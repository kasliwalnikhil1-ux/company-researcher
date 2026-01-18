'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { supabase } from '@/utils/supabase/client';
import { useAuth } from './AuthContext';

export interface Company {
  id: string;
  user_id: string;
  domain: string;
  instagram: string;
  summary: any; // jsonb
  created_at?: string;
}

type SortOrder = 'newest' | 'oldest';
type DateFilter = 'all' | 'today' | 'yesterday' | 'last_week' | 'last_month';
type ClassificationFilter = 'all' | 'QUALIFIED' | 'NOT_QUALIFIED' | 'EXPIRED' | 'empty';

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
  classificationFilter: ClassificationFilter;
  setClassificationFilter: (filter: ClassificationFilter) => void;
  refreshCompanies: () => Promise<void>;
  createCompany: (company: Omit<Company, 'id' | 'user_id'>) => Promise<void>;
  updateCompany: (id: string, company: Partial<Omit<Company, 'id' | 'user_id'>>) => Promise<void>;
  deleteCompany: (id: string) => Promise<void>;
}

const CompaniesContext = createContext<CompaniesContextType | undefined>(undefined);

export const CompaniesProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [classificationFilter, setClassificationFilter] = useState<ClassificationFilter>('all');
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
  }, [user, sortOrder, currentPage, pageSize, dateFilter, classificationFilter]);

  const createCompany = async (company: Omit<Company, 'id' | 'user_id'>) => {
    if (!user) throw new Error('User must be logged in');

    const payload = {
      user_id: user.id,
      domain: company.domain || '',
      instagram: company.instagram || '',
      summary: company.summary || null,
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

    const { error } = await supabase
      .from('companies')
      .update(updates)
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
        updates,
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
  }, [sortOrder, dateFilter, classificationFilter]);

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
    classificationFilter,
    setClassificationFilter,
    refreshCompanies: fetchCompanies,
    createCompany,
    updateCompany,
    deleteCompany,
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
