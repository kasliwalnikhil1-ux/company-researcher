'use client';

import { useState, useEffect } from 'react';
import { useCompanies, CompanyCountByOwner } from '@/contexts/CompaniesContext';
import { useOwner } from '@/contexts/OwnerContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import {
  BarChart3,
  TrendingUp,
  Users,
  Target,
  Globe,
  Layers,
  Briefcase,
  Loader2,
} from 'lucide-react';
import { fetchInvestorAnalytics, type InvestorAnalytics } from '@/lib/api';
import { getCountryName } from '@/lib/isoCodes';

type AnalyticsPeriod = 'today' | 'yesterday' | 'week' | 'month';

const formatKebabLabel = (value: string): string =>
  value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

// B2B Analytics — Company counts by owner
function B2BAnalytics() {
  const { getCompanyCountsByOwner } = useCompanies();
  const { ownerColors } = useOwner();
  const [period, setPeriod] = useState<AnalyticsPeriod>('today');
  const [data, setData] = useState<CompanyCountByOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        const result = await getCompanyCountsByOwner(period);
        setData(result);
      } catch (err) {
        console.error('Error fetching analytics data:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch analytics data');
        setData([]);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [period, getCompanyCountsByOwner]);

  const getBarColor = (owner: string) => ownerColors[owner]?.hex || '#254bf1';

  const getPeriodLabel = (p: AnalyticsPeriod) => {
    switch (p) {
      case 'today':
        return 'Today';
      case 'yesterday':
        return 'Yesterday';
      case 'week':
        return 'Last Week';
      case 'month':
        return 'Last Month';
      default:
        return p;
    }
  };

  return (
    <>
      <div className="mb-6">
        <label htmlFor="period" className="block text-sm font-medium text-gray-700 mb-2">
          Time Period
        </label>
        <select
          id="period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as AnalyticsPeriod)}
          className="w-full max-w-xs px-4 py-2 border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        >
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="week">Last Week</option>
          <option value="month">Last Month</option>
        </select>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        {loading ? (
          <div className="flex items-center justify-center h-96">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
              <span className="text-gray-500">Loading analytics...</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-96">
            <div className="text-center">
              <p className="text-accent-red font-medium">Error loading data</p>
              <p className="text-sm text-gray-600 mt-1">{error}</p>
            </div>
          </div>
        ) : data.length === 0 ? (
          <div className="flex items-center justify-center h-96">
            <div className="text-center text-gray-500">
              <p>No data available for {getPeriodLabel(period)}</p>
              <p className="text-sm mt-1">Try selecting a different time period</p>
            </div>
          </div>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Company Counts by Owner — {getPeriodLabel(period)}
            </h2>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart
                data={data}
                margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="owner" tick={{ fill: '#6b7280' }} style={{ fontSize: '14px' }} />
                <YAxis tick={{ fill: '#6b7280' }} style={{ fontSize: '14px' }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                  }}
                />
                <Legend />
                <Bar dataKey="total" name="Companies">
                  {data.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={getBarColor(entry.owner)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </>
  );
}

// Fundraising Analytics — Investor funnel, fit, activity, geography, stages, industries
function FundraisingAnalytics() {
  const [data, setData] = useState<InvestorAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        const result = await fetchInvestorAnalytics();
        setData(result ?? null);
      } catch (err) {
        console.error('Error fetching investor analytics:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch investor analytics');
        setData(null);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
          <span className="text-gray-500">Loading investor analytics...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <p className="text-accent-red font-medium">Error loading data</p>
          <p className="text-sm text-gray-600 mt-1">{error}</p>
        </div>
      </div>
    );
  }

  const funnel = data?.funnel;
  const fit = data?.fit;
  const activity = data?.activity;
  const geography = data?.geography ?? [];
  const stages = data?.stages ?? [];
  const industries = data?.industries ?? [];

  const funnelSteps = funnel
    ? [
        { name: 'Total', value: funnel.total, fill: '#6366f1' },
        { name: 'Identified', value: funnel.identified, fill: '#818cf8' },
        { name: 'Contacted', value: funnel.contacted, fill: '#a5b4fc' },
        { name: 'Interested', value: funnel.interested, fill: '#c7d2fe' },
        { name: 'Passed', value: funnel.passed, fill: '#e0e7ff' },
        { name: 'Funded', value: funnel.funded, fill: '#4ade80' },
        { name: 'Unreviewed', value: funnel.unreviewed, fill: '#94a3b8' },
      ]
    : [];

  const fitData = fit
    ? [
        { name: 'Strong Fit', value: fit.fit_true, emoji: '😊', fill: '#22c55e' },
        { name: 'Weak Fit', value: fit.fit_false, emoji: '😕', fill: '#f59e0b' },
        { name: 'Unclear Fit', value: fit.fit_unknown, emoji: '😐', fill: '#94a3b8' },
      ]
    : [];

  const geographyData = geography.map((g) => ({
    name: getCountryName(g.hq_country) || g.hq_country,
    count: g.count,
  }));

  const stagesData = stages.map((s) => ({
    name: formatKebabLabel(s.stage),
    count: s.count,
  }));

  const industriesData = industries.map((i) => ({
    name: formatKebabLabel(i.industry),
    count: i.count,
  }));

  const tooltipStyle = {
    backgroundColor: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
  };

  return (
    <div className="space-y-8">
      {/* Funnel Section */}
      {funnel && (
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-indigo-600" />
            Investor Funnel
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
            {funnelSteps.map((step) => (
              <div
                key={step.name}
                className="rounded-lg border border-gray-200 p-4 text-center"
                style={{ borderTopColor: step.fill, borderTopWidth: 3 }}
              >
                <p className="text-2xl font-bold text-gray-900">{step.value}</p>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mt-1">
                  {step.name}
                </p>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={funnelSteps} layout="vertical" margin={{ top: 5, right: 30, left: 80, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis type="number" tick={{ fill: '#6b7280' }} />
              <YAxis type="category" dataKey="name" tick={{ fill: '#6b7280' }} width={70} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number | undefined) => [v ?? 0, 'Count']} />
              <Bar dataKey="value" name="Count" radius={[0, 4, 4, 0]}>
                {funnelSteps.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      {/* Fit & Activity Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Fit Section — matches InvestorDetailsDrawer: Strong Fit 😊, Weak Fit 😕, Unclear Fit 😐 */}
        {fit && (
          <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Target className="w-5 h-5 text-indigo-600" />
              Fit Assessment
            </h2>
            <div className="flex items-center gap-4 mb-4">
              {fitData.map((item) => (
                <div key={item.name} className="flex items-center gap-2">
                  <span className="text-xl" role="img" aria-label={item.name}>
                    {item.name === 'Strong Fit' ? '😊' : item.name === 'Weak Fit' ? '😕' : '😐'}
                  </span>
                  <span className="text-sm font-medium text-gray-700">{item.name}</span>
                  <span className="text-lg font-bold text-gray-900">{item.value}</span>
                </div>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={fitData} margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 12 }} />
                <YAxis tick={{ fill: '#6b7280' }} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="value" name="Investors" radius={[4, 4, 0, 0]}>
                  {fitData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </section>
        )}

        {/* Activity Section */}
        {activity && (
          <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Users className="w-5 h-5 text-indigo-600" />
              Recent Activity
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-5">
                <p className="text-3xl font-bold text-indigo-700">{activity.added_last_7d}</p>
                <p className="text-sm font-medium text-indigo-600 mt-1">Added last 7 days</p>
              </div>
              <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-5">
                <p className="text-3xl font-bold text-indigo-700">{activity.added_last_30d}</p>
                <p className="text-sm font-medium text-indigo-600 mt-1">Added last 30 days</p>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Geography, Stages, Industries */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Geography */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Globe className="w-5 h-5 text-indigo-600" />
            Geography
          </h2>
          {geographyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={geographyData} margin={{ top: 5, right: 5, left: 5, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 11 }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: '#6b7280' }} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number | undefined) => [v ?? 0, 'Investors']} />
                <Bar dataKey="count" name="Investors" fill="#6366f1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-gray-500 py-8 text-center">No geography data</p>
          )}
        </section>

        {/* Stages */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Layers className="w-5 h-5 text-indigo-600" />
            Investment Stages
          </h2>
          {stagesData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={stagesData} margin={{ top: 5, right: 5, left: 5, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 11 }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: '#6b7280' }} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number | undefined) => [v ?? 0, 'Investors']} />
                <Bar dataKey="count" name="Investors" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-gray-500 py-8 text-center">No stage data</p>
          )}
        </section>

        {/* Industries */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-indigo-600" />
            Industries
          </h2>
          {industriesData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={industriesData} margin={{ top: 5, right: 5, left: 5, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 11 }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: '#6b7280' }} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number | undefined) => [v ?? 0, 'Investors']} />
                <Bar dataKey="count" name="Investors" fill="#06b6d4" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-gray-500 py-8 text-center">No industry data</p>
          )}
        </section>
      </div>

      {!funnel && !fit && !activity && geography.length === 0 && stages.length === 0 && industries.length === 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500">No investor analytics data yet.</p>
          <p className="text-sm text-gray-400 mt-1">Add investors to your pipeline to see analytics.</p>
        </div>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const { onboarding, loading: onboardingLoading } = useOnboarding();
  const primaryUse = onboarding?.step0?.primaryUse;

  const isFundraising = primaryUse === 'fundraising';
  const isB2B = primaryUse === 'b2b';

  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="relative flex-1 overflow-auto bg-secondary-default">
            <div className="absolute inset-0 -z-0 w-full h-full bg-[linear-gradient(to_right,#80808012_1px,transparent_0px),linear-gradient(to_bottom,#80808012_1px,transparent_0px)] bg-[size:60px_60px]" />
            <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              <div className="flex items-center gap-3 mb-8">
                <div className="p-2 bg-indigo-100 rounded-lg">
                  <BarChart3 className="w-6 h-6 text-indigo-600" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
                  <p className="text-sm text-gray-500">
                    {onboardingLoading
                      ? 'Loading...'
                      : isFundraising
                        ? 'Investor pipeline funnel, fit, and activity'
                        : isB2B
                          ? 'View company counts by owner'
                          : 'View company counts by owner'}
                  </p>
                </div>
              </div>

              {onboardingLoading ? (
                <div className="flex items-center justify-center min-h-[300px]">
                  <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
                </div>
              ) : isFundraising ? (
                <FundraisingAnalytics />
              ) : (
                <B2BAnalytics />
              )}
            </div>
          </div>
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}
