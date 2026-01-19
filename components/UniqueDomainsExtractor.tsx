"use client";

import { useState, useRef } from "react";
import { parseCsv, CsvRow, csvToString } from "../lib/csvImport";
import { downloadCsv } from "../lib/csvExport";
import ColumnSelectorDialog from "./ui/ColumnSelectorDialog";
import Toast from "./ui/Toast";

// Utility functions (same as in CompanyResearchHome.tsx)
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

const cleanUrl = (url: string): string | null => {
  if (!url) return null;
  try {
    // Remove any whitespace
    url = url.trim();
    
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    // Parse URL
    const urlObj = new URL(url);
    
    // Extract just the origin (protocol + hostname)
    const hostname = urlObj.hostname;
    return `${urlObj.protocol}//${hostname}`;
  } catch (e) {
    console.error('Error cleaning URL:', e);
    return null;
  }
};

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

interface ExtractionStats {
  totalUrls: number;
  uniqueDomains: number;
  invalidDomains: number;
  emptyUrls: number;
}

export default function UniqueDomainsExtractor() {
  const [csvData, setCsvData] = useState<{ headers: string[]; rows: CsvRow[] } | null>(null);
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  const [selectedUrlColumn, setSelectedUrlColumn] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [extractedDomains, setExtractedDomains] = useState<string[]>([]);
  const [stats, setStats] = useState<ExtractionStats | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setSelectedUrlColumn(null);
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

  // Extract unique domains from CSV
  const extractUniqueDomains = () => {
    if (!csvData || !selectedUrlColumn) return;

    setIsProcessing(true);

    try {
      const uniqueDomains = new Set<string>();
      let totalUrls = 0;
      let invalidDomains = 0;
      let emptyUrls = 0;
      
      // Process all rows
      csvData.rows.forEach(row => {
        const url = row[selectedUrlColumn]?.trim() || '';
        totalUrls++;
        
        if (!url || !url.includes('.')) {
          emptyUrls++;
          return;
        }

        // Clean URL
        const cleanedUrl = cleanUrl(url);
        if (!cleanedUrl) {
          emptyUrls++;
          return;
        }

        // Extract domain
        const domain = extractDomain(cleanedUrl);
        if (!domain) {
          emptyUrls++;
          return;
        }

        // Check if domain is invalid
        if (INVALID_DOMAINS.some(invalidDomain => domain.toLowerCase().includes(invalidDomain.toLowerCase()))) {
          invalidDomains++;
          return;
        }

        // Add to set (automatically handles uniqueness)
        uniqueDomains.add(domain);
      });

      // Convert to array and sort
      const domainsArray = Array.from(uniqueDomains).sort();

      // Update stats
      setStats({
        totalUrls,
        uniqueDomains: domainsArray.length,
        invalidDomains,
        emptyUrls
      });

      // Store extracted domains for display
      setExtractedDomains(domainsArray);

      // Create CSV with single column
      const headers = ['Domain'];
      const rows: CsvRow[] = domainsArray.map(domain => ({ Domain: domain }));

      // Generate CSV string and download
      const csvString = csvToString(headers, rows);
      downloadCsv(csvString, `unique-domains-${new Date().toISOString().split('T')[0]}.csv`);

      setToastMessage(`Successfully extracted ${domainsArray.length} unique domains`);
      setShowToast(true);

      // Reset CSV data state (but keep extracted domains and stats)
      setCsvData(null);
      setSelectedUrlColumn(null);
    } catch (error) {
      console.error('Error extracting domains:', error);
      setToastMessage('Failed to extract domains. Please try again.');
      setShowToast(true);
    } finally {
      setIsProcessing(false);
    }
  };

  // Clear all results
  const handleClearResults = () => {
    setExtractedDomains([]);
    setStats(null);
    setCsvData(null);
    setSelectedUrlColumn(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-semibold">Extract Unique Domains from CSV</h2>
          {extractedDomains.length > 0 && (
            <button
              onClick={handleClearResults}
              className="px-4 py-2 bg-red-600 text-white rounded-sm hover:bg-red-700 transition-colors font-medium text-sm"
            >
              Clear Results
            </button>
          )}
        </div>
        <p className="text-gray-600 mb-6">
          Upload a CSV file and select the column containing URLs. This tool will extract all unique domains, 
          excluding social media platforms and invalid domains.
        </p>

        <div className="border-2 border-dashed border-gray-300 rounded-sm p-6 bg-gray-50 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold mb-1">Upload CSV File</h3>
              <p className="text-sm text-gray-600">
                Select a CSV file containing URLs in one of its columns.
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleCsvUpload}
              className="hidden"
              id="csv-upload-domains"
            />
            <label
              htmlFor="csv-upload-domains"
              className="px-4 py-2 bg-brand-default text-white rounded-sm cursor-pointer hover:bg-opacity-90 transition-colors"
            >
              Choose CSV File
            </label>
          </div>
        </div>

        {isProcessing && (
          <div className="mb-6 p-3 bg-blue-50 text-blue-700 rounded-sm flex items-center gap-2">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-700"></div>
            <span>Extracting unique domains...</span>
          </div>
        )}

        {/* Stats Section */}
        {stats && (
          <div className="mb-6 grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white border border-gray-200 rounded-sm p-4">
              <div className="text-sm text-gray-600 mb-1">Total URLs</div>
              <div className="text-2xl font-semibold text-gray-900">{stats.totalUrls}</div>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-sm p-4">
              <div className="text-sm text-green-700 mb-1">Unique Domains</div>
              <div className="text-2xl font-semibold text-green-900">{stats.uniqueDomains}</div>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-sm p-4">
              <div className="text-sm text-red-700 mb-1">Invalid Domains</div>
              <div className="text-2xl font-semibold text-red-900">{stats.invalidDomains}</div>
            </div>
            <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-4">
              <div className="text-sm text-yellow-700 mb-1">Empty/Invalid URLs</div>
              <div className="text-2xl font-semibold text-yellow-900">{stats.emptyUrls}</div>
            </div>
          </div>
        )}

        {/* Domains List Section */}
        {extractedDomains.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-sm p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Extracted Domains ({extractedDomains.length})</h3>
              <button
                onClick={() => {
                  const headers = ['Domain'];
                  const rows: CsvRow[] = extractedDomains.map(domain => ({ Domain: domain }));
                  const csvString = csvToString(headers, rows);
                  downloadCsv(csvString, `unique-domains-${new Date().toISOString().split('T')[0]}.csv`);
                }}
                className="px-4 py-2 bg-brand-default text-white rounded-sm hover:bg-opacity-90 transition-colors text-sm font-medium"
              >
                Download CSV
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto border border-gray-200 rounded-sm">
              <div className="divide-y divide-gray-200">
                {extractedDomains.map((domain, index) => (
                  <div
                    key={index}
                    className="px-4 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-mono text-gray-900">{domain}</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(domain);
                          setToastMessage(`Copied ${domain} to clipboard`);
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

        {/* Column Selector Dialog */}
        <ColumnSelectorDialog
          isOpen={showColumnSelector}
          columns={csvData?.headers || []}
          rows={csvData?.rows || []}
          selectedColumn={selectedUrlColumn}
          mode="domain"
          onSelectColumn={(column) => {
            setSelectedUrlColumn(column);
          }}
          onConfirm={() => {
            if (selectedUrlColumn) {
              // Close dialog immediately
              setShowColumnSelector(false);
              // Process extraction
              extractUniqueDomains();
            }
          }}
          onClose={() => {
            setShowColumnSelector(false);
            setCsvData(null);
            setSelectedUrlColumn(null);
          }}
        />

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
