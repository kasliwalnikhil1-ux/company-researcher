'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { getValidAccessToken } from '@/lib/api';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import {
  ShieldCheck,
  Search,
  RefreshCw,
  Loader2,
  Pencil,
  Ban,
  CheckCircle2,
  X,
  Users,
  Coins,
  CreditCard,
  UserX,
} from 'lucide-react';

const ADMIN_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

const PLANS = ['free', 'basic', 'pro'] as const;
const STATUSES = ['active', 'inactive', 'cancelled', 'past_due'] as const;
const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly'] as const;

interface AdminUser {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  banned: boolean;
  plan: string | null;
  billing_cycle: string | null;
  renewal_date: string | null;
  last_billed_at: string | null;
  status: string | null;
  credits_remaining: number | null;
}

interface EditForm {
  plan: string;
  credits_remaining: string;
  status: string;
  billing_cycle: string;
  renewal_date: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

function PlanBadge({ plan }: { plan: string | null }) {
  const p = plan ?? 'free';
  const styles: Record<string, string> = {
    free: 'bg-gray-100 text-gray-700',
    basic: 'bg-sky-100 text-sky-700',
    pro: 'bg-indigo-100 text-indigo-700',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${styles[p] ?? styles.free}`}>
      {p}
    </span>
  );
}

function StatusBadge({ status, banned }: { status: string | null; banned: boolean }) {
  if (banned) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-700">
        <Ban className="w-3 h-3" />
        Banned
      </span>
    );
  }
  const s = status ?? 'active';
  const styles: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-700',
    inactive: 'bg-gray-100 text-gray-600',
    cancelled: 'bg-amber-100 text-amber-700',
    past_due: 'bg-rose-100 text-rose-700',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${styles[s] ?? styles.active}`}>
      {s.replace('_', ' ')}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  color: string;
}) {
  const colorMap: Record<string, { text: string; iconBg: string }> = {
    indigo: { text: 'text-indigo-700', iconBg: 'bg-indigo-100' },
    emerald: { text: 'text-emerald-700', iconBg: 'bg-emerald-100' },
    amber: { text: 'text-amber-700', iconBg: 'bg-amber-100' },
    rose: { text: 'text-rose-700', iconBg: 'bg-rose-100' },
  };
  const c = colorMap[color] ?? colorMap.indigo;
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className={`${c.iconBg} rounded-lg p-2`}>
          <Icon className={`w-5 h-5 ${c.text}`} />
        </div>
        <span className="text-sm font-medium text-gray-500">{label}</span>
      </div>
      <p className="text-3xl font-bold text-gray-900">{value.toLocaleString()}</p>
    </div>
  );
}

// ─── Edit modal ──────────────────────────────────────────────────────
function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditForm>({
    plan: user.plan ?? 'free',
    credits_remaining: String(user.credits_remaining ?? 0),
    status: user.status ?? 'active',
    billing_cycle: user.billing_cycle ?? 'quarterly',
    renewal_date: user.renewal_date ? user.renewal_date.slice(0, 10) : '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const credits = Number(form.credits_remaining);
    if (!Number.isFinite(credits) || credits < 0) {
      setError('Credits must be a non-negative number');
      return;
    }
    try {
      setSaving(true);
      setError(null);

      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        setError('No active session');
        return;
      }

      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          userId: user.id,
          plan: form.plan,
          credits_remaining: credits,
          status: form.status,
          billing_cycle: form.billing_cycle,
          renewal_date: form.renewal_date || null,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-gray-900">Edit account</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-5 truncate">{user.email ?? user.id}</p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Plan</label>
            <select
              value={form.plan}
              onChange={(e) => setForm((f) => ({ ...f, plan: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 capitalize"
            >
              {PLANS.map((p) => (
                <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Credits remaining</label>
            <input
              type="number"
              min={0}
              value={form.credits_remaining}
              onChange={(e) => setForm((f) => ({ ...f, credits_remaining: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 capitalize"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Billing cycle</label>
              <select
                value={form.billing_cycle}
                onChange={(e) => setForm((f) => ({ ...f, billing_cycle: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 capitalize"
              >
                {BILLING_CYCLES.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Renewal date</label>
            <input
              type="date"
              value={form.renewal_date}
              onChange={(e) => setForm((f) => ({ ...f, renewal_date: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-accent-red">{error}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────
export default function AdminPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [banningId, setBanningId] = useState<string | null>(null);

  const isAllowed = ADMIN_USER_IDS.has(user?.id ?? '');

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        setError('No active session');
        return;
      }

      const res = await fetch('/api/admin/users', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }

      const data = await res.json();
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      console.error('Failed to fetch users:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAllowed) {
      router.replace('/');
      return;
    }
    fetchUsers();
  }, [isAllowed, router, fetchUsers]);

  const toggleBan = useCallback(
    async (target: AdminUser) => {
      const action = target.banned ? 'restore access for' : 'revoke access for';
      if (!window.confirm(`Are you sure you want to ${action} ${target.email ?? target.id}?`)) {
        return;
      }
      try {
        setBanningId(target.id);

        const accessToken = await getValidAccessToken();
        if (!accessToken) return;

        const res = await fetch('/api/admin/users', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ userId: target.id, banned: !target.banned }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || res.statusText);
        }

        setUsers((prev) =>
          prev.map((u) => (u.id === target.id ? { ...u, banned: !target.banned } : u))
        );
      } catch (err) {
        console.error('Failed to toggle ban:', err);
        alert(err instanceof Error ? err.message : 'Failed to update access');
      } finally {
        setBanningId(null);
      }
    },
    []
  );

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        (u.email ?? '').toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q) ||
        (u.plan ?? '').toLowerCase().includes(q)
    );
  }, [users, search]);

  const summary = useMemo(
    () => ({
      total: users.length,
      paid: users.filter((u) => u.plan === 'basic' || u.plan === 'pro').length,
      totalCredits: users.reduce((sum, u) => sum + (u.credits_remaining ?? 0), 0),
      banned: users.filter((u) => u.banned).length,
    }),
    [users]
  );

  if (!isAllowed) return null;

  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="relative flex-1 overflow-auto bg-secondary-default">
            <div className="absolute inset-0 -z-0 w-full h-full bg-[linear-gradient(to_right,#80808012_1px,transparent_0px),linear-gradient(to_bottom,#80808012_1px,transparent_0px)] bg-[size:60px_60px]" />
            <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              {/* Header */}
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-indigo-100 rounded-lg">
                    <ShieldCheck className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div>
                    <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
                    <p className="text-sm text-gray-500">Manage account plans, credits, and access</p>
                  </div>
                </div>
                <button
                  onClick={fetchUsers}
                  disabled={loading}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>

              {/* Loading */}
              {loading && users.length === 0 && (
                <div className="flex items-center justify-center min-h-[400px]">
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
                    <span className="text-gray-500">Loading accounts...</span>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && !loading && (
                <div className="flex items-center justify-center min-h-[400px]">
                  <div className="text-center">
                    <p className="text-accent-red font-medium">Failed to load accounts</p>
                    <p className="text-sm text-gray-600 mt-1">{error}</p>
                    <button
                      onClick={fetchUsers}
                      className="mt-4 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              {!error && users.length > 0 && (
                <div className="space-y-6">
                  {/* Summary cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <SummaryCard label="Total Accounts" value={summary.total} icon={Users} color="indigo" />
                    <SummaryCard label="Paid Plans" value={summary.paid} icon={CreditCard} color="emerald" />
                    <SummaryCard label="Credits Outstanding" value={summary.totalCredits} icon={Coins} color="amber" />
                    <SummaryCard label="Banned" value={summary.banned} icon={UserX} color="rose" />
                  </div>

                  {/* Search */}
                  <div className="relative max-w-sm">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by email, user ID, or plan..."
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  {/* Users table */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            <th className="px-4 py-3">Account</th>
                            <th className="px-4 py-3">Plan</th>
                            <th className="px-4 py-3 text-right">Credits</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3">Billing</th>
                            <th className="px-4 py-3">Renewal</th>
                            <th className="px-4 py-3">Last Sign-in</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {filteredUsers.map((u) => (
                            <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                              <td className="px-4 py-3">
                                <div className="font-medium text-gray-900 truncate max-w-[220px]">
                                  {u.email ?? '—'}
                                </div>
                                <div className="text-xs text-gray-400 truncate max-w-[220px]">{u.id}</div>
                              </td>
                              <td className="px-4 py-3">
                                <PlanBadge plan={u.plan} />
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                                {(u.credits_remaining ?? 0).toLocaleString()}
                              </td>
                              <td className="px-4 py-3">
                                <StatusBadge status={u.status} banned={u.banned} />
                              </td>
                              <td className="px-4 py-3 text-gray-600 capitalize">{u.billing_cycle ?? '—'}</td>
                              <td className="px-4 py-3 text-gray-600">{formatDate(u.renewal_date)}</td>
                              <td className="px-4 py-3 text-gray-600">{formatDate(u.last_sign_in_at)}</td>
                              <td className="px-4 py-3">
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    onClick={() => setEditingUser(u)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => toggleBan(u)}
                                    disabled={banningId === u.id || u.id === user?.id}
                                    title={u.id === user?.id ? 'You cannot ban yourself' : undefined}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                                      u.banned
                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                        : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                    }`}
                                  >
                                    {banningId === u.id ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : u.banned ? (
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                    ) : (
                                      <Ban className="w-3.5 h-3.5" />
                                    )}
                                    {u.banned ? 'Unban' : 'Ban'}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                          {filteredUsers.length === 0 && (
                            <tr>
                              <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                                No accounts match your search.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {editingUser && (
          <EditUserModal
            user={editingUser}
            onClose={() => setEditingUser(null)}
            onSaved={fetchUsers}
          />
        )}
      </MainLayout>
    </ProtectedRoute>
  );
}
