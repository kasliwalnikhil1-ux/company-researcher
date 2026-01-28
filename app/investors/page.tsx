'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useInvestors, Investor } from '@/contexts/InvestorsContext';
import { supabase } from '@/utils/supabase/client';
import Toast from '@/components/ui/Toast';
import InvestorDetailsDrawer from '@/components/ui/InvestorDetailsDrawer';
import ManageInvestorColumnsDrawer from '@/components/ui/ManageInvestorColumnsDrawer';
import { copyToClipboard } from '@/lib/utils';
import { Handshake, Filter, ChevronLeft, ChevronRight, ChevronDown, Eye, Table, List, X } from 'lucide-react';

const COLUMN_ORDER_KEY = 'investors-column-order';
const COLUMN_VISIBILITY_KEY = 'investors-column-visibility';
const VIEW_MODE_KEY = 'investors-view-mode';

// Common filter options (can be replaced with API later)
const STAGE_OPTIONS = [
  'Pre-seed',
  'Seed',
  'Series A',
  'Series B',
  'Series C',
  'Growth',
  'Late Stage',
];

const INDUSTRY_OPTIONS = [
  'SaaS',
  'Fintech',
  'Healthcare',
  'AI/ML',
  'Consumer',
  'Enterprise',
  'Climate',
  'EdTech',
  'Marketplace',
  'Other',
];

const COUNTRY_OPTIONS = [
  'United States',
  'United Kingdom',
  'Germany',
  'France',
  'India',
  'Canada',
  'Singapore',
  'Other',
];

const DEFAULT_COLUMN_ORDER = [
  'name',
  'role',
  'hq_country',
  'hq_state',
  'investor_type',
  'fund_size_usd',
  'check_size_min_usd',
  'check_size_max_usd',
  'investment_stages',
  'investment_industries',
  'investment_geographies',
  'investment_thesis',
];

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  role: 'Role',
  hq_state: 'HQ State',
  hq_country: 'HQ Country',
  investor_type: 'Investor Type',
  fund_size_usd: 'Fund Size',
  check_size_min_usd: 'Check Min',
  check_size_max_usd: 'Check Max',
  investment_stages: 'Stages',
  investment_industries: 'Industries',
  investment_geographies: 'Geographies',
  investment_thesis: 'Thesis',
};

const formatCurrency = (value: number | null | undefined): string => {
  if (value == null || value === 0) return '-';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value}`;
};

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
  const {
    investors,
    loading,
    searchLoading,
    searchQuery,
    setSearchQuery,
    stageFilter,
    setStageFilter,
    industryFilter,
    setIndustryFilter,
    countryFilter,
    setCountryFilter,
    currentPage,
    setCurrentPage,
    totalCount,
    totalPages,
    pageSize,
    initializeInvestors,
  } = useInvestors();

  useEffect(() => {
    initializeInvestors();
  }, [initializeInvestors]);

  // Load column_settings from user_settings (same as companies)
  const [columnSettingsFromApi, setColumnSettingsFromApi] = useState<{
    investorsColumnOrder?: string[];
    investorsVisibleColumns?: string[];
  } | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('user_settings')
        .select('column_settings')
        .eq('id', user.id)
        .single();
      if (cancelled) return;
      const cs = data?.column_settings;
      if (cs && typeof cs === 'object') {
        const parsed = typeof cs === 'string' ? JSON.parse(cs) : cs;
        if (Array.isArray(parsed.investorsColumnOrder) || Array.isArray(parsed.investorsVisibleColumns)) {
          setColumnSettingsFromApi({
            investorsColumnOrder: parsed.investorsColumnOrder,
            investorsVisibleColumns: parsed.investorsVisibleColumns,
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [investorToView, setInvestorToView] = useState<Investor | null>(null);
  const [pendingPageDirection, setPendingPageDirection] = useState<'next' | 'prev' | null>(null);
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const [localSearchInput, setLocalSearchInput] = useState(searchQuery);
  const [columnFilterOpen, setColumnFilterOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [stageDropdownOpen, setStageDropdownOpen] = useState(false);
  const [industryDropdownOpen, setIndustryDropdownOpen] = useState(false);

  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (investorToView && drawerOpen) {
      const updated = investors.find((i) => i.id === investorToView.id);
      if (updated) setInvestorToView(updated);
      else if (investors.length > 0) {
        if (pendingPageDirection === 'next') setInvestorToView(investors[0]);
        else if (pendingPageDirection === 'prev') setInvestorToView(investors[investors.length - 1]);
        else setInvestorToView(investors[0]);
        setPendingPageDirection(null);
      }
    }
  }, [investors, drawerOpen, pendingPageDirection]);

  useEffect(() => {
    setLocalSearchInput(searchQuery);
  }, [searchQuery]);

  const debouncedSearch = useCallback((query: string) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (query.length === 0) {
      setSearchQuery('');
      return;
    }
    searchTimeoutRef.current = setTimeout(() => setSearchQuery(query.trim()), 400);
  }, [setSearchQuery]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setLocalSearchInput(q);
    debouncedSearch(q);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      setSearchQuery(localSearchInput.trim());
    }
  };

  const handleClearSearch = () => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    setLocalSearchInput('');
    setSearchQuery('');
  };

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [...DEFAULT_COLUMN_ORDER];
    const saved = localStorage.getItem(COLUMN_ORDER_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as string[];
        return parsed.length ? parsed : [...DEFAULT_COLUMN_ORDER];
      } catch {
        return [...DEFAULT_COLUMN_ORDER];
      }
    }
    return [...DEFAULT_COLUMN_ORDER];
  });

  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set(DEFAULT_COLUMN_ORDER);
    const saved = localStorage.getItem(COLUMN_VISIBILITY_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as string[];
        return new Set(parsed.length ? parsed : DEFAULT_COLUMN_ORDER);
      } catch {
        return new Set(DEFAULT_COLUMN_ORDER);
      }
    }
    return new Set(DEFAULT_COLUMN_ORDER);
  });

  // Apply column_settings from API (investors keys) once loaded
  useEffect(() => {
    if (!columnSettingsFromApi) return;
    const saved = columnSettingsFromApi;
    if (Array.isArray(saved.investorsColumnOrder) && saved.investorsColumnOrder.length > 0) {
      const merged = [...saved.investorsColumnOrder];
      DEFAULT_COLUMN_ORDER.forEach((col) => {
        if (!merged.includes(col)) merged.push(col);
      });
      setColumnOrder(merged);
    }
    if (Array.isArray(saved.investorsVisibleColumns) && saved.investorsVisibleColumns.length > 0) {
      const visibleSet = new Set(saved.investorsVisibleColumns);
      DEFAULT_COLUMN_ORDER.forEach((col) => visibleSet.add(col));
      setVisibleColumns(visibleSet);
    }
    setColumnSettingsFromApi(null);
  }, [columnSettingsFromApi]);

  const [viewMode, setViewMode] = useState<'table' | 'list'>(() => {
    if (typeof window === 'undefined') return 'table';
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return saved === 'list' ? 'list' : 'table';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(columnOrder));
  }, [columnOrder]);

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(Array.from(visibleColumns)));
  }, [visibleColumns]);

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  const orderedVisibleColumns = useMemo(
    () => columnOrder.filter((col) => visibleColumns.has(col)),
    [columnOrder, visibleColumns]
  );

  const getCellValue = useCallback((investor: Investor, columnKey: string): string => {
    switch (columnKey) {
      case 'name':
        return investor.name || '-';
      case 'role':
        return investor.role || '-';
      case 'hq_state':
        return investor.hq_state || '-';
      case 'hq_country':
        return investor.hq_country || '-';
      case 'investor_type':
        return Array.isArray(investor.investor_type) ? investor.investor_type.join(', ') : '-';
      case 'fund_size_usd':
        return formatCurrency(investor.fund_size_usd);
      case 'check_size_min_usd':
        return formatCurrency(investor.check_size_min_usd);
      case 'check_size_max_usd':
        return formatCurrency(investor.check_size_max_usd);
      case 'investment_stages':
        return Array.isArray(investor.investment_stages) ? investor.investment_stages.join(', ') : '-';
      case 'investment_industries':
        return Array.isArray(investor.investment_industries) ? investor.investment_industries.join(', ') : '-';
      case 'investment_geographies':
        return Array.isArray(investor.investment_geographies) ? investor.investment_geographies.join(', ') : '-';
      case 'investment_thesis':
        return investor.investment_thesis || '-';
      default:
        return '-';
    }
  }, []);

  const handleCellClick = useCallback(
    async (investor: Investor, columnKey: string) => {
      const value = getCellValue(investor, columnKey);
      if (value && value !== '-') {
        try {
          await copyToClipboard(value);
          setToastMessage(`${COLUMN_LABELS[columnKey]} copied to clipboard`);
          setToastVisible(true);
        } catch {
          setToastMessage('Failed to copy to clipboard');
          setToastVisible(true);
        }
      }
    },
    [getCellValue]
  );

  const toggleColumn = (column: string) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  };

  const persistColumnSettings = useCallback(async () => {
    if (!user?.id) return;
    const { data: existing } = await supabase
      .from('user_settings')
      .select('personalization, owners, email_settings, onboarding, column_settings')
      .eq('id', user.id)
      .single();
    let existingColumnSettings: Record<string, unknown> = {};
    const raw = existing?.column_settings;
    if (raw != null) {
      if (typeof raw === 'string') {
        try {
          existingColumnSettings = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          /* keep {} */
        }
      } else if (typeof raw === 'object' && !Array.isArray(raw)) {
        existingColumnSettings = raw as Record<string, unknown>;
      }
    }
    const payload = {
      id: user.id,
      personalization: existing?.personalization ?? null,
      owners: existing?.owners ?? null,
      email_settings: existing?.email_settings ?? null,
      onboarding: existing?.onboarding ?? null,
      column_settings: {
        ...existingColumnSettings,
        investorsColumnOrder: columnOrder,
        investorsVisibleColumns: Array.from(visibleColumns),
      },
    };
    const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
  }, [user?.id, columnOrder, visibleColumns]);

  const handlePageChange = useCallback(
    (page: number) => {
      const direction = page > currentPage ? 'next' : 'prev';
      setPendingPageDirection(direction);
      setCurrentPage(page);
    },
    [currentPage, setCurrentPage]
  );

  const toggleStage = (stage: string) => {
    setStageFilter(
      stageFilter.includes(stage) ? stageFilter.filter((s) => s !== stage) : [...stageFilter, stage]
    );
  };

  const toggleIndustry = (industry: string) => {
    setIndustryFilter(
      industryFilter.includes(industry)
        ? industryFilter.filter((i) => i !== industry)
        : [...industryFilter, industry]
    );
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-full mx-auto">
      <div className="mb-4 md:mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Handshake className="w-6 h-6 md:w-8 md:h-8" />
          Investors
        </h1>
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          <div className="inline-flex items-center border border-gray-300 rounded-md overflow-hidden bg-white">
            <button
              onClick={() => setViewMode('table')}
              className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center ${
                viewMode === 'table' ? 'text-white bg-indigo-600 hover:bg-indigo-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="Table View"
            >
              <Table className="w-4 h-4" />
            </button>
            <div className="h-6 w-px bg-gray-300" />
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center ${
                viewMode === 'list' ? 'text-white bg-indigo-600 hover:bg-indigo-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
              title="List View"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={() => setColumnFilterOpen(!columnFilterOpen)}
            className="inline-flex items-center px-3 md:px-4 py-2 border border-gray-300 text-xs md:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
          >
            <Filter className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Manage Columns</span>
            <span className="sm:hidden">Columns</span>
          </button>
        </div>
      </div>

      <ManageInvestorColumnsDrawer
        isOpen={columnFilterOpen}
        onClose={() => setColumnFilterOpen(false)}
        columnOrder={columnOrder}
        visibleColumns={visibleColumns}
        columnLabels={COLUMN_LABELS}
        onColumnOrderChange={setColumnOrder}
        onToggleColumn={toggleColumn}
        onSave={async () => {
          try {
            await persistColumnSettings();
            setToastMessage('Column settings saved.');
            setToastVisible(true);
            setColumnFilterOpen(false);
          } catch (e) {
            setToastMessage(e instanceof Error ? e.message : 'Failed to save column settings.');
            setToastVisible(true);
          }
        }}
      />

      <div className="mb-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
        <div className="relative flex-1 max-w-full sm:max-w-md">
          <input
            type="text"
            placeholder="Search investors..."
            value={localSearchInput}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            className="block w-full px-4 py-2 pr-10 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 text-sm"
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
        <button
          onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}
          className="sm:hidden flex items-center justify-center gap-2 px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
        >
          <Filter className="w-4 h-4" />
          <span>Filters</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${mobileFiltersOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Filters */}
      <div
        className={`mb-4 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 sm:gap-4 ${
          mobileFiltersOpen ? 'sm:flex' : 'hidden sm:flex'
        }`}
      >
        <div className="relative">
          <button
            onClick={() => {
              setStageDropdownOpen(!stageDropdownOpen);
              setIndustryDropdownOpen(false);
            }}
            className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Stage {stageFilter.length ? `(${stageFilter.length})` : ''}
            <ChevronDown className="w-4 h-4" />
          </button>
          {stageDropdownOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setStageDropdownOpen(false)} />
              <div className="absolute left-0 top-full mt-1 z-20 w-48 py-2 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                {STAGE_OPTIONS.map((s) => (
                  <label
                    key={s}
                    className="flex items-center px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={stageFilter.includes(s)}
                      onChange={() => toggleStage(s)}
                      className="mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-700">{s}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="relative">
          <button
            onClick={() => {
              setIndustryDropdownOpen(!industryDropdownOpen);
              setStageDropdownOpen(false);
            }}
            className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Industry {industryFilter.length ? `(${industryFilter.length})` : ''}
            <ChevronDown className="w-4 h-4" />
          </button>
          {industryDropdownOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setIndustryDropdownOpen(false)} />
              <div className="absolute left-0 top-full mt-1 z-20 w-48 py-2 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                {INDUSTRY_OPTIONS.map((i) => (
                  <label
                    key={i}
                    className="flex items-center px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={industryFilter.includes(i)}
                      onChange={() => toggleIndustry(i)}
                      className="mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-700">{i}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <select
          value={countryFilter || 'all'}
          onChange={(e) => setCountryFilter(e.target.value === 'all' ? null : e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
        >
          <option value="all">All Countries</option>
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {investors.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 md:p-12 text-center">
          <Handshake className="w-10 h-10 md:w-12 md:h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-sm md:text-base text-gray-500 mb-4">
            {searchQuery || stageFilter.length || industryFilter.length || countryFilter
              ? 'No investors found matching your filters.'
              : 'No investors found.'}
          </p>
        </div>
      ) : viewMode === 'list' ? (
        <div className="space-y-4">
          {investors.map((investor) => (
            <div
              key={investor.id}
              className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm cursor-pointer hover:bg-gray-50 transition-colors"
              onClick={() => {
                setInvestorToView(investor);
                setDrawerOpen(true);
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-gray-900">{investor.name}</h3>
                  {investor.role && (
                    <p className="text-sm text-gray-600 mt-0.5">{investor.role}</p>
                  )}
                  {(investor.hq_state || investor.hq_country) && (
                    <p className="text-sm text-gray-500 mt-1">
                      {[investor.hq_state, investor.hq_country].filter(Boolean).join(', ')}
                    </p>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setInvestorToView(investor);
                    setDrawerOpen(true);
                  }}
                  className="p-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100"
                  title="View Details"
                >
                  <Eye className="w-4 h-4" />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {Array.isArray(investor.investment_stages) &&
                  investor.investment_stages.slice(0, 3).map((s) => (
                    <span
                      key={s}
                      className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800"
                    >
                      {s}
                    </span>
                  ))}
                {formatCurrency(investor.fund_size_usd) !== '-' && (
                  <span className="text-xs text-gray-500">{formatCurrency(investor.fund_size_usd)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm relative">
          {searchLoading && (
            <div className="absolute inset-0 bg-white/75 flex items-center justify-center z-10">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-500" />
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {orderedVisibleColumns.map((col) => (
                    <th
                      key={col}
                      className="px-3 md:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                    >
                      {COLUMN_LABELS[col] || col}
                    </th>
                  ))}
                  <th className="px-3 md:px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {investors.map((investor) => (
                  <tr
                    key={investor.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) {
                        setInvestorToView(investor);
                        setDrawerOpen(true);
                      }
                    }}
                  >
                    {orderedVisibleColumns.map((col) => (
                      <td
                        key={col}
                        className="px-3 md:px-6 py-4 text-sm text-gray-900 max-w-xs truncate"
                        title={getCellValue(investor, col)}
                        onClick={(e) => {
                          if (!(e.ctrlKey || e.metaKey)) {
                            e.stopPropagation();
                            handleCellClick(investor, col);
                          }
                        }}
                      >
                        {getCellValue(investor, col)}
                      </td>
                    ))}
                    <td className="px-3 md:px-6 py-4 whitespace-nowrap text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setInvestorToView(investor);
                          setDrawerOpen(true);
                        }}
                        className="inline-flex items-center px-2 md:px-3 py-1.5 border border-gray-300 text-xs md:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                        title="View Details"
                      >
                        <Eye className="w-3 h-3 md:w-4 md:h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm mt-4">
          <div className="px-4 py-3 flex items-center justify-between border-t border-gray-200 sm:px-6">
            <div className="flex-1 flex justify-between sm:hidden">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
                className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
            <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
              <p className="text-sm text-gray-700">
                Showing{' '}
                <span className="font-medium">{(currentPage - 1) * pageSize + 1}</span> to{' '}
                <span className="font-medium">{Math.min(currentPage * pageSize, totalCount)}</span> of{' '}
                <span className="font-medium">{totalCount}</span> results
              </p>
              <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) pageNum = i + 1;
                  else if (currentPage <= 3) pageNum = i + 1;
                  else if (currentPage >= totalPages - 2) pageNum = totalPages - 4 + i;
                  else pageNum = currentPage - 2 + i;
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                        currentPage === pageNum
                          ? 'z-10 bg-indigo-50 border-indigo-500 text-indigo-600'
                          : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                  className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </nav>
            </div>
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
        investors={investors}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={handlePageChange}
        onInvestorChange={(inv) => setInvestorToView(inv)}
      />
    </div>
  );
}
