"use client";

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  X,
  Mail,
  Phone,
  Linkedin,
  Globe,
  User,
  Users,
  Loader2,
  Copy,
  Check,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Plus,
  Edit2,
  FileText,
  CheckCircle,
  XCircle,
  HelpCircle,
  Minus,
  Eye,
  ExternalLink,
  Upload,
  Instagram,
  Sparkles,
  Search,
  Newspaper,
  Link2,
  RefreshCw,
  Star,
} from "lucide-react";
import { Company } from "@/contexts/CompaniesContext";
import { useAuth } from "@/contexts/AuthContext";
import { useMessageTemplates, CHANNEL_LABELS, TemplateChannel } from "@/contexts/MessageTemplatesContext";
import { renderCompanyTemplate, OFFER_OPTIONS, getOfferLabel, type TemplateContact } from "@/lib/messageTemplates";
import { extractPhoneNumber } from "@/lib/utils";
import PhoneInputField from "@/components/ui/PhoneInputField";
import { buildEmailComposeUrl, buildEmailBody, type EmailSettings } from "@/lib/emailCompose";
import { supabase } from "@/utils/supabase/client";
import { getValidAccessToken, fetchCompanyNewsCurrent, fetchCompanyNews, fetchCompanyNewsEmailOpener, type CompanyNews } from "@/lib/api";
import { reanalyzeCompany } from "@/lib/reanalyzeCompany";
import ReactMarkdown from 'react-markdown';
import DeleteConfirmationModal from "@/components/ui/DeleteConfirmationModal";

type DrawerTab = "overview" | "outreach" | "latest-news" | "contacts";

interface CompanyDetailsDrawerProps {
  isOpen: boolean;
  company: Company | null;
  onClose: () => void;
  getSummaryData: (company: Company) => any;
  columnLabels: Record<string, string>;
  getCellValue: (company: Company, columnKey: string) => string;
  columnOrder: string[];
  updateCompany: (id: string, updates: Partial<Company>) => Promise<void>;
  companies?: Company[];
  onCompanyChange?: (company: Company) => void;
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  emailSettings?: EmailSettings | null;
  availableSetNames?: string[];
  onDelete?: (id: string) => Promise<void>;
}

/* ---------- Shared layout helpers (mirrors InvestorDetailsDrawer) ---------- */

function DetailRow({
  label,
  icon,
  value,
}: {
  label: string;
  icon: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
        <div className="text-sm text-gray-900 mt-0.5">{value}</div>
      </div>
    </div>
  );
}

function DetailField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <div className="text-sm text-gray-900">{children}</div>
    </div>
  );
}

function DetailSection({
  label,
  icon,
  action,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1">
          {icon}
          {label}
        </h3>
        {action}
      </div>
      <div className="text-sm text-gray-700">{children}</div>
    </div>
  );
}

const CompanyDetailsDrawer: React.FC<CompanyDetailsDrawerProps> = ({
  isOpen,
  company,
  onClose,
  getSummaryData,
  columnLabels,
  getCellValue,
  columnOrder,
  updateCompany,
  companies = [],
  onCompanyChange,
  currentPage = 1,
  totalPages = 1,
  onPageChange,
  emailSettings = null,
  availableSetNames = [],
  onDelete,
}) => {
  // Inline editing state
  const [editingCell, setEditingCell] = useState<{
    companyId: string;
    columnKey: string;
    value: string;
    originalValue: string;
  } | null>(null);

  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [classificationValue, setClassificationValue] = useState<string>("");
  const [setNameCreating, setSetNameCreating] = useState(false);
  const [newSetNameValue, setNewSetNameValue] = useState("");
  // Persist the last-visited drawer tab so opening the next company restores it
  // (when that tab exists for the company — person profiles have no Contacts tab).
  const ACTIVE_TAB_STORAGE_KEY = "companyDrawer.lastTab";
  const [activeTab, setActiveTab] = useState<DrawerTab>("overview");
  // Only persist on an explicit user click; programmatic resets (on company
  // change) must not overwrite the stored preference when a tab is unavailable.
  const handleSelectTab = useCallback((tab: DrawerTab) => {
    setActiveTab(tab);
    try {
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
    } catch {
      // Ignore storage errors (private mode, etc.)
    }
  }, []);
  const [contacts, setContacts] = useState<any[] | null>(null);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactToRemove, setContactToRemove] = useState<{
    contactId: string | number;
    contactName: string;
  } | null>(null);
  const [isAddingContact, setIsAddingContact] = useState(false);
  const emptyNewContact = {
    full_name: "",
    title: "",
    headline: "",
    email: "",
    phone: "",
    linkedin_url: "",
    photo_url: "",
    status: "",
    isActionProfile: "",
  };
  const [newContact, setNewContact] = useState<Record<string, string>>(emptyNewContact);
  const [savingNewContact, setSavingNewContact] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | number | null>(null);
  const [enrichingContactId, setEnrichingContactId] = useState<string | number | null>(null);
  const [enrichingMode, setEnrichingMode] = useState<"basic" | "email" | null>(null);

  // Notes management state
  const [notes, setNotes] = useState<Array<{ message: string; date: string }>>([]);
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null);
  const [newNoteMessage, setNewNoteMessage] = useState('');
  const [noteToDelete, setNoteToDelete] = useState<number | null>(null);

  // JSON import state
  const [isJsonImportOpen, setIsJsonImportOpen] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonImporting, setJsonImporting] = useState(false);

  // Contact JSON import state (LinkedIn-style profile JSON)
  const [contactJsonOpen, setContactJsonOpen] = useState(false);
  const [contactJsonInput, setContactJsonInput] = useState('');
  const [contactJsonError, setContactJsonError] = useState<string | null>(null);

  const [copiedDetailKey, setCopiedDetailKey] = useState<string | null>(null);
  const [domainCopied, setDomainCopied] = useState(false);
  const [copiedOutreachKey, setCopiedOutreachKey] = useState<string | null>(null);
  const [copiedAllOutreach, setCopiedAllOutreach] = useState(false);
  const [outreachChannelFilter, setOutreachChannelFilter] = useState<TemplateChannel | "all">("all");
  const [outreachCategoryFilter, setOutreachCategoryFilter] = useState<string>("all");
  // Offer filter. Defaults to 'all' so every outreach message shows on open
  // until the user explicitly picks an offer. Intentionally NOT coupled to the
  // Templates page's persisted offer — that default used to silently hide all
  // messages here ("No outreach messages match the current filters.").
  const [outreachOfferFilter, setOutreachOfferFilter] = useState<string>("all");
  const [outreachSearch, setOutreachSearch] = useState("");
  // Starred outreach templates. Keyed by outreach column key (e.g. "template_<id>")
  // so a star follows the template across every company. Persisted locally; not
  // tied to a company record. `outreachStarredOnly` filters the list to favourites.
  const STARRED_OUTREACH_STORAGE_KEY = "outreach.starredTemplates";
  const [starredOutreachKeys, setStarredOutreachKeys] = useState<Set<string>>(new Set());
  const [outreachStarredOnly, setOutreachStarredOnly] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STARRED_OUTREACH_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setStarredOutreachKeys(new Set(parsed.filter((x): x is string => typeof x === "string")));
        }
      }
    } catch {
      // Ignore storage errors (private mode, malformed value, etc.)
    }
  }, []);
  const toggleStarredOutreach = useCallback((columnKey: string) => {
    setStarredOutreachKeys((prev) => {
      const next = new Set(prev);
      if (next.has(columnKey)) next.delete(columnKey);
      else next.add(columnKey);
      try {
        window.localStorage.setItem(
          STARRED_OUTREACH_STORAGE_KEY,
          JSON.stringify(Array.from(next))
        );
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);
  // Identifier of the contact whose name fields (e.g. ${first_name}) should be
  // injected when rendering outreach template values. "" = no contact selected.
  const [outreachContactId, setOutreachContactId] = useState<string>("");
  const [companyNews, setCompanyNews] = useState<CompanyNews | null>(null);
  const [companyNewsLoading, setCompanyNewsLoading] = useState(false);
  const [companyNewsError, setCompanyNewsError] = useState<string | null>(null);
  const [companyNewsFetchCooldown, setCompanyNewsFetchCooldown] = useState(false);
  const [generatingEmailOpener, setGeneratingEmailOpener] = useState(false);
  const [emailOpenerError, setEmailOpenerError] = useState<string | null>(null);
  type NewsField = 'answer' | 'first_line_to_start_email' | 'subject_line';
  const [editingNewsField, setEditingNewsField] = useState<NewsField | null>(null);
  const [newsFieldDraft, setNewsFieldDraft] = useState('');
  const [copiedNewsField, setCopiedNewsField] = useState<NewsField | null>(null);
  const [manualNewsOpen, setManualNewsOpen] = useState(false);
  const [manualNewsDraft, setManualNewsDraft] = useState('');
  const [savingManualNews, setSavingManualNews] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { user } = useAuth();
  const { templates: messageTemplates } = useMessageTemplates();

  const templateById = useMemo(() => {
    const map = new Map<string, { id: string; title: string; channel: TemplateChannel; category?: string; offer?: string | null }>();
    for (const t of messageTemplates) {
      map.set(t.id, { id: t.id, title: t.title, channel: t.channel, category: t.category, offer: t.offer });
    }
    return map;
  }, [messageTemplates]);

  const getTemplateForColumn = useCallback(
    (columnKey: string) => {
      if (!columnKey.startsWith("template_")) return null;
      const id = columnKey.replace("template_", "");
      return templateById.get(id) || null;
    },
    [templateById]
  );

  // Stable identifier for a contact row (mirrors the lookup logic used by
  // handleContactToggle / handleContactStatusChange).
  const getContactIdentifier = useCallback((contact: any): string => {
    return String(contact?.person_id || contact?.email || contact?.full_name || "");
  }, []);

  const selectedOutreachContact = useMemo<TemplateContact | null>(() => {
    if (!outreachContactId || !contacts) return null;
    const match = contacts.find((c) => getContactIdentifier(c) === outreachContactId);
    return (match as TemplateContact) || null;
  }, [outreachContactId, contacts, getContactIdentifier]);

  // Contact-aware variant of getCellValue: for template columns, re-render the
  // template with the given contact so ${first_name} resolves to that
  // recipient. For all other columns, fall back to the prop-supplied getter.
  const renderOutreachForContact = useCallback(
    (columnKey: string, contact: TemplateContact | null): string => {
      if (!company) return "";
      if (columnKey.startsWith("template_") && contact) {
        const templateId = columnKey.replace("template_", "");
        const fullTemplate = messageTemplates.find((t) => t.id === templateId);
        if (fullTemplate && fullTemplate.template) {
          const summary = (company.summary as Record<string, any> | null | undefined) ?? null;
          const rendered = renderCompanyTemplate(
            fullTemplate,
            summary,
            messageTemplates,
            [],
            contact
          );
          return rendered || "";
        }
      }
      return getCellValue(company, columnKey);
    },
    [company, messageTemplates, getCellValue]
  );

  // Shorthand bound to the outreach-tab's contact selector.
  const getOutreachValue = useCallback(
    (columnKey: string): string =>
      renderOutreachForContact(columnKey, selectedOutreachContact),
    [renderOutreachForContact, selectedOutreachContact]
  );

  // Handle cell double click (edit)
  const handleCellDoubleClick = useCallback(
    (company: Company, columnKey: string) => {
      if (columnKey.startsWith("template_")) return;
      if (columnKey === "domain" || columnKey === "instagram") return;
      if (columnKey === "classification") return;
      if (columnKey === "notes") return;

      const currentValue = getCellValue(company, columnKey);
      const normalized = currentValue === "-" ? "" : currentValue;
      setEditingCell({
        companyId: company.id,
        columnKey,
        value: normalized,
        originalValue: normalized,
      });
    },
    [getCellValue]
  );

  // Handle inline edit save
  const handleInlineEditSave = useCallback(async () => {
    if (!editingCell || !company) return;

    const { companyId, columnKey, originalValue } = editingCell;
    const value = editingCell.value.trim();

    if (value === originalValue.trim()) {
      setEditingCell(null);
      return;
    }

    try {
      if (columnKey === "phone") {
        const cleanedPhone = extractPhoneNumber(value);
        await updateCompany(companyId, { [columnKey]: cleanedPhone });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      if (columnKey === "email") {
        await updateCompany(companyId, { [columnKey]: value });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      if (columnKey === "set_name") {
        await updateCompany(companyId, { [columnKey]: value || null });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      const summaryData = getSummaryData(company);
      const updatedSummary = { ...summaryData };
      const prevValue = summaryData[columnKey];

      if (Array.isArray(prevValue)) {
        updatedSummary[columnKey] = value
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
      } else if (typeof prevValue === 'number') {
        const parsed = parseFloat(value.replace("%", ""));
        if (!isNaN(parsed)) {
          updatedSummary[columnKey] = parsed <= 100 && parsed >= 0 && prevValue <= 1 ? parsed / 100 : parsed;
        }
      } else {
        updatedSummary[columnKey] = value;
      }

      await updateCompany(companyId, { summary: updatedSummary });
      setEditingCell(null);
      setToastMessage(`${columnLabels[columnKey]} updated successfully`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error("Error updating field:", error);
      setToastMessage(
        `Error updating ${columnLabels[columnKey]}: ${error.message}`
      );
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    }
  }, [editingCell, company, getSummaryData, updateCompany, columnLabels]);

  useEffect(() => {
    if (!editingCell || !editInputRef.current) return;

    const el = editInputRef.current;
    requestAnimationFrame(() => {
      el.focus();
      const length = el.value.length;
      if (typeof (el as any).setSelectionRange === "function") {
        (el as any).setSelectionRange(length, length);
      }
    });
  }, [editingCell?.companyId, editingCell?.columnKey]);

  useEffect(() => {
    if (company) {
      const summaryData = getSummaryData(company);
      const currentClassification = summaryData.classification || "";
      const displayValue =
        currentClassification === "NOT_QUALIFIED"
          ? "UNQUALIFIED"
          : currentClassification;
      setClassificationValue(displayValue);
    }
  }, [company, company?.summary, getSummaryData]);

  const handleClassificationChange = useCallback(
    async (newValue: string) => {
      if (!company || !newValue) return;

      setClassificationValue(newValue);

      try {
        const summaryData = getSummaryData(company);
        const updatedSummary = { ...summaryData };

        const dbValue = newValue === "UNQUALIFIED" ? "NOT_QUALIFIED" : newValue;

        if (["QUALIFIED", "NOT_QUALIFIED", "MAYBE", "EXPIRED"].includes(dbValue.toUpperCase())) {
          updatedSummary.classification = dbValue.toUpperCase() as
            | "QUALIFIED"
            | "NOT_QUALIFIED"
            | "MAYBE"
            | "EXPIRED";
        } else {
          const currentClassification = summaryData.classification || "";
          const displayValue =
            currentClassification === "NOT_QUALIFIED"
              ? "UNQUALIFIED"
              : currentClassification;
          setClassificationValue(displayValue);
          return;
        }

        await updateCompany(company.id, { summary: updatedSummary });
        setToastMessage("Classification updated successfully");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
      } catch (error: any) {
        console.error("Error updating classification:", error);
        setToastMessage(`Error updating classification: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);

        const summaryData = getSummaryData(company);
        const currentClassification = summaryData.classification || "";
        const displayValue =
          currentClassification === "NOT_QUALIFIED"
            ? "UNQUALIFIED"
            : currentClassification;
        setClassificationValue(displayValue);
      }
    },
    [company, getSummaryData, updateCompany]
  );

  const handleSetNameSave = useCallback(
    async (rawValue: string) => {
      if (!company) return;
      const trimmed = rawValue.trim();
      try {
        await updateCompany(company.id, { set_name: trimmed || null });
        setToastMessage(
          trimmed
            ? `Set updated to "${trimmed}"`
            : "Set cleared"
        );
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
      } catch (error: any) {
        console.error("Error updating set name:", error);
        setToastMessage(`Error updating set: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
      }
    },
    [company, updateCompany]
  );

  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchedDomainsRef = useRef<Set<string>>(new Set());
  const prevTabRef = useRef<DrawerTab>("overview");

  const fetchContacts = useCallback(async (force: boolean = false) => {
    if (!company?.domain) return;

    const domain = company.domain;
    const storageKey = `contacts_${domain}`;

    // Force refresh = pull the latest contacts straight from Supabase so
    // edits made elsewhere (other devices, other tabs) show up.
    if (force) {
      setContactsLoading(true);
      try {
        const { data, error } = await supabase
          .from("companies")
          .select("contacts")
          .eq("id", company.id)
          .maybeSingle();
        if (error) throw error;

        const remoteContacts: any[] = Array.isArray(data?.contacts) ? data.contacts : [];
        localStorage.setItem(storageKey, JSON.stringify(remoteContacts));
        fetchedDomainsRef.current.add(domain);
        setContacts(remoteContacts);
        if (onCompanyChange) {
          onCompanyChange({ ...company, contacts: remoteContacts });
        }
        setToastMessage("Contacts refreshed from server");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 2000);
      } catch (error: any) {
        console.error("Error refreshing contacts from backend:", error);
        setToastMessage(`Error refreshing contacts: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
      } finally {
        setContactsLoading(false);
      }
      return;
    }

    if (fetchedDomainsRef.current.has(domain)) {
      const cachedContacts = localStorage.getItem(storageKey);
      if (cachedContacts) {
        try {
          const parsed = JSON.parse(cachedContacts);
          setContacts(parsed);
          return;
        } catch (e) {
          console.error("Error parsing cached contacts:", e);
        }
      }
      return;
    }

    if (company.contacts && Array.isArray(company.contacts)) {
      setContacts(company.contacts);
      localStorage.setItem(storageKey, JSON.stringify(company.contacts));
      fetchedDomainsRef.current.add(domain);
      return;
    }

    const cachedContacts = localStorage.getItem(storageKey);
    if (cachedContacts) {
      try {
        const parsed = JSON.parse(cachedContacts);
        setContacts(parsed);
        fetchedDomainsRef.current.add(domain);
        return;
      } catch (e) {
        console.error("Error parsing cached contacts:", e);
      }
    }

    setContactsLoading(true);
    try {
      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        throw new Error("Not authenticated");
      }

      const category =
        company?.summary && typeof company.summary === "object"
          ? (company.summary as Record<string, any>).category
          : undefined;

      const response = await fetch(
        "https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/people_search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            domain,
            ...(category ? { category } : {}),
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch contacts: ${response.statusText}`);
      }

      const data = await response.json();
      const contactsList = data.results || [];

      let mergedContacts = contactsList;
      if (company.contacts && Array.isArray(company.contacts)) {
        const existingContactsMap = new Map();
        company.contacts.forEach((existingContact) => {
          const id = existingContact.person_id || existingContact.email || existingContact.full_name;
          if (id) {
            existingContactsMap.set(id, existingContact);
          }
        });

        mergedContacts = contactsList.map((newContact: any) => {
          const id = newContact.person_id || newContact.email || newContact.full_name;
          const existingContact = id ? existingContactsMap.get(id) : null;
          if (existingContact) {
            return { ...newContact, checked: existingContact.checked };
          }
          return newContact;
        });
      }

      localStorage.setItem(storageKey, JSON.stringify(mergedContacts));
      fetchedDomainsRef.current.add(domain);
      setContacts(mergedContacts);
    } catch (error: any) {
      console.error("Error fetching contacts:", error);
      setToastMessage(`Error fetching contacts: ${error.message}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } finally {
      setContactsLoading(false);
    }
  }, [company?.id, company?.domain, company?.summary, company?.contacts, onCompanyChange]);

  const COMPANY_NEWS_STORAGE_KEY = (id: string) => `company-news-${id}`;

  const newsFetchedWithin7Days =
    companyNews?.date &&
    Date.now() - new Date(companyNews.date).getTime() < 7 * 24 * 60 * 60 * 1000;

  const loadCompanyNews = useCallback(async (companyId: string) => {
    if (typeof window === 'undefined') return;
    const cached = localStorage.getItem(COMPANY_NEWS_STORAGE_KEY(companyId));
    if (cached !== null) {
      try {
        const parsed = JSON.parse(cached) as CompanyNews;
        if (parsed?.answer != null || (Array.isArray(parsed?.citations) && parsed.citations.length > 0)) {
          setCompanyNews(parsed);
          return;
        }
      } catch {
        // invalid cache
      }
    }
    if (company?.news && company.id === companyId) {
      setCompanyNews(company.news);
      return;
    }
    setCompanyNewsLoading(true);
    setCompanyNewsError(null);
    const result = await fetchCompanyNewsCurrent(companyId);
    setCompanyNewsLoading(false);
    if (result?.news) {
      setCompanyNews(result.news);
    } else if (result?.error) {
      setCompanyNewsError(result.error);
    } else {
      setCompanyNews(null);
    }
  }, [company?.id, company?.news]);

  const handleFetchCompanyNews = useCallback(async () => {
    if (!company || companyNewsFetchCooldown || !!newsFetchedWithin7Days) return;
    setCompanyNewsLoading(true);
    setCompanyNewsError(null);
    const domainClean = company.domain
      ? company.domain.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/$/, '')
      : null;
    const result = await fetchCompanyNews({
      companyId: company.id,
      domain: domainClean,
      name: domainClean ? domainClean.split('.')[0] : null,
    });
    setCompanyNewsLoading(false);
    if (result?.news) {
      setCompanyNews(result.news);
      try {
        localStorage.setItem(COMPANY_NEWS_STORAGE_KEY(company.id), JSON.stringify(result.news));
      } catch {
        // ignore quota errors
      }
      if (onCompanyChange) {
        onCompanyChange({ ...company, news: result.news });
      }
      setCompanyNewsFetchCooldown(true);
      setTimeout(() => setCompanyNewsFetchCooldown(false), 10000);
      setToastMessage('Company news fetched successfully');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } else if (result?.error) {
      setCompanyNewsError(result.error);
      setToastMessage(`Failed to fetch company news: ${result.error}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 4000);
    }
  }, [company, companyNewsFetchCooldown, newsFetchedWithin7Days, onCompanyChange]);

  const handleGenerateEmailOpener = useCallback(async () => {
    if (!company || !companyNews?.answer || generatingEmailOpener) return;
    setGeneratingEmailOpener(true);
    setEmailOpenerError(null);
    try {
      const result = await fetchCompanyNewsEmailOpener(companyNews.answer);
      if (!result) {
        setEmailOpenerError('Could not generate email opener.');
        setToastMessage('Could not generate email opener.');
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 4000);
        return;
      }
      if (result.first_line_to_start_email === null && result.subject_line === null) {
        const msg = 'News not a good fit for an email opener — nothing generated.';
        setEmailOpenerError(msg);
        setToastMessage(msg);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 4000);
        return;
      }
      const updatedNews: CompanyNews = {
        ...companyNews,
        first_line_to_start_email: result.first_line_to_start_email ?? undefined,
        subject_line: result.subject_line ?? undefined,
      };
      setCompanyNews(updatedNews);
      try {
        localStorage.setItem(COMPANY_NEWS_STORAGE_KEY(company.id), JSON.stringify(updatedNews));
      } catch {
        // ignore quota errors
      }
      // Merge into summary (mirrors mergeNewsDraftIntoSummary in CompanyResearchHome)
      const updatedSummary = {
        ...getSummaryData(company),
        first_line_to_start_email: result.first_line_to_start_email,
        subject_line: result.subject_line,
      };
      await updateCompany(company.id, { summary: updatedSummary, news: updatedNews });
      if (onCompanyChange) {
        onCompanyChange({ ...company, summary: updatedSummary, news: updatedNews });
      }
      setToastMessage('Email opener generated successfully');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (err) {
      console.error('[CompanyDetailsDrawer] Email opener generation failed:', err);
      setEmailOpenerError('Something went wrong. Please try again.');
      setToastMessage('Failed to generate email opener. Please try again.');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 4000);
    } finally {
      setGeneratingEmailOpener(false);
    }
  }, [company, companyNews, generatingEmailOpener, getSummaryData, updateCompany, onCompanyChange]);

  const handleCopyNewsField = useCallback(async (field: NewsField, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedNewsField(field);
      setTimeout(() => setCopiedNewsField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, []);

  const handleStartEditNewsField = useCallback((field: NewsField, currentValue: string) => {
    setEditingNewsField(field);
    setNewsFieldDraft(currentValue || '');
  }, []);

  const handleCancelEditNewsField = useCallback(() => {
    setEditingNewsField(null);
    setNewsFieldDraft('');
  }, []);

  const handleSaveNewsField = useCallback(async () => {
    if (!company || !companyNews || !editingNewsField) return;
    const trimmed = newsFieldDraft.trim();
    const updatedNews: CompanyNews = { ...companyNews, [editingNewsField]: trimmed };
    setCompanyNews(updatedNews);
    try {
      localStorage.setItem(COMPANY_NEWS_STORAGE_KEY(company.id), JSON.stringify(updatedNews));
    } catch {
      // ignore
    }
    try {
      const updates: Partial<Company> = { news: updatedNews };
      // Mirror first_line_to_start_email + subject_line into summary as well
      if (editingNewsField === 'first_line_to_start_email' || editingNewsField === 'subject_line') {
        updates.summary = { ...getSummaryData(company), [editingNewsField]: trimmed };
      }
      await updateCompany(company.id, updates);
      if (onCompanyChange) {
        onCompanyChange({ ...company, ...updates });
      }
      setToastMessage('Updated');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 2000);
    } catch (err: any) {
      console.error('Error saving news field:', err);
      setToastMessage(`Error: ${err?.message || 'Failed to save'}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } finally {
      setEditingNewsField(null);
      setNewsFieldDraft('');
    }
  }, [company, companyNews, editingNewsField, newsFieldDraft, getSummaryData, updateCompany, onCompanyChange]);

  const handleSaveManualNews = useCallback(async () => {
    if (!company) return;
    const trimmed = manualNewsDraft.trim();
    if (!trimmed) {
      setToastMessage('Please enter news text to save.');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
      return;
    }
    setSavingManualNews(true);
    const updatedNews: CompanyNews = {
      answer: trimmed,
      citations: companyNews?.citations ?? [],
      date: new Date().toISOString(),
      first_line_to_start_email: companyNews?.first_line_to_start_email,
      subject_line: companyNews?.subject_line,
    };
    setCompanyNews(updatedNews);
    try {
      localStorage.setItem(COMPANY_NEWS_STORAGE_KEY(company.id), JSON.stringify(updatedNews));
    } catch {
      // ignore quota errors
    }
    try {
      await updateCompany(company.id, { news: updatedNews });
      if (onCompanyChange) {
        onCompanyChange({ ...company, news: updatedNews });
      }
      setManualNewsOpen(false);
      setManualNewsDraft('');
      setCompanyNewsError(null);
      setToastMessage('News added. You can now generate an email opener.');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (err: any) {
      console.error('Error saving manual news:', err);
      setToastMessage(`Error: ${err?.message || 'Failed to save news'}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } finally {
      setSavingManualNews(false);
    }
  }, [company, manualNewsDraft, companyNews, updateCompany, onCompanyChange]);

  const handleReanalyze = useCallback(async () => {
    if (!company || reanalyzing) return;
    if (!company.domain?.trim()) {
      setToastMessage('No domain to reanalyze.');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
      return;
    }

    setReanalyzing(true);
    try {
      const result = await reanalyzeCompany({
        company,
        userId: user?.id ?? null,
        updateCompany,
      });

      if (!result.ok) {
        setToastMessage(result.error || 'Reanalysis failed.');
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 4000);
        return;
      }

      if (onCompanyChange && result.updates) {
        onCompanyChange({ ...company, ...result.updates });
      }

      setToastMessage('Company reanalyzed successfully');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (err: any) {
      console.error('[CompanyDetailsDrawer] Reanalyze failed:', err);
      setToastMessage(`Reanalysis failed: ${err?.message || 'Unknown error'}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 4000);
    } finally {
      setReanalyzing(false);
    }
  }, [company, reanalyzing, user?.id, updateCompany, onCompanyChange]);

  useEffect(() => {
    if (company && activeTab === 'latest-news') {
      loadCompanyNews(company.id);
    }
  }, [company?.id, activeTab, loadCompanyNews]);

  useEffect(() => {
    if (
      activeTab === "contacts" &&
      prevTabRef.current !== activeTab &&
      company?.domain
    ) {
      fetchContacts();
    }
    prevTabRef.current = activeTab;
  }, [activeTab, company?.domain, fetchContacts]);

  const notesChangedLocallyRef = useRef(false);
  const prevCompanyIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (company) {
      const companyIdChanged = prevCompanyIdRef.current !== company.id;

      if (companyIdChanged) {
        notesChangedLocallyRef.current = false;
        prevCompanyIdRef.current = company.id;
      }

      // Restore the user's last-visited tab if it's available for this company.
      // The Contacts tab only exists for non-person profiles, so fall back to
      // Overview when the stored tab can't be shown.
      let restoredTab: DrawerTab = "overview";
      try {
        const stored = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY) as DrawerTab | null;
        const isPerson = /linkedin\.com\/in\//i.test(company.domain || "");
        const availableTabs: DrawerTab[] = isPerson
          ? ["overview", "outreach", "latest-news"]
          : ["overview", "outreach", "latest-news", "contacts"];
        if (stored && availableTabs.includes(stored)) {
          restoredTab = stored;
        }
      } catch {
        // Ignore storage errors — default to Overview.
      }
      setActiveTab(restoredTab);
      setContacts(null);
      setOutreachContactId("");
      setCompanyNews(null);
      setCompanyNewsError(null);
      setCompanyNewsFetchCooldown(false);
      setGeneratingEmailOpener(false);
      setEmailOpenerError(null);
      setEditingNewsField(null);
      setNewsFieldDraft('');
      setCopiedNewsField(null);
      setManualNewsOpen(false);
      setManualNewsDraft('');
      setSavingManualNews(false);
      setSetNameCreating(false);
      setNewSetNameValue("");
      prevTabRef.current = "overview";

      if (!notesChangedLocallyRef.current) {
        if (company.notes && Array.isArray(company.notes)) {
          setNotes(company.notes);
        } else {
          setNotes([]);
        }
      } else {
        const propNotes = company.notes && Array.isArray(company.notes) ? company.notes : [];
        const notesMatch = JSON.stringify(propNotes) === JSON.stringify(notes);
        if (notesMatch) {
          notesChangedLocallyRef.current = false;
        }
      }
      setIsAddingNote(false);
      setEditingNoteIndex(null);
      setNewNoteMessage('');
    } else {
      prevCompanyIdRef.current = null;
      notesChangedLocallyRef.current = false;
    }
  }, [company?.id]);

  const handleContactToggle = useCallback(
    async (contactId: string | number, checked: boolean) => {
      if (!company || !contacts) return;

      try {
        const updatedContacts = contacts.map((contact) => {
          const matches =
            contact.person_id === contactId ||
            contact.email === contactId ||
            contact.full_name === contactId;

          if (matches) {
            return { ...contact, checked };
          }
          return contact;
        });

        setContacts(updatedContacts);

        const domain = company.domain;
        const storageKey = `contacts_${domain}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedContacts));

        await updateCompany(company.id, { contacts: updatedContacts });

        setToastMessage(checked ? "Contact checked" : "Contact unchecked");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 2000);
      } catch (error: any) {
        console.error("Error toggling contact:", error);
        setToastMessage(`Error updating contact: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        setContacts(contacts);
      }
    },
    [company, contacts, updateCompany]
  );

  const handleContactStatusChange = useCallback(
    async (contactId: string | number, status: string) => {
      if (!company || !contacts) return;

      const previousContacts = contacts;

      try {
        const updatedContacts = contacts.map((contact) => {
          const matches =
            contact.person_id === contactId ||
            contact.email === contactId ||
            contact.full_name === contactId;

          if (matches) {
            return { ...contact, status };
          }
          return contact;
        });

        setContacts(updatedContacts);

        const domain = company.domain;
        const storageKey = `contacts_${domain}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedContacts));

        await updateCompany(company.id, { contacts: updatedContacts });

        setToastMessage(status ? `Status set to ${status}` : "Status cleared");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 2000);
      } catch (error: any) {
        console.error("Error updating contact status:", error);
        setToastMessage(`Error updating status: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        setContacts(previousContacts);
      }
    },
    [company, contacts, updateCompany]
  );

  const handleContactFieldChange = useCallback(
    async (contactId: string | number, field: string, value: string) => {
      if (!company || !contacts) return;

      const previousContacts = contacts;

      try {
        const updatedContacts = contacts.map((contact) => {
          const matches =
            contact.person_id === contactId ||
            contact.email === contactId ||
            contact.full_name === contactId;

          if (matches) {
            return { ...contact, [field]: value };
          }
          return contact;
        });

        setContacts(updatedContacts);

        const domain = company.domain;
        const storageKey = `contacts_${domain}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedContacts));

        await updateCompany(company.id, { contacts: updatedContacts });

        setToastMessage(`${field.replace(/_/g, " ")} updated`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 2000);
      } catch (error: any) {
        console.error(`Error updating contact ${field}:`, error);
        setToastMessage(`Error updating ${field}: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        setContacts(previousContacts);
      }
    },
    [company, contacts, updateCompany]
  );

  const handleContactRemoveClick = useCallback(
    (contactId: string | number, contactName: string) => {
      setContactToRemove({ contactId, contactName });
    },
    []
  );

  const handleAddContactSubmit = useCallback(
    async () => {
      if (!company) return;

      const trimmed: Record<string, any> = {};
      Object.entries(newContact).forEach(([k, v]) => {
        const val = (v || "").trim();
        if (val) trimmed[k] = val;
      });
      if (trimmed.isActionProfile === "true") trimmed.isActionProfile = true;
      else if (trimmed.isActionProfile === "false") trimmed.isActionProfile = false;
      else delete trimmed.isActionProfile;

      if (!trimmed.full_name && !trimmed.email && !trimmed.linkedin_url && !trimmed.phone) {
        setToastMessage("Add at least a name, email, phone, or LinkedIn URL");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      const previousContacts = contacts;
      setSavingNewContact(true);

      try {
        const isEditing = editingContactId !== null;
        let updatedContacts: any[];

        if (isEditing && contacts) {
          updatedContacts = contacts.map((contact) => {
            const matches =
              contact.person_id === editingContactId ||
              contact.email === editingContactId ||
              contact.full_name === editingContactId;
            if (!matches) return contact;

            const merged: Record<string, any> = { ...contact };
            Object.keys(emptyNewContact).forEach((field) => {
              if (Object.prototype.hasOwnProperty.call(trimmed, field)) {
                merged[field] = trimmed[field];
              } else {
                delete merged[field];
              }
            });
            return merged;
          });
        } else {
          const contactToAdd: any = {
            ...trimmed,
            person_id: `manual_${Date.now()}`,
            checked: false,
          };
          updatedContacts = [contactToAdd, ...(contacts || [])];
        }

        setContacts(updatedContacts);

        const domain = company.domain;
        const storageKey = `contacts_${domain}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedContacts));

        await updateCompany(company.id, { contacts: updatedContacts });

        setNewContact(emptyNewContact);
        setIsAddingContact(false);
        setEditingContactId(null);
        setContactJsonOpen(false);
        setContactJsonInput("");
        setContactJsonError(null);
        setToastMessage(isEditing ? "Contact updated" : "Contact added");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 2000);
      } catch (error: any) {
        console.error("Error saving contact:", error);
        setToastMessage(`Error saving contact: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        setContacts(previousContacts || null);
      } finally {
        setSavingNewContact(false);
      }
    },
    [company, contacts, newContact, editingContactId, updateCompany]
  );

  const handleAddContactCancel = useCallback(() => {
    setNewContact(emptyNewContact);
    setIsAddingContact(false);
    setEditingContactId(null);
    setContactJsonOpen(false);
    setContactJsonInput("");
    setContactJsonError(null);
  }, []);

  const handleContactEditClick = useCallback(
    (contactId: string | number) => {
      if (!contacts) return;
      const target = contacts.find(
        (c) =>
          c.person_id === contactId || c.email === contactId || c.full_name === contactId
      );
      if (!target) return;

      setNewContact({
        full_name: target.full_name || "",
        title: target.title || "",
        headline: target.headline || "",
        email: target.email || "",
        phone: target.phone || "",
        linkedin_url: target.linkedin_url || "",
        photo_url: target.photo_url || "",
        status: target.status || "",
        isActionProfile:
          target.isActionProfile === true
            ? "true"
            : target.isActionProfile === false
            ? "false"
            : "",
      });
      setEditingContactId(contactId);
      setIsAddingContact(true);
    },
    [contacts]
  );

  const handleContactRemoveConfirm = useCallback(
    async () => {
      if (!company || !contacts || !contactToRemove) return;

      const { contactId } = contactToRemove;

      try {
        const updatedContacts = contacts.filter((contact) => {
          const matches =
            contact.person_id === contactId ||
            contact.email === contactId ||
            contact.full_name === contactId;
          return !matches;
        });

        setContacts(updatedContacts);

        const domain = company.domain;
        const storageKey = `contacts_${domain}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedContacts));

        await updateCompany(company.id, { contacts: updatedContacts });

        setContactToRemove(null);
        setToastMessage("Contact removed");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 2000);
      } catch (error: any) {
        console.error("Error removing contact:", error);
        setToastMessage(`Error removing contact: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        setContacts(contacts);
      }
    },
    [company, contacts, contactToRemove, updateCompany]
  );

  const handleContactRemoveCancel = useCallback(() => {
    setContactToRemove(null);
  }, []);

  const handleGetContactDetails = useCallback(
    async (
      contactId: string | number,
      personId: string,
      revealEmail: boolean
    ) => {
      if (!company || !contacts) return;
      const domain = company.domain?.trim();
      if (!domain) {
        setToastMessage("Company has no domain");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      const previousContacts = contacts;
      setEnrichingContactId(contactId);
      setEnrichingMode(revealEmail ? "email" : "basic");
      try {
        const accessToken = await getValidAccessToken();
        if (!accessToken) {
          throw new Error("Not authenticated");
        }

        const response = await fetch(
          "https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/enrich-company-contact",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              domain,
              person_id: personId,
              reveal_email: revealEmail,
            }),
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to enrich contact: ${response.statusText}`);
        }

        const data = await response.json();
        const result = data?.result;
        if (!result || !result.person_id) {
          throw new Error("Enrichment returned no result");
        }

        const updatedContacts = previousContacts.map((contact) =>
          contact.person_id === result.person_id
            ? { ...contact, ...result }
            : contact
        );

        setContacts(updatedContacts);

        const storageKey = `contacts_${domain}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedContacts));

        await updateCompany(company.id, { contacts: updatedContacts });
      } catch (error: any) {
        console.error("Error enriching contact:", error);
        setToastMessage(`Error enriching contact: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        setContacts(previousContacts);
      } finally {
        setEnrichingContactId(null);
        setEnrichingMode(null);
      }
    },
    [company, contacts, updateCompany]
  );

  // Notes management handlers
  const handleAddNote = useCallback(() => {
    setIsAddingNote(true);
    setNewNoteMessage('');
  }, []);

  const handleCancelAddNote = useCallback(() => {
    setIsAddingNote(false);
    setNewNoteMessage('');
  }, []);

  const handleSaveNote = useCallback(async () => {
    if (!company || !newNoteMessage.trim()) return;

    try {
      const updatedNotes = [...notes];

      if (editingNoteIndex !== null) {
        const originalNote = notes[editingNoteIndex];
        updatedNotes[editingNoteIndex] = {
          message: newNoteMessage.trim(),
          date: originalNote.date,
        };
      } else {
        const today = new Date().toISOString().split('T')[0];
        updatedNotes.push({
          message: newNoteMessage.trim(),
          date: today,
        });
      }

      updatedNotes.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      await updateCompany(company.id, { notes: updatedNotes });
      setNotes(updatedNotes);
      notesChangedLocallyRef.current = true;

      if (onCompanyChange) {
        onCompanyChange({ ...company, notes: updatedNotes });
      }

      setIsAddingNote(false);
      setEditingNoteIndex(null);
      setNewNoteMessage('');
      setToastMessage(editingNoteIndex !== null ? 'Note updated successfully' : 'Note added successfully');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error('Error saving note:', error);
      setToastMessage(`Error saving note: ${error.message}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    }
  }, [company, notes, newNoteMessage, editingNoteIndex, updateCompany, onCompanyChange]);

  const handleEditNote = useCallback((index: number) => {
    const note = notes[index];
    if (note) {
      setEditingNoteIndex(index);
      setNewNoteMessage(note.message);
      setIsAddingNote(true);
    }
  }, [notes]);

  const handleCancelEditNote = useCallback(() => {
    setEditingNoteIndex(null);
    setIsAddingNote(false);
    setNewNoteMessage('');
  }, []);

  const handleDeleteNoteClick = useCallback((index: number) => {
    setNoteToDelete(index);
  }, []);

  const handleDeleteNoteConfirm = useCallback(async () => {
    if (!company || noteToDelete === null) return;

    try {
      const updatedNotes = notes.filter((_, index) => index !== noteToDelete);
      const finalNotes = updatedNotes.length > 0 ? updatedNotes : null;
      await updateCompany(company.id, { notes: finalNotes });
      setNotes(updatedNotes);
      notesChangedLocallyRef.current = true;

      if (onCompanyChange) {
        onCompanyChange({ ...company, notes: finalNotes });
      }

      setNoteToDelete(null);
      setToastMessage('Note deleted successfully');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error('Error deleting note:', error);
      setToastMessage(`Error deleting note: ${error.message}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
      setNoteToDelete(null);
    }
  }, [company, notes, noteToDelete, updateCompany, onCompanyChange]);

  const handleDeleteNoteCancel = useCallback(() => {
    setNoteToDelete(null);
  }, []);

  // JSON import handlers
  const handleOpenJsonImport = useCallback(() => {
    setJsonInput('');
    setJsonError(null);
    setIsJsonImportOpen(true);
  }, []);

  const handleCloseJsonImport = useCallback(() => {
    setIsJsonImportOpen(false);
    setJsonInput('');
    setJsonError(null);
  }, []);

  const handleApplyJsonImport = useCallback(async () => {
    if (!company) return;

    let parsed: any;
    try {
      parsed = JSON.parse(jsonInput);
    } catch (e: any) {
      setJsonError(`Invalid JSON: ${e.message}`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setJsonError('JSON must be an object');
      return;
    }

    const asArray = (v: unknown): string[] => {
      if (!Array.isArray(v)) return [];
      return v
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((s) => s.length > 0);
    };

    const emails = asArray(parsed.emails);
    const phones = asArray(parsed.phones);
    const instagrams = asArray(parsed.instagram);
    const linkedins = asArray(parsed.linkedin);
    const facebooks = asArray(parsed.facebook);

    const updates: Partial<Company> = {};

    if (emails.length > 0) {
      updates.email = emails.join(', ');
    }
    if (phones.length > 0) {
      updates.phone = phones.join(', ');
    }
    if (instagrams.length > 0) {
      const first = instagrams[0];
      const match = first.match(/instagram\.com\/([^/?#]+)/i);
      updates.instagram = match ? match[1] : first.replace(/^@/, '');
    }

    if (linkedins.length > 0 || facebooks.length > 0) {
      const currentSummary = getSummaryData(company);
      const nextSummary = { ...currentSummary };
      if (linkedins.length > 0) nextSummary.linkedin = linkedins;
      if (facebooks.length > 0) nextSummary.facebook = facebooks;
      updates.summary = nextSummary;
    }

    if (Object.keys(updates).length === 0) {
      setJsonError('No values to import (all arrays empty or unrecognized).');
      return;
    }

    setJsonImporting(true);
    try {
      await updateCompany(company.id, updates);
      if (onCompanyChange) {
        onCompanyChange({ ...company, ...updates });
      }
      setIsJsonImportOpen(false);
      setJsonInput('');
      setJsonError(null);
      setToastMessage('Company updated from JSON');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error('Error importing JSON:', error);
      setJsonError(`Update failed: ${error.message}`);
    } finally {
      setJsonImporting(false);
    }
  }, [company, jsonInput, getSummaryData, updateCompany, onCompanyChange]);

  // Navigation
  const currentIndex = company ? companies.findIndex((c) => c.id === company.id) : -1;
  const hasNextInPage = currentIndex < companies.length - 1 && currentIndex >= 0;
  const hasNextPage = currentPage < totalPages;
  const hasNext = hasNextInPage || hasNextPage;
  const hasPreviousPage = currentPage > 1;
  const hasPreviousInPage = currentIndex > 0;
  const hasPrevious = hasPreviousInPage || hasPreviousPage;

  const handlePrevious = useCallback(() => {
    if (!onCompanyChange || !company) return;

    if (currentIndex === 0 && hasPreviousPage && onPageChange) {
      onPageChange(currentPage - 1);
      return;
    }

    if (currentIndex > 0) {
      const previousCompany = companies[currentIndex - 1];
      if (previousCompany) {
        onCompanyChange(previousCompany);
      }
    }
  }, [currentIndex, hasPreviousPage, onPageChange, currentPage, onCompanyChange, companies, company]);

  const handleNext = useCallback(() => {
    if (!onCompanyChange || !company) return;

    if (currentIndex === companies.length - 1 && hasNextPage && onPageChange) {
      onPageChange(currentPage + 1);
      return;
    }

    if (currentIndex < companies.length - 1) {
      const nextCompany = companies[currentIndex + 1];
      if (nextCompany) {
        onCompanyChange(nextCompany);
      }
    }
  }, [currentIndex, companies, hasNextPage, onPageChange, currentPage, onCompanyChange, company]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!company || !onDelete) return;
    const deletedId = company.id;

    // Choose the best next selection BEFORE deletion so the parent's sync effect
    // lands on a sensible target instead of defaulting to the first row.
    const inPageNext = hasNextInPage ? companies[currentIndex + 1] : null;
    const inPagePrev = hasPreviousInPage ? companies[currentIndex - 1] : null;
    const inPageTarget = inPageNext || inPagePrev;

    setDeleting(true);
    try {
      if (inPageTarget && onCompanyChange) {
        onCompanyChange(inPageTarget);
        await onDelete(deletedId);
      } else if (hasNextPage && onPageChange) {
        onPageChange(currentPage + 1);
        await onDelete(deletedId);
      } else if (hasPreviousPage && onPageChange) {
        onPageChange(currentPage - 1);
        await onDelete(deletedId);
      } else {
        await onDelete(deletedId);
        onClose();
      }
      setDeleteConfirmOpen(false);
    } catch (error: any) {
      alert(`Error deleting company: ${error?.message || error}`);
      setDeleteConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  }, [
    company,
    onDelete,
    hasNextInPage,
    hasPreviousInPage,
    companies,
    currentIndex,
    onCompanyChange,
    hasNextPage,
    hasPreviousPage,
    onPageChange,
    currentPage,
    onClose,
  ]);

  useEffect(() => {
    if (!isOpen || !company) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      if (e.key === 'ArrowLeft' && hasPrevious) {
        e.preventDefault();
        handlePrevious();
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        handleNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, company, hasPrevious, hasNext, handlePrevious, handleNext]);

  /* ---------- Contact Card (refreshed style) ---------- */
  const CONTACT_STATUS_OPTIONS = [
    "Not Contacted",
    "Contacted",
    "In Discussion",
    "Interested",
    "Not Interested",
    "Closed",
  ];

  const getStatusPillClasses = (status: string) => {
    switch (status) {
      case "Contacted":
        return "bg-blue-50 text-blue-700 border-blue-200";
      case "In Discussion":
        return "bg-amber-50 text-amber-700 border-amber-200";
      case "Interested":
        return "bg-emerald-50 text-emerald-700 border-emerald-200";
      case "Not Interested":
        return "bg-red-50 text-red-700 border-red-200";
      case "Closed":
        return "bg-purple-50 text-purple-700 border-purple-200";
      default:
        return "bg-gray-50 text-gray-700 border-gray-200";
    }
  };

  const ContactCard = ({
    contact,
    index,
    onToggle,
    onRemove,
    onStatusChange,
    onEdit,
    onFieldChange,
    onGetDetails,
    isEnriching,
    enrichingMode,
  }: {
    contact: any;
    index: number;
    onToggle: (contactId: string | number, checked: boolean) => void;
    onRemove: (contactId: string | number, contactName: string) => void;
    onStatusChange: (contactId: string | number, status: string) => void;
    onEdit: (contactId: string | number) => void;
    onFieldChange: (contactId: string | number, field: string, value: string) => void;
    onGetDetails: (
      contactId: string | number,
      personId: string,
      revealEmail: boolean
    ) => void;
    isEnriching: boolean;
    enrichingMode: "basic" | "email" | null;
  }) => {
    const [imageError, setImageError] = useState(false);
    const [copiedItem, setCopiedItem] = useState<string | null>(null);
    const [editingEmail, setEditingEmail] = useState(false);
    const [emailDraft, setEmailDraft] = useState("");
    const [messagesExpanded, setMessagesExpanded] = useState(false);
    const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
    const [cardChannelFilter, setCardChannelFilter] = useState<TemplateChannel | "all">("all");
    const [cardCategoryFilter, setCardCategoryFilter] = useState<string>("all");
    const [cardSearch, setCardSearch] = useState("");
    const showPlaceholder = !contact.photo_url || imageError;

    const contactId = contact.person_id || contact.email || contact.full_name || index;
    const isChecked = contact.checked === true;
    const hasPersonId = Boolean(contact.person_id);
    const isEnriched = Boolean(contact.enriched_at);
    const hasBasicDetails = Boolean(
      contact.linkedin_url || contact.title || contact.headline
    );
    const hasEmail = Boolean(contact.email);
    const canGetDetails = hasPersonId && !isEnriched && !hasBasicDetails;
    const canGetEmail = hasPersonId && !isEnriched && !hasEmail;
    const contactName =
      contact.full_name ||
      `${contact.first_name || ""} ${contact.last_name || ""}`.trim() ||
      contact.email ||
      "Unknown";

    const handleCopy = async (text: string, itemType: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedItem(itemType);
        setTimeout(() => setCopiedItem(null), 2000);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    };

    const getComposeUrl = (email: string): string => {
      if (!company) return `mailto:${email}`;
      const trimmedEmail = email.trim();
      const subjectColumn = typeof window !== 'undefined'
        ? localStorage.getItem('companies-subject-column')
        : null;
      const clipboardColumn = typeof window !== 'undefined'
        ? localStorage.getItem('companies-clipboard-column')
        : null;
      let subject: string | undefined;
      let body: string | undefined;
      if (subjectColumn) {
        try {
          const subjectValue = getCellValue(company, subjectColumn);
          if (subjectValue && subjectValue !== '-') subject = subjectValue;
        } catch (_) {}
      }
      if (clipboardColumn) {
        try {
          const clipboardValue = getCellValue(company, clipboardColumn);
          if (clipboardValue && clipboardValue !== '-') {
            let firstName = '';
            if (contact.first_name) {
              firstName = contact.first_name;
            } else if (contact.full_name) {
              const nameParts = contact.full_name.trim().split(/\s+/);
              firstName = nameParts[0] || '';
            }
            const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
            body = buildEmailBody(clipboardValue, greeting, emailSettings);
          }
        } catch (_) {}
      }
      return buildEmailComposeUrl(trimmedEmail, { subject, body, emailSettings });
    };

    const actionProfileClass =
      contact.isActionProfile === true
        ? "bg-green-50 border-green-300 hover:bg-green-100"
        : contact.isActionProfile === false
        ? "bg-gray-100 border-gray-300 hover:bg-gray-200"
        : isChecked
        ? "border-indigo-300 bg-indigo-50/30 hover:bg-indigo-50/50"
        : "bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300";

    return (
      <div
        className={`border rounded-lg p-4 shadow-sm transition-colors ${actionProfileClass}`}
      >
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={isChecked}
            onChange={(e) => onToggle(contactId, e.target.checked)}
            className="mt-1 w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500 cursor-pointer flex-shrink-0"
            title={isChecked ? "Uncheck contact" : "Check contact"}
          />
          <div className="relative w-12 h-12 flex-shrink-0">
            {contact.photo_url && !imageError && (
              <img
                src={contact.photo_url}
                alt={contact.full_name || "Contact"}
                className="w-12 h-12 rounded-full object-cover border border-gray-200"
                onError={() => setImageError(true)}
              />
            )}
            {showPlaceholder && (
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center border border-gray-200">
                <User className="w-6 h-6 text-gray-400" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {(() => {
                  let firstName = contact.first_name || "";
                  let lastName = contact.last_name || "";
                  if ((!firstName || !lastName) && contact.full_name) {
                    const parts = contact.full_name.trim().split(/\s+/);
                    if (!firstName) firstName = parts[0] || "";
                    if (!lastName) lastName = parts.slice(1).join(" ");
                  }
                  const domain = company?.domain || "";
                  const nameToken = [firstName, lastName].filter(Boolean).join("_");
                  const nameTokenSpaced = [firstName, lastName].filter(Boolean).join(" ");
                  const composeTarget =
                    nameToken && domain ? `${nameToken}@${domain}` : nameToken || domain;
                  const copyTarget =
                    nameTokenSpaced && domain
                      ? `${nameTokenSpaced}@${domain}`
                      : nameTokenSpaced || domain;

                  const cleanDomain = domain
                    .replace(/^https?:\/\//i, "")
                    .replace(/^www\./, "")
                    .replace(/\/.*$/, "")
                    .trim();
                  const companyToken = cleanDomain.split(".")[0] || "";
                  const linkedInSearchUrl = (() => {
                    if (!contactName || contactName === "Unknown") return null;
                    const queryParts: string[] = [`"${contactName}"`];
                    const orParts: string[] = [];
                    if (company?.set_name) orParts.push(`"${company.set_name}"`);
                    if (companyToken) orParts.push(companyToken);
                    if (contact.title) orParts.push(`"${contact.title}"`);
                    if (orParts.length) queryParts.push(`(${orParts.join(" OR ")})`);
                    const query = `site:linkedin.com/in ${queryParts.join(" ")}`;
                    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                  })();
                  const linkedInSearchButton = linkedInSearchUrl ? (
                    <button
                      onClick={() =>
                        window.open(linkedInSearchUrl, "_blank", "noopener,noreferrer")
                      }
                      className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors flex-shrink-0"
                      title={`Search Google for ${contactName} on LinkedIn`}
                    >
                      <Search className="w-3.5 h-3.5" />
                    </button>
                  ) : null;

                  if (!composeTarget) {
                    return (
                      <div className="flex items-center gap-1.5 min-w-0">
                        <h3 className="font-semibold text-gray-900 truncate">
                          {contactName}
                        </h3>
                        {linkedInSearchButton}
                      </div>
                    );
                  }
                  return (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <h3 className="font-semibold text-gray-900 truncate">
                        <a
                          href={getComposeUrl(composeTarget)}
                          onClick={(e) => {
                            e.preventDefault();
                            window.open(
                              getComposeUrl(composeTarget),
                              "_blank",
                              "noopener,noreferrer"
                            );
                          }}
                          className="hover:text-indigo-700 hover:underline"
                          title={`Compose email to ${composeTarget}`}
                        >
                          {contactName}
                        </a>
                      </h3>
                      <button
                        onClick={() => handleCopy(copyTarget, `name-email-${index}`)}
                        className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors flex-shrink-0"
                        title={`Copy ${copyTarget}`}
                      >
                        {copiedItem === `name-email-${index}` ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {linkedInSearchButton}
                    </div>
                  );
                })()}
                {contact.title && (
                  <p className="text-sm text-gray-600 mt-0.5 truncate">{contact.title}</p>
                )}
                {contact.headline && (
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">
                    {contact.headline}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <select
                  value={contact.status || ""}
                  onChange={(e) => onStatusChange(contactId, e.target.value)}
                  className={`text-xs font-medium border rounded px-2 py-1 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 ${getStatusPillClasses(
                    contact.status || ""
                  )}`}
                  title="Set contact status"
                >
                  <option value="">No status</option>
                  {CONTACT_STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => onEdit(contactId)}
                  className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                  title="Edit contact"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => onRemove(contactId, contactName)}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                  title="Remove contact"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-x-4 gap-y-2">
              <div className="flex items-center gap-1.5 text-sm">
                <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                {editingEmail ? (
                  <>
                    <input
                      type="email"
                      autoFocus
                      value={emailDraft}
                      onChange={(e) => setEmailDraft(e.target.value)}
                      onBlur={() => {
                        const next = emailDraft.trim();
                        if (next !== (contact.email || "")) {
                          onFieldChange(contactId, "email", next);
                        }
                        setEditingEmail(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          (e.currentTarget as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                          setEditingEmail(false);
                        }
                      }}
                      placeholder="jane@example.com"
                      className="flex-1 min-w-[180px] px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  </>
                ) : contact.email ? (
                  <>
                    <a
                      href={getComposeUrl(contact.email)}
                      onClick={(e) => {
                        e.preventDefault();
                        window.open(getComposeUrl(contact.email), '_blank', 'noopener,noreferrer');
                      }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        setEmailDraft(contact.email || "");
                        setEditingEmail(true);
                      }}
                      title="Double click to edit"
                      className="text-indigo-600 hover:text-indigo-800 hover:underline truncate max-w-[180px]"
                    >
                      {contact.email}
                    </a>
                    {contact.email_status === "verified" ? (
                      <CheckCircle
                        className="w-3.5 h-3.5 text-green-600 flex-shrink-0"
                        aria-label="Verified email"
                      />
                    ) : contact.email_status ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-100 text-gray-700">
                        {contact.email_status}
                      </span>
                    ) : null}
                    <button
                      onClick={() => handleCopy(contact.email, `email-${index}`)}
                      className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                      title="Copy email"
                    >
                      {copiedItem === `email-${index}` ? (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => {
                        setEmailDraft(contact.email || "");
                        setEditingEmail(true);
                      }}
                      className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                      title="Edit email"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setEmailDraft("");
                      setEditingEmail(true);
                    }}
                    className="text-xs text-gray-500 hover:text-indigo-600 italic"
                    title="Add email"
                  >
                    Add email
                  </button>
                )}
              </div>
              {contact.phone && (
                <div className="flex items-center gap-1.5 text-sm">
                  <Phone className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a
                    href={`tel:${contact.phone}`}
                    className="text-indigo-600 hover:text-indigo-800 hover:underline"
                  >
                    {contact.phone}
                  </a>
                </div>
              )}
              {contact.linkedin_url && (
                <div className="flex items-center gap-1.5 text-sm">
                  <a
                    href={contact.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-400 hover:text-indigo-600 transition-colors"
                    title="Open LinkedIn profile"
                  >
                    <Linkedin className="w-4 h-4" />
                  </a>
                  <button
                    onClick={() => handleCopy(contact.linkedin_url, `linkedin-${index}`)}
                    className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                    title="Copy LinkedIn URL"
                  >
                    {copiedItem === `linkedin-${index}` ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              )}
              {canGetDetails && (
                <button
                  onClick={() => onGetDetails(contactId, contact.person_id, false)}
                  disabled={isEnriching}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  title="Fetch missing details for this contact"
                >
                  {isEnriching && enrichingMode === "basic" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  {isEnriching && enrichingMode === "basic" ? "Getting…" : "Get details"}
                </button>
              )}
              {canGetEmail && (
                <button
                  onClick={() => onGetDetails(contactId, contact.person_id, true)}
                  disabled={isEnriching}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  title="Fetch missing details and reveal email"
                >
                  {isEnriching && enrichingMode === "email" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Mail className="w-3.5 h-3.5" />
                  )}
                  {isEnriching && enrichingMode === "email"
                    ? "Getting…"
                    : "Get details with email"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setMessagesExpanded((v) => !v)}
                className={`ml-auto inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded border transition-colors ${
                  messagesExpanded
                    ? "border-indigo-300 bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
                    : "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                }`}
                title={messagesExpanded ? "Hide outreach messages" : "Show outreach messages"}
                aria-expanded={messagesExpanded}
              >
                {messagesExpanded ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <Mail className="w-3.5 h-3.5" />
                )}
                {messagesExpanded ? "Hide messages" : "Show messages"}
              </button>
            </div>
          </div>
        </div>
        {messagesExpanded && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            {(() => {
              const populatedKeys = columnOrder
                .filter((c) => isOutreachColumn(c) && !shouldHideDrawerField(c))
                .filter((c) => {
                  const v = renderOutreachForContact(c, contact);
                  return v && v !== "-";
                });

              if (populatedKeys.length === 0) {
                return (
                  <p className="text-xs text-gray-400 italic">
                    No outreach messages available for this company yet.
                  </p>
                );
              }

              // Filter option discovery (channels and categories present in
              // populated template-backed columns).
              const cardAvailableChannels = new Set<TemplateChannel>();
              const cardAvailableCategories = new Set<string>();
              for (const key of populatedKeys) {
                const tpl = getTemplateForColumn(key);
                if (!tpl) continue;
                cardAvailableChannels.add(tpl.channel);
                const cat = (tpl.category || "").trim();
                if (cat) cardAvailableCategories.add(cat);
              }
              const cardVisibleChannels = (
                ["email", "linkedin", "direct", "instagram"] as TemplateChannel[]
              ).filter((ch) => cardAvailableChannels.has(ch));
              const cardVisibleCategories = Array.from(cardAvailableCategories).sort(
                (a, b) => a.localeCompare(b)
              );

              const cardFiltersActive =
                cardChannelFilter !== "all" ||
                cardCategoryFilter !== "all" ||
                cardSearch.trim().length > 0;
              const cardSearchLower = cardSearch.trim().toLowerCase();

              const filteredKeys = populatedKeys.filter((c) => {
                if (!cardFiltersActive) return true;
                const tpl = getTemplateForColumn(c);
                if (!tpl) return false;
                if (cardChannelFilter !== "all" && tpl.channel !== cardChannelFilter) {
                  return false;
                }
                if (
                  cardCategoryFilter !== "all" &&
                  (tpl.category || "").trim() !== cardCategoryFilter
                ) {
                  return false;
                }
                if (
                  cardSearchLower &&
                  !(tpl.title || "").toLowerCase().includes(cardSearchLower)
                ) {
                  return false;
                }
                return true;
              });

              const subjectColumn =
                typeof window !== "undefined"
                  ? localStorage.getItem("companies-subject-column")
                  : null;

              const getSubjectForContact = (): string | undefined => {
                if (!subjectColumn) return undefined;
                try {
                  const v = renderOutreachForContact(subjectColumn, contact);
                  return v && v !== "-" ? v : undefined;
                } catch (_) {
                  return undefined;
                }
              };

              const getGreeting = (): string => {
                let firstName = "";
                if (contact.first_name) {
                  firstName = contact.first_name;
                } else if (contact.full_name) {
                  const parts = contact.full_name.trim().split(/\s+/);
                  firstName = parts[0] || "";
                }
                return firstName ? `Hi ${firstName},` : "Hi,";
              };

              const handleCopyMsg = async (key: string, text: string) => {
                try {
                  await navigator.clipboard.writeText(text);
                  setCopiedMessageKey(key);
                  setTimeout(() => setCopiedMessageKey(null), 2000);
                } catch (err) {
                  console.error("Failed to copy:", err);
                }
              };

              const handleSendEmail = (messageText: string) => {
                if (!contact.email) return;
                const subject = getSubjectForContact();
                const body = buildEmailBody(messageText, getGreeting(), emailSettings);
                const url = buildEmailComposeUrl(contact.email, {
                  subject,
                  body,
                  emailSettings,
                });
                window.open(url, "_blank", "noopener,noreferrer");
              };

              const handleSendLinkedIn = async (key: string, messageText: string) => {
                if (!contact.linkedin_url) return;
                try {
                  await navigator.clipboard.writeText(messageText);
                  setCopiedMessageKey(`linkedin-${key}`);
                  setTimeout(() => setCopiedMessageKey(null), 2000);
                } catch (err) {
                  console.error("Failed to copy:", err);
                }
                window.open(contact.linkedin_url, "_blank", "noopener,noreferrer");
              };

              const handleCopyAllForContact = async () => {
                try {
                  const combined = filteredKeys
                    .map((k) => {
                      const label = columnLabels[k] || k;
                      const value = renderOutreachForContact(k, contact);
                      return `${label}\n${value}`;
                    })
                    .join("\n\n");
                  await navigator.clipboard.writeText(combined);
                  setCopiedMessageKey("__all__");
                  setTimeout(() => setCopiedMessageKey(null), 2000);
                } catch (err) {
                  console.error("Failed to copy all:", err);
                }
              };

              return (
                <>
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider truncate">
                      Outreach for {contactName}
                    </p>
                    <button
                      type="button"
                      onClick={handleCopyAllForContact}
                      disabled={filteredKeys.length === 0}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-indigo-600 bg-indigo-50 rounded hover:bg-indigo-100 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Copy all messages with labels"
                    >
                      {copiedMessageKey === "__all__" ? (
                        <Check className="w-3 h-3 text-emerald-500" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      {copiedMessageKey === "__all__" ? "Copied!" : "Copy All"}
                    </button>
                  </div>

                  {/* Filters: search + channel + category */}
                  <div className="space-y-2 mb-2">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={cardSearch}
                        onChange={(e) => setCardSearch(e.target.value)}
                        placeholder="Search by title..."
                        className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {cardVisibleChannels.length > 0 && (
                        <select
                          value={cardChannelFilter}
                          onChange={(e) =>
                            setCardChannelFilter(e.target.value as TemplateChannel | "all")
                          }
                          className="px-2 py-1 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                        >
                          <option value="all">All channels</option>
                          {cardVisibleChannels.map((ch) => (
                            <option key={ch} value={ch}>
                              {CHANNEL_LABELS[ch]}
                            </option>
                          ))}
                        </select>
                      )}
                      {cardVisibleCategories.length > 0 && (
                        <select
                          value={cardCategoryFilter}
                          onChange={(e) => setCardCategoryFilter(e.target.value)}
                          className="px-2 py-1 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                        >
                          <option value="all">All categories</option>
                          {cardVisibleCategories.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
                      )}
                      {cardFiltersActive && (
                        <button
                          type="button"
                          onClick={() => {
                            setCardChannelFilter("all");
                            setCardCategoryFilter("all");
                            setCardSearch("");
                          }}
                          className="px-2 py-1 text-[11px] font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  </div>

                  {filteredKeys.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">
                      No messages match the current filters.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {filteredKeys.map((columnKey) => {
                        const value = renderOutreachForContact(columnKey, contact);
                        const label = columnLabels[columnKey] || columnKey;
                        return (
                          <div
                            key={columnKey}
                            className="bg-gray-50 border border-gray-200 rounded p-2.5"
                          >
                            <div className="flex items-center justify-between mb-1.5 gap-2">
                              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider truncate">
                                {label}
                              </p>
                              <div className="flex items-center gap-0.5 flex-shrink-0">
                                {contact.email && (
                                  <button
                                    type="button"
                                    onClick={() => handleSendEmail(value)}
                                    className="p-0.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                    title={`Open in email to ${contact.email}`}
                                  >
                                    <Mail className="w-3 h-3" />
                                  </button>
                                )}
                                {contact.linkedin_url && (
                                  <button
                                    type="button"
                                    onClick={() => handleSendLinkedIn(columnKey, value)}
                                    className="p-0.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                                    title="Copy message & open LinkedIn"
                                  >
                                    {copiedMessageKey === `linkedin-${columnKey}` ? (
                                      <Check className="w-3 h-3 text-emerald-500" />
                                    ) : (
                                      <Linkedin className="w-3 h-3" />
                                    )}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleCopyMsg(columnKey, value)}
                                  className="p-0.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                  title={`Copy ${label}`}
                                >
                                  {copiedMessageKey === columnKey ? (
                                    <Check className="w-3 h-3 text-emerald-500" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </div>
                            </div>
                            <pre className="text-xs text-gray-800 whitespace-pre-wrap font-sans break-words">
                              {value}
                            </pre>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>
    );
  };

  const summaryData = company ? getSummaryData(company) : {};
  const isOutreachColumn = (columnKey: string) => {
    const key = columnKey.toLowerCase();
    const label = (columnLabels[columnKey] || columnKey).toLowerCase();
    return key.startsWith("template_") || key.includes("message") || label.includes("message");
  };
  const shouldHideDrawerField = (columnKey: string) => {
    const key = columnKey.toLowerCase();
    const label = (columnLabels[columnKey] || columnKey).toLowerCase();
    const keyOrLabel = `${key} ${label}`;
    return (
      keyOrLabel.includes("confidence_score") ||
      keyOrLabel.includes("confidence score") ||
      keyOrLabel.includes("sales_action") ||
      keyOrLabel.includes("sales action")
    );
  };
  const summaryColumnKeys = useMemo(() => {
    const exclude = (column: string) => {
      if (
        column === "domain" ||
        column === "instagram" ||
        column === "phone" ||
        column === "email" ||
        column === "notes" ||
        column === "set_name" ||
        column === "classification"
      ) {
        return true;
      }
      if (isOutreachColumn(column)) return true;
      if (shouldHideDrawerField(column)) return true;
      return false;
    };

    const fromOrder = columnOrder.filter((c) => !exclude(c));
    const fromSummary = Object.keys(summaryData || {}).filter((c) => !exclude(c));
    return Array.from(new Set([...fromOrder, ...fromSummary]));
  }, [columnOrder, summaryData, columnLabels]);

  if (!isOpen || !company) return null;

  /* ---------- Display values ---------- */
  const summaryCompanyName = (summaryData?.company_name ?? "").toString().trim();
  const hasDomain = !!company.domain?.trim();
  const displayName =
    company.domain?.trim() ||
    summaryCompanyName ||
    company.instagram?.trim() ||
    company.email?.trim() ||
    "Company Details";

  // Person profile entries (created by Person Research) store a LinkedIn handle
  // in `domain` like "linkedin.com/in/abhishekraniwala". Hide contacts UI for these.
  const isPersonProfile = /linkedin\.com\/in\//i.test(company.domain || "");

  const classificationLabel =
    classificationValue === "QUALIFIED"
      ? "Qualified"
      : classificationValue === "UNQUALIFIED" || classificationValue === "NOT_QUALIFIED"
      ? "Unqualified"
      : classificationValue === "MAYBE"
      ? "Maybe"
      : classificationValue === "EXPIRED"
      ? "Expired"
      : null;

  const classificationPillClasses =
    classificationValue === "QUALIFIED"
      ? "bg-emerald-100 text-emerald-800"
      : classificationValue === "UNQUALIFIED" || classificationValue === "NOT_QUALIFIED"
      ? "bg-red-100 text-red-800"
      : classificationValue === "MAYBE"
      ? "bg-amber-100 text-amber-800"
      : classificationValue === "EXPIRED"
      ? "bg-gray-200 text-gray-700"
      : "bg-gray-100 text-gray-800";

  const phones = (company.phone || "").split(',').map((s) => s.trim()).filter((s) => s && s !== '-');
  const emails = (company.email || "").split(',').map((s) => s.trim()).filter((s) => s && s !== '-');

  const buildEmailHref = (emailAddr: string): string => {
    const subjectColumn = typeof window !== 'undefined'
      ? localStorage.getItem('companies-subject-column')
      : null;
    const clipboardColumn = typeof window !== 'undefined'
      ? localStorage.getItem('companies-clipboard-column')
      : null;
    let subject: string | undefined;
    let body: string | undefined;
    if (subjectColumn) {
      try {
        const v = getCellValue(company, subjectColumn);
        if (v && v !== '-') subject = v;
      } catch (_) {}
    }
    if (clipboardColumn) {
      try {
        const v = getCellValue(company, clipboardColumn);
        if (v && v !== '-') body = buildEmailBody(v, 'Hi, \n\n', emailSettings);
      } catch (_) {}
    }
    return buildEmailComposeUrl(emailAddr, { subject, body, emailSettings });
  };

  const renderEditableValue = (columnKey: string, value: string) => {
    const isEditing =
      editingCell?.companyId === company.id &&
      editingCell?.columnKey === columnKey;
    const isEditable =
      !columnKey.startsWith("template_") &&
      columnKey !== "domain" &&
      columnKey !== "instagram";
    const isLongText = value.length > 100;
    const isTextareaField = value.length > 60;

    if (isEditing) {
      return (
        <div className="flex items-start gap-2">
          {isTextareaField ? (
            <textarea
              ref={editInputRef as React.RefObject<HTMLTextAreaElement>}
              value={editingCell!.value}
              onChange={(e) =>
                setEditingCell((prev) => (prev ? { ...prev, value: e.target.value } : prev))
              }
              onBlur={handleInlineEditSave}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  handleInlineEditSave();
                } else if (e.key === "Escape") {
                  setEditingCell(null);
                }
              }}
              className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
              rows={3}
            />
          ) : (
            <input
              ref={editInputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={editingCell!.value}
              onChange={(e) =>
                setEditingCell((prev) => (prev ? { ...prev, value: e.target.value } : prev))
              }
              onBlur={handleInlineEditSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleInlineEditSave();
                } else if (e.key === "Escape") {
                  setEditingCell(null);
                }
              }}
              className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          )}
          <div className="flex flex-col gap-1">
            <button
              onClick={handleInlineEditSave}
              className="text-emerald-600 hover:text-emerald-800"
              title="Save (Enter)"
            >
              ✓
            </button>
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                setEditingCell(null);
              }}
              className="text-red-600 hover:text-red-800"
              title="Cancel (Esc)"
            >
              ✕
            </button>
          </div>
        </div>
      );
    }

    const isCopied = copiedDetailKey === columnKey;
    return (
      <p
        className={`text-sm ${isCopied ? "text-emerald-700 bg-emerald-50" : "text-gray-900"} ${isLongText ? "whitespace-pre-wrap break-words" : ""} cursor-pointer ${
          isEditable ? "hover:bg-blue-50 -mx-1 px-1 rounded transition-colors" : "hover:bg-gray-50 -mx-1 px-1 rounded transition-colors"
        }`}
        onClick={() => {
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          clickTimerRef.current = setTimeout(async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopiedDetailKey(columnKey);
              setTimeout(() => setCopiedDetailKey(null), 2000);
            } catch {}
          }, 250);
        }}
        onDoubleClick={isEditable ? () => {
          if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
          handleCellDoubleClick(company, columnKey);
        } : () => {
          if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
        }}
        title={isEditable ? "Click to copy · Double click to edit" : "Click to copy"}
      >
        {value}
      </p>
    );
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-2xl bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrevious}
              disabled={!hasPrevious}
              className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Previous company"
              title="Previous company (←)"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={handleNext}
              disabled={!hasNext}
              className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Next company"
              title="Next company (→)"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            {companies.length > 0 && currentIndex >= 0 && (
              <span className="text-xs text-gray-500 ml-1">
                {currentIndex + 1} of {companies.length}
                {totalPages > 1 && ` • Page ${currentPage}/${totalPages}`}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="relative border-b border-gray-200 flex-shrink-0">
          <div className="flex gap-0.5 sm:gap-1 px-2 sm:px-4 pt-2 overflow-x-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
            <button
              onClick={() => handleSelectTab("overview")}
              className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === "overview"
                  ? "border-indigo-600 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => handleSelectTab("outreach")}
              className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === "outreach"
                  ? "border-indigo-600 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              Outreach
            </button>
            <button
              onClick={() => handleSelectTab("latest-news")}
              className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === "latest-news"
                  ? "border-indigo-600 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              Latest News
            </button>
            {!isPersonProfile && (
              <button
                onClick={() => handleSelectTab("contacts")}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === "contacts"
                    ? "border-indigo-600 text-indigo-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                Contacts
              </button>
            )}
            <div className="flex-shrink-0 w-4 sm:hidden" aria-hidden="true" />
          </div>
          <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-white to-transparent pointer-events-none sm:hidden" />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "overview" ? (
            <div className="space-y-6">
              {/* Title + status pills */}
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {hasDomain && (() => {
                      const cleanDomain = company.domain!
                        .replace(/^https?:\/\//i, '')
                        .replace(/^www\./, '')
                        .replace(/\/.*$/, '')
                        .trim();
                      if (!cleanDomain) return null;
                      return (
                        <img
                          src={`https://www.google.com/s2/favicons?domain=${cleanDomain}&sz=64`}
                          alt=""
                          className="w-6 h-6 rounded flex-shrink-0"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      );
                    })()}
                    <h2 className="text-xl font-semibold text-gray-900 break-all">{displayName}</h2>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!hasDomain && summaryCompanyName && (
                      <button
                        type="button"
                        onClick={() => {
                          const query = `${summaryCompanyName} official website`;
                          const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                          window.open(url, '_blank', 'noopener,noreferrer');
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-md hover:bg-amber-100 transition-colors"
                        title={`Search Google for ${summaryCompanyName}'s website`}
                      >
                        <Search className="w-3.5 h-3.5" />
                        Find Website
                      </button>
                    )}
                    {company.domain?.trim() && !isPersonProfile && (
                      <button
                        type="button"
                        onClick={() => {
                          const domain = company.domain!.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/$/, '');
                          const name = domain.split('.')[0];
                          const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
                          const query = `site:linkedin.com/in ("${capitalized}" OR "${domain}") ("Founder" OR "Co-Founder" OR "CEO" OR "Head of Marketing" OR "CMO" OR "VP Marketing" OR "Director Marketing" OR "Head of Growth" OR "Head of Communications" OR "Head of Brand" OR "Creative Director" OR "Head of Content")`;
                          const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                          window.open(url, '_blank', 'noopener,noreferrer');
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-md hover:bg-emerald-100 transition-colors"
                        title="Find people on LinkedIn via Google search"
                      >
                        <Users className="w-3.5 h-3.5" />
                        Find People
                      </button>
                    )}
                    {company.domain?.trim() && (
                      <button
                        type="button"
                        onClick={handleReanalyze}
                        disabled={reanalyzing}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        title="Re-run domain analysis and update fields"
                      >
                        {reanalyzing ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        {reanalyzing ? 'Reanalyzing...' : 'Reanalyze'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleOpenJsonImport}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 rounded-md hover:bg-indigo-100 transition-colors"
                      title="Import contact details from JSON"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Import JSON
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-2 items-center">
                  {classificationLabel && (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${classificationPillClasses}`}
                    >
                      {classificationValue === "QUALIFIED" ? (
                        <CheckCircle className="w-3 h-3" />
                      ) : classificationValue === "UNQUALIFIED" || classificationValue === "NOT_QUALIFIED" ? (
                        <XCircle className="w-3 h-3" />
                      ) : classificationValue === "MAYBE" ? (
                        <HelpCircle className="w-3 h-3" />
                      ) : (
                        <Minus className="w-3 h-3" />
                      )}
                      {classificationLabel}
                    </span>
                  )}
                  {company.set_name && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-800">
                      {company.set_name}
                    </span>
                  )}
                  {company.instagram && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-pink-100 text-pink-800">
                      @{company.instagram.replace(/^@/, '')}
                    </span>
                  )}
                </div>
              </div>

              {/* Start a Conversation */}
              {(company.domain?.trim() || emails.length > 0 || phones.length > 0 || company.instagram?.trim()) && (
                <div>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                    Start a Conversation
                  </h3>
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-1">
                      {company.domain?.trim() && (
                        <>
                          <a
                            href={
                              /^https?:\/\//i.test(company.domain)
                                ? company.domain
                                : `https://${company.domain.replace(/^www\./, '')}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 rounded-lg text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            title={company.domain}
                            aria-label="Visit website"
                          >
                            <Globe className="w-5 h-5" />
                          </a>
                          <a
                            href={
                              /^https?:\/\//i.test(company.domain)
                                ? company.domain
                                : `https://${company.domain.replace(/^www\./, '')}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline break-all"
                            title={company.domain}
                          >
                            {company.domain.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
                          </a>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const value = company.domain!.replace(/^https?:\/\//i, '').replace(/\/$/, '');
                                await navigator.clipboard.writeText(value);
                                setDomainCopied(true);
                                setToastMessage('Domain copied to clipboard');
                                setToastVisible(true);
                                setTimeout(() => setDomainCopied(false), 2000);
                                setTimeout(() => setToastVisible(false), 2000);
                              } catch (err) {
                                console.error('Failed to copy domain:', err);
                              }
                            }}
                            className="p-1.5 rounded-lg text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            title="Copy domain"
                            aria-label="Copy domain"
                          >
                            {domainCopied ? (
                              <Check className="w-4 h-4 text-emerald-600" />
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </button>
                        </>
                      )}
                      {company.instagram?.trim() && (
                        <>
                          <a
                            href={`https://instagram.com/${company.instagram.replace(/^@/, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 rounded-lg text-gray-500 hover:text-pink-600 hover:bg-pink-50 transition-colors"
                            title="Instagram"
                            aria-label="Open Instagram"
                          >
                            <Instagram className="w-5 h-5" />
                          </a>
                          <a
                            href={`https://instagram.com/${company.instagram.replace(/^@/, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-pink-600 hover:text-pink-800 hover:underline break-all"
                            title="Instagram"
                          >
                            @{company.instagram.replace(/^@/, '')}
                          </a>
                        </>
                      )}
                    </div>
                    {emails.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        <div className="flex flex-wrap gap-x-3 gap-y-0">
                          {emails.map((e, idx) => (
                            <a
                              key={idx}
                              href={buildEmailHref(e)}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(ev) => {
                                ev.preventDefault();
                                window.open(buildEmailHref(e), '_blank', 'noopener,noreferrer');
                              }}
                              className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                            >
                              {e}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                    {phones.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Phone className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        <div className="flex flex-wrap gap-x-3 gap-y-0">
                          {phones.map((p, idx) => {
                            const cleaned = p.replace(/[^\d+]/g, '');
                            return (
                              <a
                                key={idx}
                                href={`tel:${cleaned}`}
                                className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                              >
                                {p}
                              </a>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Editable Phone */}
              {(editingCell?.companyId === company.id && editingCell?.columnKey === "phone") || !company.phone || phones.length === 0 ? (
                <DetailField label={columnLabels.phone || "Phone"}>
                  {editingCell?.companyId === company.id && editingCell?.columnKey === "phone" ? (
                    <div className="flex items-center gap-2">
                      <PhoneInputField
                        value={editingCell.value}
                        onChange={(phone) =>
                          setEditingCell((prev) => (prev ? { ...prev, value: phone } : prev))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleInlineEditSave();
                          } else if (e.key === "Escape") {
                            setEditingCell(null);
                          }
                        }}
                        compact
                        autoFocus
                        className="flex-1"
                      />
                      <button
                        onClick={handleInlineEditSave}
                        className="text-emerald-600 hover:text-emerald-800"
                        title="Save (Enter)"
                      >
                        ✓
                      </button>
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setEditingCell(null);
                        }}
                        className="text-red-600 hover:text-red-800"
                        title="Cancel (Esc)"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <p
                      className="text-sm text-gray-900 cursor-pointer hover:bg-blue-50 -mx-1 px-1 rounded transition-colors"
                      onDoubleClick={() => handleCellDoubleClick(company, "phone")}
                      title="Double click to edit"
                    >
                      -
                    </p>
                  )}
                </DetailField>
              ) : null}

              {/* Editable Email */}
              {(editingCell?.companyId === company.id && editingCell?.columnKey === "email") || !company.email || emails.length === 0 ? (
                <DetailField label={columnLabels.email || "Email"}>
                  {editingCell?.companyId === company.id && editingCell?.columnKey === "email" ? (
                    <div className="flex items-center gap-2">
                      <input
                        ref={editInputRef as React.RefObject<HTMLInputElement>}
                        type="text"
                        value={editingCell.value}
                        onChange={(e) =>
                          setEditingCell((prev) => (prev ? { ...prev, value: e.target.value } : prev))
                        }
                        onBlur={handleInlineEditSave}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleInlineEditSave();
                          } else if (e.key === "Escape") {
                            setEditingCell(null);
                          }
                        }}
                        className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <button
                        onClick={handleInlineEditSave}
                        className="text-emerald-600 hover:text-emerald-800"
                        title="Save (Enter)"
                      >
                        ✓
                      </button>
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setEditingCell(null);
                        }}
                        className="text-red-600 hover:text-red-800"
                        title="Cancel (Esc)"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <p
                      className="text-sm text-gray-900 cursor-pointer hover:bg-blue-50 -mx-1 px-1 rounded transition-colors"
                      onDoubleClick={() => handleCellDoubleClick(company, "email")}
                      title="Double click to edit"
                    >
                      -
                    </p>
                  )}
                </DetailField>
              ) : null}

              <hr className="border-gray-200" />

              {/* Pipeline (Set + Classification) */}
              <div className="space-y-4">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Pipeline</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      {columnLabels.classification || "Classification"}
                    </label>
                    <select
                      value={classificationValue}
                      onChange={(e) => handleClassificationChange(e.target.value)}
                      className={`block w-full px-3 py-2 text-sm font-medium rounded-lg border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                        classificationValue === "QUALIFIED"
                          ? "bg-emerald-50 text-emerald-800 border-emerald-300 focus:ring-emerald-500"
                          : classificationValue === "UNQUALIFIED" || classificationValue === "NOT_QUALIFIED"
                          ? "bg-red-50 text-red-800 border-red-300 focus:ring-red-500"
                          : classificationValue === "MAYBE"
                          ? "bg-amber-50 text-amber-800 border-amber-300 focus:ring-amber-500"
                          : classificationValue === "EXPIRED"
                          ? "bg-gray-100 text-gray-800 border-gray-300 focus:ring-gray-400"
                          : "bg-white text-gray-900 border-gray-300 focus:ring-indigo-500"
                      }`}
                    >
                      <option value="">— Select —</option>
                      <option value="QUALIFIED">Qualified</option>
                      <option value="MAYBE">Maybe</option>
                      <option value="UNQUALIFIED">Unqualified</option>
                      <option value="EXPIRED">Expired</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      {columnLabels.set_name || "Set"}
                    </label>
                    {(() => {
                      const currentSet = company.set_name || "";
                      const optionSet = new Set<string>(availableSetNames);
                      if (currentSet) optionSet.add(currentSet);
                      const options = Array.from(optionSet).sort((a, b) =>
                        a.localeCompare(b)
                      );
                      const selectValue = setNameCreating ? "__create_new_set__" : currentSet;
                      return (
                        <>
                          <select
                            value={selectValue}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === "__create_new_set__") {
                                setSetNameCreating(true);
                                setNewSetNameValue("");
                                return;
                              }
                              setSetNameCreating(false);
                              setNewSetNameValue("");
                              if (val !== currentSet) {
                                handleSetNameSave(val);
                              }
                            }}
                            className="block w-full px-3 py-2 text-sm font-medium rounded-lg border-2 border-gray-300 bg-white text-gray-900 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                          >
                            <option value="">— Not set —</option>
                            {options.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                            <option value="__create_new_set__" className="text-indigo-600 font-medium">
                              + Add new set
                            </option>
                          </select>
                          {setNameCreating && (
                            <div className="mt-2 flex items-center gap-2">
                              <input
                                autoFocus
                                type="text"
                                value={newSetNameValue}
                                onChange={(e) => setNewSetNameValue(e.target.value)}
                                placeholder="Enter new set name"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    const trimmed = newSetNameValue.trim();
                                    if (trimmed) {
                                      handleSetNameSave(trimmed);
                                      setSetNameCreating(false);
                                      setNewSetNameValue("");
                                    }
                                  } else if (e.key === "Escape") {
                                    setSetNameCreating(false);
                                    setNewSetNameValue("");
                                  }
                                }}
                                className="flex-1 block w-full px-3 py-2 text-sm rounded-lg border-2 border-indigo-500 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const trimmed = newSetNameValue.trim();
                                  if (trimmed) {
                                    handleSetNameSave(trimmed);
                                    setSetNameCreating(false);
                                    setNewSetNameValue("");
                                  }
                                }}
                                disabled={!newSetNameValue.trim()}
                                className="text-emerald-600 hover:text-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                title="Save"
                              >
                                ✓
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSetNameCreating(false);
                                  setNewSetNameValue("");
                                }}
                                className="text-gray-500 hover:text-gray-700"
                                title="Cancel"
                              >
                                ✕
                              </button>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>

              <hr className="border-gray-200" />

              {/* Notes */}
              <DetailSection
                label="Notes"
                icon={<FileText className="w-3.5 h-3.5 text-gray-400" />}
                action={
                  !isAddingNote ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleAddNote();
                      }}
                      className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-md hover:bg-indigo-100 transition-colors"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Add Note
                    </button>
                  ) : null
                }
              >
                {isAddingNote && (
                  <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50/30 mb-3">
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Message
                        </label>
                        <div className="flex flex-wrap gap-2 mb-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setNewNoteMessage('Not Picked');
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                          >
                            Not Picked
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setNewNoteMessage('Interested');
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-300 rounded-md hover:bg-emerald-100 transition-colors"
                          >
                            Interested
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setNewNoteMessage('Not Interested');
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-300 rounded-md hover:bg-red-100 transition-colors"
                          >
                            Not Interested
                          </button>
                        </div>
                        <textarea
                          value={newNoteMessage}
                          onChange={(e) => setNewNoteMessage(e.target.value)}
                          placeholder="Enter note message..."
                          rows={3}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                        {editingNoteIndex === null && (
                          <p className="mt-1 text-xs text-gray-500">
                            Date will be automatically set to today
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            editingNoteIndex !== null ? handleCancelEditNote() : handleCancelAddNote();
                          }}
                          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleSaveNote();
                          }}
                          disabled={!newNoteMessage.trim()}
                          className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {editingNoteIndex !== null ? 'Update' : 'Save'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {notes.length > 0 ? (
                  <div className="space-y-2">
                    {notes.map((note, index) => (
                      <div
                        key={index}
                        className="bg-white border border-gray-200 rounded-lg p-3 shadow-sm hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">
                              {new Date(note.date).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                              })}
                            </p>
                            <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                              {note.message}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleEditNote(index);
                              }}
                              className="p-1.5 rounded text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                              title="Edit note"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleDeleteNoteClick(index);
                              }}
                              className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                              title="Delete note"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  !isAddingNote && (
                    <p className="text-sm text-gray-500 italic">
                      No notes yet. Click &ldquo;Add Note&rdquo; to track conversation details.
                    </p>
                  )
                )}
              </DetailSection>

              {/* Summary Data */}
              {summaryColumnKeys.length > 0 && (() => {
                const visibleKeys = summaryColumnKeys.filter((k) => {
                  const v = getCellValue(company, k);
                  return v && v !== "-";
                });
                if (visibleKeys.length === 0) return null;
                return (
                  <>
                    <hr className="border-gray-200" />
                    <div className="space-y-3">
                      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Details
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                        {visibleKeys.map((columnKey) => {
                          const value = getCellValue(company, columnKey);
                          const label = columnLabels[columnKey] || columnKey;
                          const isLong = value.length > 80;

                          return (
                            <div
                              key={columnKey}
                              className={isLong ? "sm:col-span-2" : undefined}
                            >
                              <DetailField label={label}>
                                {renderEditableValue(columnKey, value)}
                              </DetailField>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                );
              })()}

              {/* Metadata */}
              <hr className="border-gray-200" />
              <div className="space-y-3">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Metadata
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                  <DetailField label="ID">
                    <p className="text-sm text-gray-900 font-mono break-all">{company.id}</p>
                  </DetailField>
                  {company.created_at && (
                    <DetailField label="Created At">
                      <p className="text-sm text-gray-900">
                        {new Date(company.created_at).toLocaleString()}
                      </p>
                    </DetailField>
                  )}
                  {company.updated_at && (
                    <DetailField label="Updated At">
                      <p className="text-sm text-gray-900">
                        {new Date(company.updated_at).toLocaleString()}
                      </p>
                    </DetailField>
                  )}
                </div>
                {onDelete && (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmOpen(true)}
                      disabled={deleting}
                      className="inline-flex items-center gap-2 px-3 py-1.5 border border-red-200 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50 hover:border-red-300 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Delete this company"
                    >
                      <Trash2 className="w-4 h-4" />
                      {deleting ? "Deleting…" : "Delete company"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : activeTab === "outreach" ? (
            <div className="space-y-4">
              {(() => {
                const filtersActive =
                  outreachChannelFilter !== "all" ||
                  outreachCategoryFilter !== "all" ||
                  outreachOfferFilter !== "all" ||
                  outreachSearch.trim().length > 0;
                // Includes the "starred only" view toggle — used for the empty
                // state copy and the Clear-filters affordance.
                const anyFilterActive = filtersActive || outreachStarredOnly;
                const searchLower = outreachSearch.trim().toLowerCase();

                const populatedOutreachKeys = columnOrder
                  .filter((c) => isOutreachColumn(c) && !shouldHideDrawerField(c))
                  .filter((c) => {
                    const v = getOutreachValue(c);
                    return v && v !== "-";
                  });

                const availableChannels = new Set<TemplateChannel>();
                const availableCategories = new Set<string>();
                const availableOffers = new Set<string>();
                for (const key of populatedOutreachKeys) {
                  const tpl = getTemplateForColumn(key);
                  if (!tpl) continue;
                  availableChannels.add(tpl.channel);
                  const cat = (tpl.category || "").trim();
                  if (cat) availableCategories.add(cat);
                  const offer = (tpl.offer || "").trim();
                  if (offer && (OFFER_OPTIONS as Record<string, string>)[offer]) {
                    availableOffers.add(offer);
                  }
                }
                const visibleChannelOptionsForFilter = (
                  ["email", "linkedin", "direct", "instagram"] as TemplateChannel[]
                ).filter((ch) => availableChannels.has(ch));
                const visibleCategoryOptionsForFilter = Array.from(availableCategories).sort(
                  (a, b) => a.localeCompare(b)
                );
                const visibleOfferOptionsForFilter = Object.keys(OFFER_OPTIONS).filter((k) =>
                  availableOffers.has(k)
                );

                const outreachKeys = populatedOutreachKeys
                  .filter((c) => {
                    if (outreachStarredOnly && !starredOutreachKeys.has(c)) return false;
                    if (!filtersActive) return true;
                    const tpl = getTemplateForColumn(c);
                    // Non-template outreach columns lack channel/category metadata.
                    if (!tpl) return false;
                    if (outreachChannelFilter !== "all" && tpl.channel !== outreachChannelFilter) {
                      return false;
                    }
                    if (
                      outreachCategoryFilter !== "all" &&
                      (tpl.category || "").trim() !== outreachCategoryFilter
                    ) {
                      return false;
                    }
                    if (
                      outreachOfferFilter !== "all" &&
                      (tpl.offer || "").trim() !== outreachOfferFilter
                    ) {
                      return false;
                    }
                    if (searchLower && !(tpl.title || "").toLowerCase().includes(searchLower)) {
                      return false;
                    }
                    return true;
                  })
                  // Surface starred templates first; Array.sort is stable, so the
                  // original column order is preserved within each group.
                  .sort(
                    (a, b) =>
                      (starredOutreachKeys.has(b) ? 1 : 0) - (starredOutreachKeys.has(a) ? 1 : 0)
                  );

                const handleCopyMessage = async (key: string, text: string) => {
                  try {
                    await navigator.clipboard.writeText(text);
                    setCopiedOutreachKey(key);
                    setTimeout(() => setCopiedOutreachKey(null), 2000);
                  } catch (err) {
                    console.error("Failed to copy:", err);
                  }
                };

                const handleCopyAll = async () => {
                  try {
                    const combined = outreachKeys
                      .map((k) => {
                        const label = columnLabels[k] || k;
                        const value = getOutreachValue(k);
                        return `${label}\n${value}`;
                      })
                      .join("\n\n");
                    await navigator.clipboard.writeText(combined);
                    setCopiedAllOutreach(true);
                    setTimeout(() => setCopiedAllOutreach(false), 2000);
                  } catch (err) {
                    console.error("Failed to copy all:", err);
                  }
                };

                const filterControls = (
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={outreachSearch}
                        onChange={(e) => setOutreachSearch(e.target.value)}
                        placeholder="Search by title..."
                        className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {visibleChannelOptionsForFilter.length > 0 && (
                        <select
                          value={outreachChannelFilter}
                          onChange={(e) =>
                            setOutreachChannelFilter(e.target.value as TemplateChannel | "all")
                          }
                          className="px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                        >
                          <option value="all">All channels</option>
                          {visibleChannelOptionsForFilter.map((ch) => (
                            <option key={ch} value={ch}>
                              {CHANNEL_LABELS[ch]}
                            </option>
                          ))}
                        </select>
                      )}
                      {visibleCategoryOptionsForFilter.length > 0 && (
                        <select
                          value={outreachCategoryFilter}
                          onChange={(e) => setOutreachCategoryFilter(e.target.value)}
                          className="px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                        >
                          <option value="all">All categories</option>
                          {visibleCategoryOptionsForFilter.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
                      )}
                      {visibleOfferOptionsForFilter.length > 0 && (
                        <select
                          value={outreachOfferFilter}
                          onChange={(e) => setOutreachOfferFilter(e.target.value)}
                          className="px-3 py-2 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                        >
                          {visibleOfferOptionsForFilter.map((k) => (
                            <option key={k} value={k}>
                              {getOfferLabel(k)}
                            </option>
                          ))}
                          <option value="all">All offers</option>
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={() => setOutreachStarredOnly((v) => !v)}
                        aria-pressed={outreachStarredOnly}
                        className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-md transition-colors ${
                          outreachStarredOnly
                            ? "border-amber-300 bg-amber-50 text-amber-700"
                            : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                        }`}
                        title={
                          outreachStarredOnly
                            ? "Showing starred only — click to show all"
                            : "Show starred messages only"
                        }
                      >
                        <Star
                          className={`w-3.5 h-3.5 ${
                            outreachStarredOnly ? "fill-amber-400 text-amber-400" : ""
                          }`}
                        />
                        Starred
                      </button>
                      {anyFilterActive && (
                        <button
                          type="button"
                          onClick={() => {
                            setOutreachChannelFilter("all");
                            setOutreachCategoryFilter("all");
                            setOutreachOfferFilter("all");
                            setOutreachSearch("");
                            setOutreachStarredOnly(false);
                          }}
                          className="px-3 py-2 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  </div>
                );

                if (outreachKeys.length === 0) {
                  return (
                    <>
                      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Outreach Messages
                      </h3>
                      {filterControls}
                      <div className="text-center py-12 border border-dashed border-gray-200 rounded-lg bg-gray-50">
                        <Mail className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                        <p className="text-sm text-gray-500">
                          {outreachStarredOnly
                            ? "No starred outreach messages yet — tap the star on a message to save it here."
                            : anyFilterActive
                            ? "No outreach messages match the current filters."
                            : "No outreach messages available for this company."}
                        </p>
                      </div>
                    </>
                  );
                }

                return (
                  <>
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Outreach Messages
                      </h3>
                      <button
                        type="button"
                        onClick={handleCopyAll}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 rounded-md hover:bg-indigo-100 transition-colors"
                        title="Copy all messages with labels"
                      >
                        {copiedAllOutreach ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        {copiedAllOutreach ? "Copied!" : "Copy All"}
                      </button>
                    </div>
                    {filterControls}
                    <div className="space-y-3">
                      {outreachKeys.map((columnKey) => {
                        const value = getOutreachValue(columnKey);
                        const label = columnLabels[columnKey] || columnKey;
                        return (
                          <div
                            key={columnKey}
                            className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                                {label}
                              </p>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button
                                  type="button"
                                  onClick={() => toggleStarredOutreach(columnKey)}
                                  className="p-1 text-gray-400 hover:text-amber-500 hover:bg-amber-50 rounded transition-colors"
                                  title={
                                    starredOutreachKeys.has(columnKey)
                                      ? "Unstar this message"
                                      : "Star this message"
                                  }
                                  aria-pressed={starredOutreachKeys.has(columnKey)}
                                >
                                  <Star
                                    className={`w-3.5 h-3.5 ${
                                      starredOutreachKeys.has(columnKey)
                                        ? "fill-amber-400 text-amber-400"
                                        : ""
                                    }`}
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleCopyMessage(columnKey, value)}
                                  className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                  title={`Copy ${label}`}
                                >
                                  {copiedOutreachKey === columnKey ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </div>
                            </div>
                            {renderEditableValue(columnKey, value)}
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          ) : activeTab === "latest-news" ? (
            /* Latest News Tab */
            <div className="space-y-4">
              {companyNewsLoading && !companyNews ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                </div>
              ) : companyNewsError ? (
                <p className="text-red-600 text-sm">{companyNewsError}</p>
              ) : companyNews ? (
                <div className="space-y-4">
                  {companyNews.answer && (
                    <div>
                      <div className="flex items-center justify-between mb-2 gap-2">
                        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1">
                          <Newspaper className="w-3.5 h-3.5 text-gray-400" />
                          Summary
                        </h3>
                        {editingNewsField !== 'answer' && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => handleCopyNewsField('answer', companyNews.answer)}
                              className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                              title="Copy summary"
                            >
                              {copiedNewsField === 'answer' ? (
                                <Check className="w-3.5 h-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              onClick={() => handleStartEditNewsField('answer', companyNews.answer)}
                              className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                              title="Edit summary"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      {editingNewsField === 'answer' ? (
                        <div className="space-y-2">
                          <textarea
                            value={newsFieldDraft}
                            onChange={(e) => setNewsFieldDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveNewsField();
                              else if (e.key === 'Escape') handleCancelEditNewsField();
                            }}
                            rows={8}
                            className="w-full px-3 py-2 text-sm border border-indigo-500 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            autoFocus
                          />
                          <div className="flex items-center gap-2 justify-end">
                            <button
                              onClick={handleCancelEditNewsField}
                              className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleSaveNewsField}
                              className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="prose prose-sm max-w-none prose-p:text-gray-700 prose-p:leading-relaxed prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline">
                          <ReactMarkdown>{companyNews.answer}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  )}
                  {(companyNews.first_line_to_start_email || editingNewsField === 'first_line_to_start_email') && (
                    <div>
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Email Opener</h3>
                        {editingNewsField !== 'first_line_to_start_email' && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {companyNews.first_line_to_start_email && (
                              <button
                                onClick={() => handleCopyNewsField('first_line_to_start_email', companyNews.first_line_to_start_email!)}
                                className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                title="Copy email opener"
                              >
                                {copiedNewsField === 'first_line_to_start_email' ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                            <button
                              onClick={() => handleStartEditNewsField('first_line_to_start_email', companyNews.first_line_to_start_email || '')}
                              className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                              title="Edit email opener"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      {editingNewsField === 'first_line_to_start_email' ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={newsFieldDraft}
                            onChange={(e) => setNewsFieldDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveNewsField();
                              else if (e.key === 'Escape') handleCancelEditNewsField();
                            }}
                            className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            autoFocus
                          />
                          <button onClick={handleSaveNewsField} className="text-emerald-600 hover:text-emerald-800" title="Save">✓</button>
                          <button onClick={handleCancelEditNewsField} className="text-red-600 hover:text-red-800" title="Cancel">✕</button>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-700">{companyNews.first_line_to_start_email}</p>
                      )}
                    </div>
                  )}
                  {(companyNews.subject_line || editingNewsField === 'subject_line') && (
                    <div>
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Subject Line</h3>
                        {editingNewsField !== 'subject_line' && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {companyNews.subject_line && (
                              <button
                                onClick={() => handleCopyNewsField('subject_line', companyNews.subject_line!)}
                                className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                title="Copy subject line"
                              >
                                {copiedNewsField === 'subject_line' ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                            <button
                              onClick={() => handleStartEditNewsField('subject_line', companyNews.subject_line || '')}
                              className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                              title="Edit subject line"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      {editingNewsField === 'subject_line' ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={newsFieldDraft}
                            onChange={(e) => setNewsFieldDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveNewsField();
                              else if (e.key === 'Escape') handleCancelEditNewsField();
                            }}
                            className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            autoFocus
                          />
                          <button onClick={handleSaveNewsField} className="text-emerald-600 hover:text-emerald-800" title="Save">✓</button>
                          <button onClick={handleCancelEditNewsField} className="text-red-600 hover:text-red-800" title="Cancel">✕</button>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-700">{companyNews.subject_line}</p>
                      )}
                    </div>
                  )}
                  {Array.isArray(companyNews.citations) && companyNews.citations.length > 0 && (
                    <div>
                      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <Link2 className="w-3.5 h-3.5 text-gray-400" />
                        Sources
                      </h3>
                      <ul className="list-disc list-inside space-y-1.5">
                        {companyNews.citations.map((item, idx) => {
                          const match = item.match(/\[([^\]]+)\]\(([^)]+)\)/);
                          const label = match ? match[1] : item;
                          const href = match ? match[2] : null;
                          return (
                            <li key={idx} className="text-sm text-gray-700">
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                >
                                  {label}
                                </a>
                              ) : (
                                label
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  {companyNews.date && (
                    <p className="text-xs text-gray-500">
                      Last fetched:{' '}
                      {new Date(companyNews.date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </p>
                  )}
                </div>
              ) : null}
              {manualNewsOpen && (
                <div className="bg-white border border-indigo-200 rounded-lg p-3 shadow-sm space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-gray-900">Paste news text</h4>
                    <span className="text-xs text-gray-500">Saved as the news summary</span>
                  </div>
                  <textarea
                    value={manualNewsDraft}
                    onChange={(e) => setManualNewsDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveManualNews();
                      else if (e.key === 'Escape') {
                        setManualNewsOpen(false);
                        setManualNewsDraft('');
                      }
                    }}
                    rows={8}
                    placeholder="Paste an article, announcement, or any news text about this company..."
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    autoFocus
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => {
                        setManualNewsOpen(false);
                        setManualNewsDraft('');
                      }}
                      disabled={savingManualNews}
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveManualNews}
                      disabled={savingManualNews || !manualNewsDraft.trim()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingManualNews && <Loader2 className="w-3 h-3 animate-spin" />}
                      {savingManualNews ? 'Saving...' : 'Save news'}
                    </button>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                {!companyNews && !companyNewsLoading && !companyNewsError && !manualNewsOpen && (
                  <p className="text-sm text-gray-500 w-full">No news fetched yet. Click to fetch latest, or paste your own news text below.</p>
                )}
                {companyNews?.answer && (
                  <button
                    onClick={handleGenerateEmailOpener}
                    disabled={generatingEmailOpener}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-white text-indigo-700 hover:bg-indigo-50 border border-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                  >
                    {generatingEmailOpener ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    {generatingEmailOpener ? 'Generating...' : 'Generate Email Opener'}
                  </button>
                )}
                {!manualNewsOpen && (
                  <button
                    onClick={() => {
                      setManualNewsDraft(companyNews?.answer || '');
                      setManualNewsOpen(true);
                    }}
                    disabled={companyNewsLoading}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-white text-gray-700 hover:bg-gray-50 border border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    title={companyNews?.answer ? 'Replace the current news with your own text' : 'Paste your own news text to process'}
                  >
                    <FileText className="w-4 h-4" />
                    {companyNews?.answer ? 'Edit / replace with manual text' : 'Add news manually'}
                  </button>
                )}
                <button
                  onClick={handleFetchCompanyNews}
                  disabled={companyNewsLoading || companyNewsFetchCooldown || !!newsFetchedWithin7Days}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  {companyNewsLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Newspaper className="w-4 h-4" />
                  )}
                  {companyNewsLoading
                    ? 'Fetching...'
                    : newsFetchedWithin7Days
                      ? 'News fetched recently (try again in 7 days)'
                      : `Fetch Latest News on ${company?.domain?.replace(/^https?:\/\//i, '').replace(/\/$/, '') || 'this company'}`}
                </button>
                {emailOpenerError && (
                  <p className="text-sm text-red-600 w-full">{emailOpenerError}</p>
                )}
              </div>
            </div>
          ) : (
            /* Contacts Tab */
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1">
                  <Users className="w-3.5 h-3.5 text-gray-400" />
                  Contacts {contacts && contacts.length > 0 && (
                    <span className="ml-1 text-gray-400 normal-case">({contacts.length})</span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  {company.domain?.trim() && !isPersonProfile && (
                    <button
                      type="button"
                      onClick={() => {
                        const domain = company.domain!.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/$/, '');
                        const name = domain.split('.')[0];
                        const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
                        const query = `site:linkedin.com/in ("${capitalized}" OR "${domain}") ("Founder" OR "Co-Founder" OR "CEO" OR "Head of Marketing" OR "CMO" OR "VP Marketing" OR "Director Marketing" OR "Head of Growth" OR "Head of Communications" OR "Head of Brand" OR "Creative Director" OR "Head of Content")`;
                        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                        window.open(url, '_blank', 'noopener,noreferrer');
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded transition-colors"
                      title="Find people on LinkedIn via Google search"
                    >
                      <Users className="w-3.5 h-3.5" />
                      Find People
                    </button>
                  )}
                  {company.domain?.trim() && !isPersonProfile && (
                    <button
                      type="button"
                      onClick={() => fetchContacts(true)}
                      disabled={contactsLoading}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Refetch contacts from people search (cached locally)"
                    >
                      {contactsLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      Refresh
                    </button>
                  )}
                  <button
                    onClick={() => setIsAddingContact(true)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add contact
                  </button>
                </div>
              </div>

              {isAddingContact && (
                <>
                  <div
                    className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity duration-300"
                    onClick={savingNewContact ? undefined : handleAddContactCancel}
                  />
                  <div className="fixed inset-0 z-[70] flex items-start sm:items-center justify-center p-4 overflow-y-auto">
                    <div
                      className="bg-white rounded-lg shadow-xl max-w-2xl w-full my-8 p-5 space-y-3 transform transition-all"
                      onClick={(e) => e.stopPropagation()}
                    >
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-gray-900">
                      {editingContactId !== null ? "Edit contact" : "New contact"}
                    </h4>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setContactJsonOpen((v) => !v);
                          setContactJsonError(null);
                        }}
                        className="text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
                      >
                        {contactJsonOpen ? "Hide JSON import" : "Import JSON"}
                      </button>
                      <span className="text-xs text-gray-500">All fields optional</span>
                    </div>
                  </div>
                  {contactJsonOpen && (
                    <div className="border border-dashed border-indigo-300 bg-indigo-50/40 rounded p-3 space-y-2">
                      <p className="text-xs text-gray-600">
                        Paste LinkedIn profile JSON (with fields like <code>accountName</code>,{" "}
                        <code>url</code>, <code>profilePhoto</code>, <code>connectionsText</code>,{" "}
                        <code>aboutEmail</code>, <code>aboutPhoneNumber</code>,{" "}
                        <code>isActionProfile</code>) to autofill below.
                      </p>
                      <textarea
                        value={contactJsonInput}
                        onChange={(e) => {
                          setContactJsonInput(e.target.value);
                          if (contactJsonError) setContactJsonError(null);
                        }}
                        placeholder='{"url": "https://www.linkedin.com/in/...", "accountName": "Jane Doe", ...}'
                        rows={6}
                        className="w-full px-2.5 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                      {contactJsonError && (
                        <p className="text-xs text-red-600">{contactJsonError}</p>
                      )}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setContactJsonInput("");
                            setContactJsonError(null);
                          }}
                          className="text-xs text-gray-600 hover:text-gray-800"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const raw = contactJsonInput.trim();
                            if (!raw) {
                              setContactJsonError("Paste JSON first.");
                              return;
                            }
                            let data: any;
                            try {
                              data = JSON.parse(raw);
                            } catch (err: any) {
                              setContactJsonError(`Invalid JSON: ${err.message}`);
                              return;
                            }
                            if (!data || typeof data !== "object") {
                              setContactJsonError("JSON must be an object.");
                              return;
                            }
                            const fullName =
                              (data.accountName || data.nameHeading || "").toString().trim();
                            const linkedinUrl = (data.url || "").toString().trim();
                            const photoUrl = (data.profilePhoto || "").toString().trim();
                            const email = (data.aboutEmail || "").toString().trim();
                            const phone = (data.aboutPhoneNumber || "").toString().trim();
                            let headline = "";
                            const connText = (data.connectionsText || "").toString();
                            if (connText && fullName) {
                              let txt = connText;
                              if (txt.startsWith(fullName)) {
                                txt = txt.slice(fullName.length).trim();
                              }
                              txt = txt
                                .replace(/^(He\/Him|She\/Her|They\/Them)\s*/i, "")
                                .trim();
                              const loc = (data.locationText || "").toString().trim();
                              if (loc) {
                                const idx = txt.indexOf(loc);
                                if (idx > 0) txt = txt.slice(0, idx).trim();
                              }
                              headline = txt;
                            }
                            const actionProfileVal =
                              data.isActionProfile === true
                                ? "true"
                                : data.isActionProfile === false
                                ? "false"
                                : "";
                            setNewContact((prev) => ({
                              ...prev,
                              full_name: fullName || prev.full_name,
                              linkedin_url: linkedinUrl || prev.linkedin_url,
                              photo_url: photoUrl || prev.photo_url,
                              email: email || prev.email,
                              phone: phone || prev.phone,
                              headline: headline || prev.headline,
                              isActionProfile: actionProfileVal || prev.isActionProfile,
                            }));
                            setContactJsonError(null);
                            setContactJsonOpen(false);
                            setContactJsonInput("");
                            setToastMessage("Contact fields filled from JSON");
                            setToastVisible(true);
                          }}
                          className="text-xs font-medium px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                        >
                          Fill fields
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Full name
                      </label>
                      <input
                        type="text"
                        value={newContact.full_name}
                        onChange={(e) =>
                          setNewContact({ ...newContact, full_name: e.target.value })
                        }
                        placeholder="Jane Doe"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                      <input
                        type="email"
                        value={newContact.email}
                        onChange={(e) => setNewContact({ ...newContact, email: e.target.value })}
                        placeholder="jane@example.com"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        LinkedIn URL
                      </label>
                      <input
                        type="url"
                        value={newContact.linkedin_url}
                        onChange={(e) =>
                          setNewContact({ ...newContact, linkedin_url: e.target.value })
                        }
                        placeholder="https://linkedin.com/in/..."
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Title</label>
                      <input
                        type="text"
                        value={newContact.title}
                        onChange={(e) => setNewContact({ ...newContact, title: e.target.value })}
                        placeholder="Head of Sales"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
                      <input
                        type="tel"
                        value={newContact.phone}
                        onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
                        placeholder="+1 555 123 4567"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Headline
                      </label>
                      <input
                        type="text"
                        value={newContact.headline}
                        onChange={(e) =>
                          setNewContact({ ...newContact, headline: e.target.value })
                        }
                        placeholder="Short bio"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Photo URL
                      </label>
                      <input
                        type="url"
                        value={newContact.photo_url}
                        onChange={(e) =>
                          setNewContact({ ...newContact, photo_url: e.target.value })
                        }
                        placeholder="https://..."
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
                      <select
                        value={newContact.status}
                        onChange={(e) =>
                          setNewContact({ ...newContact, status: e.target.value })
                        }
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                      >
                        <option value="">No status</option>
                        {CONTACT_STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Active profile
                      </label>
                      <select
                        value={newContact.isActionProfile}
                        onChange={(e) =>
                          setNewContact({ ...newContact, isActionProfile: e.target.value })
                        }
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                      >
                        <option value="">Not set</option>
                        <option value="true">Yes (active profile)</option>
                        <option value="false">No (not active profile)</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
                    <button
                      onClick={handleAddContactCancel}
                      disabled={savingNewContact}
                      className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddContactSubmit}
                      disabled={savingNewContact}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded transition-colors disabled:opacity-50"
                    >
                      {savingNewContact ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : editingContactId !== null ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                      {editingContactId !== null ? "Update contact" : "Save contact"}
                    </button>
                  </div>
                    </div>
                  </div>
                </>
              )}

              {contactsLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                </div>
              ) : contacts && contacts.length > 0 ? (
                <div className="space-y-3">
                  {contacts.map((contact, index) => {
                    const cardContactId =
                      contact.person_id || contact.email || contact.full_name || index;
                    return (
                      <ContactCard
                        key={contact.person_id || index}
                        contact={contact}
                        index={index}
                        onToggle={handleContactToggle}
                        onFieldChange={handleContactFieldChange}
                        onRemove={handleContactRemoveClick}
                        onStatusChange={handleContactStatusChange}
                        onEdit={handleContactEditClick}
                        onGetDetails={handleGetContactDetails}
                        isEnriching={enrichingContactId === cardContactId}
                        enrichingMode={
                          enrichingContactId === cardContactId ? enrichingMode : null
                        }
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12 border border-dashed border-gray-200 rounded-lg bg-gray-50">
                  <User className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-500">No contacts found for this company.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Toast Notification */}
      {toastVisible && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-md shadow-lg z-[80] transition-opacity duration-300">
          {toastMessage}
        </div>
      )}

      {/* Remove Contact Confirmation Modal */}
      {contactToRemove && (
        <>
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity duration-300"
            onClick={handleContactRemoveCancel}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 transform transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Remove Contact
              </h3>
              <p className="text-sm text-gray-600 mb-6">
                Are you sure you want to remove{' '}
                <span className="font-semibold text-gray-900">{contactToRemove.contactName}</span>{' '}
                from the contacts list? This action cannot be undone.
              </p>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={handleContactRemoveCancel}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleContactRemoveConfirm}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* JSON Import Modal */}
      {isJsonImportOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity duration-300"
            onClick={jsonImporting ? undefined : handleCloseJsonImport}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 transform transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Import JSON
              </h3>
              <p className="text-sm text-gray-600 mb-3">
                Paste a JSON object with <code className="text-xs bg-gray-100 px-1 rounded">emails</code>,{' '}
                <code className="text-xs bg-gray-100 px-1 rounded">phones</code>,{' '}
                <code className="text-xs bg-gray-100 px-1 rounded">instagram</code>,{' '}
                <code className="text-xs bg-gray-100 px-1 rounded">linkedin</code>, or{' '}
                <code className="text-xs bg-gray-100 px-1 rounded">facebook</code> arrays. Empty arrays are ignored.
              </p>
              <textarea
                value={jsonInput}
                onChange={(e) => {
                  setJsonInput(e.target.value);
                  if (jsonError) setJsonError(null);
                }}
                placeholder={`{\n  "emails": [],\n  "linkedin": [],\n  "facebook": [],\n  "instagram": [],\n  "phones": []\n}`}
                rows={10}
                className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                disabled={jsonImporting}
              />
              {jsonError && (
                <p className="mt-2 text-sm text-red-600">{jsonError}</p>
              )}

              <div className="flex gap-3 justify-end mt-4">
                <button
                  type="button"
                  onClick={handleCloseJsonImport}
                  disabled={jsonImporting}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyJsonImport}
                  disabled={jsonImporting || !jsonInput.trim()}
                  className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {jsonImporting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Apply
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Delete Note Confirmation Modal */}
      {noteToDelete !== null && (
        <>
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity duration-300"
            onClick={handleDeleteNoteCancel}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 transform transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Delete Note
              </h3>
              <div className="text-sm text-gray-600 mb-6">
                <p>Are you sure you want to delete this note? This action cannot be undone.</p>
                {notes[noteToDelete] && (
                  <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
                    <p className="text-xs text-gray-500 mb-1">
                      {new Date(notes[noteToDelete].date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </p>
                    <p className="text-sm text-gray-900">
                      {notes[noteToDelete].message}
                    </p>
                  </div>
                )}
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDeleteNoteCancel();
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDeleteNoteConfirm();
                  }}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <DeleteConfirmationModal
        isOpen={deleteConfirmOpen}
        title="Delete Company"
        message="Are you sure you want to delete this company? This action cannot be undone."
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          if (!deleting) setDeleteConfirmOpen(false);
        }}
        confirmText={deleting ? "Deleting…" : "Delete"}
        cancelText="Cancel"
        confirmDisabled={deleting}
      />
    </>
  );
};

export default CompanyDetailsDrawer;
