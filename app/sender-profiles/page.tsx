'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { getValidAccessToken } from '@/lib/api';
import {
  Users,
  Plus,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  XCircle,
  User,
  Link as LinkIcon,
  Tag,
  Clock,
  Wifi,
  WifiOff,
  Globe,
  Copy,
  ArrowUpDown,
  PauseCircle,
  CircleDot,
} from 'lucide-react';

/* ────────────────────────── Types ────────────────────────── */

interface SenderProfile {
  uuid: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  label?: string;
  status?: string;
  linkedin_account_uuid?: string;
  linkedin_browser_uuid?: string;
  assignee_user_id?: number;
  created_at?: string;
  updated_at?: string;
  photo_url?: string;
  avatar_url?: string;
  image_url?: string;
  linkedin_photo_url?: string;
  [key: string]: unknown;
}

interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

type ModalType = 'create' | 'connect-external' | null;

/* ────────────────────────── Helpers ────────────────────────── */

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
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

function getProfileName(profile: SenderProfile): string {
  if (profile.full_name) return profile.full_name;
  const parts = [profile.first_name, profile.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Unnamed';
}

function getProfilePhoto(profile: SenderProfile): string | null {
  return (
    profile.photo_url ||
    profile.avatar_url ||
    profile.image_url ||
    profile.linkedin_photo_url ||
    (typeof profile.photo === 'string' ? profile.photo : null) ||
    (typeof profile.avatar === 'string' ? profile.avatar : null) ||
    (typeof profile.image === 'string' ? profile.image : null) ||
    (typeof profile.picture === 'string' ? profile.picture : null) ||
    (typeof profile.picture_url === 'string' ? profile.picture_url : null) ||
    null
  );
}

interface StatusStyle {
  bg: string;
  text: string;
  border: string;
  iconBg: string;
  label: string;
}

function getStatusStyle(status?: string): StatusStyle {
  switch (status?.toLowerCase()) {
    case 'active':
      return {
        bg: 'bg-emerald-50',
        text: 'text-emerald-700',
        border: 'border-emerald-200',
        iconBg: 'bg-emerald-500',
        label: 'Active',
      };
    case 'connected':
      return {
        bg: 'bg-green-50',
        text: 'text-green-700',
        border: 'border-green-200',
        iconBg: 'bg-green-500',
        label: 'Connected',
      };
    case 'paused':
      return {
        bg: 'bg-amber-50',
        text: 'text-amber-700',
        border: 'border-amber-200',
        iconBg: 'bg-amber-500',
        label: 'Paused',
      };
    case 'disabled':
      return {
        bg: 'bg-orange-50',
        text: 'text-orange-700',
        border: 'border-orange-200',
        iconBg: 'bg-orange-400',
        label: 'Disabled',
      };
    case 'error':
      return {
        bg: 'bg-red-50',
        text: 'text-red-700',
        border: 'border-red-200',
        iconBg: 'bg-red-500',
        label: 'Error',
      };
    case 'failed':
      return {
        bg: 'bg-red-50',
        text: 'text-red-600',
        border: 'border-red-200',
        iconBg: 'bg-red-400',
        label: 'Failed',
      };
    case 'pending':
      return {
        bg: 'bg-sky-50',
        text: 'text-sky-700',
        border: 'border-sky-200',
        iconBg: 'bg-sky-500',
        label: 'Pending',
      };
    case 'connecting':
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        border: 'border-blue-200',
        iconBg: 'bg-blue-500',
        label: 'Connecting',
      };
    case 'warming_up':
    case 'warming up':
      return {
        bg: 'bg-orange-50',
        text: 'text-orange-700',
        border: 'border-orange-200',
        iconBg: 'bg-orange-500',
        label: 'Warming Up',
      };
    default:
      return {
        bg: 'bg-gray-50',
        text: 'text-gray-500',
        border: 'border-gray-200',
        iconBg: 'bg-gray-400',
        label: status || 'Unknown',
      };
  }
}

function StatusIcon({ status }: { status?: string }) {
  const s = status?.toLowerCase();
  const iconClass = 'w-3 h-3';
  if (s === 'active' || s === 'connected') return <CheckCircle2 className={`${iconClass} text-white`} />;
  if (s === 'paused' || s === 'disabled') return <PauseCircle className={`${iconClass} text-white`} />;
  if (s === 'error' || s === 'failed') return <XCircle className={`${iconClass} text-white`} />;
  if (s === 'pending') return <Clock className={`${iconClass} text-white`} />;
  if (s === 'connecting' || s === 'warming_up' || s === 'warming up') return <Loader2 className={`${iconClass} text-white animate-spin`} />;
  return <CircleDot className={`${iconClass} text-white`} />;
}

/* ────────────────────────── Page ────────────────────────── */

export default function SenderProfilesPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <SenderProfilesContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

/* ────────────────────────── Content ────────────────────────── */

function SenderProfilesContent() {
  // List state
  const [profiles, setProfiles] = useState<SenderProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginationMeta>({
    limit: 20,
    offset: 0,
    total: 0,
    has_more: false,
  });

  // Search & sorting
  const [searchQuery, setSearchQuery] = useState('');
  const [orderField, setOrderField] = useState('created_at');
  const [orderType, setOrderType] = useState<'asc' | 'desc'>('desc');

  // Modal state
  const [activeModal, setActiveModal] = useState<ModalType>(null);

  // Toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  /* ────────────────── API: Fetch profiles ────────────────── */

  const fetchProfiles = useCallback(
    async (offset = 0) => {
      try {
        setLoading(true);
        setError(null);
        const token = await getValidAccessToken();
        if (!token) throw new Error('Not authenticated');

        const params = new URLSearchParams({
          limit: String(pagination.limit),
          offset: String(offset),
          order_field: orderField,
          order_type: orderType,
        });

        if (searchQuery.trim()) {
          params.set('filter[q]', searchQuery.trim());
        }

        const res = await fetch(`/api/sender-profiles?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Failed to fetch sender profiles (${res.status})`);
        }

        const json = await res.json();
        // Debug: log first profile to see all available fields including photo URLs
        if (json.data?.[0]) {
          console.log('[sender-profiles] Sample profile fields:', Object.keys(json.data[0]));
          console.log('[sender-profiles] Sample profile:', json.data[0]);
        }
        setProfiles(json.data || []);
        setPagination({
          limit: json.limit || 20,
          offset: json.offset || 0,
          total: json.total || 0,
          has_more: json.has_more || false,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load sender profiles');
      } finally {
        setLoading(false);
      }
    },
    [pagination.limit, orderField, orderType, searchQuery]
  );

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  /* ────────────────── Pagination helpers ────────────────── */

  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));

  const goToPage = (page: number) => {
    const offset = (page - 1) * pagination.limit;
    fetchProfiles(offset);
  };

  /* ────────────────── Sort toggle ────────────────── */

  const toggleSort = (field: string) => {
    if (orderField === field) {
      setOrderType((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setOrderField(field);
      setOrderType('desc');
    }
  };

  /* ────────────────── Copy UUID ────────────────── */

  const copyUuid = (uuid: string) => {
    navigator.clipboard.writeText(uuid).then(() => {
      showToast('UUID copied to clipboard', 'success');
    });
  };

  /* ────────────────── Filtered (client-side extra filter) ────────────────── */

  const filteredProfiles = useMemo(() => {
    // The API-side filter[q] handles server search; this is a fallback for local results
    return profiles;
  }, [profiles]);

  /* ────────────────── Render ────────────────── */

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
              <Users className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Sender Profiles</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Manage your LinkedIn sender profiles
                {!loading && (
                  <span className="ml-1 text-gray-400">({pagination.total} total)</span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchProfiles(pagination.offset)}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              onClick={() => setActiveModal('create')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" />
              Create Profile
            </button>
            <button
              onClick={() => setActiveModal('connect-external')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shadow-sm"
            >
              <Globe className="w-4 h-4" />
              Connect GoLogin
            </button>
          </div>
        </div>
      </div>

      {/* Search bar */}
      <div className="mb-4">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name, label, or UUID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') fetchProfiles(0);
            }}
            className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
          />
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-4 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
          <button
            onClick={() => fetchProfiles(0)}
            className="ml-auto text-red-600 hover:text-red-700 font-medium underline text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && profiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
          <p className="text-sm text-gray-500">Loading sender profiles...</p>
        </div>
      ) : filteredProfiles.length === 0 && !loading ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center">
            <Users className="w-8 h-8 text-gray-300" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-gray-700">No sender profiles found</h3>
            <p className="text-sm text-gray-500 mt-1">
              {searchQuery
                ? 'Try adjusting your search query'
                : 'Create your first sender profile to get started'}
            </p>
          </div>
          {!searchQuery && (
            <div className="flex gap-2">
              <button
                onClick={() => setActiveModal('create')}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create Profile
              </button>
              <button
                onClick={() => setActiveModal('connect-external')}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors"
              >
                <Globe className="w-4 h-4" />
                Connect via GoLogin
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Table */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-5 py-3 font-semibold text-gray-600">
                      <button
                        onClick={() => toggleSort('first_name')}
                        className="inline-flex items-center gap-1 hover:text-gray-900 transition-colors"
                      >
                        Name
                        <ArrowUpDown className="w-3.5 h-3.5 text-gray-400" />
                      </button>
                    </th>
                    <th className="text-left px-5 py-3 font-semibold text-gray-600">Label</th>
                    <th className="text-left px-5 py-3 font-semibold text-gray-600">Status</th>
                    <th className="text-left px-5 py-3 font-semibold text-gray-600">LinkedIn</th>
                    <th className="text-left px-5 py-3 font-semibold text-gray-600">
                      <button
                        onClick={() => toggleSort('created_at')}
                        className="inline-flex items-center gap-1 hover:text-gray-900 transition-colors"
                      >
                        Created
                        <ArrowUpDown className="w-3.5 h-3.5 text-gray-400" />
                      </button>
                    </th>
                    <th className="text-left px-5 py-3 font-semibold text-gray-600">UUID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredProfiles.map((profile) => {
                    const statusStyle = getStatusStyle(profile.status);
                    const hasLinkedIn = !!profile.linkedin_account_uuid;
                    const photoUrl = getProfilePhoto(profile);

                    return (
                      <tr
                        key={profile.uuid}
                        className="hover:bg-gray-50/70 transition-colors"
                      >
                        {/* Name + Photo */}
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 overflow-hidden ring-2 ring-white shadow-sm">
                              {photoUrl ? (
                                <img
                                  src={photoUrl}
                                  alt={getProfileName(profile)}
                                  className="w-10 h-10 rounded-full object-cover"
                                  onError={(e) => {
                                    // Hide broken image, show fallback initial
                                    (e.target as HTMLImageElement).style.display = 'none';
                                    const parent = (e.target as HTMLImageElement).parentElement;
                                    if (parent) {
                                      parent.textContent = getProfileName(profile).charAt(0).toUpperCase();
                                    }
                                  }}
                                />
                              ) : (
                                getProfileName(profile).charAt(0).toUpperCase()
                              )}
                            </div>
                            <div>
                              <p className="font-medium text-gray-900">
                                {getProfileName(profile)}
                              </p>
                              {profile.assignee_user_id && (
                                <p className="text-xs text-gray-400 mt-0.5">
                                  Assignee ID: {profile.assignee_user_id}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Label */}
                        <td className="px-5 py-4">
                          {profile.label ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-indigo-50 text-indigo-700 rounded-full border border-indigo-100">
                              <Tag className="w-3 h-3" />
                              {profile.label}
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>

                        {/* Status - redesigned */}
                        <td className="px-5 py-4">
                          <div
                            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border ${statusStyle.bg} ${statusStyle.border}`}
                          >
                            <span
                              className={`w-5 h-5 rounded-full ${statusStyle.iconBg} flex items-center justify-center flex-shrink-0 shadow-sm`}
                            >
                              <StatusIcon status={profile.status} />
                            </span>
                            <span className={`text-xs font-semibold ${statusStyle.text}`}>
                              {statusStyle.label}
                            </span>
                          </div>
                        </td>

                        {/* LinkedIn connection */}
                        <td className="px-5 py-4">
                          {hasLinkedIn ? (
                            <div className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-green-50 border border-green-200">
                              <Wifi className="w-3.5 h-3.5 text-green-600" />
                              <span className="text-xs font-medium text-green-700">Connected</span>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-gray-50 border border-gray-200">
                              <WifiOff className="w-3.5 h-3.5 text-gray-400" />
                              <span className="text-xs font-medium text-gray-400">Not connected</span>
                            </div>
                          )}
                        </td>

                        {/* Created */}
                        <td className="px-5 py-4">
                          <span className="text-xs text-gray-500 flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-gray-400" />
                            {formatDate(profile.created_at)}
                          </span>
                        </td>

                        {/* UUID */}
                        <td className="px-5 py-4">
                          <button
                            onClick={() => copyUuid(profile.uuid)}
                            className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-600 font-mono transition-colors group bg-gray-50 px-2 py-1 rounded-md border border-transparent hover:border-indigo-200 hover:bg-indigo-50"
                            title="Click to copy UUID"
                          >
                            <span className="truncate max-w-[100px]">{profile.uuid}</span>
                            <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50">
                <p className="text-xs text-gray-500">
                  Showing {pagination.offset + 1}–
                  {Math.min(pagination.offset + pagination.limit, pagination.total)} of{' '}
                  {pagination.total}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => goToPage(currentPage - 1)}
                    disabled={currentPage === 1 || loading}
                    className="p-1.5 rounded-md text-gray-500 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>

                  {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                    let page: number;
                    if (totalPages <= 7) {
                      page = i + 1;
                    } else if (currentPage <= 4) {
                      page = i + 1;
                    } else if (currentPage >= totalPages - 3) {
                      page = totalPages - 6 + i;
                    } else {
                      page = currentPage - 3 + i;
                    }
                    return (
                      <button
                        key={page}
                        onClick={() => goToPage(page)}
                        disabled={loading}
                        className={`w-8 h-8 text-xs font-medium rounded-md transition-colors ${
                          page === currentPage
                            ? 'bg-indigo-600 text-white'
                            : 'text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {page}
                      </button>
                    );
                  })}

                  <button
                    onClick={() => goToPage(currentPage + 1)}
                    disabled={currentPage === totalPages || loading}
                    className="p-1.5 rounded-md text-gray-500 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Create Profile Modal */}
      {activeModal === 'create' && (
        <CreateProfileModal
          onClose={() => setActiveModal(null)}
          onSuccess={() => {
            setActiveModal(null);
            showToast('Sender profile created successfully', 'success');
            fetchProfiles(0);
          }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {/* Connect External (GoLogin) Modal */}
      {activeModal === 'connect-external' && (
        <ConnectExternalModal
          onClose={() => setActiveModal(null)}
          onSuccess={() => {
            setActiveModal(null);
            showToast('Sender profile created and connected via GoLogin', 'success');
            fetchProfiles(0);
          }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all animate-in slide-in-from-bottom-2 ${
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
          )}
          {toast.message}
          <button onClick={() => setToast(null)} className="ml-2 hover:opacity-80">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────── Create Profile Modal ────────────────────────── */

function CreateProfileModal({
  onClose,
  onSuccess,
  onError,
}: {
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [label, setLabel] = useState('');
  const [assigneeUserId, setAssigneeUserId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) {
      onError('First name and last name are required');
      return;
    }

    try {
      setSubmitting(true);
      const token = await getValidAccessToken();
      if (!token) throw new Error('Not authenticated');

      const body: Record<string, unknown> = {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
      };
      if (label.trim()) body.label = label.trim();
      if (assigneeUserId.trim()) body.assignee_user_id = parseInt(assigneeUserId.trim(), 10);

      const res = await fetch('/api/sender-profiles', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to create profile (${res.status})`);
      }

      onSuccess();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create profile');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <User className="w-5 h-5 text-indigo-600" />
            <h2 className="text-lg font-semibold text-gray-900">Create Sender Profile</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-5 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  First Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="John"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Last Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Doe"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Label
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Sales Team, Outreach Bot"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Assignee User ID
              </label>
              <input
                type="number"
                value={assigneeUserId}
                onChange={(e) => setAssigneeUserId(e.target.value)}
                placeholder="e.g. 12345"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <p className="text-xs text-gray-400 mt-1">
                The user ID to assign this sender profile to
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !firstName.trim() || !lastName.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  Create Profile
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ────────────────────────── Connect External (GoLogin) Modal ────────────────────────── */

function ConnectExternalModal({
  onClose,
  onSuccess,
  onError,
}: {
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gologinExternalId, setGologinExternalId] = useState('');
  const [label, setLabel] = useState('');
  const [smartLimitsEnabled, setSmartLimitsEnabled] = useState(true);
  const [notificationEmails, setNotificationEmails] = useState('');
  const [browserOwner, setBrowserOwner] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || !gologinExternalId.trim()) {
      onError('First name, last name, and GoLogin External ID are required');
      return;
    }

    try {
      setSubmitting(true);
      const token = await getValidAccessToken();
      if (!token) throw new Error('Not authenticated');

      const body: Record<string, unknown> = {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        gologin_external_id: gologinExternalId.trim(),
      };
      if (label.trim()) body.label = label.trim();
      body.smart_limits_enabled = smartLimitsEnabled;
      if (notificationEmails.trim()) {
        body.notification_emails = notificationEmails
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean);
      }
      if (browserOwner.trim()) body.browser_owner = browserOwner.trim();

      const res = await fetch('/api/sender-profiles/connect-external', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to connect profile (${res.status})`);
      }

      onSuccess();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to connect profile');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-emerald-600" />
            <h2 className="text-lg font-semibold text-gray-900">Connect via GoLogin</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Info Banner */}
        <div className="mx-6 mt-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg">
          <p className="text-xs text-emerald-700 leading-relaxed">
            This creates a sender profile and automatically connects it to a LinkedIn Browser using
            the GoLogin external ID. Recommended for programmatic LinkedIn setup.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  First Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="John"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Last Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Doe"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                GoLogin External ID <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={gologinExternalId}
                onChange={(e) => setGologinExternalId(e.target.value)}
                placeholder="e.g. abc123-def456-..."
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                required
              />
              <p className="text-xs text-gray-400 mt-1">
                The external profile ID from GoLogin
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Sales Outreach"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              />
            </div>

            <div className="flex items-center gap-3">
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={smartLimitsEnabled}
                  onChange={(e) => setSmartLimitsEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-gray-300 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
              </label>
              <span className="text-sm text-gray-700">Enable smart limits</span>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notification Emails
              </label>
              <input
                type="text"
                value={notificationEmails}
                onChange={(e) => setNotificationEmails(e.target.value)}
                placeholder="email1@example.com, email2@example.com"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              />
              <p className="text-xs text-gray-400 mt-1">Comma-separated list of emails</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Browser Owner
              </label>
              <input
                type="text"
                value={browserOwner}
                onChange={(e) => setBrowserOwner(e.target.value)}
                placeholder="e.g. owner-name"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                submitting ||
                !firstName.trim() ||
                !lastName.trim() ||
                !gologinExternalId.trim()
              }
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <LinkIcon className="w-4 h-4" />
                  Create &amp; Connect
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
