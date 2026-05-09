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
  Plus,
  Edit2,
  FileText,
  CheckCircle,
  XCircle,
  Minus,
  Eye,
  ExternalLink,
  Upload,
  Instagram,
} from "lucide-react";
import { Company } from "@/contexts/CompaniesContext";
import { extractPhoneNumber } from "@/lib/utils";
import PhoneInputField from "@/components/ui/PhoneInputField";
import { buildEmailComposeUrl, buildEmailBody, type EmailSettings } from "@/lib/emailCompose";
import { supabase } from "@/utils/supabase/client";
import { getValidAccessToken } from "@/lib/api";

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
}) => {
  // Inline editing state
  const [editingCell, setEditingCell] = useState<{
    companyId: string;
    columnKey: string;
    value: string;
  } | null>(null);

  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [classificationValue, setClassificationValue] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"overview" | "outreach" | "contacts">("overview");
  const [contacts, setContacts] = useState<any[] | null>(null);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactToRemove, setContactToRemove] = useState<{
    contactId: string | number;
    contactName: string;
  } | null>(null);

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

  const [domainCopied, setDomainCopied] = useState(false);

  // Handle cell double click (edit)
  const handleCellDoubleClick = useCallback(
    (company: Company, columnKey: string) => {
      if (columnKey.startsWith("template_")) return;
      if (columnKey === "domain" || columnKey === "instagram") return;
      if (columnKey === "classification") return;
      if (columnKey === "notes") return;

      const currentValue = getCellValue(company, columnKey);
      setEditingCell({
        companyId: company.id,
        columnKey,
        value: currentValue === "-" ? "" : currentValue,
      });
    },
    [getCellValue]
  );

  // Handle inline edit save
  const handleInlineEditSave = useCallback(async () => {
    if (!editingCell || !company) return;

    const { companyId, columnKey, value } = editingCell;

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
        await updateCompany(companyId, { [columnKey]: value.trim() });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      if (columnKey === "set_name") {
        await updateCompany(companyId, { [columnKey]: value.trim() || null });
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

        if (["QUALIFIED", "NOT_QUALIFIED", "EXPIRED"].includes(dbValue.toUpperCase())) {
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

  const fetchedDomainsRef = useRef<Set<string>>(new Set());
  const prevTabRef = useRef<"overview" | "outreach" | "contacts">("overview");

  const fetchContacts = useCallback(async () => {
    if (!company?.domain) return;

    const domain = company.domain;
    const storageKey = `contacts_${domain}`;

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

      const response = await fetch(
        "https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/people_search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ domain }),
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
  }, [company?.domain]);

  useEffect(() => {
    if (
      activeTab === "contacts" &&
      prevTabRef.current !== "contacts" &&
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

      setActiveTab("overview");
      setContacts(null);
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

  const handleContactRemoveClick = useCallback(
    (contactId: string | number, contactName: string) => {
      setContactToRemove({ contactId, contactName });
    },
    []
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
  const ContactCard = ({
    contact,
    index,
    onToggle,
    onRemove,
  }: {
    contact: any;
    index: number;
    onToggle: (contactId: string | number, checked: boolean) => void;
    onRemove: (contactId: string | number, contactName: string) => void;
  }) => {
    const [imageError, setImageError] = useState(false);
    const [copiedItem, setCopiedItem] = useState<string | null>(null);
    const showPlaceholder = !contact.photo_url || imageError;

    const contactId = contact.person_id || contact.email || contact.full_name || index;
    const isChecked = contact.checked === true;
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

    return (
      <div
        className={`bg-white border rounded-lg p-4 shadow-sm hover:bg-gray-50 hover:border-gray-300 transition-colors ${
          isChecked ? "border-indigo-300 bg-indigo-50/30 hover:bg-indigo-50/50" : "border-gray-200"
        }`}
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
                <h3 className="font-semibold text-gray-900 truncate">
                  {contactName}
                </h3>
                {contact.title && (
                  <p className="text-sm text-gray-600 mt-0.5 truncate">{contact.title}</p>
                )}
                {contact.headline && (
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">
                    {contact.headline}
                  </p>
                )}
              </div>
              <button
                onClick={() => onRemove(contactId, contactName)}
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors flex-shrink-0"
                title="Remove contact"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-x-4 gap-y-2">
              {contact.email && (
                <div className="flex items-center gap-1.5 text-sm">
                  <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a
                    href={getComposeUrl(contact.email)}
                    onClick={(e) => {
                      e.preventDefault();
                      window.open(getComposeUrl(contact.email), '_blank', 'noopener,noreferrer');
                    }}
                    className="text-indigo-600 hover:text-indigo-800 hover:underline truncate max-w-[180px]"
                  >
                    {contact.email}
                  </a>
                  {contact.email_status && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        contact.email_status === "verified"
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {contact.email_status}
                    </span>
                  )}
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
                </div>
              )}
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
                  <Linkedin className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a
                    href={contact.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 hover:text-indigo-800 hover:underline"
                  >
                    LinkedIn
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
            </div>
          </div>
        </div>
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
  const displayName =
    company.domain?.trim() ||
    company.instagram?.trim() ||
    company.email?.trim() ||
    "Company Details";

  const classificationLabel =
    classificationValue === "QUALIFIED"
      ? "Qualified"
      : classificationValue === "UNQUALIFIED" || classificationValue === "NOT_QUALIFIED"
      ? "Unqualified"
      : classificationValue === "EXPIRED"
      ? "Expired"
      : null;

  const classificationPillClasses =
    classificationValue === "QUALIFIED"
      ? "bg-emerald-100 text-emerald-800"
      : classificationValue === "UNQUALIFIED" || classificationValue === "NOT_QUALIFIED"
      ? "bg-red-100 text-red-800"
      : classificationValue === "EXPIRED"
      ? "bg-amber-100 text-amber-800"
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

    return (
      <p
        className={`text-sm text-gray-900 ${isLongText ? "whitespace-pre-wrap break-words" : ""} ${
          isEditable ? "cursor-pointer hover:bg-blue-50 -mx-1 px-1 rounded transition-colors" : ""
        }`}
        onDoubleClick={isEditable ? () => handleCellDoubleClick(company, columnKey) : undefined}
        title={isEditable ? "Double click to edit" : undefined}
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
              onClick={() => setActiveTab("overview")}
              className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === "overview"
                  ? "border-indigo-600 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab("outreach")}
              className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === "outreach"
                  ? "border-indigo-600 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              Outreach
            </button>
            <button
              onClick={() => setActiveTab("contacts")}
              className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === "contacts"
                  ? "border-indigo-600 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              Contacts
            </button>
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
                  <h2 className="text-xl font-semibold text-gray-900 break-all">{displayName}</h2>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {company.domain?.trim() && (
                      <button
                        type="button"
                        onClick={() => {
                          const domain = company.domain!.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/$/, '');
                          const name = domain.split('.')[0];
                          const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
                          const query = `site:linkedin.com/in ("Founder" OR "Co-Founder" OR "CEO" OR "Head of Marketing" OR "CMO" OR "VP Marketing" OR "Director Marketing") ("${capitalized}" OR "${domain}")`;
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
                          : classificationValue === "EXPIRED"
                          ? "bg-amber-50 text-amber-800 border-amber-300 focus:ring-amber-500"
                          : "bg-white text-gray-900 border-gray-300 focus:ring-indigo-500"
                      }`}
                    >
                      <option value="">— Select —</option>
                      <option value="QUALIFIED">Qualified</option>
                      <option value="UNQUALIFIED">Unqualified</option>
                      <option value="EXPIRED">Expired</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      {columnLabels.set_name || "Set"}
                    </label>
                    {editingCell?.companyId === company.id && editingCell?.columnKey === "set_name" ? (
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
                          className="flex-1 block w-full px-3 py-2 text-sm font-medium rounded-lg border-2 border-indigo-500 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                        <button
                          onClick={handleInlineEditSave}
                          className="text-emerald-600 hover:text-emerald-800"
                          title="Save (Enter)"
                        >
                          ✓
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleCellDoubleClick(company, "set_name")}
                        className="block w-full px-3 py-2 text-left text-sm font-medium rounded-lg border-2 border-gray-300 bg-white text-gray-900 hover:bg-gray-50 transition-colors"
                        title="Click to edit"
                      >
                        {company.set_name || <span className="text-gray-400">— Not set —</span>}
                      </button>
                    )}
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
                </div>
              </div>
            </div>
          ) : activeTab === "outreach" ? (
            <div className="space-y-4">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Outreach Messages
              </h3>
              {(() => {
                const outreachKeys = columnOrder
                  .filter((c) => isOutreachColumn(c) && !shouldHideDrawerField(c))
                  .filter((c) => {
                    const v = getCellValue(company, c);
                    return v && v !== "-";
                  });

                if (outreachKeys.length === 0) {
                  return (
                    <div className="text-center py-12 border border-dashed border-gray-200 rounded-lg bg-gray-50">
                      <Mail className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                      <p className="text-sm text-gray-500">
                        No outreach messages available for this company.
                      </p>
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    {outreachKeys.map((columnKey) => {
                      const value = getCellValue(company, columnKey);
                      const label = columnLabels[columnKey] || columnKey;
                      return (
                        <div
                          key={columnKey}
                          className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm"
                        >
                          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                            {label}
                          </p>
                          {renderEditableValue(columnKey, value)}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
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
              </div>

              {contactsLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                </div>
              ) : contacts && contacts.length > 0 ? (
                <div className="space-y-3">
                  {contacts.map((contact, index) => (
                    <ContactCard
                      key={contact.person_id || index}
                      contact={contact}
                      index={index}
                      onToggle={handleContactToggle}
                      onRemove={handleContactRemoveClick}
                    />
                  ))}
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
    </>
  );
};

export default CompanyDetailsDrawer;
