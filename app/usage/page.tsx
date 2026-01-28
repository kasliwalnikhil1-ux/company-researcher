'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/utils/supabase/client';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { CreditCard, Coins, ExternalLink } from 'lucide-react';

type UsageSettings = {
  plan: string | null;
  billing_cycle: string | null;
  renewal_date: string | null;
  last_billed_at: string | null;
  status: string | null;
  credits_remaining: number | null;
};

const DEFAULT_PLAN = 'free';
const DEFAULT_BILLING_CYCLE = 'quarterly';
const DEFAULT_STATUS = 'active';
const DEFAULT_CREDITS = 0;

const ADD_CREDITS_URL = 'https://calendly.com/aarushi-kaptured/15min';

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
            <div className="mt-6">
              <a
                href={ADD_CREDITS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
              >
                Add more credits
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </section>

        </>
      )}
    </div>
  );
}
