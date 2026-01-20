"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import { parseCsv, CsvRow, csvToString } from "../lib/csvImport";
import { downloadCsv } from "../lib/csvExport";
import ColumnSelectorDialog from "./ui/ColumnSelectorDialog";
import Toast from "./ui/Toast";
import { useCompanies } from "@/contexts/CompaniesContext";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/utils/supabase/client";
import { Loader2 } from "lucide-react";
import type { Company } from "@/contexts/CompaniesContext";

// Utility function to extract domain from email or URL
const extractDomainFromValue = (value: string): string | null => {
  if (!value || typeof value !== 'string') return null;
  
  const trimmed = value.trim();
  if (!trimmed) return null;

  // If it's an email, extract domain after @
  if (trimmed.includes('@')) {
    const emailParts = trimmed.split('@');
    if (emailParts.length === 2) {
      return emailParts[1].toLowerCase();
    }
  }

  // If it's a URL, extract domain
  try {
    let domain = trimmed.toLowerCase();
    // Remove protocol
    domain = domain.replace(/^https?:\/\//, '');
    // Remove www
    domain = domain.replace(/^www\./, '');
    // Remove path and query params
    domain = domain.split('/')[0].split('?')[0].split(':')[0];
    
    // Remove trailing dot if present
    domain = domain.replace(/\.$/, '');
    
    return domain || null;
  } catch (e) {
    console.error('Error extracting domain:', e);
    return null;
  }
};

export default function CsvEnrich() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [allCompanies, setAllCompanies] = useState<Company[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [csvData, setCsvData] = useState<{ headers: string[]; rows: CsvRow[] } | null>(null);
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  const [selectedSourceColumn, setSelectedSourceColumn] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch all companies for matching (not paginated)
  const fetchAllCompanies = async (): Promise<Company[]> => {
    if (!userId) {
      setAllCompanies([]);
      return [];
    }

    setCompaniesLoading(true);
    try {
      const { data, error } = await supabase
        .from('companies')
        .select('*')
        .eq('user_id', userId);

      if (error) {
        console.error('Error fetching all companies:', error);
        setAllCompanies([]);
        return [];
      }

      const companies = data || [];
      setAllCompanies(companies);
      return companies;
    } catch (error) {
      console.error('Error in fetchAllCompanies:', error);
      setAllCompanies([]);
      return [];
    } finally {
      setCompaniesLoading(false);
    }
  };

  // Create a map of domain -> company for fast lookup
  const domainToCompanyMap = useMemo(() => {
    const map = new Map<string, Company>();
    
    allCompanies.forEach(company => {
      if (company.domain) {
        const normalizedDomain = company.domain.toLowerCase().trim();
        // Store the company, allowing multiple companies per domain (last one wins)
        map.set(normalizedDomain, company);
      }
    });
    
    return map;
  }, [allCompanies]);

  // Fetch all companies when component mounts or user changes
  useEffect(() => {
    if (userId) {
      fetchAllCompanies();
    } else {
      setAllCompanies([]);
    }
  }, [userId]);

  // Handle CSV file upload
  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setToastMessage('CSV file is empty or invalid');
        setShowToast(true);
        return;
      }

      setCsvData(parsed);
      setShowColumnSelector(true);
      setSelectedSourceColumn(null);
      setStatus(`Parsed ${parsed.rows.length} rows. Select the column containing emails or domains.`);
    } catch (error) {
      console.error('Error parsing CSV:', error);
      setToastMessage('Failed to parse CSV file. Please check the file format.');
      setShowToast(true);
    }
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Run enrichment
  const runEnrichment = async () => {
    if (!csvData || !selectedSourceColumn) {
      setToastMessage('Please select a source column first');
      setShowToast(true);
      return;
    }

    // Ensure we have all companies loaded
    let companiesToUse = allCompanies;
    if (companiesLoading || allCompanies.length === 0) {
      setStatus("Loading all companies from database...");
      companiesToUse = await fetchAllCompanies();
    }
    
    // Check if we have companies
    if (companiesToUse.length === 0) {
      setStatus("No companies found in database. Please add companies first.");
      setToastMessage('No companies found in database.');
      setShowToast(true);
      setIsProcessing(false);
      return;
    }

    // Create domain map from fetched companies
    const domainMap = new Map<string, Company>();
    companiesToUse.forEach(company => {
      if (company.domain) {
        const normalizedDomain = company.domain.toLowerCase().trim();
        domainMap.set(normalizedDomain, company);
      }
    });

    // Guard: limit to 25k rows for browser-based processing
    if (csvData.rows.length > 25000) {
      setStatus("This UI flow is intended for about 25k rows. For larger datasets, use server-side processing.");
      setToastMessage('Too many rows. Maximum 25,000 rows supported.');
      setShowToast(true);
      return;
    }

    setIsProcessing(true);
    setStatus("Processing CSV and matching domains...");

    try {
      let matchedCount = 0;
      let unmatchedCount = 0;

      // Enrich each row
      const enrichedRows: CsvRow[] = csvData.rows.map((row, index) => {
        const sourceValue = row[selectedSourceColumn] || '';
        const domain = extractDomainFromValue(sourceValue);
        
        const enrichedRow = { ...row };

        if (domain && domainMap.has(domain)) {
          matchedCount++;
          const company = domainMap.get(domain)!;
          
          // Add company data to the row
          if (company.summary) {
            const summary = company.summary;
            
            // Add company summary fields
            enrichedRow['Company Summary'] = summary.company_summary || summary.profile_summary || '';
            enrichedRow['Company Industry'] = summary.company_industry || summary.profile_industry || '';
            enrichedRow['Sales Opener Sentence'] = summary.sales_opener_sentence || '';
            enrichedRow['Classification'] = summary.classification || '';
            
            if (summary.confidence_score !== undefined) {
              enrichedRow['Confidence Score'] = String(summary.confidence_score);
            }
            
            // Handle product types
            if (summary.product_types && Array.isArray(summary.product_types)) {
              const productTypes = summary.product_types.filter((pt: any) => pt && typeof pt === 'string');
              if (productTypes.length > 0) {
                // Format product types as string
                if (productTypes.length === 1) {
                  enrichedRow['Product Types'] = productTypes[0];
                } else if (productTypes.length === 2) {
                  enrichedRow['Product Types'] = `${productTypes[0]} and ${productTypes[1]}`;
                } else {
                  const allButLast = productTypes.slice(0, -1).join(', ');
                  enrichedRow['Product Types'] = `${allButLast}, and ${productTypes[productTypes.length - 1]}`;
                }
                
                // Add individual product type columns
                productTypes.forEach((pt: string, idx: number) => {
                  enrichedRow[`PRODUCT${idx + 1}`] = pt;
                });
              }
            }
            
            enrichedRow['Sales Action'] = summary.sales_action || '';
          }
          
          // Add contact information
          if (company.email) {
            enrichedRow['Email'] = company.email;
          }
          if (company.phone) {
            enrichedRow['Phone'] = company.phone;
          }
          if (company.instagram) {
            enrichedRow['Instagram'] = company.instagram;
          }
          
          // Add domain for reference
          enrichedRow['Matched Domain'] = company.domain;
        } else {
          unmatchedCount++;
          enrichedRow['Matched Domain'] = '';
        }

        // Update status periodically
        if ((index + 1) % 1000 === 0) {
          setStatus(`Processing... ${index + 1} of ${csvData.rows.length} rows`);
        }

        return enrichedRow;
      });

      // Determine which columns to include in the output
      const baseHeaders = [...csvData.headers];
      
      // Add enrichment columns if they don't exist
      const enrichmentColumns = [
        'Company Summary',
        'Company Industry',
        'Sales Opener Sentence',
        'Classification',
        'Confidence Score',
        'Product Types',
        'Sales Action',
        'Email',
        'Phone',
        'Instagram',
        'Matched Domain'
      ];

      // Find max product type columns needed
      const maxProductTypes = enrichedRows.reduce((max, row) => {
        let count = 0;
        for (let i = 1; i <= 20; i++) {
          if (row[`PRODUCT${i}`]) count = i;
        }
        return Math.max(max, count);
      }, 0);

      // Build final headers
      const finalHeaders = [...baseHeaders];
      
      // Add enrichment columns that don't exist
      enrichmentColumns.forEach(col => {
        if (!finalHeaders.includes(col)) {
          finalHeaders.push(col);
        }
      });

      // Add product type columns
      for (let i = 1; i <= maxProductTypes; i++) {
        const colName = `PRODUCT${i}`;
        if (!finalHeaders.includes(colName)) {
          finalHeaders.push(colName);
        }
      }

      setStatus(`Done. Matched ${matchedCount} rows, ${unmatchedCount} unmatched. Generating CSV...`);

      // Generate CSV
      const csvString = csvToString(finalHeaders, enrichedRows);
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `enriched_${timestamp}.csv`;

      setStatus("Downloading CSV...");
      
      // Small delay to show the status message
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Download CSV
      downloadCsv(csvString, filename);

      setStatus("Cleaning up...");
      
      // Small delay to show cleanup status
      await new Promise(resolve => setTimeout(resolve, 100));

      // Clean up state
      setCsvData(null);
      setSelectedSourceColumn(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      setStatus(`✅ Done — file downloaded and temp data removed.\n\nEnriched ${enrichedRows.length} rows. Matched ${matchedCount} companies, ${unmatchedCount} unmatched.\nDownloaded: ${filename}`);
      setToastMessage(`Successfully enriched CSV. Matched ${matchedCount} companies.`);
      setShowToast(true);
    } catch (error: any) {
      console.error('Error enriching CSV:', error);
      setStatus(`Error: ${error?.message ?? String(error)}`);
      setToastMessage(`Error: ${error?.message ?? 'Failed to enrich CSV'}`);
      setShowToast(true);
    } finally {
      setIsProcessing(false);
    }
  };

  // Clear all data
  const handleClear = () => {
    setCsvData(null);
    setSelectedSourceColumn(null);
    setStatus("");
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const canRun = csvData && selectedSourceColumn && !isProcessing && !companiesLoading;

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-semibold">CSV Enrichment</h2>
          {csvData && (
            <button
              onClick={handleClear}
              className="px-4 py-2 bg-red-600 text-white rounded-sm hover:bg-red-700 transition-colors font-medium text-sm"
            >
              Clear
            </button>
          )}
        </div>
        
        <p className="text-gray-600 mb-6">
          Upload a CSV file and enrich it with company data from your database. 
          The tool will match domains from your CSV (emails or URLs) to companies in your database 
          and add company information to each row.
        </p>

        {/* File Upload */}
        <div className="border-2 border-dashed border-gray-300 rounded-sm p-6 bg-gray-50 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold mb-1">Upload CSV File</h3>
              <p className="text-sm text-gray-600">
                Select a CSV file containing emails or domains in one of its columns.
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleCsvUpload}
              className="hidden"
              id="csv-upload-enrich"
            />
            <label
              htmlFor="csv-upload-enrich"
              className="px-4 py-2 bg-indigo-600 text-white rounded-sm cursor-pointer hover:bg-indigo-700 transition-colors font-medium text-sm"
            >
              Choose CSV File
            </label>
          </div>
        </div>

        {/* Column Selector Info */}
        {csvData && !selectedSourceColumn && (
          <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-sm">
            <p className="text-sm text-yellow-900">
              Please select the column containing emails or domains from the dialog above.
            </p>
          </div>
        )}

        {/* Selected Column Info */}
        {selectedSourceColumn && csvData && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-sm">
            <p className="text-sm text-green-900">
              <span className="font-semibold">Selected column:</span> {selectedSourceColumn}
              <br />
              <span className="text-xs text-green-700">
                {csvData.rows.length} rows ready for enrichment
              </span>
            </p>
          </div>
        )}

        {/* Processing Status */}
        {isProcessing && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-sm">
            <div className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
              <p className="text-sm text-blue-900">{status || "Processing..."}</p>
            </div>
          </div>
        )}

        {/* Status Message */}
        {status && !isProcessing && (
          <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-sm">
            <p className="text-sm text-gray-900 whitespace-pre-wrap">{status}</p>
          </div>
        )}

        {/* Enrich Button */}
        <div className="mb-6">
          <button
            onClick={runEnrichment}
            disabled={!canRun}
            className={`px-6 py-3 rounded-sm font-medium text-sm transition-colors ${
              canRun
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            {isProcessing ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing...
              </span>
            ) : (
              'Enrich and Download CSV'
            )}
          </button>
        </div>

        {/* Info Note */}
        <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-sm">
          <p className="text-xs text-gray-600">
            <span className="font-semibold">Note:</span> This tool is designed for up to 20,000 rows. 
            The tool extracts domains from 
            email addresses (part after @) or normalizes URLs to extract the domain. Matching is done 
            against the domain field in your companies database.
          </p>
        </div>
      </div>

      {/* Column Selector Dialog */}
      <ColumnSelectorDialog
        isOpen={showColumnSelector}
        columns={csvData?.headers || []}
        rows={csvData?.rows || []}
        selectedColumn={selectedSourceColumn}
        onSelectColumn={setSelectedSourceColumn}
        onConfirm={() => {
          if (selectedSourceColumn) {
            setShowColumnSelector(false);
            setStatus(`Selected column: ${selectedSourceColumn}. Ready to enrich ${csvData?.rows.length || 0} rows.`);
          }
        }}
        onClose={() => {
          setShowColumnSelector(false);
          if (!selectedSourceColumn) {
            setCsvData(null);
          }
        }}
        mode="domain"
      />

      {/* Toast */}
      <Toast
        message={toastMessage}
        isVisible={showToast}
        onClose={() => setShowToast(false)}
      />
    </div>
  );
}
