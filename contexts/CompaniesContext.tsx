'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
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

  // Remove any URL prefix, trailing slashes, and @ symbol
  let cleaned = instagram
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, '') // Remove URL prefix
    .replace(/\/+$/, '') // Remove trailing slashes
    .replace(/^@/, ''); // Remove leading @ symbol

  return cleaned;
};

export const CompaniesProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const { getEffectiveCountryCode } = useCountry();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [customDateRange, setCustomDateRange] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [classificationFilter, setClassificationFilter] = useState<ClassificationFilter>('all');
  const [setNameFilter, setSetNameFilter] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const [availableSetNames, setAvailableSetNames] = useState<string[]>([]);
  const [availableOwners, setAvailableOwners] = useState<string[]>([]);
  const pageSize = 25;

  const fetchCompanies = useCallback(async () => {
    if (!user) {
      setCompanies([]);
      setLoading(false);
      setTotalCount(0);
      return;
    }

    try {
      setLoading(true);
      
      // Helper function to get date range for filter
      const getDateRange = (filter: DateFilter): { start: Date | null; end: Date | null } => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        switch (filter) {
          case 'today':
            return { start: today, end: null };
          case 'yesterday':
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            return { start: yesterday, end: today };
          case 'last_week':
            const weekAgo = new Date(today);
            weekAgo.setDate(weekAgo.getDate() - 7);
            return { start: weekAgo, end: null };
          case 'last_month':
            const monthAgo = new Date(today);
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            return { start: monthAgo, end: null };
          case 'custom':
            // For custom range, adjust end date to next day at 00:00:00 to match query pattern
            // This ensures the entire selected end day is included when using .lt() in queries
            if (customDateRange.end) {
              const adjustedEnd = new Date(customDateRange.end);
              adjustedEnd.setDate(adjustedEnd.getDate() + 1);
              adjustedEnd.setHours(0, 0, 0, 0);
              return { start: customDateRange.start, end: adjustedEnd };
            }
            return customDateRange;
          default:
            return { start: null, end: null };
        }
      };

      // Build base query for count
      let countQuery = supabase
        .from('companies')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);

      // Apply date filter
      if (dateFilter !== 'all') {
        const { start, end } = getDateRange(dateFilter);
        if (start) {
          countQuery = countQuery.gte('created_at', start.toISOString());
        }
        if (end) {
          countQuery = countQuery.lt('created_at', end.toISOString());
        }
      }

      // Apply classification filter
      if (classificationFilter !== 'all') {
        if (classificationFilter === 'empty') {
          // Filter for null summary or missing/empty classification
          // Use OR condition: summary is null OR summary->>classification is null OR summary->>classification is empty string
          countQuery = countQuery.or('summary.is.null,summary->>classification.is.null,summary->>classification.eq.');
        } else {
          // Filter for specific classification
          countQuery = countQuery.eq('summary->>classification', classificationFilter);
        }
      }

      // Apply set_name filter
      if (setNameFilter !== null) {
        if (setNameFilter === '') {
          // Filter for null or empty set_name
          countQuery = countQuery.or('set_name.is.null,set_name.eq.');
        } else {
          // Filter for specific set_name
          countQuery = countQuery.eq('set_name', setNameFilter);
        }
      }

      // Apply owner filter
      if (ownerFilter !== null) {
        if (ownerFilter === '') {
          // Filter for null or empty owner
          countQuery = countQuery.or('owner.is.null,owner.eq.');
        } else {
          // Filter for specific owner
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
        .eq('user_id', user.id)
        .range(offset, offset + pageSize - 1);

      // Apply date filter
      if (dateFilter !== 'all') {
        const { start, end } = getDateRange(dateFilter);
        if (start) {
          query = query.gte('created_at', start.toISOString());
        }
        if (end) {
          query = query.lt('created_at', end.toISOString());
        }
      }

      // Apply classification filter
      if (classificationFilter !== 'all') {
        if (classificationFilter === 'empty') {
          // Filter for null summary or missing/empty classification
          // Use OR condition: summary is null OR summary->>classification is null OR summary->>classification is empty string
          query = query.or('summary.is.null,summary->>classification.is.null,summary->>classification.eq.');
        } else {
          // Filter for specific classification
          query = query.eq('summary->>classification', classificationFilter);
        }
      }

      // Apply set_name filter
      if (setNameFilter !== null) {
        if (setNameFilter === '') {
          // Filter for null or empty set_name
          query = query.or('set_name.is.null,set_name.eq.');
        } else {
          // Filter for specific set_name
          query = query.eq('set_name', setNameFilter);
        }
      }

      // Apply owner filter
      if (ownerFilter !== null) {
        if (ownerFilter === '') {
          // Filter for null or empty owner
          query = query.or('owner.is.null,owner.eq.');
        } else {
          // Filter for specific owner
          query = query.eq('owner', ownerFilter);
        }
      }

      // Apply sorting based on created_at
      if (sortOrder === 'newest') {
        query = query.order('created_at', { ascending: false });
      } else {
        query = query.order('created_at', { ascending: true });
      }

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
  }, [user, sortOrder, currentPage, pageSize, dateFilter, customDateRange, classificationFilter, setNameFilter, ownerFilter]);

  // Fetch available set names
  const fetchAvailableSetNames = useCallback(async () => {
    if (!user) {
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

      // RPC should return an array of objects with set_name, or an array of strings
      // Handle both cases
      if (Array.isArray(data)) {
        const setNames = data
          .map(item => typeof item === 'string' ? item : item?.set_name)
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
  }, [user]);

  // Fetch available owners
  const fetchAvailableOwners = useCallback(async () => {
    if (!user) {
      setAvailableOwners([]);
      return;
    }

    try {
      // Fetch distinct owner values from companies table
      const { data, error } = await supabase
        .from('companies')
        .select('owner')
        .eq('user_id', user.id)
        .not('owner', 'is', null)
        .neq('owner', '');

      if (error) {
        console.error('Error fetching available owners:', error);
        setAvailableOwners([]);
        return;
      }

      // Extract unique owner values
      if (Array.isArray(data)) {
        const owners = [...new Set(data
          .map(item => item?.owner)
          .filter((owner): owner is string => typeof owner === 'string' && owner !== null && owner !== undefined && owner.trim() !== '')
        )].sort();
        setAvailableOwners(owners);
      } else {
        setAvailableOwners([]);
      }
    } catch (error) {
      console.error('Error in fetchAvailableOwners:', error);
      setAvailableOwners([]);
    }
  }, [user]);

  // Fetch set names when user changes
  useEffect(() => {
    if (user) {
      fetchAvailableSetNames();
      fetchAvailableOwners();
    } else {
      setAvailableSetNames([]);
      setAvailableOwners([]);
    }
  }, [user, fetchAvailableSetNames, fetchAvailableOwners]);

  const createCompany = async (company: Omit<Company, 'id' | 'user_id'>) => {
    if (!user) throw new Error('User must be logged in');

    // Prepend country code to phone number
    let phoneWithCountryCode = company.phone || '';
    if (phoneWithCountryCode && !phoneWithCountryCode.startsWith('+')) {
      phoneWithCountryCode = `${getEffectiveCountryCode()}${phoneWithCountryCode}`;
    }

    const payload = {
      user_id: user.id,
      domain: company.domain || '',
      instagram: cleanInstagramUsername(company.instagram),
      phone: phoneWithCountryCode,
      email: company.email || '',
      summary: company.summary || null,
      set_name: company.set_name || null,
      owner: company.owner || null,
    };

    const { data, error } = await supabase
      .from('companies')
      .insert(payload)
      .select()
      .single();

    if (error) {
      // Log raw error first to see full structure
      console.error('Error creating company - raw error:', error);
      console.error('Error creating company - error type:', typeof error);
      console.error('Error creating company - error keys:', error ? Object.keys(error) : 'error is null/undefined');
      
      // Build error details object with fallbacks
      const errorDetails = {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        payload,
        // Include stringified version for complex objects
        errorString: error ? JSON.stringify(error, null, 2) : 'null',
      };
      
      console.error('Error creating company:', errorDetails);
      throw new Error(error?.message || 'Failed to create company');
    }

    await fetchCompanies();
  };

  const updateCompany = async (id: string, updates: Partial<Omit<Company, 'id' | 'user_id'>>) => {
    if (!user) throw new Error('User must be logged in');

    // Prepend country code to phone if it's being updated
    const processedUpdates = { ...updates };
    if (processedUpdates.phone !== undefined) {
      let phoneWithCountryCode = processedUpdates.phone || '';
      if (phoneWithCountryCode && !phoneWithCountryCode.startsWith('+')) {
        phoneWithCountryCode = `${getEffectiveCountryCode()}${phoneWithCountryCode}`;
      }
      processedUpdates.phone = phoneWithCountryCode;
    }

    // Clean Instagram username if it's being updated
    if (processedUpdates.instagram !== undefined) {
      processedUpdates.instagram = cleanInstagramUsername(processedUpdates.instagram);
    }

    const { error } = await supabase
      .from('companies')
      .update(processedUpdates)
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) {
      // Log raw error first to see full structure
      console.error('Error updating company - raw error:', error);
      console.error('Error updating company - error type:', typeof error);
      console.error('Error updating company - error keys:', error ? Object.keys(error) : 'error is null/undefined');
      
      // Build error details object with fallbacks
      const errorDetails = {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        id,
        updates: processedUpdates,
        errorString: error ? JSON.stringify(error, null, 2) : 'null',
      };
      
      console.error('Error updating company:', errorDetails);
      throw new Error(error?.message || 'Failed to update company');
    }

    await fetchCompanies();
  };

  const deleteCompany = async (id: string) => {
    if (!user) throw new Error('User must be logged in');

    const { error } = await supabase
      .from('companies')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) {
      // Log raw error first to see full structure
      console.error('Error deleting company - raw error:', error);
      console.error('Error deleting company - error type:', typeof error);
      console.error('Error deleting company - error keys:', error ? Object.keys(error) : 'error is null/undefined');
      
      // Build error details object with fallbacks
      const errorDetails = {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        id,
        errorString: error ? JSON.stringify(error, null, 2) : 'null',
      };
      
      console.error('Error deleting company:', errorDetails);
      throw new Error(error?.message || 'Failed to delete company');
    }

    await fetchCompanies();
  };

  const bulkUpdateSetName = async (ids: string[], setName: string | null) => {
    if (!user) throw new Error('User must be logged in');
    if (ids.length === 0) return;

    // Normalize empty string to null
    const setValue = setName?.trim() || null;

    const { error } = await supabase
      .from('companies')
      .update({ set_name: setValue })
      .in('id', ids)
      .eq('user_id', user.id);

    if (error) {
      console.error('Error bulk updating set_name - raw error:', error);
      console.error('Error bulk updating set_name - error type:', typeof error);
      console.error('Error bulk updating set_name - error keys:', error ? Object.keys(error) : 'error is null/undefined');
      
      const errorDetails = {
        message: error?.message || 'Unknown error',
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        ids,
        setName: setValue,
        errorString: error ? JSON.stringify(error, null, 2) : 'null',
      };
      
      console.error('Error bulk updating set_name:', errorDetails);
      throw new Error(error?.message || 'Failed to bulk update set_name');
    }

    await fetchCompanies();
    await fetchAvailableSetNames(); // Refresh available set names after update
  };

  const getCompanyCountsByOwner = async (period: AnalyticsPeriod): Promise<CompanyCountByOwner[]> => {
    if (!user) throw new Error('User must be logged in');

    const { data, error } = await supabase
      .rpc('get_company_counts_by_owner', {
        period: period
      });

    if (error) {
      console.error('Error fetching company counts by owner:', error);
      throw new Error(error?.message || 'Failed to fetch company counts by owner');
    }

    return data || [];
  };

  useEffect(() => {
    if (user) {
      fetchCompanies();
    } else {
      setCompanies([]);
      setLoading(false);
    }
  }, [user, fetchCompanies]);

  // Reset to page 1 when sort order or filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [sortOrder, dateFilter, customDateRange, classificationFilter, setNameFilter, ownerFilter]);

  // Refresh available set names and owners after create/update/delete
  useEffect(() => {
    if (user && companies.length >= 0) {
      fetchAvailableSetNames();
      fetchAvailableOwners();
    }
  }, [user, companies, fetchAvailableSetNames, fetchAvailableOwners]);

  const totalPages = Math.ceil(totalCount / pageSize);

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

  return (
    <CompaniesContext.Provider value={value}>
      {children}
    </CompaniesContext.Provider>
  );
};

export const useCompanies = () => {
  const context = useContext(CompaniesContext);
  if (context === undefined) {
    throw new Error('useCompanies must be within a CompaniesProvider');
  }
  return context;
};
