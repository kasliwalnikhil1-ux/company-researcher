// CompanyResearchHome.tsx

"use client";
import { useState, FormEvent, useCallback, useMemo, useRef } from "react";
import QualificationDisplay from './qualification/QualificationDisplay';
import Image from "next/image";
import { fetchCompanyMap, sendSlackNotification } from "../lib/api";
import ExportCsvButton from './ui/ExportCsvButton';
import ColumnSelectorDialog from './ui/ColumnSelectorDialog';
import ConfirmationModal from './ui/ConfirmationModal';
import { parseCsv, csvToString, mergeQualificationData, ensureColumnsExist, CsvRow } from "../lib/csvImport";
import { downloadCsv } from "../lib/csvExport";

// Interface for qualification data
interface QualificationData {
  company_summary: string;
  company_industry: string;
  sales_opener_sentence: string;
  classification: 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE';
  confidence_score: number;
  product_types: string[] | null;
  sales_action: 'OUTREACH' | 'EXCLUDE' | 'PARTNERSHIP' | 'MANUAL_REVIEW';
}

// Utility functions
const extractDomain = (url: string): string | null => {
  if (!url) return null;
  try {
    // Remove protocol, www, and any path/query parameters
    let domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/:?]/)[0];
    return domain || null;
  } catch (e) {
    console.error('Error extracting domain:', e);
    return null;
  }
};

// Clean URL to base domain with protocol (remove paths, query params, etc.)
const cleanUrl = (url: string): string | null => {
  if (!url) return null;
  try {
    // Remove any whitespace
    url = url.trim();
    
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    // Parse URL to extract just the origin (protocol + hostname)
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // Return base URL with protocol
    return `${urlObj.protocol}//${hostname}`;
  } catch (e) {
    console.error('Error cleaning URL:', e);
    return null;
  }
};

export default function CompanyResearcher() {
  // Company input and state
  const [rawCompanyInput, setRawCompanyInput] = useState('');
  const [submittedCompanies, setSubmittedCompanies] = useState<string[]>([]);
  const [activeCompany, setActiveCompany] = useState<string>('');
  const [isSearching, setIsSearching] = useState(false);
  
  // Results and errors by company
  const [resultsByCompany, setResultsByCompany] = useState<{
    [company: string]: {
      qualificationData: QualificationData | null;
    }
  }>({});
  
  const [errorsByCompany, setErrorsByCompany] = useState<{[company: string]: Record<string, string>}>({});
  
  // CSV import state
  const [csvData, setCsvData] = useState<{ headers: string[]; rows: CsvRow[] } | null>(null);
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  const [selectedUrlColumn, setSelectedUrlColumn] = useState<string | null>(null);
  const [isProcessingCsv, setIsProcessingCsv] = useState(false);
  const [csvProcessingProgress, setCsvProcessingProgress] = useState({ current: 0, total: 0 });
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Helper to get current company data
  const getCurrentCompanyData = useCallback((company: string) => {
    return resultsByCompany[company] || {
      qualificationData: null
    };
  }, [resultsByCompany]);
  
  // Get data for active company
  const { qualificationData } = activeCompany ? getCurrentCompanyData(activeCompany) : getCurrentCompanyData('');

  // Prepare companies data for CSV export
  const companiesForExport = useMemo(() => {
    return submittedCompanies.map(company => ({
      companyName: company,
      data: {
        qualificationData: resultsByCompany[company]?.qualificationData || null
      }
    }));
  }, [submittedCompanies, resultsByCompany]);

  // Function to check if a string is a valid URL
  const isValidUrl = useCallback(async (url: string): Promise<boolean> => {
    try {
      // Remove any whitespace
      url = url.trim();
      
      // Check if it's just a single word without dots
      if (!url.includes('.')) {
        return false;
      }

      // Add protocol if missing
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      const urlObj = new URL(url);
      // Check if hostname has at least one dot and no spaces
      return urlObj.hostname.includes('.') && !urlObj.hostname.includes(' ');
    } catch {
      return false;
    }
  }, []);

  // Parse company input into array of company names
  const parseCompanyInput = useCallback((input: string): string[] => {
    return input
      .split(/[,\n]/) // Split by comma or newline
      .map(company => company.trim())
      .filter(company => company.length > 0) // Remove empty entries
      .map(company => {
        // Clean URL to base domain
        const cleaned = cleanUrl(company);
        return cleaned || company; // Fallback to original if cleaning fails
      })
      .filter((company, index, self) => 
        index === self.findIndex(c => c.toLowerCase() === company.toLowerCase()) // Deduplicate case-insensitive
      );
  }, []);

  // Research a single company
  const researchCompany = useCallback(async (company: string) => {
    const domainName = extractDomain(company);
    if (!domainName) {
      setErrorsByCompany(prev => ({
        ...prev,
        [company]: { form: `Invalid company URL: ${company}. Please use format 'example.com'` }
      }));
      return;
    }

    // Initialize company data and clear previous errors
    setResultsByCompany(prev => ({
      ...prev,
      [company]: {
        qualificationData: null
      }
    }));
    
    setErrorsByCompany(prev => ({
      ...prev,
      [company]: {}
    }));

    try {
      // Fetch company qualification data
      let qualificationData = null;
      
      try {
        qualificationData = await fetchCompanyMap(domainName);
      } catch (error) {
        console.error('Error fetching company qualification:', error);
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            qualificationData: 'Could not load qualification data.'
          }
        }));
      }

      // Update results with qualification data
      setResultsByCompany(prev => ({
        ...prev,
        [company]: {
          ...prev[company],
          ...(qualificationData && { qualificationData: qualificationData })
        }
      }));

    } catch (error) {
      setErrorsByCompany(prev => ({
        ...prev,
        [company]: {
          ...prev[company],
          general: error instanceof Error ? error.message : 'An unexpected error occurred'
        }
      }));
    }
  }, []);

  // Handle CSV file upload
  const handleCsvUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        alert('CSV file is empty or invalid');
        return;
      }

      setCsvData(parsed);
      setShowColumnSelector(true);
      setSelectedUrlColumn(null);
    } catch (error) {
      console.error('Error parsing CSV:', error);
      alert('Failed to parse CSV file. Please check the file format.');
    }
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Process CSV rows
  const processCsvRows = useCallback(async () => {
    if (!csvData || !selectedUrlColumn) return;

    setIsProcessingCsv(true);
    setCsvProcessingProgress({ current: 0, total: csvData.rows.length });

    // Collect all valid URLs from CSV for display in textarea (cleaned)
    const allValidUrls: string[] = [];
    csvData.rows.forEach(row => {
      const url = row[selectedUrlColumn]?.trim() || '';
      if (url && url.includes('.')) {
        const cleaned = cleanUrl(url);
        if (cleaned) {
          allValidUrls.push(cleaned);
        }
      }
    });

    // Filter rows: skip if Classification is filled, skip if no valid URL
    const rowsToProcess = csvData.rows.filter((row, index) => {
      const url = row[selectedUrlColumn]?.trim() || '';
      const classification = row['Classification']?.trim() || '';
      
      // Skip if Classification is already filled
      if (classification) {
        return false;
      }
      
      // Skip if no valid URL
      if (!url || !url.includes('.')) {
        return false;
      }
      
      return true;
    });

    // Extract unique domains from URLs (clean URLs first)
    const urlToDomainMap = new Map<string, string>();
    const uniqueDomains = new Set<string>();
    
    rowsToProcess.forEach(row => {
      const url = row[selectedUrlColumn]?.trim() || '';
      if (url) {
        // Clean URL first
        const cleanedUrl = cleanUrl(url);
        if (cleanedUrl) {
          const domainName = extractDomain(cleanedUrl);
          if (domainName) {
            // Map both original and cleaned URL to domain
            urlToDomainMap.set(url, domainName);
            urlToDomainMap.set(cleanedUrl, domainName);
            uniqueDomains.add(domainName);
          }
        }
      }
    });

    // Fetch qualification data for all unique domains
    const qualificationDataMap = new Map<string, any>();
    const errorMap = new Map<string, string>(); // Track errors for each domain
    
    const uniqueDomainsArray = Array.from(uniqueDomains);
    for (let i = 0; i < uniqueDomainsArray.length; i++) {
      const domainName = uniqueDomainsArray[i];
      setCsvProcessingProgress({ current: i + 1, total: uniqueDomainsArray.length });
      
      try {
        const data = await fetchCompanyMap(domainName);
        if (data) {
          qualificationDataMap.set(domainName, data);
        } else {
          // Data fetch returned null, indicating an error
          errorMap.set(domainName, 'Failed to fetch company qualification data');
        }
      } catch (error) {
        console.error(`Error fetching data for ${domainName}:`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        errorMap.set(domainName, errorMessage);
      }
    }

    // Merge qualification data into CSV rows
    const updatedRows = csvData.rows.map(row => {
      const url = row[selectedUrlColumn]?.trim() || '';
      const classification = row['Classification']?.trim() || '';
      const updatedRow = { ...row };
      
      // Skip if Classification is already filled
      if (classification) {
        // Still update Research Status if not set or if we want to track skipped rows
        if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
          updatedRow['Research Status'] = 'skipped (already classified)';
        }
        return updatedRow;
      }
      
      // Skip if no valid URL
      if (!url || !url.includes('.')) {
        // Still update Research Status if not set
        if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
          updatedRow['Research Status'] = 'skipped (invalid URL)';
        }
        return updatedRow;
      }

      // Clean URL and extract domain
      const cleanedUrl = cleanUrl(url);
      const domainName = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
      const qualificationData = domainName 
        ? qualificationDataMap.get(domainName)
        : null;

      // Determine research status for processed rows
      let researchStatus = '';
      if (qualificationData) {
        researchStatus = 'completed';
      } else if (domainName) {
        // Check if there's an error for this domain
        const error = errorMap.get(domainName);
        researchStatus = error || 'Failed to fetch company qualification data';
      } else {
        researchStatus = 'Invalid URL';
      }
      
      // Update Research Status for processed rows (always update to reflect current status)
      updatedRow['Research Status'] = researchStatus;
      
      if (qualificationData) {
        // We have qualification data, use it
        updatedRow['Company Summary'] = qualificationData.company_summary || updatedRow['Company Summary'] || '';
        updatedRow['Company Industry'] = qualificationData.company_industry || updatedRow['Company Industry'] || '';
        updatedRow['Sales Opener Sentence'] = qualificationData.sales_opener_sentence || updatedRow['Sales Opener Sentence'] || '';
        updatedRow['Classification'] = qualificationData.classification || updatedRow['Classification'] || '';
        updatedRow['Confidence Score'] = String((qualificationData.confidence_score ?? updatedRow['Confidence Score']) || '');
        
        // Handle product types
        if (qualificationData.product_types && Array.isArray(qualificationData.product_types)) {
          const productTypes = qualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
          if (productTypes.length > 0) {
            // Format product types as string
            if (productTypes.length === 1) {
              updatedRow['Product Types'] = productTypes[0];
            } else if (productTypes.length === 2) {
              updatedRow['Product Types'] = `${productTypes[0]} and ${productTypes[1]}`;
            } else {
              const allButLast = productTypes.slice(0, -1).join(', ');
              updatedRow['Product Types'] = `${allButLast}, and ${productTypes[productTypes.length - 1]}`;
            }
            
            // Add individual product type columns
            productTypes.forEach((pt: string, index: number) => {
              updatedRow[`PRODUCT${index + 1}`] = pt;
            });
          }
        }
        
        updatedRow['Sales Action'] = qualificationData.sales_action || updatedRow['Sales Action'] || '';
      } else {
        // No qualification data, but still add empty columns to maintain structure
        updatedRow['Company Summary'] = updatedRow['Company Summary'] || '';
        updatedRow['Company Industry'] = updatedRow['Company Industry'] || '';
        updatedRow['Sales Opener Sentence'] = updatedRow['Sales Opener Sentence'] || '';
        updatedRow['Classification'] = updatedRow['Classification'] || '';
        updatedRow['Confidence Score'] = updatedRow['Confidence Score'] || '';
        updatedRow['Product Types'] = updatedRow['Product Types'] || '';
        updatedRow['Sales Action'] = updatedRow['Sales Action'] || '';
      }
      
      return updatedRow;
    });

    // Ensure all required columns exist
    const updatedHeaders = ensureColumnsExist(csvData.headers);
    
    // Add PRODUCT columns if needed
    const maxProductTypes = updatedRows.reduce((max, row) => {
      let count = 0;
      Object.keys(row).forEach(key => {
        if (key.startsWith('PRODUCT')) {
          const num = parseInt(key.replace('PRODUCT', ''));
          if (!isNaN(num)) count = Math.max(count, num);
        }
      });
      return Math.max(max, count);
    }, 0);

    const finalHeaders = [...updatedHeaders];
    for (let i = 1; i <= maxProductTypes; i++) {
      const colName = `PRODUCT${i}`;
      if (!finalHeaders.includes(colName)) {
        finalHeaders.push(colName);
      }
    }

    // Generate updated CSV
    const updatedCsv = csvToString(finalHeaders, updatedRows);
    
    // Download updated CSV
    downloadCsv(updatedCsv, 'updated-companies.csv');
    
    // Add URLs to textarea for visual display (all valid URLs from CSV)
    const uniqueUrls = Array.from(new Set(allValidUrls));
    const existingUrls = parseCompanyInput(rawCompanyInput);
    const combinedUrls = Array.from(new Set([...existingUrls, ...uniqueUrls]));
    setRawCompanyInput(combinedUrls.join(', '));
    
    // Set as submitted companies and active company for display
    setSubmittedCompanies(combinedUrls);
    if (combinedUrls.length > 0 && !activeCompany) {
      setActiveCompany(combinedUrls[0]);
    }
    
    // Store results for display (only for processed URLs that have data, using cleaned URLs)
    const newResults: typeof resultsByCompany = {};
    rowsToProcess.forEach(row => {
      const url = row[selectedUrlColumn]?.trim() || '';
      if (url) {
        const cleanedUrl = cleanUrl(url);
        const domainName = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
        const qualificationData = domainName ? qualificationDataMap.get(domainName) : null;
        if (qualificationData) {
          // Use cleaned URL as key for display
          const displayUrl = cleanedUrl || url;
          newResults[displayUrl] = {
            qualificationData: qualificationData
          };
        }
      }
    });
    setResultsByCompany(prev => ({ ...prev, ...newResults }));
    
    setIsProcessingCsv(false);
    setCsvData(null);
    setShowColumnSelector(false);
    setSelectedUrlColumn(null);
    
    // Show confirmation modal
    const message = `CSV processing complete! Processed ${rowsToProcess.length} rows.`;
    setConfirmationMessage(message);
    setShowConfirmationModal(true);
    
    // Send Slack notification
    sendSlackNotification(`✅ CSV Processing Complete: Processed ${rowsToProcess.length} rows.`).catch(
      (error) => console.error('Failed to send Slack notification:', error)
    );
  }, [csvData, selectedUrlColumn]);

  // Clear all data function
  const handleClearAll = useCallback(() => {
    setRawCompanyInput('');
    setSubmittedCompanies([]);
    setActiveCompany('');
    setResultsByCompany({});
    setErrorsByCompany({});
    setCsvData(null);
    setSelectedUrlColumn(null);
    setIsSearching(false);
    setIsProcessingCsv(false);
    setCsvProcessingProgress({ current: 0, total: 0 });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Main Research Function
  const handleResearch = useCallback(async (e: FormEvent) => {
    e.preventDefault();

    const companies = parseCompanyInput(rawCompanyInput);
    
    if (companies.length === 0) {
      setErrorsByCompany(prev => ({
        ...prev,
        _form: { form: 'Please enter at least one company URL' }
      }));
      return;
    }

    setIsSearching(true);
    setSubmittedCompanies(companies);
    setActiveCompany(companies[0]);
    
    // Clear previous results and errors for these companies
    setResultsByCompany(prev => {
      const newState = { ...prev };
      companies.forEach(company => {
        if (!newState[company]) {
          newState[company] = {
            qualificationData: null
          };
        }
      });
      return newState;
    });
    
    setErrorsByCompany({});

    // Start research for all companies in parallel
    await Promise.all(companies.map(company => researchCompany(company)));
    
    setIsSearching(false);
  }, [rawCompanyInput, researchCompany]);

  return (
    <div className="w-full max-w-5xl p-6 z-10 mb-20 mt-6">
      <div className="flex items-center justify-between mb-4 pb-5 opacity-0 animate-fade-up [animation-delay:200ms]">
        <div className="flex items-center gap-4">
          <Image 
            src="/logo.png" 
            alt="Logo" 
            width={60} 
            height={60} 
            className="object-contain"
          />
          <h1 className="md:text-6xl text-4xl font-medium">
            <span className="text-brand-default"> Company </span>
            Researcher
          </h1>
        </div>
        {(submittedCompanies.length > 0 || rawCompanyInput.trim().length > 0) && (
          <button
            onClick={handleClearAll}
            className="px-4 py-2 bg-red-600 text-white rounded-sm hover:bg-red-700 transition-colors font-medium text-sm whitespace-nowrap"
          >
            CLEAR ALL
          </button>
        )}
      </div>

      <p className="text-black mb-12 opacity-0 animate-fade-up [animation-delay:400ms]">
        Enter company URLs (comma or newline separated) for qualification assessment, or upload a CSV file.
      </p>

      {/* CSV Import Section */}
      <div className="mb-8 opacity-0 animate-fade-up [animation-delay:500ms]">
        <div className="border-2 border-dashed border-gray-300 rounded-sm p-6 bg-gray-50">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold mb-1">Import from CSV</h3>
              <p className="text-sm text-gray-600">
                Upload a CSV file to process multiple companies. Select the column containing website URLs.
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleCsvUpload}
              className="hidden"
              id="csv-upload"
            />
            <label
              htmlFor="csv-upload"
              className="px-4 py-2 bg-brand-default text-white rounded-sm cursor-pointer hover:bg-opacity-90 transition-colors"
            >
              Choose CSV File
            </label>
          </div>
          {isProcessingCsv && (
            <div className="mt-4 p-3 bg-blue-50 text-blue-700 rounded-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-700"></div>
                <span>Processing CSV: {csvProcessingProgress.current} / {csvProcessingProgress.total}</span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${(csvProcessingProgress.current / csvProcessingProgress.total) * 100}%` }}
                ></div>
              </div>
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleResearch} className="space-y-6 mb-8">
        <textarea
          value={rawCompanyInput}
          onChange={(e) => setRawCompanyInput(e.target.value)}
          placeholder="Enter company URLs (e.g., example.com, another-company.com)"
          rows={4}
          className="w-full bg-white p-3 border box-border outline-none rounded-sm ring-2 ring-brand-default resize-none opacity-0 animate-fade-up [animation-delay:600ms]"
        />
        <button
          type="submit"
          className={`w-full text-white font-semibold px-2 py-2 rounded-sm transition-opacity opacity-0 animate-fade-up [animation-delay:800ms] min-h-[50px] ${
            isSearching ? 'bg-gray-400' : 'bg-brand-default ring-2 ring-brand-default'
          } transition-colors`}
          disabled={isSearching}
        >
          {isSearching ? 'Analyzing...' : 'Analyze Companies'}
        </button>
      </form>
      
      {/* Global loading indicator */}
      {isSearching && (
        <div className="mb-6 p-3 bg-blue-50 text-blue-700 rounded-sm flex items-center gap-2">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-700"></div>
          <span>Analyzing company qualification...</span>
        </div>
      )}
      
      {/* Tabs for companies */}
      {submittedCompanies.length > 0 && (
        <div className="mb-6 border-b border-gray-200">
          <nav className="-mb-px flex space-x-8 overflow-x-auto">
            {submittedCompanies.map((company) => (
              <button
                key={company}
                onClick={() => setActiveCompany(company)}
                className={`whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm ${
                  activeCompany === company
                    ? 'border-brand-default text-brand-default'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {company}
                {errorsByCompany[company] && Object.keys(errorsByCompany[company]).length > 0 && (
                  <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                    Error
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      )}
      
      {/* Display errors for the active company */}
      {activeCompany && errorsByCompany[activeCompany] && (
        <div className="space-y-2 mb-6">
          {Object.entries(errorsByCompany[activeCompany]).map(([key, message]) => (
            <div key={key} className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-sm">
              {key !== 'form' && <span className="font-medium">{key}: </span>}
              {message as string}
            </div>
          ))}
        </div>
      )}
      
      <div className="space-y-12">
        {/* Qualification Section */}
        {(isSearching || qualificationData) && (
          <div className="space-y-8">
            <div className="flex items-center">
              <h2 className="text-3xl font-medium">Qualification Assessment</h2>
            </div>

            <div className="opacity-0 animate-fade-up [animation-delay:300ms]">
              {isSearching && qualificationData === null ? (
                <div className="animate-pulse">
                  <div className="h-[300px] bg-gray-100 rounded-lg flex items-center justify-center">
                    <div className="text-center">
                      <div className="text-gray-500 mb-2">Analyzing company qualification...</div>
                      <div className="flex justify-center">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-700"></div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : qualificationData ? (
                <QualificationDisplay data={qualificationData} />
              ) : (
                <div className="h-[300px] bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                  <div className="text-center p-6">
                    <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <h3 className="mt-2 text-sm font-medium text-gray-900">No qualification data available</h3>
                    <p className="mt-1 text-sm text-gray-500">We couldn't generate qualification data for this company.</p>
                    {errorsByCompany[activeCompany || '']?.qualificationData && (
                      <p className="mt-2 text-sm text-red-600">
                        {errorsByCompany[activeCompany || ''].qualificationData}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Export CSV Button */}
      {submittedCompanies.length > 0 && companiesForExport.length > 0 && (
        <ExportCsvButton companies={companiesForExport} />
      )}

      {/* Column Selector Dialog */}
      <ColumnSelectorDialog
        isOpen={showColumnSelector}
        columns={csvData?.headers || []}
        rows={csvData?.rows || []}
        selectedColumn={selectedUrlColumn}
        onSelectColumn={(column) => {
          setSelectedUrlColumn(column);
        }}
        onConfirm={() => {
          if (selectedUrlColumn) {
            setShowColumnSelector(false);
            processCsvRows();
          }
        }}
        onClose={() => {
          setShowColumnSelector(false);
          setCsvData(null);
          setSelectedUrlColumn(null);
        }}
      />

      {/* Confirmation Modal */}
      <ConfirmationModal
        isOpen={showConfirmationModal}
        title="CSV Processing Complete"
        message={confirmationMessage}
        onClose={() => setShowConfirmationModal(false)}
      />
    </div>  
  );
}
