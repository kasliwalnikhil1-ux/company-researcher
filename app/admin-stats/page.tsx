'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';
import { getValidAccessToken } from '@/lib/api';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import {
  ShieldCheck,
  Users,
  Building2,
  UserCheck,
  UserX,
  Globe,
  Linkedin,
  Mail,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { getCountryName } from '@/lib/isoCodes';

const formatKebabLabel = (value: string): string =>
  value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

const ME_DATA_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

interface AdminStats {
  total_investors: number;
  total_firms: number;
  total_people: number;
  active_investors: number;
  inactive_investors: number;
  investors_with_domain: number;
  investors_with_linkedin: number;
  investors_with_email: number;
  investors_by_country: Record<string, number>;
  investors_by_tier: Record<string, number>;
  investors_by_stage: Record<string, number>;
}

// ─── Stat Card ───────────────────────────────────────────────────────
function StatCard({
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
  const colorMap: Record<string, { bg: string; text: string; iconBg: string }> = {
    indigo: { bg: 'bg-indigo-50', text: 'text-indigo-700', iconBg: 'bg-indigo-100' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', iconBg: 'bg-emerald-100' },
    amber: { bg: 'bg-amber-50', text: 'text-amber-700', iconBg: 'bg-amber-100' },
    rose: { bg: 'bg-rose-50', text: 'text-rose-700', iconBg: 'bg-rose-100' },
    sky: { bg: 'bg-sky-50', text: 'text-sky-700', iconBg: 'bg-sky-100' },
    violet: { bg: 'bg-violet-50', text: 'text-violet-700', iconBg: 'bg-violet-100' },
    teal: { bg: 'bg-teal-50', text: 'text-teal-700', iconBg: 'bg-teal-100' },
    orange: { bg: 'bg-orange-50', text: 'text-orange-700', iconBg: 'bg-orange-100' },
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
      <p className={`text-3xl font-bold text-gray-900`}>{(value ?? 0).toLocaleString()}</p>
    </div>
  );
}

// ─── Horizontal bar chart ────────────────────────────────────────────
function HorizontalBarChart({
  title,
  data,
  color,
  formatLabel,
}: {
  title: string;
  data: Record<string, number>;
  color: string;
  formatLabel?: (key: string) => string;
}) {
  const sorted = Object.entries(data ?? {}).sort(([, a], [, b]) => b - a);
  const max = Math.max(...sorted.map(([, v]) => v), 1);

  const barColorMap: Record<string, string> = {
    indigo: 'bg-indigo-500',
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
    sky: 'bg-sky-500',
    violet: 'bg-violet-500',
    teal: 'bg-teal-500',
    orange: 'bg-orange-500',
  };
  const barBg = barColorMap[color] ?? barColorMap.indigo;

  const barTrackMap: Record<string, string> = {
    indigo: 'bg-indigo-100',
    emerald: 'bg-emerald-100',
    amber: 'bg-amber-100',
    rose: 'bg-rose-100',
    sky: 'bg-sky-100',
    violet: 'bg-violet-100',
    teal: 'bg-teal-100',
    orange: 'bg-orange-100',
  };
  const trackBg = barTrackMap[color] ?? barTrackMap.indigo;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-5">{title}</h3>
      <div className="space-y-4">
        {sorted.map(([label, value]) => (
          <div key={label}>
            <div className="flex justify-between text-sm mb-1.5">
              <span className="text-gray-700 font-medium">{formatLabel ? formatLabel(label) : label}</span>
              <span className="text-gray-500 tabular-nums">{(value ?? 0).toLocaleString()}</span>
            </div>
            <div className={`w-full ${trackBg} rounded-full h-2.5`}>
              <div
                className={`${barBg} h-2.5 rounded-full transition-all duration-500`}
                style={{ width: `${(value / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Data coverage donut-style metric ────────────────────────────────
function CoverageCard({
  label,
  value,
  total,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  total: number;
  icon: React.ElementType;
  color: string;
}) {
  const safeValue = value ?? 0;
  const safeTotal = total ?? 0;
  const pct = safeTotal > 0 ? Math.round((safeValue / safeTotal) * 100) : 0;

  const ringColorMap: Record<string, string> = {
    sky: 'text-sky-500',
    violet: 'text-violet-500',
    teal: 'text-teal-500',
  };
  const ringColor = ringColorMap[color] ?? 'text-sky-500';

  const circumference = 2 * Math.PI * 40;
  const dashOffset = circumference - (pct / 100) * circumference;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 flex flex-col items-center">
      <div className="relative w-28 h-28 mb-4">
        <svg className="w-28 h-28 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill="none" className="text-gray-100" stroke="currentColor" strokeWidth="10" />
          <circle
            cx="50"
            cy="50"
            r="40"
            fill="none"
            className={ringColor}
            stroke="currentColor"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 0.6s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xl font-bold text-gray-900">{pct}%</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`w-4 h-4 ${ringColor}`} />
        <span className="text-sm font-semibold text-gray-900">{label}</span>
      </div>
      <p className="text-sm text-gray-500">
        {safeValue.toLocaleString()} / {safeTotal.toLocaleString()}
      </p>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────
export default function AdminStatsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAllowed = ME_DATA_ALLOWED_USER_IDS.has(user?.id ?? '');

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        setError('No active session');
        return;
      }

      const res = await fetch('/api/admin-stats', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }

      const data: AdminStats = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch admin stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAllowed) {
      router.replace('/');
      return;
    }
    fetchStats();
  }, [isAllowed, router, fetchStats]);

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
                    <h1 className="text-2xl font-bold text-gray-900">Admin Stats</h1>
                    <p className="text-sm text-gray-500">Investor database overview</p>
                  </div>
                </div>
                <button
                  onClick={fetchStats}
                  disabled={loading}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>

              {/* Loading */}
              {loading && !stats && (
                <div className="flex items-center justify-center min-h-[400px]">
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
                    <span className="text-gray-500">Loading admin stats...</span>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && !loading && (
                <div className="flex items-center justify-center min-h-[400px]">
                  <div className="text-center">
                    <p className="text-accent-red font-medium">Failed to load stats</p>
                    <p className="text-sm text-gray-600 mt-1">{error}</p>
                    <button
                      onClick={fetchStats}
                      className="mt-4 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              {/* Stats */}
              {stats && (
                <div className="space-y-8">
                  {/* ─── Summary Cards ─────────────────── */}
                  <section>
                    <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <Users className="w-5 h-5 text-indigo-600" />
                      Overview
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      <StatCard label="Total Investors" value={stats.total_investors} icon={Users} color="indigo" />
                      <StatCard label="Total Firms" value={stats.total_firms} icon={Building2} color="emerald" />
                      <StatCard label="Total People" value={stats.total_people} icon={Users} color="violet" />
                      <StatCard label="Active Investors" value={stats.active_investors} icon={UserCheck} color="teal" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
                      <StatCard label="Inactive Investors" value={stats.inactive_investors} icon={UserX} color="rose" />
                      <StatCard label="With Domain" value={stats.investors_with_domain} icon={Globe} color="sky" />
                      <StatCard label="With LinkedIn" value={stats.investors_with_linkedin} icon={Linkedin} color="amber" />
                      <StatCard label="With Email" value={stats.investors_with_email} icon={Mail} color="orange" />
                    </div>
                  </section>

                  {/* ─── Data Coverage ─────────────────── */}
                  <section>
                    <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <Globe className="w-5 h-5 text-indigo-600" />
                      Data Coverage
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <CoverageCard
                        label="Domain"
                        value={stats.investors_with_domain}
                        total={stats.total_investors}
                        icon={Globe}
                        color="sky"
                      />
                      <CoverageCard
                        label="LinkedIn"
                        value={stats.investors_with_linkedin}
                        total={stats.total_investors}
                        icon={Linkedin}
                        color="violet"
                      />
                      <CoverageCard
                        label="Email"
                        value={stats.investors_with_email}
                        total={stats.total_investors}
                        icon={Mail}
                        color="teal"
                      />
                    </div>
                  </section>

                  {/* ─── Breakdown Charts ──────────────── */}
                  <section>
                    <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <Building2 className="w-5 h-5 text-indigo-600" />
                      Breakdowns
                    </h2>
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                      <HorizontalBarChart
                        title="By Country"
                        data={stats.investors_by_country ?? {}}
                        color="indigo"
                        formatLabel={(code) => getCountryName(code) || code}
                      />
                      <HorizontalBarChart
                        title="By Tier"
                        data={stats.investors_by_tier ?? {}}
                        color="emerald"
                      />
                      <HorizontalBarChart
                        title="By Stage"
                        data={stats.investors_by_stage ?? {}}
                        color="amber"
                        formatLabel={formatKebabLabel}
                      />
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}
