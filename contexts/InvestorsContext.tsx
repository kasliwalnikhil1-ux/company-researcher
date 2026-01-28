'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
  useMemo,
} from 'react';
import { supabase } from '@/utils/supabase/client';

export interface Investor {
  id: string;
  name: string;
  role: string;
  hq_state: string;
  hq_country: string;
  investor_type: string[] | null;
  fund_size_usd: number | null;
  check_size_min_usd: number | null;
  check_size_max_usd: number | null;
  investment_stages: string[] | null;
  investment_industries: string[] | null;
  investment_geographies: string[] | null;
  investment_thesis: string | null;
}

interface InvestorsContextType {
  investors: Investor[];
  loading: boolean;
  searchLoading: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  stageFilter: string[];
  setStageFilter: (stages: string[]) => void;
  industryFilter: string[];
  setIndustryFilter: (industries: string[]) => void;
  countryFilter: string | null;
  setCountryFilter: (country: string | null) => void;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  refreshInvestors: () => Promise<void>;
  initializeInvestors: () => Promise<void>;
}

const InvestorsContext = createContext<InvestorsContextType | undefined>(undefined);

const PAGE_SIZE = 20;

export const InvestorsProvider = ({ children }: { children: ReactNode }) => {
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<string[]>([]);
  const [industryFilter, setIndustryFilter] = useState<string[]>([]);
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [previousSearchQuery, setPreviousSearchQuery] = useState('');
  const hasFetchedOnceRef = useRef(false);

  const fetchInvestors = useCallback(async () => {
    try {
      const isSearchOperation = searchQuery !== previousSearchQuery;
      setPreviousSearchQuery(searchQuery);

      // Full-page loading only on initial load; search/filter/pagination use table overlay only
      if (!hasFetchedOnceRef.current) {
        setLoading(true);
      } else {
        setSearchLoading(true);
      }

      const offset = (currentPage - 1) * PAGE_SIZE;

      const { data, error } = await supabase.rpc('search_public_investors', {
        q: searchQuery.trim() || null,
        stage_filter: stageFilter.length ? stageFilter : null,
        industry_filter: industryFilter.length ? industryFilter : null,
        country_filter: countryFilter || null,
        limit_count: PAGE_SIZE,
        offset_count: offset,
      });

      if (error) {
        console.error('Error fetching investors:', error);
        throw error;
      }

      const list = Array.isArray(data) ? data : [];
      setInvestors(list);
      hasFetchedOnceRef.current = true;

      // Total: if we got less than page size, this is the last page so total = offset + list.length; else at least this many
      setTotalCount((prev) => {
        const knownMin = offset + list.length;
        if (list.length < PAGE_SIZE) return knownMin;
        return Math.max(prev, knownMin);
      });
    } catch (err) {
      console.error('Error in fetchInvestors:', err);
      setInvestors([]);
    } finally {
      setLoading(false);
      setSearchLoading(false);
    }
  }, [
    searchQuery,
    previousSearchQuery,
    stageFilter,
    industryFilter,
    countryFilter,
    currentPage,
  ]);
  // totalCount intentionally omitted - we set it inside fetchInvestors via functional update

  useEffect(() => {
    fetchInvestors();
  }, [fetchInvestors]);

  const initializeInvestors = useCallback(async () => {
    await fetchInvestors();
  }, [fetchInvestors]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, stageFilter, industryFilter, countryFilter]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    [totalCount]
  );

  const hasNextPage = currentPage < totalPages;

  const value: InvestorsContextType = {
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
    pageSize: PAGE_SIZE,
    totalCount,
    totalPages,
    hasNextPage,
    refreshInvestors: fetchInvestors,
    initializeInvestors,
  };

  return (
    <InvestorsContext.Provider value={value}>
      {children}
    </InvestorsContext.Provider>
  );
};

export const useInvestors = () => {
  const context = useContext(InvestorsContext);
  if (context === undefined) {
    throw new Error('useInvestors must be used within an InvestorsProvider');
  }
  return context;
};
