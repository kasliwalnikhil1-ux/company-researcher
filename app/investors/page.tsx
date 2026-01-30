'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import Toast from '@/components/ui/Toast';
import InvestorDetailsDrawer from '@/components/ui/InvestorDetailsDrawer';
import ReportMissingInvestorsModal from '@/components/ui/ReportMissingInvestorsModal';
import InsufficientCreditsModal from '@/components/ui/InsufficientCreditsModal';
import {
  useInvestorSearch,
  fetchInvestorById,
  type InvestorSearchFilters,
  type InvestorSearchResult,
  type InvestorTypeFilter,
} from '@/hooks/useInvestorSearch';
import {
  Handshake,
  Filter,
  ChevronDown,
  Eye,
  X,
  Search,
  Check,
  Sparkles,
  Loader2,
  Globe,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { formatHqLocationShort } from '@/lib/isoCodes';
import { Skeleton } from '@/components/ui/skeleton';
import { CALENDLY_URL } from '@/components/BookDemoButton';
import { fetchInvestorAnalyze } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useOwner } from '@/contexts/OwnerContext';
import { supabase } from '@/utils/supabase/client';

// Filter options - must match search_investors RPC
const INVESTOR_TYPE_OPTIONS = [
  'VC',
  'Angel',
  'PE',
  'Corporate Venture',
  'Family Office',
  'Accelerator',
  'Fund of Funds',
  'Other',
];

const STAGE_OPTIONS = [
  'pre-seed',
  'seed',
  'post-seed',
  'series-a',
  'series-b',
  'series-c',
  'growth',
  'late-stage',
  'pre-ipo',
  'public-equity',
  'angel',
];

const INDUSTRY_OPTIONS = [
  'artificial-intelligence',
  'machine-learning',
  'healthtech',
  'biotech',
  'digital-health',
  'mental-health',
  'wellness',
  'longevity',
  'fitness',
  'consumer-health',
  'medtech',
  'pharma',
  'genomics',
  'bioinformatics',
  'neuroscience',
  'consumer-tech',
  'enterprise-software',
  'saas',
  'vertical-saas',
  'developer-tools',
  'productivity',
  'collaboration',
  'fintech',
  'payments',
  'lending',
  'credit',
  'insurtech',
  'regtech',
  'wealthtech',
  'climate-tech',
  'energy',
  'clean-energy',
  'carbon-removal',
  'sustainability',
  'web3',
  'blockchain',
  'crypto',
  'defi',
  'nft',
  'social-platforms',
  'marketplaces',
  'creator-economy',
  'edtech',
  'hr-tech',
  'future-of-work',
  'mobility',
  'transportation',
  'autonomous-vehicles',
  'robotics',
  'hardware',
  'deep-tech',
  'semiconductors',
  'data-infrastructure',
  'cloud-infrastructure',
  'devops',
  'cybersecurity',
  'security',
  'privacy',
  'identity',
  'digital-identity',
  'consumer-internet',
  'ecommerce',
  'retail-tech',
  'proptech',
  'real-estate',
  'construction-tech',
  'smart-cities',
  'supply-chain',
  'logistics',
  'manufacturing',
  'industrial-tech',
  'agtech',
  'foodtech',
  'gaming',
  'esports',
  'media',
  'entertainment',
  'music-tech',
  'sports-tech',
  'travel-tech',
  'hospitality',
  'martech',
  'adtech',
  'legal-tech',
  'govtech',
  'defense-tech',
  'space-tech',
  'aerospace',
  'iot',
  'edge-computing',
  'network-effects',
];

// ISO 3166-2: country codes (alpha-2) and common subdivisions
const GEOGRAPHY_OPTIONS = [
  'US',
  'GB',
  'DE',
  'FR',
  'IN',
  'CA',
  'SG',
  'AU',
  'NL',
  'IL',
  'CH',
  'SE',
  'ES',
  'IT',
  'JP',
  'CN',
  'KR',
  'BR',
  'MX',
  'ZA',
  'EU',
  'LATAM',
  'APAC',
  'EMEA',
];

const ROLE_OPTIONS = [
  'CEO / Founder',
  'Partner',
  'Managing Partner',
  'General Partner',
  'Principal',
  'Venture Partner',
  'Operating Partner',
  'Independent Investor / Angel',
  'Associate',
  'Research Analyst',
  'Scout',
];

// Reviewed tab only: pipeline stage options
const REVIEWED_STAGE_OPTIONS = [
  'Identified',
  'Seeking Intro',
  'Call Scheduled',
  'Due Diligence',
  'Verbal Agreement',
  'Closed/Signed',
  'Closed/Lost',
  'Disappeared',
];

// Investor fit: Strong Fit -> true, Weak Fit -> false, Unclear Fit -> null
const INVESTOR_FIT_OPTIONS: { value: boolean | null; label: string }[] = [
  { value: true, label: '😊 Strong Fit' },
  { value: false, label: '😕 Weak Fit' },
  { value: null, label: '😐 Unclear Fit' },
];

const DEFAULT_FILTERS: InvestorSearchFilters = {
  type: 'firm',
  mode: 'global',
  name: '',
  active: null,
  role: null,
  hq_state: null,
  hq_country: null,
  investor_type: [],
  fund_size_min: null,
  fund_size_max: null,
  check_size_min: null,
  check_size_max: null,
  investment_stages: [],
  investment_industries: [],
  investment_geographies: [],
  leads_round: null,
  reviewed_stage: [],
  set: [],
  owner: [],
  investor_fit: [],
};

const formatKebabLabel = (value: string): string =>
  value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

function parseNumericInput(value: string): number | null {
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export default function InvestorsPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <InvestorsContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function InvestorsContent() {
  const { user } = useAuth();
  const { availableOwners, isFreePlan } = useOwner();
  const [investorSets, setInvestorSets] = useState<string[]>([]);
  const [filters, setFilters] = useState<InvestorSearchFilters>(DEFAULT_FILTERS);
  const [localSearchInput, setLocalSearchInput] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [investorToView, setInvestorToView] = useState<InvestorSearchResult | null>(null);
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const [reportMissingModalOpen, setReportMissingModalOpen] = useState(false);
  const [insufficientCreditsModalOpen, setInsufficientCreditsModalOpen] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [showCelebration, setShowCelebration] = useState(false);
  /** Pending analyze results for immediate card update before refresh completes */
  const [pendingAnalyzeResults, setPendingAnalyzeResults] = useState<
    Record<string, { investor_fit: boolean | null; reason: string | null }>
  >({});
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const pageSize = isFreePlan ? 5 : 20;
  const { data, loading, error, hasMore, page, setPage, loadMore, refresh } =
    useInvestorSearch({ filters, pageSize });

  // Fetch investor sets (used in drawer pipeline and reviewed filters)
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: sets, error } = await supabase.rpc('get_investor_sets');
      if (mounted && !error && Array.isArray(sets)) {
        setInvestorSets(sets.filter((s): s is string => typeof s === 'string'));
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Sync drawer investor with refreshed data (e.g. after analyze) so personalization fields appear
  useEffect(() => {
    if (investorToView && data.length > 0) {
      const refreshed = data.find((i) => i.id === investorToView.id);
      if (refreshed && refreshed !== investorToView) {
        setInvestorToView(refreshed);
      }
    }
  }, [data, investorToView]);

  const updateInvestor = useCallback(
    async (
      investorId: string,
      updates: {
        notes?: Array<{ message: string; date: string }> | null;
        owner?: string | null;
        set_name?: string | null;
        stage?: string | null;
        ai_metadata?: Record<string, unknown> | null;
      }
    ) => {
      if (!user?.id) throw new Error('User must be logged in');
      const payload: Record<string, unknown> = {};
      if ('notes' in updates) payload.notes = updates.notes ?? null;
      if ('owner' in updates) payload.owner = updates.owner ?? null;
      if ('set_name' in updates) payload.set_name = updates.set_name ?? null;
      if ('stage' in updates) payload.stage = updates.stage ?? null;
      if ('ai_metadata' in updates) payload.ai_metadata = updates.ai_metadata ?? null;
      if (Object.keys(payload).length === 0) return;

      const { error } = await supabase
        .from('investor_personalization')
        .update(payload)
        .eq('investor_id', investorId)
        .eq('user_id', user.id);

      if (error) {
        console.error('Error updating investor personalization:', error);
        throw new Error(error.message || 'Failed to update investor');
      }

      setInvestorToView((prev) =>
        prev?.id === investorId ? { ...prev, ...payload } : prev
      );
      refresh();
    },
    [user?.id, refresh]
  );

  const handleAnalyze = useCallback(
    async (investorId: string, investorName?: string) => {
      setAnalyzingId(investorId);
      const result = await fetchInvestorAnalyze(investorId);
      setAnalyzingId(null);
      if (result?.error) {
        if (result.errorCode === 'INSUFFICIENT_CREDITS') {
          setInsufficientCreditsModalOpen(true);
        } else {
          setToastMessage(result.error);
          setToastVisible(true);
        }
      } else {
        const name = investorName?.trim() || 'Investor';
        const investorFit = result?.investor_fit ?? null;
        const reason = result?.reason ?? null;

        // Update card immediately with investor_fit and reason
        setPendingAnalyzeResults((prev) => ({
          ...prev,
          [investorId]: { investor_fit: investorFit, reason },
        }));

        if (investorFit === true) {
          setShowCelebration(true);
          setToastMessage(`${name} is a strong fit for your company`);
          setTimeout(() => setShowCelebration(false), 3500);
        } else {
          setToastMessage('Investor analyzed successfully.');
        }
        setToastVisible(true);
        refresh();

        // If good fit or null, fetch full investor and auto-open drawer
        if (investorFit === true || investorFit === null) {
          const fullInvestor = await fetchInvestorById(investorId, {
            type: filters.type,
            mode: filters.mode,
          });
          if (fullInvestor) {
            setInvestorToView({
              ...fullInvestor,
              has_personalization: true,
              ai_metadata: {
                ...fullInvestor.ai_metadata,
                investor_fit: investorFit,
                reason,
              },
            });
            setDrawerOpen(true);
          }
        }

        // Clear pending result after a short delay (refresh will have updated data)
        setTimeout(() => {
          setPendingAnalyzeResults((prev) => {
            const next = { ...prev };
            delete next[investorId];
            return next;
          });
        }, 2000);
      }
    },
    [refresh, filters.type, filters.mode]
  );

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, name: localSearchInput.trim() }));
    }, 400);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [localSearchInput]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      setFilters((prev) => ({ ...prev, name: localSearchInput.trim() }));
    }
  };

  const handleClearSearch = () => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    setLocalSearchInput('');
    setFilters((prev) => ({ ...prev, name: '' }));
  };

  const updateFilter = useCallback(<K extends keyof InvestorSearchFilters>(
    key: K,
    value: InvestorSearchFilters[K]
  ) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleArrayFilter = useCallback((
    key: 'investor_type' | 'investment_stages' | 'investment_industries' | 'investment_geographies' | 'reviewed_stage' | 'set' | 'owner',
    item: string
  ) => {
    setFilters((prev) => {
      const arr = prev[key];
      const next = arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];
      return { ...prev, [key]: next };
    });
  }, []);

  const toggleInvestorFitFilter = useCallback((value: boolean | null) => {
    setFilters((prev) => {
      const arr = prev.investor_fit;
      const has = arr.some((v) => v === value);
      const next = has ? arr.filter((v) => v !== value) : [...arr, value];
      return { ...prev, investor_fit: next };
    });
  }, []);

  const buildReportContent = () => {
    const parts: string[] = [];
    if (filters.name) parts.push(`Search: ${filters.name}`);
    if (filters.investment_stages.length) parts.push(`Stage: ${filters.investment_stages.join(', ')}`);
    if (filters.investment_industries.length) parts.push(`Industry: ${filters.investment_industries.join(', ')}`);
    if (filters.investment_geographies.length) parts.push(`Geography: ${filters.investment_geographies.join(', ')}`);
    if (filters.hq_country) parts.push(`Country: ${filters.hq_country}`);
    if (filters.mode === 'reviewed') {
      if (filters.reviewed_stage.length) parts.push(`Pipeline Stage: ${filters.reviewed_stage.join(', ')}`);
      if (filters.set.length) parts.push(`Sets: ${filters.set.join(', ')}`);
      if (filters.owner.length) parts.push(`Owners: ${filters.owner.join(', ')}`);
      if (filters.investor_fit.length) {
        const labels = filters.investor_fit.map((v) =>
          v === true ? 'Strong Fit' : v === false ? 'Weak Fit' : 'Unclear Fit'
        );
        parts.push(`Investor Fit: ${labels.join(', ')}`);
      }
    }
    return parts.length ? parts.join('\n') : 'No search terms or filters applied';
  };

  // Infinite scroll observer
  useEffect(() => {
    if (!hasMore || loading) return;
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '100px', threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  const handleDrawerPageChange = useCallback(
    (newPage: number) => {
      if (newPage > page && hasMore && !loading) {
        loadMore();
      }
    },
    [page, hasMore, loading, loadMore]
  );

  return (
    <div className="p-4 md:p-8 max-w-full mx-auto">
      <div className="mb-4 md:mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Handshake className="w-6 h-6 md:w-8 md:h-8" />
          Investors
        </h1>
        {/* All / Reviewed toggle */}
        <div className="inline-flex items-center border border-gray-300 rounded-md overflow-hidden bg-white self-start">
          <button
            onClick={() => updateFilter('mode', 'global')}
            className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center gap-1.5 text-sm font-medium ${
              filters.mode === 'global'
                ? 'text-white bg-indigo-600 hover:bg-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="All investors"
          >
            <Globe className="w-4 h-4" />
            All
          </button>
          <div className="h-6 w-px bg-gray-300" />
          <button
            onClick={() => updateFilter('mode', 'reviewed')}
            className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center gap-1.5 text-sm font-medium ${
              filters.mode === 'reviewed'
                ? 'text-white bg-indigo-600 hover:bg-indigo-700'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
            title="Reviewed investors only"
          >
            <CheckCircle2 className="w-4 h-4" />
            Reviewed
          </button>
        </div>
      </div>

      {/* Search form */}
      <div className="mb-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex flex-1 gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name, domain, or LinkedIn..."
                value={localSearchInput}
                onChange={(e) => setLocalSearchInput(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 text-sm"
              />
              {localSearchInput && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <select
              value={filters.type}
              onChange={(e) => {
                const newType = e.target.value as InvestorTypeFilter;
                setFilters((prev) => ({
                  ...prev,
                  type: newType,
                  role: newType === 'firm' ? null : prev.role,
                }));
              }}
              className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 min-w-[120px]"
            >
              <option value="firm">Firm</option>
              <option value="person">Person</option>
            </select>
          </div>
          <button
            onClick={() => setFiltersExpanded(!filtersExpanded)}
            className={`inline-flex items-center gap-2 px-4 py-2 border rounded-md text-sm font-medium ${
              filtersExpanded
                ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
            }`}
          >
            <Filter className="w-4 h-4" />
            Filters
            <ChevronDown className={`w-4 h-4 transition-transform ${filtersExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {/* Expanded filters */}
        {filtersExpanded && (
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <MultiSelectFilter
                label="Investor type"
                options={INVESTOR_TYPE_OPTIONS}
                selected={filters.investor_type}
                onToggle={(item) => toggleArrayFilter('investor_type', item)}
              />
              <MultiSelectFilter
                label="Stages"
                options={STAGE_OPTIONS}
                selected={filters.investment_stages}
                onToggle={(item) => toggleArrayFilter('investment_stages', item)}
                formatLabel={formatKebabLabel}
              />
              <MultiSelectFilter
                label="Industries"
                options={INDUSTRY_OPTIONS}
                selected={filters.investment_industries}
                onToggle={(item) => toggleArrayFilter('investment_industries', item)}
                formatLabel={formatKebabLabel}
              />
              <MultiSelectFilter
                label="Geographies"
                options={GEOGRAPHY_OPTIONS}
                selected={filters.investment_geographies}
                onToggle={(item) => toggleArrayFilter('investment_geographies', item)}
              />
              {filters.type === 'person' && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Role</label>
                  <select
                    value={filters.role ?? ''}
                    onChange={(e) => updateFilter('role', e.target.value || null)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="">All roles</option>
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <NumericRangeInput
                label="Fund size (USD) min"
                value={filters.fund_size_min}
                onChange={(v) => updateFilter('fund_size_min', v)}
                placeholder="e.g. 1000000"
              />
              <NumericRangeInput
                label="Fund size (USD) max"
                value={filters.fund_size_max}
                onChange={(v) => updateFilter('fund_size_max', v)}
                placeholder="e.g. 100000000"
              />
              <NumericRangeInput
                label="Check size (USD) min"
                value={filters.check_size_min}
                onChange={(v) => updateFilter('check_size_min', v)}
                placeholder="e.g. 100000"
              />
              <NumericRangeInput
                label="Check size (USD) max"
                value={filters.check_size_max}
                onChange={(v) => updateFilter('check_size_max', v)}
                placeholder="e.g. 5000000"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">HQ Country</label>
                <input
                  type="text"
                  placeholder="e.g. US, India, United States"
                  value={filters.hq_country ?? ''}
                  onChange={(e) => updateFilter('hq_country', e.target.value.trim() || null)}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">HQ State / Region</label>
                <input
                  type="text"
                  placeholder="e.g. US-CA, Tamil Nadu, California"
                  value={filters.hq_state ?? ''}
                  onChange={(e) => updateFilter('hq_state', e.target.value.trim() || null)}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-4 items-center">
              <ToggleFilter
                label="Active"
                value={filters.active}
                onChange={(v) => updateFilter('active', v)}
              />
              <ToggleFilter
                label="Leads round"
                value={filters.leads_round}
                onChange={(v) => updateFilter('leads_round', v)}
              />
            </div>
            {/* Reviewed tab only: Stage, Sets, Owners, Investor Fit */}
            {filters.mode === 'reviewed' && (
              <div className="pt-4 border-t border-gray-200">
                <p className="text-xs font-medium text-gray-500 mb-3">Pipeline Filters</p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <MultiSelectFilter
                    label="Stage"
                    options={REVIEWED_STAGE_OPTIONS}
                    selected={filters.reviewed_stage}
                    onToggle={(item) => toggleArrayFilter('reviewed_stage', item)}
                  />
                  <InvestorFitFilter
                    options={INVESTOR_FIT_OPTIONS}
                    selected={filters.investor_fit}
                    onToggle={toggleInvestorFitFilter}
                  />
                  <MultiSelectFilter
                    label="Sets"
                    options={investorSets}
                    selected={filters.set}
                    onToggle={(item) => toggleArrayFilter('set', item)}
                  />
                  <MultiSelectFilter
                    label="Owners"
                    options={availableOwners}
                    selected={filters.owner}
                    onToggle={(item) => toggleArrayFilter('owner', item)}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error.message}
        </div>
      )}

      {/* Loading state */}
      {loading && data.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500" />
        </div>
      ) : data.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 md:p-12 text-center">
          <Handshake className="w-10 h-10 md:w-12 md:h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-sm md:text-base text-gray-500 mb-4">
            {filters.name || filters.investment_stages.length || filters.investment_industries.length ||
             filters.investment_geographies.length || filters.investor_type.length ||
             filters.reviewed_stage.length || filters.set.length || filters.owner.length || filters.investor_fit.length
              ? 'No investors found matching your filters.'
              : 'No investors found. Try adjusting your search or filters.'}
          </p>
          <p className="text-sm text-gray-600 mb-3">Spot a missing investor? Tell us and we&apos;ll add them for free.</p>
          <button
            onClick={() => setReportMissingModalOpen(true)}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
          >
            Report Missing Investors
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            {loading && data.length > 0 && (
              <div className="absolute inset-0 bg-white/60 flex items-center justify-center z-10 rounded-lg">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-500" />
              </div>
            )}
            <div className="space-y-3">
              {data.map((investor) => (
                <InvestorResultCard
                  key={investor.id}
                  investor={investor}
                  pendingAnalyze={pendingAnalyzeResults[investor.id]}
                  onView={() => {
                    setInvestorToView(investor);
                    setDrawerOpen(true);
                  }}
                onAnalyze={() => handleAnalyze(investor.id, investor.name)}
                isAnalyzing={analyzingId === investor.id}
                />
              ))}
              {/* Free plan: skeletons + Upgrade button below the 5 results */}
              {isFreePlan && data.length > 0 && (
                <div className="relative pt-2">
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <InvestorCardSkeleton key={i} />
                    ))}
                  </div>
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/90 backdrop-blur-sm rounded-lg">
                    <p className="text-sm text-gray-600 text-center">
                    Upgrade your plan to connect with the right investors and complete your raise.
                    </p>
                    <a
                      href={CALENDLY_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-brand-default hover:bg-brand-dark text-white border-2 border-brand-fainter transition-colors shadow-sm"
                    >
                      Upgrade Plan
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Infinite scroll sentinel - hide for free plan (no load more) */}
          {!isFreePlan && hasMore && <div ref={loadMoreRef} className="h-4" />}

          {/* Pagination fallback - show load more button on mobile (hide for free plan) */}
          {!isFreePlan && hasMore && (
            <div className="mt-4 flex justify-center sm:hidden">
              <button
                onClick={() => loadMore()}
                disabled={loading}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                {loading ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {showCelebration && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
          <div className="w-64 h-64 md:w-80 md:h-80">
            <DotLottieReact
              src="/celebrations.lottie"
              loop={false}
              autoplay={true}
              className="w-full h-full"
            />
          </div>
        </div>
      )}

      <Toast message={toastMessage} isVisible={toastVisible} onClose={() => setToastVisible(false)} />

      <InvestorDetailsDrawer
        isOpen={drawerOpen}
        investor={investorToView}
        onClose={() => {
          setDrawerOpen(false);
          setInvestorToView(null);
        }}
        investors={data}
        currentPage={1}
        totalPages={isFreePlan ? 1 : hasMore ? 2 : 1}
        onPageChange={handleDrawerPageChange}
        onInvestorChange={(inv) => setInvestorToView(inv as InvestorSearchResult)}
        onAnalyze={(id) => handleAnalyze(id, investorToView?.name)}
        isAnalyzing={investorToView ? analyzingId === investorToView.id : false}
        updateInvestor={updateInvestor}
        stageOptions={REVIEWED_STAGE_OPTIONS}
        setOptions={investorSets}
        ownerOptions={availableOwners}
      />

      <ReportMissingInvestorsModal
        isOpen={reportMissingModalOpen}
        onClose={() => setReportMissingModalOpen(false)}
        initialContent={buildReportContent()}
        onSuccess={() => {
          setToastMessage("Report submitted successfully. We'll add these investors for you.");
          setToastVisible(true);
        }}
      />

      <InsufficientCreditsModal
        isOpen={insufficientCreditsModalOpen}
        onClose={() => setInsufficientCreditsModalOpen(false)}
      />
    </div>
  );
}

function InvestorFitFilter({
  options,
  selected,
  onToggle,
}: {
  options: { value: boolean | null; label: string }[];
  selected: (boolean | null)[];
  onToggle: (value: boolean | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isSelected = (v: boolean | null) => selected.some((s) => s === v);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
      >
        <span>
          Investor Fit {selected.length ? `(${selected.length})` : ''}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-20 w-full min-w-[200px] bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden">
            <div className="max-h-52 overflow-y-auto py-1">
              {options.map((opt) => (
                <label
                  key={String(opt.value)}
                  className="flex items-center px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={isSelected(opt.value)}
                    onChange={() => onToggle(opt.value)}
                    className="mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-gray-700">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onToggle,
  formatLabel = (v: string) => v,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (item: string) => void;
  formatLabel?: (value: string) => string;
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

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          if (open) setSearch('');
        }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
      >
        <span>
          {label} {selected.length ? `(${selected.length})` : ''}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); setSearch(''); }} />
          <div className="absolute left-0 top-full mt-1 z-20 w-full min-w-[200px] bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden">
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
            <div className="max-h-52 overflow-y-auto py-1">
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

function NumericRangeInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState(value?.toString() ?? '');
  useEffect(() => {
    setInputValue(value?.toString() ?? '');
  }, [value]);
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      <input
        type="text"
        inputMode="numeric"
        placeholder={placeholder}
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          onChange(parseNumericInput(e.target.value));
        }}
        className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
      />
    </div>
  );
}

function ToggleFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <select
        value={value === null ? 'all' : value ? 'yes' : 'no'}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === 'all' ? null : v === 'yes');
        }}
        className="px-2 py-1 border border-gray-300 rounded text-sm"
      >
        <option value="all">All</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </div>
  );
}

function InvestorCardSkeleton() {
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

function InvestorResultCard({
  investor,
  pendingAnalyze,
  onView,
  onAnalyze,
  isAnalyzing,
}: {
  investor: InvestorSearchResult;
  pendingAnalyze?: { investor_fit: boolean | null; reason: string | null };
  onView: () => void;
  onAnalyze?: (investorId: string) => void;
  isAnalyzing?: boolean;
}) {
  const location = formatHqLocationShort(investor.hq_state, investor.hq_country);
  const thesis = investor.investment_thesis?.trim();

  // Merge ai_metadata with pending analyze result for immediate display
  const aiMeta = investor.ai_metadata ?? {};
  const investorFit =
    pendingAnalyze?.investor_fit !== undefined
      ? pendingAnalyze.investor_fit
      : (aiMeta.investor_fit as boolean | null | undefined);
  const reason =
    pendingAnalyze?.reason ?? (typeof aiMeta.reason === 'string' ? aiMeta.reason : null);
  const hasFitInfo =
    typeof investorFit === 'boolean' || investorFit === null;
  const hasReason = typeof reason === 'string' && reason.trim().length > 0;

  return (
    <div
      className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm cursor-pointer hover:bg-gray-50 hover:border-gray-300 transition-colors"
      onClick={onView}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-gray-900">{investor.name}</h3>
          {investor.role && <p className="text-sm text-gray-600 mt-0.5">{investor.role}</p>}
          {thesis && <p className="text-sm text-gray-600 mt-1 line-clamp-3 leading-relaxed">{thesis}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {investor.has_personalization && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">
              <Check className="w-3 h-3" />
              Reviewed
            </span>
          )}
          {!investor.has_personalization && onAnalyze && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAnalyze(investor.id);
              }}
              disabled={isAnalyzing}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 flex-shrink-0"
              title="Analyze with AI"
            >
              {isAnalyzing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              Analyze with AI
            </button>
          )}
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
      </div>

      {/* investor_fit and reason - compact display like InvestorDetailsDrawer */}
      {(hasFitInfo || hasReason) && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-1.5">
          {hasFitInfo && (
            <div className="flex items-center gap-2">
              <span className="text-base" role="img" aria-label="fit">
                {investorFit === true ? '😊' : investorFit === false ? '😕' : '😐'}
              </span>
              <span className="text-xs font-medium text-gray-700">
                {investorFit === true ? 'Strong Fit' : investorFit === false ? 'Weak Fit' : 'Unclear Fit'}
              </span>
            </div>
          )}
          {hasReason && (
            <div className="p-2 rounded-md bg-indigo-50 border border-indigo-100">
              <p className="text-xs text-gray-800 line-clamp-2 leading-relaxed">{reason.trim()}</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-2 items-center">
        {location && <span className="text-sm text-gray-500">{location}</span>}
        {Array.isArray(investor.investment_stages) &&
          investor.investment_stages.slice(0, 3).map((s) => (
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
