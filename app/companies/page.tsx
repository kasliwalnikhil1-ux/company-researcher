'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useCompanies, Company } from '@/contexts/CompaniesContext';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import Toast from '@/components/ui/Toast';
import { generateMessageTemplates } from '@/lib/messageTemplates';
import { useMessageTemplates } from '@/contexts/MessageTemplatesContext';
import { Building2, Edit2, Trash2, Plus, X, Filter, GripVertical, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
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
    createCompany, 
    updateCompany, 
    deleteCompany, 
    sortOrder, 
    setSortOrder,
    currentPage,
    setCurrentPage,
    totalCount,
    totalPages,
    pageSize,
    dateFilter,
    setDateFilter,
    classificationFilter,
    setClassificationFilter
  } = useCompanies();
  const { templates } = useMessageTemplates();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [companyToDelete, setCompanyToDelete] = useState<string | null>(null);
  const [formData, setFormData] = useState<{
    domain: string;
    instagram: string;
    summary: string;
  }>({
    domain: '',
    instagram: '',
    summary: '',
  });
  
  // Toast state
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  
  // Inline editing state
  const [editingCell, setEditingCell] = useState<{ companyId: string; columnKey: string; value: string } | null>(null);
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  
  // Row hover state
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  
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
      const saved = localStorage.getItem(COLUMN_ORDER_KEY);
      let order: string[] = initialDefault;
      
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          // Merge with current template columns to handle new templates
          const savedBase = parsed.filter((col: string) => !col.startsWith('template_'));
          const currentTemplates = initialTemplateColumns;
          const merged = [...savedBase, ...currentTemplates.filter(t => parsed.includes(t))];
          // Add any new template columns that weren't in saved
          const newTemplates = currentTemplates.filter(t => !parsed.includes(t));
          order = [...merged, ...newTemplates];
        } catch {
          order = initialDefault;
        }
      }
      
      // Check for clipboard column and move it to first position
      const savedClipboardColumn = localStorage.getItem(CLIPBOARD_COLUMN_KEY);
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
          return new Set(JSON.parse(saved));
        } catch {
          return new Set(initialDefault);
        }
      }
    }
    return new Set(initialDefault);
  });
  
  const [columnFilterOpen, setColumnFilterOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Clipboard column state
  const [clipboardColumn, setClipboardColumn] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(CLIPBOARD_COLUMN_KEY);
      return saved || null;
    }
    return null;
  });
  
  // Reset to page 1 when search query changes
  useEffect(() => {
    if (searchQuery && currentPage !== 1) {
      setCurrentPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);
  
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
      await navigator.clipboard.writeText(value);
      setToastMessage(`${columnLabels[columnKey]} copied to clipboard`);
      setToastVisible(true);
    }
  }, [getCellValue, columnLabels]);
  
  // Handle cell double click (edit)
  const handleCellDoubleClick = useCallback((company: Company, columnKey: string) => {
    // Template columns are read-only
    if (columnKey.startsWith('template_')) {
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
        summary: summaryValue,
      });
      
      setIsCreating(false);
      setFormData({ domain: '', instagram: '', summary: '' });
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
        summary: summaryValue,
      });
      
      setEditingId(null);
      setFormData({ domain: '', instagram: '', summary: '' });
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

  const startEditing = (company: Company) => {
    setEditingId(company.id);
    setFormData({
      domain: company.domain || '',
      instagram: company.instagram || '',
      summary: company.summary ? JSON.stringify(company.summary, null, 2) : '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setIsCreating(false);
    setFormData({ domain: '', instagram: '', summary: '' });
  };

  // Filter companies based on search query
  const filteredCompanies = useMemo(() => {
    if (!searchQuery.trim()) return companies;
    
    const query = searchQuery.toLowerCase();
    return companies.filter(company => {
      const summaryData = getSummaryData(company);
      return (
        company.domain?.toLowerCase().includes(query) ||
        company.instagram?.toLowerCase().includes(query) ||
        JSON.stringify(company.summary)?.toLowerCase().includes(query) ||
        summaryData.company_summary?.toLowerCase().includes(query) ||
        summaryData.company_industry?.toLowerCase().includes(query) ||
        summaryData.sales_opener_sentence?.toLowerCase().includes(query)
      );
    });
  }, [companies, searchQuery, getSummaryData]);

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
                setFormData({ domain: '', instagram: '', summary: '' });
              }}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Company
            </button>
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
                  {columnLabels[column]}
                </option>
              ))}
            </select>
            {clipboardColumn && (
              <p className="mt-1 text-xs text-gray-500">
                Selected: {columnLabels[clipboardColumn]}
              </p>
            )}
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
                    columnLabel={columnLabels[column]}
                    isVisible={visibleColumns.has(column)}
                    onToggle={() => toggleColumn(column)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      )}

      {/* Search, Filters, and Sort */}
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <input
          type="text"
          placeholder="Search companies..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="block w-full max-w-md px-4 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
        />
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-500" />
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value as 'all' | 'today' | 'yesterday' | 'last_week' | 'last_month')}
            className="px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="all">All Dates</option>
            <option value="today">Created Today</option>
            <option value="yesterday">Created Yesterday</option>
            <option value="last_week">Created Last Week</option>
            <option value="last_month">Created Last Month</option>
          </select>
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
      {filteredCompanies.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
          <Building2 className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-500 mb-4">
            {searchQuery ? 'No companies found matching your search.' : 'No companies found. Create your first company to get started.'}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {orderedVisibleColumns.map((column) => (
                    <th key={column} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {columnLabels[column]}
                    </th>
                  ))}
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredCompanies.map((company) => {
                  const isEditingThisCell = editingCell?.companyId === company.id && editingCell?.columnKey;
                  
                  const isRowHovered = hoveredRowId === company.id;
                  
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
                  
                  return (
                    <tr 
                      key={company.id} 
                      className={getRowBgColor()}
                      onMouseEnter={() => setHoveredRowId(company.id)}
                      onMouseLeave={() => setHoveredRowId(null)}
                    >
                      {orderedVisibleColumns.map((columnKey) => {
                        const isEditing = isEditingThisCell === columnKey;
                        const isTemplateColumn = columnKey.startsWith('template_');
                        const isLinkColumn = columnKey === 'domain' || columnKey === 'instagram';
                        
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
                        
                        return (
                          <td
                            key={columnKey}
                            className={`${isLinkColumn && linkUrl ? 'p-0 relative' : 'px-6 py-4'} text-sm ${isClassificationColumn ? getClassificationColorClasses() : 'text-gray-900'} ${
                              isEditing ? '' : isTemplateColumn ? 'cursor-pointer hover:bg-blue-50' : isLinkColumn && linkUrl ? 'cursor-pointer' : isClassificationColumn ? 'cursor-pointer hover:opacity-80' : 'cursor-pointer hover:bg-blue-50'
                            } transition-colors ${isTemplateColumn ? 'max-w-xl' : 'max-w-md'}`}
                            onClick={!isEditing && !isLinkColumn ? () => handleCellClick(company, columnKey) : undefined}
                            onDoubleClick={!isEditing && !isTemplateColumn && !isLinkColumn ? () => handleCellDoubleClick(company, columnKey) : undefined}
                            title={!isEditing ? (isTemplateColumn ? "Click to copy message" : isLinkColumn && linkUrl ? "Click to open link and copy clipboard column" : "Single click to copy, double click to edit") : undefined}
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
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  // Copy clipboard column value if set
                                  if (clipboardColumn) {
                                    const clipboardValue = getCellValue(company, clipboardColumn);
                                    if (clipboardValue && clipboardValue !== '-') {
                                      try {
                                        await navigator.clipboard.writeText(clipboardValue);
                                        setToastMessage(`${columnLabels[clipboardColumn]} copied to clipboard`);
                                        setToastVisible(true);
                                      } catch (error) {
                                        console.error('Failed to copy to clipboard:', error);
                                      }
                                    }
                                  }
                                }}
                                className={`absolute inset-0 flex items-center w-full h-full px-6 py-4 text-indigo-600 hover:text-indigo-800 hover:underline hover:bg-indigo-50 ${isRowHovered ? "whitespace-normal break-words" : "truncate"}`}
                                title={value}
                              >
                                {value}
                              </a>
                            ) : (
                              <div className={`${isRowHovered ? "whitespace-normal break-words" : "truncate"} ${isClassificationColumn && (classificationValue === 'QUALIFIED' || classificationValue === 'NOT_QUALIFIED' || classificationValue === 'EXPIRED') ? 'font-medium' : ''}`} title={value}>
                                {value}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => startEditing(company)}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                            title="Edit"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteClick(company.id)}
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
    </div>
  );
}
