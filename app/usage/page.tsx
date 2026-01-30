'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/utils/supabase/client';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { CreditCard, Coins, ExternalLink, BarChart3, List, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

type UsageSettings = {
  plan: string | null;
  billing_cycle: string | null;
  renewal_date: string | null;
  last_billed_at: string | null;
  status: string | null;
  credits_remaining: number | null;
};

type CreditUsageLogEntry = {
  id: string;
  action: string;
  credits_used: number;
  investor_id: string | null;
  investor_name: string | null;
  created_at: string;
};

type CreditUsageByAction = {
  action: string;
  total_credits: number;
};

const DEFAULT_PLAN = 'free';
const DEFAULT_BILLING_CYCLE = 'quarterly';
const DEFAULT_STATUS = 'active';
const DEFAULT_CREDITS = 0;

const ADD_CREDITS_URL = 'https://calendly.com/founders-capitalxai/20min';

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

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

const USAGE_LOG_PAGE_SIZE = 25;

function UsageDetailsButton() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCreditsUsed, setTotalCreditsUsed] = useState<number | null>(null);
  const [usageByAction, setUsageByAction] = useState<CreditUsageByAction[]>([]);
  const [usageLog, setUsageLog] = useState<CreditUsageLogEntry[]>([]);
  const [logPage, setLogPage] = useState(0);
  const [logLoading, setLogLoading] = useState(false);
  const [hasMoreLog, setHasMoreLog] = useState(true);

  const fetchUsageDetails = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [totalRes, byActionRes, logRes] = await Promise.all([
        supabase.rpc('get_total_credits_used'),
        supabase.rpc('get_credit_usage_by_action'),
        supabase.rpc('get_credit_usage_log', {
          limit_count: USAGE_LOG_PAGE_SIZE,
          offset_count: 0,
        }),
      ]);

      if (totalRes.error) throw totalRes.error;
      if (byActionRes.error) throw byActionRes.error;
      if (logRes.error) throw logRes.error;

      setTotalCreditsUsed(totalRes.data ?? 0);
      setUsageByAction(Array.isArray(byActionRes.data) ? byActionRes.data : []);
      setUsageLog(Array.isArray(logRes.data) ? logRes.data : []);
      setLogPage(0);
      setHasMoreLog((Array.isArray(logRes.data) ? logRes.data.length : 0) >= USAGE_LOG_PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage details');
      setTotalCreditsUsed(null);
      setUsageByAction([]);
      setUsageLog([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMoreLog = useCallback(async () => {
    const nextOffset = (logPage + 1) * USAGE_LOG_PAGE_SIZE;
    setLogLoading(true);
    try {
      const { data, error: logError } = await supabase.rpc('get_credit_usage_log', {
        limit_count: USAGE_LOG_PAGE_SIZE,
        offset_count: nextOffset,
      });
      if (logError) throw logError;
      const entries = Array.isArray(data) ? data : [];
      setUsageLog((prev) => [...prev, ...entries]);
      setLogPage((p) => p + 1);
      setHasMoreLog(entries.length >= USAGE_LOG_PAGE_SIZE);
    } catch {
      setHasMoreLog(false);
    } finally {
      setLogLoading(false);
    }
  }, [logPage]);

  const handleToggle = useCallback(() => {
    if (!expanded) {
      setExpanded(true);
      fetchUsageDetails();
    } else {
      setExpanded(false);
    }
  }, [expanded, fetchUsageDetails]);

  return (
    <div className={`flex flex-col gap-4 ${expanded ? 'w-full' : ''}`}>
      <button
        type="button"
        onClick={handleToggle}
        className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors border border-indigo-200"
      >
        {expanded ? (
          <>
            Hide usage
            <ChevronUp className="w-4 h-4" />
          </>
        ) : (
          <>
            See usage
            <ChevronDown className="w-4 h-4" />
          </>
        )}
      </button>

      {expanded && (
        <UsageDetailsPanel
          loading={loading}
          error={error}
          totalCreditsUsed={totalCreditsUsed}
          usageByAction={usageByAction}
          usageLog={usageLog}
          hasMoreLog={hasMoreLog}
          logLoading={logLoading}
          onLoadMoreLog={loadMoreLog}
        />
      )}
    </div>
  );
}

function UsageDetailsPanel({
  loading,
  error,
  totalCreditsUsed,
  usageByAction,
  usageLog,
  hasMoreLog,
  logLoading,
  onLoadMoreLog,
}: {
  loading: boolean;
  error: string | null;
  totalCreditsUsed: number | null;
  usageByAction: CreditUsageByAction[];
  usageLog: CreditUsageLogEntry[];
  hasMoreLog: boolean;
  logLoading: boolean;
  onLoadMoreLog: () => void;
}) {
  if (loading) {
    return (
      <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-8">
        <div className="flex items-center justify-center gap-2 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading usage details…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      </section>
    );
  }

  return (
    <section className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
      <div className="p-6 space-y-6">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-indigo-600" />
          Usage details
        </h2>

        <div className="rounded-lg bg-gray-50 border border-gray-200 p-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Total credits used</p>
          <p className="text-2xl font-bold text-gray-900">{totalCreditsUsed ?? 0}</p>
        </div>

        {usageByAction.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-indigo-500" />
              Usage by action
            </h3>
            <ul className="rounded-lg border border-gray-200 divide-y divide-gray-200 overflow-hidden">
              {usageByAction.map((row) => (
                <li
                  key={row.action}
                  className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition-colors"
                >
                  <span className="text-sm font-medium text-gray-900">{row.action}</span>
                  <span className="text-sm text-gray-600 tabular-nums">{row.total_credits} credits</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <List className="w-4 h-4 text-indigo-500" />
            Recent activity
          </h3>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-medium text-gray-700">Action</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700">Credits</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700 hidden sm:table-cell">Investor</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-700">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {usageLog.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                        No usage recorded yet.
                      </td>
                    </tr>
                  ) : (
                    usageLog.map((entry) => (
                      <tr key={entry.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{entry.action}</td>
                        <td className="px-4 py-3 text-gray-600 tabular-nums">{entry.credits_used}</td>
                        <td className="px-4 py-3 text-gray-600 hidden sm:table-cell">
                          {entry.investor_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                          {formatDateTime(entry.created_at)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {hasMoreLog && (
              <div className="border-t border-gray-200 bg-gray-50 px-4 py-3">
                <button
                  type="button"
                  onClick={onLoadMoreLog}
                  disabled={logLoading}
                  className="text-sm font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {logLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading…
                    </>
                  ) : (
                    'Load more'
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function UsagePage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <UsageContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function UsageContent() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<UsageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    if (!user?.id) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('user_settings')
        .select('plan, billing_cycle, renewal_date, last_billed_at, status, credits_remaining')
        .eq('id', user.id)
        .single();

      if (fetchError && fetchError.code !== 'PGRST116') {
        console.error('Error fetching usage:', fetchError);
        setError(fetchError.message ?? 'Failed to load usage');
        setSettings(null);
        return;
      }

      setSettings(data ?? null);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  const plan = settings?.plan ?? DEFAULT_PLAN;
  const billingCycle = settings?.billing_cycle ?? DEFAULT_BILLING_CYCLE;
  const status = settings?.status ?? DEFAULT_STATUS;
  const creditsRemaining = settings?.credits_remaining ?? DEFAULT_CREDITS;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Usage</h1>
      <p className="text-sm text-gray-500 mb-6">
        View your plan, billing, and credits. No updates are made on this page.
      </p>

      {loading ? (
        <div className="py-12 flex items-center justify-center">
          <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-indigo-500" />
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      ) : (
        <>
          <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-6 mb-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-indigo-600" />
              Plan & billing
            </h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">Plan</dt>
                <dd className="mt-1 text-sm font-medium text-gray-900 capitalize">{plan}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">Billing cycle</dt>
                <dd className="mt-1 text-sm font-medium text-gray-900 capitalize">{billingCycle}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">Status</dt>
                <dd className="mt-1">
                  <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full capitalize ${status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                    {status}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">Renewal date</dt>
                <dd className="mt-1 text-sm text-gray-900">{formatDate(settings?.renewal_date ?? null)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">Last billed at</dt>
                <dd className="mt-1 text-sm text-gray-900">{formatDate(settings?.last_billed_at ?? null)}</dd>
              </div>
            </dl>
          </section>

          <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-6 mb-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Coins className="w-5 h-5 text-indigo-600" />
              Credits
            </h2>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-gray-900">{creditsRemaining}</span>
              <span className="text-sm text-gray-500">credits remaining</span>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <a
                href={ADD_CREDITS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
              >
                Add more credits
                <ExternalLink className="w-4 h-4" />
              </a>
              <UsageDetailsButton />
            </div>
          </section>

        </>
      )}
    </div>
  );
}
