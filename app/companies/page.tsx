'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useCompanies, Company } from '@/contexts/CompaniesContext';
import { supabase } from '@/utils/supabase/client';
import { buildEmailComposeUrl, buildEmailBody, type EmailSettings } from '@/lib/emailCompose';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import Toast from '@/components/ui/Toast';
import CompanyDetailsDrawer from '@/components/ui/CompanyDetailsDrawer';
import WhatsAppTemplateModal from '@/components/ui/WhatsAppTemplateModal';
import ManageColumnsDrawer from '@/components/ui/ManageColumnsDrawer';
import CompanyFormModal from '@/components/ui/CompanyFormModal';
import { generateMessageTemplates } from '@/lib/messageTemplates';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { Building2, Edit2, Trash2, Plus, X, Filter, ArrowUpDown, ChevronLeft, ChevronRight, ChevronDown, Eye, GitMerge, Phone, MessageCircle, Mail, Table, List } from 'lucide-react';
import { extractPhoneNumber, copyToClipboard } from '@/lib/utils';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const COLUMN_ORDER_KEY = 'companies-column-order';
const COLUMN_VISIBILITY_KEY = 'companies-column-visibility';
const CLIPBOARD_COLUMN_KEY = 'companies-clipboard-column';
const SUBJECT_COLUMN_KEY = 'companies-subject-column';
const PHONE_CLICK_BEHAVIOR_KEY = 'companies-phone-click-behavior';

export interface ColumnSettings {
  columnOrder?: string[];
  visibleColumns?: string[];
  clipboardColumn?: string | null;
  subjectColumn?: string | null;
  phoneClickBehavior?: 'whatsapp' | 'call';
}

// Helper function to extract domain from URL
const extractDomainFromUrl = (url: string): string => {
  if (!url) return url;
  try {
    // Remove protocol, www, and any path/query parameters
    let domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/:?]/)[0];
    return domain || url;
  } catch (e) {
    console.error('Error extracting domain:', e);
    return url;
  }
};

// Helper function to clean Instagram username
const cleanInstagramUsernameForSearch = (instagram: string): string => {
  if (!instagram) return instagram;

  return instagram
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
    .replace(/\/+$/, '')
    .replace(/^@/, '');
};

// Clean search query by detecting and cleaning URLs/Instagram handles
const cleanSearchQuery = (query: string): string => {
  if (!query || query.trim() === '') return query;

  const trimmed = query.trim();

  // Check if it's an Instagram URL or handle
  if (trimmed.includes('instagram.com') || trimmed.startsWith('@')) {
    return cleanInstagramUsernameForSearch(trimmed);
  }

  // Check if it's a URL (contains protocol or www)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('www.')) {
    return extractDomainFromUrl(trimmed);
  }

  return trimmed;
};


interface SummaryData {
  sales_action?: string;
  product_types?: string[] | null;
  classification?: 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE' | 'EXPIRED';
  company_summary?: string;
  company_industry?: string;
  confidence_score?: number;
  sales_opener_sentence?: string;
  profile_summary?: string;
  profile_industry?: string;
}

export default function CompaniesPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <CompaniesContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

function CompaniesContent() {
  const { user } = useAuth();
  const {
    companies,
    loading,
    searchLoading,
    createCompany,
    updateCompany,
    deleteCompany,
    bulkDeleteCompany,
    bulkUpdateSetName,
    sortOrder,
    setSortOrder,
    currentPage,
    setCurrentPage,
    totalCount,
    totalPages,
    pageSize,
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
    initializeCompanies
  } = useCompanies();

  // Email settings and column_settings from user_settings (for compose links and Manage Columns)
  const [emailSettings, setEmailSettings] = useState<EmailSettings | null>(null);
  const [columnSettingsFromApi, setColumnSettingsFromApi] = useState<ColumnSettings | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('user_settings')
        .select('email_settings, column_settings')
        .eq('id', user.id)
        .single();
      if (cancelled) return;
      const es = data?.email_settings;
      if (es && typeof es === 'object') {
        const parsed = typeof es === 'string' ? JSON.parse(es) : es;
        if (parsed && (parsed.provider === 'gmail' || parsed.provider === 'outlook')) {
          setEmailSettings({
            provider: parsed.provider,
            signature: typeof parsed.signature === 'string' ? parsed.signature : '',
          });
        } else {
          setEmailSettings(null);
        }
      } else {
        setEmailSettings(null);
      }
      const cs = data?.column_settings;
      if (cs && typeof cs === 'object') {
        const parsed = typeof cs === 'string' ? JSON.parse(cs) : cs;
        if (parsed && (Array.isArray(parsed.columnOrder) || Array.isArray(parsed.visibleColumns))) {
          setColumnSettingsFromApi(parsed as ColumnSettings);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Initialize companies on mount (only on Companies page)
  useEffect(() => {
    initializeCompanies();
  }, [initializeCompanies]);
  
  // Helper function to format date for date input (YYYY-MM-DD)
  const formatDateForInput = (date: Date | null): string => {
    if (!date) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  
  // Helper function to parse date input value to local Date object
  const parseDateFromInput = (value: string): Date | null => {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  };
  const { templates } = useMessageTemplates();
  const [companyFormModalOpen, setCompanyFormModalOpen] = useState(false);
  const [companyFormMode, setCompanyFormMode] = useState<'create' | 'edit'>('create');
  const [companyToEdit, setCompanyToEdit] = useState<Company | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [companyToDelete, setCompanyToDelete] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [companyToView, setCompanyToView] = useState<Company | null>(null);
  const [pendingPageDirection, setPendingPageDirection] = useState<'next' | 'prev' | null>(null);
  
  // Sync companyToView with updated companies array when drawer is open
  useEffect(() => {
    if (companyToView && drawerOpen) {
      const updatedCompany = companies.find(c => c.id === companyToView.id);
      if (updatedCompany) {
        // Update companyToView with the latest data from companies array
        setCompanyToView(updatedCompany);
      } else if (drawerOpen && companies.length > 0) {
        // If current company is not in the new page's companies, select appropriate company
        // This happens when navigating to a new page
        if (pendingPageDirection === 'next') {
          // When going to next page, select first company
          setCompanyToView(companies[0]);
        } else if (pendingPageDirection === 'prev') {
          // When going to previous page, select last company
          setCompanyToView(companies[companies.length - 1]);
        } else {
          // Default: select first company
          setCompanyToView(companies[0]);
        }
        setPendingPageDirection(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, drawerOpen]);
  
  // Toast state
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  
  // Inline editing state
  const [editingCell, setEditingCell] = useState<{ companyId: string; columnKey: string; value: string } | null>(null);
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  
  // Cell hover state - tracks which cell is hovered (only for truncated cells)
  const [hoveredCell, setHoveredCell] = useState<{ companyId: string; columnKey: string } | null>(null);
  
  // List view note editing state
  const [editingNoteState, setEditingNoteState] = useState<{ companyId: string; noteIndex: number; text: string } | null>(null);
  const [newNoteState, setNewNoteState] = useState<Record<string, string>>({});
  const [noteToDelete, setNoteToDelete] = useState<{ companyId: string; noteIndex: number } | null>(null);
  
  // Track click timeouts for phone/email double-click detection
  const clickTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Track if double-click is in progress to prevent single-click action
  const doubleClickInProgressRef = useRef<Map<string, boolean>>(new Map());

  // Search debouncing refs
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Local search input state (updates immediately for responsive UI)
  const [localSearchInput, setLocalSearchInput] = useState(searchQuery);

  // Table drag-to-pan state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartX, setDragStartX] = useState(0);
  const [scrollStartX, setScrollStartX] = useState(0);
  const tableScrollContainerRef = useRef<HTMLDivElement>(null);

  // Multi-select state
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [bulkDeleteModalOpen, setBulkDeleteModalOpen] = useState(false);
  const [assignSetModalOpen, setAssignSetModalOpen] = useState(false);
  const [assignSetName, setAssignSetName] = useState('');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  
  // WhatsApp template modal state
  const [whatsappTemplateModalOpen, setWhatsappTemplateModalOpen] = useState(false);
  const [selectedCompanyForWhatsApp, setSelectedCompanyForWhatsApp] = useState<Company | null>(null);
  
  // Generate template-based column keys
  const getTemplateColumnKeys = useCallback(() => {
    const directTemplates = templates.filter(t => t.channel === 'direct');
    const instagramTemplates = templates.filter(t => t.channel === 'instagram');
    
    const directColumns = directTemplates.map(t => `template_${t.id}`);
    const instagramColumns = instagramTemplates.map(t => `template_${t.id}`);
    
    return [...directColumns, ...instagramColumns];
  }, [templates]);

  // Column ordering and visibility - base columns without template columns
  const baseColumnOrder = [
    'domain',
    'instagram',
    'phone',
    'email',
    'set_name',
    'notes',
    'company_summary',
    'company_industry',
    'profile_summary',
    'profile_industry',
    'sales_opener_sentence',
    'classification',
    'confidence_score',
    'product_types',
    'sales_action',
  ];

  // Get template columns dynamically
  const templateColumns = getTemplateColumnKeys();
  
  // Combine base columns with template columns
  const getDefaultColumnOrder = useCallback(() => {
    return [...baseColumnOrder, ...templateColumns];
  }, [templateColumns]);
  
  const defaultColumnOrder = useMemo(() => getDefaultColumnOrder(), [getDefaultColumnOrder]);
  
  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    const initialTemplateColumns = templates
      .map(t => `template_${t.id}`);
    const initialDefault = [...baseColumnOrder, ...initialTemplateColumns];
    
    if (typeof window !== 'undefined') {
      const savedClipboardColumn = localStorage.getItem(CLIPBOARD_COLUMN_KEY);
      const saved = localStorage.getItem(COLUMN_ORDER_KEY);
      let order: string[] = initialDefault;
      
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          // Merge with current template columns to handle new templates
          const savedBase = parsed.filter((col: string) => !col.startsWith('template_') && col !== savedClipboardColumn);
          
          // Ensure all current base columns are included (add missing ones like phone/email)
          const missingBaseColumns = baseColumnOrder.filter(col => !savedBase.includes(col));
          const mergedBase = [...savedBase, ...missingBaseColumns];
          
          const currentTemplates = initialTemplateColumns;
          const merged = [...mergedBase, ...currentTemplates.filter(t => parsed.includes(t))];
          // Add any new template columns that weren't in saved
          const newTemplates = currentTemplates.filter(t => !parsed.includes(t));
          order = [...merged, ...newTemplates];
        } catch {
          order = initialDefault;
        }
      }
      
      // Check for clipboard column and move it to first position
      if (savedClipboardColumn && order.includes(savedClipboardColumn)) {
        const filtered = order.filter(col => col !== savedClipboardColumn);
        order = [savedClipboardColumn, ...filtered];
      }
      
      return order;
    }
    return initialDefault;
  });

  // Update column order and visible columns when templates change
  useEffect(() => {
    const currentTemplateColumns = getTemplateColumnKeys();
    setColumnOrder(prev => {
      // Preserve clipboard column if it exists and is first
      const wasFirst = prev[0] === clipboardColumn && clipboardColumn;
      
      // Remove old template columns and add new ones
      const baseColumns = prev.filter(col => !col.startsWith('template_') && col !== clipboardColumn);
      const existingTemplateColumns = prev.filter(col => col.startsWith('template_'));
      const newTemplateColumns = currentTemplateColumns.filter(
        tc => !existingTemplateColumns.includes(tc)
      );
      
      const newOrder = [...baseColumns, ...existingTemplateColumns.filter(tc => currentTemplateColumns.includes(tc)), ...newTemplateColumns];
      
      // Put clipboard column first if it was first before or if it exists
      if (clipboardColumn && (wasFirst || newOrder.includes(clipboardColumn))) {
        const filtered = newOrder.filter(col => col !== clipboardColumn);
        return [clipboardColumn, ...filtered];
      }
      
      return newOrder;
    });
    
    // Also update visible columns to include new template columns
    setVisibleColumns(prev => {
      const newSet = new Set(prev);
      currentTemplateColumns.forEach(col => {
        if (!newSet.has(col)) {
          newSet.add(col); // Add new template columns by default
        }
      });
      // Remove template columns that no longer exist
      const templateColumnsToRemove = Array.from(prev).filter(
        col => col.startsWith('template_') && !currentTemplateColumns.includes(col)
      );
      templateColumnsToRemove.forEach(col => newSet.delete(col));
      return newSet;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getTemplateColumnKeys]); // clipboardColumn is accessed in closure - separate effect handles its changes
  
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => {
    const initialTemplateColumns = templates
      .map(t => `template_${t.id}`);
    const initialDefault = [...baseColumnOrder, ...initialTemplateColumns];
    
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(COLUMN_VISIBILITY_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as string[];
          const savedSet = new Set<string>(parsed);
          // Ensure all base columns are visible by default (add missing ones like phone/email)
          const visibleSet = new Set<string>(savedSet);
          baseColumnOrder.forEach(col => {
            if (!visibleSet.has(col)) {
              visibleSet.add(col);
            }
          });
          // Also ensure template columns are visible
          initialTemplateColumns.forEach(col => {
            if (!visibleSet.has(col)) {
              visibleSet.add(col);
            }
          });
          return visibleSet;
        } catch {
          return new Set(initialDefault);
        }
      }
    }
    return new Set(initialDefault);
  });
  
  const [columnFilterOpen, setColumnFilterOpen] = useState(false);

  // Clipboard column state
  const [clipboardColumn, setClipboardColumn] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(CLIPBOARD_COLUMN_KEY);
      return saved || null;
    }
    return null;
  });
  
  // Subject column state
  const [subjectColumn, setSubjectColumn] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(SUBJECT_COLUMN_KEY);
      return saved || null;
    }
    return null;
  });
  
  // Phone click behavior state (default: 'whatsapp')
  const [phoneClickBehavior, setPhoneClickBehavior] = useState<'whatsapp' | 'call'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(PHONE_CLICK_BEHAVIOR_KEY);
      return (saved === 'whatsapp' || saved === 'call') ? saved : 'whatsapp';
    }
    return 'whatsapp';
  });
  
  // View mode state (table or list)
  const [viewMode, setViewMode] = useState<'table' | 'list'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('companies-view-mode');
      return (saved === 'list' || saved === 'table') ? saved : 'table';
    }
    return 'table';
  });
  
  // Save view mode to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('companies-view-mode', viewMode);
    }
  }, [viewMode]);
  
  
  // Save column order to localStorage (saves automatically whenever columnOrder changes)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(columnOrder));
    }
  }, [columnOrder]);
  
  // Save column visibility to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(Array.from(visibleColumns)));
    }
  }, [visibleColumns]);
  
  // Save clipboard column selection to localStorage (persists forever)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (clipboardColumn) {
        localStorage.setItem(CLIPBOARD_COLUMN_KEY, clipboardColumn);
      } else {
        localStorage.removeItem(CLIPBOARD_COLUMN_KEY);
      }
    }
  }, [clipboardColumn]);
  
  // Save subject column selection to localStorage (persists forever)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (subjectColumn) {
        localStorage.setItem(SUBJECT_COLUMN_KEY, subjectColumn);
      } else {
        localStorage.removeItem(SUBJECT_COLUMN_KEY);
      }
    }
  }, [subjectColumn]);
  
  // Save phone click behavior to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(PHONE_CLICK_BEHAVIOR_KEY, phoneClickBehavior);
    }
  }, [phoneClickBehavior]);
  
  // Reorder columns to put clipboard column first when it changes
  // This change will automatically trigger the columnOrder save effect above
  useEffect(() => {
    if (clipboardColumn) {
      setColumnOrder(prev => {
        // Check if clipboard column exists in order
        if (prev.includes(clipboardColumn)) {
          // Always ensure clipboard column is first (even on refresh/mount)
          if (prev[0] !== clipboardColumn) {
            const filtered = prev.filter(col => col !== clipboardColumn);
            // Moving clipboard column to first - this will trigger save via columnOrder effect
            const newOrder = [clipboardColumn, ...filtered];
            return newOrder;
          }
        } else {
          // If clipboard column doesn't exist, add it at the beginning
          // This will trigger save via columnOrder effect
          return [clipboardColumn, ...prev];
        }
        return prev;
      });
    }
    // If clipboard column is cleared, keep the order as is (no need to move anything)
  }, [clipboardColumn]);

  // Apply column_settings from API (merge with current base + template columns, then clear so we only apply once)
  useEffect(() => {
    if (!columnSettingsFromApi) return;
    const saved = columnSettingsFromApi;
    const currentTemplateColumns = getTemplateColumnKeys();

    if (Array.isArray(saved.columnOrder) && saved.columnOrder.length > 0) {
      const savedClipboard = saved.clipboardColumn ?? null;
      const savedBase = saved.columnOrder.filter((col: string) => !col.startsWith('template_') && col !== savedClipboard);
      const missingBase = baseColumnOrder.filter(col => !savedBase.includes(col));
      const mergedBase = [...savedBase, ...missingBase];
      const merged = [...mergedBase, ...currentTemplateColumns.filter(tc => saved.columnOrder!.includes(tc)), ...currentTemplateColumns.filter(tc => !saved.columnOrder!.includes(tc))];
      let order = merged;
      if (savedClipboard && order.includes(savedClipboard)) {
        order = [savedClipboard, ...order.filter(col => col !== savedClipboard)];
      }
      setColumnOrder(order);
    }

    if (Array.isArray(saved.visibleColumns) && saved.visibleColumns.length > 0) {
      const visibleSet = new Set<string>(saved.visibleColumns);
      baseColumnOrder.forEach(col => { if (!visibleSet.has(col)) visibleSet.add(col); });
      currentTemplateColumns.forEach(col => { if (!visibleSet.has(col)) visibleSet.add(col); });
      setVisibleColumns(visibleSet);
    }

    if (saved.clipboardColumn !== undefined) setClipboardColumn(saved.clipboardColumn ?? null);
    if (saved.subjectColumn !== undefined) setSubjectColumn(saved.subjectColumn ?? null);
    if (saved.phoneClickBehavior === 'whatsapp' || saved.phoneClickBehavior === 'call') setPhoneClickBehavior(saved.phoneClickBehavior);

    setColumnSettingsFromApi(null);
  }, [columnSettingsFromApi, getTemplateColumnKeys]);

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
        columnOrder,
        visibleColumns: Array.from(visibleColumns),
        clipboardColumn: clipboardColumn ?? null,
        subjectColumn: subjectColumn ?? null,
        phoneClickBehavior,
      },
    };
    const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
  }, [user?.id, columnOrder, visibleColumns, clipboardColumn, subjectColumn, phoneClickBehavior]);

  // Generate column labels including template-based labels
  const columnLabels = useMemo<Record<string, string>>(() => {
    const baseLabels: Record<string, string> = {
      domain: 'Domain',
      instagram: 'Instagram',
      phone: 'Phone',
      email: 'Email',
      set_name: 'Set Name',
      notes: 'Notes',
      company_summary: 'Company Summary',
      company_industry: 'Company Industry',
      profile_summary: 'Profile Summary',
      profile_industry: 'Profile Industry',
      sales_opener_sentence: 'Sales Opener Sentence',
      classification: 'Classification',
      confidence_score: 'Confidence Score',
      product_types: 'Product Types',
      sales_action: 'Sales Action',
    };

    // Add template-based labels
    templates.forEach(template => {
      const channelLabel = template.channel === 'direct' ? 'Direct Message' : 'Instagram Message';
      baseLabels[`template_${template.id}`] = `${template.title} - ${channelLabel}`;
    });

    return baseLabels;
  }, [templates]);
  
  
  // Extract summary data from company summary JSON
  const getSummaryData = useCallback((company: Company): SummaryData => {
    if (!company.summary || typeof company.summary !== 'object') {
      return {};
    }
    return company.summary as SummaryData;
  }, []);

  // Get message for a specific template
  const getMessageForTemplate = useCallback((company: Company, templateId: string): string => {
    const template = templates.find(t => t.id === templateId);
    if (!template) return '';

    const summaryData = getSummaryData(company);
    
    // Check if qualified and has product types
    if (
      summaryData.classification !== 'QUALIFIED' ||
      !summaryData.product_types ||
      !Array.isArray(summaryData.product_types) ||
      summaryData.product_types.length === 0
    ) {
      return '';
    }
    
    // Prepare qualification data for message generation
    const qualificationData = {
      product_types: summaryData.product_types,
      sales_opener_sentence: summaryData.sales_opener_sentence || '',
      company_industry: summaryData.company_industry || '',
      profile_industry: summaryData.profile_industry || '',
    };

    const isInstagram = template.channel === 'instagram';
    const messages = generateMessageTemplates(qualificationData, isInstagram, [template.template]);
    
    // Return the first message (each template generates one message)
    return messages.length > 0 ? messages[0] : '';
  }, [getSummaryData, templates]);
  
  // Get cell display value
  const getCellValue = useCallback((company: Company, columnKey: string): string => {
    const summaryData = getSummaryData(company);
    
    switch (columnKey) {
      case 'domain':
        return company.domain || '-';
      case 'instagram':
        return company.instagram || '-';
      case 'phone':
        return company.phone || '-';
      case 'email':
        return company.email || '-';
      case 'set_name':
        return company.set_name || '-';
      case 'notes':
        if (!company.notes || !Array.isArray(company.notes) || company.notes.length === 0) {
          return '-';
        }
        // Show count and latest note preview
        const latestNote = company.notes[company.notes.length - 1];
        const notePreview = latestNote?.message ? latestNote.message.substring(0, 50) : '';
        return `${company.notes.length} note${company.notes.length !== 1 ? 's' : ''}${notePreview ? `: ${notePreview}${notePreview.length >= 50 ? '...' : ''}` : ''}`;
      case 'company_summary':
        return summaryData.company_summary || '-';
      case 'company_industry':
        return summaryData.company_industry || '-';
      case 'profile_summary':
        return summaryData.profile_summary || '-';
      case 'profile_industry':
        return summaryData.profile_industry || '-';
      case 'sales_opener_sentence':
        return summaryData.sales_opener_sentence || '-';
      case 'classification':
        return summaryData.classification || '-';
      case 'confidence_score':
        return summaryData.confidence_score !== undefined 
          ? `${(summaryData.confidence_score * 100).toFixed(0)}%` 
          : '-';
      case 'product_types':
        return summaryData.product_types && Array.isArray(summaryData.product_types)
          ? summaryData.product_types.join(', ')
          : '-';
      case 'sales_action':
        return summaryData.sales_action || '-';
      default:
        // Check if this is a template column
        if (columnKey.startsWith('template_')) {
          const templateId = columnKey.replace('template_', '');
          return getMessageForTemplate(company, templateId);
        }
        return '-';
    }
  }, [getSummaryData, getMessageForTemplate]);
  
  // Generate messages for a company
  const getMessages = useCallback((company: Company, channel: 'direct' | 'instagram'): string[] => {
    const summaryData = getSummaryData(company);
    
    // Check if qualified and has product types
    if (
      summaryData.classification !== 'QUALIFIED' ||
      !summaryData.product_types ||
      !Array.isArray(summaryData.product_types) ||
      summaryData.product_types.length === 0
    ) {
      return [];
    }
    
    // Prepare qualification data for message generation
    const qualificationData = {
      product_types: summaryData.product_types,
      sales_opener_sentence: summaryData.sales_opener_sentence || '',
      company_industry: summaryData.company_industry || '',
      profile_industry: summaryData.profile_industry || '',
    };
    
    // Get templates from database
    const dbTemplates = templates
      .filter(t => t.channel === channel)
      .map(t => t.template)
      .filter(t => t && t.trim().length > 0);
    
    const templateStrings = dbTemplates.length > 0 ? dbTemplates : undefined;
    const isInstagram = channel === 'instagram';
    
    return generateMessageTemplates(qualificationData, isInstagram, templateStrings);
  }, [getSummaryData, templates]);
  
  // Handle cell click (copy to clipboard)
  const handleCellClick = useCallback(async (company: Company, columnKey: string) => {
    const value = getCellValue(company, columnKey);
    if (value && value !== '-') {
      try {
        await copyToClipboard(value);
        setToastMessage(`${columnLabels[columnKey]} copied to clipboard`);
        setToastVisible(true);
      } catch (error) {
        console.error('Failed to copy to clipboard:', error);
        setToastMessage('Failed to copy to clipboard');
        setToastVisible(true);
      }
    }
  }, [getCellValue, columnLabels]);
  
  // Handle cell double click (edit)
  const handleCellDoubleClick = useCallback((company: Company, columnKey: string) => {
    // Template columns are read-only
    if (columnKey.startsWith('template_')) {
      return;
    }
    
    // Domain and instagram are not directly editable (they have special link behavior)
    // But phone and email can be edited
    if (columnKey === 'domain' || columnKey === 'instagram') {
      return;
    }
    
    // Notes column opens drawer instead of inline editing
    if (columnKey === 'notes') {
      setCompanyToView(company);
      setDrawerOpen(true);
      return;
    }
    
    const currentValue = getCellValue(company, columnKey);
    setEditingCell({
      companyId: company.id,
      columnKey,
      value: currentValue === '-' ? '' : currentValue,
    });
  }, [getCellValue]);
  
  // Handle inline edit save
  const handleInlineEditSave = useCallback(async () => {
    if (!editingCell) return;
    
    const { companyId, columnKey, value } = editingCell;
    const company = companies.find(c => c.id === companyId);
    if (!company) return;
    
    try {
      // Handle direct company fields (not in summary)
      if (columnKey === 'phone') {
        const cleanedPhone = extractPhoneNumber(value);
        await updateCompany(companyId, { [columnKey]: cleanedPhone });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        return;
      }
      if (columnKey === 'email') {
        await updateCompany(companyId, { [columnKey]: value.trim() });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        return;
      }
      if (columnKey === 'set_name') {
        await updateCompany(companyId, { [columnKey]: value.trim() || null });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        return;
      }
      
      const summaryData = getSummaryData(company);
      const updatedSummary = { ...summaryData };
      
      // Update the specific field
      switch (columnKey) {
        case 'company_summary':
          updatedSummary.company_summary = value;
          break;
        case 'company_industry':
          updatedSummary.company_industry = value;
          break;
        case 'profile_summary':
          updatedSummary.profile_summary = value;
          break;
        case 'profile_industry':
          updatedSummary.profile_industry = value;
          break;
        case 'sales_opener_sentence':
          updatedSummary.sales_opener_sentence = value;
          break;
        case 'classification':
          if (['QUALIFIED', 'NOT_QUALIFIED', 'MAYBE', 'EXPIRED'].includes(value.toUpperCase())) {
            updatedSummary.classification = value.toUpperCase() as 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE' | 'EXPIRED';
          }
          break;
        case 'confidence_score':
          const score = parseFloat(value.replace('%', ''));
          if (!isNaN(score) && score >= 0 && score <= 100) {
            updatedSummary.confidence_score = score / 100;
          }
          break;
        case 'product_types':
          updatedSummary.product_types = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
          break;
        case 'sales_action':
          if (['OUTREACH', 'EXCLUDE', 'PARTNERSHIP', 'MANUAL_REVIEW'].includes(value.toUpperCase())) {
            updatedSummary.sales_action = value.toUpperCase() as 'OUTREACH' | 'EXCLUDE' | 'PARTNERSHIP' | 'MANUAL_REVIEW';
          }
          break;
      }
      
      await updateCompany(companyId, { summary: updatedSummary });
      setEditingCell(null);
      setToastMessage(`${columnLabels[columnKey]} updated successfully`);
      setToastVisible(true);
    } catch (error: any) {
      console.error('Error updating field:', error);
      setToastMessage(`Error updating ${columnLabels[columnKey]}: ${error.message}`);
      setToastVisible(true);
    }
  }, [editingCell, companies, getSummaryData, updateCompany, columnLabels]);
  
  // Focus input when editing starts
  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      if (editInputRef.current instanceof HTMLInputElement || editInputRef.current instanceof HTMLTextAreaElement) {
        // Place cursor at the end instead of selecting all text
        const length = editInputRef.current.value.length;
        editInputRef.current.setSelectionRange(length, length);
      }
    }
  }, [editingCell]);

  // Handle 'o' key to open drawer when a cell is hovered
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          (activeElement instanceof HTMLElement && activeElement.isContentEditable))
      ) {
        return;
      }

      // Check if 'o' key is pressed and a cell is hovered
      if (event.key === 'o' && hoveredCell) {
        const company = companies.find(c => c.id === hoveredCell.companyId);
        if (company) {
          setCompanyToView(company);
          setDrawerOpen(true);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [hoveredCell, companies]);

  // Sync local search input with context searchQuery when it changes externally
  useEffect(() => {
    setLocalSearchInput(searchQuery);
  }, [searchQuery]);

  // Debounced search functions
  const performSearch = useCallback((query: string) => {
    // Cancel any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller for this request
    abortControllerRef.current = new AbortController();

    // Clean the search query before searching
    const cleanedQuery = cleanSearchQuery(query);

    // Perform the search
    setSearchQuery(cleanedQuery);
  }, [setSearchQuery]);

  const debouncedSearch = useCallback((query: string) => {
    // Clear previous timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // For empty query, search immediately
    if (query.length === 0) {
      performSearch(query);
      return;
    }

    // For all other inputs, debounce
    searchTimeoutRef.current = setTimeout(() => {
      performSearch(query);
    }, 400);
  }, [performSearch]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    // Update local input immediately for responsive UI
    setLocalSearchInput(query);
    // Debounce the actual search
    debouncedSearch(query);
  }, [debouncedSearch]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Clear debounce timeout and perform immediate search
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      const query = (e.target as HTMLInputElement).value;
      setLocalSearchInput(query);
      performSearch(query);
    }
  }, [performSearch]);

  const handleClearSearch = useCallback(() => {
    // Clear debounce timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    // Clear local input immediately
    setLocalSearchInput('');
    // Clear search query
    performSearch('');
  }, [performSearch]);

  // Cleanup timeouts and abort controllers on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const handleCompanyFormSave = async (formData: {
    domain: string;
    instagram: string;
    phone: string;
    email: string;
    summary: string;
    set_name: string;
  }) => {
    let summaryValue = null;
    if (formData.summary.trim()) {
      try {
        summaryValue = JSON.parse(formData.summary.trim());
      } catch {
        summaryValue = { text: formData.summary.trim() };
      }
    }

    if (companyFormMode === 'create') {
      await createCompany({
        domain: formData.domain.trim(),
        instagram: formData.instagram.trim(),
        phone: extractPhoneNumber(formData.phone),
        email: formData.email.trim(),
        summary: summaryValue,
        set_name: formData.set_name.trim() || null,
        owner: null,
      });
    } else if (companyFormMode === 'edit' && companyToEdit) {
      await updateCompany(companyToEdit.id, {
        domain: formData.domain.trim(),
        instagram: formData.instagram.trim(),
        phone: extractPhoneNumber(formData.phone),
        email: formData.email.trim(),
        summary: summaryValue,
        set_name: formData.set_name.trim() || null,
      });
    }
  };

  const handleDeleteClick = (id: string) => {
    setCompanyToDelete(id);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!companyToDelete) return;

    try {
      await deleteCompany(companyToDelete);
      setDeleteModalOpen(false);
      setCompanyToDelete(null);
    } catch (error: any) {
      alert(`Error deleting company: ${error.message}`);
      setDeleteModalOpen(false);
      setCompanyToDelete(null);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteModalOpen(false);
    setCompanyToDelete(null);
  };

  // Handle row selection
  const handleRowSelect = (companyId: string, isSelected: boolean) => {
    setSelectedCompanyIds(prev => {
      const newSet = new Set(prev);
      if (isSelected) {
        newSet.add(companyId);
      } else {
        newSet.delete(companyId);
      }
      return newSet;
    });
  };

  // Handle select all
  const handleSelectAll = (isSelected: boolean) => {
    if (isSelected) {
      setSelectedCompanyIds(new Set(companies.map(c => c.id)));
    } else {
      setSelectedCompanyIds(new Set());
    }
  };

  // Table drag-to-pan handlers
  const handleTableMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only start drag on left mouse button
    if (e.button !== 0) return;
    
    // Don't start drag if clicking on interactive elements (buttons, inputs, links, etc.)
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'BUTTON' ||
      target.tagName === 'INPUT' ||
      target.tagName === 'A' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA' ||
      target.closest('button, input, a, select, textarea')
    ) {
      return;
    }

    setIsDragging(true);
    setDragStartX(e.clientX);
    if (tableScrollContainerRef.current) {
      setScrollStartX(tableScrollContainerRef.current.scrollLeft);
    }
    e.preventDefault();
  }, []);

  const handleTableMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !tableScrollContainerRef.current) return;
    
    const deltaX = e.clientX - dragStartX;
    tableScrollContainerRef.current.scrollLeft = scrollStartX - deltaX;
    e.preventDefault();
  }, [isDragging, dragStartX, scrollStartX]);

  const handleTableMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleTableMouseLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Global mouse handlers to handle dragging when mouse moves outside container
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!tableScrollContainerRef.current) return;
      const deltaX = e.clientX - dragStartX;
      tableScrollContainerRef.current.scrollLeft = scrollStartX - deltaX;
    };

    const handleGlobalMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDragging, dragStartX, scrollStartX]);

  // Helper function to check if a value is empty (null, undefined, empty string, or whitespace-only)
  const isEmpty = (value: any): boolean => {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') {
      return value.trim().length === 0;
    }
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    return false;
  };

  // Helper function to check if a value is not empty
  const isNotEmpty = (value: any): boolean => {
    return !isEmpty(value);
  };

  // Handle bulk delete
  const handleBulkDelete = async () => {
    if (selectedCompanyIds.size === 0) {
      setToastMessage('Please select at least one company to delete');
      setToastVisible(true);
      return;
    }

    try {
      const count = selectedCompanyIds.size;
      const idsArray = Array.from(selectedCompanyIds);
      // Delete all selected companies in one operation
      await bulkDeleteCompany(idsArray);

      // Clear selection
      setSelectedCompanyIds(new Set());
      setBulkDeleteModalOpen(false);
      setToastMessage(`Successfully deleted ${count} ${count === 1 ? 'company' : 'companies'}`);
      setToastVisible(true);
    } catch (error: any) {
      console.error('Error deleting companies:', error);
      setToastMessage(`Error deleting companies: ${error.message}`);
      setToastVisible(true);
    }
  };

  // Handle assign set
  const handleAssignSet = async () => {
    if (selectedCompanyIds.size === 0) {
      setToastMessage('Please select at least one company to assign set');
      setToastVisible(true);
      return;
    }

    try {
      const count = selectedCompanyIds.size;
      const setName = assignSetName.trim() || null;
      
      // Update set_name for all selected companies
      await bulkUpdateSetName(Array.from(selectedCompanyIds), setName);

      // Clear selection and close modal
      setSelectedCompanyIds(new Set());
      setAssignSetModalOpen(false);
      setAssignSetName('');
      setToastMessage(`Successfully assigned set "${setName || 'empty'}" to ${count} ${count === 1 ? 'company' : 'companies'}`);
      setToastVisible(true);
    } catch (error: any) {
      console.error('Error assigning set:', error);
      setToastMessage(`Error assigning set: ${error.message}`);
      setToastVisible(true);
    }
  };

  // Handle merge
  const handleMerge = async () => {
    if (selectedCompanyIds.size < 2) {
      setToastMessage('Please select at least 2 companies to merge');
      setToastVisible(true);
      return;
    }

    try {
      // Get all selected companies
      const selectedCompanies = companies.filter(c => selectedCompanyIds.has(c.id));
      
      // Sort by created_at to find the newest (keep this one)
      const sortedCompanies = [...selectedCompanies].sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return dateB - dateA; // Newest first
      });

      const newestCompany = sortedCompanies[0];
      const companiesToMerge = sortedCompanies.slice(1);

      // Start with the newest company's data
      // Normalize empty strings to empty strings (keep as is, isEmpty will handle them)
      const mergedData: Partial<Company> = {
        domain: newestCompany.domain ?? '',
        instagram: newestCompany.instagram ?? '',
        phone: newestCompany.phone ?? '',
        email: newestCompany.email ?? '',
        summary: newestCompany.summary ? { ...newestCompany.summary } : null,
      };

      // Merge data from other companies
      for (const company of companiesToMerge) {
        // Merge direct fields (only if newest is empty and other has value)
        if (isEmpty(mergedData.domain) && isNotEmpty(company.domain)) {
          mergedData.domain = company.domain;
        }
        if (isEmpty(mergedData.instagram) && isNotEmpty(company.instagram)) {
          mergedData.instagram = company.instagram;
        }
        if (isEmpty(mergedData.phone) && isNotEmpty(company.phone)) {
          mergedData.phone = company.phone;
        }
        if (isEmpty(mergedData.email) && isNotEmpty(company.email)) {
          mergedData.email = company.email;
        }

        // Merge summary data
        if (company.summary && typeof company.summary === 'object') {
          const otherSummary = company.summary as SummaryData;
          const currentSummary = mergedData.summary as SummaryData | null;

          if (!currentSummary) {
            mergedData.summary = { ...otherSummary };
          } else {
            // Merge summary fields - for conflicts, keep newest (already in currentSummary)
            const mergedSummary: SummaryData = { ...currentSummary };

            // Only add non-empty values from other company if current is empty
            if (isEmpty(mergedSummary.company_summary) && isNotEmpty(otherSummary.company_summary)) {
              mergedSummary.company_summary = otherSummary.company_summary;
            }
            if (isEmpty(mergedSummary.company_industry) && isNotEmpty(otherSummary.company_industry)) {
              mergedSummary.company_industry = otherSummary.company_industry;
            }
            if (isEmpty(mergedSummary.profile_summary) && isNotEmpty(otherSummary.profile_summary)) {
              mergedSummary.profile_summary = otherSummary.profile_summary;
            }
            if (isEmpty(mergedSummary.profile_industry) && isNotEmpty(otherSummary.profile_industry)) {
              mergedSummary.profile_industry = otherSummary.profile_industry;
            }
            if (isEmpty(mergedSummary.sales_opener_sentence) && isNotEmpty(otherSummary.sales_opener_sentence)) {
              mergedSummary.sales_opener_sentence = otherSummary.sales_opener_sentence;
            }
            if (isEmpty(mergedSummary.classification) && isNotEmpty(otherSummary.classification)) {
              mergedSummary.classification = otherSummary.classification;
            }
            if ((mergedSummary.confidence_score === undefined || mergedSummary.confidence_score === null) && (otherSummary.confidence_score !== undefined && otherSummary.confidence_score !== null)) {
              mergedSummary.confidence_score = otherSummary.confidence_score;
            }
            if (isEmpty(mergedSummary.product_types) && isNotEmpty(otherSummary.product_types)) {
              mergedSummary.product_types = otherSummary.product_types;
            }
            if (isEmpty(mergedSummary.sales_action) && isNotEmpty(otherSummary.sales_action)) {
              mergedSummary.sales_action = otherSummary.sales_action;
            }

            mergedData.summary = mergedSummary;
          }
        }
      }

      // Update the newest company with merged data
      await updateCompany(newestCompany.id, mergedData);

      // Delete the other companies
      for (const company of companiesToMerge) {
        await deleteCompany(company.id);
      }

      // Clear selection
      setSelectedCompanyIds(new Set());
      setMergeModalOpen(false);
      setToastMessage(`Successfully merged ${companiesToMerge.length} ${companiesToMerge.length === 1 ? 'company' : 'companies'} into ${newestCompany.domain || 'selected company'}`);
      setToastVisible(true);
    } catch (error: any) {
      console.error('Error merging companies:', error);
      setToastMessage(`Error merging companies: ${error.message}`);
      setToastVisible(true);
    }
  };

  const startEditing = (company: Company) => {
    setCompanyToEdit(company);
    setCompanyFormMode('edit');
    setCompanyFormModalOpen(true);
  };

  const handleAddCompany = () => {
    setCompanyToEdit(null);
    setCompanyFormMode('create');
    setCompanyFormModalOpen(true);
  };


  const toggleColumn = (column: string) => {
    const newVisibleColumns = new Set(visibleColumns);
    if (newVisibleColumns.has(column)) {
      newVisibleColumns.delete(column);
    } else {
      newVisibleColumns.add(column);
    }
    setVisibleColumns(newVisibleColumns);
  };
  
  // Get ordered visible columns
  const orderedVisibleColumns = useMemo(() => {
    return columnOrder.filter(col => visibleColumns.has(col));
  }, [columnOrder, visibleColumns]);
  
  // Helper function to handle phone call click
  const handlePhoneCall = useCallback((phone: string) => {
    const cleanedPhone = phone.trim().replace(/[^\d+]/g, '');
    window.location.href = `tel:${cleanedPhone}`;
  }, []);
  
  // Helper function to handle WhatsApp click (with pre-filled text)
  const handleWhatsAppClick = useCallback(async (company: Company, phoneOverride?: string) => {
    const phoneToUse = phoneOverride || company.phone;
    if (!phoneToUse || phoneToUse === '-') return;
    
    const phone = phoneToUse.trim().replace(/[^\d+]/g, '');
    let whatsappUrl = `https://wa.me/${phone}`;
    
    // Add clipboard column value as pre-filled message if available
    if (clipboardColumn) {
      const clipboardValue = getCellValue(company, clipboardColumn);
      if (clipboardValue && clipboardValue !== '-') {
        const encodedMessage = encodeURIComponent(clipboardValue);
        whatsappUrl += `?text=${encodedMessage}`;
        // Copy to clipboard
        try {
          await copyToClipboard(clipboardValue);
          setToastMessage(`${columnLabels[clipboardColumn]} copied to clipboard`);
          setToastVisible(true);
        } catch (error) {
          console.error('Failed to copy to clipboard:', error);
        }
      }
    }
    
    window.open(whatsappUrl, '_blank');
  }, [clipboardColumn, getCellValue, columnLabels]);
  
  // Helper function to handle WhatsApp click without pre-filled text
  const handleWhatsAppClickNoText = useCallback((company: Company, phoneOverride?: string) => {
    const phoneToUse = phoneOverride || company.phone;
    if (!phoneToUse || phoneToUse === '-') return;
    
    // Create a temporary company object with the specific phone number for the modal
    const companyWithPhone = { ...company, phone: phoneToUse };
    
    // Open modal to select message template
    setSelectedCompanyForWhatsApp(companyWithPhone);
    setWhatsappTemplateModalOpen(true);
  }, []);
  
  // Helper function to handle template selection and open WhatsApp
  const handleTemplateSelect = useCallback((columnKey: string) => {
    if (!selectedCompanyForWhatsApp || !selectedCompanyForWhatsApp.phone || selectedCompanyForWhatsApp.phone === '-') return;
    
    const phone = selectedCompanyForWhatsApp.phone.trim().replace(/[^\d+]/g, '');
    const message = getCellValue(selectedCompanyForWhatsApp, columnKey);
    
    let whatsappUrl = `https://wa.me/${phone}`;
    
    // If message exists and is not empty, add it to the URL
    if (message && message !== '-' && message.trim() !== '') {
      const encodedMessage = encodeURIComponent(message.trim());
      whatsappUrl += `?text=${encodedMessage}`;
    }
    
    window.open(whatsappUrl, '_blank');
    setSelectedCompanyForWhatsApp(null);
  }, [selectedCompanyForWhatsApp, getCellValue]);
  
  // Helper function to handle email click (uses user email_settings for provider + signature)
  // Always includes subject and body when configured, with signature in body
  const handleEmailClick = useCallback((company: Company, emailOverride?: string) => {
    const emailToUse = emailOverride || company.email;
    if (!emailToUse || emailToUse === '-') return;
    
    const email = emailToUse.trim();
    let subject: string | undefined;
    let body: string | undefined;
    
    // Always try to get subject if column is configured
    if (subjectColumn) {
      const subjectValue = getCellValue(company, subjectColumn);
      if (subjectValue && subjectValue !== '-') {
        subject = subjectValue;
      }
    }
    
    // Always try to get body with signature if clipboard column is configured
    if (clipboardColumn) {
      const clipboardValue = getCellValue(company, clipboardColumn);
      if (clipboardValue && clipboardValue !== '-') {
        // Build body with greeting, clipboard content, and signature
        body = buildEmailBody(clipboardValue, 'Hi, \n\n', emailSettings);
      }
    }
    
    // Build compose URL with subject and body (signature included in body if body exists)
    const url = buildEmailComposeUrl(email, { subject, body, emailSettings });
    window.open(url, '_blank');
  }, [subjectColumn, clipboardColumn, getCellValue, emailSettings]);

  // Copy clipboard column on domain/Instagram link click (same logic as table cells)
  const handleDomainInstagramLinkClick = useCallback(async (company: Company) => {
    if (!clipboardColumn) return;
    const clipboardValue = getCellValue(company, clipboardColumn);
    if (!clipboardValue || clipboardValue === '-') return;
    try {
      await copyToClipboard(clipboardValue);
      setToastMessage(`${columnLabels[clipboardColumn]} copied to clipboard`);
      setToastVisible(true);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      setToastMessage('Failed to copy to clipboard');
      setToastVisible(true);
    }
  }, [clipboardColumn, getCellValue, columnLabels]);

  // Helper function to handle notes update in cards
  const handleNotesUpdate = useCallback(async (companyId: string, newNote: string) => {
    const company = companies.find(c => c.id === companyId);
    if (!company) return;
    
    const currentNotes = company.notes && Array.isArray(company.notes) ? company.notes : [];
    const updatedNotes = [...currentNotes, { 
      message: newNote.trim(), 
      date: new Date().toISOString().split('T')[0] 
    }];
    
    try {
      await updateCompany(companyId, { notes: updatedNotes });
      setToastMessage('Note added successfully');
      setToastVisible(true);
    } catch (error: any) {
      console.error('Failed to update notes:', error);
      setToastMessage(`Error updating notes: ${error.message}`);
      setToastVisible(true);
    }
  }, [companies, updateCompany]);

  // Delete note (list view) - open confirm modal
  const handleDeleteNoteClick = useCallback((companyId: string, noteIndex: number) => {
    setNoteToDelete({ companyId, noteIndex });
  }, []);

  // Delete note (list view) - confirm and persist
  const handleDeleteNoteConfirm = useCallback(async () => {
    if (!noteToDelete) return;
    const company = companies.find(c => c.id === noteToDelete.companyId);
    if (!company) {
      setNoteToDelete(null);
      return;
    }
    const notes = company.notes && Array.isArray(company.notes) ? company.notes : [];
    const updatedNotes = notes.filter((_, i) => i !== noteToDelete.noteIndex);
    const finalNotes = updatedNotes.length > 0 ? updatedNotes : null;
    try {
      await updateCompany(noteToDelete.companyId, { notes: finalNotes });
      setNoteToDelete(null);
      setToastMessage('Note deleted successfully');
      setToastVisible(true);
    } catch (error: any) {
      console.error('Failed to delete note:', error);
      setToastMessage(`Error deleting note: ${error.message}`);
      setToastVisible(true);
      setNoteToDelete(null);
    }
  }, [noteToDelete, companies, updateCompany]);

  const handleDeleteNoteCancel = useCallback(() => {
    setNoteToDelete(null);
  }, []);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-full mx-auto">
      <div className="mb-4 md:mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Building2 className="w-6 h-6 md:w-8 md:h-8" />
          Companies
        </h1>
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          {selectedCompanyIds.size > 0 ? (
            <>
              <button
                onClick={() => setAssignSetModalOpen(true)}
                className="inline-flex items-center px-3 md:px-4 py-2 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                <span className="hidden sm:inline">Assign Set </span>({selectedCompanyIds.size})
              </button>
              <button
                onClick={() => setMergeModalOpen(true)}
                className="inline-flex items-center px-3 md:px-4 py-2 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700"
              >
                <GitMerge className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Merge Selected </span>({selectedCompanyIds.size})
              </button>
              <button
                onClick={() => setBulkDeleteModalOpen(true)}
                className="inline-flex items-center px-3 md:px-4 py-2 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700"
              >
                <Trash2 className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Delete Selected </span>({selectedCompanyIds.size})
              </button>
            </>
          ) : (
            <>
              {/* View Toggle: Table/List */}
              <div className="inline-flex items-center border border-gray-300 rounded-md overflow-hidden bg-white">
                <button
                  onClick={() => setViewMode('table')}
                  className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center ${
                    viewMode === 'table'
                      ? 'text-white bg-indigo-600 hover:bg-indigo-700'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                  title="Table View"
                >
                  <Table className="w-4 h-4" />
                </button>
                <div className="h-6 w-px bg-gray-300"></div>
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-3 md:px-4 py-2 transition-colors flex items-center justify-center ${
                    viewMode === 'list'
                      ? 'text-white bg-indigo-600 hover:bg-indigo-700'
                      : 'text-gray-700 hover:bg-gray-50'
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
              <button
                onClick={handleAddCompany}
                className="inline-flex items-center px-3 md:px-4 py-2 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
              >
                <Plus className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Add Company</span>
                <span className="sm:hidden">Add</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Column Management Drawer */}
      <ManageColumnsDrawer
        isOpen={columnFilterOpen}
        onClose={() => setColumnFilterOpen(false)}
        columnOrder={columnOrder}
        visibleColumns={visibleColumns}
        columnLabels={columnLabels}
        clipboardColumn={clipboardColumn}
        subjectColumn={subjectColumn}
        phoneClickBehavior={phoneClickBehavior}
        onColumnOrderChange={setColumnOrder}
        onToggleColumn={toggleColumn}
        onClipboardColumnChange={setClipboardColumn}
        onSubjectColumnChange={setSubjectColumn}
        onPhoneClickBehaviorChange={setPhoneClickBehavior}
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

      {/* Search and Filter & Sort Button (Mobile) */}
      <div className="mb-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
        <div className="relative flex-1 max-w-full sm:max-w-md">
          <input
            type="text"
            placeholder="Search companies..."
            value={localSearchInput}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            className="block w-full px-4 py-2 pr-10 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 text-sm"
          />
          {localSearchInput && (
            <button
              onClick={handleClearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {/* Mobile Filter & Sort Button */}
        <button
          onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}
          className="sm:hidden flex items-center justify-center gap-2 px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
        >
          <Filter className="w-4 h-4" />
          <span>Filter & Sort</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${mobileFiltersOpen ? 'rotate-180' : ''}`} />
        </button>
        {/* Desktop Sort */}
        <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
          <ArrowUpDown className="w-4 h-4 text-gray-500" />
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest')}
            className="flex-none px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
          </select>
        </div>
      </div>

      {/* Mobile Sort and Filters - Collapsible */}
      <div className={`sm:hidden mb-4 ${mobileFiltersOpen ? 'block' : 'hidden'}`}>
        <div className="flex flex-col gap-3">
          {/* Mobile Sort */}
          <div className="flex items-center gap-2">
            <ArrowUpDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest')}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
            </select>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className={`mb-4 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 sm:gap-4 ${mobileFiltersOpen ? 'sm:flex' : 'hidden sm:flex'}`}>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1 sm:flex-initial">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-500 flex-shrink-0" />
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value as 'all' | 'today' | 'yesterday' | 'last_week' | 'last_month' | 'custom')}
              className="flex-1 sm:flex-initial px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="all">All Dates</option>
              <option value="today">Created Today</option>
              <option value="yesterday">Created Yesterday</option>
              <option value="last_week">Created Last Week</option>
              <option value="last_month">Created Last Month</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>
          {dateFilter === 'custom' && (
            <div className="flex items-center gap-2 sm:ml-0">
              <input
                type="date"
                value={formatDateForInput(customDateRange.start)}
                onChange={(e) => {
                  setCustomDateRange({ 
                    ...customDateRange, 
                    start: parseDateFromInput(e.target.value) 
                  });
                }}
                className="flex-1 sm:flex-initial px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="Start date"
              />
              <span className="text-gray-500 text-sm flex-shrink-0">to</span>
              <input
                type="date"
                value={formatDateForInput(customDateRange.end)}
                onChange={(e) => {
                  setCustomDateRange({ 
                    ...customDateRange, 
                    end: parseDateFromInput(e.target.value) 
                  });
                }}
                className="flex-1 sm:flex-initial px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="End date"
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-1 sm:flex-initial">
          <select
            value={classificationFilter}
            onChange={(e) => setClassificationFilter(e.target.value as 'all' | 'QUALIFIED' | 'NOT_QUALIFIED' | 'EXPIRED' | 'empty')}
            className="flex-1 sm:flex-initial px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="all">All Classifications</option>
            <option value="QUALIFIED">QUALIFIED</option>
            <option value="NOT_QUALIFIED">NOT QUALIFIED</option>
            <option value="EXPIRED">EXPIRED</option>
            <option value="empty">Empty/Null Summary</option>
          </select>
        </div>
        <div className="flex items-center gap-2 flex-1 sm:flex-initial">
          <select
            value={setNameFilter || 'all'}
            onChange={(e) => setSetNameFilter(e.target.value === 'all' ? null : (e.target.value === '' ? '' : e.target.value))}
            className="flex-1 sm:flex-initial px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="all">All Sets</option>
            <option value="">No Set (null/empty)</option>
            {availableSetNames.map((setName) => (
              <option key={setName} value={setName}>
                {setName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 flex-1 sm:flex-initial">
          <select
            value={ownerFilter || 'all'}
            onChange={(e) => setOwnerFilter(e.target.value === 'all' ? null : (e.target.value === '' ? '' : e.target.value))}
            className="flex-1 sm:flex-initial px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="all">All Owners</option>
            <option value="">No Owner (null/empty)</option>
            {availableOwners.map((owner) => (
              <option key={owner} value={owner}>
                {owner}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 flex-1 sm:flex-initial">
          <select
            value={domainInstagramFilter}
            onChange={(e) => setDomainInstagramFilter(e.target.value as 'any' | 'has_valid_domain' | 'has_valid_instagram' | 'has_valid_phone' | 'has_valid_email')}
            className="flex-1 sm:flex-initial px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="any">Any</option>
            <option value="has_valid_domain">Has Valid Domain</option>
            <option value="has_valid_instagram">Has Valid Instagram</option>
            <option value="has_valid_phone">Has Valid Phone</option>
            <option value="has_valid_email">Has Valid Email</option>
          </select>
        </div>
      </div>

      {/* Company Form Modal */}
      <CompanyFormModal
        isOpen={companyFormModalOpen}
        onClose={() => {
          setCompanyFormModalOpen(false);
          setCompanyToEdit(null);
        }}
        onSave={handleCompanyFormSave}
        company={companyToEdit}
        availableSetNames={availableSetNames}
        mode={companyFormMode}
      />

      {/* Companies Table or Cards */}
      {companies.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 md:p-12 text-center">
          <Building2 className="w-10 h-10 md:w-12 md:h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-sm md:text-base text-gray-500 mb-4">
            {searchQuery ? 'No companies found matching your search.' : 'No companies found. Create your first company to get started.'}
          </p>
        </div>
      ) : viewMode === 'list' ? (
        /* List View - Compact Cards */
        <div className="space-y-4">
          {companies.map((company) => {
            const domain = company.domain && company.domain !== '-' ? company.domain.trim() : null;
            const instagram = company.instagram && company.instagram !== '-' ? company.instagram.trim().replace(/^@/, '') : null;
            const phone = company.phone && company.phone !== '-' ? company.phone.trim() : null;
            const email = company.email && company.email !== '-' ? company.email.trim() : null;
            const notes = company.notes && Array.isArray(company.notes) ? company.notes : [];
            const isEditingThisNote = editingNoteState?.companyId === company.id;
            const editingNoteIndex = isEditingThisNote ? editingNoteState!.noteIndex : null;
            const editingNoteText = isEditingThisNote ? editingNoteState!.text : '';
            const newNote = newNoteState[company.id] || '';
            
            return (
              <div
                key={company.id}
                className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm"
              >
                {/* Domain/Instagram Tags - click to open, same copy-to-clipboard logic as table */}
                <div className="flex flex-wrap gap-2 mb-3">
                  {domain && (
                    <a
                      href={domain.startsWith('http://') || domain.startsWith('https://') ? domain : `https://${domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={async (e) => {
                        await handleDomainInstagramLinkClick(company);
                      }}
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 hover:bg-blue-200 cursor-pointer transition-colors"
                    >
                      {domain.startsWith('http://') || domain.startsWith('https://') ? domain : `https://${domain}`}
                    </a>
                  )}
                  {instagram && (
                    <a
                      href={`https://instagram.com/${instagram}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={async (e) => {
                        await handleDomainInstagramLinkClick(company);
                      }}
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-pink-100 text-pink-800 hover:bg-pink-200 cursor-pointer transition-colors"
                    >
                      @{instagram}
                    </a>
                  )}
                </div>
                
                {/* Phone with Call and WhatsApp Icons */}
                {phone && (
                  <div className="mb-3">
                    {phone.split(',').map((phoneNum, index) => {
                      const trimmedPhone = phoneNum.trim();
                      if (!trimmedPhone) return null;
                      return (
                        <div key={index} className="flex items-center gap-3 mb-2">
                          <span className="text-sm text-gray-900 flex-1">{trimmedPhone}</span>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handlePhoneCall(trimmedPhone)}
                              className="p-2 rounded-full bg-green-100 text-green-700 hover:bg-green-200 transition-colors"
                              title="Call"
                            >
                              <Phone className="w-5 h-5" />
                            </button>
                            <button
                              onClick={() => handleWhatsAppClick(company, trimmedPhone)}
                              className="p-2 rounded-full bg-green-100 text-green-700 hover:bg-green-200 transition-colors"
                              title="WhatsApp (with pre-filled text)"
                            >
                              <MessageCircle className="w-5 h-5" />
                            </button>
                            <button
                              onClick={() => handleWhatsAppClickNoText(company, trimmedPhone)}
                              className="p-2 rounded-full bg-gray-200 text-gray-700 border border-gray-400 hover:bg-gray-300 transition-colors"
                              title="WhatsApp (no text)"
                            >
                              <MessageCircle className="w-5 h-5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                
                {/* Email */}
                {email && (
                  <div className="mb-3">
                    {email.split(',').map((emailAddr, index) => {
                      const trimmedEmail = emailAddr.trim();
                      if (!trimmedEmail) return null;
                      return (
                        <div key={index} className="flex items-center gap-3 mb-2">
                          <span className="text-sm font-medium text-gray-700 min-w-[80px]">Email:</span>
                          <button
                            onClick={() => handleEmailClick(company, trimmedEmail)}
                            className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            <Mail className="w-4 h-4" />
                            {trimmedEmail}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                
                {/* Notes Section */}
                <div className="border-t border-gray-200 pt-3 mt-3">
                  <div className="text-xs font-medium text-gray-700 mb-2">Notes:</div>
                  <div className="space-y-2 mb-3">
                    {notes.map((note: any, index: number) => (
                      <div key={index} className="text-sm text-gray-700 bg-gray-50 p-2 rounded">
                        {editingNoteIndex === index ? (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={editingNoteText}
                              onChange={(e) => setEditingNoteState({ companyId: company.id, noteIndex: index, text: e.target.value })}
                              onBlur={async () => {
                                const updatedNotes = [...notes];
                                updatedNotes[index] = { ...note, message: editingNoteText.trim() };
                                try {
                                  await updateCompany(company.id, { notes: updatedNotes });
                                  setEditingNoteState(null);
                                  setToastMessage('Note updated successfully');
                                  setToastVisible(true);
                                } catch (error: any) {
                                  console.error('Failed to update note:', error);
                                  setToastMessage(`Error updating note: ${error.message}`);
                                  setToastVisible(true);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                  setEditingNoteState(null);
                                }
                              }}
                              className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                              autoFocus
                            />
                          </div>
                        ) : (
                          <div 
                            className="flex items-start justify-between gap-1 cursor-pointer hover:bg-gray-100 p-1 rounded"
                            onClick={() => {
                              setEditingNoteState({ companyId: company.id, noteIndex: index, text: note.message || '' });
                            }}
                          >
                            <span className="flex-1">{note.message || ''}</span>
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDeleteNoteClick(company.id, index);
                                }}
                                className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                title="Delete note"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                              <Edit2 className="w-3 h-3 text-gray-400" />
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setNewNoteState({ ...newNoteState, [company.id]: 'Not Picked' });
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                      >
                        Not Picked
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setNewNoteState({ ...newNoteState, [company.id]: 'Interested' });
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 transition-colors"
                      >
                        Interested
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setNewNoteState({ ...newNoteState, [company.id]: 'Not Interested' });
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-300 rounded-md hover:bg-red-100 transition-colors"
                      >
                        Not Interested
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newNote}
                        onChange={(e) => setNewNoteState({ ...newNoteState, [company.id]: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newNote.trim()) {
                            handleNotesUpdate(company.id, newNote);
                            setNewNoteState({ ...newNoteState, [company.id]: '' });
                          }
                        }}
                        placeholder="Add a note..."
                        className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                      />
                      <button
                        onClick={() => {
                          if (newNote.trim()) {
                            handleNotesUpdate(company.id, newNote);
                            setNewNoteState({ ...newNoteState, [company.id]: '' });
                          }
                        }}
                        className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm relative">
          {searchLoading && (
            <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center z-10">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-500"></div>
            </div>
          )}
          <div 
            ref={tableScrollContainerRef}
            className={`overflow-x-auto overflow-y-auto max-h-[calc(100vh-300px)] -mx-4 md:mx-0 ${isDragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`}
            onMouseDown={handleTableMouseDown}
            onMouseMove={handleTableMouseMove}
            onMouseUp={handleTableMouseUp}
            onMouseLeave={handleTableMouseLeave}
            style={{ userSelect: isDragging ? 'none' : 'auto' }}
          >
              <div className="inline-block min-w-full align-middle">
                <table className="min-w-full divide-y divide-gray-200" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <colgroup>
                    <col style={{ width: '48px' }} />
                    {orderedVisibleColumns.map((column) => {
                      const isPhoneColumn = column === 'phone';
                      const isEmailColumn = column === 'email';
                      const isTemplateColumn = column.startsWith('template_');
                      if (isPhoneColumn || isEmailColumn) {
                        return <col key={column} style={{ width: '192px', minWidth: '192px' }} />;
                      } else if (isTemplateColumn) {
                        return <col key={column} style={{ width: '400px', minWidth: '300px' }} />;
                      } else {
                        return <col key={column} style={{ width: '200px', minWidth: '150px' }} />;
                      }
                    })}
                    <col style={{ width: '140px' }} />
                  </colgroup>
                  <thead className="bg-gray-50 sticky top-0 z-20 shadow-sm">
                    <tr>
                      <th className="px-2 md:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                          <input
                            type="checkbox"
                            checked={selectedCompanyIds.size > 0 && selectedCompanyIds.size === companies.length}
                            onChange={(e) => handleSelectAll(e.target.checked)}
                            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            onClick={(e) => e.stopPropagation()}
                          />
                      </th>
                      {orderedVisibleColumns.map((column) => {
                        const isPhoneColumn = column === 'phone';
                        const isEmailColumn = column === 'email';
                        return (
                          <th 
                            key={column} 
                            className={`px-3 md:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50 ${(isPhoneColumn || isEmailColumn) ? 'min-w-[12rem]' : ''}`}
                          >
                            <span className="hidden sm:inline">{columnLabels[column] || column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</span>
                            <span className="sm:hidden">{columnLabels[column]?.split(' ')[0] || column.split('_')[0]}</span>
                          </th>
                        );
                      })}
                      <th className="px-3 md:px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                        Actions
                      </th>
                    </tr>
                  </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                {companies.map((company) => {
                  const isEditingThisCell = editingCell?.companyId === company.id && editingCell?.columnKey;
                  
                  // Get classification for row styling
                  const summaryData = getSummaryData(company);
                  const classification = summaryData.classification?.toUpperCase();
                  const getRowBgColor = () => {
                    if (classification === 'QUALIFIED') {
                      return 'bg-green-200 hover:bg-green-300';
                    } else if (classification === 'NOT_QUALIFIED') {
                      return 'bg-red-200 hover:bg-red-300';
                    } else if (classification === 'EXPIRED') {
                      return 'bg-amber-100 hover:bg-amber-200';
                    }
                    return 'hover:bg-gray-50';
                  };
                  
                  // Handle row click with Ctrl/Cmd to open drawer
                  const handleRowClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
                    // Only open drawer if Ctrl (Windows/Linux) or Cmd (Mac) is pressed
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault();
                      setCompanyToView(company);
                      setDrawerOpen(true);
                    }
                  };
                  
                  return (
                    <tr 
                      key={company.id} 
                      className={getRowBgColor()}
                      onClick={handleRowClick}
                    >
                      <td className="px-2 md:px-4 py-4 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={selectedCompanyIds.has(company.id)}
                          onChange={(e) => handleRowSelect(company.id, e.target.checked)}
                          className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      {orderedVisibleColumns.map((columnKey) => {
                        const isEditing = isEditingThisCell === columnKey;
                        const isTemplateColumn = columnKey.startsWith('template_');
                        const isLinkColumn = columnKey === 'domain' || columnKey === 'instagram';
                        const isPhoneColumn = columnKey === 'phone';
                        const isEmailColumn = columnKey === 'email';
                        const isNotesColumn = columnKey === 'notes';
                        
                        // Regular columns and template columns
                        const value = getCellValue(company, columnKey);
                        
                        // Get URL for domain and instagram columns
                        let linkUrl = null;
                        if (columnKey === 'domain' && company.domain && company.domain !== '-') {
                          const domain = company.domain.trim();
                          linkUrl = domain.startsWith('http://') || domain.startsWith('https://') 
                            ? domain 
                            : `https://${domain}`;
                        } else if (columnKey === 'instagram' && company.instagram && company.instagram !== '-') {
                          const instagram = company.instagram.trim().replace(/^@/, '');
                          linkUrl = `https://instagram.com/${instagram}`;
                        } else if (isPhoneColumn && company.phone && company.phone !== '-') {
                          // For phone column, we'll handle multiple phones in the rendering section
                          // Generate phone link based on behavior (for single phone or first phone)
                          const phone = company.phone.trim().split(',')[0].trim().replace(/[^\d+]/g, ''); // Get first phone, remove non-digit chars except +
                          if (phoneClickBehavior === 'call') {
                            linkUrl = `tel:${phone}`;
                          } else if (phoneClickBehavior === 'whatsapp') {
                            // WhatsApp web URL format: https://wa.me/{phone}?text={message}
                            let whatsappUrl = `https://wa.me/${phone}`;
                            // Add clipboard column value as pre-filled message if available
                            if (clipboardColumn) {
                              const clipboardValue = getCellValue(company, clipboardColumn);
                              if (clipboardValue && clipboardValue !== '-') {
                                const encodedMessage = encodeURIComponent(clipboardValue);
                                whatsappUrl += `?text=${encodedMessage}`;
                              }
                            }
                            linkUrl = whatsappUrl;
                          }
                        } else if (isEmailColumn && company.email && company.email !== '-') {
                          const email = company.email.trim().split(',')[0].trim();
                          let subject: string | undefined;
                          let body: string | undefined;
                          if (subjectColumn) {
                            const subjectValue = getCellValue(company, subjectColumn);
                            if (subjectValue && subjectValue !== '-') subject = subjectValue;
                          }
                          if (clipboardColumn) {
                            const clipboardValue = getCellValue(company, clipboardColumn);
                            if (clipboardValue && clipboardValue !== '-') {
                              body = buildEmailBody(clipboardValue, 'Hi, \n\n', emailSettings);
                            }
                          }
                          linkUrl = buildEmailComposeUrl(email, { subject, body, emailSettings });
                        }
                        
                        // Get classification color classes
                        const isClassificationColumn = columnKey === 'classification';
                        const classificationValue = isClassificationColumn ? value.toUpperCase() : '';
                        const getClassificationColorClasses = () => {
                          if (isClassificationColumn) {
                            if (classificationValue === 'QUALIFIED') {
                              return 'bg-green-50 text-green-700';
                            } else if (classificationValue === 'NOT_QUALIFIED') {
                              return 'bg-red-50 text-red-700';
                            } else if (classificationValue === 'EXPIRED') {
                              return 'bg-amber-50 text-amber-700';
                            }
                          }
                          return '';
                        };
                        
                        const isCellHovered = hoveredCell?.companyId === company.id && hoveredCell?.columnKey === columnKey;
                        
                        // Helper to check if content is truncated and handle hover
                        const handleCellMouseEnter = (e: React.MouseEvent<HTMLDivElement | HTMLAnchorElement>) => {
                          const element = e.currentTarget;
                          // Check if content is truncated
                          const isTruncated = element.scrollWidth > element.clientWidth;
                          if (isTruncated) {
                            setHoveredCell({ companyId: company.id, columnKey });
                          }
                        };
                        
                        const handleCellMouseLeave = () => {
                          setHoveredCell(null);
                        };
                        
                        return (
                          <td
                            key={columnKey}
                            className={`${(isLinkColumn || isPhoneColumn || isEmailColumn) && linkUrl ? 'p-0 relative' : 'px-3 md:px-6 py-4'} text-xs md:text-sm ${isClassificationColumn ? getClassificationColorClasses() : 'text-gray-900'} ${
                              isEditing ? '' : isTemplateColumn ? 'cursor-pointer hover:bg-blue-50' : (isLinkColumn || isPhoneColumn || isEmailColumn) && linkUrl ? 'cursor-pointer' : isClassificationColumn ? 'cursor-pointer hover:opacity-80' : 'cursor-pointer hover:bg-blue-50'
                            } transition-colors ${isTemplateColumn ? 'max-w-xl' : (isPhoneColumn || isEmailColumn) ? 'min-w-[12rem]' : 'max-w-md'}`}
                            onClick={!isEditing && !isLinkColumn && !isPhoneColumn && !isEmailColumn ? (e) => {
                              // If Ctrl/Cmd is pressed, let the row handler handle it (for opening drawer)
                              if (e.ctrlKey || e.metaKey) {
                                return; // Let event bubble to row handler
                              }
                              e.stopPropagation();
                              // Notes column opens drawer instead of copying
                              if (isNotesColumn) {
                                setCompanyToView(company);
                                setDrawerOpen(true);
                              } else {
                                handleCellClick(company, columnKey);
                              }
                            } : undefined}
                            onDoubleClick={!isEditing && !isTemplateColumn && !isLinkColumn && !isPhoneColumn && !isEmailColumn && !isNotesColumn ? (e) => {
                              e.stopPropagation();
                              handleCellDoubleClick(company, columnKey);
                            } : undefined}
                            title={!isEditing ? (isNotesColumn ? "Click to open notes management" : isTemplateColumn ? "Click to copy message" : (isLinkColumn || isPhoneColumn || isEmailColumn) && linkUrl ? (isPhoneColumn && phoneClickBehavior === 'whatsapp' ? "Single click to open WhatsApp and copy clipboard column, double click to edit" : isPhoneColumn ? "Single click to call, double click to edit" : isEmailColumn ? "Single click to open email (Gmail/Outlook) with pre-filled body, double click to edit" : "Click to open link and copy clipboard column") : "Single click to copy, double click to edit") : undefined}
                          >
                            {isEditing ? (
                              <div className="flex items-center gap-2">
                                {columnKey === 'company_summary' || columnKey === 'sales_opener_sentence' ? (
                                  <textarea
                                    ref={editInputRef as React.RefObject<HTMLTextAreaElement>}
                                    value={editingCell?.value || ''}
                                    onChange={(e) => setEditingCell({ ...editingCell!, value: e.target.value })}
                                    onBlur={handleInlineEditSave}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                        handleInlineEditSave();
                                      } else if (e.key === 'Escape') {
                                        setEditingCell(null);
                                      }
                                    }}
                                    className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                    rows={3}
                                  />
                                ) : (
                                  <input
                                    ref={editInputRef as React.RefObject<HTMLInputElement>}
                                    type="text"
                                    value={editingCell?.value || ''}
                                    onChange={(e) => setEditingCell({ ...editingCell!, value: e.target.value })}
                                    onBlur={handleInlineEditSave}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        handleInlineEditSave();
                                      } else if (e.key === 'Escape') {
                                        setEditingCell(null);
                                      }
                                    }}
                                    className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                  />
                                )}
                                <button
                                  onClick={handleInlineEditSave}
                                  className="text-green-600 hover:text-green-800"
                                  title="Save (Enter)"
                                >
                                  ✓
                                </button>
                                <button
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setEditingCell(null);
                                  }}
                                  className="text-red-600 hover:text-red-800"
                                  title="Cancel (Esc)"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (isPhoneColumn || isEmailColumn) && value && value !== '-' ? (
                              // Handle multiple phone numbers or emails
                              <div className="flex flex-col gap-1 py-2">
                                {(isPhoneColumn ? (company.phone || '').split(',') : (company.email || '').split(',')).map((item: string, index: number) => {
                                  const trimmedItem = item.trim();
                                  if (!trimmedItem) return null;
                                  
                                  if (isPhoneColumn) {
                                    const cleanedPhone = trimmedItem.replace(/[^\d+]/g, '');
                                    let phoneLinkUrl = null;
                                    if (phoneClickBehavior === 'call') {
                                      phoneLinkUrl = `tel:${cleanedPhone}`;
                                    } else if (phoneClickBehavior === 'whatsapp') {
                                      let whatsappUrl = `https://wa.me/${cleanedPhone}`;
                                      if (clipboardColumn) {
                                        const clipboardValue = getCellValue(company, clipboardColumn);
                                        if (clipboardValue && clipboardValue !== '-') {
                                          const encodedMessage = encodeURIComponent(clipboardValue);
                                          whatsappUrl += `?text=${encodedMessage}`;
                                        }
                                      }
                                      phoneLinkUrl = whatsappUrl;
                                    }
                                    
                                    return (
                                      <div key={index} className="flex items-center gap-2">
                                        <span className="text-xs md:text-sm text-gray-900 flex-1 truncate">{trimmedItem}</span>
                                        {phoneLinkUrl && (
                                          <button
                                            onClick={async (e) => {
                                              e.stopPropagation();
                                              if (phoneClickBehavior === 'call') {
                                                window.location.href = phoneLinkUrl;
                                              } else {
                                                if (phoneClickBehavior === 'whatsapp' && clipboardColumn) {
                                                  const clipboardValue = getCellValue(company, clipboardColumn);
                                                  if (clipboardValue && clipboardValue !== '-') {
                                                    try {
                                                      await copyToClipboard(clipboardValue);
                                                      setToastMessage(`${columnLabels[clipboardColumn]} copied to clipboard`);
                                                      setToastVisible(true);
                                                    } catch (error) {
                                                      console.error('Failed to copy to clipboard:', error);
                                                    }
                                                  }
                                                }
                                                window.open(phoneLinkUrl, '_blank', 'noopener,noreferrer');
                                              }
                                            }}
                                            onDoubleClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              handleCellDoubleClick(company, columnKey);
                                            }}
                                            className="p-1 rounded bg-green-100 text-green-700 hover:bg-green-200 transition-colors flex-shrink-0"
                                            title={phoneClickBehavior === 'call' ? 'Call' : 'WhatsApp'}
                                          >
                                            <Phone className="w-3 h-3 md:w-4 md:h-4" />
                                          </button>
                                        )}
                                      </div>
                                    );
                                  } else {
                                    // Email column (uses user email_settings for provider + signature)
                                    const trimmedEmail = trimmedItem;
                                    let subject: string | undefined;
                                    let body: string | undefined;
                                    
                                    // Always try to get subject if column is configured
                                    if (subjectColumn) {
                                      const subjectValue = getCellValue(company, subjectColumn);
                                      if (subjectValue && subjectValue !== '-') {
                                        subject = subjectValue;
                                      }
                                    }
                                    
                                    // Always try to get body with signature if clipboard column is configured
                                    if (clipboardColumn) {
                                      const clipboardValue = getCellValue(company, clipboardColumn);
                                      if (clipboardValue && clipboardValue !== '-') {
                                        // Build body with greeting, clipboard content, and signature
                                        body = buildEmailBody(clipboardValue, 'Hi, \n\n', emailSettings);
                                      }
                                    }
                                    
                                    // Build compose URL with subject and body (signature included in body if body exists)
                                    const emailLinkUrl = buildEmailComposeUrl(trimmedEmail, { subject, body, emailSettings });
                                    
                                    return (
                                      <div key={index} className="flex items-center gap-2">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            window.open(emailLinkUrl, '_blank', 'noopener,noreferrer');
                                          }}
                                          onDoubleClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            handleCellDoubleClick(company, columnKey);
                                          }}
                                          className="text-xs md:text-sm text-indigo-600 hover:text-indigo-800 hover:underline flex-1 text-left truncate"
                                          title={subject || body ? "Click to open email with subject and body" : "Click to open email"}
                                        >
                                          {trimmedEmail}
                                        </button>
                                      </div>
                                    );
                                  }
                                })}
                              </div>
                            ) : linkUrl ? (
                              <a
                                href={linkUrl}
                                target={isLinkColumn ? "_blank" : undefined}
                                rel={isLinkColumn ? "noopener noreferrer" : undefined}
                                onClick={async (e) => {
                                  // If Ctrl/Cmd is pressed, let the row handler handle it (for opening drawer)
                                  if (e.ctrlKey || e.metaKey) {
                                    e.preventDefault();
                                    return; // Let event bubble to row handler
                                  }
                                  e.stopPropagation();
                                  
                                  // For domain/instagram columns, copy clipboard column value if set
                                  if (clipboardColumn) {
                                    const clipboardValue = getCellValue(company, clipboardColumn);
                                    if (clipboardValue && clipboardValue !== '-') {
                                      try {
                                        await copyToClipboard(clipboardValue);
                                        setToastMessage(`${columnLabels[clipboardColumn]} copied to clipboard`);
                                        setToastVisible(true);
                                      } catch (error) {
                                        console.error('Failed to copy to clipboard:', error);
                                        setToastMessage('Failed to copy to clipboard');
                                        setToastVisible(true);
                                      }
                                    }
                                  }
                                }}
                                onMouseEnter={handleCellMouseEnter}
                                onMouseLeave={handleCellMouseLeave}
                                className={`absolute inset-0 flex items-center w-full h-full px-3 md:px-6 py-4 text-indigo-600 hover:text-indigo-800 hover:underline hover:bg-indigo-50 ${isCellHovered ? "whitespace-normal break-words" : "truncate"}`}
                                title={value}
                              >
                                {value}
                              </a>
                            ) : (
                              <div 
                                onMouseEnter={handleCellMouseEnter}
                                onMouseLeave={handleCellMouseLeave}
                                className={`${isCellHovered ? "whitespace-normal break-words" : "truncate"} ${isClassificationColumn && (classificationValue === 'QUALIFIED' || classificationValue === 'NOT_QUALIFIED' || classificationValue === 'EXPIRED') ? 'font-medium' : ''}`} 
                                title={value}
                              >
                                {value}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-3 md:px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end gap-1 md:gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setCompanyToView(company);
                              setDrawerOpen(true);
                            }}
                            className="inline-flex items-center px-2 md:px-3 py-1.5 border border-gray-300 text-xs md:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                            title="View Details"
                          >
                            <Eye className="w-3 h-3 md:w-4 md:h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditing(company);
                            }}
                            className="inline-flex items-center px-2 md:px-3 py-1.5 border border-gray-300 text-xs md:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                            title="Edit"
                          >
                            <Edit2 className="w-3 h-3 md:w-4 md:h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteClick(company.id);
                            }}
                            className="inline-flex items-center px-2 md:px-3 py-1.5 border border-transparent text-xs md:text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700"
                            title="Delete"
                          >
                            <Trash2 className="w-3 h-3 md:w-4 md:h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      
      {/* Pagination Controls - Show for both table and card views */}
      {totalPages > 1 && (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm mt-4">
          <div className="bg-white px-4 py-3 flex items-center justify-between border-t border-gray-200 sm:px-6">
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
                <div>
                  <p className="text-sm text-gray-700">
                    Showing <span className="font-medium">{(currentPage - 1) * pageSize + 1}</span> to{' '}
                    <span className="font-medium">{Math.min(currentPage * pageSize, totalCount)}</span> of{' '}
                    <span className="font-medium">{totalCount}</span> results
                  </p>
                </div>
                <div>
                  <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="sr-only">Previous</span>
                      <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                    </button>
                    
                    {/* Page Numbers */}
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      
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
                      <span className="sr-only">Next</span>
                      <ChevronRight className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </nav>
                </div>
              </div>
            </div>
          </div>
        )}

      {/* Toast Notification */}
      <Toast
        message={toastMessage}
        isVisible={toastVisible}
        onClose={() => setToastVisible(false)}
      />

      {/* WhatsApp Template Modal */}
      <WhatsAppTemplateModal
        isOpen={whatsappTemplateModalOpen}
        templateColumns={templateColumns}
        columnLabels={columnLabels}
        onSelectTemplate={handleTemplateSelect}
        onClose={() => {
          setWhatsappTemplateModalOpen(false);
          setSelectedCompanyForWhatsApp(null);
        }}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={deleteModalOpen}
        title="Delete Company"
        message="Are you sure you want to delete this company? This action cannot be undone."
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        confirmText="Delete"
        cancelText="Cancel"
      />

      {/* Merge Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={mergeModalOpen}
        title="Merge Companies"
        message={`Are you sure you want to merge ${selectedCompanyIds.size} selected companies? The newest company will be kept, and data from others will be merged into it. The other companies will be deleted. This action cannot be undone.`}
        onConfirm={handleMerge}
        onCancel={() => {
          setMergeModalOpen(false);
        }}
        confirmText="Merge"
        cancelText="Cancel"
      />

      {/* Bulk Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={bulkDeleteModalOpen}
        title="Delete Companies"
        message={`Are you sure you want to delete ${selectedCompanyIds.size} selected ${selectedCompanyIds.size === 1 ? 'company' : 'companies'}? This action cannot be undone.`}
        onConfirm={handleBulkDelete}
        onCancel={() => {
          setBulkDeleteModalOpen(false);
        }}
        confirmText="Delete"
        cancelText="Cancel"
      />

      {/* Delete Note Confirmation Modal (list view) */}
      {noteToDelete && (() => {
        const company = companies.find(c => c.id === noteToDelete.companyId);
        const notes = company?.notes && Array.isArray(company.notes) ? company.notes : [];
        const note = notes[noteToDelete.noteIndex];
        return (
          <>
            <div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity duration-300"
              onClick={handleDeleteNoteCancel}
            />
            <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
              <div
                className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 transform transition-all"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  Delete Note
                </h3>
                <div className="text-sm text-gray-600 mb-6">
                  <p className="mb-3">Are you sure you want to delete this note? This action cannot be undone.</p>
                  {note && (
                    <div className="p-3 bg-gray-50 rounded border border-gray-200">
                      <p className="text-xs text-gray-500 mb-1">
                        {note.date ? new Date(note.date).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        }) : null}
                      </p>
                      <p className="text-sm text-gray-900">
                        {note.message}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex gap-3 justify-end">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDeleteNoteCancel();
                    }}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDeleteNoteConfirm();
                    }}
                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </>
        );
      })()}

      {/* Assign Set Modal */}
      {assignSetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 md:p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">Assign Set</h2>
            <p className="text-gray-600 mb-4">
              Assign a set name to {selectedCompanyIds.size} selected {selectedCompanyIds.size === 1 ? 'company' : 'companies'}. Leave empty to clear the set name.
            </p>
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Set Name
              </label>
              <textarea
                value={assignSetName}
                onChange={(e) => setAssignSetName(e.target.value)}
                placeholder="Enter set name (leave empty to clear)"
                rows={3}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setAssignSetModalOpen(false);
                  setAssignSetName('');
                }}
                className="px-6 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Cancel
              </button>
              <button
                onClick={handleAssignSet}
                className="px-6 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Company Details Drawer */}
      <CompanyDetailsDrawer
        isOpen={drawerOpen}
        company={companyToView}
        onClose={() => {
          setDrawerOpen(false);
          setCompanyToView(null);
        }}
        getSummaryData={getSummaryData}
        columnLabels={columnLabels}
        getCellValue={getCellValue}
        columnOrder={columnOrder}
        updateCompany={updateCompany}
        companies={companies}
        onCompanyChange={(company) => {
          setCompanyToView(company);
        }}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={(page) => {
          const direction = page > currentPage ? 'next' : 'prev';
          setPendingPageDirection(direction);
          setCurrentPage(page);
          // When page changes, select the appropriate company of the new page
          // The companies will update after the page loads, and useEffect will handle selection
        }}
        emailSettings={emailSettings}
      />
    </div>
  );
}
