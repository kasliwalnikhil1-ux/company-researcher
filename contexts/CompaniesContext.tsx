'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
  useMemo,
} from 'react';
import { supabase } from '@/utils/supabase/client';
import { useAuth } from './AuthContext';
import { useCountry } from './CountryContext';

export interface Company {
  id: string;
  user_id: string;
  domain: string;
  instagram: string;
  phone: string;
  email: string;
  summary: any; // jsonb
  set_name: string | null;
  owner: string | null;
  created_at?: string;
}

type SortOrder = 'newest' | 'oldest';
type DateFilter = 'all' | 'today' | 'yesterday' | 'last_week' | 'last_month' | 'custom';
type ClassificationFilter = 'all' | 'QUALIFIED' | 'NOT_QUALIFIED' | 'EXPIRED' | 'empty';
type AnalyticsPeriod = 'today' | 'yesterday' | 'week' | 'month';

export interface CompanyCountByOwner {
  owner: string;
  total: number;
}

interface CompaniesContextType {
  companies: Company[];
  loading: boolean;
  sortOrder: SortOrder;
  setSortOrder: (order: SortOrder) => void;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  dateFilter: DateFilter;
  setDateFilter: (filter: DateFilter) => void;
  customDateRange: { start: Date | null; end: Date | null };
  setCustomDateRange: (range: { start: Date | null; end: Date | null }) => void;
  classificationFilter: ClassificationFilter;
  setClassificationFilter: (filter: ClassificationFilter) => void;
  setNameFilter: string | null;
  setSetNameFilter: (filter: string | null) => void;
  ownerFilter: string | null;
  setOwnerFilter: (filter: string | null) => void;
  availableSetNames: string[];
  availableOwners: string[];
  refreshCompanies: () => Promise<void>;
  createCompany: (company: Omit<Company, 'id' | 'user_id'>) => Promise<void>;
  updateCompany: (id: string, company: Partial<Omit<Company, 'id' | 'user_id'>>) => Promise<void>;
  deleteCompany: (id: string) => Promise<void>;
  bulkUpdateSetName: (ids: string[], setName: string | null) => Promise<void>;
  getCompanyCountsByOwner: (period: AnalyticsPeriod) => Promise<CompanyCountByOwner[]>;
}

const CompaniesContext = createContext<CompaniesContextType | undefined>(undefined);

// Helper function to clean Instagram username
const cleanInstagramUsername = (instagram: string | undefined): string => {
  if (!instagram) return '';

  return instagram
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
    .replace(/\/+$/, '')
    .replace(/^@/, '');
};

export const CompaniesProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const { getEffectiveCountryCode } = useCountry();

  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [customDateRange, setCustomDateRange] = useState<{ start: Date | null; end: Date | null }>({
    start: null,
    end: null,
  });
  const [classificationFilter, setClassificationFilter] = useState<ClassificationFilter>('all');
  const [setNameFilter, setSetNameFilter] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const [availableSetNames, setAvailableSetNames] = useState<string[]>([]);
  const [availableOwners, setAvailableOwners] = useState<string[]>([]);
  const pageSize = 25;

  // Stable helper to get date range
  const getDateRange = useCallback(
    (filter: DateFilter): { start: Date | null; end: Date | null } => {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      switch (filter) {
        case 'today':
          return { start: today, end: null };
        case 'yesterday': {
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);
          return { start: yesterday, end: today };
        }
        case 'last_week': {
          const weekAgo = new Date(today);
          weekAgo.setDate(weekAgo.getDate() - 7);
          return { start: weekAgo, end: null };
        }
        case 'last_month': {
          const monthAgo = new Date(today);
          monthAgo.setMonth(monthAgo.getMonth() - 1);
          return { start: monthAgo, end: null };
        }
        case 'custom': {
          if (customDateRange.end) {
            const adjustedEnd = new Date(customDateRange.end);
            adjustedEnd.setDate(adjustedEnd.getDate() + 1);
            adjustedEnd.setHours(0, 0, 0, 0);
            return { start: customDateRange.start, end: adjustedEnd };
          }
          return customDateRange;
        }
        default:
          return { start: null, end: null };
      }
    },
    [customDateRange]
  );

  const fetchCompanies = useCallback(async () => {
    if (!userId) {
      setCompanies([]);
      setLoading(false);
      setTotalCount(0);
      return;
    }

    try {
      setLoading(true);

      // Build base query for count
      let countQuery = supabase
        .from('companies')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      // Apply date filter
      if (dateFilter !== 'all') {
        const { start, end } = getDateRange(dateFilter);
        if (start) countQuery = countQuery.gte('created_at', start.toISOString());
        if (end) countQuery = countQuery.lt('created_at', end.toISOString());
      }

      // Apply classification filter
      if (classificationFilter !== 'all') {
        if (classificationFilter === 'empty') {
          countQuery = countQuery.or('summary.is.null,summary->>classification.is.null,summary->>classification.eq.');
        } else {
          countQuery = countQuery.eq('summary->>classification', classificationFilter);
        }
      }

      // Apply set_name filter
      if (setNameFilter !== null) {
        if (setNameFilter === '') {
          countQuery = countQuery.or('set_name.is.null,set_name.eq.');
        } else {
          countQuery = countQuery.eq('set_name', setNameFilter);
        }
      }

      // Apply owner filter
      if (ownerFilter !== null) {
        if (ownerFilter === '') {
          countQuery = countQuery.or('owner.is.null,owner.eq.');
        } else {
          countQuery = countQuery.eq('owner', ownerFilter);
        }
      }

      const { count, error: countError } = await countQuery;

      if (countError) {
        console.error('Error fetching companies count:', countError);
        throw countError;
      }

      setTotalCount(count || 0);

      // Calculate offset
      const offset = (currentPage - 1) * pageSize;

      // Build main query
      let query = supabase
        .from('companies')
        .select('*')
        .eq('user_id', userId)
        .range(offset, offset + pageSize - 1);

      // Apply date filter
      if (dateFilter !== 'all') {
        const { start, end } = getDateRange(dateFilter);
        if (start) query = query.gte('created_at', start.toISOString());
        if (end) query = query.lt('created_at', end.toISOString());
      }

      // Apply classification filter
      if (classificationFilter !== 'all') {
        if (classificationFilter === 'empty') {
          query = query.or('summary.is.null,summary->>classification.is.null,summary->>classification.eq.');
        } else {
          query = query.eq('summary->>classification', classificationFilter);
        }
      }

      // Apply set_name filter
      if (setNameFilter !== null) {
        if (setNameFilter === '') {
          query = query.or('set_name.is.null,set_name.eq.');
        } else {
          query = query.eq('set_name', setNameFilter);
        }
      }

      // Apply owner filter
      if (ownerFilter !== null) {
        if (ownerFilter === '') {
          query = query.or('owner.is.null,owner.eq.');
        } else {
          query = query.eq('owner', ownerFilter);
        }
      }

      // Sorting
      query =
        sortOrder === 'newest'
          ? query.order('created_at', { ascending: false })
          : query.order('created_at', { ascending: true });

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching companies:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        throw error;
      }

      setCompanies(data || []);
    } catch (error) {
      console.error('Error in fetchCompanies:', error);
    } finally {
      setLoading(false);
    }
  }, [
    userId,
    sortOrder,
    currentPage,
    pageSize,
    dateFilter,
    getDateRange,
    classificationFilter,
    setNameFilter,
    ownerFilter,
  ]);

  // Fetch available set names
  const fetchAvailableSetNames = useCallback(async () => {
    if (!userId) {
      setAvailableSetNames([]);
      return;
    }

    try {
      const { data, error } = await supabase.rpc('get_unique_sets');

      if (error) {
        console.error('Error fetching available set names:', error);
        setAvailableSetNames([]);
        return;
      }

      if (Array.isArray(data)) {
        const setNames = data
          .map((item) => (typeof item === 'string' ? item : item?.set_name))
          .filter((name): name is string => typeof name === 'string' && name !== null && name !== undefined)
          .sort();

        setAvailableSetNames(setNames);
      } else {
        setAvailableSetNames([]);
      }
    } catch (error) {
      console.error('Error in fetchAvailableSetNames:', error);
      setAvailableSetNames([]);
    }
  }, [userId]);

  // Fetch available owners
  const fetchAvailableOwners = useCallback(async () => {
    if (!userId) {
      setAvailableOwners([]);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('companies')
        .select('owner')
        .eq('user_id', userId)
        .not('owner', 'is', null)
        .neq('owner', '');

      if (error) {
        console.error('Error fetching available owners:', error);
        setAvailableOwners([]);
        return;
      }

      if (Array.isArray(data)) {
        const owners = [...new Set(
          data
            .map((item) => item?.owner)
            .filter((owner): owner is string => typeof owner === 'string' && owner.trim() !== '')
        )].sort();

        setAvailableOwners(owners);
      } else {
        setAvailableOwners([]);
      }
    } catch (error) {
      console.error('Error in fetchAvailableOwners:', error);
      setAvailableOwners([]);
    }
  }, [userId]);

  // Fetch set names + owners when user changes (not on every companies change)
  useEffect(() => {
    if (userId) {
      fetchAvailableSetNames();
      fetchAvailableOwners();
    } else {
      setAvailableSetNames([]);
      setAvailableOwners([]);
    }
  }, [userId, fetchAvailableSetNames, fetchAvailableOwners]);

  const createCompany = async (company: Omit<Company, 'id' | 'user_id'>) => {
    if (!userId) throw new Error('User must be logged in');

    let phoneWithCountryCode = company.phone || '';
    if (phoneWithCountryCode && !phoneWithCountryCode.startsWith('+')) {
      const cleanedPhone = phoneWithCountryCode.replace(/\s+/g, '').replace(/^0+/, '');
      phoneWithCountryCode = `${getEffectiveCountryCode()}${cleanedPhone}`;
    }

    const payload = {
      user_id: userId,
      domain: company.domain || '',
      instagram: cleanInstagramUsername(company.instagram),
      phone: phoneWithCountryCode,
      email: company.email || '',
      summary: company.summary || null,
      set_name: company.set_name || null,
      owner: company.owner || null,
    };

    const { error } = await supabase.from('companies').insert(payload);

    if (error) {
      console.error('Error creating company:', {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        payload,
      });
      throw new Error(error?.message || 'Failed to create company');
    }

    await fetchCompanies();
    await Promise.all([fetchAvailableSetNames(), fetchAvailableOwners()]);
  };

  const updateCompany = async (id: string, updates: Partial<Omit<Company, 'id' | 'user_id'>>) => {
    if (!userId) throw new Error('User must be logged in');

    const processedUpdates = { ...updates };

    if (processedUpdates.phone !== undefined) {
      let phoneWithCountryCode = processedUpdates.phone || '';
      if (phoneWithCountryCode && !phoneWithCountryCode.startsWith('+')) {
        const cleanedPhone = phoneWithCountryCode.replace(/\s+/g, '').replace(/^0+/, '');
        phoneWithCountryCode = `${getEffectiveCountryCode()}${cleanedPhone}`;
      }
      processedUpdates.phone = phoneWithCountryCode;
    }

    if (processedUpdates.instagram !== undefined) {
      processedUpdates.instagram = cleanInstagramUsername(processedUpdates.instagram);
    }

    const { error } = await supabase
      .from('companies')
      .update(processedUpdates)
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating company:', {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        id,
        updates: processedUpdates,
      });
      throw new Error(error?.message || 'Failed to update company');
    }

    await fetchCompanies();
    await Promise.all([fetchAvailableSetNames(), fetchAvailableOwners()]);
  };

  const deleteCompany = async (id: string) => {
    if (!userId) throw new Error('User must be logged in');

    const { error } = await supabase.from('companies').delete().eq('id', id).eq('user_id', userId);

    if (error) {
      console.error('Error deleting company:', {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        id,
      });
      throw new Error(error?.message || 'Failed to delete company');
    }

    await fetchCompanies();
    await Promise.all([fetchAvailableSetNames(), fetchAvailableOwners()]);
  };

  const bulkUpdateSetName = async (ids: string[], setName: string | null) => {
    if (!userId) throw new Error('User must be logged in');
    if (ids.length === 0) return;

    const setValue = setName?.trim() || null;

    const { error } = await supabase
      .from('companies')
      .update({ set_name: setValue })
      .in('id', ids)
      .eq('user_id', userId);

    if (error) {
      console.error('Error bulk updating set_name:', {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        ids,
        setName: setValue,
      });
      throw new Error(error?.message || 'Failed to bulk update set_name');
    }

    await fetchCompanies();
    await Promise.all([fetchAvailableSetNames(), fetchAvailableOwners()]);
  };

  const getCompanyCountsByOwner = async (period: AnalyticsPeriod): Promise<CompanyCountByOwner[]> => {
    if (!userId) throw new Error('User must be logged in');

    const { data, error } = await supabase.rpc('get_company_counts_by_owner', { period });

    if (error) {
      console.error('Error fetching company counts by owner:', error);
      throw new Error(error?.message || 'Failed to fetch company counts by owner');
    }

    return data || [];
  };

  useEffect(() => {
    if (userId) {
      fetchCompanies();
    } else {
      setCompanies([]);
      setLoading(false);
      setTotalCount(0);
    }
  }, [userId, fetchCompanies]);

  // Reset to page 1 when sort order or filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [sortOrder, dateFilter, customDateRange, classificationFilter, setNameFilter, ownerFilter]);

  const totalPages = useMemo(() => Math.ceil(totalCount / pageSize), [totalCount, pageSize]);

  const value: CompaniesContextType = {
    companies,
    loading,
    sortOrder,
    setSortOrder,
    currentPage,
    setCurrentPage,
    pageSize,
    totalCount,
    totalPages,
    dateFilter,
    setDateFilter,
    customDateRange,
    setCustomDateRange,
    classificationFilter,
    setClassificationFilter,
    setNameFilter,
    setSetNameFilter,
    ownerFilter,
    setOwnerFilter,
    availableSetNames,
    availableOwners,
    refreshCompanies: fetchCompanies,
    createCompany,
    updateCompany,
    deleteCompany,
    bulkUpdateSetName,
    getCompanyCountsByOwner,
  };

  return <CompaniesContext.Provider value={value}>{children}</CompaniesContext.Provider>;
};

export const useCompanies = () => {
  const context = useContext(CompaniesContext);
  if (context === undefined) {
    throw new Error('useCompanies must be within a CompaniesProvider');
  }
  return context;
};
