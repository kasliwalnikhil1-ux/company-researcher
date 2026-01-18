"use client";

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { Company } from '@/contexts/CompaniesContext';
import { extractPhoneNumber } from '@/lib/utils';

interface CompanyDetailsDrawerProps {
  isOpen: boolean;
  company: Company | null;
  onClose: () => void;
  getSummaryData: (company: Company) => any;
  columnLabels: Record<string, string>;
  getCellValue: (company: Company, columnKey: string) => string;
  columnOrder: string[];
  updateCompany: (id: string, updates: Partial<Company>) => Promise<void>;
}

const CompanyDetailsDrawer: React.FC<CompanyDetailsDrawerProps> = ({
  isOpen,
  company,
  onClose,
  getSummaryData,
  columnLabels,
  getCellValue,
  columnOrder,
  updateCompany,
}) => {
  // Inline editing state
  const [editingCell, setEditingCell] = useState<{ companyId: string; columnKey: string; value: string } | null>(null);
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const [classificationValue, setClassificationValue] = useState<string>('');

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
    
    // Classification uses a dropdown, not double-click editing
    if (columnKey === 'classification') {
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
    if (!editingCell || !company) return;
    
    const { companyId, columnKey, value } = editingCell;
    
    try {
      // Handle direct company fields (not in summary)
      if (columnKey === 'phone') {
        const cleanedPhone = extractPhoneNumber(value);
        await updateCompany(companyId, { [columnKey]: cleanedPhone });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }
      if (columnKey === 'email') {
        await updateCompany(companyId, { [columnKey]: value.trim() });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }
      if (columnKey === 'set_name') {
        await updateCompany(companyId, { [columnKey]: value.trim() || null });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
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
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error('Error updating field:', error);
      setToastMessage(`Error updating ${columnLabels[columnKey]}: ${error.message}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    }
  }, [editingCell, company, getSummaryData, updateCompany, columnLabels]);

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

  // Update classification value when company changes
  useEffect(() => {
    if (company) {
      const summaryData = getSummaryData(company);
      const currentClassification = summaryData.classification || '';
      // Map NOT_QUALIFIED to UNQUALIFIED for display
      const displayValue = currentClassification === 'NOT_QUALIFIED' ? 'UNQUALIFIED' : currentClassification;
      setClassificationValue(displayValue);
    }
  }, [company, company?.summary, getSummaryData]);

  // Handle classification dropdown change
  const handleClassificationChange = useCallback(async (newValue: string) => {
    if (!company || !newValue) return;
    
    // Optimistically update the UI
    setClassificationValue(newValue);
    
    try {
      const summaryData = getSummaryData(company);
      const updatedSummary = { ...summaryData };
      
      // Map UNQUALIFIED to NOT_QUALIFIED for database compatibility
      const dbValue = newValue === 'UNQUALIFIED' ? 'NOT_QUALIFIED' : newValue;
      
      // Validate and set classification
      if (['QUALIFIED', 'NOT_QUALIFIED', 'EXPIRED'].includes(dbValue.toUpperCase())) {
        updatedSummary.classification = dbValue.toUpperCase() as 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE' | 'EXPIRED';
      } else {
        // Invalid value, revert
        const currentClassification = summaryData.classification || '';
        const displayValue = currentClassification === 'NOT_QUALIFIED' ? 'UNQUALIFIED' : currentClassification;
        setClassificationValue(displayValue);
        return;
      }
      
      await updateCompany(company.id, { summary: updatedSummary });
      setToastMessage('Classification updated successfully');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error('Error updating classification:', error);
      setToastMessage(`Error updating classification: ${error.message}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
      // Revert to previous value on error
      const summaryData = getSummaryData(company);
      const currentClassification = summaryData.classification || '';
      const displayValue = currentClassification === 'NOT_QUALIFIED' ? 'UNQUALIFIED' : currentClassification;
      setClassificationValue(displayValue);
    }
  }, [company, getSummaryData, updateCompany]);

  // Early return AFTER all hooks have been called
  if (!isOpen || !company) return null;

  const summaryData = getSummaryData(company);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-white/30 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-4xl bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <h2 className="text-2xl font-semibold text-gray-900">Company Details</h2>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
              aria-label="Close drawer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            <div className="space-y-6">
              {/* Basic Information */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
                <div className="space-y-3">
                  {company.domain && (
                    <div className="border-l-4 border-indigo-500 pl-4">
                      <p className="text-sm font-medium text-gray-500">{columnLabels.domain || 'Domain'}</p>
                      <p className="text-sm text-gray-900">{company.domain}</p>
                    </div>
                  )}
                  {company.instagram && (
                    <div className="border-l-4 border-indigo-500 pl-4">
                      <p className="text-sm font-medium text-gray-500">{columnLabels.instagram || 'Instagram'}</p>
                      <p className="text-sm text-gray-900">{company.instagram}</p>
                    </div>
                  )}
                  {company.phone && (
                    <div className="border-l-4 border-indigo-500 pl-4">
                      <p className="text-sm font-medium text-gray-500">{columnLabels.phone || 'Phone'}</p>
                      {editingCell?.companyId === company.id && editingCell?.columnKey === 'phone' ? (
                        <div className="flex items-center gap-2">
                          <input
                            ref={editInputRef as React.RefObject<HTMLInputElement>}
                            type="text"
                            value={editingCell.value}
                            onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
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
                      ) : (
                        <p 
                          className="text-sm text-gray-900 cursor-pointer hover:bg-blue-50 p-1 rounded transition-colors"
                          onDoubleClick={() => handleCellDoubleClick(company, 'phone')}
                          title="Double click to edit"
                        >
                          {company.phone}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="border-l-4 border-indigo-500 pl-4">
                    <p className="text-sm font-medium text-gray-500">{columnLabels.email || 'Email'}</p>
                    {editingCell?.companyId === company.id && editingCell?.columnKey === 'email' ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={editInputRef as React.RefObject<HTMLInputElement>}
                          type="text"
                          value={editingCell.value}
                          onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
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
                    ) : (
                      <p 
                        className="text-sm text-gray-900 cursor-pointer hover:bg-blue-50 p-1 rounded transition-colors"
                        onDoubleClick={() => handleCellDoubleClick(company, 'email')}
                        title="Double click to edit"
                      >
                        {company.email || '-'}
                      </p>
                    )}
                  </div>
                  <div className="border-l-4 border-indigo-500 pl-4">
                    <p className="text-sm font-medium text-gray-500">{columnLabels.set_name || 'Set Name'}</p>
                    {editingCell?.companyId === company.id && editingCell?.columnKey === 'set_name' ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={editInputRef as React.RefObject<HTMLInputElement>}
                          type="text"
                          value={editingCell.value}
                          onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
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
                    ) : (
                      <p 
                        className="text-sm text-gray-900 cursor-pointer hover:bg-blue-50 p-1 rounded transition-colors"
                        onDoubleClick={() => handleCellDoubleClick(company, 'set_name')}
                        title="Double click to edit"
                      >
                        {company.set_name || '-'}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Summary Data */}
              {((summaryData && Object.keys(summaryData).length > 0) || columnOrder.includes('classification')) && (
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Summary Data</h3>
                  <div className="space-y-3">
                    {columnOrder
                      .filter(column => {
                        // Only show columns that are not domain/instagram/phone/email (already shown above)
                        if (column === 'domain' || column === 'instagram' || column === 'phone' || column === 'email') return false;
                        // Show all other columns from columnOrder
                        return true;
                      })
                      .map((columnKey) => {
                        const value = getCellValue(company, columnKey);
                        const isClassification = columnKey === 'classification';
                        
                        // Always show classification field (even if empty) so users can set it
                        // For other fields, hide if empty
                        if (!isClassification && (value === '-' || !value)) return null;

                        const label = columnLabels[columnKey] || columnKey;
                        const isLongText = value.length > 100;
                        const classificationValue = isClassification ? value.toUpperCase() : '';
                        
                        const getClassificationColorClasses = () => {
                          if (isClassification) {
                            if (classificationValue === 'QUALIFIED') {
                              return 'bg-green-50 text-green-700 border-green-200';
                            } else if (classificationValue === 'NOT_QUALIFIED') {
                              return 'bg-red-50 text-red-700 border-red-200';
                            } else if (classificationValue === 'EXPIRED') {
                              return 'bg-amber-50 text-amber-700 border-amber-200';
                            }
                          }
                          return 'bg-gray-50 border-gray-200';
                        };

                        const isEditing = editingCell?.companyId === company.id && editingCell?.columnKey === columnKey;
                        const isEditable = !columnKey.startsWith('template_') && columnKey !== 'domain' && columnKey !== 'instagram';
                        const isTextareaField = columnKey === 'company_summary' || columnKey === 'sales_opener_sentence';

                        // Special handling for classification field - use dropdown
                        if (isClassification) {
                          return (
                            <div
                              key={columnKey}
                              className={`border-l-4 pl-4 py-2 rounded-r ${getClassificationColorClasses()}`}
                            >
                              <p className="text-sm font-medium text-gray-700 mb-1">{label}</p>
                              <select
                                value={classificationValue}
                                onChange={(e) => handleClassificationChange(e.target.value)}
                                className={`w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                                  classificationValue === 'QUALIFIED'
                                    ? 'bg-green-50 text-green-700 border-green-300'
                                    : classificationValue === 'UNQUALIFIED' || classificationValue === 'NOT_QUALIFIED'
                                    ? 'bg-red-50 text-red-700 border-red-300'
                                    : classificationValue === 'EXPIRED'
                                    ? 'bg-amber-50 text-amber-700 border-amber-300'
                                    : 'bg-gray-50 border-gray-300'
                                } font-semibold`}
                              >
                                <option value="">Select classification...</option>
                                <option value="QUALIFIED">QUALIFIED</option>
                                <option value="UNQUALIFIED">UNQUALIFIED</option>
                                <option value="EXPIRED">EXPIRED</option>
                              </select>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={columnKey}
                            className={`border-l-4 pl-4 py-2 rounded-r ${getClassificationColorClasses()}`}
                          >
                            <p className="text-sm font-medium text-gray-700 mb-1">{label}</p>
                            {isEditing ? (
                              <div className="flex items-start gap-2">
                                {isTextareaField ? (
                                  <textarea
                                    ref={editInputRef as React.RefObject<HTMLTextAreaElement>}
                                    value={editingCell.value}
                                    onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
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
                                    value={editingCell.value}
                                    onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
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
                                <div className="flex flex-col gap-1">
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
                              </div>
                            ) : (
                              <p
                                className={`text-sm ${
                                  isClassification
                                    ? classificationValue === 'QUALIFIED' || 
                                      classificationValue === 'NOT_QUALIFIED' || 
                                      classificationValue === 'EXPIRED'
                                      ? 'font-semibold'
                                      : ''
                                    : 'text-gray-900'
                                } ${isLongText ? 'whitespace-pre-wrap break-words' : ''} ${
                                  isEditable ? 'cursor-pointer hover:bg-blue-50 p-1 rounded transition-colors' : ''
                                }`}
                                onDoubleClick={isEditable ? () => handleCellDoubleClick(company, columnKey) : undefined}
                                title={isEditable ? 'Double click to edit' : undefined}
                              >
                                {value}
                              </p>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Metadata</h3>
                <div className="space-y-3">
                  <div className="border-l-4 border-indigo-500 pl-4">
                    <p className="text-sm font-medium text-gray-500">ID</p>
                    <p className="text-sm text-gray-900 font-mono">{company.id}</p>
                  </div>
                  {company.created_at && (
                    <div className="border-l-4 border-indigo-500 pl-4">
                      <p className="text-sm font-medium text-gray-500">Created At</p>
                      <p className="text-sm text-gray-900">{new Date(company.created_at).toLocaleString()}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="p-6 border-t border-gray-200">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      {toastVisible && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-md shadow-lg z-50 transition-opacity duration-300">
          {toastMessage}
        </div>
      )}
    </>
  );
};

export default CompanyDetailsDrawer;
