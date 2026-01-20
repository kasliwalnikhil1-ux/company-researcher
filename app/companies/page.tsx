'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useCompanies, Company } from '@/contexts/CompaniesContext';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import Toast from '@/components/ui/Toast';
import CompanyDetailsDrawer from '@/components/ui/CompanyDetailsDrawer';
import { generateMessageTemplates } from '@/lib/messageTemplates';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { Building2, Edit2, Trash2, Plus, X, Filter, GripVertical, ArrowUpDown, ChevronLeft, ChevronRight, Eye, GitMerge } from 'lucide-react';
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

// Sortable Column Item Component
interface SortableColumnItemProps {
  column: string;
  columnLabel: string;
  isVisible: boolean;
  onToggle: () => void;
}

function SortableColumnItem({ column, columnLabel, isVisible, onToggle }: SortableColumnItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center justify-between p-2 hover:bg-gray-50 rounded"
    >
      <div className="flex items-center gap-2 flex-1">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing touch-none"
          aria-label="Drag to reorder"
        >
          <GripVertical className="w-4 h-4 text-gray-400" />
        </button>
        <label className="flex items-center cursor-pointer flex-1">
          <input
            type="checkbox"
            checked={isVisible}
            onChange={onToggle}
            className="mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            onClick={(e) => e.stopPropagation()}
          />
          <span className="text-sm text-gray-700">{columnLabel}</span>
        </label>
      </div>
    </div>
  );
}

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
  const {
    companies,
    loading,
    searchLoading,
    createCompany,
    updateCompany,
    deleteCompany,
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
    searchQuery,
    setSearchQuery,
    availableSetNames,
    availableOwners
  } = useCompanies();
  
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
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [companyToDelete, setCompanyToDelete] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [companyToView, setCompanyToView] = useState<Company | null>(null);
  const [formData, setFormData] = useState<{
    domain: string;
    instagram: string;
    phone: string;
    email: string;
    summary: string;
    set_name: string;
  }>({
    domain: '',
    instagram: '',
    phone: '',
    email: '',
    summary: '',
    set_name: '',
  });
  
  // Sync companyToView with updated companies array when drawer is open
  useEffect(() => {
    if (companyToView && drawerOpen) {
      const updatedCompany = companies.find(c => c.id === companyToView.id);
      if (updatedCompany) {
        // Update companyToView with the latest data from companies array
        setCompanyToView(updatedCompany);
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
  
  // Track click timeouts for phone/email double-click detection
  const clickTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Track if double-click is in progress to prevent single-click action
  const doubleClickInProgressRef = useRef<Map<string, boolean>>(new Map());

  // Search debouncing refs
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Local search input state (updates immediately for responsive UI)
  const [localSearchInput, setLocalSearchInput] = useState(searchQuery);

  // Multi-select state
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [bulkDeleteModalOpen, setBulkDeleteModalOpen] = useState(false);
  const [assignSetModalOpen, setAssignSetModalOpen] = useState(false);
  const [assignSetName, setAssignSetName] = useState('');
  
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
  
  
  // Generate column labels including template-based labels
  const columnLabels = useMemo<Record<string, string>>(() => {
    const baseLabels: Record<string, string> = {
      domain: 'Domain',
      instagram: 'Instagram',
      phone: 'Phone',
      email: 'Email',
      set_name: 'Set Name',
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
  
  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Handle drag end
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setColumnOrder((items) => {
        const oldIndex = items.indexOf(active.id as string);
        const newIndex = items.indexOf(over.id as string);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }, []);
  
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

  const handleCreate = async () => {
    try {
      if (!formData.domain.trim()) {
        alert('Please enter a domain.');
        return;
      }

      let summaryValue = null;
      if (formData.summary.trim()) {
        try {
          summaryValue = JSON.parse(formData.summary.trim());
        } catch {
          summaryValue = { text: formData.summary.trim() };
        }
      }

      await createCompany({
        domain: formData.domain.trim(),
        instagram: formData.instagram.trim(),
        phone: extractPhoneNumber(formData.phone),
        email: formData.email.trim(),
        summary: summaryValue,
        set_name: formData.set_name.trim() || null,
        owner: null,
      });
      
      setIsCreating(false);
      setFormData({ domain: '', instagram: '', phone: '', email: '', summary: '', set_name: '' });
    } catch (error: any) {
      alert(`Error creating company: ${error.message}`);
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      if (!formData.domain.trim()) {
        alert('Please enter a domain.');
        return;
      }

      let summaryValue = null;
      if (formData.summary.trim()) {
        try {
          summaryValue = JSON.parse(formData.summary.trim());
        } catch {
          summaryValue = { text: formData.summary.trim() };
        }
      }

      await updateCompany(id, {
        domain: formData.domain.trim(),
        instagram: formData.instagram.trim(),
        phone: extractPhoneNumber(formData.phone),
        email: formData.email.trim(),
        summary: summaryValue,
        set_name: formData.set_name.trim() || null,
      });
      
      setEditingId(null);
      setFormData({ domain: '', instagram: '', phone: '', email: '', summary: '', set_name: '' });
    } catch (error: any) {
      alert(`Error updating company: ${error.message}`);
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
      // Delete all selected companies
      const deletePromises = Array.from(selectedCompanyIds).map(id => deleteCompany(id));
      await Promise.all(deletePromises);

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
    setEditingId(company.id);
    setFormData({
      domain: company.domain || '',
      instagram: company.instagram || '',
      phone: company.phone || '',
      email: company.email || '',
      summary: company.summary ? JSON.stringify(company.summary, null, 2) : '',
      set_name: company.set_name || '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setIsCreating(false);
    setFormData({ domain: '', instagram: '', phone: '', email: '', summary: '', set_name: '' });
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

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-full mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Building2 className="w-8 h-8" />
          Companies
        </h1>
        <div className="flex items-center gap-3">
          {selectedCompanyIds.size > 0 ? (
            <>
              <button
                onClick={() => setAssignSetModalOpen(true)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                Assign Set ({selectedCompanyIds.size})
              </button>
              <button
                onClick={() => setMergeModalOpen(true)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700"
              >
                <GitMerge className="w-4 h-4 mr-2" />
                Merge Selected ({selectedCompanyIds.size})
              </button>
              <button
                onClick={() => setBulkDeleteModalOpen(true)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Selected ({selectedCompanyIds.size})
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setColumnFilterOpen(!columnFilterOpen)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <Filter className="w-4 h-4 mr-2" />
                Manage Columns
              </button>
              {!isCreating && (
                <button
                  onClick={() => {
                    setIsCreating(true);
                    setFormData({ domain: '', instagram: '', phone: '', email: '', summary: '', set_name: '' });
                  }}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Company
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Column Management Dropdown */}
      {columnFilterOpen && (
        <div className="mb-4 bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-900">Manage Columns</h3>
            <button
              onClick={() => setColumnFilterOpen(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          
          {/* Clipboard Column Selection */}
          <div className="mb-4 pb-4 border-b border-gray-200">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Clipboard Column (copied when opening Domain/Instagram links)
            </label>
            <select
              value={clipboardColumn || ''}
              onChange={(e) => setClipboardColumn(e.target.value || null)}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="">None</option>
              {columnOrder.map((column) => (
                <option key={column} value={column}>
                  {columnLabels[column] || column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </option>
              ))}
            </select>
            {clipboardColumn && (
              <p className="mt-1 text-xs text-gray-500">
                Selected: {columnLabels[clipboardColumn] || clipboardColumn.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
              </p>
            )}
          </div>
          
          {/* Subject Column Selection */}
          <div className="mb-4 pb-4 border-b border-gray-200">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Subject Column (used as email subject when opening email links)
            </label>
            <select
              value={subjectColumn || ''}
              onChange={(e) => setSubjectColumn(e.target.value || null)}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="">None</option>
              {columnOrder.map((column) => (
                <option key={column} value={column}>
                  {columnLabels[column] || column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                </option>
              ))}
            </select>
            {subjectColumn && (
              <p className="mt-1 text-xs text-gray-500">
                Selected: {columnLabels[subjectColumn] || subjectColumn.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
              </p>
            )}
          </div>
          
          {/* Phone Click Behavior Selection */}
          <div className="mb-4 pb-4 border-b border-gray-200">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Phone Click Behavior
            </label>
            <select
              value={phoneClickBehavior}
              onChange={(e) => setPhoneClickBehavior(e.target.value as 'whatsapp' | 'call')}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="whatsapp">WhatsApp (opens WhatsApp and copies Clipboard Column)</option>
              <option value="call">Call (uses tel: link)</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Selected: {phoneClickBehavior === 'whatsapp' ? 'WhatsApp' : 'Call'}
            </p>
          </div>
          
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={columnOrder}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {columnOrder.map((column) => (
                  <SortableColumnItem
                    key={column}
                    column={column}
                    columnLabel={columnLabels[column] || column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    isVisible={visibleColumns.has(column)}
                    onToggle={() => toggleColumn(column)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      )}

      {/* Search and Sort */}
      <div className="mb-4 flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            placeholder="Search companies..."
            value={localSearchInput}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            className="block w-full px-4 py-2 pr-10 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
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
        <div className="flex items-center gap-2">
          <ArrowUpDown className="w-4 h-4 text-gray-500" />
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest')}
            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
          </select>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="w-4 h-4 text-gray-500" />
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value as 'all' | 'today' | 'yesterday' | 'last_week' | 'last_month' | 'custom')}
            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="all">All Dates</option>
            <option value="today">Created Today</option>
            <option value="yesterday">Created Yesterday</option>
            <option value="last_week">Created Last Week</option>
            <option value="last_month">Created Last Month</option>
            <option value="custom">Custom Range</option>
          </select>
          {dateFilter === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={formatDateForInput(customDateRange.start)}
                onChange={(e) => {
                  setCustomDateRange({ 
                    ...customDateRange, 
                    start: parseDateFromInput(e.target.value) 
                  });
                }}
                className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="Start date"
              />
              <span className="text-gray-500 text-sm">to</span>
              <input
                type="date"
                value={formatDateForInput(customDateRange.end)}
                onChange={(e) => {
                  setCustomDateRange({ 
                    ...customDateRange, 
                    end: parseDateFromInput(e.target.value) 
                  });
                }}
                className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="End date"
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={classificationFilter}
            onChange={(e) => setClassificationFilter(e.target.value as 'all' | 'QUALIFIED' | 'NOT_QUALIFIED' | 'EXPIRED' | 'empty')}
            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="all">All Classifications</option>
            <option value="QUALIFIED">QUALIFIED</option>
            <option value="NOT_QUALIFIED">NOT QUALIFIED</option>
            <option value="EXPIRED">EXPIRED</option>
            <option value="empty">Empty/Null Summary</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={setNameFilter || 'all'}
            onChange={(e) => setSetNameFilter(e.target.value === 'all' ? null : (e.target.value === '' ? '' : e.target.value))}
            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
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
        <div className="flex items-center gap-2">
          <select
            value={ownerFilter || 'all'}
            onChange={(e) => setOwnerFilter(e.target.value === 'all' ? null : (e.target.value === '' ? '' : e.target.value))}
            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
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
      </div>

      {/* Create/Edit Form */}
      {(isCreating || editingId) && (
        <div className="mb-8 bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            {isCreating ? 'Add New Company' : 'Edit Company'}
          </h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Domain <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.domain}
                onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Instagram
              </label>
              <input
                type="text"
                value={formData.instagram}
                onChange={(e) => setFormData({ ...formData, instagram: e.target.value })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="@company"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Phone
              </label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="+1234567890"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="contact@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Set Name
              </label>
              <select
                value={formData.set_name}
                onChange={(e) => setFormData({ ...formData, set_name: e.target.value })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">No Set (null/empty)</option>
                {availableSetNames.map((setName) => (
                  <option key={setName} value={setName}>
                    {setName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Summary (JSON)
              </label>
              <textarea
                value={formData.summary}
                onChange={(e) => setFormData({ ...formData, summary: e.target.value })}
                rows={6}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
                placeholder='{"key": "value"}'
              />
              <p className="mt-1 text-xs text-gray-500">
                Enter JSON data for the summary field, or plain text (will be converted to JSON)
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => isCreating ? handleCreate() : editingId && handleUpdate(editingId)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
              >
                {isCreating ? 'Create' : 'Update'}
              </button>
              <button
                onClick={cancelEdit}
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Companies Table */}
      {companies.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
          <Building2 className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-500 mb-4">
            {searchQuery ? 'No companies found matching your search.' : 'No companies found. Create your first company to get started.'}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden relative">
          {searchLoading && (
            <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center z-10">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-500"></div>
            </div>
          )}
          <div className="overflow-x-auto">
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
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
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
                        className={`px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${(isPhoneColumn || isEmailColumn) ? 'min-w-[12rem]' : ''}`}
                      >
                        {columnLabels[column] || column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </th>
                    );
                  })}
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
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
                      return 'bg-green-50/30 hover:bg-green-50/60';
                    } else if (classification === 'NOT_QUALIFIED') {
                      return 'bg-red-50/30 hover:bg-red-50/60';
                    } else if (classification === 'EXPIRED') {
                      return 'bg-amber-50/30 hover:bg-amber-50/60';
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
                      <td className="px-4 py-4 whitespace-nowrap">
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
                          // Generate phone link based on behavior
                          const phone = company.phone.trim().replace(/[^\d+]/g, ''); // Remove non-digit chars except +
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
                          // Generate Gmail compose URL with email pre-filled
                          const email = company.email.trim();
                          let gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`;
                          // Add subject column value as email subject if available
                          if (subjectColumn) {
                            const subjectValue = getCellValue(company, subjectColumn);
                            if (subjectValue && subjectValue !== '-') {
                              const encodedSubject = encodeURIComponent(subjectValue);
                              gmailUrl += `&su=${encodedSubject}`;
                            }
                          }
                          // Add clipboard column value as email body if available
                          if (clipboardColumn) {
                            const clipboardValue = getCellValue(company, clipboardColumn);
                            if (clipboardValue && clipboardValue !== '-') {
                              const emailBody = `Hi, \n\n${clipboardValue}\n\nAarushi Jain\nCEO, Kaptured AI`;
                              const encodedBody = encodeURIComponent(emailBody);
                              gmailUrl += `&body=${encodedBody}`;
                            }
                          }
                          linkUrl = gmailUrl;
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
                            className={`${(isLinkColumn || isPhoneColumn || isEmailColumn) && linkUrl ? 'p-0 relative' : 'px-6 py-4'} text-sm ${isClassificationColumn ? getClassificationColorClasses() : 'text-gray-900'} ${
                              isEditing ? '' : isTemplateColumn ? 'cursor-pointer hover:bg-blue-50' : (isLinkColumn || isPhoneColumn || isEmailColumn) && linkUrl ? 'cursor-pointer' : isClassificationColumn ? 'cursor-pointer hover:opacity-80' : 'cursor-pointer hover:bg-blue-50'
                            } transition-colors ${isTemplateColumn ? 'max-w-xl' : (isPhoneColumn || isEmailColumn) ? 'min-w-[12rem]' : 'max-w-md'}`}
                            onClick={!isEditing && !isLinkColumn && !isPhoneColumn && !isEmailColumn ? (e) => {
                              // If Ctrl/Cmd is pressed, let the row handler handle it (for opening drawer)
                              if (e.ctrlKey || e.metaKey) {
                                return; // Let event bubble to row handler
                              }
                              e.stopPropagation();
                              handleCellClick(company, columnKey);
                            } : undefined}
                            onDoubleClick={!isEditing && !isTemplateColumn && !isLinkColumn && !isPhoneColumn && !isEmailColumn ? (e) => {
                              e.stopPropagation();
                              handleCellDoubleClick(company, columnKey);
                            } : undefined}
                            title={!isEditing ? (isTemplateColumn ? "Click to copy message" : (isLinkColumn || isPhoneColumn || isEmailColumn) && linkUrl ? (isPhoneColumn && phoneClickBehavior === 'whatsapp' ? "Single click to open WhatsApp and copy clipboard column, double click to edit" : isPhoneColumn ? "Single click to call, double click to edit" : isEmailColumn ? "Single click to open Gmail with pre-filled email and body, double click to edit" : "Click to open link and copy clipboard column") : "Single click to copy, double click to edit") : undefined}
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
                            ) : linkUrl ? (
                              <a
                                href={linkUrl}
                                target={isPhoneColumn && phoneClickBehavior === 'call' ? undefined : "_blank"}
                                rel={isPhoneColumn && phoneClickBehavior === 'call' ? undefined : "noopener noreferrer"}
                                onClick={async (e) => {
                                  // For phone and email, prevent default to allow double-click to work
                                  if (isPhoneColumn || isEmailColumn) {
                                    e.preventDefault();
                                  }
                                  
                                  // If Ctrl/Cmd is pressed, let the row handler handle it (for opening drawer)
                                  if (e.ctrlKey || e.metaKey) {
                                    if (isPhoneColumn || isEmailColumn) {
                                      // Already prevented, just return
                                    } else {
                                      e.preventDefault();
                                    }
                                    return; // Let event bubble to row handler
                                  }
                                  e.stopPropagation();
                                  
                                  // Use a small delay for phone/email to detect double-click
                                  if (isPhoneColumn || isEmailColumn) {
                                    const timeoutKey = `${company.id}-${columnKey}`;
                                    
                                    // Clear any existing timeout for this cell
                                    const existingTimeout = clickTimeoutsRef.current.get(timeoutKey);
                                    if (existingTimeout) {
                                      clearTimeout(existingTimeout);
                                    }
                                    
                                    // Copy clipboard column immediately (must happen synchronously in user gesture)
                                    // For phone column with WhatsApp behavior, copy clipboard column
                                    if (isPhoneColumn && phoneClickBehavior === 'whatsapp' && clipboardColumn) {
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
                                    
                                    const clickDelay = setTimeout(() => {
                                      // Check if timeout was cleared (double-click occurred) or if double-click flag is set
                                      const timeoutStillExists = clickTimeoutsRef.current.has(timeoutKey);
                                      const isDoubleClick = doubleClickInProgressRef.current.get(timeoutKey);
                                      
                                      // Clean up
                                      clickTimeoutsRef.current.delete(timeoutKey);
                                      if (isDoubleClick) {
                                        doubleClickInProgressRef.current.delete(timeoutKey);
                                      }
                                      
                                      // Don't open link if double-click occurred (timeout was cleared or flag is set)
                                      if (!timeoutStillExists || isDoubleClick) {
                                        return;
                                      }
                                      
                                      if (isPhoneColumn && phoneClickBehavior === 'call') {
                                        window.location.href = linkUrl;
                                      } else {
                                        window.open(linkUrl, '_blank', 'noopener,noreferrer');
                                      }
                                    }, 300); // 300ms delay to detect double-click
                                    
                                    // Store timeout ID in ref for this cell
                                    clickTimeoutsRef.current.set(timeoutKey, clickDelay);
                                    return;
                                  }
                                  
                                  // For domain/instagram columns, copy clipboard column value if set
                                  if (!isPhoneColumn && clipboardColumn) {
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
                                onDoubleClick={(isPhoneColumn || isEmailColumn) ? (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  
                                  // Clear the click timeout if it exists
                                  const timeoutKey = `${company.id}-${columnKey}`;
                                  const existingTimeout = clickTimeoutsRef.current.get(timeoutKey);
                                  
                                  // Mark that double-click is in progress BEFORE clearing timeout
                                  // This ensures the flag is set even if timeout callback is already queued
                                  doubleClickInProgressRef.current.set(timeoutKey, true);
                                  
                                  if (existingTimeout) {
                                    clearTimeout(existingTimeout);
                                    clickTimeoutsRef.current.delete(timeoutKey);
                                  }
                                  
                                  handleCellDoubleClick(company, columnKey);
                                } : undefined}
                                onMouseEnter={handleCellMouseEnter}
                                onMouseLeave={handleCellMouseLeave}
                                className={`absolute inset-0 flex items-center w-full h-full px-6 py-4 text-indigo-600 hover:text-indigo-800 hover:underline hover:bg-indigo-50 ${isCellHovered ? "whitespace-normal break-words" : "truncate"}`}
                                title={(isPhoneColumn || isEmailColumn) ? "Single click to open link, double click to edit" : value}
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
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setCompanyToView(company);
                              setDrawerOpen(true);
                            }}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                            title="View Details"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditing(company);
                            }}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                            title="Edit"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteClick(company.id);
                            }}
                            className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          
          {/* Pagination Controls */}
          {totalPages > 1 && (
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
          )}
        </div>
      )}

      {/* Toast Notification */}
      <Toast
        message={toastMessage}
        isVisible={toastVisible}
        onClose={() => setToastVisible(false)}
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

      {/* Assign Set Modal */}
      {assignSetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
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
      />
    </div>
  );
}
