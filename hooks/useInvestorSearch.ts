'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/utils/supabase/client';
import { resolveCountryInput, resolveSubdivisionInput } from '@/lib/isoCodes';

export type InvestorTypeFilter = 'firm' | 'person';

export type InvestorModeFilter = 'global' | 'reviewed';

export interface InvestorSearchFilters {
  type: InvestorTypeFilter;
  mode: InvestorModeFilter;
  name: string;
  active: boolean | null;
  role: string | null;
  hq_state: string | null;
  hq_country: string | null;
  investor_type: string[];
  fund_size_min: number | null;
  fund_size_max: number | null;
  check_size_min: number | null;
  check_size_max: number | null;
  investment_stages: string[];
  investment_industries: string[];
  investment_geographies: string[];
  leads_round: boolean | null;
  /** Reviewed tab only: pipeline stage filter */
  reviewed_stage: string[];
  /** Reviewed tab only: set names from get_investor_sets */
  set: string[];
  /** Reviewed tab only: owner names */
  owner: string[];
  /** Reviewed tab only: investor_fit - true=Strong, false=Weak, null=Unclear */
  investor_fit: (boolean | null)[];
}

export interface InvestorSearchResult {
  id: string;
  name: string;
  type: string;
  active: boolean | null;
  role: string | null;
  hq_state: string | null;
  hq_country: string | null;
  investor_type: string[] | null;
  fund_size_usd: number | null;
  check_size_min_usd: number | null;
  check_size_max_usd: number | null;
  investment_stages: string[] | null;
  investment_industries: string[] | null;
  investment_geographies: string[] | null;
  investment_thesis: string | null;
  notable_investments: string[] | null;
  leads_round: boolean | null;
  has_personalization: boolean;
  /** Only populated when has_personalization === true; otherwise null */
  set_name?: string | null;
  owner?: string | null;
  /** jsonb array: [{ message, date }] */
  notes?: Array<{ message: string; date: string }> | null;
  stage?: string | null;
  ai_metadata?: Record<string, unknown> | null;
  domain?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  email?: string | null;
  phone?: string | null;
  links?: string[] | null;
  /** For type='person': firm this person is associated with */
  associated_firm_id?: string | null;
  associated_firm_name?: string | null;
  /** For type='firm': number of people linked to the firm */
  associated_people_count?: number | null;
}

export interface UseInvestorSearchOptions {
  filters: InvestorSearchFilters;
  pageSize?: number;
}

export interface UseInvestorSearchReturn {
  data: InvestorSearchResult[];
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  page: number;
  setPage: (page: number) => void;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

const PAGE_SIZE_DEFAULT = 20;

function buildRpcParams(
  filters: InvestorSearchFilters,
  offset: number,
  limit: number
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    p_type: filters.type,
    p_mode: filters.mode,
    p_limit: limit,
    p_offset: offset,
  };

  if (filters.name.trim()) {
    params.p_query = filters.name.trim();
  }
  if (filters.active !== null) {
    params.p_active = filters.active;
  }
  if (filters.role?.trim()) {
    params.p_role = filters.role.trim();
  }
  // Resolve country/state names to ISO codes for search (e.g. "India" → "IN", "Tamil Nadu" → "IN-TN")
  const resolvedCountry = filters.hq_country?.trim()
    ? resolveCountryInput(filters.hq_country) ?? filters.hq_country.trim()
    : null;
  const resolvedState = filters.hq_state?.trim()
    ? resolveSubdivisionInput(filters.hq_state, filters.hq_country) ?? filters.hq_state.trim()
    : null;
  if (resolvedState) params.p_hq_state = resolvedState;
  if (resolvedCountry) params.p_hq_country = resolvedCountry;
  if (filters.investor_type.length > 0) {
    params.p_investor_type = filters.investor_type;
  }
  if (filters.fund_size_min != null && filters.fund_size_min > 0) {
    params.p_fund_size_min = filters.fund_size_min;
  }
  if (filters.fund_size_max != null && filters.fund_size_max > 0) {
    params.p_fund_size_max = filters.fund_size_max;
  }
  if (filters.check_size_min != null && filters.check_size_min > 0) {
    params.p_check_min = filters.check_size_min;
  }
  if (filters.check_size_max != null && filters.check_size_max > 0) {
    params.p_check_max = filters.check_size_max;
  }
  if (filters.investment_stages.length > 0) {
    params.p_stages = filters.investment_stages;
  }
  if (filters.investment_industries.length > 0) {
    params.p_industries = filters.investment_industries;
  }
  if (filters.investment_geographies.length > 0) {
    params.p_geographies = filters.investment_geographies;
  }
  if (filters.leads_round !== null) {
    params.p_leads_round = filters.leads_round;
  }
  if (filters.reviewed_stage.length > 0) {
    params.p_reviewed_stage = filters.reviewed_stage;
  }
  if (filters.set.length > 0) {
    params.p_set = filters.set;
  }
  if (filters.owner.length > 0) {
    params.p_owner = filters.owner;
  }
  if (filters.investor_fit.length > 0) {
    params.p_investor_fit = filters.investor_fit;
  }

  return params;
}

export function useInvestorSearch({
  filters,
  pageSize = PAGE_SIZE_DEFAULT,
}: UseInvestorSearchOptions): UseInvestorSearchReturn {
  const [data, setData] = useState<InvestorSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (pageNum: number, append = false) => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      abortRef.current = new AbortController();

      setLoading(true);
      setError(null);

      const offset = (pageNum - 1) * pageSize;
      const rpcParams = buildRpcParams(filters, offset, pageSize);

      try {
        const { data: result, error: rpcError } = await supabase.rpc(
          'search_investors',
          rpcParams
        );

        if (abortRef.current?.signal.aborted) return;

        if (rpcError) {
          setError(rpcError as unknown as Error);
          if (!append) setData([]);
          setHasMore(false);
          return;
        }

        const list = Array.isArray(result) ? (result as InvestorSearchResult[]) : [];
        setData((prev) => (append ? [...prev, ...list] : list));
        setHasMore(list.length >= pageSize);
      } catch (err) {
        if (!abortRef.current?.signal.aborted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          if (!append) setData([]);
          setHasMore(false);
        }
      } finally {
        if (!abortRef.current?.signal.aborted) {
          setLoading(false);
        }
        abortRef.current = null;
      }
    },
    [filters, pageSize]
  );

  useEffect(() => {
    setPage(1);
  }, [
    filters.type,
    filters.mode,
    filters.name,
    filters.active,
    filters.role,
    filters.hq_state,
    filters.hq_country,
    JSON.stringify(filters.investor_type),
    filters.fund_size_min,
    filters.fund_size_max,
    filters.check_size_min,
    filters.check_size_max,
    JSON.stringify(filters.investment_stages),
    JSON.stringify(filters.investment_industries),
    JSON.stringify(filters.investment_geographies),
    filters.leads_round,
    JSON.stringify(filters.reviewed_stage),
    JSON.stringify(filters.set),
    JSON.stringify(filters.owner),
    JSON.stringify(filters.investor_fit),
  ]);

  useEffect(() => {
    fetchPage(page, false);
  }, [fetchPage, page]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    const nextPage = Math.floor(data.length / pageSize) + 1;
    await fetchPage(nextPage, true);
  }, [hasMore, loading, data.length, pageSize, fetchPage]);

  const refresh = useCallback(async () => {
    await fetchPage(page, false);
  }, [fetchPage, page]);

  return {
    data,
    loading,
    error,
    hasMore,
    page,
    setPage,
    loadMore,
    refresh,
  };
}

/** Fetch a single investor by ID using search_investors RPC (same format as search results) */
export async function fetchInvestorById(
  investorId: string,
  filters: Pick<InvestorSearchFilters, 'type' | 'mode'>
): Promise<InvestorSearchResult | null> {
  const rpcParams: Record<string, unknown> = {
    p_type: filters.type,
    p_mode: filters.mode,
    p_investor_id: investorId,
    p_limit: 1,
    p_offset: 0,
  };
  const { data, error } = await supabase.rpc('search_investors', rpcParams);
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return data[0] as InvestorSearchResult;
}

/** Fetch investors for CSV export - always uses p_mode: "reviewed", p_limit: 100000 */
export async function fetchInvestorsForExport(
  filters: InvestorSearchFilters
): Promise<InvestorSearchResult[]> {
  const params = buildRpcParams(
    { ...filters, mode: 'reviewed' },
    0,
    100000
  );
  const { data, error } = await supabase.rpc('search_investors', params);
  if (error || !Array.isArray(data)) return [];
  return data as InvestorSearchResult[];
}

/** Limit for contacts at firm when on free plan */
export const CONTACTS_FREE_LIMIT = 5;

/** Fetch people at a firm using search_investors RPC (p_investor_id = firm id, p_type = person) */
export async function fetchPeopleAtFirm(
  firmId: string,
  mode: InvestorModeFilter,
  limit: number
): Promise<InvestorSearchResult[]> {
  const rpcParams: Record<string, unknown> = {
    p_type: 'person',
    p_mode: mode,
    p_investor_id: firmId,
    p_limit: limit,
    p_offset: 0,
  };
  const { data, error } = await supabase.rpc('search_investors', rpcParams);
  if (error || !Array.isArray(data)) return [];
  return data as InvestorSearchResult[];
}
