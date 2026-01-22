"use client";

import React, { useState, useMemo } from 'react';

interface CsvRow {
  [key: string]: string;
}

interface ColumnSelectorDialogProps {
  isOpen: boolean;
  columns: string[];
  rows?: CsvRow[];
  selectedColumn: string | null;
  selectedColumns?: { domain: string | null; instagram: string | null };
  onSelectColumn: (column: string) => void;
  onSelectColumns?: (columns: { domain: string | null; instagram: string | null }) => void;
  onConfirm: () => void;
  onClose: () => void;
  mode?: 'domain' | 'instagram';
  allowBoth?: boolean;
}

const ColumnSelectorDialog: React.FC<ColumnSelectorDialogProps> = ({
  isOpen,
  columns,
  rows = [],
  selectedColumn,
  selectedColumns,
  onSelectColumn,
  onSelectColumns,
  onConfirm,
  onClose,
  mode = 'domain',
  allowBoth = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [localSelectedColumns, setLocalSelectedColumns] = useState<{ domain: string | null; instagram: string | null }>(
    selectedColumns || { domain: null, instagram: null }
  );

  // Excluded domains (social media and platforms)
  const excludedDomains = [
    'linkedin.com',
    'linkedin',
    'twitter.com',
    'twitter',
    'x.com',
    'facebook.com',
    'facebook',
    'instagram.com',
    'instagram',
    'wikipedia.org',
    'wikipedia',
    'apollo.io',
    'apollo',
    'amazonaws.com',
    'amazonaws',
  ];

  // Check if a URL is from an excluded domain
  const isExcludedDomain = (url: string): boolean => {
    if (!url || typeof url !== 'string') return false;
    const urlLower = url.toLowerCase().trim();
    if (!urlLower.includes('.')) return false;
    
    // Extract domain from URL
    try {
      let domain = urlLower;
      // Remove protocol
      domain = domain.replace(/^https?:\/\//, '');
      // Remove www
      domain = domain.replace(/^www\./, '');
      // Remove path and query params
      domain = domain.split('/')[0].split('?')[0];
      
      // Check if domain matches any excluded domain
      return excludedDomains.some(excluded => 
        domain === excluded || domain.endsWith('.' + excluded)
      );
    } catch {
      return false;
    }
  };

  // Check if URL contains instagram.com
  const isInstagramUrl = (url: string): boolean => {
    if (!url || typeof url !== 'string') return false;
    const urlLower = url.toLowerCase().trim();
    return urlLower.includes('instagram.com');
  };

  // Get valid URLs from a column (first 5 rows) - for display purposes
  const getValidUrls = (columnName: string, forInstagramColumn: boolean = false): string[] => {
    if (!rows || rows.length === 0) return [];
    
    // Check first 5 rows (or all rows if less than 5)
    const rowsToCheck = rows.slice(0, 5);
    const validUrls: string[] = [];
    
    for (const row of rowsToCheck) {
      const value = row[columnName]?.trim() || '';
      if (!value) continue;
      
      if (allowBoth && forInstagramColumn) {
        // When displaying Instagram column, show all URLs (including Instagram)
        if (value.includes('.') || isInstagramUrl(value)) {
          validUrls.push(value);
        }
      } else if (allowBoth) {
        // When displaying domain column, show non-Instagram URLs
        if (value.includes('.') && !isInstagramUrl(value) && !isExcludedDomain(value)) {
          validUrls.push(value);
        }
      } else if (mode === 'instagram') {
        // In Instagram mode, only include Instagram URLs
        if (isInstagramUrl(value)) {
          validUrls.push(value);
        }
      } else {
        // In domain mode, exclude social media domains
        // Check if it looks like a URL (contains a dot)
        if (value.includes('.')) {
          // Check if it's NOT an excluded domain
          if (!isExcludedDomain(value)) {
            validUrls.push(value);
          }
        }
      }
    }
    
    return validUrls;
  };

  // Check if a column contains valid URLs
  const hasValidUrls = (columnName: string): boolean => {
    return getValidUrls(columnName).length > 0;
  };

  // Filter columns: exclude those with no URLs or only social media URLs
  const validColumns = useMemo(() => {
    return columns.filter(column => hasValidUrls(column));
  }, [columns, rows]);

  // Filter columns based on search query
  const filteredColumns = useMemo(() => {
    const columnsToFilter = validColumns;
    if (!searchQuery.trim()) {
      return columnsToFilter;
    }
    const query = searchQuery.toLowerCase().trim();
    return columnsToFilter.filter(column => 
      column.toLowerCase().includes(query)
    );
  }, [validColumns, searchQuery]);

  // Reset search when dialog closes
  React.useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setLocalSelectedColumns(selectedColumns || { domain: null, instagram: null });
    }
  }, [isOpen, selectedColumns]);

  // Update local state when selectedColumns prop changes
  React.useEffect(() => {
    if (selectedColumns) {
      setLocalSelectedColumns(selectedColumns);
    }
  }, [selectedColumns]);

  // Separate columns into domain and Instagram columns
  const domainColumns = useMemo(() => {
    if (!allowBoth) return [];
    return columns.filter(column => {
      // Check all rows (not just first 5) to be more thorough
      const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
      let hasNonInstagramUrl = false;
      
      for (const row of rowsToCheck) {
        const value = row[column]?.trim() || '';
        if (!value) continue;
        
        // Check if it's a URL (contains a dot)
        if (value.includes('.')) {
          // If it's not an Instagram URL, it's a domain URL
          if (!isInstagramUrl(value)) {
            // Also check it's not an excluded domain
            if (!isExcludedDomain(value)) {
              hasNonInstagramUrl = true;
              break;
            }
          }
        }
      }
      
      return hasNonInstagramUrl;
    });
  }, [columns, rows, allowBoth]);

  const instagramColumns = useMemo(() => {
    if (!allowBoth) return [];
    return columns.filter(column => {
      // Check all rows (not just first 5) to be more thorough
      const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
      let hasInstagramUrl = false;
      
      for (const row of rowsToCheck) {
        const value = row[column]?.trim() || '';
        if (!value) continue;
        
        // Check if it's an Instagram URL
        if (isInstagramUrl(value)) {
          hasInstagramUrl = true;
          break;
        }
      }
      
      return hasInstagramUrl;
    });
  }, [columns, rows, allowBoth]);

  const handleColumnToggle = (column: string, type: 'domain' | 'instagram') => {
    const newSelected = { ...localSelectedColumns };
    if (newSelected[type] === column) {
      newSelected[type] = null;
    } else {
      newSelected[type] = column;
    }
    setLocalSelectedColumns(newSelected);
    if (onSelectColumns) {
      onSelectColumns(newSelected);
    }
  };

  if (!isOpen) return null;

  const canConfirm = allowBoth 
    ? (localSelectedColumns.domain !== null || localSelectedColumns.instagram !== null)
    : selectedColumn !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-semibold mb-4">
          {allowBoth ? 'Select Columns' : (mode === 'instagram' ? 'Select Instagram Column' : 'Select URL Column')}
        </h2>
        <p className="text-gray-600 mb-4">
          {allowBoth
            ? 'Select the domain column and/or Instagram column. You can select both to combine data from both columns.'
            : (mode === 'instagram' 
              ? 'Please select the column that contains Instagram URLs. Only columns with Instagram URLs (instagram.com) are shown.'
              : 'Please select the column that contains company website URLs. Columns with no URLs or social media links (LinkedIn, Twitter, Facebook, etc.) are excluded.')}
        </p>
        
        {/* Search Input */}
        <div className="mb-4">
          <input
            type="text"
            placeholder="Search columns..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-sm ring-2 ring-brand-default focus:outline-none focus:ring-brand-default"
            autoFocus
          />
        </div>
        
        {allowBoth ? (
          <div className="space-y-6 mb-6">
            {/* Domain Column Selection */}
            <div>
              <h3 className="text-lg font-medium mb-3">Domain Column (Optional)</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {domainColumns.length > 0 ? (
                  domainColumns
                    .filter(column => !searchQuery.trim() || column.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((column) => {
                      const validUrls = getValidUrls(column, false);
                      const isSelected = localSelectedColumns.domain === column;
                      return (
                        <button
                          key={column}
                          onClick={() => handleColumnToggle(column, 'domain')}
                          className={`w-full text-left px-4 py-3 rounded-sm border-2 transition-colors ${
                            isSelected
                              ? 'border-brand-default bg-brand-default bg-opacity-10 text-brand-default'
                              : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleColumnToggle(column, 'domain')}
                              className="w-4 h-4"
                            />
                            <div className="font-medium text-sm">{column}</div>
                          </div>
                          {validUrls.length > 0 && (
                            <div className="mt-2 space-y-1 ml-6">
                              <div className="text-xs text-gray-500 font-medium">
                                Valid URLs found ({validUrls.length}):
                              </div>
                              <div className="space-y-0.5">
                                {validUrls.slice(0, 3).map((url, index) => (
                                  <div
                                    key={index}
                                    className="text-xs text-gray-600 truncate pl-2"
                                    title={url}
                                  >
                                    • {url}
                                  </div>
                                ))}
                                {validUrls.length > 3 && (
                                  <div className="text-xs text-gray-500 pl-2">
                                    ... and {validUrls.length - 3} more
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </button>
                      );
                    })
                ) : (
                  <div className="text-center py-4 text-gray-500 text-sm">
                    No domain columns found
                  </div>
                )}
              </div>
            </div>

            {/* Instagram Column Selection */}
            <div>
              <h3 className="text-lg font-medium mb-3">Instagram Column (Optional)</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {instagramColumns.length > 0 ? (
                  instagramColumns
                    .filter(column => !searchQuery.trim() || column.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((column) => {
                      const validUrls = getValidUrls(column, true);
                      const isSelected = localSelectedColumns.instagram === column;
                      return (
                        <button
                          key={column}
                          onClick={() => handleColumnToggle(column, 'instagram')}
                          className={`w-full text-left px-4 py-3 rounded-sm border-2 transition-colors ${
                            isSelected
                              ? 'border-brand-default bg-brand-default bg-opacity-10 text-brand-default'
                              : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleColumnToggle(column, 'instagram')}
                              className="w-4 h-4"
                            />
                            <div className="font-medium text-sm">{column}</div>
                          </div>
                          {validUrls.length > 0 && (
                            <div className="mt-2 space-y-1 ml-6">
                              <div className="text-xs text-gray-500 font-medium">
                                Valid URLs found ({validUrls.length}):
                              </div>
                              <div className="space-y-0.5">
                                {validUrls.slice(0, 3).map((url, index) => (
                                  <div
                                    key={index}
                                    className="text-xs text-gray-600 truncate pl-2"
                                    title={url}
                                  >
                                    • {url}
                                  </div>
                                ))}
                                {validUrls.length > 3 && (
                                  <div className="text-xs text-gray-500 pl-2">
                                    ... and {validUrls.length - 3} more
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </button>
                      );
                    })
                ) : (
                  <div className="text-center py-4 text-gray-500 text-sm">
                    No Instagram columns found
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto mb-6">
            {filteredColumns.length > 0 ? (
              filteredColumns.map((column) => {
                const validUrls = getValidUrls(column);
                return (
                  <button
                    key={column}
                    onClick={() => onSelectColumn(column)}
                    className={`w-full text-left px-4 py-3 rounded-sm border-2 transition-colors ${
                      selectedColumn === column
                        ? 'border-brand-default bg-brand-default bg-opacity-10 text-brand-default'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className="font-medium text-sm mb-1">{column}</div>
                    {validUrls.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <div className="text-xs text-gray-500 font-medium">
                          Valid URLs found ({validUrls.length}):
                        </div>
                        <div className="space-y-0.5">
                          {validUrls.map((url, index) => (
                            <div
                              key={index}
                              className="text-xs text-gray-600 truncate pl-2"
                              title={url}
                            >
                              • {url}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </button>
                );
              })
            ) : (
              <div className="text-center py-8 text-gray-500">
                <p>No columns found matching "{searchQuery}"</p>
              </div>
            )}
          </div>
        )}
        
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 rounded-sm transition-colors ${
              canConfirm
                ? 'bg-brand-default text-white hover:bg-opacity-90'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default ColumnSelectorDialog;
