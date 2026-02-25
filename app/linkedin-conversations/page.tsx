'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useAuth } from '@/contexts/AuthContext';
import { getValidAccessToken } from '@/lib/api';
import { useMessageTemplates, MessageTemplate, TemplateChannel, CHANNEL_LABELS } from '@/contexts/MessageTemplatesContext';
import { substituteVariables } from '@/lib/utils';
import { getFollowUpDate } from '@/lib/messageTemplates';
import { duplicateTemplate, replaceInPresentation } from '@/lib/googleSlides';
import { supabase } from '@/utils/supabase/client';
import {
  MessageSquare,
  Send,
  ArrowLeft,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  User,
  Inbox,
  Search,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Info,
  X,
  Briefcase,
  Mail,
  Phone,
  MapPin,
  Globe,
  Linkedin,
  Award,
  Filter,
  Zap,
  ChevronDown,
  Sparkles,
  Square,
  FileText,
  Tag,
  List,
  ArrowDownUp,
  UserSearch,
  ClipboardCopy,
  Check,
  Presentation,
} from 'lucide-react';

/* ────────────────────────── Stage Constants ────────────────────────── */

const STAGE_OPTIONS = [
  { value: 'attempted_to_contact', label: 'Attempted to Contact', color: 'bg-gray-100 text-gray-700 border-gray-200' },
  { value: 'reply_received', label: 'Reply Received', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'meeting_scheduled', label: 'Meeting Scheduled', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  { value: 'demo_completed', label: 'Demo Completed', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { value: 'proposal_sent', label: 'Proposal Sent', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  { value: 'negotiating', label: 'Negotiating', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { value: 'closed_won', label: 'Closed Won', color: 'bg-green-100 text-green-700 border-green-200' },
  { value: 'closed_lost', label: 'Closed Lost', color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

function getStageOption(value: string) {
  return STAGE_OPTIONS.find((s) => s.value === value) || STAGE_OPTIONS[0];
}

/* ────────────────────────── Types ────────────────────────── */

interface LinkedInMessage {
  uuid: string;
  linkedin_conversation_uuid: string;
  lead_uuid: string;
  sender_profile_uuid?: string;
  type: string; // inbox | outbox
  text: string;
  status?: string;
  automation?: string | null; // "auto" | "synced" | null
  created_at: string;
  sent_at?: string;
  updated_at?: string;
  read_at?: string | null;
  [key: string]: unknown;
}

interface Conversation {
  linkedin_conversation_uuid: string;
  lead_uuid: string;
  last_message: LinkedInMessage;
  message_count: number;
  lead?: LeadInfo | null;
  sender_profile_uuid?: string; // from the outbox messages in this conversation
  has_unread: boolean; // true if the last message is from the lead (awaiting reply)
  has_prospect_reply: boolean; // true if any message in this conversation is from the prospect
  automation_type?: string | null; // "auto" | "synced" | null — from messages
}

interface LeadMarker {
  sender_profile_uuid?: string;
  last_message_type?: string; // "inbox" | "outbox"
  linkedin_messages_inbox_count?: number;
  linkedin_read_count?: number;
  linkedin_messages_sent_count?: number;
  [key: string]: unknown;
}

interface LeadFlow {
  uuid: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

interface LeadExperience {
  company_name?: string;
  position?: string;
  company_nickname?: string;
  employment_type?: string;
  location?: string;
  start_date?: string;
  end_date?: string;
  description?: string;
}

interface LeadInfo {
  uuid: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  company_uuid?: string;
  company_ln_id?: string;
  linkedin?: string;
  avatar_url?: string;
  position?: string;
  headline?: string;
  about?: string;
  work_email?: string;
  personal_email?: string;
  work_phone_number?: string;
  personal_phone_number?: string;
  facebook?: string;
  twitter?: string;
  connections_number?: number;
  followers_number?: number;
  primary_language?: string;
  raw_address?: string;
  location?: {
    country?: string;
    region?: string;
    city?: string;
    timezone?: string;
  };
  experience?: LeadExperience[];
  skills?: string[];
  status?: string;
  linkedin_status?: string;
  email_status?: string;
  markers?: LeadMarker[];
  tags?: string[];
  lead_flows?: LeadFlow[];
  list_uuid?: string;
  created_at?: string;
  [key: string]: unknown;
}

interface CompanyInfo {
  uuid: string;
  name?: string;
  domain?: string;
  website?: string;
  linkedin?: string;
  logo_url?: string;
  phone?: string;
  industry?: string;
  employees_range?: string;
  followers?: number;
  employees_on_linkedin?: number;
  year_established?: number;
  tagline?: string;
  about?: string;
  specialities?: string[];
  hq_raw_address?: string;
  hq_location?: {
    country?: string;
    region?: string;
    city?: string;
    zip?: string;
    timezone?: string;
    address_string?: string;
  };
  facebook?: string;
  twitter?: string;
  [key: string]: unknown;
}

interface SenderProfile {
  uuid: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  linkedin_account_uuid?: string;
  avatar_url?: string;
  [key: string]: unknown;
}

interface AutomationInfo {
  uuid: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

interface ListInfo {
  uuid: string;
  name?: string;
  [key: string]: unknown;
}

interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

/* ────────────────────────── Helper ────────────────────────── */

function getLeadDisplayName(lead?: LeadInfo | null): string {
  if (!lead) return 'Unknown Contact';
  if (lead.name) return lead.name;
  const parts = [lead.first_name, lead.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Unknown Contact';
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  } catch {
    return dateStr;
  }
}

function formatFullDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return dateStr;
  }
}

/* ────────────────────────── Main Component ────────────────────────── */

function SearchableDropdown({
  value,
  onChange,
  placeholder,
  options,
  icon: Icon,
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = filter
    ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    : options;

  const selectedLabel = options.find((o) => o.value === value)?.label;

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        type="button"
        onClick={() => { setOpen(!open); setFilter(''); }}
        className="w-full flex items-center gap-1 text-[11px] px-2 py-1.5 border border-gray-200 rounded-md bg-white text-gray-600 hover:border-gray-300 transition-colors truncate"
      >
        {Icon && <Icon className="w-3 h-3 flex-shrink-0 text-gray-400" />}
        <span className="truncate flex-1 text-left">{selectedLabel || placeholder}</span>
        {value ? (
          <X
            className="w-3 h-3 flex-shrink-0 text-gray-400 hover:text-gray-600"
            onClick={(e) => { e.stopPropagation(); onChange(''); setOpen(false); }}
          />
        ) : (
          <ChevronDown className="w-3 h-3 flex-shrink-0 text-gray-400" />
        )}
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 flex flex-col">
          <div className="p-1.5 border-b border-gray-100">
            <input
              autoFocus
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Type to filter..."
              className="w-full text-[11px] px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-teal-400"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false); }}
              className={`w-full text-left text-[11px] px-3 py-1.5 hover:bg-teal-50 transition-colors ${!value ? 'text-teal-600 font-medium' : 'text-gray-500'}`}
            >
              {placeholder}
            </button>
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`w-full text-left text-[11px] px-3 py-1.5 hover:bg-teal-50 transition-colors truncate ${o.value === value ? 'text-teal-600 font-medium bg-teal-50/50' : 'text-gray-700'}`}
              >
                {o.label}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-[11px] text-gray-400 px-3 py-2 text-center">No matches</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LinkedInConversationsPage() {
  // Auth
  const { user } = useAuth();

  // Conversation list state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginationMeta>({ limit: 50, offset: 0, total: 0, has_more: false });
  const [searchQuery, setSearchQuery] = useState('');
  const [showUnrepliedOnly, setShowUnrepliedOnly] = useState(true);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  // Thread view state
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [threadMessages, setThreadMessages] = useState<LinkedInMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadPagination, setThreadPagination] = useState<PaginationMeta>({ limit: 50, offset: 0, total: 0, has_more: false });

  // Reply state
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySuccess, setReplySuccess] = useState(false);

  // AI reply generation state
  const [generatingReply, setGeneratingReply] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Template picker state
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [templatePickerTab, setTemplatePickerTab] = useState<TemplateChannel | null>(null);
  const templatePickerRef = useRef<HTMLDivElement>(null);
  const { templates: allTemplates, loading: templatesLoading } = useMessageTemplates();
  const templatesByChannel = useMemo(() => {
    const grouped: Partial<Record<TemplateChannel, MessageTemplate[]>> = {};
    for (const t of allTemplates) {
      (grouped[t.channel] ??= []).push(t);
    }
    return grouped;
  }, [allTemplates]);
  const templateChannels = useMemo(
    () => (Object.keys(templatesByChannel) as TemplateChannel[]).sort((a, b) => {
      const order: TemplateChannel[] = ['linkedin', 'direct', 'email', 'instagram'];
      return order.indexOf(a) - order.indexOf(b);
    }),
    [templatesByChannel]
  );

  // Drafts: keyed by linkedin_conversation_uuid
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Bulk AI generation state
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkErrors, setBulkErrors] = useState(0);
  const bulkAbortRef = useRef(false);

  // Sender profiles
  const [senderProfiles, setSenderProfiles] = useState<SenderProfile[]>([]);
  const [selectedSenderProfile, setSelectedSenderProfile] = useState<string>('');

  // Automation type filter (auto, synced, is_null, is_not_null)
  const [automationFilter, setAutomationFilter] = useState<string>('');

  // Search Contacts mode
  const [contactSearchMode, setContactSearchMode] = useState(false);
  const [contactSearchQuery, setContactSearchQuery] = useState('');
  const [contactSearchLoading, setContactSearchLoading] = useState(false);
  const [contactSearchError, setContactSearchError] = useState<string | null>(null);
  const [contactSearchResults, setContactSearchResults] = useState<LeadInfo[]>([]);
  const [contactSearchConversations, setContactSearchConversations] = useState<Conversation[]>([]);
  const [contactSearchTruncated, setContactSearchTruncated] = useState(false);
  const [contactSearchListFilter, setContactSearchListFilter] = useState<string>('');
  const [contactSearchTagFilter, setContactSearchTagFilter] = useState<string>('');

  // Contact details panel
  const [showContactDetails, setShowContactDetails] = useState(false);
  const [copiedContact, setCopiedContact] = useState(false);
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo | null>(null);
  const [companyLoading, setCompanyLoading] = useState(false);
  const companyCacheRef = useRef<Record<string, CompanyInfo>>({});
  const [pptLoading, setPptLoading] = useState(false);
  const [pptError, setPptError] = useState<string | null>(null);
  const [pptUrl, setPptUrl] = useState<string | null>(null);

  // Automations, Lists & Tags lookup maps
  const [automationsMap, setAutomationsMap] = useState<Record<string, AutomationInfo>>({});
  const [listsMap, setListsMap] = useState<Record<string, ListInfo>>({});
  const [tagsMap, setTagsMap] = useState<Record<string, string>>({});

  // Outreach stages: key = "lead_uuid::sender_profile_id", value = stage string
  const [stagesMap, setStagesMap] = useState<Record<string, string>>({});
  const [stageUpdating, setStageUpdating] = useState<string | null>(null); // key currently being updated

  // Lead cache
  const leadCacheRef = useRef<Record<string, LeadInfo>>({});

  // Refs
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftsRef = useRef<Record<string, string>>({});
  const filteredConversationsRef = useRef<Conversation[]>([]);
  const accessFilteredConversationsRef = useRef<Conversation[]>([]);

  /* ────────────────── API Calls ────────────────── */

  // Background lead hydration: fetches lead details and updates conversations progressively
  const hydrateLeads = useCallback(async (leadUuids: string[], token: string) => {
    // Always clear cache on fresh fetch so stale data doesn't persist
    leadCacheRef.current = {};

    if (leadUuids.length === 0) return;

    // Fire ALL requests in parallel for speed
    const promises = leadUuids.map(async (uuid) => {
      try {
        const leadRes = await fetch(`/api/linkedin-conversations/leads?uuid=${encodeURIComponent(uuid)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (leadRes.ok) {
          const leadData = await leadRes.json();
          // API route returns { lead: { uuid, name, ... }, markers: [...], flows: [...] }
          const lead = leadData.lead || leadData;
          const markers = leadData.markers || [];
          const flows = leadData.flows || [];
          if (lead && (lead.name || lead.first_name)) {
            lead.markers = markers;
            lead.lead_flows = flows;
            leadCacheRef.current[uuid] = lead;
          }
        }
      } catch {
        // silently skip failed lead fetches
      }
    });

    // Update UI progressively as batches of 20 resolve
    const batchSize = 20;
    for (let i = 0; i < promises.length; i += batchSize) {
      await Promise.allSettled(promises.slice(i, i + batchSize));
      setConversations((prev) =>
        prev.map((c) => ({
          ...c,
          lead: leadCacheRef.current[c.lead_uuid] || c.lead || null,
        }))
      );
    }
  }, []);

  const fetchMessages = useCallback(async (offset = 0) => {
    try {
      setConversationsLoading(true);
      setConversationsError(null);
      const token = await getValidAccessToken();
      if (!token) throw new Error('Not authenticated');

      const params = new URLSearchParams({
        limit: '200',
        offset: String(offset),
        order_field: 'created_at',
        order_type: 'desc',
      });

      // Apply automation filter
      if (automationFilter) {
        params.set('filter[automation]', automationFilter);
      }

      const res = await fetch(`/api/linkedin-conversations?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to fetch messages (${res.status})`);
      }

      const json = await res.json();
      const messages: LinkedInMessage[] = json.data || [];

      // Group by linkedin_conversation_uuid
      const convMap = new Map<string, { messages: LinkedInMessage[]; lead_uuid: string; sender_profile_uuid?: string; automation_type?: string | null }>();
      for (const msg of messages) {
        const key = msg.linkedin_conversation_uuid;
        if (!key) continue;
        if (!convMap.has(key)) {
          convMap.set(key, { messages: [], lead_uuid: msg.lead_uuid });
        }
        const entry = convMap.get(key)!;
        entry.messages.push(msg);
        // Track sender_profile_uuid from any message (inbox messages carry it too)
        if (msg.sender_profile_uuid && !entry.sender_profile_uuid) {
          entry.sender_profile_uuid = msg.sender_profile_uuid;
        }
        // Track automation type from outbox messages
        if (msg.type === 'outbox' && msg.automation && !entry.automation_type) {
          entry.automation_type = msg.automation as string;
        }
      }

      // Build conversations list sorted by most recent message
      const convList: Conversation[] = [];
      convMap.forEach((val, key) => {
        const sorted = val.messages.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        // Unread = last message is from the lead (inbox), meaning they replied and we haven't responded yet
        const lastMsg = sorted[0];
        convList.push({
          linkedin_conversation_uuid: key,
          lead_uuid: val.lead_uuid,
          last_message: lastMsg,
          message_count: sorted.length,
          lead: leadCacheRef.current[val.lead_uuid] || null,
          sender_profile_uuid: val.sender_profile_uuid,
          has_unread: lastMsg.type === 'inbox',
          has_prospect_reply: val.messages.some((m) => m.type === 'inbox'),
          automation_type: val.automation_type || null,
        });
      });

      convList.sort((a, b) => new Date(b.last_message.created_at).getTime() - new Date(a.last_message.created_at).getTime());

      // Show conversations IMMEDIATELY (before lead details load)
      setConversations(convList);
      setConversationsLoading(false);
      setPagination({
        limit: json.limit || 200,
        offset: json.offset || 0,
        total: json.total || messages.length,
        has_more: json.has_more || false,
      });

      // Hydrate lead details in the background (non-blocking)
      const uniqueLeadUuids = [...new Set(convList.map((c) => c.lead_uuid).filter(Boolean))];
      hydrateLeads(uniqueLeadUuids, token);

    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : 'Failed to load conversations');
      setConversationsLoading(false);
    }
  }, [hydrateLeads, automationFilter]);

  const fetchThreadMessages = useCallback(async (conversationUuid: string, offset = 0) => {
    try {
      setThreadLoading(true);
      setThreadError(null);
      const token = await getValidAccessToken();
      if (!token) throw new Error('Not authenticated');

      const params = new URLSearchParams({
        limit: '100',
        offset: String(offset),
        order_field: 'created_at',
        order_type: 'asc',
        'filter[linkedin_conversation_uuid]': conversationUuid,
      });

      const res = await fetch(`/api/linkedin-conversations?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to fetch thread (${res.status})`);
      }

      const json = await res.json();
      const messages: LinkedInMessage[] = json.data || [];

      if (offset === 0) {
        setThreadMessages(messages);
      } else {
        setThreadMessages((prev) => [...prev, ...messages]);
      }

      // Auto-detect sender profile from thread outbox messages if not already set
      const outboxMsg = messages.find((m) => m.type === 'outbox' && m.sender_profile_uuid);
      if (outboxMsg?.sender_profile_uuid) {
        setSelectedSenderProfile((prev) => prev || outboxMsg.sender_profile_uuid!);
      }

      setThreadPagination({
        limit: json.limit || 100,
        offset: json.offset || 0,
        total: json.total || messages.length,
        has_more: json.has_more || false,
      });
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Failed to load thread');
    } finally {
      setThreadLoading(false);
    }
  }, []);

  const fetchCompanyInfo = useCallback(async (companyUuid: string) => {
    // Check cache first
    if (companyCacheRef.current[companyUuid]) {
      setCompanyInfo(companyCacheRef.current[companyUuid]);
      return;
    }

    try {
      setCompanyLoading(true);
      const token = await getValidAccessToken();
      if (!token) return;

      const res = await fetch(`/api/linkedin-conversations/companies?uuid=${encodeURIComponent(companyUuid)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const json = await res.json();
        const company: CompanyInfo = json.company || json;
        companyCacheRef.current[companyUuid] = company;
        setCompanyInfo(company);
      }
    } catch (err) {
      console.error('Failed to fetch company info:', err);
    } finally {
      setCompanyLoading(false);
    }
  }, []);

  const handleMakePpt = useCallback(async (lead: LeadInfo, company: CompanyInfo | null) => {
    const TEMPLATE_URL = 'https://docs.google.com/presentation/d/1_Fnoq1loiBkKgp3s8WQQBIK_6pJBBYiMMtdavmS6T34/edit';

    setPptLoading(true);
    setPptError(null);
    setPptUrl(null);

    try {
      // Verify the user has an active session before calling edge functions
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData?.session) {
        throw new Error('You must be signed in to generate a presentation. Please refresh the page and sign in again.');
      }

      const fullName = getLeadDisplayName(lead);
      const firstName = lead.first_name || fullName.split(/\s+/)[0] || '';
      const followUp = getFollowUpDate();

      const data: Record<string, unknown> = {
        // Same variables used in Message Templates
        name: fullName,
        cleaned_name: firstName,
        cleanedName: firstName,
        first_name: firstName,
        firstName: firstName,
        last_name: lead.last_name || '',
        lastName: lead.last_name || '',
        company_name: company?.name || lead.company_name || '',
        companyName: company?.name || lead.company_name || '',
        position: lead.position || '',
        headline: lead.headline || '',
        company_industry: company?.industry || '',
        companyIndustry: company?.industry || '',
        followUpFullDate: followUp.fullDate,
        followUpWeekdayDate: followUp.weekdayDate,
        followUpShortDay: followUp.shortDay,
        followUpRelativeDay: followUp.relativeDay,
        followUpRelativeShortDay: followUp.relativeShortDay,
        followUpDateOnly: followUp.dateOnly,

        // Additional contact & company fields
        // contact_email: lead.work_email || lead.personal_email || '',
        // work_email: lead.work_email || '',
        // personal_email: lead.personal_email || '',
        // contact_phone: lead.work_phone_number || lead.personal_phone_number || '',
        // work_phone: lead.work_phone_number || '',
        // personal_phone: lead.personal_phone_number || '',
        // contact_linkedin: lead.linkedin || '',
        // contact_location: lead.raw_address ||
        //   [lead.location?.city, lead.location?.region, lead.location?.country].filter(Boolean).join(', ') || '',
        company_domain: company?.domain || '',
        company_website: company?.website || '',
        // company_employees: company?.employees_range || '',
        company_tagline: company?.tagline || '',
        // company_about: company?.about || '',
        // company_phone: company?.phone || '',
        company_hq: company?.hq_location?.address_string ||
          [company?.hq_location?.city, company?.hq_location?.region, company?.hq_location?.country].filter(Boolean).join(', ') ||
          company?.hq_raw_address || '',
        // company_linkedin: company?.linkedin || '',
        // company_specialities: company?.specialities?.join(', ') || '',
      };

      const companyName = data.company_name;
      const personName = fullName;
      const copyName = companyName
        ? `CapitalxAI - ${companyName}`
        : `CapitalxAI - ${personName}`;

      const hasCompanyDetails = !!(company?.about || company?.tagline || company?.name);

      const buildCompanyDescription = (): string => {
        const parts: string[] = [];
        if (company?.name) parts.push(`Company: ${company.name}`);
        if (company?.tagline) parts.push(`Tagline: ${company.tagline}`);
        if (company?.about) parts.push(`About: ${company.about}`);
        if (company?.industry) parts.push(`Industry: ${company.industry}`);
        if (company?.specialities?.length) parts.push(`Specialities: ${company.specialities.join(', ')}`);
        if (company?.employees_range) parts.push(`Employees: ${company.employees_range}`);
        if (company?.year_established) parts.push(`Founded: ${company.year_established}`);
        if (company?.website) parts.push(`Website: ${company.website}`);
        const hq = company?.hq_location?.address_string ||
          [company?.hq_location?.city, company?.hq_location?.region, company?.hq_location?.country].filter(Boolean).join(', ') ||
          company?.hq_raw_address;
        if (hq) parts.push(`HQ: ${hq}`);
        if (lead.position) parts.push(`Contact Position: ${lead.position}`);
        if (lead.headline) parts.push(`Contact Headline: ${lead.headline}`);
        return parts.join('\n');
      };

      const duplicatePromise = duplicateTemplate({
        supabaseClient: supabase,
        templateUrl: TEMPLATE_URL,
        copyName,
      });

      const analyzePromise = hasCompanyDetails
        ? fetch('/api/linkedin-conversations/analyze-company', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ company_description: buildCompanyDescription() }),
          })
            .then(res => res.ok ? res.json() : null)
            .catch(() => null)
        : Promise.resolve(null);

      const [dupResult, analysisResult] = await Promise.all([duplicatePromise, analyzePromise]);

      if (analysisResult && !analysisResult.error) {
        for (const [key, value] of Object.entries(analysisResult)) {
          if (Array.isArray(value)) {
            data[key] = value;
            value.forEach((item, i) => {
              if (typeof item === 'string') {
                data[`${key}_${i + 1}`] = item;
              }
            });
          } else {
            data[key] = value;
          }
        }
      }

      const result = await replaceInPresentation({
        supabaseClient: supabase,
        presentationId: dupResult.presentationId,
        presentationUrl: dupResult.presentationUrl,
        data,
        accessToken: dupResult.accessToken,
        imageIdentifier: 'company_logo',
        faviconUrl: company?.logo_url || '',
      });

      setPptUrl(result.presentationUrl);
      window.open(result.presentationUrl, '_blank');
    } catch (err: unknown) {
      console.error('Make PPT failed:', err);
      if (err instanceof TypeError && err.message === 'Failed to fetch') {
        setPptError('Network error — please check your internet connection and try again.');
      } else {
        setPptError(err instanceof Error ? err.message : 'An unexpected error occurred while generating the presentation.');
      }
    } finally {
      setPptLoading(false);
    }
  }, []);

  const fetchSenderProfiles = useCallback(async () => {
    try {
      const token = await getValidAccessToken();
      if (!token) return;

      // Fetch all sender profiles (paginate through all pages)
      let allProfiles: SenderProfile[] = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`/api/linkedin-conversations/sender-profiles?limit=${limit}&offset=${offset}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) break;

        const json = await res.json();
        const profiles: SenderProfile[] = json.data || [];
        allProfiles = allProfiles.concat(profiles);
        hasMore = json.has_more || false;
        offset += limit;
      }

      setSenderProfiles(allProfiles);
    } catch (err) {
      console.error('Failed to fetch sender profiles:', err);
    }
  }, []);

  const fetchAutomations = useCallback(async () => {
    try {
      const token = await getValidAccessToken();
      if (!token) return;

      let allFlows: AutomationInfo[] = [];
      let offset = 0;
      const limit = 200;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`/api/linkedin-conversations/automations?limit=${limit}&offset=${offset}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) break;
        const json = await res.json();
        const flows: AutomationInfo[] = json.data || [];
        allFlows = allFlows.concat(flows);
        hasMore = json.has_more || false;
        offset += limit;
      }

      const map: Record<string, AutomationInfo> = {};
      for (const f of allFlows) {
        map[f.uuid] = f;
      }
      setAutomationsMap(map);
    } catch (err) {
      console.error('Failed to fetch automations:', err);
    }
  }, []);

  const fetchLists = useCallback(async () => {
    try {
      const token = await getValidAccessToken();
      if (!token) return;

      let allLists: ListInfo[] = [];
      let offset = 0;
      const limit = 200;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`/api/linkedin-conversations/lists?limit=${limit}&offset=${offset}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) break;
        const json = await res.json();
        const lists: ListInfo[] = json.data || [];
        allLists = allLists.concat(lists);
        hasMore = json.has_more || false;
        offset += limit;
      }

      const map: Record<string, ListInfo> = {};
      for (const l of allLists) {
        map[l.uuid] = l;
      }
      setListsMap(map);
    } catch (err) {
      console.error('Failed to fetch lists:', err);
    }
  }, []);

  const fetchTags = useCallback(async () => {
    try {
      const token = await getValidAccessToken();
      if (!token) return;

      let allTags: { uuid: string; name: string }[] = [];
      let offset = 0;
      const limit = 200;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`/api/linkedin-conversations/tags?limit=${limit}&offset=${offset}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) break;
        const json = await res.json();
        const tags: { uuid: string; name: string }[] = json.data || [];
        allTags = allTags.concat(tags);
        hasMore = json.has_more || false;
        offset += limit;
      }

      const map: Record<string, string> = {};
      for (const t of allTags) {
        map[t.uuid] = t.name;
      }
      setTagsMap(map);
    } catch (err) {
      console.error('Failed to fetch tags:', err);
    }
  }, []);

  // Search contacts by name/company and fetch their LinkedIn conversations
  const searchContacts = useCallback(async (query: string, listUuid?: string, tagUuid?: string) => {
    if (!query.trim()) return;
    try {
      setContactSearchLoading(true);
      setContactSearchError(null);
      setContactSearchResults([]);
      setContactSearchConversations([]);
      setContactSearchTruncated(false);

      const token = await getValidAccessToken();
      if (!token) throw new Error('Not authenticated');

      const payload: Record<string, unknown> = { query: query.trim() };
      if (listUuid) payload.list_uuid = listUuid;
      if (tagUuid) payload.tag_uuid = tagUuid;

      const res = await fetch('/api/linkedin-conversations/search-contacts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Search failed (${res.status})`);
      }

      const json = await res.json();
      const contacts: LeadInfo[] = json.contacts || [];
      setContactSearchResults(contacts);

      // Build contact lookup for hydrating conversations
      const contactLookup: Record<string, LeadInfo> = {};
      for (const c of contacts) {
        contactLookup[c.uuid] = c;
      }

      // Map conversation results to our Conversation type
      const convos: Conversation[] = (json.conversations || []).map(
        (c: {
          linkedin_conversation_uuid: string;
          lead_uuid: string;
          last_message: LinkedInMessage;
          message_count: number;
          sender_profile_uuid?: string;
          has_unread: boolean;
        }) => ({
          ...c,
          lead: contactLookup[c.lead_uuid] || null,
          automation_type: null,
        })
      );
      setContactSearchConversations(convos);
      setContactSearchTruncated(json.truncated || false);
    } catch (err) {
      setContactSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setContactSearchLoading(false);
    }
  }, []);

  // Fetch outreach stages for a set of conversations
  const fetchStages = useCallback(async (convos: Conversation[]) => {
    try {
      const token = await getValidAccessToken();
      if (!token) return;

      // Build pairs from conversations (need both lead_uuid and sender_profile_uuid)
      const pairs = convos
        .filter((c) => c.lead_uuid && c.sender_profile_uuid)
        .map((c) => ({ lead_uuid: c.lead_uuid, sender_profile_id: c.sender_profile_uuid! }));

      if (pairs.length === 0) return;

      const res = await fetch('/api/linkedin-conversations/stages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pairs }),
      });

      if (res.ok) {
        const json = await res.json();
        setStagesMap(json.stages || {});
      }
    } catch (err) {
      console.error('Failed to fetch stages:', err);
    }
  }, []);

  // Update (upsert) a stage for a lead/sender pair
  const updateStage = useCallback(async (leadUuid: string, senderProfileId: string, stage: string) => {
    const key = `${leadUuid}::${senderProfileId}`;
    setStageUpdating(key);
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch('/api/linkedin-conversations/stages', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lead_uuid: leadUuid, sender_profile_id: senderProfileId, stage }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update stage');
      }

      // Optimistically update local state
      setStagesMap((prev) => ({ ...prev, [key]: stage }));
    } catch (err) {
      console.error('Failed to update stage:', err);
    } finally {
      setStageUpdating(null);
    }
  }, []);

  const resizeTextarea = useCallback(() => {
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 128) + 'px';
      }
    }, 0);
  }, []);

  const sendReply = useCallback(async () => {
    if (!replyText.trim() || !selectedConversation || replySending) return;

    try {
      setReplySending(true);
      setReplyError(null);
      setReplySuccess(false);
      const token = await getValidAccessToken();
      if (!token) throw new Error('Not authenticated');

      const body: Record<string, string> = {
        lead_uuid: selectedConversation.lead_uuid,
        text: replyText.trim(),
      };
      if (selectedSenderProfile) {
        body.sender_profile_uuid = selectedSenderProfile;
      }

      const res = await fetch('/api/linkedin-conversations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to send message (${res.status})`);
      }

      const sentMessage = await res.json();
      setReplyText('');
      resizeTextarea();
      // Clear draft for this conversation
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[selectedConversation.linkedin_conversation_uuid];
        return next;
      });
      setReplySuccess(true);
      setTimeout(() => setReplySuccess(false), 3000);

      // Add the sent message to thread
      const newMsg: LinkedInMessage = {
        uuid: sentMessage.uuid || sentMessage.data?.uuid || `temp-${Date.now()}`,
        linkedin_conversation_uuid: selectedConversation.linkedin_conversation_uuid,
        lead_uuid: selectedConversation.lead_uuid,
        sender_profile_uuid: selectedSenderProfile,
        type: 'outbox',
        text: replyText.trim(),
        status: sentMessage.status || 'sent',
        created_at: sentMessage.created_at || new Date().toISOString(),
        sent_at: sentMessage.sent_at || new Date().toISOString(),
      };

      setThreadMessages((prev) => [...prev, newMsg]);

      // Update conversation list
      setConversations((prev) =>
        prev.map((c) =>
          c.linkedin_conversation_uuid === selectedConversation.linkedin_conversation_uuid
            ? { ...c, last_message: newMsg, message_count: c.message_count + 1 }
            : c
        )
      );
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setReplySending(false);
    }
  }, [replyText, selectedConversation, selectedSenderProfile, replySending]);

  const generateReply = useCallback(async () => {
    if (!selectedConversation || generatingReply) return;

    try {
      setGeneratingReply(true);
      setGenerateError(null);

      const token = await getValidAccessToken();
      if (!token) {
        setGenerateError('Not authenticated');
        return;
      }

      // Build conversation history from the last 20 messages
      const recentMessages = threadMessages.slice(-20);
      const conversationHistory = recentMessages
        .map((msg) => {
          const sender = msg.type === 'inbox' ? 'Prospect' : 'You';
          return `${sender}: ${msg.text || '(No content)'}`;
        })
        .join('\n');

      // The latest inbound message from the prospect
      const lastInboxMsg = [...recentMessages].reverse().find((m) => m.type === 'inbox');
      const userMessage =
        lastInboxMsg?.text ||
        recentMessages[recentMessages.length - 1]?.text ||
        '(No new message from prospect)';

      const res = await fetch('/api/linkedin-conversations/generate-reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversation_history: conversationHistory,
          user_message: userMessage,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to generate reply (${res.status})`);
      }

      const data = await res.json();

      // Auto-update stage if AI returned one
      if (data.stage && selectedConversation.lead_uuid && selectedConversation.sender_profile_uuid) {
        updateStage(selectedConversation.lead_uuid, selectedConversation.sender_profile_uuid, data.stage);
      }

      if (data.action === 'handover') {
        setGenerateError('AI suggests handing over this conversation to a human team member.');
        return;
      }

      if (data.message) {
        setReplyText(data.message);
        // Save as draft
        setDrafts((prev) => ({ ...prev, [selectedConversation.linkedin_conversation_uuid]: data.message }));
        resizeTextarea();
        setTimeout(() => textareaRef.current?.focus(), 50);
      } else {
        setGenerateError('AI returned an empty reply.');
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate reply');
    } finally {
      setGeneratingReply(false);
    }
  }, [selectedConversation, threadMessages, generatingReply, updateStage]);

  /* ────────────────── Effects ────────────────── */

  // Fetch messages (re-runs automatically when automationFilter changes)
  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Load sender profiles, automations, and lists once on mount
  useEffect(() => {
    fetchSenderProfiles();
  }, [fetchSenderProfiles]);

  useEffect(() => {
    fetchAutomations();
  }, [fetchAutomations]);

  useEffect(() => {
    fetchLists();
  }, [fetchLists]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  // Fetch stages when conversations are loaded
  useEffect(() => {
    if (conversations.length > 0) {
      fetchStages(conversations);
    }
  }, [conversations.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom when new messages appear
  useEffect(() => {
    if (threadMessages.length > 0) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [threadMessages]);

  // Focus textarea when entering thread view
  useEffect(() => {
    if (selectedConversation) {
      setTimeout(() => textareaRef.current?.focus(), 200);
    }
  }, [selectedConversation]);

  // Close template picker on outside click
  useEffect(() => {
    if (!showTemplatePicker) return;
    const handler = (e: MouseEvent) => {
      if (templatePickerRef.current && !templatePickerRef.current.contains(e.target as Node)) {
        setShowTemplatePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTemplatePicker]);

  /* ────────────────── Handlers ────────────────── */

  const openConversation = (conv: Conversation) => {
    // Save current reply text as draft before switching
    if (selectedConversation && replyText.trim()) {
      setDrafts((prev) => ({ ...prev, [selectedConversation.linkedin_conversation_uuid]: replyText }));
    } else if (selectedConversation && !replyText.trim()) {
      // Clear empty draft
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[selectedConversation.linkedin_conversation_uuid];
        return next;
      });
    }

    setSelectedConversation(conv);
    setThreadMessages([]);
    // Load draft for this conversation (if any)
    setReplyText(drafts[conv.linkedin_conversation_uuid] || '');
    resizeTextarea();
    setReplyError(null);
    setReplySuccess(false);
    setGenerateError(null);
    setShowContactDetails(false);
    setCompanyInfo(null);
    // Auto-select the sender profile that was used in this conversation
    if (conv.sender_profile_uuid) {
      setSelectedSenderProfile(conv.sender_profile_uuid);
    }
    fetchThreadMessages(conv.linkedin_conversation_uuid);
  };

  const closeThread = () => {
    // Save current reply as draft before closing
    if (selectedConversation && replyText.trim()) {
      setDrafts((prev) => ({ ...prev, [selectedConversation.linkedin_conversation_uuid]: replyText }));
    } else if (selectedConversation && !replyText.trim()) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[selectedConversation.linkedin_conversation_uuid];
        return next;
      });
    }
    setSelectedConversation(null);
    setThreadMessages([]);
    setThreadError(null);
    setShowContactDetails(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  };

  // Helper: does a conversation have unread messages (per GetSales markers on the lead)
  const conversationHasUnread = useCallback((conv: Conversation): boolean => {
    const markers = conv.lead?.markers;
    if (!markers || !Array.isArray(markers) || markers.length === 0) return false;
    const senderUuid = conv.sender_profile_uuid;
    const marker = senderUuid
      ? markers.find((m) => m.sender_profile_uuid === senderUuid)
      : markers.find((m) => m.sender_profile_uuid);
    if (!marker) return false;
    const inboxCount = typeof marker.linkedin_messages_inbox_count === 'number' ? marker.linkedin_messages_inbox_count : 0;
    const readCount = typeof marker.linkedin_read_count === 'number' ? marker.linkedin_read_count : 0;
    return inboxCount > readCount;
  }, []);

  // Access-controlled conversations: only show conversations linked to the user's allowed sender profiles
  const allowedSenderUuids = useMemo(() => {
    if (senderProfiles.length === 0) return null; // profiles not loaded yet, show all
    return new Set(senderProfiles.map((p) => p.uuid));
  }, [senderProfiles]);

  const accessFilteredConversations = useMemo(() => {
    if (!allowedSenderUuids) return conversations;
    return conversations.filter(
      (c) => c.sender_profile_uuid && allowedSenderUuids.has(c.sender_profile_uuid)
    );
  }, [conversations, allowedSenderUuids]);

  // Filtered conversations (applies on top of access filter)
  const filteredConversations = useMemo(() => {
    let result = accessFilteredConversations;
    if (showUnrepliedOnly) {
      result = result.filter((c) => c.has_unread);
    }
    if (showUnreadOnly) {
      result = result.filter((c) => conversationHasUnread(c));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) => {
        const name = getLeadDisplayName(c.lead).toLowerCase();
        const company = c.lead?.company_name?.toLowerCase() || '';
        const lastMsg = c.last_message.text?.toLowerCase() || '';
        return name.includes(q) || company.includes(q) || lastMsg.includes(q);
      });
    }
    return result;
  }, [accessFilteredConversations, searchQuery, showUnrepliedOnly, showUnreadOnly, conversationHasUnread]);

  // Counts for filter badges (based on access-filtered conversations)
  const unrepliedCount = useMemo(() => accessFilteredConversations.filter((c) => c.has_unread).length, [accessFilteredConversations]);
  const unreadCount = useMemo(() => accessFilteredConversations.filter((c) => conversationHasUnread(c)).length, [accessFilteredConversations, conversationHasUnread]);

  // Keep refs in sync for use inside async bulk generation
  filteredConversationsRef.current = filteredConversations;
  accessFilteredConversationsRef.current = accessFilteredConversations;
  draftsRef.current = drafts;

  // Fetch thread messages for a given conversation (returns the messages array directly)
  const fetchThreadMessagesForBulk = useCallback(async (conversationUuid: string, token: string): Promise<LinkedInMessage[]> => {
    const params = new URLSearchParams({
      limit: '100',
      offset: '0',
      order_field: 'created_at',
      order_type: 'asc',
      'filter[linkedin_conversation_uuid]': conversationUuid,
    });

    const res = await fetch(`/api/linkedin-conversations?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  }, []);

  const generateAllReplies = useCallback(async (scope: 'filtered' | 'all') => {
    if (bulkGenerating) return;

    // Read from refs to get the latest values at call time (avoids stale closures)
    const targetConversations = scope === 'filtered'
      ? filteredConversationsRef.current
      : accessFilteredConversationsRef.current;
    if (targetConversations.length === 0) return;

    bulkAbortRef.current = false;
    setBulkGenerating(true);
    setBulkProgress(0);
    setBulkTotal(targetConversations.length);
    setBulkErrors(0);

    let errorCount = 0;

    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error('Not authenticated');

      for (let i = 0; i < targetConversations.length; i++) {
        if (bulkAbortRef.current) break;

        const conv = targetConversations[i];

        // Skip if already has a draft (read latest from ref)
        if (draftsRef.current[conv.linkedin_conversation_uuid]) {
          setBulkProgress(i + 1);
          continue;
        }

        try {
          const messages = await fetchThreadMessagesForBulk(conv.linkedin_conversation_uuid, token);
          if (messages.length === 0) {
            setBulkProgress(i + 1);
            continue;
          }

          const recentMessages = messages.slice(-20);
          const conversationHistory = recentMessages
            .map((msg) => {
              const sender = msg.type === 'inbox' ? 'Prospect' : 'You';
              return `${sender}: ${msg.text || '(No content)'}`;
            })
            .join('\n');

          const lastInboxMsg = [...recentMessages].reverse().find((m) => m.type === 'inbox');
          const userMessage =
            lastInboxMsg?.text ||
            recentMessages[recentMessages.length - 1]?.text ||
            '(No new message from prospect)';

          const res = await fetch('/api/linkedin-conversations/generate-reply', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              conversation_history: conversationHistory,
              user_message: userMessage,
            }),
          });

          if (res.ok) {
            const data = await res.json();
            if (data.action === 'reply' && data.message) {
              setDrafts((prev) => ({ ...prev, [conv.linkedin_conversation_uuid]: data.message }));
            }
            if (data.stage && conv.lead_uuid && conv.sender_profile_uuid) {
              updateStage(conv.lead_uuid, conv.sender_profile_uuid, data.stage);
            }
          } else {
            errorCount++;
            setBulkErrors(errorCount);
          }
        } catch {
          errorCount++;
          setBulkErrors(errorCount);
        }

        setBulkProgress(i + 1);
      }
    } catch (err) {
      console.error('Bulk generation error:', err);
    } finally {
      setBulkGenerating(false);
    }
  }, [bulkGenerating, fetchThreadMessagesForBulk, updateStage]);

  const stopBulkGeneration = useCallback(() => {
    bulkAbortRef.current = true;
  }, []);

  // Active lead: stays reactive to conversations state updates (lead hydration)
  const activeLead = useMemo(() => {
    if (!selectedConversation) return null;
    const conv = conversations.find(
      (c) => c.linkedin_conversation_uuid === selectedConversation.linkedin_conversation_uuid
    );
    return conv?.lead || selectedConversation.lead || null;
  }, [selectedConversation, conversations]);

  const copyProspectForHubSpot = useCallback(() => {
    if (!activeLead) return;
    const lead = activeLead;
    const name = getLeadDisplayName(lead);
    const stageKey = selectedConversation?.sender_profile_uuid
      ? `${selectedConversation.lead_uuid}::${selectedConversation.sender_profile_uuid}`
      : '';
    const stageValue = stageKey
      ? stagesMap[stageKey] || (selectedConversation?.has_prospect_reply ? 'reply_received' : 'attempted_to_contact')
      : '';
    const stageLabel = stageValue ? getStageOption(stageValue).label : '';

    const lines: string[] = [];
    lines.push('Create / Update Contact');
    lines.push('');
    lines.push(`Name: ${name}`);
    if (lead.first_name) lines.push(`First Name: ${lead.first_name}`);
    if (lead.last_name) lines.push(`Last Name: ${lead.last_name}`);
    if (lead.position) lines.push(`Job Title: ${lead.position}`);
    if (lead.company_name) lines.push(`Company: ${lead.company_name}`);
    if (lead.work_email) lines.push(`Work Email: ${lead.work_email}`);
    if (lead.personal_email) lines.push(`Personal Email: ${lead.personal_email}`);
    if (lead.work_phone_number) lines.push(`Work Phone: ${lead.work_phone_number}`);
    if (lead.personal_phone_number) lines.push(`Personal Phone: ${lead.personal_phone_number}`);
    if (lead.linkedin) {
      const url = lead.linkedin.startsWith('http') ? lead.linkedin : `https://linkedin.com/in/${lead.linkedin}`;
      lines.push(`LinkedIn: ${url}`);
    }
    const loc = [lead.location?.city, lead.location?.region, lead.location?.country].filter(Boolean).join(', ') || lead.raw_address;
    if (loc) lines.push(`Location: ${loc}`);
    if (lead.headline) lines.push(`Headline: ${lead.headline}`);
    if (stageLabel) lines.push(`Stage: ${stageLabel}`);

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopiedContact(true);
      setTimeout(() => setCopiedContact(false), 2000);
    });
  }, [activeLead, selectedConversation, stagesMap]);

  const fillTemplateVariables = useCallback((templateStr: string): string => {
    const lead = activeLead ?? selectedConversation?.lead;
    const fullName = getLeadDisplayName(lead);
    const firstName = lead?.first_name || fullName.split(/\s+/)[0] || '';

    const followUp = getFollowUpDate();

    const variables: Record<string, string> = {
      name: fullName,
      cleaned_name: firstName,
      cleanedName: firstName,
      first_name: firstName,
      firstName: firstName,
      last_name: lead?.last_name || '',
      lastName: lead?.last_name || '',
      company_name: lead?.company_name || '',
      companyName: lead?.company_name || '',
      position: lead?.position || '',
      headline: lead?.headline || '',
      company_industry: companyInfo?.industry || '',
      companyIndustry: companyInfo?.industry || '',
      followUpFullDate: followUp.fullDate,
      followUpWeekdayDate: followUp.weekdayDate,
      followUpShortDay: followUp.shortDay,
      followUpRelativeDay: followUp.relativeDay,
      followUpRelativeShortDay: followUp.relativeShortDay,
      followUpDateOnly: followUp.dateOnly,
    };

    return substituteVariables(templateStr, variables);
  }, [activeLead, selectedConversation, companyInfo]);

  // Fetch company info when contact panel opens
  useEffect(() => {
    if (showContactDetails && activeLead?.company_uuid && !companyInfo) {
      fetchCompanyInfo(activeLead.company_uuid as string);
    }
  }, [showContactDetails, activeLead, companyInfo, fetchCompanyInfo]);

  /* ────────────────── Pagination ────────────────── */

  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const totalPages = Math.ceil(pagination.total / pagination.limit) || 1;

  /* ────────────────── Render ────────────────── */

  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="h-screen flex flex-col bg-gray-50">
          {/* Header */}
          <div className="bg-white border-b border-gray-200 px-3 sm:px-6 py-2.5 sm:py-4 flex-shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                {selectedConversation && (
                  <button
                    onClick={closeThread}
                    className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors md:hidden flex-shrink-0"
                  >
                    <ArrowLeft className="w-5 h-5 text-gray-600" />
                  </button>
                )}
                <MessageSquare className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-600 flex-shrink-0" />
                <h1 className="text-base sm:text-xl font-bold text-gray-900 truncate">
                  <span className="hidden sm:inline">LinkedIn Conversations</span>
                  <span className="sm:hidden">Chats</span>
                </h1>
                {!conversationsLoading && (
                  <span className="text-xs sm:text-sm text-gray-500 flex-shrink-0">({filteredConversations.length})</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
                {/* Drafts count badge */}
                {Object.keys(drafts).length > 0 && (
                  <span className="flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg">
                    <FileText className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    <span>{Object.keys(drafts).length}</span>
                    <span className="hidden sm:inline">draft{Object.keys(drafts).length !== 1 ? 's' : ''}</span>
                  </span>
                )}

                {/* Bulk AI Generate button */}
                {!bulkGenerating ? (
                  <div className="relative inline-flex">
                    <button
                      onClick={() => generateAllReplies('filtered')}
                      disabled={conversationsLoading || filteredConversations.length === 0}
                      className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-white bg-gradient-to-br from-purple-500 to-indigo-600 rounded-l-lg hover:from-purple-600 hover:to-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
                    >
                      <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      <span className="hidden sm:inline">AI Reply All ({filteredConversations.length})</span>
                      <span className="sm:hidden">{filteredConversations.length}</span>
                    </button>
                    <button
                      onClick={() => generateAllReplies('all')}
                      disabled={conversationsLoading || accessFilteredConversations.length === 0}
                      title="Generate for all conversations (ignore filters)"
                      className="flex items-center px-1.5 sm:px-2 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-white bg-gradient-to-br from-purple-600 to-indigo-700 rounded-r-lg border-l border-white/20 hover:from-purple-700 hover:to-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
                    >
                      <ChevronDown className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-lg">
                      <Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" />
                      <span>{bulkProgress}/{bulkTotal}</span>
                      <div className="w-12 sm:w-20 h-1.5 bg-purple-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-600 rounded-full transition-all duration-300"
                          style={{ width: `${bulkTotal > 0 ? (bulkProgress / bulkTotal) * 100 : 0}%` }}
                        />
                      </div>
                      {bulkErrors > 0 && <span className="text-[10px] sm:text-xs text-red-500">{bulkErrors} err</span>}
                    </div>
                    <button
                      onClick={stopBulkGeneration}
                      className="flex items-center px-1.5 sm:px-2 py-1.5 sm:py-2 text-sm font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
                      title="Stop generation"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                    </button>
                  </div>
                )}

                <button
                  onClick={() => {
                    fetchMessages();
                    if (selectedConversation) {
                      fetchThreadMessages(selectedConversation.linkedin_conversation_uuid);
                    }
                  }}
                  disabled={conversationsLoading}
                  className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${conversationsLoading ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">Refresh</span>
                </button>
              </div>
            </div>
          </div>

          {/* Main Content: Split View */}
          <div className="flex-1 flex overflow-hidden">
            {/* Left Panel: Conversation List */}
            <div
              className={`${
                selectedConversation ? 'hidden md:flex' : 'flex'
              } flex-col w-full md:w-96 lg:w-[420px] border-r border-gray-200 bg-white flex-shrink-0`}
            >
              {/* Search + Unread filter */}
              <div className="px-4 py-3 border-b border-gray-100 space-y-2">
                {contactSearchMode ? (
                  <>
                    {/* Contact search input */}
                    <div className="relative">
                      <UserSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-teal-500" />
                      <input
                        type="text"
                        placeholder="Search by full name..."
                        value={contactSearchQuery}
                        onChange={(e) => setContactSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && contactSearchQuery.trim()) {
                            searchContacts(contactSearchQuery, contactSearchListFilter, contactSearchTagFilter);
                          }
                        }}
                        autoFocus
                        className="w-full pl-9 pr-20 py-2 text-sm border border-teal-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent bg-teal-50/30"
                      />
                      <button
                        onClick={() => contactSearchQuery.trim() && searchContacts(contactSearchQuery, contactSearchListFilter, contactSearchTagFilter)}
                        disabled={contactSearchLoading || !contactSearchQuery.trim()}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-teal-600 rounded-md hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {contactSearchLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                        Search
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <SearchableDropdown
                        value={contactSearchListFilter}
                        onChange={setContactSearchListFilter}
                        placeholder="All Lists"
                        icon={List}
                        options={Object.values(listsMap)
                          .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                          .map((l) => ({ value: l.uuid, label: l.name || l.uuid }))}
                      />
                      <SearchableDropdown
                        value={contactSearchTagFilter}
                        onChange={setContactSearchTagFilter}
                        placeholder="All Tags"
                        icon={Tag}
                        options={Object.entries(tagsMap)
                          .sort((a, b) => a[1].localeCompare(b[1]))
                          .map(([uuid, name]) => ({ value: uuid, label: name }))}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setContactSearchMode(false);
                          setContactSearchQuery('');
                          setContactSearchResults([]);
                          setContactSearchConversations([]);
                          setContactSearchError(null);
                          setContactSearchListFilter('');
                          setContactSearchTagFilter('');
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                      >
                        <ArrowLeft className="w-3 h-3" />
                        Back to conversations
                      </button>
                      {contactSearchResults.length > 0 && (
                        <span className="text-xs text-gray-500">
                          {contactSearchResults.length} contact{contactSearchResults.length !== 1 ? 's' : ''} · {contactSearchConversations.length} conversation{contactSearchConversations.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {contactSearchTruncated && (
                      <div className="px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                        <p className="text-[11px] text-amber-700">
                          Too many matches — try typing more of the name
                          {!contactSearchListFilter && !contactSearchTagFilter ? ' or narrow by list/tag' : ''}.
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search conversations..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-gray-50"
                      />
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => setContactSearchMode(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 transition-colors"
                      >
                        <UserSearch className="w-3 h-3" />
                        Search Contacts
                      </button>
                      <button
                        onClick={() => { setShowUnrepliedOnly(!showUnrepliedOnly); if (!showUnrepliedOnly) setShowUnreadOnly(false); }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                          showUnrepliedOnly
                            ? 'bg-indigo-600 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        <Filter className="w-3 h-3" />
                        Unreplied
                        {unrepliedCount > 0 && (
                          <span
                            className={`ml-0.5 px-1.5 py-0.5 text-[10px] font-bold rounded-full leading-none ${
                              showUnrepliedOnly ? 'bg-white/20 text-white' : 'bg-indigo-100 text-indigo-700'
                            }`}
                          >
                            {unrepliedCount}
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => { setShowUnreadOnly(!showUnreadOnly); if (!showUnreadOnly) setShowUnrepliedOnly(false); }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                          showUnreadOnly
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        <Mail className="w-3 h-3" />
                        Unread
                        {unreadCount > 0 && (
                          <span
                            className={`ml-0.5 px-1.5 py-0.5 text-[10px] font-bold rounded-full leading-none ${
                              showUnreadOnly ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-700'
                            }`}
                          >
                            {unreadCount}
                          </span>
                        )}
                      </button>

                      {/* Automation type filter */}
                      <div className="relative inline-flex items-center">
                        <Zap className={`absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none ${automationFilter ? 'text-white' : 'text-gray-400'}`} />
                        <select
                          value={automationFilter}
                          onChange={(e) => setAutomationFilter(e.target.value)}
                          className={`appearance-none pl-7 pr-7 py-1.5 text-xs font-medium rounded-full cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors ${
                            automationFilter
                              ? 'bg-purple-600 text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          <option value="">All Messages</option>
                          <option value="auto">Flow-Automated</option>
                          <option value="synced">Synced from LinkedIn</option>
                          <option value="is_not_null">All Non-Manual</option>
                          <option value="is_null">Manual Only</option>
                        </select>
                        <ChevronDown className={`absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none ${automationFilter ? 'text-white' : 'text-gray-400'}`} />
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Conversations List */}
              <div className="flex-1 overflow-y-auto">
                {contactSearchMode ? (
                  /* Contact search results */
                  contactSearchLoading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                      <Loader2 className="w-8 h-8 text-teal-500 animate-spin" />
                      <p className="text-sm text-gray-500">Searching contacts...</p>
                    </div>
                  ) : contactSearchError ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3 px-6">
                      <AlertCircle className="w-8 h-8 text-red-400" />
                      <p className="text-sm text-red-600 text-center">{contactSearchError}</p>
                    </div>
                  ) : contactSearchConversations.length > 0 ? (
                    contactSearchConversations.map((conv) => (
                      <button
                        key={conv.linkedin_conversation_uuid}
                        onClick={() => openConversation(conv)}
                        className={`w-full text-left px-4 py-3.5 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                          selectedConversation?.linkedin_conversation_uuid === conv.linkedin_conversation_uuid
                            ? 'bg-teal-50 border-l-2 border-l-teal-500'
                            : ''
                        } ${conv.has_unread ? 'bg-blue-50/40' : ''}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="relative flex-shrink-0">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-teal-400 to-emerald-500 flex items-center justify-center text-white font-semibold text-sm">
                              {conv.lead?.avatar_url ? (
                                <img
                                  src={conv.lead.avatar_url}
                                  alt=""
                                  className="w-10 h-10 rounded-full object-cover"
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).style.display = 'none';
                                    (e.target as HTMLImageElement).parentElement!.textContent = getLeadDisplayName(conv.lead).charAt(0).toUpperCase();
                                  }}
                                />
                              ) : (
                                getLeadDisplayName(conv.lead).charAt(0).toUpperCase()
                              )}
                            </div>
                            {conv.has_unread && (
                              <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-blue-500 border-2 border-white rounded-full" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-sm truncate ${conv.has_unread ? 'font-bold text-gray-900' : 'font-semibold text-gray-900'}`}>
                                {getLeadDisplayName(conv.lead)}
                              </span>
                              <span className={`text-xs whitespace-nowrap ${conv.has_unread ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>
                                {formatDate(conv.last_message.created_at)}
                              </span>
                            </div>
                            {conv.lead?.company_name && (
                              <p className="text-xs text-gray-500 truncate mt-0.5">{conv.lead.company_name}</p>
                            )}
                            {conv.lead?.position && (
                              <p className="text-[10px] text-gray-400 truncate">{conv.lead.position}</p>
                            )}
                            <div className="flex items-center gap-1.5 mt-1">
                              {conv.last_message.type === 'outbox' && (
                                <span className="text-xs text-indigo-500 font-medium">You:</span>
                              )}
                              <p className={`text-xs truncate ${conv.has_unread ? 'text-gray-700 font-medium' : 'text-gray-500'}`}>
                                {conv.last_message.text || '(No content)'}
                              </p>
                            </div>
                            <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 text-[9px] font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded">
                              <MessageSquare className="w-2.5 h-2.5" />
                              {conv.message_count} message{conv.message_count !== 1 ? 's' : ''}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))
                  ) : contactSearchQuery ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                      <Inbox className="w-10 h-10 text-gray-300" />
                      <p className="text-sm text-gray-500">No conversations found</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 gap-4 px-6">
                      <div className="w-16 h-16 rounded-full bg-teal-50 flex items-center justify-center">
                        <UserSearch className="w-8 h-8 text-teal-400" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-medium text-gray-700">Search for contacts</p>
                        <p className="text-xs text-gray-400 mt-1">
                          Enter a full name to find contacts with LinkedIn conversations
                        </p>
                      </div>
                    </div>
                  )
                ) : conversationsLoading ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                    <p className="text-sm text-gray-500">Loading conversations...</p>
                  </div>
                ) : conversationsError ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-3 px-6">
                    <AlertCircle className="w-8 h-8 text-red-400" />
                    <p className="text-sm text-red-600 text-center">{conversationsError}</p>
                    <button
                      onClick={() => fetchMessages()}
                      className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                    >
                      Try again
                    </button>
                  </div>
                ) : filteredConversations.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Inbox className="w-10 h-10 text-gray-300" />
                    <p className="text-sm text-gray-500">
                      {showUnrepliedOnly
                        ? 'No conversations awaiting your reply'
                        : showUnreadOnly
                        ? 'No unread conversations'
                        : searchQuery
                        ? 'No conversations match your search'
                        : automationFilter
                        ? 'No conversations for this automation filter'
                        : 'No conversations yet'}
                    </p>
                    {(showUnrepliedOnly || showUnreadOnly || automationFilter) && (
                      <button
                        onClick={() => { setShowUnrepliedOnly(false); setShowUnreadOnly(false); setAutomationFilter(''); }}
                        className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                      >
                        Show all conversations
                      </button>
                    )}
                  </div>
                ) : (
                  filteredConversations.map((conv) => (
                    <button
                      key={conv.linkedin_conversation_uuid}
                      onClick={() => openConversation(conv)}
                      className={`w-full text-left px-4 py-3.5 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                        selectedConversation?.linkedin_conversation_uuid === conv.linkedin_conversation_uuid
                          ? 'bg-indigo-50 border-l-2 border-l-indigo-500'
                          : ''
                      } ${conv.has_unread ? 'bg-blue-50/40' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        {/* Avatar with unread dot */}
                        <div className="relative flex-shrink-0">
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-semibold text-sm">
                            {conv.lead?.avatar_url ? (
                              <img
                                src={conv.lead.avatar_url}
                                alt=""
                                className="w-10 h-10 rounded-full object-cover"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                  (e.target as HTMLImageElement).parentElement!.textContent = getLeadDisplayName(conv.lead).charAt(0).toUpperCase();
                                }}
                              />
                            ) : (
                              getLeadDisplayName(conv.lead).charAt(0).toUpperCase()
                            )}
                          </div>
                          {conv.has_unread && (
                            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-blue-500 border-2 border-white rounded-full" />
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-sm truncate ${conv.has_unread ? 'font-bold text-gray-900' : 'font-semibold text-gray-900'}`}>
                              {getLeadDisplayName(conv.lead)}
                            </span>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {drafts[conv.linkedin_conversation_uuid] && (
                                <span className="px-1.5 py-0.5 text-[9px] font-bold text-amber-700 bg-amber-100 rounded leading-none">
                                  DRAFT
                                </span>
                              )}
                              <span className={`text-xs whitespace-nowrap ${conv.has_unread ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>
                                {formatDate(conv.last_message.created_at)}
                              </span>
                            </div>
                          </div>

                          {conv.lead?.company_name && (
                            <p className="text-xs text-gray-500 truncate mt-0.5">{conv.lead.company_name}</p>
                          )}

                          {/* Stage badge */}
                          {(() => {
                            const stageKey = conv.sender_profile_uuid ? `${conv.lead_uuid}::${conv.sender_profile_uuid}` : '';
                            const stageValue = stageKey ? stagesMap[stageKey] : undefined;
                            const defaultStage = conv.has_prospect_reply ? 'reply_received' : 'attempted_to_contact';
                            const stage = getStageOption(stageValue || defaultStage);
                            return (
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-semibold rounded border mt-0.5 ${stage.color}`}>
                                <ArrowDownUp className="w-2.5 h-2.5" />
                                {stage.label}
                              </span>
                            );
                          })()}

                          <div className="flex items-center gap-1.5 mt-1">
                            {conv.last_message.type === 'outbox' && (
                              <span className="text-xs text-indigo-500 font-medium">You:</span>
                            )}
                            <p className={`text-xs truncate ${conv.has_unread ? 'text-gray-700 font-medium' : 'text-gray-500'}`}>
                              {conv.last_message.text || '(No content)'}
                            </p>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>

              {/* Pagination */}
              {pagination.total > pagination.limit && (
                <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between bg-white">
                  <button
                    onClick={() => fetchMessages(Math.max(0, pagination.offset - pagination.limit))}
                    disabled={pagination.offset === 0 || conversationsLoading}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Prev
                  </button>
                  <span className="text-xs text-gray-500">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => fetchMessages(pagination.offset + pagination.limit)}
                    disabled={!pagination.has_more || conversationsLoading}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Right Panel: Thread View */}
            <div
              className={`${
                selectedConversation ? 'flex' : 'hidden md:flex'
              } flex-col flex-1 bg-gray-50`}
            >
              {!selectedConversation ? (
                /* Empty state */
                <div className="flex-1 flex flex-col items-center justify-center gap-4">
                  <div className="w-20 h-20 rounded-full bg-indigo-50 flex items-center justify-center">
                    <MessageSquare className="w-10 h-10 text-indigo-300" />
                  </div>
                  <div className="text-center">
                    <h2 className="text-lg font-semibold text-gray-700">Select a conversation</h2>
                    <p className="text-sm text-gray-500 mt-1">
                      Choose a conversation from the list to view messages
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Thread Header */}
                  <div className="bg-white border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3 flex-shrink-0 sticky top-0 z-10">
                    {/* Row 1: Back + avatar + name + contact info toggle */}
                    <div className="flex items-center gap-2 sm:gap-3">
                      <button
                        onClick={closeThread}
                        className="p-1 sm:p-1.5 rounded-lg hover:bg-gray-100 transition-colors block md:hidden flex-shrink-0"
                      >
                        <ArrowLeft className="w-5 h-5 text-gray-500" />
                      </button>

                      {/* Thread header avatar */}
                      <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-semibold text-xs sm:text-sm flex-shrink-0 overflow-hidden">
                        {activeLead?.avatar_url ? (
                          <img
                            src={activeLead.avatar_url}
                            alt=""
                            className="w-8 h-8 sm:w-9 sm:h-9 rounded-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          getLeadDisplayName(activeLead).charAt(0).toUpperCase()
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 text-xs sm:text-sm truncate">
                          {getLeadDisplayName(activeLead)}
                        </h3>
                        {(activeLead?.position || activeLead?.company_name) && (
                          <p className="text-[10px] sm:text-xs text-gray-500 truncate sm:line-clamp-2">
                            {activeLead.position && <span>{activeLead.position}</span>}
                            {activeLead.position && activeLead.company_name && <span className="text-gray-400"> at </span>}
                            {activeLead.company_name && <span>{activeLead.company_name}</span>}
                          </p>
                        )}
                      </div>

                      {/* Contact Info toggle - always visible */}
                      <button
                        onClick={() => setShowContactDetails(!showContactDetails)}
                        className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 text-xs font-medium rounded-lg transition-colors flex-shrink-0 ${
                          showContactDetails
                            ? 'text-indigo-700 bg-indigo-100'
                            : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                        }`}
                      >
                        <Info className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Contact Info</span>
                      </button>
                    </div>

                    {/* Row 2: Stage dropdown + Action buttons (side-by-side on lg) */}
                    <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between mt-2 gap-2">
                      {selectedConversation?.sender_profile_uuid && (
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[11px] font-medium text-gray-500 flex-shrink-0">Stage:</span>
                          <div className="relative inline-flex items-center">
                            <select
                              value={
                                stagesMap[`${selectedConversation.lead_uuid}::${selectedConversation.sender_profile_uuid}`] || (selectedConversation.has_prospect_reply ? 'reply_received' : 'attempted_to_contact')
                              }
                              onChange={(e) => {
                                updateStage(
                                  selectedConversation.lead_uuid,
                                  selectedConversation.sender_profile_uuid!,
                                  e.target.value
                                );
                              }}
                              disabled={stageUpdating === `${selectedConversation.lead_uuid}::${selectedConversation.sender_profile_uuid}`}
                              className={`appearance-none pl-3 pr-7 py-1 text-xs font-medium rounded-lg cursor-pointer border focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors ${
                                (() => {
                                  const val = stagesMap[`${selectedConversation.lead_uuid}::${selectedConversation.sender_profile_uuid}`] || (selectedConversation.has_prospect_reply ? 'reply_received' : 'attempted_to_contact');
                                  return getStageOption(val).color;
                                })()
                              } ${stageUpdating === `${selectedConversation.lead_uuid}::${selectedConversation.sender_profile_uuid}` ? 'opacity-50' : ''}`}
                            >
                              {STAGE_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none" />
                            {stageUpdating === `${selectedConversation.lead_uuid}::${selectedConversation.sender_profile_uuid}` && (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400 ml-2" />
                            )}
                          </div>
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto scrollbar-hide lg:ml-auto">
                      {activeLead?.linkedin && (
                        <a
                          href={
                            activeLead.linkedin.startsWith('http')
                              ? activeLead.linkedin
                              : `https://linkedin.com/in/${activeLead.linkedin}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 text-[11px] sm:text-xs font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors flex-shrink-0"
                        >
                          <ExternalLink className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                          LinkedIn
                        </a>
                      )}
                      {(activeLead?.work_email || activeLead?.personal_email) && (
                        <a
                          href={`mailto:${activeLead.work_email || activeLead.personal_email}`}
                          className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 text-[11px] sm:text-xs font-medium text-emerald-600 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition-colors flex-shrink-0"
                          title={activeLead.work_email || activeLead.personal_email}
                        >
                          <Mail className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                          Email
                        </a>
                      )}
                      {(activeLead?.work_phone_number || activeLead?.personal_phone_number) && (() => {
                        const phoneNumber = activeLead.work_phone_number || activeLead.personal_phone_number || '';
                        const cleanPhone = phoneNumber.replace(/[^+\d]/g, '');
                        return (
                          <>
                            <a
                              href={`tel:${cleanPhone}`}
                              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 text-[11px] sm:text-xs font-medium text-orange-600 bg-orange-50 rounded-lg hover:bg-orange-100 transition-colors flex-shrink-0"
                              title={phoneNumber}
                            >
                              <Phone className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                              Call
                            </a>
                            <a
                              href={`https://wa.me/${cleanPhone.replace('+', '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 sm:py-1.5 text-[11px] sm:text-xs font-medium text-green-600 bg-green-50 rounded-lg hover:bg-green-100 transition-colors flex-shrink-0"
                              title={`WhatsApp ${phoneNumber}`}
                            >
                              <MessageSquare className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                              WhatsApp
                            </a>
                          </>
                        );
                      })()}
                      </div>
                    </div>
                  </div>

                  {/* Content: Messages + optional Contact Panel */}
                  <div className="flex-1 flex overflow-hidden">
                  {/* Messages + Reply column */}
                  <div className={`flex-1 flex flex-col min-w-0 ${showContactDetails ? 'hidden lg:flex' : 'flex'}`}>
                  {/* Messages Area */}
                  <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                    {threadLoading && threadMessages.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                        <p className="text-sm text-gray-500">Loading messages...</p>
                      </div>
                    ) : threadError ? (
                      <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <AlertCircle className="w-8 h-8 text-red-400" />
                        <p className="text-sm text-red-600">{threadError}</p>
                        <button
                          onClick={() => fetchThreadMessages(selectedConversation.linkedin_conversation_uuid)}
                          className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                        >
                          Try again
                        </button>
                      </div>
                    ) : threadMessages.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <MessageSquare className="w-8 h-8 text-gray-300" />
                        <p className="text-sm text-gray-500">No messages in this conversation</p>
                      </div>
                    ) : (
                      <>
                        {/* Load more */}
                        {threadPagination.has_more && (
                          <div className="text-center">
                            <button
                              onClick={() =>
                                fetchThreadMessages(
                                  selectedConversation.linkedin_conversation_uuid,
                                  threadPagination.offset + threadPagination.limit
                                )
                              }
                              disabled={threadLoading}
                              className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                            >
                              Load older messages
                            </button>
                          </div>
                        )}

                        {threadMessages.map((msg) => {
                          const isOutbox = msg.type === 'outbox';
                          return (
                            <div
                              key={msg.uuid}
                              className={`flex items-end gap-2 ${isOutbox ? 'justify-end' : 'justify-start'}`}
                            >
                              {/* Inbox avatar */}
                              {!isOutbox && (
                                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-semibold text-[10px] flex-shrink-0 overflow-hidden">
                                  {activeLead?.avatar_url ? (
                                    <img
                                      src={activeLead.avatar_url}
                                      alt=""
                                      className="w-7 h-7 rounded-full object-cover"
                                      onError={(e) => {
                                        (e.target as HTMLImageElement).style.display = 'none';
                                      }}
                                    />
                                  ) : (
                                    getLeadDisplayName(activeLead).charAt(0).toUpperCase()
                                  )}
                                </div>
                              )}

                              <div
                                className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                                  isOutbox
                                    ? 'bg-indigo-600 text-white rounded-br-md'
                                    : 'bg-white text-gray-900 border border-gray-200 rounded-bl-md shadow-sm'
                                }`}
                              >
                                <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                                  {msg.text || '(No content)'}
                                </p>
                                <div
                                  className={`flex items-center gap-1.5 mt-1.5 ${
                                    isOutbox ? 'justify-end' : 'justify-start'
                                  }`}
                                >
                                  <span
                                    className={`text-[10px] ${
                                      isOutbox ? 'text-indigo-200' : 'text-gray-400'
                                    }`}
                                  >
                                    {formatFullDate(msg.created_at)}
                                  </span>
                                  {isOutbox && msg.status && (
                                    <>
                                      {msg.status === 'sent' || msg.status === 'delivered' || msg.status === 'done' ? (
                                        <CheckCircle2 className="w-3 h-3 text-indigo-200" />
                                      ) : msg.status === 'pending' || msg.status === 'queued' ? (
                                        <Clock className="w-3 h-3 text-indigo-200" />
                                      ) : null}
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        <div ref={threadEndRef} />
                      </>
                    )}
                  </div>

                  {/* Reply Box – only shown when user has sender profiles */}
                  {senderProfiles.length > 0 ? (
                  <div className="bg-white border-t border-gray-200 px-6 py-4 flex-shrink-0">
                    {/* Sender profile indicator */}
                    {selectedSenderProfile && senderProfiles.length > 0 && (() => {
                      const sp = senderProfiles.find((p) => p.uuid === selectedSenderProfile);
                      const spName = sp
                        ? [sp.first_name, sp.last_name].filter(Boolean).join(' ')
                        : null;
                      return (
                        <div className="mb-3 flex items-center gap-2">
                          {sp?.avatar_url && (
                            <img src={sp.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover" />
                          )}
                          <span className="text-xs text-gray-500">
                            Replying as <span className="font-medium text-gray-700">{spName || 'Unknown profile'}</span>
                          </span>
                        </div>
                      );
                    })()}

                    {replyError && (
                      <div className="mb-3 flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        {replyError}
                      </div>
                    )}

                    {generateError && (
                      <div className="mb-3 flex items-center gap-2 text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        {generateError}
                        <button onClick={() => setGenerateError(null)} className="ml-auto p-0.5 hover:bg-amber-100 rounded">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}

                    {replySuccess && (
                      <div className="mb-3 flex items-center gap-2 text-sm text-green-600 bg-green-50 px-3 py-2 rounded-lg">
                        <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                        Message sent successfully!
                      </div>
                    )}

                    <div className="flex items-end gap-3">
                      <button
                        onClick={generateReply}
                        disabled={generatingReply || threadMessages.length === 0}
                        title="Generate AI reply"
                        className="flex items-center justify-center gap-1.5 h-10 px-3 bg-gradient-to-br from-purple-500 to-indigo-600 text-white rounded-xl hover:from-purple-600 hover:to-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0 shadow-sm"
                      >
                        {generatingReply ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Sparkles className="w-4 h-4" />
                        )}
                        <span className="hidden sm:inline text-xs font-medium">AI Reply</span>
                      </button>
                      {/* Template picker */}
                      <div className="relative flex-shrink-0" ref={templatePickerRef}>
                        <button
                          onClick={() => {
                            setShowTemplatePicker((v) => !v);
                            if (!showTemplatePicker && templateChannels.length > 0 && !templatePickerTab) {
                              setTemplatePickerTab(templateChannels[0]);
                            }
                          }}
                          title="Use a message template"
                          className="flex items-center justify-center gap-1.5 h-10 px-3 border border-gray-200 bg-white text-gray-700 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm"
                        >
                          <FileText className="w-4 h-4" />
                          <span className="hidden sm:inline text-xs font-medium">Templates</span>
                        </button>
                        {showTemplatePicker && (
                          <div className="absolute bottom-full left-0 mb-2 w-80 max-h-72 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden flex flex-col">
                            <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
                              <span className="text-xs font-semibold text-gray-700">Message Templates</span>
                              <button onClick={() => setShowTemplatePicker(false)} className="p-0.5 hover:bg-gray-100 rounded">
                                <X className="w-3.5 h-3.5 text-gray-400" />
                              </button>
                            </div>
                            {templatesLoading ? (
                              <div className="flex items-center justify-center py-6">
                                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                <span className="ml-2 text-xs text-gray-400">Loading...</span>
                              </div>
                            ) : templateChannels.length === 0 ? (
                              <div className="px-3 py-6 text-center">
                                <FileText className="w-6 h-6 text-gray-300 mx-auto mb-2" />
                                <p className="text-xs text-gray-400">No templates found.</p>
                                <p className="text-[11px] text-gray-300 mt-1">Create templates on the Templates page.</p>
                              </div>
                            ) : (
                              <>
                                {templateChannels.length > 1 && (
                                  <div className="flex border-b border-gray-100 px-1 gap-0.5 bg-gray-50/60">
                                    {templateChannels.map((ch) => (
                                      <button
                                        key={ch}
                                        onClick={() => setTemplatePickerTab(ch)}
                                        className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors relative ${
                                          (templatePickerTab ?? templateChannels[0]) === ch
                                            ? 'text-indigo-700'
                                            : 'text-gray-500 hover:text-gray-700'
                                        }`}
                                      >
                                        {CHANNEL_LABELS[ch]}
                                        <span className="ml-1 text-[10px] text-gray-400">{templatesByChannel[ch]?.length}</span>
                                        {(templatePickerTab ?? templateChannels[0]) === ch && (
                                          <span className="absolute bottom-0 left-1 right-1 h-0.5 bg-indigo-600 rounded-full" />
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <div className="overflow-y-auto flex-1">
                                  {(templatesByChannel[templatePickerTab ?? templateChannels[0]] ?? []).map((tpl) => (
                                    <button
                                      key={tpl.id}
                                      onClick={() => {
                                        const filled = fillTemplateVariables(tpl.template);
                                        setReplyText(filled);
                                        if (selectedConversation) {
                                          setDrafts((prev) => ({ ...prev, [selectedConversation.linkedin_conversation_uuid]: filled }));
                                        }
                                        resizeTextarea();
                                        setShowTemplatePicker(false);
                                        setTimeout(() => textareaRef.current?.focus(), 50);
                                      }}
                                      className="w-full text-left px-3 py-2.5 hover:bg-indigo-50 transition-colors border-b border-gray-50 last:border-b-0 group"
                                    >
                                      <div className="text-xs font-medium text-gray-800 group-hover:text-indigo-700 truncate">{tpl.title}</div>
                                      <div className="text-[11px] text-gray-400 mt-0.5 line-clamp-2 leading-relaxed">{fillTemplateVariables(tpl.template)}</div>
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      <textarea
                        ref={textareaRef}
                        value={replyText}
                        onChange={(e) => {
                          setReplyText(e.target.value);
                          if (selectedConversation) {
                            const uuid = selectedConversation.linkedin_conversation_uuid;
                            if (e.target.value.trim()) {
                              setDrafts((prev) => ({ ...prev, [uuid]: e.target.value }));
                            } else {
                              setDrafts((prev) => {
                                const next = { ...prev };
                                delete next[uuid];
                                return next;
                              });
                            }
                          }
                        }}
                        onKeyDown={handleKeyDown}
                        placeholder="Type a message..."
                        rows={1}
                        className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none bg-gray-50 max-h-32"
                        style={{
                          minHeight: '42px',
                          maxHeight: '128px',
                          overflow: replyText.split('\n').length > 4 ? 'auto' : 'hidden',
                        }}
                        onInput={(e) => {
                          const target = e.target as HTMLTextAreaElement;
                          target.style.height = 'auto';
                          target.style.height = Math.min(target.scrollHeight, 128) + 'px';
                        }}
                      />
                      <button
                        onClick={sendReply}
                        disabled={!replyText.trim() || replySending}
                        className="flex items-center justify-center w-10 h-10 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                      >
                        {replySending ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  ) : (
                  <div className="bg-gray-50 border-t border-gray-200 px-6 py-3 flex-shrink-0">
                    <p className="text-xs text-gray-400 text-center">Sending is not available for this conversation</p>
                  </div>
                  )}
                  {/* end Messages + Reply column */}
                  </div>

                  {/* Contact Details Panel */}
                  {showContactDetails && activeLead && (
                    <div className="w-full lg:w-80 xl:w-96 border-l border-gray-200 bg-white overflow-y-auto overflow-x-hidden flex-shrink-0">
                      {/* Panel Header */}
                      <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between z-10">
                        <h4 className="font-semibold text-sm text-gray-900">Contact Details</h4>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={copyProspectForHubSpot}
                            title="Copy prospect details for HubSpot"
                            className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-lg transition-colors ${
                              copiedContact
                                ? 'text-green-700 bg-green-100'
                                : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                            }`}
                          >
                            {copiedContact ? <Check className="w-3.5 h-3.5" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
                            <span>{copiedContact ? 'Copied!' : 'Copy for HubSpot'}</span>
                          </button>
                          <button
                            onClick={() => setShowContactDetails(false)}
                            className="p-1 rounded-lg hover:bg-gray-100 transition-colors"
                          >
                            <X className="w-4 h-4 text-gray-500" />
                          </button>
                        </div>
                      </div>

                      <div className="px-5 py-4 space-y-5 overflow-hidden">
                        {/* Make PPT */}
                        <div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleMakePpt(activeLead, companyInfo)}
                              disabled={pptLoading}
                              title="Generate a presentation for this contact"
                              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors w-full justify-center ${
                                pptLoading
                                  ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
                                  : 'text-orange-700 bg-orange-50 hover:bg-orange-100 border border-orange-200'
                              }`}
                            >
                              {pptLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Presentation className="w-3.5 h-3.5" />
                              )}
                              {pptLoading ? 'Generating...' : 'Make PPT'}
                            </button>
                          </div>
                          {pptUrl && !pptError && (
                            <a
                              href={pptUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1.5 mt-2 px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors w-full justify-center"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                              Open Generated PPT
                            </a>
                          )}
                          {pptError && (
                            <div className="mt-2 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <p className="break-words">{pptError}</p>
                                <div className="flex items-center gap-3 mt-1.5">
                                  <button
                                    onClick={() => { setPptError(null); handleMakePpt(activeLead, companyInfo); }}
                                    className="text-[10px] font-medium text-red-600 hover:underline"
                                  >
                                    Retry
                                  </button>
                                  <button onClick={() => setPptError(null)} className="text-[10px] text-red-400 hover:underline">
                                    Dismiss
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                        {/* Profile card */}
                        <div className="flex items-center gap-3">
                          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-bold text-lg flex-shrink-0 overflow-hidden">
                            {activeLead.avatar_url ? (
                              <img src={activeLead.avatar_url} alt="" className="w-14 h-14 rounded-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            ) : (
                              getLeadDisplayName(activeLead).charAt(0).toUpperCase()
                            )}
                          </div>
                          <div className="min-w-0 overflow-hidden">
                            <p className="font-semibold text-gray-900 text-sm truncate">{getLeadDisplayName(activeLead)}</p>
                            {activeLead.position && (
                              <p className="text-xs text-gray-600 truncate">{activeLead.position}</p>
                            )}
                            {activeLead.company_name && (
                              <p className="text-xs text-gray-500 truncate">{activeLead.company_name}</p>
                            )}
                          </div>
                        </div>

                        {/* Headline */}
                        {activeLead.headline && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1">Headline</p>
                            <p className="text-xs text-gray-700 leading-relaxed break-words overflow-hidden">{activeLead.headline}</p>
                          </div>
                        )}

                        {/* About */}
                        {activeLead.about && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1">About</p>
                            <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-line max-h-40 overflow-y-auto">{activeLead.about}</p>
                          </div>
                        )}

                        {/* Contact Info */}
                        {(activeLead.work_email || activeLead.personal_email || activeLead.work_phone_number || activeLead.personal_phone_number) && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">Contact</p>
                            <div className="space-y-2">
                              {activeLead.work_email && (
                                <div className="flex items-center gap-2">
                                  <Mail className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                                  <a href={`mailto:${activeLead.work_email}`} className="text-xs text-indigo-600 hover:underline truncate">{activeLead.work_email}</a>
                                  <span className="text-[10px] text-gray-400">Work</span>
                                </div>
                              )}
                              {activeLead.personal_email && (
                                <div className="flex items-center gap-2">
                                  <Mail className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                                  <a href={`mailto:${activeLead.personal_email}`} className="text-xs text-indigo-600 hover:underline truncate">{activeLead.personal_email}</a>
                                  <span className="text-[10px] text-gray-400">Personal</span>
                                </div>
                              )}
                              {activeLead.work_phone_number && (
                                <div className="flex items-center gap-2">
                                  <Phone className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                                  <a href={`tel:${activeLead.work_phone_number}`} className="text-xs text-gray-700 hover:underline">{activeLead.work_phone_number}</a>
                                  <span className="text-[10px] text-gray-400">Work</span>
                                </div>
                              )}
                              {activeLead.personal_phone_number && (
                                <div className="flex items-center gap-2">
                                  <Phone className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                                  <a href={`tel:${activeLead.personal_phone_number}`} className="text-xs text-gray-700 hover:underline">{activeLead.personal_phone_number}</a>
                                  <span className="text-[10px] text-gray-400">Personal</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Location */}
                        {(activeLead.location?.country || activeLead.raw_address) && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">Location</p>
                            <div className="flex items-center gap-2">
                              <MapPin className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                              <span className="text-xs text-gray-700">
                                {[activeLead.location?.city, activeLead.location?.region, activeLead.location?.country].filter(Boolean).join(', ') || activeLead.raw_address}
                              </span>
                            </div>
                            {activeLead.location?.timezone && (
                              <div className="flex items-center gap-2 mt-1">
                                <Globe className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                                <span className="text-xs text-gray-500">{activeLead.location.timezone}</span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Social Links */}
                        {(activeLead.linkedin || activeLead.twitter || activeLead.facebook) && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">Social</p>
                            <div className="flex flex-wrap gap-2">
                              {activeLead.linkedin && (
                                <a
                                  href={activeLead.linkedin.startsWith('http') ? activeLead.linkedin : `https://linkedin.com/in/${activeLead.linkedin}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                                >
                                  <Linkedin className="w-3 h-3" />
                                  LinkedIn
                                </a>
                              )}
                              {activeLead.twitter && (
                                <a
                                  href={activeLead.twitter.startsWith('http') ? activeLead.twitter : `https://twitter.com/${activeLead.twitter}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-sky-600 bg-sky-50 rounded-md hover:bg-sky-100 transition-colors"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  Twitter
                                </a>
                              )}
                              {activeLead.facebook && (
                                <a
                                  href={activeLead.facebook.startsWith('http') ? activeLead.facebook : `https://facebook.com/${activeLead.facebook}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  Facebook
                                </a>
                              )}
                            </div>
                          </div>
                        )}

                        {/* ───── Company Details ───── */}
                        {(activeLead.company_uuid || activeLead.company_name) && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Company</p>
                            </div>

                            {companyLoading ? (
                              <div className="flex items-center gap-2 py-3">
                                <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
                                <span className="text-xs text-gray-500">Loading company details...</span>
                              </div>
                            ) : companyInfo ? (
                              <div className="bg-gray-50 rounded-lg p-3 space-y-3">
                                {/* Company header */}
                                <div className="flex items-center gap-2.5">
                                  {companyInfo.logo_url && (
                                    <img src={companyInfo.logo_url} alt="" className="w-9 h-9 rounded-lg object-cover bg-white border border-gray-200" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                  )}
                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold text-gray-900">{companyInfo.name || activeLead.company_name}</p>
                                    {companyInfo.industry && (
                                      <p className="text-[10px] text-gray-500">{companyInfo.industry}</p>
                                    )}
                                  </div>
                                </div>

                                {/* Tagline */}
                                {companyInfo.tagline && (
                                  <p className="text-xs text-gray-600 italic">{companyInfo.tagline}</p>
                                )}

                                {/* Quick facts */}
                                <div className="grid grid-cols-2 gap-2">
                                  {companyInfo.domain && (
                                    <div className="flex items-center gap-1.5">
                                      <Globe className="w-3 h-3 text-gray-400 flex-shrink-0" />
                                      <a href={companyInfo.website || `https://${companyInfo.domain}`} target="_blank" rel="noopener noreferrer" className="text-[11px] text-indigo-600 hover:underline truncate">
                                        {companyInfo.domain}
                                      </a>
                                    </div>
                                  )}
                                  {companyInfo.employees_range && (
                                    <div className="flex items-center gap-1.5">
                                      <User className="w-3 h-3 text-gray-400 flex-shrink-0" />
                                      <span className="text-[11px] text-gray-700">{companyInfo.employees_range} employees</span>
                                    </div>
                                  )}
                                  {companyInfo.phone && (
                                    <div className="flex items-center gap-1.5">
                                      <Phone className="w-3 h-3 text-gray-400 flex-shrink-0" />
                                      <a href={`tel:${companyInfo.phone}`} className="text-[11px] text-gray-700 hover:underline">{companyInfo.phone}</a>
                                    </div>
                                  )}
                                  {companyInfo.followers != null && (
                                    <div className="flex items-center gap-1.5">
                                      <Linkedin className="w-3 h-3 text-gray-400 flex-shrink-0" />
                                      <span className="text-[11px] text-gray-700">{companyInfo.followers.toLocaleString()} followers</span>
                                    </div>
                                  )}
                                </div>

                                {/* HQ Location */}
                                {(companyInfo.hq_location?.city || companyInfo.hq_raw_address) && (
                                  <div className="flex items-start gap-1.5">
                                    <MapPin className="w-3 h-3 text-gray-400 flex-shrink-0 mt-0.5" />
                                    <span className="text-[11px] text-gray-700">
                                      {companyInfo.hq_location?.address_string ||
                                        [companyInfo.hq_location?.city, companyInfo.hq_location?.region, companyInfo.hq_location?.country].filter(Boolean).join(', ') ||
                                        companyInfo.hq_raw_address}
                                    </span>
                                  </div>
                                )}

                                {/* Company LinkedIn */}
                                {companyInfo.linkedin && (
                                  <a
                                    href={`https://linkedin.com/company/${companyInfo.linkedin}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                                  >
                                    <Linkedin className="w-3 h-3" />
                                    Company LinkedIn
                                  </a>
                                )}

                                {/* About */}
                                {companyInfo.about && (
                                  <div>
                                    <p className="text-[10px] font-medium text-gray-400 uppercase mb-1">About</p>
                                    <p className="text-[11px] text-gray-700 leading-relaxed whitespace-pre-line max-h-32 overflow-y-auto">{companyInfo.about}</p>
                                  </div>
                                )}

                                {/* Specialities */}
                                {companyInfo.specialities && companyInfo.specialities.length > 0 && (
                                  <div>
                                    <p className="text-[10px] font-medium text-gray-400 uppercase mb-1">Specialities</p>
                                    <div className="flex flex-wrap gap-1">
                                      {companyInfo.specialities.map((s, idx) => (
                                        <span key={idx} className="px-1.5 py-0.5 text-[10px] text-gray-600 bg-white border border-gray-200 rounded">
                                          {s.trim()}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-gray-500">{activeLead.company_name || 'No company info'}</p>
                            )}
                          </div>
                        )}

                        {/* Stats */}
                        {(activeLead.connections_number || activeLead.followers_number) && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">LinkedIn Stats</p>
                            <div className="flex gap-4">
                              {activeLead.connections_number != null && (
                                <div>
                                  <p className="text-sm font-semibold text-gray-900">{activeLead.connections_number.toLocaleString()}</p>
                                  <p className="text-[10px] text-gray-500">Connections</p>
                                </div>
                              )}
                              {activeLead.followers_number != null && (
                                <div>
                                  <p className="text-sm font-semibold text-gray-900">{activeLead.followers_number.toLocaleString()}</p>
                                  <p className="text-[10px] text-gray-500">Followers</p>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Experience */}
                        {activeLead.experience && activeLead.experience.length > 0 && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">Experience</p>
                            <div className="space-y-3">
                              {activeLead.experience.map((exp, idx) => (
                                <div key={idx} className="flex gap-2.5">
                                  <Briefcase className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5" />
                                  <div className="min-w-0">
                                    <p className="text-xs font-medium text-gray-900">{exp.position || 'Role'}</p>
                                    <p className="text-xs text-gray-600">{exp.company_name}</p>
                                    <p className="text-[10px] text-gray-400">
                                      {exp.start_date ? new Date(exp.start_date).getFullYear() : '?'}
                                      {' - '}
                                      {exp.end_date ? new Date(exp.end_date).getFullYear() : 'Present'}
                                      {exp.employment_type ? ` · ${exp.employment_type}` : ''}
                                    </p>
                                    {exp.location && (
                                      <p className="text-[10px] text-gray-400">{exp.location}</p>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Skills */}
                        {activeLead.skills && activeLead.skills.length > 0 && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">Skills</p>
                            <div className="flex flex-wrap gap-1.5">
                              {activeLead.skills.map((skill, idx) => (
                                <span key={idx} className="px-2 py-0.5 text-[10px] font-medium text-indigo-700 bg-indigo-50 rounded-full">
                                  {skill}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Language */}
                        {activeLead.primary_language && (
                          <div>
                            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1">Language</p>
                            <p className="text-xs text-gray-700">{activeLead.primary_language.toUpperCase()}</p>
                          </div>
                        )}

                        {/* Automation, List & Tags */}
                        {(() => {
                          const flows = activeLead.lead_flows || [];
                          const listUuid = activeLead.list_uuid;
                          const tagUuids: string[] = Array.isArray(activeLead.tags) ? activeLead.tags : [];
                          // Get automation type from the active conversation's messages
                          const activeConv = conversations.find(
                            (c) => c.linkedin_conversation_uuid === selectedConversation.linkedin_conversation_uuid
                          );
                          const autoType = activeConv?.automation_type || null;
                          const hasAnyMeta = flows.length > 0 || autoType || listUuid || tagUuids.length > 0;

                          if (!hasAnyMeta) return null;

                          return (
                            <div>
                              <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">Campaign Management</p>
                              <div className="space-y-2.5">
                                {/* Automation type (from message data) + active flows if any */}
                                {(autoType || flows.length > 0) && (
                                  <div>
                                    <div className="flex items-center gap-1.5 mb-1">
                                      <Zap className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                                      <span className="text-[10px] font-medium text-gray-500 uppercase">Automation</span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                      {autoType && (
                                        <span
                                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-md ${
                                            autoType === 'auto'
                                              ? 'text-purple-700 bg-purple-50 border border-purple-200'
                                              : 'text-sky-700 bg-sky-50 border border-sky-200'
                                          }`}
                                        >
                                          <Zap className="w-2.5 h-2.5" />
                                          {autoType === 'auto' ? 'Flow-Automated' : autoType === 'synced' ? 'Synced from LinkedIn' : autoType}
                                        </span>
                                      )}
                                      {flows.map((flow) => (
                                        <span
                                          key={flow.uuid}
                                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-md"
                                          title={flow.uuid}
                                        >
                                          <Zap className="w-2.5 h-2.5" />
                                          {flow.name || automationsMap[flow.uuid]?.name || flow.uuid.slice(0, 8) + '...'}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* List */}
                                {listUuid && (
                                  <div>
                                    <div className="flex items-center gap-1.5 mb-1">
                                      <List className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                                      <span className="text-[10px] font-medium text-gray-500 uppercase">List</span>
                                    </div>
                                    <span
                                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md"
                                      title={listUuid}
                                    >
                                      <List className="w-2.5 h-2.5" />
                                      {listsMap[listUuid]?.name || listUuid.slice(0, 8) + '...'}
                                    </span>
                                  </div>
                                )}

                                {/* Tags (resolved from UUID via tagsMap) */}
                                {tagUuids.length > 0 && (
                                  <div>
                                    <div className="flex items-center gap-1.5 mb-1">
                                      <Tag className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                                      <span className="text-[10px] font-medium text-gray-500 uppercase">Tags</span>
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                      {tagUuids.map((tagId) => (
                                        <span
                                          key={tagId}
                                          className="px-2 py-0.5 text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full"
                                          title={tagId}
                                        >
                                          {tagsMap[tagId] || tagId.slice(0, 8) + '...'}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                  {/* end Content flex */}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}
