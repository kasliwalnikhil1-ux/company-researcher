'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, ChevronLeft, ChevronRight, ArrowLeft, MapPin, Briefcase, Target, Globe, ExternalLink, CheckCircle, XCircle, Minus, Sparkles, Loader2, Mail, Phone, Link2, User, Users, FileText, Copy, Check, Linkedin, Twitter, Plus, Edit2, Trash2, Eye, Search, ChevronDown, Newspaper } from 'lucide-react';
import { fetchInvestorDeepResearch, fetchInvestorNews, fetchInvestorNewsCurrent, type InvestorNews } from '@/lib/api';
import { formatHqLocation, formatHqLocationShort } from '@/lib/isoCodes';
import { fetchPeopleAtFirm, CONTACTS_FREE_LIMIT } from '@/hooks/useInvestorSearch';
import { Skeleton } from '@/components/ui/skeleton';
import { usePricingModal } from '@/contexts/PricingModalContext';
import { copyToClipboard, extractPhoneNumber } from '@/lib/utils';
import { buildEmailComposeUrl, buildEmailBody, type EmailSettings } from '@/lib/emailCompose';
import { supabase } from '@/utils/supabase/client';

const INVESTOR_DRAWER_MESSAGES_SEARCH_KEY = 'investor-drawer-messages-search';
const INVESTOR_DRAWER_MESSAGES_CHANNEL_KEY = 'investor-drawer-messages-channel';

const MESSAGE_CHANNEL_OPTIONS_BASE = ['Email', 'LinkedIn', 'Direct Message', 'Instagram Message'];

const getDomainFromUrl = (urlStr: string): string | null => {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

type WarmIntroFounder = {
  city?: string;
  name: string;
  state?: string;
  country?: string;
  linkedin?: string;
  photo_url?: string;
};

type WarmIntroByDomain = {
  domain: string;
  founders: WarmIntroFounder[];
};

function CompanyLogo({ name, url }: { name: string; url?: string }) {
  const domain = url ? getDomainFromUrl(url) : null;
  const [clearbitFailed, setClearbitFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);

  const showLetter = !domain || (clearbitFailed && faviconFailed);
  const showFavicon = domain && clearbitFailed && !faviconFailed;
  const showClearbit = domain && !clearbitFailed;

  return (
    <div className="w-5 h-5 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0 bg-gray-100">
      {showLetter ? (
        <span className="text-xs font-semibold text-gray-600">{name.charAt(0).toUpperCase()}</span>
      ) : showFavicon ? (
        <img
          src={`https://www.google.com/s2/favicons?sz=256&domain=${domain}`}
          alt=""
          onError={() => setFaviconFailed(true)}
          className="w-full h-full object-contain"
        />
      ) : (
        <img
          src={`https://logo.clearbit.com/${domain}`}
          alt=""
          onError={() => setClearbitFailed(true)}
          className="w-full h-full object-contain"
        />
      )}
    </div>
  );
}

export interface InvestorDetails {
  id: string;
  name: string;
  type?: string | null;
  active?: boolean | null;
  role?: string | null;
  hq_state?: string | null;
  hq_country?: string | null;
  investor_type?: string[] | null;
  fund_size_usd?: number | null;
  check_size_min_usd?: number | null;
  check_size_max_usd?: number | null;
  investment_stages?: string[] | null;
  investment_industries?: string[] | null;
  investment_geographies?: string[] | null;
  investment_thesis?: string | null;
  notable_investments?: string[] | string | null;
  leads_round?: boolean | null;
  has_personalization?: boolean;
  /** Personalization fields - only present when has_personalization === true */
  set_name?: string | null;
  owner?: string | null;
  /** jsonb - array of note objects: [{ message: string, date: string }] */
  notes?: Array<{ message: string; date: string }> | null;
  stage?: string | null;
  ai_metadata?: Record<string, unknown> | null;
  domain?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  /** Comma-separated list of emails */
  email?: string | null;
  /** Comma-separated list of phone numbers */
  phone?: string | null;
  /** Array of "[text](url)" formatted links */
  links?: string[] | null;
  /** Latest news: { answer, citations, date } - only when has_personalization */
  investor_news?: InvestorNews | null;
  /** For type='person': firm this person is associated with */
  associated_firm_id?: string | null;
  associated_firm_name?: string | null;
  /** For type='firm': number of people linked to the firm */
  associated_people_count?: number | null;
}

interface InvestorDetailsDrawerProps {
  isOpen: boolean;
  investor: InvestorDetails | null;
  onClose: () => void;
  investors: InvestorDetails[];
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onInvestorChange?: (investor: InvestorDetails) => void;
  /** When provided, clicking associated firm name opens that firm in the drawer */
  onOpenInvestorById?: (id: string) => Promise<void>;
  /** When viewing a firm opened from a person, show "Back to person" instead of prev/next */
  backToInvestor?: InvestorDetails | null;
  /** When viewing a person opened from firm's Contacts tab, show "Back to firm" instead of prev/next */
  backToFirm?: InvestorDetails | null;
  /** Called when opening a contact from the Contacts tab - parent should set backToFirm and investor */
  onOpenContactFromFirm?: (contact: InvestorDetails, firm: InvestorDetails) => void;
  onAnalyze?: (investorId: string) => void;
  isAnalyzing?: boolean;
  updateInvestor?: (
    investorId: string,
    updates: Partial<Pick<InvestorDetails, 'notes' | 'owner' | 'set_name' | 'stage' | 'ai_metadata'>>
  ) => Promise<void>;
  stageOptions?: string[];
  setOptions?: string[];
  ownerOptions?: string[];
  /** Mode for fetching contacts at firm (global | reviewed) */
  filtersMode?: 'global' | 'reviewed';
  /** When true, limit contacts to CONTACTS_FREE_LIMIT and show skeletons for more */
  isFreePlan?: boolean;
  /** Column settings for contact-detail click behavior (matches investors table) */
  clipboardColumn?: string | null;
  clipboardLinkedInColumn?: string | null;
  subjectColumn?: string | null;
  phoneClickBehavior?: 'whatsapp' | 'call';
  emailSettings?: EmailSettings | null;
  getInvestorCellValue?: (investor: InvestorDetails, columnKey: string) => string;
  columnLabels?: Record<string, string>;
  onCopyToClipboard?: (message: string) => void;
}

const formatCurrency = (value: number | null | undefined): string => {
  if (value == null || value === 0) return '-';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value}`;
};

const formatKebabLabel = (value: string): string =>
  value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

const parseNotableInvestment = (s: string): { name: string; url: string } | null => {
  const match = s.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  return match ? { name: match[1], url: match[2] } : null;
};

/** Parse comma-separated text into trimmed non-empty list */
const parseCommaList = (text: string | null | undefined): string[] => {
  if (!text || typeof text !== 'string') return [];
  return text.split(',').map((s) => s.trim()).filter(Boolean);
};

function ContactsMultiSelect({
  label,
  options,
  selected,
  onToggle,
  formatLabel = (v: string) => v,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  formatLabel?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchLower = search.trim().toLowerCase();
  const filteredOptions = searchLower
    ? options.filter(
        (opt) =>
          opt.toLowerCase().includes(searchLower) ||
          formatLabel(opt).toLowerCase().includes(searchLower)
      )
    : options;

  if (options.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (open) setSearch('');
        }}
        className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
      >
        <span>
          {label} {selected.length ? `(${selected.length})` : ''}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); setSearch(''); }} />
          <div className="absolute left-0 top-full mt-1 z-20 w-full min-w-[180px] max-w-[220px] bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden">
            <div className="p-2 border-b border-gray-100 sticky top-0 bg-white">
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="block w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div className="max-h-40 overflow-y-auto py-1">
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-500">No matches</p>
              ) : (
                filteredOptions.map((opt) => (
                  <label
                    key={opt}
                    className="flex items-center px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(opt)}
                      onChange={() => onToggle(opt)}
                      className="mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-700">{formatLabel(opt)}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ContactCardSkeleton() {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm opacity-60">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-2">
        <Skeleton className="h-5 w-16 rounded" />
        <Skeleton className="h-5 w-20 rounded" />
        <Skeleton className="h-5 w-14 rounded" />
      </div>
    </div>
  );
}

function ContactCard({
  contact,
  onView,
}: {
  contact: InvestorDetails;
  onView: () => void;
}) {
  const location = formatHqLocationShort(contact.hq_state, contact.hq_country);
  const thesis = contact.investment_thesis?.trim();
  const aiMeta = contact.ai_metadata ?? {};
  const investorFit = aiMeta.investor_fit as boolean | null | undefined;
  const reason = typeof aiMeta.reason === 'string' ? aiMeta.reason : null;
  const hasFitInfo = typeof investorFit === 'boolean' || investorFit === null;
  const hasReason = typeof reason === 'string' && reason.trim().length > 0;

  return (
    <div
      className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm cursor-pointer hover:bg-gray-50 hover:border-gray-300 transition-colors"
      onClick={onView}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-gray-900">{contact.name}</h3>
          {contact.role && <p className="text-sm text-gray-600 mt-0.5">{contact.role}</p>}
          {thesis && <p className="text-sm text-gray-600 mt-1 line-clamp-3 leading-relaxed">{thesis}</p>}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onView();
          }}
          className="p-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 flex-shrink-0"
          title="View Details"
        >
          <Eye className="w-4 h-4" />
        </button>
      </div>

      {(hasFitInfo || hasReason) && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-1.5">
          {hasFitInfo && (
            <div className="flex items-center gap-2">
              <span className="text-base" role="img" aria-label="fit">
                {investorFit === true ? '😊' : investorFit === false ? '😕' : '😐'}
              </span>
              <span
                className={`text-xs font-medium ${
                  investorFit === true
                    ? 'text-emerald-700'
                    : investorFit === false
                      ? 'text-red-700'
                      : investorFit === null
                        ? 'text-amber-700'
                        : 'text-gray-700'
                }`}
              >
                {investorFit === true ? 'Strong Fit' : investorFit === false ? 'Weak Fit' : 'Unclear Fit'}
              </span>
            </div>
          )}
          {hasReason && (
            <div
              className={`p-2 rounded-md border ${
                investorFit === true
                  ? 'bg-emerald-50 border-emerald-100'
                  : investorFit === false
                    ? 'bg-red-50 border-red-100'
                    : investorFit === null
                      ? 'bg-amber-50 border-amber-100'
                      : 'bg-gray-50 border-gray-100'
              }`}
            >
              <p className="text-xs text-gray-800 line-clamp-2 leading-relaxed">{reason!.trim()}</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-2 items-center">
        {contact.has_personalization && (
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
              investorFit === true
                ? 'bg-emerald-100 text-emerald-800'
                : investorFit === false
                  ? 'bg-red-100 text-red-800'
                  : investorFit === null
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-gray-100 text-gray-800'
            }`}
          >
            <Check className="w-3 h-3" />
            Reviewed
          </span>
        )}
        {location && <span className="text-sm text-gray-500">{location}</span>}
        {Array.isArray(contact.investment_stages) &&
          contact.investment_stages.slice(0, 3).map((s) => (
            <span
              key={s}
              className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800"
            >
              {formatKebabLabel(s)}
            </span>
          ))}
      </div>
    </div>
  );
}

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

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-sm font-medium text-gray-900">{value}</p>
    </div>
  );
}

function DetailSection({
  label,
  icon,
  value,
}: {
  label: string;
  icon?: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
        {icon}
        {label}
      </h3>
      <div className="text-sm text-gray-700">{value}</div>
    </div>
  );
}

const InvestorDetailsDrawer: React.FC<InvestorDetailsDrawerProps> = ({
  isOpen,
  investor,
  onClose,
  investors,
  currentPage,
  totalPages,
  onPageChange,
  onInvestorChange,
  onOpenInvestorById,
  backToInvestor,
  backToFirm,
  onOpenContactFromFirm,
  onAnalyze,
  isAnalyzing,
  updateInvestor,
  stageOptions = [],
  setOptions = [],
  ownerOptions = [],
  filtersMode = 'global',
  isFreePlan = false,
  clipboardColumn = null,
  clipboardLinkedInColumn = null,
  subjectColumn = null,
  phoneClickBehavior = 'whatsapp',
  emailSettings = null,
  getInvestorCellValue,
  columnLabels = {},
  onCopyToClipboard,
}) => {
  const { openPricingModal } = usePricingModal();
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'profile' | 'pipeline' | 'deep-research' | 'latest-news' | 'contacts'>('profile');
  const [notes, setNotes] = useState<Array<{ message: string; date: string }>>([]);
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null);
  const [newNoteMessage, setNewNoteMessage] = useState('');
  const [noteToDelete, setNoteToDelete] = useState<number | null>(null);
  const [noteToast, setNoteToast] = useState<string | null>(null);
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [deepResearchContent, setDeepResearchContent] = useState<string | null>(null);
  const [deepResearchLoading, setDeepResearchLoading] = useState(false);
  const [deepResearchError, setDeepResearchError] = useState<string | null>(null);
  const [contactsData, setContactsData] = useState<InvestorDetails[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [contactsNameSearch, setContactsNameSearch] = useState('');
  const [contactsRoleFilter, setContactsRoleFilter] = useState<string[]>([]);
  const [contactsStageFilter, setContactsStageFilter] = useState<string[]>([]);
  const [contactsIndustryFilter, setContactsIndustryFilter] = useState<string[]>([]);
  const [editingAiMetadata, setEditingAiMetadata] = useState(false);
  const [aiMetadataTwitterLine, setAiMetadataTwitterLine] = useState('');
  const [aiMetadataLine1, setAiMetadataLine1] = useState('');
  const [aiMetadataLine2, setAiMetadataLine2] = useState('');
  const [aiMetadataMutualInterestsText, setAiMetadataMutualInterestsText] = useState('');
  const [aiMetadataSaving, setAiMetadataSaving] = useState(false);
  const [investorNews, setInvestorNews] = useState<InvestorNews | null>(null);
  const [investorNewsLoading, setInvestorNewsLoading] = useState(false);
  const [investorNewsError, setInvestorNewsError] = useState<string | null>(null);
  const [investorNewsFetchCooldown, setInvestorNewsFetchCooldown] = useState(false);
  const [warmIntrosByDomains, setWarmIntrosByDomains] = useState<WarmIntroByDomain[] | null>(null);
  const [warmIntrosLoading, setWarmIntrosLoading] = useState(false);
  const returningToFirmRef = useRef(false);

  const [messagesSearch, setMessagesSearch] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(INVESTOR_DRAWER_MESSAGES_SEARCH_KEY) ?? '';
    }
    return '';
  });
  const [messagesChannelFilter, setMessagesChannelFilter] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(INVESTOR_DRAWER_MESSAGES_CHANNEL_KEY);
      return saved && (saved === 'All' || MESSAGE_CHANNEL_OPTIONS_BASE.includes(saved)) ? saved : 'All';
    }
    return 'All';
  });

  // Persist messages search and channel filter to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(INVESTOR_DRAWER_MESSAGES_SEARCH_KEY, messagesSearch);
    }
  }, [messagesSearch]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(INVESTOR_DRAWER_MESSAGES_CHANNEL_KEY, messagesChannelFilter);
    }
  }, [messagesChannelFilter]);

  // Reset tab when investor changes
  useEffect(() => {
    if (returningToFirmRef.current && investor?.type === 'firm' && (investor?.associated_people_count ?? 0) > 0) {
      setActiveTab('contacts');
      returningToFirmRef.current = false;
    } else {
      setActiveTab('profile');
    }
    setDeepResearchContent(null);
    setDeepResearchError(null);
    setInvestorNews(null);
    setInvestorNewsError(null);
    setInvestorNewsFetchCooldown(false);
    setWarmIntrosByDomains(null);
    setContactsData([]);
    setContactsError(null);
    setContactsNameSearch('');
    setContactsRoleFilter([]);
    setContactsStageFilter([]);
    setContactsIndustryFilter([]);
  }, [investor?.id]);

  // Load notes from investor when investor changes
  useEffect(() => {
    if (investor?.notes && Array.isArray(investor.notes)) {
      setNotes(investor.notes);
    } else {
      setNotes([]);
    }
    setIsAddingNote(false);
    setEditingNoteIndex(null);
    setNewNoteMessage('');
    setNoteToDelete(null);
  }, [investor?.id, investor?.notes]);

  // Load ai_metadata Personalization and mutual_interests when investor changes
  useEffect(() => {
    const meta = investor?.ai_metadata;
    if (meta && typeof meta === 'object') {
      setAiMetadataTwitterLine(typeof meta.twitter_line === 'string' ? meta.twitter_line : '');
      setAiMetadataLine1(typeof meta.line1 === 'string' ? meta.line1 : '');
      setAiMetadataLine2(typeof meta.line2 === 'string' ? meta.line2 : '');
      const interests = Array.isArray(meta.mutual_interests)
        ? (meta.mutual_interests as string[]).filter((s): s is string => typeof s === 'string')
        : [];
      setAiMetadataMutualInterestsText(interests.join('\n'));
    } else {
      setAiMetadataTwitterLine('');
      setAiMetadataLine1('');
      setAiMetadataLine2('');
      setAiMetadataMutualInterestsText('');
    }
    setEditingAiMetadata(false);
  }, [investor?.id, investor?.ai_metadata]);

  const DEEP_RESEARCH_STORAGE_KEY = (id: string) => `investor-deep-research-${id}`;
  const INVESTOR_NEWS_STORAGE_KEY = (id: string) => `investor-news-${id}`;
  const contactsLimit = isFreePlan ? CONTACTS_FREE_LIMIT : 100;
  const CONTACTS_STORAGE_KEY = (id: string) => `investor-contacts-${id}-${contactsLimit}`;

  const loadContacts = useCallback(async (firmId: string) => {
    if (typeof window === 'undefined') return;
    const cached = localStorage.getItem(CONTACTS_STORAGE_KEY(firmId));
    if (cached !== null) {
      try {
        const parsed = JSON.parse(cached) as InvestorDetails[];
        setContactsData(Array.isArray(parsed) ? parsed : []);
        return;
      } catch {
        // Invalid cache, fetch fresh
      }
    }
    setContactsLoading(true);
    setContactsError(null);
    try {
      const list = await fetchPeopleAtFirm(firmId, filtersMode, contactsLimit);
      setContactsData(list);
      try {
        localStorage.setItem(CONTACTS_STORAGE_KEY(firmId), JSON.stringify(list));
      } catch {
        // Ignore quota errors
      }
    } catch (err) {
      setContactsError(err instanceof Error ? err.message : 'Failed to load contacts');
      setContactsData([]);
    } finally {
      setContactsLoading(false);
    }
  }, [filtersMode, contactsLimit]);

  const loadDeepResearch = useCallback(async (investorId: string) => {
    if (typeof window === 'undefined') return;
    const cached = localStorage.getItem(DEEP_RESEARCH_STORAGE_KEY(investorId));
    if (cached !== null) {
      setDeepResearchContent(cached);
      return;
    }
    setDeepResearchLoading(true);
    setDeepResearchError(null);
    const result = await fetchInvestorDeepResearch(investorId);
    setDeepResearchLoading(false);
    if (result?.error) {
      setDeepResearchError(result.error);
      setDeepResearchContent(null);
    } else if (result?.deep_research != null) {
      const content = result.deep_research || '';
      setDeepResearchContent(content);
      localStorage.setItem(DEEP_RESEARCH_STORAGE_KEY(investorId), content);
    } else {
      setDeepResearchContent(null);
    }
  }, []);

  useEffect(() => {
    if (investor && activeTab === 'deep-research') {
      loadDeepResearch(investor.id);
    }
  }, [investor?.id, activeTab, loadDeepResearch]);

  useEffect(() => {
    if (investor?.type === 'firm' && investor.id && activeTab === 'contacts') {
      loadContacts(investor.id);
    }
  }, [investor?.id, investor?.type, activeTab, loadContacts]);

  const loadInvestorNews = useCallback(async (investorId: string) => {
    if (typeof window === 'undefined') return;
    const cached = localStorage.getItem(INVESTOR_NEWS_STORAGE_KEY(investorId));
    if (cached !== null) {
      try {
        const parsed = JSON.parse(cached) as InvestorNews;
        console.log('[InvestorDetailsDrawer] loadInvestorNews from localStorage:', {
          answerLength: parsed?.answer?.length,
          citationsCount: parsed?.citations?.length,
          hasDate: !!parsed?.date,
        });
        if (parsed?.answer != null || (Array.isArray(parsed?.citations) && parsed.citations.length > 0)) {
          setInvestorNews(parsed);
          return;
        }
      } catch {
        // Invalid cache
      }
    }
    if (investor?.investor_news && investor.id === investorId) {
      console.log('[InvestorDetailsDrawer] loadInvestorNews from investor:', {
        answerLength: investor.investor_news?.answer?.length,
        citationsCount: investor.investor_news?.citations?.length,
      });
      setInvestorNews(investor.investor_news);
      return;
    }
    setInvestorNewsLoading(true);
    setInvestorNewsError(null);
    const result = await fetchInvestorNewsCurrent(investorId);
    setInvestorNewsLoading(false);
    if (result?.investor_news) {
      console.log('[InvestorDetailsDrawer] loadInvestorNews from API:', {
        answerLength: result.investor_news?.answer?.length,
        citationsCount: result.investor_news?.citations?.length,
      });
      setInvestorNews(result.investor_news);
    } else if (result?.error) {
      setInvestorNewsError(result.error);
    } else {
      setInvestorNews(null);
    }
  }, [investor?.id, investor?.investor_news]);

  useEffect(() => {
    if (investor && activeTab === 'latest-news') {
      loadInvestorNews(investor.id);
    }
  }, [investor?.id, activeTab, loadInvestorNews]);

  const loadWarmIntros = useCallback(async (domains: string[]) => {
    if (domains.length === 0) {
      setWarmIntrosByDomains(null);
      return;
    }
    const sortedDomains = [...new Set(domains)].sort();
    const cacheKey = `warm-intros-${sortedDomains.join(',')}`;
    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem(cacheKey);
      if (cached !== null) {
        try {
          const parsed = JSON.parse(cached) as WarmIntroByDomain[];
          const hasFounders = parsed.some((d) => Array.isArray(d.founders) && d.founders.length > 0);
          if (hasFounders) {
            setWarmIntrosByDomains(parsed);
            return;
          }
        } catch {
          // Invalid cache
        }
      }
    }
    setWarmIntrosLoading(true);
    const { data, error } = await supabase.rpc('get_warm_intros_by_domains', {
      domains: sortedDomains,
    });
    setWarmIntrosLoading(false);
    if (error) {
      setWarmIntrosByDomains(null);
      return;
    }
    const results = (data ?? []) as WarmIntroByDomain[];
    const hasFounders = results.some((d) => Array.isArray(d.founders) && d.founders.length > 0);
    if (hasFounders) {
      setWarmIntrosByDomains(results);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(results));
      } catch {
        // Ignore quota errors
      }
    } else {
      setWarmIntrosByDomains(null);
    }
  }, []);

  useEffect(() => {
    if (!investor) return;
    const items = Array.isArray(investor.notable_investments)
      ? investor.notable_investments
      : typeof investor.notable_investments === 'string'
        ? [investor.notable_investments]
        : [];
    const domains: string[] = [];
    for (const item of items) {
      const parsed = parseNotableInvestment(item);
      if (parsed?.url) {
        const domain = normalizeDomain(parsed.url);
        if (domain) domains.push(domain);
      }
    }
    loadWarmIntros(domains);
  }, [investor?.id, investor?.notable_investments, loadWarmIntros]);

  const handleFetchInvestorNews = useCallback(async () => {
    if (!investor || investorNewsFetchCooldown) return;
    setInvestorNewsLoading(true);
    setInvestorNewsError(null);
    const result = await fetchInvestorNews({
      investorId: investor.id,
      name: investor.name,
      domain: investor.domain,
      type: investor.type === 'firm' || investor.type === 'person' ? investor.type : undefined,
      investor_type: investor.investor_type ?? undefined,
      associated_firm_name: investor.associated_firm_name ?? undefined,
    });
    setInvestorNewsLoading(false);
    if (result?.investor_news) {
      console.log('[InvestorDetailsDrawer] fetchInvestorNews result:', {
        answerLength: result.investor_news.answer?.length,
        citationsCount: result.investor_news.citations?.length,
        date: result.investor_news.date,
      });
      setInvestorNews(result.investor_news);
      try {
        localStorage.setItem(INVESTOR_NEWS_STORAGE_KEY(investor.id), JSON.stringify(result.investor_news));
      } catch {
        // Ignore quota errors
      }
      if (onInvestorChange) {
        onInvestorChange({ ...investor, investor_news: result.investor_news });
      }
      setInvestorNewsFetchCooldown(true);
      setTimeout(() => setInvestorNewsFetchCooldown(false), 10000);
    } else if (result?.error) {
      setInvestorNewsError(result.error);
    }
  }, [investor, investorNewsFetchCooldown, onInvestorChange]);

  const handleAddNote = useCallback(() => {
    setIsAddingNote(true);
    setNewNoteMessage('');
  }, []);

  const handleCancelAddNote = useCallback(() => {
    setIsAddingNote(false);
    setNewNoteMessage('');
  }, []);

  const handleSaveNote = useCallback(async () => {
    if (!investor || !newNoteMessage.trim() || !updateInvestor) return;

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
        updatedNotes.push({ message: newNoteMessage.trim(), date: today });
      }

      updatedNotes.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      await updateInvestor(investor.id, { notes: updatedNotes });
      setNotes(updatedNotes);
      if (onInvestorChange) {
        onInvestorChange({ ...investor, notes: updatedNotes });
      }

      setIsAddingNote(false);
      setEditingNoteIndex(null);
      setNewNoteMessage('');
      setNoteToast(editingNoteIndex !== null ? 'Note updated successfully' : 'Note added successfully');
      setTimeout(() => setNoteToast(null), 3000);
    } catch (err) {
      console.error('Error saving note:', err);
    }
  }, [investor, notes, newNoteMessage, editingNoteIndex, updateInvestor, onInvestorChange]);

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
    if (!investor || noteToDelete === null || !updateInvestor) return;

    try {
      const updatedNotes = notes.filter((_, index) => index !== noteToDelete);
      const finalNotes = updatedNotes.length > 0 ? updatedNotes : null;
      await updateInvestor(investor.id, { notes: finalNotes });
      setNotes(updatedNotes);
      if (onInvestorChange) {
        onInvestorChange({ ...investor, notes: finalNotes });
      }
      setNoteToDelete(null);
      setNoteToast('Note deleted successfully');
      setTimeout(() => setNoteToast(null), 3000);
    } catch (err) {
      console.error('Error deleting note:', err);
      setNoteToDelete(null);
    }
  }, [investor, notes, noteToDelete, updateInvestor, onInvestorChange]);

  const handleDeleteNoteCancel = useCallback(() => {
    setNoteToDelete(null);
  }, []);

  const handleSaveAiMetadata = useCallback(async () => {
    if (!investor || !updateInvestor) return;

    const meta = investor.ai_metadata && typeof investor.ai_metadata === 'object' ? investor.ai_metadata : {};
    const mutualInterests = aiMetadataMutualInterestsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const updatedAiMetadata: Record<string, unknown> = {
      ...meta,
      twitter_line: aiMetadataTwitterLine.trim() || null,
      line1: aiMetadataLine1.trim() || null,
      line2: aiMetadataLine2.trim() || null,
      mutual_interests: mutualInterests,
    };

    try {
      setAiMetadataSaving(true);
      await updateInvestor(investor.id, { ai_metadata: updatedAiMetadata });
      if (onInvestorChange) {
        onInvestorChange({ ...investor, ai_metadata: updatedAiMetadata });
      }
      setEditingAiMetadata(false);
      setNoteToast('Personalization saved');
      setTimeout(() => setNoteToast(null), 3000);
    } catch (err) {
      console.error('Error saving ai_metadata:', err);
    } finally {
      setAiMetadataSaving(false);
    }
  }, [investor, aiMetadataTwitterLine, aiMetadataLine1, aiMetadataLine2, aiMetadataMutualInterestsText, updateInvestor, onInvestorChange]);

  const handleCancelEditAiMetadata = useCallback(() => {
    const meta = investor?.ai_metadata && typeof investor.ai_metadata === 'object' ? investor.ai_metadata : {};
    setAiMetadataTwitterLine(typeof meta.twitter_line === 'string' ? meta.twitter_line : '');
    setAiMetadataLine1(typeof meta.line1 === 'string' ? meta.line1 : '');
    setAiMetadataLine2(typeof meta.line2 === 'string' ? meta.line2 : '');
    const interests = Array.isArray(meta.mutual_interests)
      ? (meta.mutual_interests as string[]).filter((s): s is string => typeof s === 'string')
      : [];
    setAiMetadataMutualInterestsText(interests.join('\n'));
    setEditingAiMetadata(false);
  }, [investor?.ai_metadata]);

  const handlePipelineFieldChange = useCallback(
    async (field: 'owner' | 'set_name' | 'stage', value: string | null) => {
      if (!investor || !updateInvestor) return;
      const trimmed = typeof value === 'string' ? value.trim() || null : null;
      try {
        setPipelineSaving(true);
        await updateInvestor(investor.id, { [field]: trimmed });
        if (onInvestorChange) {
          onInvestorChange({ ...investor, [field]: trimmed });
        }
      } catch (err) {
        console.error('Error updating pipeline field:', err);
      } finally {
        setPipelineSaving(false);
      }
    },
    [investor, updateInvestor, onInvestorChange]
  );

  const handleCopyField = async (text: string, field: string) => {
    try {
      await copyToClipboard(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const currentIndex = investor ? investors.findIndex((i) => i.id === investor.id) : -1;
  const hasPrev = currentIndex > 0 || (currentIndex === 0 && currentPage > 1);
  const hasNext = currentIndex >= 0 && (currentIndex < investors.length - 1 || currentPage < totalPages);

  const handlePrev = () => {
    if (currentIndex > 0 && onInvestorChange) {
      onInvestorChange(investors[currentIndex - 1]);
    } else if (currentPage > 1) {
      onPageChange(currentPage - 1);
    }
  };

  const handleNext = () => {
    if (currentIndex >= 0 && currentIndex < investors.length - 1 && onInvestorChange) {
      onInvestorChange(investors[currentIndex + 1]);
    } else if (currentPage < totalPages) {
      onPageChange(currentPage);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-2xl bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            {investor?.type === 'firm' && backToInvestor && onInvestorChange ? (
              <button
                onClick={() => onInvestorChange(backToInvestor)}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                aria-label="Back to person"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="text-sm font-medium">Back to person</span>
              </button>
            ) : investor?.type === 'person' && backToFirm && onInvestorChange ? (
              <button
                onClick={() => {
                  returningToFirmRef.current = true;
                  onInvestorChange(backToFirm);
                }}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                aria-label="Back to firm"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="text-sm font-medium">Back to firm</span>
              </button>
            ) : (
              <>
                <button
                  onClick={handlePrev}
                  disabled={!hasPrev}
                  className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Previous investor"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={handleNext}
                  disabled={!hasNext}
                  className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Next investor"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </>
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

        {/* Tabs - when has_personalization or (firm with contacts) */}
        {(investor?.has_personalization || (investor?.type === 'firm' && (investor?.associated_people_count ?? 0) > 0)) && (
          <div className="flex gap-1 px-4 pt-2 border-b border-gray-200 flex-shrink-0">
            <button
              onClick={() => setActiveTab('profile')}
              className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'profile'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Investor Profile
            </button>
            {investor?.has_personalization && (
              <button
                onClick={() => setActiveTab('pipeline')}
                className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === 'pipeline'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Pipeline
              </button>
            )}
            {investor?.type === 'firm' && (investor?.associated_people_count ?? 0) > 0 && (
              <button
                onClick={() => setActiveTab('contacts')}
                className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === 'contacts'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Contacts
              </button>
            )}
            {investor?.has_personalization && (
              <>
                <button
                  onClick={() => setActiveTab('deep-research')}
                  className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    activeTab === 'deep-research'
                      ? 'border-indigo-600 text-indigo-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Deep Research
                </button>
                <button
                  onClick={() => setActiveTab('latest-news')}
                  className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    activeTab === 'latest-news'
                      ? 'border-indigo-600 text-indigo-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Latest News
                </button>
              </>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!investor ? (
            <p className="text-gray-500 text-sm">Select an investor to view details.</p>
          ) : investor.type === 'firm' && activeTab === 'contacts' ? (
            /* Contacts tab content */
            (() => {
              const nameSearchLower = contactsNameSearch.trim().toLowerCase();
              const roles = [...new Set(contactsData.map((c) => c.role?.trim()).filter(Boolean))] as string[];
              const stages = [...new Set(contactsData.flatMap((c) => c.investment_stages ?? []).filter(Boolean))].sort();
              const industries = [...new Set(contactsData.flatMap((c) => c.investment_industries ?? []).filter(Boolean))].sort();
              const filteredContacts = contactsData.filter((c) => {
                if (nameSearchLower && !c.name?.toLowerCase().includes(nameSearchLower)) return false;
                if (contactsRoleFilter.length > 0 && !contactsRoleFilter.includes(c.role?.trim() ?? '')) return false;
                if (contactsStageFilter.length > 0) {
                  const contactStages = c.investment_stages ?? [];
                  if (!contactsStageFilter.some((s) => contactStages.includes(s))) return false;
                }
                if (contactsIndustryFilter.length > 0) {
                  const contactIndustries = c.investment_industries ?? [];
                  if (!contactsIndustryFilter.some((i) => contactIndustries.includes(i))) return false;
                }
                return true;
              });
              return (
                <div className="space-y-4">
                  {contactsLoading ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                    </div>
                  ) : contactsError ? (
                    <p className="text-red-600 text-sm">{contactsError}</p>
                  ) : contactsData.length > 0 ? (
                    <>
                      <div className="space-y-3">
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                          <input
                            type="text"
                            placeholder="Search by name..."
                            value={contactsNameSearch}
                            onChange={(e) => setContactsNameSearch(e.target.value)}
                            className="block w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                          />
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ContactsMultiSelect
                            label="Role"
                            options={roles}
                            selected={contactsRoleFilter}
                            onToggle={(v) =>
                              setContactsRoleFilter((prev) =>
                                prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
                              )
                            }
                          />
                          <ContactsMultiSelect
                            label="Stages"
                            options={stages}
                            selected={contactsStageFilter}
                            onToggle={(v) =>
                              setContactsStageFilter((prev) =>
                                prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
                              )
                            }
                            formatLabel={formatKebabLabel}
                          />
                          <ContactsMultiSelect
                            label="Industries"
                            options={industries}
                            selected={contactsIndustryFilter}
                            onToggle={(v) =>
                              setContactsIndustryFilter((prev) =>
                                prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
                              )
                            }
                            formatLabel={formatKebabLabel}
                          />
                        </div>
                        <p className="text-xs text-gray-500">
                          {filteredContacts.length} of {contactsData.length} contacts
                        </p>
                      </div>
                      <div className="space-y-3 relative">
                        {filteredContacts.length > 0 ? (
                          <>
                            {filteredContacts.map((contact) => (
                              <ContactCard
                                key={contact.id}
                                contact={contact}
                                onView={() => {
                                  if (onOpenContactFromFirm && investor) {
                                    onOpenContactFromFirm(contact, investor);
                                  } else {
                                    onInvestorChange?.(contact);
                                  }
                                }}
                              />
                            ))}
                            {isFreePlan && (investor?.associated_people_count ?? 0) > contactsData.length && (
                              <div className="relative pt-2">
                                <div className="space-y-3">
                                  {[1, 2, 3].map((i) => (
                                    <ContactCardSkeleton key={i} />
                                  ))}
                                </div>
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/90 backdrop-blur-sm rounded-lg">
                                  <p className="text-sm text-gray-600 text-center">
                                    Upgrade your plan to connect with the right investors and complete your raise.
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => openPricingModal()}
                                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-brand-default hover:bg-brand-dark text-white border-2 border-brand-fainter transition-colors shadow-sm"
                                  >
                                    Upgrade Plan
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-gray-500 text-sm">No contacts match your filters.</p>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-gray-500 text-sm">No contacts found for this firm.</p>
                  )}
                </div>
              );
            })()
          ) : investor.has_personalization && activeTab === 'pipeline' ? (
            /* Pipeline tab content */
            <div className="space-y-6">
              <div className="space-y-4">
                {/* Owner, Set, Stage - always shown, editable */}
                {updateInvestor && (
                  <div className="space-y-4">
                    <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Pipeline</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Stage</label>
                        <select
                          value={investor.stage?.trim() ?? 'Identified'}
                          onChange={(e) => handlePipelineFieldChange('stage', e.target.value || null)}
                          disabled={pipelineSaving}
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
                        >
                          {stageOptions.map((s: string) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Owner</label>
                        <select
                          value={investor.owner?.trim() ?? ''}
                          onChange={(e) => handlePipelineFieldChange('owner', e.target.value || null)}
                          disabled={pipelineSaving}
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
                        >
                          <option value="">— Select —</option>
                          {ownerOptions.map((o: string) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Set</label>
                        <select
                          value={investor.set_name?.trim() ?? ''}
                          onChange={(e) => handlePipelineFieldChange('set_name', e.target.value || null)}
                          disabled={pipelineSaving}
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
                        >
                          <option value="">— Select —</option>
                          {setOptions.map((s: string) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {pipelineSaving && (
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Saving...
                      </div>
                    )}
                    <hr className="border-gray-200" />
                  </div>
                )}

                {(investor.domain?.trim() ||
                    investor.linkedin_url?.trim() ||
                    investor.twitter_url?.trim() ||
                    parseCommaList(investor.email).length > 0 ||
                    parseCommaList(investor.phone).length > 0) && (
                    <div>
                      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Contact Details</h3>
                      <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-1">
                        {investor.domain?.trim() && (
                          <a
                            href={
                              /^https?:\/\//i.test(investor.domain!)
                                ? investor.domain!
                                : `https://${investor.domain!.replace(/^www\./, '')}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 rounded-lg text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            title={investor.domain!.replace(/^https?:\/\//i, '').replace(/^www\./, '')}
                            aria-label="Visit website"
                            onClick={async () => {
                              if (clipboardColumn && getInvestorCellValue) {
                                const val = getInvestorCellValue(investor, clipboardColumn);
                                if (val && val !== '-') {
                                  try {
                                    await copyToClipboard(val);
                                    onCopyToClipboard?.(`${columnLabels[clipboardColumn] ?? clipboardColumn} copied to clipboard`);
                                  } catch {
                                    // ignore
                                  }
                                }
                              }
                            }}
                          >
                            <Globe className="w-5 h-5" />
                          </a>
                        )}
                        {investor.linkedin_url?.trim() && (
                          <a
                            href={investor.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 rounded-lg text-gray-500 hover:text-[#0A66C2] hover:bg-[#0A66C2]/10 transition-colors"
                            title="LinkedIn"
                            aria-label="Open LinkedIn"
                            onClick={async () => {
                              if (clipboardLinkedInColumn && getInvestorCellValue) {
                                const val = getInvestorCellValue(investor, clipboardLinkedInColumn);
                                if (val && val !== '-') {
                                  try {
                                    await copyToClipboard(val);
                                    onCopyToClipboard?.(`${columnLabels[clipboardLinkedInColumn] ?? clipboardLinkedInColumn} copied to clipboard`);
                                  } catch {
                                    // ignore
                                  }
                                }
                              }
                            }}
                          >
                            <Linkedin className="w-5 h-5" />
                          </a>
                        )}
                        {investor.twitter_url?.trim() && (
                          <a
                            href={investor.twitter_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 rounded-lg text-gray-500 hover:text-[#1DA1F2] hover:bg-[#1DA1F2]/10 transition-colors"
                            title="Twitter"
                            aria-label="Open Twitter"
                          >
                            <Twitter className="w-5 h-5" />
                          </a>
                        )}
                      </div>
                      {(() => {
                        const emails = parseCommaList(investor.email);
                        return emails.length > 0 ? (
                          <div className="flex items-center gap-2">
                            <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            <div className="flex flex-wrap gap-x-3 gap-y-0">
                              {emails.map((e, idx) => {
                                let subject: string | undefined;
                                let body: string | undefined;
                                if (subjectColumn && getInvestorCellValue) {
                                  const subVal = getInvestorCellValue(investor, subjectColumn);
                                  if (subVal && subVal !== '-') subject = subVal;
                                }
                                if (clipboardColumn && getInvestorCellValue) {
                                  const clipVal = getInvestorCellValue(investor, clipboardColumn);
                                  if (clipVal && clipVal !== '-') {
                                    body = buildEmailBody(clipVal, 'Hi,\n\n', emailSettings);
                                  }
                                }
                                const href = buildEmailComposeUrl(e, { subject, body, emailSettings });
                                return (
                                  <a
                                    key={idx}
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                  >
                                    {e}
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        ) : null;
                      })()}
                      {(() => {
                        const phones = parseCommaList(investor.phone);
                        return phones.length > 0 ? (
                          <div className="flex items-center gap-2">
                            <Phone className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            <div className="flex flex-wrap gap-x-3 gap-y-0">
                              {phones.map((p, idx) => {
                                const phone = extractPhoneNumber(p);
                                let href: string;
                                if (phone) {
                                  if (phoneClickBehavior === 'call') {
                                    href = `tel:${phone}`;
                                  } else {
                                    let whatsappUrl = `https://wa.me/${phone}`;
                                    if (clipboardColumn && getInvestorCellValue) {
                                      const clipVal = getInvestorCellValue(investor, clipboardColumn);
                                      if (clipVal && clipVal !== '-') {
                                        whatsappUrl += `?text=${encodeURIComponent(clipVal)}`;
                                      }
                                    }
                                    href = whatsappUrl;
                                  }
                                } else {
                                  href = `tel:${p.replace(/\s/g, '')}`;
                                }
                                return (
                                  <a
                                    key={idx}
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                  >
                                    {p}
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        ) : null;
                      })()}
                    </div>
                    </div>
                  )}

                  {/* Messages - filled templates with copy button for each */}
                  {getInvestorCellValue &&
                    (() => {
                      const templateKeys = Object.keys(columnLabels).filter((k) => k.startsWith('template_'));
                      const filledMessages = templateKeys
                        .map((k) => ({ key: k, message: getInvestorCellValue(investor, k), label: columnLabels[k] ?? k.replace('template_', '') }))
                        .filter(({ message }) => message && message !== '-');
                      const channelsWithMessages = [...new Set(
                        filledMessages
                          .map(({ label }) => {
                            const m = label.match(/ - (.+)$/);
                            return m ? m[1] : null;
                          })
                          .filter((ch): ch is string => ch != null)
                      )].sort((a, b) => MESSAGE_CHANNEL_OPTIONS_BASE.indexOf(a) - MESSAGE_CHANNEL_OPTIONS_BASE.indexOf(b));
                      const messageChannelOptions = ['All', ...channelsWithMessages];
                      const effectiveChannelFilter = messageChannelOptions.includes(messagesChannelFilter) ? messagesChannelFilter : 'All';
                      const searchLower = messagesSearch.trim().toLowerCase();
                      const channelFilter = effectiveChannelFilter === 'All' ? null : effectiveChannelFilter;
                      const filteredMessages = filledMessages.filter(({ label }) => {
                        if (searchLower && !label.toLowerCase().includes(searchLower)) return false;
                        if (channelFilter && !label.endsWith(` - ${channelFilter}`)) return false;
                        return true;
                      });
                      return filledMessages.length > 0 ? (
                        <div>
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider shrink-0">Messages</h3>
                            <div className="ml-auto flex items-center gap-2 min-w-0">
                              <div className="relative w-[140px] min-w-[120px]">
                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                                <input
                                  type="text"
                                  placeholder="Search title..."
                                  value={messagesSearch}
                                  onChange={(e) => setMessagesSearch(e.target.value)}
                                  className="block w-full pl-7 pr-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                                />
                              </div>
                              <select
                                value={effectiveChannelFilter}
                                onChange={(e) => setMessagesChannelFilter(e.target.value)}
                                className="px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 min-w-0 max-w-[140px]"
                              >
                                {messageChannelOptions.map((ch) => (
                                  <option key={ch} value={ch}>
                                    {ch}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div className="space-y-3">
                            {filteredMessages.length === 0 ? (
                              <p className="text-sm text-gray-500 py-2">No messages match your search or filter.</p>
                            ) : (
                            filteredMessages.map(({ key: columnKey, message, label }) => (
                                <div
                                  key={columnKey}
                                  className="flex gap-2 p-3 rounded-lg border border-gray-200 bg-gray-50/50"
                                >
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
                                    <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                                      {message}
                                    </p>
                                  </div>
                                <button
                                  type="button"
                                  onClick={() => handleCopyField(message, `message_${columnKey}`)}
                                  className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 flex-shrink-0"
                                  title="Copy"
                                  aria-label={`Copy ${label}`}
                                >
                                  {copiedField === `message_${columnKey}` ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                                </button>
                              </div>
                            ))
                            )}
                          </div>
                        </div>
                      ) : null;
                    })()}

                  {investor.has_personalization && updateInvestor && (
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1">
                          <FileText className="w-3.5 h-3.5 text-gray-400" />
                          Notes
                        </h3>
                        {!isAddingNote && (
                          <button
                            type="button"
                            onClick={handleAddNote}
                            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-md hover:bg-indigo-100 transition-colors"
                          >
                            <Plus className="w-4 h-4 mr-1" />
                            Add Note
                          </button>
                        )}
                      </div>

                      {isAddingNote ? (
                        <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50/30 mb-4">
                          <div className="space-y-3">
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Message</label>
                              <div className="flex flex-wrap gap-2 mb-2">
                                <button
                                  type="button"
                                  onClick={() => setNewNoteMessage('Not Picked')}
                                  className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                                >
                                  Not Picked
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setNewNoteMessage('Interested')}
                                  className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 transition-colors"
                                >
                                  Interested
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setNewNoteMessage('Not Interested')}
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
                                <p className="mt-1 text-xs text-gray-500">Date will be automatically set to today</p>
                              )}
                            </div>
                            <div className="flex gap-2 justify-end">
                              <button
                                type="button"
                                onClick={editingNoteIndex !== null ? handleCancelEditNote : handleCancelAddNote}
                                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={handleSaveNote}
                                disabled={!newNoteMessage.trim()}
                                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {editingNoteIndex !== null ? 'Update' : 'Save'}
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {notes.length > 0 ? (
                        <div className="space-y-3">
                          {notes.map((note, index) => (
                            <div
                              key={index}
                              className="border border-gray-200 rounded-lg p-4 bg-white hover:shadow-md transition-shadow"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-xs font-medium text-gray-500">
                                      {new Date(note.date).toLocaleDateString('en-US', {
                                        year: 'numeric',
                                        month: 'short',
                                        day: 'numeric',
                                      })}
                                    </span>
                                  </div>
                                  <p className="text-sm text-gray-900 whitespace-pre-wrap">{note.message}</p>
                                </div>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleEditNote(index)}
                                    className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                    title="Edit note"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteNoteClick(index)}
                                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
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
                          <div className="text-center py-8 border border-gray-200 rounded-lg bg-gray-50">
                            <p className="text-sm text-gray-600">No notes yet. Click &quot;Add Note&quot; to create one.</p>
                          </div>
                        )
                      )}
                    </div>
                  )}
                  {investor.has_personalization && updateInvestor && <hr className="border-gray-200" />}
                  {Array.isArray(investor.links) && investor.links.length > 0 && (
                    <DetailSection
                      label="Investor Links"
                      icon={<Link2 className="w-3.5 h-3.5 text-gray-400" />}
                      value={
                        <ul className="list-disc list-inside space-y-2">
                          {investor.links.map((item, idx) => {
                            const parsed = parseNotableInvestment(item);
                            return (
                              <li key={idx}>
                                {parsed ? (
                                  <a
                                    href={parsed.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                  >
                                    {parsed.name}
                                  </a>
                                ) : (
                                  <span className="text-sm text-gray-700">{item}</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      }
                    />
                  )}
                </div>
            </div>
          ) : investor.has_personalization && activeTab === 'deep-research' ? (
            /* Deep Research tab content */
            <div className="space-y-4">
              {deepResearchLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                </div>
              ) : deepResearchError ? (
                <p className="text-red-600 text-sm">{deepResearchError}</p>
              ) : deepResearchContent ? (
                <div className="prose prose-base max-w-none [&>*:first-child]:mt-0
                  prose-headings:text-gray-900 prose-headings:font-semibold
                  prose-h1:mt-0 prose-h1:mb-6 prose-h1:text-2xl
                  prose-h2:mt-10 prose-h2:mb-4 prose-h2:text-xl prose-h2:border-b prose-h2:border-gray-200 prose-h2:pb-2
                  prose-h3:mt-8 prose-h3:mb-3 prose-h3:text-lg
                  prose-p:text-gray-700 prose-p:my-4 prose-p:leading-relaxed
                  prose-strong:text-gray-900 prose-strong:font-semibold
                  prose-hr:my-8 prose-hr:border-gray-300
                  prose-ul:my-4 prose-ol:my-4 prose-li:my-2
                  prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline">
                  <ReactMarkdown>{deepResearchContent}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No deep research data available for this investor.</p>
              )}
            </div>
          ) : investor.has_personalization && activeTab === 'latest-news' ? (
            /* Latest News tab content */
            <div className="space-y-4">
              {investorNewsLoading && !investorNews ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                </div>
              ) : investorNewsError ? (
                <p className="text-red-600 text-sm">{investorNewsError}</p>
              ) : investorNews ? (
                <div className="space-y-4">
                  {investorNews.answer && (
                    <div>
                      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <Newspaper className="w-3.5 h-3.5 text-gray-400" />
                        Summary
                      </h3>
                      <div className="prose prose-sm max-w-none prose-p:text-gray-700 prose-p:leading-relaxed prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline">
                        <ReactMarkdown>{investorNews.answer}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                  {Array.isArray(investorNews.citations) && investorNews.citations.length > 0 && (
                    <DetailSection
                      label="Sources"
                      icon={<Link2 className="w-3.5 h-3.5 text-gray-400" />}
                      value={
                        <ul className="list-disc list-inside space-y-2">
                          {investorNews.citations.map((item, idx) => {
                            const parsed = parseNotableInvestment(item);
                            return (
                              <li key={idx}>
                                {parsed ? (
                                  <a
                                    href={parsed.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                  >
                                    {parsed.name}
                                  </a>
                                ) : (
                                  <span className="text-sm text-gray-700">{item}</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      }
                    />
                  )}
                  {investorNews.date && (
                    <p className="text-xs text-gray-500">
                      {investorNews.answer || (Array.isArray(investorNews.citations) && investorNews.citations.length > 0)
                        ? `Last fetched: ${new Date(investorNews.date).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}`
                        : 'Last fetch returned no results. Try fetching again.'}
                    </p>
                  )}
                </div>
              ) : null}
              <div className="flex flex-col gap-2 pt-2">
                {!investorNews && !investorNewsLoading && !investorNewsError && (
                  <p className="text-sm text-gray-500">No news fetched yet. Click to fetch latest.</p>
                )}
                <button
                  onClick={handleFetchInvestorNews}
                  disabled={investorNewsLoading || investorNewsFetchCooldown}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm w-fit"
                >
                  {investorNewsLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Newspaper className="w-4 h-4" />
                  )}
                  {investorNewsLoading
                    ? 'Fetching...'
                    : `Fetch Latest News on ${investor?.name || 'this investor'}`}
                </button>
              </div>
            </div>
          ) : (
            /* Investor Profile tab (default) - current content without Pipeline fields */
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{investor.name}</h2>
                <div className="flex flex-wrap gap-3 mt-2 text-sm text-gray-600 items-center">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium text-gray-500">Active</span>
                    {investor.active === true ? (
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    ) : investor.active === false ? (
                      <XCircle className="w-4 h-4 text-gray-400" />
                    ) : (
                      <Minus className="w-4 h-4 text-gray-400" />
                    )}
                    <span>{investor.active === true ? 'Yes' : investor.active === false ? 'No' : '-'}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium text-gray-500">Leads round</span>
                    {investor.leads_round === true ? (
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    ) : investor.leads_round === false ? (
                      <XCircle className="w-4 h-4 text-gray-400" />
                    ) : (
                      <Minus className="w-4 h-4 text-gray-400" />
                    )}
                    <span>{investor.leads_round === true ? 'Yes' : investor.leads_round === false ? 'No' : '-'}</span>
                  </span>
                  {investor.has_personalization && (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                        investor.ai_metadata?.investor_fit === true
                          ? 'bg-emerald-100 text-emerald-800'
                          : investor.ai_metadata?.investor_fit === false
                            ? 'bg-red-100 text-red-800'
                            : investor.ai_metadata?.investor_fit === null
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      <CheckCircle className="w-3 h-3" />
                      Reviewed
                    </span>
                  )}
                </div>
                {!investor.has_personalization && onAnalyze && (
                  <button
                    onClick={() => onAnalyze(investor.id)}
                    disabled={isAnalyzing}
                    className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-600 disabled:opacity-50 shadow-sm"
                  >
                    {isAnalyzing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    Analyze with AI
                  </button>
                )}
              </div>

              {investor.type === 'firm' && investor.role && (
                <DetailRow
                  label="Role"
                  icon={<Briefcase className="w-4 h-4 text-gray-400" />}
                  value={investor.role}
                />
              )}

              {investor.ai_metadata && typeof investor.ai_metadata === 'object' && Object.keys(investor.ai_metadata).length > 0 && (
                <>
                  <hr className="border-gray-200" />
                  <div className="space-y-4">
                    {/* investor_fit */}
                    {typeof investor.ai_metadata.investor_fit === 'boolean' || investor.ai_metadata.investor_fit === null ? (
                      <div className="flex items-center gap-2">
                        <span className="text-lg" role="img" aria-label="fit">
                          {investor.ai_metadata.investor_fit === true ? '😊' : investor.ai_metadata.investor_fit === false ? '😕' : '😐'}
                        </span>
                        <span
                          className={`text-sm font-medium ${
                            investor.ai_metadata?.investor_fit === true
                              ? 'text-emerald-700'
                              : investor.ai_metadata?.investor_fit === false
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }`}
                        >
                          {investor.ai_metadata.investor_fit === true ? 'Strong Fit' : investor.ai_metadata.investor_fit === false ? 'Weak Fit' : 'Unclear Fit'}
                        </span>
                      </div>
                    ) : null}

                    {/* reason */}
                    {typeof investor.ai_metadata.reason === 'string' && investor.ai_metadata.reason.trim() && (
                      <div
                        className={`p-3 rounded-lg border ${
                          investor.ai_metadata?.investor_fit === true
                            ? 'bg-emerald-50 border-emerald-100'
                            : investor.ai_metadata?.investor_fit === false
                              ? 'bg-red-50 border-red-100'
                              : investor.ai_metadata?.investor_fit === null
                                ? 'bg-amber-50 border-amber-100'
                                : 'bg-gray-50 border-gray-100'
                        }`}
                      >
                        <p className="text-sm text-gray-800 whitespace-pre-wrap">{investor.ai_metadata.reason}</p>
                      </div>
                    )}

                    {/* Personalization - line1 & line2 - editable (show when has content, or when editing, or when updateInvestor to allow adding) */}
                    {(typeof investor.ai_metadata.line1 === 'string' && investor.ai_metadata.line1.trim()) ||
                    (typeof investor.ai_metadata.line2 === 'string' && investor.ai_metadata.line2.trim()) ||
                    (typeof investor.ai_metadata.twitter_line === 'string' && investor.ai_metadata.twitter_line.trim()) ||
                    (Array.isArray(investor.ai_metadata.mutual_interests) && investor.ai_metadata.mutual_interests.length > 0) ||
                    editingAiMetadata ||
                    (updateInvestor && investor.has_personalization) ? (
                      <>
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">How to Reach Out Thoughtfully</h3>
                          {updateInvestor && (
                            editingAiMetadata ? (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={handleCancelEditAiMetadata}
                                  className="px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-800"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={handleSaveAiMetadata}
                                  disabled={aiMetadataSaving}
                                  className="px-2 py-1 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50"
                                >
                                  {aiMetadataSaving ? 'Saving...' : 'Save'}
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setEditingAiMetadata(true)}
                                className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-indigo-600 flex-shrink-0"
                                title="Edit"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                            )
                          )}
                        </div>
                        {editingAiMetadata ? (
                          <div className="space-y-3 border border-indigo-200 rounded-lg p-4 bg-indigo-50/30">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Twitter Line</label>
                              <textarea
                                value={aiMetadataTwitterLine}
                                onChange={(e) => setAiMetadataTwitterLine(e.target.value)}
                                rows={2}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                placeholder="I just read your tweet about..."
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Line 1</label>
                              <textarea
                                value={aiMetadataLine1}
                                onChange={(e) => setAiMetadataLine1(e.target.value)}
                                rows={2}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                placeholder="Personalization line 1..."
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Line 2</label>
                              <textarea
                                value={aiMetadataLine2}
                                onChange={(e) => setAiMetadataLine2(e.target.value)}
                                rows={2}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                placeholder="Personalization line 2..."
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Mutual Interests (one per line)</label>
                              <textarea
                                value={aiMetadataMutualInterestsText}
                                onChange={(e) => setAiMetadataMutualInterestsText(e.target.value)}
                                rows={4}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                placeholder="One interest per line..."
                              />
                            </div>
                          </div>
                        ) : (
                          <>
                            {typeof investor.ai_metadata.twitter_line === 'string' && investor.ai_metadata.twitter_line.trim() && (
                              <div className="flex items-start gap-2">
                                <p className="text-sm text-gray-700 flex-1">{investor.ai_metadata.twitter_line}</p>
                                <button
                                  type="button"
                                  onClick={() => handleCopyField(investor.ai_metadata!.twitter_line as string, 'twitter_line')}
                                  className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 flex-shrink-0"
                                  title="Copy"
                                >
                                  {copiedField === 'twitter_line' ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                                </button>
                              </div>
                            )}
                            {typeof investor.ai_metadata.line1 === 'string' && investor.ai_metadata.line1.trim() && (
                              <div className="flex items-start gap-2">
                                <p className="text-sm text-gray-700 flex-1">{investor.ai_metadata.line1}</p>
                                <button
                                  type="button"
                                  onClick={() => handleCopyField(investor.ai_metadata!.line1 as string, 'line1')}
                                  className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 flex-shrink-0"
                                  title="Copy"
                                >
                                  {copiedField === 'line1' ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                                </button>
                              </div>
                            )}
                            {typeof investor.ai_metadata.line2 === 'string' && investor.ai_metadata.line2.trim() && (
                              <div className="flex items-start gap-2">
                                <p className="text-sm text-gray-700 flex-1">{investor.ai_metadata.line2}</p>
                                <button
                                  type="button"
                                  onClick={() => handleCopyField(investor.ai_metadata!.line2 as string, 'line2')}
                                  className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 flex-shrink-0"
                                  title="Copy"
                                >
                                  {copiedField === 'line2' ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                                </button>
                              </div>
                            )}
                            {Array.isArray(investor.ai_metadata.mutual_interests) && investor.ai_metadata.mutual_interests.length > 0 && (
                              <DetailSection
                                label="Mutual Interests"
                                value={
                                  <ul className="list-disc list-inside space-y-1">
                                    {(investor.ai_metadata.mutual_interests as string[]).map((interest, idx) => (
                                      <li key={idx} className="text-sm text-gray-700">{interest}</li>
                                    ))}
                                  </ul>
                                }
                              />
                            )}
                          </>
                        )}
                      </>
                    ) : null}

                    <hr className="border-gray-200" />
                  </div>
                </>
              )}

              {/* Associated Firm (persons) / Associated People (firms) + HQ Location - same row */}
              {(investor.type === 'person' && (investor.associated_firm_id || investor.associated_firm_name)) ||
              (investor.type === 'firm' && investor.associated_people_count != null) ||
              investor.hq_state ||
              investor.hq_country ? (
                <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                  {investor.type === 'person' && (investor.associated_firm_id || investor.associated_firm_name) && (
                    <DetailRow
                      label="Associated Firm"
                      icon={<Briefcase className="w-4 h-4 text-gray-400" />}
                      value={
                        investor.associated_firm_id && onOpenInvestorById ? (
                          <button
                            type="button"
                            onClick={() => onOpenInvestorById(investor.associated_firm_id!)}
                            className="font-semibold text-indigo-600 hover:text-indigo-800 hover:underline text-left"
                          >
                            {investor.associated_firm_name || investor.associated_firm_id}
                          </button>
                        ) : (
                          <span className="font-semibold text-gray-900">
                            {investor.associated_firm_name || investor.associated_firm_id || '-'}
                          </span>
                        )
                      }
                    />
                  )}
                  {investor.type === 'firm' && investor.associated_people_count != null && (
                    <DetailRow
                      label="Associated People"
                      icon={<Users className="w-4 h-4 text-gray-400" />}
                      value={
                        investor.associated_people_count === 0 ? (
                          'No contacts available'
                        ) : (
                          <button
                            type="button"
                            onClick={() => setActiveTab('contacts')}
                            className="font-medium text-indigo-600 hover:text-indigo-800 hover:underline text-left"
                          >
                            {investor.associated_people_count === 1
                              ? '1 contact available'
                              : `${investor.associated_people_count} contacts available`}
                          </button>
                        )
                      }
                    />
                  )}
                  {(investor.hq_state || investor.hq_country) && (
                    <DetailRow
                      label="HQ Location"
                      icon={<MapPin className="w-4 h-4 text-gray-400" />}
                      value={formatHqLocation(investor.hq_state, investor.hq_country)}
                    />
                  )}
                </div>
              ) : null}

              {/* investor_type */}
              <DetailSection
                label="Investor type"
                value={
                  investor.investor_type && investor.investor_type.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {investor.investor_type.map((t) => (
                        <span
                          key={t}
                          className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )
                }
              />

              {/* investment_thesis */}
              <DetailSection
                label="Investment thesis"
                value={
                  investor.investment_thesis ? (
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{investor.investment_thesis}</p>
                  ) : (
                    '-'
                  )
                }
              />

              {/* fund_size_usd, check_size_min_usd, check_size_max_usd */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <DetailField label="Fund size" value={formatCurrency(investor.fund_size_usd)} />
                <DetailField label="Check size min" value={formatCurrency(investor.check_size_min_usd)} />
                <DetailField label="Check size max" value={formatCurrency(investor.check_size_max_usd)} />
              </div>

              {/* investment_stages */}
              <DetailSection
                label="Investment stages"
                icon={<Target className="w-3.5 h-3.5 text-gray-400" />}
                value={
                  investor.investment_stages && investor.investment_stages.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {investor.investment_stages.map((s) => (
                        <span
                          key={s}
                          className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800"
                        >
                          {formatKebabLabel(s)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )
                }
              />

              {/* investment_industries */}
              <DetailSection
                label="Investment industries"
                value={
                  investor.investment_industries && investor.investment_industries.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {investor.investment_industries.map((i) => (
                        <span
                          key={i}
                          className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-800"
                        >
                          {formatKebabLabel(i)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )
                }
              />

              {/* investment_geographies */}
              <DetailSection
                label="Investment geographies"
                icon={<Globe className="w-3.5 h-3.5 text-gray-400" />}
                value={
                  investor.investment_geographies && investor.investment_geographies.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {investor.investment_geographies.map((g) => (
                        <span
                          key={g}
                          className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-sky-50 text-sky-800"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )
                }
              />

              {/* notable_investments */}
              {(() => {
                const items = Array.isArray(investor.notable_investments)
                  ? investor.notable_investments
                  : typeof investor.notable_investments === 'string'
                    ? [investor.notable_investments]
                    : [];
                return (
                  <DetailSection
                    label="Notable investments"
                    icon={<ExternalLink className="w-3.5 h-3.5 text-gray-400" />}
                    value={
                      items.length > 0 ? (
                        <ul className="space-y-2">
                          {items.map((item, idx) => {
                            const parsed = parseNotableInvestment(item);
                            const displayName = parsed ? parsed.name : item;
                            const displayUrl = parsed ? parsed.url : undefined;
                            return (
                              <li key={idx} className="flex items-center gap-3">
                                <CompanyLogo name={displayName} url={displayUrl} />
                                {parsed ? (
                                  <a
                                    href={parsed.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                  >
                                    {parsed.name}
                                  </a>
                                ) : (
                                  <span className="text-sm text-gray-700">{item}</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        '-'
                      )
                    }
                  />
                );
              })()}

              {/* Warm intros by domain - compact display */}
              {warmIntrosLoading ? (
                <div className="flex items-center gap-2 py-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
                  <span className="text-xs text-gray-500">Loading warm intros…</span>
                </div>
              ) : warmIntrosByDomains && warmIntrosByDomains.some((d) => Array.isArray(d.founders) && d.founders.length > 0) ? (
                <DetailSection
                  label="Founder–Investor Intro Paths"
                  icon={<Users className="w-3.5 h-3.5 text-gray-400" />}
                  value={
                    <div className="space-y-3">
                      {warmIntrosByDomains
                        .filter((d) => Array.isArray(d.founders) && d.founders.length > 0)
                        .map(({ domain, founders }) => (
                          <div key={domain} className="flex flex-wrap items-center gap-2">
                            <CompanyLogo name={domain} url={`https://${domain}`} />
                            <span className="text-xs font-medium text-gray-500 shrink-0">{domain}</span>
                            <div className="flex flex-wrap gap-1.5">
                              {founders.map((f, i) => {
                                const loc = [f.city, f.state, f.country].filter(Boolean).join(', ');
                                return (
                                  <a
                                    key={i}
                                    href={f.linkedin}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-start gap-1.5 px-2 py-1.5 rounded bg-gray-50 hover:bg-gray-100 text-xs text-gray-700"
                                  >
                                    {f.photo_url ? (
                                      <img
                                        src={f.photo_url}
                                        alt=""
                                        className="w-6 h-6 rounded-full object-cover shrink-0"
                                      />
                                    ) : (
                                      <span className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-medium text-gray-500 shrink-0">
                                        {f.name.charAt(0)}
                                      </span>
                                    )}
                                    <div className="min-w-0">
                                      <span className="block font-medium truncate max-w-[100px]">{f.name}</span>
                                      {loc && (
                                        <span className="block text-[10px] text-gray-500 truncate max-w-[100px]">{loc}</span>
                                      )}
                                    </div>
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                    </div>
                  }
                />
              ) : null}

              {/* Pipeline fields moved to Pipeline tab when has_personalization */}
            </div>
          )}
        </div>
      </div>

      {/* Note Toast */}
      {noteToast && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-md shadow-lg z-[80] transition-opacity duration-300">
          {noteToast}
        </div>
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
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete Note</h3>
              <div className="text-sm text-gray-600 mb-6">
                <p className="mb-3">Are you sure you want to delete this note? This action cannot be undone.</p>
                {notes[noteToDelete] && (
                  <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
                    <p className="text-xs text-gray-500 mb-1">
                      {new Date(notes[noteToDelete].date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </p>
                    <p className="text-sm text-gray-900">{notes[noteToDelete].message}</p>
                  </div>
                )}
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={handleDeleteNoteCancel}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteNoteConfirm}
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

export default InvestorDetailsDrawer;
