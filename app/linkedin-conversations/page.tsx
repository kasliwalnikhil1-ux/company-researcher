'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useAuth } from '@/contexts/AuthContext';
import { getValidAccessToken } from '@/lib/api';
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
} from 'lucide-react';

/* ────────────────────────── Types ────────────────────────── */

interface LinkedInMessage {
  uuid: string;
  linkedin_conversation_uuid: string;
  lead_uuid: string;
  sender_profile_uuid?: string;
  type: string; // inbox | outbox
  text: string;
  status?: string;
  created_at: string;
  sent_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface Conversation {
  linkedin_conversation_uuid: string;
  lead_uuid: string;
  last_message: LinkedInMessage;
  message_count: number;
  lead?: LeadInfo | null;
  sender_profile_uuid?: string; // from the outbox messages in this conversation
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

export default function LinkedInConversationsPage() {
  // Auth
  const { user } = useAuth();

  // Conversation list state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginationMeta>({ limit: 50, offset: 0, total: 0, has_more: false });
  const [searchQuery, setSearchQuery] = useState('');

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

  // Sender profiles
  const [senderProfiles, setSenderProfiles] = useState<SenderProfile[]>([]);
  const [selectedSenderProfile, setSelectedSenderProfile] = useState<string>('');

  // Contact details panel
  const [showContactDetails, setShowContactDetails] = useState(false);
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo | null>(null);
  const [companyLoading, setCompanyLoading] = useState(false);
  const companyCacheRef = useRef<Record<string, CompanyInfo>>({});

  // Lead cache
  const leadCacheRef = useRef<Record<string, LeadInfo>>({});

  // Refs
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
          // API route returns { lead: { uuid, name, ... } }
          const lead = leadData.lead || leadData;
          if (lead && (lead.name || lead.first_name)) {
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
      const convMap = new Map<string, { messages: LinkedInMessage[]; lead_uuid: string; sender_profile_uuid?: string }>();
      for (const msg of messages) {
        const key = msg.linkedin_conversation_uuid;
        if (!key) continue;
        if (!convMap.has(key)) {
          convMap.set(key, { messages: [], lead_uuid: msg.lead_uuid });
        }
        const entry = convMap.get(key)!;
        entry.messages.push(msg);
        // Track sender_profile_uuid from outbox messages
        if (msg.type === 'outbox' && msg.sender_profile_uuid && !entry.sender_profile_uuid) {
          entry.sender_profile_uuid = msg.sender_profile_uuid;
        }
      }

      // Build conversations list sorted by most recent message
      const convList: Conversation[] = [];
      convMap.forEach((val, key) => {
        const sorted = val.messages.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        convList.push({
          linkedin_conversation_uuid: key,
          lead_uuid: val.lead_uuid,
          last_message: sorted[0],
          message_count: sorted.length,
          lead: leadCacheRef.current[val.lead_uuid] || null,
          sender_profile_uuid: val.sender_profile_uuid,
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
  }, [hydrateLeads]);

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

  /* ────────────────── Effects ────────────────── */

  useEffect(() => {
    fetchMessages();
    fetchSenderProfiles();
  }, [fetchMessages, fetchSenderProfiles]);

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

  /* ────────────────── Handlers ────────────────── */

  const openConversation = (conv: Conversation) => {
    setSelectedConversation(conv);
    setThreadMessages([]);
    setReplyText('');
    setReplyError(null);
    setReplySuccess(false);
    setShowContactDetails(false);
    setCompanyInfo(null);
    // Auto-select the sender profile that was used in this conversation
    if (conv.sender_profile_uuid) {
      setSelectedSenderProfile(conv.sender_profile_uuid);
    }
    fetchThreadMessages(conv.linkedin_conversation_uuid);
  };

  const closeThread = () => {
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

  // Filtered conversations
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.toLowerCase();
    return conversations.filter((c) => {
      const name = getLeadDisplayName(c.lead).toLowerCase();
      const company = c.lead?.company_name?.toLowerCase() || '';
      const lastMsg = c.last_message.text?.toLowerCase() || '';
      return name.includes(q) || company.includes(q) || lastMsg.includes(q);
    });
  }, [conversations, searchQuery]);

  // Active lead: stays reactive to conversations state updates (lead hydration)
  const activeLead = useMemo(() => {
    if (!selectedConversation) return null;
    const conv = conversations.find(
      (c) => c.linkedin_conversation_uuid === selectedConversation.linkedin_conversation_uuid
    );
    return conv?.lead || selectedConversation.lead || null;
  }, [selectedConversation, conversations]);

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
          <div className="bg-white border-b border-gray-200 px-6 py-4 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {selectedConversation && (
                  <button
                    onClick={closeThread}
                    className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors md:hidden"
                  >
                    <ArrowLeft className="w-5 h-5 text-gray-600" />
                  </button>
                )}
                <MessageSquare className="w-6 h-6 text-indigo-600" />
                <h1 className="text-xl font-bold text-gray-900">LinkedIn Conversations</h1>
                {!conversationsLoading && (
                  <span className="text-sm text-gray-500">({pagination.total} messages)</span>
                )}
              </div>
              <button
                onClick={() => {
                  fetchMessages();
                  if (selectedConversation) {
                    fetchThreadMessages(selectedConversation.linkedin_conversation_uuid);
                  }
                }}
                disabled={conversationsLoading}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${conversationsLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
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
              {/* Search */}
              <div className="px-4 py-3 border-b border-gray-100">
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
              </div>

              {/* Conversations List */}
              <div className="flex-1 overflow-y-auto">
                {conversationsLoading ? (
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
                      {searchQuery ? 'No conversations match your search' : 'No conversations yet'}
                    </p>
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
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {/* Avatar */}
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
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

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-sm text-gray-900 truncate">
                              {getLeadDisplayName(conv.lead)}
                            </span>
                            <span className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">
                              {formatDate(conv.last_message.created_at)}
                            </span>
                          </div>

                          {conv.lead?.company_name && (
                            <p className="text-xs text-gray-500 truncate mt-0.5">{conv.lead.company_name}</p>
                          )}

                          <div className="flex items-center gap-1.5 mt-1">
                            {conv.last_message.type === 'outbox' && (
                              <span className="text-xs text-indigo-500 font-medium">You:</span>
                            )}
                            <p className="text-xs text-gray-500 truncate">
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
                  <div className="bg-white border-b border-gray-200 px-4 py-3 flex-shrink-0">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={closeThread}
                        className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors hidden md:block flex-shrink-0"
                      >
                        <ArrowLeft className="w-5 h-5 text-gray-500" />
                      </button>

                      {/* Thread header avatar */}
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 overflow-hidden">
                        {activeLead?.avatar_url ? (
                          <img
                            src={activeLead.avatar_url}
                            alt=""
                            className="w-9 h-9 rounded-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          getLeadDisplayName(activeLead).charAt(0).toUpperCase()
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 text-sm truncate">
                          {getLeadDisplayName(activeLead)}
                        </h3>
                        {(activeLead?.position || activeLead?.company_name) && (
                          <p className="text-xs text-gray-500 line-clamp-2">
                            {activeLead.position && <span>{activeLead.position}</span>}
                            {activeLead.position && activeLead.company_name && <span className="text-gray-400"> at </span>}
                            {activeLead.company_name && <span>{activeLead.company_name}</span>}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {activeLead?.linkedin && (
                          <a
                            href={
                              activeLead.linkedin.startsWith('http')
                                ? activeLead.linkedin
                                : `https://linkedin.com/in/${activeLead.linkedin}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">LinkedIn</span>
                          </a>
                        )}
                        <button
                          onClick={() => setShowContactDetails(!showContactDetails)}
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                            showContactDetails
                              ? 'text-indigo-700 bg-indigo-100'
                              : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                          }`}
                        >
                          <Info className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Contact Info</span>
                        </button>
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

                  {/* Reply Box */}
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

                    {replySuccess && (
                      <div className="mb-3 flex items-center gap-2 text-sm text-green-600 bg-green-50 px-3 py-2 rounded-lg">
                        <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                        Message sent successfully!
                      </div>
                    )}

                    <div className="flex items-end gap-3">
                      <textarea
                        ref={textareaRef}
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                        rows={1}
                        className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none bg-gray-50 max-h-32"
                        style={{
                          height: 'auto',
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
                  {/* end Messages + Reply column */}
                  </div>

                  {/* Contact Details Panel */}
                  {showContactDetails && activeLead && (
                    <div className="w-full lg:w-80 xl:w-96 border-l border-gray-200 bg-white overflow-y-auto overflow-x-hidden flex-shrink-0">
                      {/* Panel Header */}
                      <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between z-10">
                        <h4 className="font-semibold text-sm text-gray-900">Contact Details</h4>
                        <button
                          onClick={() => setShowContactDetails(false)}
                          className="p-1 rounded-lg hover:bg-gray-100 transition-colors"
                        >
                          <X className="w-4 h-4 text-gray-500" />
                        </button>
                      </div>

                      <div className="px-5 py-4 space-y-5 overflow-hidden">
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
