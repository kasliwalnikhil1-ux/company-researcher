"use client";

import { useState, useRef, useMemo } from "react";
import { parseCsv, CsvRow, csvToString } from "../lib/csvImport";
import { downloadCsv } from "../lib/csvExport";
import { cleanInvestorInput } from "../lib/api";
import { supabase } from "@/utils/supabase/client";
import Toast from "./ui/Toast";

// Invalid domains that should be blocked
const INVALID_DOMAINS = [
  'x.com',
  'twitter.com',
  'linkedin.com',
  'whatsapp.com',
  'facebook.com',
  "fb.com",
  'tiktok.com',
  'youtube.com',
  'snapchat.com',
  'discord.com',
  'telegram.org',
  'slack.com',
  'reddit.com',
  'pinterest.com'
];

// Excluded domains for column preview filtering (social media, platforms)
const EXCLUDED_PREVIEW_DOMAINS = [
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'wikipedia.org', 'apollo.io', 'amazonaws.com',
];

const isExcludedPreviewDomain = (url: string): boolean => {
  if (!url || typeof url !== 'string') return false;
  try {
    let domain = url.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
    return EXCLUDED_PREVIEW_DOMAINS.some(ex => domain === ex || domain.endsWith('.' + ex));
  } catch { return false; }
};

// Path-only LinkedIn pattern: "word/word" where first segment has no dot (not a domain)
const LINKEDIN_PATH_RE = /^[a-z][\w-]*\/[\w.-]+$/i;

/** Check if a value looks like a URL or domain (contains a dot, not just a number) */
const looksLikeUrl = (value: string): boolean => {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  // Accept linkedin path-only like in/name, company/name, pub/name (no dot = not a domain)
  if (LINKEDIN_PATH_RE.test(v) && !v.includes('.')) return true;
  if (!v.includes('.')) return false;
  // Accept linkedin.com URLs too (investor mode)
  if (v.toLowerCase().includes('linkedin.com')) return true;
  // General URL/domain check
  return !isExcludedPreviewDomain(v) || v.toLowerCase().includes('linkedin.com');
};

/** Get preview URLs from a column (first few rows) */
const getColumnPreview = (rows: CsvRow[], columnName: string, max: number = 3): string[] => {
  const previews: string[] = [];
  for (const row of rows.slice(0, 20)) {
    const val = row[columnName]?.trim() || '';
    if (val && (val.includes('.') || (LINKEDIN_PATH_RE.test(val) && !val.includes('.')))) {
      previews.push(val);
      if (previews.length >= max) break;
    }
  }
  return previews;
};

interface UploadedFile {
  name: string;
  headers: string[];
  rows: CsvRow[];
  selectedColumns: string[]; // columns chosen for this file (can be multiple)
}

interface ExtractionStats {
  totalFiles: number;
  totalUrls: number;
  uniqueDomains: number;
  uniqueLinkedIn: number;
  invalidDomains: number;
  emptyUrls: number;
}

export default function UniqueDomainsExtractor() {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [extractedDomains, setExtractedDomains] = useState<string[]>([]);
  const [extractedLinkedIn, setExtractedLinkedIn] = useState<string[]>([]);
  const [stats, setStats] = useState<ExtractionStats | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Per-file column selection wizard
  const [wizardFileIdx, setWizardFileIdx] = useState<number | null>(null);
  const [tempSelectedColumns, setTempSelectedColumns] = useState<string[]>([]);
  const [columnSearch, setColumnSearch] = useState('');

  // Filter existing state
  const [isFiltering, setIsFiltering] = useState(false);
  const [filterResult, setFilterResult] = useState<{
    removedDomains: number;
    removedLinkedIn: number;
    removedDomainsInvestors: number;
    removedDomainsNotInvestor: number;
    removedLinkedInInvestors: number;
    removedLinkedInNotInvestor: number;
  } | null>(null);

  const isWizardOpen = wizardFileIdx !== null && wizardFileIdx < uploadedFiles.length;
  const currentWizardFile = isWizardOpen ? uploadedFiles[wizardFileIdx!] : null;

  // Total row count across all files
  const totalRowCount = useMemo(() => {
    return uploadedFiles.reduce((sum, f) => sum + f.rows.length, 0);
  }, [uploadedFiles]);

  // Check if all files have at least one column selected
  const allColumnsSelected = uploadedFiles.length > 0 && uploadedFiles.every(f => f.selectedColumns.length > 0);

  // Columns that look like they contain URLs (for the current wizard file)
  const wizardUrlColumns = useMemo(() => {
    if (!currentWizardFile) return [];
    return currentWizardFile.headers.filter(header => {
      // Check first 10 rows for URL-like values
      for (const row of currentWizardFile.rows.slice(0, 10)) {
        const val = row[header]?.trim() || '';
        if (looksLikeUrl(val)) return true;
      }
      return false;
    });
  }, [currentWizardFile]);

  // Filtered wizard columns based on search
  const filteredWizardColumns = useMemo(() => {
    if (!currentWizardFile) return [];
    const allCols = currentWizardFile.headers;
    const q = columnSearch.toLowerCase().trim();
    return q ? allCols.filter(c => c.toLowerCase().includes(q)) : allCols;
  }, [currentWizardFile, columnSearch]);

  // Handle CSV file upload (supports multiple files)
  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const newFiles: UploadedFile[] = [];
    const errors: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const text = await file.text();
        const parsed = parseCsv(text);

        if (parsed.headers.length === 0 || parsed.rows.length === 0) {
          errors.push(`${file.name}: empty or invalid`);
          continue;
        }

        newFiles.push({
          name: file.name,
          headers: parsed.headers,
          rows: parsed.rows,
          selectedColumns: [],
        });
      } catch (error) {
        console.error(`Error parsing ${file.name}:`, error);
        errors.push(`${file.name}: failed to parse`);
      }
    }

    if (newFiles.length > 0) {
      const updatedFiles = [...uploadedFiles, ...newFiles];
      setUploadedFiles(updatedFiles);

      // Auto-open wizard for the first file that doesn't have columns selected
      const firstUnselected = updatedFiles.findIndex(f => f.selectedColumns.length === 0);
      if (firstUnselected !== -1) {
        setWizardFileIdx(firstUnselected);
        setTempSelectedColumns([]);
        setColumnSearch('');
      }

      setToastMessage(`Added ${newFiles.length} file${newFiles.length > 1 ? 's' : ''}${errors.length > 0 ? ` (${errors.length} failed)` : ''}`);
      setShowToast(true);
    } else if (errors.length > 0) {
      setToastMessage(`Failed to parse: ${errors.join(', ')}`);
      setShowToast(true);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Remove a single uploaded file
  const handleRemoveFile = (index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Open wizard for a specific file to re-select its columns
  const handleReselectColumns = (index: number) => {
    setWizardFileIdx(index);
    setTempSelectedColumns([...uploadedFiles[index].selectedColumns]);
    setColumnSearch('');
  };

  // Toggle a column in the wizard multi-select
  const toggleWizardColumn = (column: string) => {
    setTempSelectedColumns(prev =>
      prev.includes(column)
        ? prev.filter(c => c !== column)
        : [...prev, column]
    );
  };

  // Wizard: confirm columns for current file and advance to next
  const handleWizardConfirm = () => {
    if (wizardFileIdx === null || tempSelectedColumns.length === 0) return;

    // Save the selected columns for this file
    setUploadedFiles(prev => prev.map((f, i) =>
      i === wizardFileIdx ? { ...f, selectedColumns: [...tempSelectedColumns] } : f
    ));

    // Move to next file without columns selected
    const nextIdx = uploadedFiles.findIndex((f, i) => i > wizardFileIdx && f.selectedColumns.length === 0);

    if (nextIdx !== -1) {
      setWizardFileIdx(nextIdx);
      setTempSelectedColumns([]);
      setColumnSearch('');
    } else {
      setWizardFileIdx(null);
      setTempSelectedColumns([]);
      setColumnSearch('');
    }
  };

  // Wizard: close without saving
  const handleWizardClose = () => {
    setWizardFileIdx(null);
    setTempSelectedColumns([]);
    setColumnSearch('');
  };

  // Extract unique domains and LinkedIn URLs from all uploaded CSVs
  const runExtraction = () => {
    if (!allColumnsSelected) return;

    setIsProcessing(true);
    setFilterResult(null);

    try {
      const uniqueDomains = new Set<string>();
      const uniqueLinkedIn = new Set<string>();
      let totalUrls = 0;
      let invalidDomains = 0;
      let emptyUrls = 0;

      // Process each file with its selected columns
      uploadedFiles.forEach(file => {
        file.rows.forEach(row => {
          // Iterate over all selected columns for this file
          for (const col of file.selectedColumns) {
            const url = row[col]?.trim() || '';
            totalUrls++;

            if (!url) {
              emptyUrls++;
              continue;
            }

            const { cleaned, type, domain } = cleanInvestorInput(url);
            if (!cleaned) {
              emptyUrls++;
              continue;
            }

            if (type === 'linkedin') {
              // Ensure full LinkedIn URL (e.g. in/namankas -> https://www.linkedin.com/in/namankas)
              const fullLinkedIn = cleaned.startsWith('http')
                ? cleaned
                : `https://www.linkedin.com/${cleaned.replace(/^\/+/, '')}`;
              uniqueLinkedIn.add(fullLinkedIn);
            } else {
              if (domain && INVALID_DOMAINS.some(inv => domain.includes(inv))) {
                invalidDomains++;
                continue;
              }
              uniqueDomains.add(cleaned);
            }
          }
        });
      });

      const domainsArray = Array.from(uniqueDomains).sort();
      const linkedInArray = Array.from(uniqueLinkedIn).sort();

      setStats({
        totalFiles: uploadedFiles.length,
        totalUrls,
        uniqueDomains: domainsArray.length,
        uniqueLinkedIn: linkedInArray.length,
        invalidDomains,
        emptyUrls
      });

      setExtractedDomains(domainsArray);
      setExtractedLinkedIn(linkedInArray);

      const parts: string[] = [];
      if (domainsArray.length > 0) parts.push(`${domainsArray.length} domains`);
      if (linkedInArray.length > 0) parts.push(`${linkedInArray.length} LinkedIn URLs`);
      setToastMessage(`Extracted ${parts.join(' and ')} from ${uploadedFiles.length} file${uploadedFiles.length > 1 ? 's' : ''}`);
      setShowToast(true);

      setUploadedFiles([]);
    } catch (error) {
      console.error('Error extracting domains:', error);
      setToastMessage('Failed to extract domains. Please try again.');
      setShowToast(true);
    } finally {
      setIsProcessing(false);
    }
  };

  // Download current results as CSVs
  const handleDownloadResults = () => {
    const dateStr = new Date().toISOString().split('T')[0];

    if (extractedDomains.length > 0) {
      const domainRows: CsvRow[] = extractedDomains.map(d => ({ Domain: d }));
      const domainCsv = csvToString(['Domain'], domainRows);
      downloadCsv(domainCsv, `unique-domains-${dateStr}.csv`);
    }

    if (extractedLinkedIn.length > 0) {
      setTimeout(() => {
        const linkedInRows: CsvRow[] = extractedLinkedIn.map(l => ({ LinkedIn: l }));
        const linkedInCsv = csvToString(['LinkedIn'], linkedInRows);
        downloadCsv(linkedInCsv, `unique-linkedin-${dateStr}.csv`);
      }, 500);
    }

    setToastMessage('Downloading CSVs...');
    setShowToast(true);
  };

  // Filter out domains/LinkedIn URLs that already exist in the investors table
  const handleFilterExisting = async () => {
    if (extractedDomains.length === 0 && extractedLinkedIn.length === 0) return;

    setIsFiltering(true);
    setFilterResult(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        setToastMessage('No active session. Please log in again.');
        setShowToast(true);
        setIsFiltering(false);
        return;
      }

      const res = await fetch('/api/domains-extractor/filter-existing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          domains: extractedDomains,
          linkedinUrls: extractedLinkedIn,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setToastMessage(body?.error || `Filter failed (${res.status})`);
        setShowToast(true);
        setIsFiltering(false);
        return;
      }

      const data = await res.json();

      const removedDomains = data.removedDomains ?? 0;
      const removedLinkedIn = data.removedLinkedIn ?? 0;
      const removedDomainsInvestors = data.removedDomainsInvestors ?? 0;
      const removedDomainsNotInvestor = data.removedDomainsNotInvestor ?? 0;
      const removedLinkedInInvestors = data.removedLinkedInInvestors ?? 0;
      const removedLinkedInNotInvestor = data.removedLinkedInNotInvestor ?? 0;

      setExtractedDomains(data.domains ?? []);
      setExtractedLinkedIn(data.linkedinUrls ?? []);

      setStats(prev => prev ? {
        ...prev,
        uniqueDomains: (data.domains ?? []).length,
        uniqueLinkedIn: (data.linkedinUrls ?? []).length,
      } : prev);

      setFilterResult({
        removedDomains,
        removedLinkedIn,
        removedDomainsInvestors,
        removedDomainsNotInvestor,
        removedLinkedInInvestors,
        removedLinkedInNotInvestor,
      });

      const parts: string[] = [];
      if (removedDomains > 0) parts.push(`${removedDomains} domains`);
      if (removedLinkedIn > 0) parts.push(`${removedLinkedIn} LinkedIn URLs`);
      if (parts.length > 0) {
        setToastMessage(`Removed ${parts.join(' and ')} (from investors & not-an-investor tables)`);
      } else {
        setToastMessage('No existing entries found in either table — all entries are new');
      }
      setShowToast(true);
    } catch (error: any) {
      console.error('Error filtering existing:', error);
      setToastMessage(error?.message || 'Failed to filter existing investors');
      setShowToast(true);
    } finally {
      setIsFiltering(false);
    }
  };

  // Clear all results
  const handleClearResults = () => {
    setExtractedDomains([]);
    setExtractedLinkedIn([]);
    setStats(null);
    setUploadedFiles([]);
    setWizardFileIdx(null);
    setTempSelectedColumns([]);
    setColumnSearch('');
    setFilterResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const hasResults = extractedDomains.length > 0 || extractedLinkedIn.length > 0;

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-semibold">Extract Unique Domains &amp; LinkedIn from CSVs</h2>
          {(hasResults || uploadedFiles.length > 0) && (
            <button
              onClick={handleClearResults}
              className="px-4 py-2 bg-red-600 text-white rounded-sm hover:bg-red-700 transition-colors font-medium text-sm"
            >
              Clear All
            </button>
          )}
        </div>
        <p className="text-gray-600 mb-6">
          Upload one or more CSV files and select the URL columns for each. This tool will extract unique domains and
          LinkedIn URLs into two separate CSVs, excluding social media platforms and invalid domains.
        </p>

        {/* Upload Area */}
        <div className="border-2 border-dashed border-gray-300 rounded-sm p-6 bg-gray-50 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold mb-1">Upload CSV Files</h3>
              <p className="text-sm text-gray-600">
                Select one or more CSV files. You&apos;ll pick URL columns for each file.
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              multiple
              onChange={handleCsvUpload}
              className="hidden"
              id="csv-upload-domains"
            />
            <label
              htmlFor="csv-upload-domains"
              className="px-4 py-2 bg-brand-default text-white rounded-sm cursor-pointer hover:bg-opacity-90 transition-colors whitespace-nowrap"
            >
              {uploadedFiles.length > 0 ? 'Add More Files' : 'Choose CSV Files'}
            </label>
          </div>
        </div>

        {/* Uploaded Files List */}
        {uploadedFiles.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-sm p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">
                Uploaded Files ({uploadedFiles.length}) &middot; {totalRowCount.toLocaleString()} total rows
              </h3>
              <button
                onClick={runExtraction}
                disabled={!allColumnsSelected || isProcessing}
                className={`px-4 py-2 rounded-sm transition-colors text-sm font-medium ${
                  allColumnsSelected && !isProcessing
                    ? 'bg-brand-default text-white hover:bg-opacity-90'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
              >
                Extract Domains &amp; LinkedIn
              </button>
            </div>
            <div className="space-y-2">
              {uploadedFiles.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-sm border border-gray-100"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-wrap">
                    <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="text-sm font-medium text-gray-900 truncate">{file.name}</span>
                    <span className="text-xs text-gray-500 flex-shrink-0">
                      {file.rows.length.toLocaleString()} rows
                    </span>
                    {file.selectedColumns.length > 0 ? (
                      <button
                        onClick={() => handleReselectColumns(index)}
                        className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-sm hover:bg-green-200 transition-colors flex-shrink-0"
                        title="Click to change columns"
                      >
                        {file.selectedColumns.length === 1
                          ? `col: ${file.selectedColumns[0]}`
                          : `${file.selectedColumns.length} cols: ${file.selectedColumns.join(', ')}`}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleReselectColumns(index)}
                        className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-sm hover:bg-yellow-200 transition-colors flex-shrink-0"
                      >
                        Select columns
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemoveFile(index)}
                    className="text-gray-400 hover:text-red-600 transition-colors p-1 flex-shrink-0"
                    title="Remove file"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            {!allColumnsSelected && (
              <p className="text-xs text-yellow-700 mt-3">
                Select at least one URL column for each file before extracting.
              </p>
            )}
          </div>
        )}

        {(isProcessing || isFiltering) && (
          <div className="mb-6 p-3 bg-blue-50 text-blue-700 rounded-sm flex items-center gap-2">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-700"></div>
            <span>
              {isFiltering
                ? 'Checking investors & not-an-investor tables for existing entries...'
                : 'Extracting unique domains & LinkedIn URLs...'}
            </span>
          </div>
        )}

        {/* Stats Section */}
        {stats && (
          <div className="mb-6 grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="bg-white border border-gray-200 rounded-sm p-4">
              <div className="text-sm text-gray-600 mb-1">Files Processed</div>
              <div className="text-2xl font-semibold text-gray-900">{stats.totalFiles}</div>
            </div>
            <div className="bg-white border border-gray-200 rounded-sm p-4">
              <div className="text-sm text-gray-600 mb-1">Total URLs</div>
              <div className="text-2xl font-semibold text-gray-900">{stats.totalUrls}</div>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-sm p-4">
              <div className="text-sm text-green-700 mb-1">Unique Domains</div>
              <div className="text-2xl font-semibold text-green-900">{stats.uniqueDomains}</div>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-sm p-4">
              <div className="text-sm text-blue-700 mb-1">Unique LinkedIn</div>
              <div className="text-2xl font-semibold text-blue-900">{stats.uniqueLinkedIn}</div>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-sm p-4">
              <div className="text-sm text-red-700 mb-1">Blocked (Social)</div>
              <div className="text-2xl font-semibold text-red-900">{stats.invalidDomains}</div>
            </div>
            <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-4">
              <div className="text-sm text-yellow-700 mb-1">Empty/Invalid</div>
              <div className="text-2xl font-semibold text-yellow-900">{stats.emptyUrls}</div>
            </div>
          </div>
        )}

        {/* Action Bar — Filter existing + Download */}
        {hasResults && (
          <div className="mb-6 flex flex-wrap items-center gap-3 p-4 bg-gray-50 border border-gray-200 rounded-sm">
            {!filterResult && (
              <button
                onClick={handleFilterExisting}
                disabled={isFiltering}
                className={`px-4 py-2 rounded-sm text-sm font-medium transition-colors ${
                  isFiltering
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-orange-600 text-white hover:bg-orange-700'
                }`}
              >
                {isFiltering ? 'Checking...' : 'Remove existing entries (investors & not-an-investor)'}
              </button>
            )}
            {filterResult && (
              <div className="text-sm text-gray-700 space-y-1">
                <div>
                  Removed <strong>{filterResult.removedDomains}</strong> domain{filterResult.removedDomains !== 1 ? 's' : ''} and{' '}
                  <strong>{filterResult.removedLinkedIn}</strong> LinkedIn URL{filterResult.removedLinkedIn !== 1 ? 's' : ''} total.
                </div>
                {(filterResult.removedDomainsInvestors > 0 || filterResult.removedLinkedInInvestors > 0) && (
                  <div className="text-xs text-gray-500">
                    Investors table: {filterResult.removedDomainsInvestors} domain{filterResult.removedDomainsInvestors !== 1 ? 's' : ''}, {filterResult.removedLinkedInInvestors} LinkedIn
                  </div>
                )}
                {(filterResult.removedDomainsNotInvestor > 0 || filterResult.removedLinkedInNotInvestor > 0) && (
                  <div className="text-xs text-gray-500">
                    Not-an-investor table: {filterResult.removedDomainsNotInvestor} domain{filterResult.removedDomainsNotInvestor !== 1 ? 's' : ''}, {filterResult.removedLinkedInNotInvestor} LinkedIn
                  </div>
                )}
              </div>
            )}
            <div className="flex-1" />
            <button
              onClick={handleDownloadResults}
              className="px-4 py-2 bg-brand-default text-white rounded-sm hover:bg-opacity-90 transition-colors text-sm font-medium"
            >
              Download CSVs
            </button>
          </div>
        )}

        {/* Domains List Section */}
        {extractedDomains.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-sm p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Domains ({extractedDomains.length})</h3>
              <button
                onClick={() => {
                  const rows: CsvRow[] = extractedDomains.map(d => ({ Domain: d }));
                  const csvString = csvToString(['Domain'], rows);
                  downloadCsv(csvString, `unique-domains-${new Date().toISOString().split('T')[0]}.csv`);
                }}
                className="px-4 py-2 bg-brand-default text-white rounded-sm hover:bg-opacity-90 transition-colors text-sm font-medium"
              >
                Download Domains CSV
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto border border-gray-200 rounded-sm">
              <div className="divide-y divide-gray-200">
                {extractedDomains.map((domain, index) => (
                  <div key={index} className="px-4 py-2.5 hover:bg-gray-50 transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-mono text-gray-900">{domain}</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(domain);
                          setToastMessage(`Copied ${domain}`);
                          setShowToast(true);
                        }}
                        className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors"
                        title="Copy to clipboard"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* LinkedIn List Section */}
        {extractedLinkedIn.length > 0 && (
          <div className="bg-white border border-blue-200 rounded-sm p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">LinkedIn URLs ({extractedLinkedIn.length})</h3>
              <button
                onClick={() => {
                  const rows: CsvRow[] = extractedLinkedIn.map(l => ({ LinkedIn: l }));
                  const csvString = csvToString(['LinkedIn'], rows);
                  downloadCsv(csvString, `unique-linkedin-${new Date().toISOString().split('T')[0]}.csv`);
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-sm hover:bg-blue-700 transition-colors text-sm font-medium"
              >
                Download LinkedIn CSV
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto border border-blue-100 rounded-sm">
              <div className="divide-y divide-blue-100">
                {extractedLinkedIn.map((url, index) => (
                  <div key={index} className="px-4 py-2.5 hover:bg-blue-50 transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-mono text-gray-900">{url}</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(url);
                          setToastMessage(`Copied ${url}`);
                          setShowToast(true);
                        }}
                        className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors"
                        title="Copy to clipboard"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Per-file Multi-Column Selector Dialog */}
        {isWizardOpen && currentWizardFile && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6 max-h-[90vh] overflow-y-auto">
              <h2 className="text-2xl font-semibold mb-1">
                Select URL Columns
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                File: <span className="font-medium text-gray-700">{currentWizardFile.name}</span>
                {uploadedFiles.length > 1 && (
                  <span className="ml-2 text-gray-400">
                    ({(wizardFileIdx ?? 0) + 1} of {uploadedFiles.length})
                  </span>
                )}
              </p>
              <p className="text-gray-600 mb-4 text-sm">
                Select one or more columns that contain domains or LinkedIn URLs. All selected columns will be processed.
              </p>

              {/* Search */}
              <div className="mb-4">
                <input
                  type="text"
                  placeholder="Search columns..."
                  value={columnSearch}
                  onChange={(e) => setColumnSearch(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-sm ring-2 ring-brand-default focus:outline-none focus:ring-brand-default"
                  autoFocus
                />
              </div>

              {/* Suggested columns (ones that contain URL-like data) */}
              {wizardUrlColumns.length > 0 && !columnSearch && (
                <div className="mb-3">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    Suggested (contain URLs)
                  </div>
                  <div className="space-y-2">
                    {wizardUrlColumns.map(column => {
                      const isSelected = tempSelectedColumns.includes(column);
                      const previews = getColumnPreview(currentWizardFile.rows, column);
                      return (
                        <button
                          key={`suggested-${column}`}
                          onClick={() => toggleWizardColumn(column)}
                          className={`w-full text-left px-4 py-3 rounded-sm border-2 transition-colors ${
                            isSelected
                              ? 'border-brand-default bg-brand-default bg-opacity-10'
                              : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleWizardColumn(column)}
                              className="w-4 h-4 flex-shrink-0"
                            />
                            <span className="font-medium text-sm">{column}</span>
                          </div>
                          {previews.length > 0 && (
                            <div className="mt-1.5 ml-6 space-y-0.5">
                              {previews.map((url, i) => (
                                <div key={i} className="text-xs text-gray-500 truncate" title={url}>
                                  &bull; {url}
                                </div>
                              ))}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* All columns (or filtered) */}
              <div className="mb-6">
                {(!columnSearch && wizardUrlColumns.length > 0) && (
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    All Columns
                  </div>
                )}
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {filteredWizardColumns
                    .filter(col => columnSearch || !wizardUrlColumns.includes(col))
                    .map(column => {
                      const isSelected = tempSelectedColumns.includes(column);
                      const previews = getColumnPreview(currentWizardFile.rows, column, 2);
                      return (
                        <button
                          key={column}
                          onClick={() => toggleWizardColumn(column)}
                          className={`w-full text-left px-4 py-2.5 rounded-sm border-2 transition-colors ${
                            isSelected
                              ? 'border-brand-default bg-brand-default bg-opacity-10'
                              : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleWizardColumn(column)}
                              className="w-4 h-4 flex-shrink-0"
                            />
                            <span className="font-medium text-sm">{column}</span>
                            {previews.length > 0 && (
                              <span className="text-xs text-gray-400 truncate ml-2">
                                e.g. {previews[0]}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  {filteredWizardColumns.filter(col => columnSearch || !wizardUrlColumns.includes(col)).length === 0 && (
                    <div className="text-center py-4 text-gray-500 text-sm">
                      {columnSearch ? `No columns matching "${columnSearch}"` : 'No additional columns'}
                    </div>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center gap-3 justify-between">
                <span className="text-sm text-gray-500">
                  {tempSelectedColumns.length} column{tempSelectedColumns.length !== 1 ? 's' : ''} selected
                </span>
                <div className="flex gap-3">
                  <button
                    onClick={handleWizardClose}
                    className="px-4 py-2 text-gray-700 border border-gray-300 rounded-sm hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleWizardConfirm}
                    disabled={tempSelectedColumns.length === 0}
                    className={`px-4 py-2 rounded-sm transition-colors ${
                      tempSelectedColumns.length > 0
                        ? 'bg-brand-default text-white hover:bg-opacity-90'
                        : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    }`}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Toast Notification */}
        <Toast
          message={toastMessage}
          isVisible={showToast}
          onClose={() => setShowToast(false)}
          duration={4000}
        />
      </div>
    </div>
  );
}
