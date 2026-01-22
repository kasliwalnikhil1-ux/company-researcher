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
  contacts?: any; // jsonb - array of contact objects
  notes?: any; // jsonb - array of note objects: [{ message: string, date: string }]
  set_name: string | null;
  owner: string | null;
  created_at?: string;
}

type SortOrder = 'newest' | 'oldest';
type DateFilter = 'all' | 'today' | 'yesterday' | 'last_week' | 'last_month' | 'custom';
type ClassificationFilter = 'all' | 'QUALIFIED' | 'NOT_QUALIFIED' | 'EXPIRED' | 'empty';
type DomainInstagramFilter = 'any' | 'has_valid_domain' | 'has_valid_instagram' | 'has_valid_phone' | 'has_valid_email';
type AnalyticsPeriod = 'today' | 'yesterday' | 'week' | 'month';

export interface CompanyCountByOwner {
  owner: string;
  total: number;
}

interface CompaniesContextType {
  companies: Company[];
  loading: boolean;
  searchLoading: boolean;
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
  domainInstagramFilter: DomainInstagramFilter;
  setDomainInstagramFilter: (filter: DomainInstagramFilter) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  availableSetNames: string[];
  availableOwners: string[];
  refreshCompanies: () => Promise<void>;
  createCompany: (company: Omit<Company, 'id' | 'user_id'>) => Promise<void>;
  updateCompany: (id: string, company: Partial<Omit<Company, 'id' | 'user_id'>>) => Promise<void>;
  deleteCompany: (id: string) => Promise<void>;
  bulkDeleteCompany: (ids: string[]) => Promise<void>;
  bulkUpdateSetName: (ids: string[], setName: string | null) => Promise<void>;
  getCompanyCountsByOwner: (period: AnalyticsPeriod) => Promise<CompanyCountByOwner[]>;
  initializeCompanies: () => Promise<void>; // Lazy initialization
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
  const [searchLoading, setSearchLoading] = useState(false);
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
  const [domainInstagramFilter, setDomainInstagramFilter] = useState<DomainInstagramFilter>('any');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [previousSearchQuery, setPreviousSearchQuery] = useState<string>('');
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
      setSearchLoading(false);
      setTotalCount(0);
      return;
    }

    try {
      // Determine if this is a search operation (search query changed)
      const isSearchOperation = searchQuery !== previousSearchQuery;
      setPreviousSearchQuery(searchQuery);

      if (isSearchOperation) {
        setSearchLoading(true);
      } else {
        setLoading(true);
      }

      // Build base query for count
      let countQuery = supabase
        .from('companies')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      // Apply search filter
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        // Search across multiple fields using OR conditions
        countQuery = countQuery.or(
          `domain.ilike.%${query}%,instagram.ilike.%${query}%,phone.ilike.%${query}%,email.ilike.%${query}%,summary->>company_summary.ilike.%${query}%,summary->>company_industry.ilike.%${query}%,summary->>profile_summary.ilike.%${query}%,summary->>profile_industry.ilike.%${query}%,summary->>sales_opener_sentence.ilike.%${query}%`
        );
      }

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

      // Apply domain/instagram/phone/email filter
      if (domainInstagramFilter === 'has_valid_domain') {
        countQuery = countQuery.not('domain', 'is', null).neq('domain', '').neq('domain', '-');
      } else if (domainInstagramFilter === 'has_valid_instagram') {
        countQuery = countQuery.not('instagram', 'is', null).neq('instagram', '').neq('instagram', '-');
      } else if (domainInstagramFilter === 'has_valid_phone') {
        countQuery = countQuery.not('phone', 'is', null).neq('phone', '').neq('phone', '-');
      } else if (domainInstagramFilter === 'has_valid_email') {
        countQuery = countQuery.not('email', 'is', null).neq('email', '').neq('email', '-');
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

      // Apply search filter
      if (searchQuery.trim()) {
        const query_text = searchQuery.trim().toLowerCase();
        // Search across multiple fields using OR conditions
        query = query.or(
          `domain.ilike.%${query_text}%,instagram.ilike.%${query_text}%,phone.ilike.%${query_text}%,email.ilike.%${query_text}%,summary->>company_summary.ilike.%${query_text}%,summary->>company_industry.ilike.%${query_text}%,summary->>profile_summary.ilike.%${query_text}%,summary->>profile_industry.ilike.%${query_text}%,summary->>sales_opener_sentence.ilike.%${query_text}%`
        );
      }

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

      // Apply domain/instagram/phone/email filter
      if (domainInstagramFilter === 'has_valid_domain') {
        query = query.not('domain', 'is', null).neq('domain', '').neq('domain', '-');
      } else if (domainInstagramFilter === 'has_valid_instagram') {
        query = query.not('instagram', 'is', null).neq('instagram', '').neq('instagram', '-');
      } else if (domainInstagramFilter === 'has_valid_phone') {
        query = query.not('phone', 'is', null).neq('phone', '').neq('phone', '-');
      } else if (domainInstagramFilter === 'has_valid_email') {
        query = query.not('email', 'is', null).neq('email', '').neq('email', '-');
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
      setSearchLoading(false);
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
    domainInstagramFilter,
    searchQuery,
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
      // Check if this is a duplicate key error (unique constraint violation)
      if (error.code === '23505') {
        console.log('Company already exists, attempting to update instead...');

        // Find the existing company with the same domain and instagram
        const { data: existingCompany } = await supabase
          .from('companies')
          .select('id')
          .eq('user_id', userId)
          .eq('domain', payload.domain)
          .eq('instagram', payload.instagram)
          .single();

        if (existingCompany) {
          // Update the existing company with the new data
          // Always update summary, but only update other fields if they have non-empty values
          const updatePayload: any = {
            summary: payload.summary, // Always update summary with new research data
          };

          // Only update phone if it's not empty/null/undefined
          if (payload.phone && payload.phone.trim() !== '') {
            updatePayload.phone = payload.phone;
          }

          // Only update email if it's not empty/null/undefined
          if (payload.email && payload.email.trim() !== '') {
            updatePayload.email = payload.email;
          }

          // Only update set_name if it's not null/undefined
          if (payload.set_name !== null && payload.set_name !== undefined) {
            updatePayload.set_name = payload.set_name;
          }

          // Only update owner if it's not null/undefined
          if (payload.owner !== null && payload.owner !== undefined) {
            updatePayload.owner = payload.owner;
          }

          const { error: updateError } = await supabase
            .from('companies')
            .update(updatePayload)
            .eq('id', existingCompany.id)
            .eq('user_id', userId);

          if (updateError) {
            console.error('Error updating existing company:', {
              message: updateError?.message || 'Unknown error',
              details: updateError?.details || null,
              hint: updateError?.hint || null,
              code: updateError?.code || null,
              id: existingCompany.id,
              updates: updatePayload,
            });
            throw new Error(updateError?.message || 'Failed to update existing company');
          }

          console.log('Successfully updated existing company');
        } else {
          // This shouldn't happen if the constraint is working properly, but handle it anyway
          console.error('Duplicate key error but could not find existing company:', {
            payload,
            error,
          });
          throw new Error('Company already exists but could not update it');
        }
      } else {
        console.error('Error creating company:', {
          message: error?.message || 'Unknown error',
          details: error?.details || null,
          hint: error?.hint || null,
          code: error?.code || null,
          payload,
        });
        throw new Error(error?.message || 'Failed to create company');
      }
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

    // Optimistically update local state without refetching all companies
    setCompanies((prevCompanies) =>
      prevCompanies.map((company) =>
        company.id === id ? { ...company, ...processedUpdates } : company
      )
    );

    // Only refetch set names and owners if relevant fields changed
    const shouldRefreshMetadata = 
      processedUpdates.set_name !== undefined || 
      processedUpdates.owner !== undefined;
    
    if (shouldRefreshMetadata) {
      await Promise.all([fetchAvailableSetNames(), fetchAvailableOwners()]);
    }
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

    // Optimistically remove company from local state without refetching
    setCompanies((prevCompanies) => prevCompanies.filter((company) => company.id !== id));
    
    // Update total count
    setTotalCount((prevCount) => Math.max(0, prevCount - 1));

    // Only refetch set names and owners if needed (they might have changed)
    await Promise.all([fetchAvailableSetNames(), fetchAvailableOwners()]);
  };

  const bulkDeleteCompany = async (ids: string[]) => {
    if (!userId) throw new Error('User must be logged in');
    if (ids.length === 0) return;

    const { error } = await supabase
      .from('companies')
      .delete()
      .in('id', ids)
      .eq('user_id', userId);

    if (error) {
      console.error('Error bulk deleting companies:', {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        ids,
      });
      throw new Error(error?.message || 'Failed to bulk delete companies');
    }

    // Optimistically remove all deleted companies from local state without refetching
    const idsSet = new Set(ids);
    setCompanies((prevCompanies) => prevCompanies.filter((company) => !idsSet.has(company.id)));
    
    // Update total count
    setTotalCount((prevCount) => Math.max(0, prevCount - ids.length));

    // Only refetch set names and owners if needed (they might have changed)
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

  // Lazy initialization - only fetch when initializeCompanies is called
  const initializeCompanies = useCallback(async () => {
    if (userId) {
      await fetchCompanies();
    }
  }, [userId, fetchCompanies]);

  // Don't auto-fetch on mount - only fetch when explicitly requested
  // This prevents fetching on Research page
  useEffect(() => {
    if (!userId) {
      setCompanies([]);
      setLoading(false);
      setTotalCount(0);
    }
  }, [userId]);

  // Reset to page 1 when sort order or filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [sortOrder, dateFilter, customDateRange, classificationFilter, setNameFilter, ownerFilter, domainInstagramFilter, searchQuery]);

  const totalPages = useMemo(() => Math.ceil(totalCount / pageSize), [totalCount, pageSize]);

  const value: CompaniesContextType = {
    companies,
    loading,
    searchLoading,
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
    domainInstagramFilter,
    setDomainInstagramFilter,
    searchQuery,
    setSearchQuery,
    availableSetNames,
    availableOwners,
    refreshCompanies: fetchCompanies,
    createCompany,
    updateCompany,
    deleteCompany,
    bulkDeleteCompany,
    bulkUpdateSetName,
    getCompanyCountsByOwner,
    initializeCompanies,
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
