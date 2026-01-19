// CompanyResearchHome.tsx

"use client";
import { useState, FormEvent, useCallback, useMemo, useRef, useEffect } from "react";
import QualificationDisplay from './qualification/QualificationDisplay';
import InstagramProfileDisplay from './qualification/InstagramProfileDisplay';
import Image from "next/image";
import { fetchCompanyMap, fetchInstagramProfile, sendSlackNotification } from "../lib/api";
import ExportCsvButton from './ui/ExportCsvButton';
import ColumnSelectorDialog from './ui/ColumnSelectorDialog';
import ConfirmationModal from './ui/ConfirmationModal';
import ResumeDialog from './ui/ResumeDialog';
import { parseCsv, csvToString, mergeQualificationData, ensureColumnsExist, CsvRow } from "../lib/csvImport";
import { downloadCsv } from "../lib/csvExport";
import { saveCsvProgress, loadCsvProgress, clearCsvProgress, hasCsvProgress, serializeQualificationDataMap, deserializeQualificationDataMap, shouldAutoSave, CsvProgressState } from "../lib/csvProgress";
import { useCompanies } from "@/contexts/CompaniesContext";
import { useOwner } from "@/contexts/OwnerContext";
import { extractUsernameFromUrl } from "../utils/instagramApi";

// Interface for qualification data
interface QualificationData {
  company_summary: string;
  company_industry: string;
  sales_opener_sentence: string;
  classification: 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE' | 'EXPIRED';
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
// For Instagram mode, preserves the full URL including username path
const cleanUrl = (url: string, mode: 'domain' | 'instagram' = 'domain'): string | null => {
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
    
    // For Instagram mode, preserve the full URL including username path
    if (mode === 'instagram' && urlObj.hostname.includes('instagram.com')) {
      // Return the full URL with pathname (username), but remove query params and hash
      return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`;
    }
    
    // For domain mode, extract just the origin (protocol + hostname)
    const hostname = urlObj.hostname;
    return `${urlObj.protocol}//${hostname}`;
  } catch (e) {
    console.error('Error cleaning URL:', e);
    return null;
  }
};

export default function CompanyResearcher() {
  // Companies context for saving summaries
  const { companies, createCompany, updateCompany } = useCompanies();
  // Owner context for selected owner
  const { selectedOwner } = useOwner();
  
  // Research mode: 'domain' or 'instagram'
  const [researchMode, setResearchMode] = useState<'domain' | 'instagram'>('domain');
  
  // Company input and state
  const [rawCompanyInput, setRawCompanyInput] = useState('');
  const [submittedCompanies, setSubmittedCompanies] = useState<string[]>([]);
  const [activeCompany, setActiveCompany] = useState<string>('');
  const [isSearching, setIsSearching] = useState(false);
  
  // Results and errors by company
  const [resultsByCompany, setResultsByCompany] = useState<{
    [company: string]: {
      qualificationData: QualificationData | null;
      instagramProfileData: any | null;
      instagramQualificationData: {
        profile_summary: string;
        profile_industry: string;
        sales_opener_sentence: string;
        classification: 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE' | 'EXPIRED';
        confidence_score?: number; // Optional
        product_types: string[] | null;
        sales_action: 'OUTREACH' | 'EXCLUDE' | 'PARTNERSHIP' | 'MANUAL_REVIEW';
      } | null;
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
  const [hasSavedProgress, setHasSavedProgress] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvDataRef = useRef<{ headers: string[]; rows: CsvRow[] } | null>(null);
  
  // Helper to get current company data
  const getCurrentCompanyData = useCallback((company: string) => {
    return resultsByCompany[company] || {
      qualificationData: null,
      instagramProfileData: null,
      instagramQualificationData: null
    };
  }, [resultsByCompany]); 

  // Get data for active company
  const { qualificationData, instagramProfileData, instagramQualificationData } = activeCompany ? getCurrentCompanyData(activeCompany) : getCurrentCompanyData('');

  // Prepare companies data for CSV export
  const companiesForExport = useMemo(() => {
    return submittedCompanies.map(company => ({
      companyName: company,
      data: {
        qualificationData: resultsByCompany[company]?.qualificationData || resultsByCompany[company]?.instagramQualificationData || null
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

  // Function to check if text contains an Instagram URL
  const containsInstagramUrl = useCallback((text: string): boolean => {
    if (!text || typeof text !== 'string') return false;
    // Check for Instagram URLs - simplified pattern that matches instagram.com/username
    // This will match any format: with/without protocol, with/without www, with/without trailing slash
    const instagramPattern = /instagram\.com\/[\w.]+/i;
    return instagramPattern.test(text);
  }, []);

  // Parse company input into array of company names 
  const parseCompanyInput = useCallback((input: string): string[] => {
    return input
      .split(/[,\n]/) // Split by comma or newline
      .map(company => company.trim())
      .filter(company => company.length > 0) // Remove empty entries
      .map(company => {
        // Clean URL to base domain (or preserve full URL for Instagram mode)
        const cleaned = cleanUrl(company, researchMode);
        return cleaned || company; // Fallback to original if cleaning fails
      })
      .filter((company, index, self) => 
        index === self.findIndex(c => c.toLowerCase() === company.toLowerCase()) // Deduplicate case-insensitive
      );
  }, [researchMode]);

  // Research a single company
  const researchCompany = useCallback(async (company: string) => {
    if (researchMode === 'instagram') {
      // Instagram research mode
      if (!company.includes('instagram.com')) {
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: { form: `Invalid Instagram URL: ${company}. Please provide an Instagram URL (instagram.com/username)` }
        }));
        return;
      }

      // Initialize company data and clear previous errors
      setResultsByCompany(prev => ({
        ...prev,
        [company]: {
          qualificationData: null,
          instagramProfileData: null,
          instagramQualificationData: null
        }
      }));
      
      setErrorsByCompany(prev => ({
        ...prev,
        [company]: {}
      }));

      try {
        let instagramProfileData = null;
        
        try {
          instagramProfileData = await fetchInstagramProfile(company);
          if (!instagramProfileData) {
            setErrorsByCompany(prev => ({
              ...prev,
              [company]: {
                ...prev[company],
                instagramProfileData: 'Could not load Instagram profile data.'
              }
            }));
          }
        } catch (error) {
          console.error('Error fetching Instagram profile:', error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: {
              ...prev[company],
              instagramProfileData: 'Could not load Instagram profile data.'
            }
          }));
          
          sendSlackNotification(`❌ Unexpected error for ${company}\nError: ${errorMessage}`).catch(
            (slackError) => console.error('Failed to send Slack notification:', slackError)
          );
        }

        // Extract qualification data from profile response if present
        const instagramQualificationData = instagramProfileData?.qualificationData || null;
        // Remove qualificationData from profile data to keep it separate
        const { qualificationData: _, ...profileDataWithoutQualification } = instagramProfileData || {};
        
        console.log(`[CompanyResearchHome] Instagram profile data for ${company}:`, {
          hasProfileData: !!profileDataWithoutQualification,
          hasQualificationData: !!instagramQualificationData,
          qualificationClassification: instagramQualificationData?.classification
        });
        
        setResultsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            ...(profileDataWithoutQualification && { instagramProfileData: profileDataWithoutQualification }),
            ...(instagramQualificationData && { instagramQualificationData: instagramQualificationData })
          }
        }));

        // Save/update company in database after summary is generated
        if (instagramQualificationData) {
          try {
            const username = extractUsernameFromUrl(company);
            if (username) {
              // Check if company exists with this instagram username
              const existingCompany = companies.find(c => c.instagram === username);
              
              // Extract email and phone from qualification data
              const email = instagramQualificationData.email || null;
              const phone = instagramQualificationData.phone || null;
              
              if (existingCompany) {
                // Update existing company
                await updateCompany(existingCompany.id, {
                  summary: instagramQualificationData,
                  domain: existingCompany.domain || '', // Keep existing domain if any
                  email: email || existingCompany.email || '',
                  phone: phone || existingCompany.phone || '',
                  owner: selectedOwner,
                });
              } else {
                // Create new company
                await createCompany({
                  domain: '',
                  instagram: username,
                  summary: instagramQualificationData,
                  email: email || '',
                  phone: phone || '',
                  set_name: null,
                  owner: selectedOwner,
                });
              }
            }
          } catch (saveError) {
            console.error('Error saving company to database:', saveError);
            // Don't fail the whole operation if save fails
          }
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            general: errorMessage
          }
        }));
        
        sendSlackNotification(`❌ General error for ${company}\nError: ${errorMessage}`).catch(
          (slackError) => console.error('Failed to send Slack notification:', slackError)
        );
      }
    } else {
      // Domain research mode (existing logic)
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
          qualificationData: null,
          instagramProfileData: null,
          instagramQualificationData: null
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
          // If fetchCompanyMap returns null, it means there was an error
          // (error notification already sent from fetchCompanyMap)
          if (!qualificationData) {
            setErrorsByCompany(prev => ({
              ...prev,
              [company]: {
                ...prev[company],
                qualificationData: 'Could not load qualification data.'
              }
            }));
          }
        } catch (error) {
          console.error('Error fetching company qualification:', error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: {
              ...prev[company],
              qualificationData: 'Could not load qualification data.'
            }
          }));
          
          // Send Slack notification for unexpected errors
          sendSlackNotification(`❌ Unexpected error for ${company}\nError: ${errorMessage}`).catch(
            (slackError) => console.error('Failed to send Slack notification:', slackError)
          );
        }

        // Update results with qualification data
        setResultsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            ...(qualificationData && { qualificationData: qualificationData })
          }
        }));

        // Save/update company in database after summary is generated
        if (qualificationData) {
          try {
            // Check if company exists with this domain
            const existingCompany = companies.find(c => c.domain === domainName);
            
            // Extract email and phone from qualification data
            const email = qualificationData.email || null;
            const phone = qualificationData.phone || null;
            
            if (existingCompany) {
              // Update existing company
              await updateCompany(existingCompany.id, {
                summary: qualificationData,
                instagram: existingCompany.instagram || '', // Keep existing instagram if any
                email: email || existingCompany.email || '',
                phone: phone || existingCompany.phone || '',
                owner: selectedOwner,
              });
            } else {
              // Create new company
              await createCompany({
                domain: domainName,
                instagram: '',
                summary: qualificationData,
                email: email || '',
                phone: phone || '',
                set_name: null,
                owner: selectedOwner,
              });
            }
          } catch (saveError) {
            console.error('Error saving company to database:', saveError);
            // Don't fail the whole operation if save fails
          }
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            general: errorMessage
          }
        }));
        
        // Send Slack notification for general errors
        sendSlackNotification(`❌ General error for ${company}\nError: ${errorMessage}`).catch(
          (slackError) => console.error('Failed to send Slack notification:', slackError)
        );
      }
    }
  }, [researchMode, companies, createCompany, updateCompany, selectedOwner]);

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

  // Check for saved progress on mount and when CSV data changes
  useEffect(() => {
    if (csvData && selectedUrlColumn) {
      const saved = hasCsvProgress();
      setHasSavedProgress(saved);
    } else {
      setHasSavedProgress(false);
    }
  }, [csvData, selectedUrlColumn]);

  // Process CSV rows with progress saving
  const processCsvRows = useCallback(async (resumeFromSaved: boolean = false) => {
    if (!csvData || !selectedUrlColumn) return;

    // Helper function to check if URL is Instagram URL
    const isInstagramUrl = (url: string): boolean => {
      if (!url || typeof url !== 'string') return false;
      return url.toLowerCase().includes('instagram.com');
    };

    setIsProcessingCsv(true);
    
    // Use a ref to track current CSV data during processing
    csvDataRef.current = csvData;
    
    // Try to load saved progress if resuming
    let savedProgress: CsvProgressState | null = null;
    let startFromIndex = 0;
    let qualificationDataMap = new Map<string, any>();
    let errorMap = new Map<string, string>();
    let processedDomainIndices: number[] = [];
    let uniqueDomainsArray: string[] = [];
    let lastSavedAt: number | null = null;

    if (resumeFromSaved) {
      savedProgress = loadCsvProgress();
      if (savedProgress && savedProgress.selectedUrlColumn === selectedUrlColumn) {
        // Validate that headers match and row count matches
        const headersMatch = JSON.stringify(savedProgress.headers) === JSON.stringify(csvData.headers);
        if (headersMatch && savedProgress.rows.length === csvData.rows.length) {
          // Resume from saved progress
          qualificationDataMap = deserializeQualificationDataMap(savedProgress.qualificationDataMap);
          errorMap = new Map(Object.entries(savedProgress.errorMap || {}));
          processedDomainIndices = savedProgress.processedDomainIndices || [];
          uniqueDomainsArray = savedProgress.uniqueDomains || [];
          startFromIndex = savedProgress.currentDomainIndex || 0;
          lastSavedAt = savedProgress.lastSavedAt;
          
          // Merge saved progress into current CSV data (preserve any new data in current CSV)
          const mergedRows = csvData.rows.map((row, index) => {
            const savedRow = savedProgress!.rows[index];
            if (savedRow && savedRow['Research Status']) {
              // Use saved row if it has been processed
              return savedRow;
            }
            return row;
          });
          
          const mergedCsvData = { headers: csvData.headers, rows: mergedRows };
          setCsvData(mergedCsvData);
          csvDataRef.current = mergedCsvData;
        } else {
          // Data structure changed, can't resume
          clearCsvProgress();
          savedProgress = null;
        }
      } else {
        savedProgress = null;
      }
    }

    // Collect all valid URLs from CSV for display in textarea
    const allValidUrls: string[] = [];
    csvData.rows.forEach(row => {
      const url = row[selectedUrlColumn]?.trim() || '';
      if (researchMode === 'instagram') {
        if (url && isInstagramUrl(url)) {
          allValidUrls.push(url);
        }
      } else {
        if (url && url.includes('.')) {
          const cleaned = cleanUrl(url, researchMode);
          if (cleaned) {
            allValidUrls.push(cleaned);
          }
        }
      }
    });

    // If not resuming or resume failed, start fresh
    if (!savedProgress) {
      setCsvProcessingProgress({ current: 0, total: csvData.rows.length });
      lastSavedAt = null;
    } else {
      setCsvProcessingProgress({ current: startFromIndex, total: uniqueDomainsArray.length });
    }

    // Filter rows based on mode
    const rowsToProcess = csvData.rows.filter((row, index) => {
      const url = row[selectedUrlColumn]?.trim() || '';
      
      if (researchMode === 'instagram') {
        // Instagram mode: only include Instagram URLs
        if (!url || !isInstagramUrl(url)) {
          return false;
        }
      } else {
        // Domain mode: existing logic
        const classification = row['Classification']?.trim() || '';
        
        // Skip if Classification is already filled
        if (classification) {
          return false;
        }
        
        // Skip if no valid URL
        if (!url || !url.includes('.')) {
          return false;
        }
      }
      
      return true;
    });

    if (researchMode === 'instagram') {
      // Instagram mode processing
      // Extract unique Instagram URLs - only if not resuming
      if (!savedProgress) {
        const uniqueUrls = new Set<string>();
        
        rowsToProcess.forEach(row => {
          const url = row[selectedUrlColumn]?.trim() || '';
          if (url && isInstagramUrl(url)) {
            uniqueUrls.add(url);
          }
        });

        uniqueDomainsArray = Array.from(uniqueUrls);
      }

      // Fetch Instagram profile data for all unique URLs (starting from saved index if resuming)
      for (let i = startFromIndex; i < uniqueDomainsArray.length; i++) {
        const instagramUrl = uniqueDomainsArray[i];
        setCsvProcessingProgress({ current: i + 1, total: uniqueDomainsArray.length });
        
        try {
          const data = await fetchInstagramProfile(instagramUrl);
          if (data) {
            qualificationDataMap.set(instagramUrl, data); // Reusing map for Instagram profiles
            
            // Save/update company in database after summary is generated
            if (data.qualificationData) {
              try {
                const username = extractUsernameFromUrl(instagramUrl);
                if (username) {
                  // Check if company exists with this instagram username
                  const existingCompany = companies.find(c => c.instagram === username);
                  
                  if (existingCompany) {
                    // Update existing company
                    await updateCompany(existingCompany.id, {
                      summary: data.qualificationData,
                      domain: existingCompany.domain || '', // Keep existing domain if any
                      owner: selectedOwner,
                    });
                  } else {
                    // Create new company
                    await createCompany({
                      domain: '',
                      instagram: username,
                      summary: data.qualificationData,
                      email: '',
                      phone: '',
                      set_name: null,
                      owner: selectedOwner,
                    });
                  }
                }
              } catch (saveError) {
                console.error('Error saving company to database during CSV processing:', saveError);
                // Don't fail the whole operation if save fails
              }
            }
          } else {
            errorMap.set(instagramUrl, 'Failed to fetch Instagram profile data');
          }
        } catch (error) {
          console.error(`Error fetching Instagram profile for ${instagramUrl}:`, error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          errorMap.set(instagramUrl, errorMessage);
          
          sendSlackNotification(`❌ CSV Processing Error for ${instagramUrl}\nError: ${errorMessage}`).catch(
            (slackError) => console.error('Failed to send Slack notification:', slackError)
          );
        }

        processedDomainIndices.push(i);
        
        // Auto-save progress periodically (inside loop to save after each item)
        const processedCountInstagram = processedDomainIndices.length;
        if (shouldAutoSave(lastSavedAt, processedCountInstagram)) {
          // Merge Instagram data into rows for saving
          // Use ref to get latest CSV data
          const currentCsvDataInstagram: { headers: string[]; rows: CsvRow[] } = csvDataRef.current || csvData;
          const currentRowsInstagram = currentCsvDataInstagram.rows.map((row: CsvRow) => {
            const url = row[selectedUrlColumn]?.trim() || '';
            const updatedRow = { ...row };
            
            if (!url || !isInstagramUrl(url)) {
              if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
                updatedRow['Research Status'] = 'skipped (not Instagram URL)';
              }
              return updatedRow;
            }

            const profileData = qualificationDataMap.get(url);
            if (profileData && !('error' in profileData)) {
              updatedRow['Research Status'] = 'completed';
              updatedRow['Instagram Username'] = profileData.username || '';
              updatedRow['Instagram Full Name'] = profileData.full_name || '';
              updatedRow['Instagram Bio'] = profileData.biography || '';
              updatedRow['Instagram Posts'] = String(profileData.edge_owner_to_timeline_media?.count || 0);
              updatedRow['Instagram Followers'] = String(profileData.edge_followed_by?.count || 0);
              updatedRow['Instagram Following'] = String(profileData.edge_follow?.count || 0);
              updatedRow['Instagram Private'] = profileData.is_private ? 'Yes' : 'No';
              
              // Add qualification data if present
              if (profileData.qualificationData) {
                const qual = profileData.qualificationData;
                updatedRow['Company Summary'] = qual.profile_summary || '';
                updatedRow['Company Industry'] = qual.profile_industry || '';
                updatedRow['Sales Opener Sentence'] = qual.sales_opener_sentence || '';
                updatedRow['Classification'] = qual.classification || '';
                // Only add confidence score if it exists
                if (qual.confidence_score !== undefined) {
                  updatedRow['Confidence Score'] = String(qual.confidence_score);
                }
                updatedRow['Sales Action'] = qual.sales_action || '';
                
                // Handle product types (can be 1 or more items)
                if (qual.product_types && Array.isArray(qual.product_types) && qual.product_types.length > 0) {
                  const productTypes = qual.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
            } else {
              const error = errorMap.get(url);
              updatedRow['Research Status'] = error || 'Failed to fetch Instagram profile data';
            }
            
            return updatedRow;
          });

          // Save progress
          const progressStateInstagram: CsvProgressState = {
            headers: currentCsvDataInstagram.headers,
            rows: currentRowsInstagram,
            selectedUrlColumn,
            processedDomainIndices: [...processedDomainIndices],
            uniqueDomains: uniqueDomainsArray,
            qualificationDataMap: serializeQualificationDataMap(qualificationDataMap),
            errorMap: Object.fromEntries(errorMap),
            lastSavedAt: Date.now(),
            totalDomains: uniqueDomainsArray.length,
            currentDomainIndex: processedDomainIndices.length
          };
          
          saveCsvProgress(progressStateInstagram);
          lastSavedAt = Date.now();
          
          // Update CSV data state with current progress
          const updatedCsvDataInstagram: { headers: string[]; rows: CsvRow[] } = { headers: currentCsvDataInstagram.headers, rows: currentRowsInstagram };
          setCsvData(updatedCsvDataInstagram);
          csvDataRef.current = updatedCsvDataInstagram;
        }
      }
    } else {
      // Domain mode processing (existing logic)
      // Extract unique domains from URLs (clean URLs first) - only if not resuming
      if (!savedProgress) {
        const urlToDomainMap = new Map<string, string>();
        const uniqueDomains = new Set<string>();
        
        rowsToProcess.forEach(row => {
          const url = row[selectedUrlColumn]?.trim() || '';
          if (url) {
            // Clean URL first
            const cleanedUrl = cleanUrl(url, researchMode);
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

        uniqueDomainsArray = Array.from(uniqueDomains);
      }

      // Fetch qualification data for all unique domains (starting from saved index if resuming)
      for (let i = startFromIndex; i < uniqueDomainsArray.length; i++) {
        const domainName = uniqueDomainsArray[i];
        setCsvProcessingProgress({ current: i + 1, total: uniqueDomainsArray.length });
        
        try {
          const data = await fetchCompanyMap(domainName);
          if (data) {
            qualificationDataMap.set(domainName, data);
            
            // Save/update company in database after summary is generated
            try {
              // Check if company exists with this domain
              const existingCompany = companies.find(c => c.domain === domainName);
              
              // Extract email and phone from qualification data
              const email = data.email || null;
              const phone = data.phone || null;
              
              if (existingCompany) {
                // Update existing company
                await updateCompany(existingCompany.id, {
                  summary: data,
                  instagram: existingCompany.instagram || '', // Keep existing instagram if any
                  email: email || existingCompany.email || '',
                  phone: phone || existingCompany.phone || '',
                  owner: selectedOwner,
                });
              } else {
                // Create new company
                await createCompany({
                  domain: domainName,
                  instagram: '',
                  summary: data,
                  email: email || '',
                  phone: phone || '',
                  set_name: null,
                  owner: selectedOwner,
                });
              }
            } catch (saveError) {
              console.error('Error saving company to database during CSV processing:', saveError);
              // Don't fail the whole operation if save fails
            }
          } else {
            // Data fetch returned null, indicating an error
            // (error notification already sent from fetchCompanyMap)
            errorMap.set(domainName, 'Failed to fetch company qualification data');
          }
        } catch (error) {
          console.error(`Error fetching data for ${domainName}:`, error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          errorMap.set(domainName, errorMessage);
          
          // Send Slack notification for CSV processing errors
          sendSlackNotification(`❌ CSV Processing Error for ${domainName}\nError: ${errorMessage}`).catch(
            (slackError) => console.error('Failed to send Slack notification:', slackError)
          );
        }

        // Update processed indices
        processedDomainIndices.push(i);
        
        // Auto-save progress periodically (inside loop to save after each item)
        const processedCount = processedDomainIndices.length;
        if (shouldAutoSave(lastSavedAt, processedCount)) {
          // Merge data into rows for saving
          // Use ref to get latest CSV data
          const currentCsvData: { headers: string[]; rows: CsvRow[] } = csvDataRef.current || csvData;
          const currentRows = currentCsvData.rows.map((row: CsvRow) => {
            const url = row[selectedUrlColumn]?.trim() || '';
            const updatedRow = { ...row };
            
            // Domain mode auto-save logic (inside domain mode loop)
            const classification = row['Classification']?.trim() || '';
            
            // Skip if Classification is already filled
            if (classification) {
              if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
                updatedRow['Research Status'] = 'skipped (already classified)';
              }
              return updatedRow;
            }
            
            // Skip if no valid URL
            if (!url || !url.includes('.')) {
              if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
                updatedRow['Research Status'] = 'skipped (invalid URL)';
              }
              return updatedRow;
            }

            const cleanedUrl = cleanUrl(url, researchMode);
            const domainName = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
            const qualificationData = domainName ? qualificationDataMap.get(domainName) : null;

            if (qualificationData) {
              updatedRow['Research Status'] = 'completed';
              updatedRow['Company Summary'] = qualificationData.company_summary || updatedRow['Company Summary'] || '';
              updatedRow['Company Industry'] = qualificationData.company_industry || updatedRow['Company Industry'] || '';
              updatedRow['Sales Opener Sentence'] = qualificationData.sales_opener_sentence || updatedRow['Sales Opener Sentence'] || '';
              updatedRow['Classification'] = qualificationData.classification || updatedRow['Classification'] || '';
              updatedRow['Confidence Score'] = String((qualificationData.confidence_score ?? updatedRow['Confidence Score']) || '');
              
              if (qualificationData.product_types && Array.isArray(qualificationData.product_types)) {
                const productTypes = qualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
                if (productTypes.length > 0) {
                  if (productTypes.length === 1) {
                    updatedRow['Product Types'] = productTypes[0];
                  } else if (productTypes.length === 2) {
                    updatedRow['Product Types'] = `${productTypes[0]} and ${productTypes[1]}`;
                  } else {
                    const allButLast = productTypes.slice(0, -1).join(', ');
                    updatedRow['Product Types'] = `${allButLast}, and ${productTypes[productTypes.length - 1]}`;
                  }
                  
                  productTypes.forEach((pt: string, index: number) => {
                    updatedRow[`PRODUCT${index + 1}`] = pt;
                  });
                }
              }
              
              updatedRow['Sales Action'] = qualificationData.sales_action || updatedRow['Sales Action'] || '';
            } else if (domainName) {
              const error = errorMap.get(domainName);
              updatedRow['Research Status'] = error || 'Failed to fetch company qualification data';
            } else {
              updatedRow['Research Status'] = 'Invalid URL';
            }
          
          return updatedRow;
        });

        // Save progress
        const progressState: CsvProgressState = {
          headers: currentCsvData.headers,
          rows: currentRows,
          selectedUrlColumn,
          processedDomainIndices: [...processedDomainIndices],
          uniqueDomains: uniqueDomainsArray,
          qualificationDataMap: serializeQualificationDataMap(qualificationDataMap),
          errorMap: Object.fromEntries(errorMap),
          lastSavedAt: Date.now(),
          totalDomains: uniqueDomainsArray.length,
          currentDomainIndex: processedDomainIndices.length
        };
        
        saveCsvProgress(progressState);
        lastSavedAt = Date.now();
        
        // Update CSV data state with current progress
        const updatedCsvData: { headers: string[]; rows: CsvRow[] } = { headers: currentCsvData.headers, rows: currentRows };
        setCsvData(updatedCsvData);
        csvDataRef.current = updatedCsvData;
        }
      }
    }

    // Merge data into CSV rows
    const updatedRows = csvData.rows.map(row => {
      const url = row[selectedUrlColumn]?.trim() || '';
      const updatedRow = { ...row };
      
      if (researchMode === 'instagram') {
        // Instagram mode: update with Instagram profile data
        if (!url || !isInstagramUrl(url)) {
          if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
            updatedRow['Research Status'] = 'skipped (not Instagram URL)';
          }
          return updatedRow;
        }

        const profileData = qualificationDataMap.get(url);

        if (profileData && !('error' in profileData)) {
          updatedRow['Research Status'] = 'completed';
          updatedRow['Instagram Username'] = profileData.username || '';
          updatedRow['Instagram Full Name'] = profileData.full_name || '';
          updatedRow['Instagram Bio'] = profileData.biography || '';
          updatedRow['Instagram Posts'] = String(profileData.edge_owner_to_timeline_media?.count || 0);
          updatedRow['Instagram Followers'] = String(profileData.edge_followed_by?.count || 0);
          updatedRow['Instagram Following'] = String(profileData.edge_follow?.count || 0);
          updatedRow['Instagram Private'] = profileData.is_private ? 'Yes' : 'No';
        } else {
          const error = errorMap.get(url);
          updatedRow['Research Status'] = error || 'Failed to fetch Instagram profile data';
        }
      } else {
        // Domain mode: existing logic
        const classification = row['Classification']?.trim() || '';
        
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
        const cleanedUrl = cleanUrl(url, researchMode);
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
    
    // Clear saved progress since processing is complete
    clearCsvProgress();
    setHasSavedProgress(false);
    
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
    
    // Store results for display (only for processed URLs that have data)
    const newResults: typeof resultsByCompany = {};
    rowsToProcess.forEach(row => {
      const url = row[selectedUrlColumn]?.trim() || '';
      if (url) {
        if (researchMode === 'instagram') {
          const profileData = qualificationDataMap.get(url);
          if (profileData && !('error' in profileData)) {
            // Extract qualification data from profile response if present
            const instagramQualificationData = profileData.qualificationData || null;
            // Remove qualificationData from profile data to keep it separate
            const { qualificationData: _, ...profileDataWithoutQualification } = profileData || {};
            
            newResults[url] = {
              qualificationData: null,
              instagramProfileData: profileDataWithoutQualification,
              instagramQualificationData: instagramQualificationData
            };
          }
        } else {
          const cleanedUrl = cleanUrl(url, researchMode);
          const domainName = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
          const qualificationData = domainName ? qualificationDataMap.get(domainName) : null;
          if (qualificationData) {
            // Use cleaned URL as key for display
            const displayUrl = cleanedUrl || url;
            newResults[displayUrl] = {
              qualificationData: qualificationData,
              instagramProfileData: null,
              instagramQualificationData: null
            };
          }
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
  }, [csvData, selectedUrlColumn, rawCompanyInput, activeCompany, parseCompanyInput, researchMode, companies, createCompany, updateCompany, selectedOwner]);

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
    clearCsvProgress();
    setHasSavedProgress(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Download partial progress
  const handleDownloadPartialProgress = useCallback(() => {
    const savedProgress = loadCsvProgress();
    if (!savedProgress) return;

    // Ensure all required columns exist
    const updatedHeaders = ensureColumnsExist(savedProgress.headers);
    
    // Add PRODUCT columns if needed
    const maxProductTypes = savedProgress.rows.reduce((max, row) => {
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

    const csvString = csvToString(finalHeaders, savedProgress.rows);
    downloadCsv(csvString, `partial-progress-${new Date().toISOString().split('T')[0]}.csv`);
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
            qualificationData: null,
            instagramProfileData: null,
            instagramQualificationData: null
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

      {/* Mode Selector */}
      <div className="mb-8 opacity-0 animate-fade-up [animation-delay:400ms]">
        <div className="flex gap-4">
          <button
            onClick={() => {
              setResearchMode('domain');
              handleClearAll();
            }}
            className={`px-6 py-3 rounded-sm font-medium transition-colors ${
              researchMode === 'domain'
                ? 'bg-brand-default text-white ring-2 ring-brand-default'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Domain Research
          </button>
          <button
            onClick={() => {
              setResearchMode('instagram');
              handleClearAll();
            }}
            className={`px-6 py-3 rounded-sm font-medium transition-colors ${
              researchMode === 'instagram'
                ? 'bg-brand-default text-white ring-2 ring-brand-default'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Instagram Research
          </button>
        </div>
      </div>

      <p className="text-black mb-12 opacity-0 animate-fade-up [animation-delay:400ms]">
        {researchMode === 'instagram' 
          ? 'Enter Instagram URLs (comma or newline separated) for profile research, or upload a CSV file with Instagram columns.'
          : 'Enter company URLs (comma or newline separated) for qualification assessment, or upload a CSV file.'}
      </p>

      {/* CSV Import Section */}
      <div className="mb-8 opacity-0 animate-fade-up [animation-delay:500ms]">
        <div className="border-2 border-dashed border-gray-300 rounded-sm p-6 bg-gray-50">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold mb-1">Import from CSV</h3>
              <p className="text-sm text-gray-600">
                {researchMode === 'instagram'
                  ? 'Upload a CSV file to process multiple Instagram profiles. Select the column containing Instagram URLs.'
                  : 'Upload a CSV file to process multiple companies. Select the column containing website URLs.'}
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
              <p className="text-xs mt-2 text-blue-600">
                Progress is automatically saved. You can safely close this page and resume later.
              </p>
            </div>
          )}
          {hasSavedProgress && !isProcessingCsv && csvData && (
            <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm font-medium text-yellow-800 mb-1">
                    Saved progress detected
                  </p>
                  <p className="text-xs text-yellow-700">
                    You have unsaved progress from a previous session. You can resume processing or download the partial results.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleDownloadPartialProgress}
                    className="px-3 py-1.5 text-xs bg-yellow-600 text-white rounded-sm hover:bg-yellow-700 transition-colors"
                  >
                    Download Partial
                  </button>
                  <button
                    onClick={() => {
                      clearCsvProgress();
                      setHasSavedProgress(false);
                    }}
                    className="px-3 py-1.5 text-xs bg-gray-200 text-gray-700 rounded-sm hover:bg-gray-300 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {!isProcessingCsv && (
        <form onSubmit={handleResearch} className="space-y-6 mb-8">
          <textarea
            value={rawCompanyInput}
            onChange={(e) => {
              const newValue = e.target.value;
              setRawCompanyInput(newValue);
              // Check if input contains Instagram URL and switch mode accordingly
              if (containsInstagramUrl(newValue)) {
                // Switch to Instagram mode if Instagram URL is detected
                if (researchMode !== 'instagram') {
                  setResearchMode('instagram');
                }
              } else if (newValue.trim().length > 0 && researchMode === 'instagram') {
                // Switch back to Domain mode if no Instagram URL and there's content
                setResearchMode('domain');
              }
            }}
            placeholder={researchMode === 'instagram' 
              ? "Enter Instagram URLs (e.g., instagram.com/username, instagram.com/another_username)"
              : "Enter company URLs (e.g., example.com, another-company.com)"}
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
            {isSearching 
              ? (researchMode === 'instagram' ? 'Researching Instagram...' : 'Analyzing...') 
              : (researchMode === 'instagram' ? 'Research Instagram Profiles' : 'Analyze Companies')}
          </button>
        </form>
      )}
      
      {/* Global loading indicator */}
      {isSearching && (
        <div className="mb-6 p-3 bg-blue-50 text-blue-700 rounded-sm flex items-center gap-2">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-700"></div>
          <span>{researchMode === 'instagram' ? 'Researching Instagram profiles...' : 'Analyzing company qualification...'}</span>
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
        {/* Qualification/Profile Section */}
        {(isSearching || qualificationData || instagramProfileData) && (
          <div className="space-y-8">
            <div className="flex items-center">
              <h2 className="text-3xl font-medium">
                {researchMode === 'instagram' ? 'Instagram Profile' : 'Qualification Assessment'}
              </h2>
            </div>

            <div className="opacity-0 animate-fade-up [animation-delay:300ms]">
              {researchMode === 'instagram' ? (
                // Instagram Profile Display
                isSearching && instagramProfileData === null ? (
                  <div className="animate-pulse">
                    <div className="h-[300px] bg-gray-100 rounded-lg flex items-center justify-center">
                      <div className="text-center">
                        <div className="text-gray-500 mb-2">Researching Instagram profile...</div>
                        <div className="flex justify-center">
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-700"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : instagramProfileData ? (
                  <InstagramProfileDisplay 
                    data={instagramProfileData} 
                    instagramUrl={activeCompany}
                    qualificationData={instagramQualificationData}
                  />
                ) : (
                  <div className="h-[300px] bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                    <div className="text-center p-6">
                      <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <h3 className="mt-2 text-sm font-medium text-gray-900">No Instagram profile data available</h3>
                      <p className="mt-1 text-sm text-gray-500">We couldn't fetch Instagram profile data for this URL.</p>
                      {errorsByCompany[activeCompany || '']?.instagramProfileData && (
                        <p className="mt-2 text-sm text-red-600">
                          {errorsByCompany[activeCompany || ''].instagramProfileData}
                        </p>
                      )}
                    </div>
                  </div>
                )
              ) : (
                // Domain Research Display (existing)
                isSearching && qualificationData === null ? (
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
                )
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
        mode={researchMode}
        onSelectColumn={(column) => {
          setSelectedUrlColumn(column);
        }}
        onConfirm={() => {
          if (selectedUrlColumn) {
            setShowColumnSelector(false);
            if (hasSavedProgress) {
              setShowResumeDialog(true);
            } else {
              processCsvRows(false);
            }
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

      {/* Resume Dialog */}
      <ResumeDialog
        isOpen={showResumeDialog}
        onResume={() => {
          processCsvRows(true);
        }}
        onStartFresh={() => {
          clearCsvProgress();
          setHasSavedProgress(false);
          processCsvRows(false);
        }}
        onClose={() => setShowResumeDialog(false)}
        progressInfo={(() => {
          const saved = loadCsvProgress();
          if (saved) {
            return {
              current: saved.currentDomainIndex,
              total: saved.totalDomains,
              lastSavedAt: saved.lastSavedAt,
            };
          }
          return undefined;
        })()}
      />
    </div>  
  );
}
