// CompanyResearchHome.tsx

"use client";
import { useState, FormEvent, useCallback, useMemo, useRef, useEffect } from "react";
import QualificationDisplay from './qualification/QualificationDisplay';
import InstagramProfileDisplay from './qualification/InstagramProfileDisplay';
import Image from "next/image";
import Link from "next/link";
import { fetchCompanyMap, fetchInstagramProfile, sendSlackNotification } from "../lib/api";
import ExportCsvButton from './ui/ExportCsvButton';
import ColumnSelectorDialog from './ui/ColumnSelectorDialog';
import ConfirmationModal from './ui/ConfirmationModal';
import ResumeDialog from './ui/ResumeDialog';
import Toast from './ui/Toast';
import { parseCsv, csvToString, mergeQualificationData, ensureColumnsExist, CsvRow } from "../lib/csvImport";
import { downloadCsv } from "../lib/csvExport";
import { saveCsvProgress, loadCsvProgress, clearCsvProgress, hasCsvProgress, serializeQualificationDataMap, deserializeQualificationDataMap, shouldAutoSave, CsvProgressState } from "../lib/csvProgress";
import { useCompanies } from "@/contexts/CompaniesContext";
import { useOwner } from "@/contexts/OwnerContext";
import { useAuth } from "@/contexts/AuthContext";
import { extractUsernameFromUrl } from "../utils/instagramUrl";
import { supabase } from "@/utils/supabase/client";

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

export default function CompanyResearcher() {
  // Companies context for saving summaries (but don't fetch companies list on mount)
  const { createCompany, updateCompany } = useCompanies();
  // Owner context for selected owner
  const { selectedOwner } = useOwner();
  // Auth context for user ID
  const { user } = useAuth();
  
  // Personalization settings (fetched once on page load)
  const [personalizationSettings, setPersonalizationSettings] = useState<{
    direct?: { query?: string; schema?: any };
    instagram?: { systemPrompt?: string; userMessage?: string };
  } | null>(null);
  
  // Research mode: 'domain' or 'instagram'
  const [researchMode, setResearchMode] = useState<'domain' | 'instagram'>('domain');

  // Set name for batch processing
  const [setName, setSetName] = useState('');
  
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
  const [selectedColumns, setSelectedColumns] = useState<{ domain: string | null; instagram: string | null }>({ domain: null, instagram: null });
  const [isProcessingCsv, setIsProcessingCsv] = useState(false);
  const [csvProcessingProgress, setCsvProcessingProgress] = useState({ current: 0, total: 0 });
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [hasSavedProgress, setHasSavedProgress] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvDataRef = useRef<{ headers: string[]; rows: CsvRow[] } | null>(null);
  const shouldStopProcessingRef = useRef<boolean>(false);

  // Toast state
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);

  // Fetch personalization settings on page load
  useEffect(() => {
    const fetchPersonalization = async () => {
      if (!user) {
        return;
      }

      try {
        const { data, error } = await supabase
          .from('user_settings')
          .select('personalization')
          .eq('id', user.id)
          .single();

        // PGRST116 = no rows returned (user hasn't set personalization yet)
        if (error && error.code === 'PGRST116') {
          // No personalization set yet, use null (will use defaults in API)
          setPersonalizationSettings(null);
          return;
        }

        if (error || !data?.personalization) {
          // Other error or no personalization data, use null
          setPersonalizationSettings(null);
          return;
        }

        const personalization = typeof data.personalization === 'string'
          ? JSON.parse(data.personalization)
          : data.personalization;

        setPersonalizationSettings({
          direct: personalization.direct || null,
          instagram: personalization.instagram || null,
        });
      } catch (error) {
        console.error('Error fetching personalization settings:', error);
        setPersonalizationSettings(null);
      }
    };

    fetchPersonalization();
  }, [user]);
  
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

  // Function to filter out invalid domains from input
  const filterInvalidDomains = useCallback((input: string): { filteredInput: string; removedDomains: string[] } => {
    const lines = input.split(/[,\n]/).map(line => line.trim()).filter(line => line.length > 0);
    const validLines: string[] = [];
    const removedDomains: string[] = [];

    lines.forEach(line => {
      // Extract domain from URL
      const cleanedUrl = cleanUrl(line, researchMode);
      const domain = cleanedUrl ? extractDomain(cleanedUrl) : null;

      if (domain && INVALID_DOMAINS.some(invalidDomain => domain.toLowerCase().includes(invalidDomain.toLowerCase()))) {
        // This is an invalid domain, add to removed list
        removedDomains.push(line);
      } else {
        // This is valid, keep it
        validLines.push(line);
      }
    });

    const filteredInput = validLines.join(', ');
    return { filteredInput, removedDomains };
  }, [researchMode]);

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
          instagramProfileData = await fetchInstagramProfile(company, user?.id, personalizationSettings?.instagram || null);
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
            if (username && user) {
              // Check if company exists with this instagram username (query database directly)
              const { data: existingCompanyData } = await supabase
                .from('companies')
                .select('id, instagram, domain, email, phone')
                .eq('user_id', user.id)
                .eq('instagram', username)
                .maybeSingle();
              
              const existingCompany = existingCompanyData;
              
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
                  set_name: setName || null,
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
          [company]: { form: `Invalid company URL: ${company}. Please use format 'capitalxai.com'` }
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
          qualificationData = await fetchCompanyMap(domainName, user?.id, personalizationSettings?.direct || null);
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
            // Check if company exists with this domain (query database directly)
            if (!user) {
              console.error('User not available, cannot save company');
              return;
            }
            
            const { data: existingCompanyData } = await supabase
              .from('companies')
              .select('id, instagram, domain, email, phone')
              .eq('user_id', user.id)
              .eq('domain', domainName)
              .maybeSingle();
            
            const existingCompany = existingCompanyData;
            
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
                set_name: setName || null,
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
  }, [researchMode, createCompany, updateCompany, selectedOwner, user, personalizationSettings]);

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
      setSelectedColumns({ domain: null, instagram: null });
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
    if (csvData && (selectedUrlColumn || (selectedColumns.domain || selectedColumns.instagram))) {
      const saved = hasCsvProgress();
      setHasSavedProgress(saved);
    } else {
      setHasSavedProgress(false);
    }
  }, [csvData, selectedUrlColumn, selectedColumns]);

  // Utility function to process items in parallel batches
  const processInBatches = async <T, R>(
    items: T[],
    processor: (item: T, index: number) => Promise<R>,
    concurrency: number = 10,
    onProgress?: (processed: number, total: number) => void,
    onBatchComplete?: (processed: number, total: number) => void
  ): Promise<R[]> => {
    const results: R[] = [];
    const errors: { item: T; error: any }[] = [];
    
    for (let i = 0; i < items.length; i += concurrency) {
      // Check if processing should stop
      if (shouldStopProcessingRef.current) {
        break;
      }
      
      const batch = items.slice(i, i + concurrency);
      const batchPromises = batch.map((item, batchIndex) => 
        processor(item, i + batchIndex).catch(error => {
          errors.push({ item, error });
          return null as R;
        })
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
      
      const processed = Math.min(i + concurrency, items.length);
      if (onProgress) {
        onProgress(processed, items.length);
      }
      
      if (onBatchComplete) {
        onBatchComplete(processed, items.length);
      }
      
      // Check again after batch completes
      if (shouldStopProcessingRef.current) {
        break;
      }
    }
    
    return results;
  };

  // Function to generate and download processed and pending CSVs
  const generateProcessedAndPendingCsvs = useCallback((
    allRows: CsvRow[],
    headers: string[],
    qualificationDataMap: Map<string, any>,
    errorMap: Map<string, string>,
    useDualColumns: boolean,
    selectedColumns: { domain: string | null; instagram: string | null },
    selectedUrlColumn: string | null,
    researchMode: 'domain' | 'instagram'
  ) => {
    const isInstagramUrl = (url: string): boolean => {
      if (!url || typeof url !== 'string') return false;
      return url.toLowerCase().includes('instagram.com');
    };

    // Separate rows into processed and pending
    const processedRows: CsvRow[] = [];
    const pendingRows: CsvRow[] = [];

    allRows.forEach(row => {
      let isProcessed = false;
      let domainName: string | null = null;
      let instagramUrl: string | null = null;

      if (useDualColumns) {
        const domainUrl = selectedColumns.domain ? row[selectedColumns.domain]?.trim() || '' : '';
        const instagramUrlValue = selectedColumns.instagram ? row[selectedColumns.instagram]?.trim() || '' : '';
        
        if (domainUrl) {
          const cleanedUrl = cleanUrl(domainUrl, 'domain');
          domainName = cleanedUrl ? extractDomain(cleanedUrl) : null;
        }
        
        if (instagramUrlValue && isInstagramUrl(instagramUrlValue)) {
          instagramUrl = instagramUrlValue;
        }

        // Check if row is processed (has qualification data or error)
        isProcessed = !!(domainName && (qualificationDataMap.has(domainName) || errorMap.has(domainName))) ||
                      !!(instagramUrl && (qualificationDataMap.has(instagramUrl) || errorMap.has(instagramUrl))) ||
                      !!(row['Research Status'] && row['Research Status'].trim() !== '');
      } else {
        const url = selectedUrlColumn ? row[selectedUrlColumn]?.trim() || '' : '';
        
        if (researchMode === 'instagram') {
          if (url && isInstagramUrl(url)) {
            instagramUrl = url;
            isProcessed = qualificationDataMap.has(url) || errorMap.has(url) || 
                         !!(row['Research Status'] && row['Research Status'].trim() !== '');
          }
        } else {
          if (url) {
            const cleanedUrl = cleanUrl(url, researchMode);
            domainName = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
            isProcessed = !!(domainName && (qualificationDataMap.has(domainName) || errorMap.has(domainName))) ||
                         !!(row['Research Status'] && row['Research Status'].trim() !== '');
          }
        }
      }

      // Update processed rows with qualification data
      if (isProcessed) {
        const updatedRow = { ...row };
        
        if (useDualColumns) {
          let domainQualificationData: any = null;
          let instagramData: any = null;
          let instagramQualificationData: any = null;
          
          if (domainName) {
            domainQualificationData = qualificationDataMap.get(domainName);
          }
          
          if (instagramUrl) {
            instagramData = qualificationDataMap.get(instagramUrl);
            if (instagramData && instagramData.qualificationData) {
              instagramQualificationData = instagramData.qualificationData;
            }
          }
          
          const finalQualificationData = domainQualificationData || instagramQualificationData;
          
          if (finalQualificationData) {
            updatedRow['Research Status'] = 'completed';
            if (domainQualificationData) {
              updatedRow['Company Summary'] = domainQualificationData.company_summary || '';
              updatedRow['Company Industry'] = domainQualificationData.company_industry || '';
              updatedRow['Sales Opener Sentence'] = domainQualificationData.sales_opener_sentence || '';
              updatedRow['Classification'] = domainQualificationData.classification || '';
              updatedRow['Confidence Score'] = String(domainQualificationData.confidence_score || '');
              updatedRow['Sales Action'] = domainQualificationData.sales_action || '';
              
              if (domainQualificationData.product_types && Array.isArray(domainQualificationData.product_types)) {
                const productTypes = domainQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
            }
            
            if (instagramData && !('error' in instagramData)) {
              updatedRow['Instagram Username'] = instagramData.username || '';
              updatedRow['Instagram Full Name'] = instagramData.full_name || '';
              updatedRow['Instagram Bio'] = instagramData.biography || '';
              updatedRow['Instagram Posts'] = String(instagramData.edge_owner_to_timeline_media?.count || 0);
              updatedRow['Instagram Followers'] = String(instagramData.edge_followed_by?.count || 0);
              updatedRow['Instagram Following'] = String(instagramData.edge_follow?.count || 0);
              updatedRow['Instagram Private'] = instagramData.is_private ? 'Yes' : 'No';
            }
            
            if (!domainQualificationData && instagramQualificationData) {
              updatedRow['Company Summary'] = instagramQualificationData.profile_summary || '';
              updatedRow['Company Industry'] = instagramQualificationData.profile_industry || '';
              updatedRow['Sales Opener Sentence'] = instagramQualificationData.sales_opener_sentence || '';
              updatedRow['Classification'] = instagramQualificationData.classification || '';
              if (instagramQualificationData.confidence_score !== undefined) {
                updatedRow['Confidence Score'] = String(instagramQualificationData.confidence_score);
              }
              updatedRow['Sales Action'] = instagramQualificationData.sales_action || '';
              
              if (instagramQualificationData.product_types && Array.isArray(instagramQualificationData.product_types)) {
                const productTypes = instagramQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
            }
          } else {
            const error = domainName ? errorMap.get(domainName) : (instagramUrl ? errorMap.get(instagramUrl) : null);
            updatedRow['Research Status'] = error || 'Failed to fetch data';
          }
        } else {
          const url = row[selectedUrlColumn!]?.trim() || '';
          
          if (researchMode === 'instagram') {
            if (url && isInstagramUrl(url)) {
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
                
                if (profileData.qualificationData) {
                  const qual = profileData.qualificationData;
                  updatedRow['Company Summary'] = qual.profile_summary || '';
                  updatedRow['Company Industry'] = qual.profile_industry || '';
                  updatedRow['Sales Opener Sentence'] = qual.sales_opener_sentence || '';
                  updatedRow['Classification'] = qual.classification || '';
                  if (qual.confidence_score !== undefined) {
                    updatedRow['Confidence Score'] = String(qual.confidence_score);
                  }
                  updatedRow['Sales Action'] = qual.sales_action || '';
                  
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
                    
                    productTypes.forEach((pt: string, index: number) => {
                      updatedRow[`PRODUCT${index + 1}`] = pt;
                    });
                  }
                }
              } else {
                const error = errorMap.get(url);
                updatedRow['Research Status'] = error || 'Failed to fetch Instagram profile data';
              }
            }
          } else {
            const cleanedUrl = cleanUrl(url, researchMode);
            const domainNameValue = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
            const qualificationData = domainNameValue ? qualificationDataMap.get(domainNameValue) : null;

            if (qualificationData) {
              updatedRow['Research Status'] = 'completed';
              updatedRow['Company Summary'] = qualificationData.company_summary || '';
              updatedRow['Company Industry'] = qualificationData.company_industry || '';
              updatedRow['Sales Opener Sentence'] = qualificationData.sales_opener_sentence || '';
              updatedRow['Classification'] = qualificationData.classification || '';
              updatedRow['Confidence Score'] = String(qualificationData.confidence_score || '');
              
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
              
              updatedRow['Sales Action'] = qualificationData.sales_action || '';
            } else if (domainNameValue) {
              const error = errorMap.get(domainNameValue);
              updatedRow['Research Status'] = error || 'Failed to fetch company qualification data';
            }
          }
        }
        
        processedRows.push(updatedRow);
      } else {
        pendingRows.push(row);
      }
    });

    // Ensure all required columns exist
    const updatedHeaders = ensureColumnsExist(headers);
    
    // Add PRODUCT columns if needed
    const allRowsForProductCheck = [...processedRows, ...pendingRows];
    const maxProductTypes = allRowsForProductCheck.reduce((max, row) => {
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

    // Generate CSVs
    if (processedRows.length > 0) {
      const processedCsv = csvToString(finalHeaders, processedRows);
      downloadCsv(processedCsv, `processed-rows-${new Date().toISOString().split('T')[0]}.csv`);
    }
    
    if (pendingRows.length > 0) {
      const pendingCsv = csvToString(finalHeaders, pendingRows);
      downloadCsv(pendingCsv, `pending-rows-${new Date().toISOString().split('T')[0]}.csv`);
    }
  }, []);

  // Process CSV rows with progress saving
  const processCsvRows = useCallback(async (resumeFromSaved: boolean = false) => {
    // Check if we have either the old single column selection or the new dual column selection
    const hasColumnSelection = selectedUrlColumn || (selectedColumns.domain || selectedColumns.instagram);
    if (!csvData || !hasColumnSelection) return;
    
    // Determine if we're using dual column mode
    const useDualColumns: boolean = !!(selectedColumns.domain || selectedColumns.instagram);

    // Helper function to check if URL is Instagram URL
    const isInstagramUrl = (url: string): boolean => {
      if (!url || typeof url !== 'string') return false;
      return url.toLowerCase().includes('instagram.com');
    };
    
    // Concurrency limit for parallel processing (adjust based on API rate limits)
    const CONCURRENCY_LIMIT = 10;

    // Helper function to save progress after each row is processed
    const saveProgressAfterRow = (mode: 'domain' | 'instagram', identifier: string) => {
      const processedCount = processedDomainIndices.length;
      if (shouldAutoSave(lastSavedAt, processedCount)) {
        // Merge data into rows for saving
        const currentCsvData: { headers: string[]; rows: CsvRow[] } = csvDataRef.current || csvData;
        const currentRows = currentCsvData.rows.map((row: CsvRow) => {
          const updatedRow = { ...row };
          
          if (useDualColumns) {
            // Dual column mode
            const domainUrl = selectedColumns.domain ? row[selectedColumns.domain]?.trim() || '' : '';
            const instagramUrl = selectedColumns.instagram ? row[selectedColumns.instagram]?.trim() || '' : '';
            
            const classification = row['Classification']?.trim() || '';
            if (classification) {
              if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
                updatedRow['Research Status'] = 'skipped (already classified)';
              }
              return updatedRow;
            }
            
            let domainName: string | null = null;
            let domainQualificationData: any = null;
            let instagramData: any = null;
            let instagramQualificationData: any = null;
            
            if (domainUrl) {
              const cleanedUrl = cleanUrl(domainUrl, 'domain');
              domainName = cleanedUrl ? extractDomain(cleanedUrl) : null;
              if (domainName) {
                domainQualificationData = qualificationDataMap.get(domainName);
              }
            }
            
            if (instagramUrl && isInstagramUrl(instagramUrl)) {
              instagramData = qualificationDataMap.get(instagramUrl);
              if (instagramData && instagramData.qualificationData) {
                instagramQualificationData = instagramData.qualificationData;
              }
            }
            
            const finalQualificationData = domainQualificationData || instagramQualificationData;
            
            if (finalQualificationData) {
              updatedRow['Research Status'] = 'completed';
              if (domainQualificationData) {
                updatedRow['Company Summary'] = domainQualificationData.company_summary || '';
                updatedRow['Company Industry'] = domainQualificationData.company_industry || '';
                updatedRow['Sales Opener Sentence'] = domainQualificationData.sales_opener_sentence || '';
                updatedRow['Classification'] = domainQualificationData.classification || '';
                updatedRow['Confidence Score'] = String(domainQualificationData.confidence_score || '');
                updatedRow['Sales Action'] = domainQualificationData.sales_action || '';
                
                if (domainQualificationData.product_types && Array.isArray(domainQualificationData.product_types)) {
                  const productTypes = domainQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
              }
              
              if (instagramData && !('error' in instagramData)) {
                updatedRow['Instagram Username'] = instagramData.username || '';
                updatedRow['Instagram Full Name'] = instagramData.full_name || '';
                updatedRow['Instagram Bio'] = instagramData.biography || '';
                updatedRow['Instagram Posts'] = String(instagramData.edge_owner_to_timeline_media?.count || 0);
                updatedRow['Instagram Followers'] = String(instagramData.edge_followed_by?.count || 0);
                updatedRow['Instagram Following'] = String(instagramData.edge_follow?.count || 0);
                updatedRow['Instagram Private'] = instagramData.is_private ? 'Yes' : 'No';
              }
              
              if (!domainQualificationData && instagramQualificationData) {
                updatedRow['Company Summary'] = instagramQualificationData.profile_summary || '';
                updatedRow['Company Industry'] = instagramQualificationData.profile_industry || '';
                updatedRow['Sales Opener Sentence'] = instagramQualificationData.sales_opener_sentence || '';
                updatedRow['Classification'] = instagramQualificationData.classification || '';
                if (instagramQualificationData.confidence_score !== undefined) {
                  updatedRow['Confidence Score'] = String(instagramQualificationData.confidence_score);
                }
                updatedRow['Sales Action'] = instagramQualificationData.sales_action || '';
                
                if (instagramQualificationData.product_types && Array.isArray(instagramQualificationData.product_types)) {
                  const productTypes = instagramQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
              }
            } else {
              const hasValidDomain = domainUrl && domainUrl.includes('.');
              const hasValidInstagram = instagramUrl && isInstagramUrl(instagramUrl);
              
              if (hasValidDomain || hasValidInstagram) {
                const error = domainName ? errorMap.get(domainName) : (instagramUrl ? errorMap.get(instagramUrl) : null);
                updatedRow['Research Status'] = error || 'Failed to fetch data';
              } else {
                updatedRow['Research Status'] = 'skipped (no valid URLs)';
              }
            }
            
            return updatedRow;
          } else {
            // Single column mode
            const url = (selectedUrlColumn ? row[selectedUrlColumn]?.trim() : '') || '';
            
            if (mode === 'instagram') {
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
                
                if (profileData.qualificationData) {
                  const qual = profileData.qualificationData;
                  updatedRow['Company Summary'] = qual.profile_summary || '';
                  updatedRow['Company Industry'] = qual.profile_industry || '';
                  updatedRow['Sales Opener Sentence'] = qual.sales_opener_sentence || '';
                  updatedRow['Classification'] = qual.classification || '';
                  if (qual.confidence_score !== undefined) {
                    updatedRow['Confidence Score'] = String(qual.confidence_score);
                  }
                  updatedRow['Sales Action'] = qual.sales_action || '';
                  
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
                    
                    productTypes.forEach((pt: string, index: number) => {
                      updatedRow[`PRODUCT${index + 1}`] = pt;
                    });
                  }
                }
              } else {
                const error = errorMap.get(url);
                updatedRow['Research Status'] = error || 'Failed to fetch Instagram profile data';
              }
            } else {
              // Domain mode
              const classification = row['Classification']?.trim() || '';
              
              if (classification) {
                if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
                  updatedRow['Research Status'] = 'skipped (already classified)';
                }
                return updatedRow;
              }
              
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
            }
            
            return updatedRow;
          }
        });

        // Save progress (without rows array to save space)
        const progressState: CsvProgressState = {
          headers: currentCsvData.headers,
          // rows: currentRows, // Removed to save localStorage space - will reconstruct on load
          selectedUrlColumn: selectedUrlColumn || '',
          processedDomainIndices: [...processedDomainIndices],
          uniqueDomains: uniqueDomainsArray,
          qualificationDataMap: serializeQualificationDataMap(qualificationDataMap),
          errorMap: Object.fromEntries(errorMap),
          lastSavedAt: Date.now(),
          totalDomains: uniqueDomainsArray.length,
          currentDomainIndex: processedDomainIndices.length,
          selectedColumns: useDualColumns ? selectedColumns : undefined,
          researchMode: researchMode
        };
        
        saveCsvProgress(progressState);
        lastSavedAt = Date.now();
        
        // Update CSV data state with current progress
        const updatedCsvData: { headers: string[]; rows: CsvRow[] } = { headers: currentCsvData.headers, rows: currentRows };
        setCsvData(updatedCsvData);
        csvDataRef.current = updatedCsvData;
      }
    };

    setIsProcessingCsv(true);
    shouldStopProcessingRef.current = false; // Reset stop flag
    
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
      // Check if saved progress matches current CSV structure
      const headersMatch = savedProgress && JSON.stringify(savedProgress.headers) === JSON.stringify(csvData.headers);
      const columnMatch = savedProgress && (
        (useDualColumns && savedProgress.selectedColumns?.domain === selectedColumns.domain && savedProgress.selectedColumns?.instagram === selectedColumns.instagram) ||
        (!useDualColumns && savedProgress.selectedUrlColumn === selectedUrlColumn)
      );
      
      if (savedProgress && headersMatch && columnMatch) {
        // Resume from saved progress
        qualificationDataMap = deserializeQualificationDataMap(savedProgress.qualificationDataMap);
        errorMap = new Map(Object.entries(savedProgress.errorMap || {}));
        processedDomainIndices = savedProgress.processedDomainIndices || [];
        uniqueDomainsArray = savedProgress.uniqueDomains || [];
        startFromIndex = savedProgress.currentDomainIndex || 0;
        lastSavedAt = savedProgress.lastSavedAt;
        
        // Reconstruct rows by merging qualification data into original CSV rows
        const mergedRows = csvData.rows.map((row: CsvRow) => {
          const updatedRow = { ...row };
          
          if (useDualColumns) {
            const domainUrl = selectedColumns.domain ? row[selectedColumns.domain]?.trim() || '' : '';
            const instagramUrl = selectedColumns.instagram ? row[selectedColumns.instagram]?.trim() || '' : '';
            
            let domainName: string | null = null;
            let domainQualificationData: any = null;
            let instagramData: any = null;
            let instagramQualificationData: any = null;
            
            if (domainUrl) {
              const cleanedUrl = cleanUrl(domainUrl, 'domain');
              domainName = cleanedUrl ? extractDomain(cleanedUrl) : null;
              if (domainName) {
                domainQualificationData = qualificationDataMap.get(domainName);
              }
            }
            
            if (instagramUrl && isInstagramUrl(instagramUrl)) {
              instagramData = qualificationDataMap.get(instagramUrl);
              if (instagramData && instagramData.qualificationData) {
                instagramQualificationData = instagramData.qualificationData;
              }
            }
            
            const finalQualificationData = domainQualificationData || instagramQualificationData;
            
            if (finalQualificationData) {
              updatedRow['Research Status'] = 'completed';
              if (domainQualificationData) {
                updatedRow['Company Summary'] = domainQualificationData.company_summary || '';
                updatedRow['Company Industry'] = domainQualificationData.company_industry || '';
                updatedRow['Sales Opener Sentence'] = domainQualificationData.sales_opener_sentence || '';
                updatedRow['Classification'] = domainQualificationData.classification || '';
                updatedRow['Confidence Score'] = String(domainQualificationData.confidence_score || '');
                updatedRow['Sales Action'] = domainQualificationData.sales_action || '';
                
                if (domainQualificationData.product_types && Array.isArray(domainQualificationData.product_types)) {
                  const productTypes = domainQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
              }
              
              if (instagramData && !('error' in instagramData)) {
                updatedRow['Instagram Username'] = instagramData.username || '';
                updatedRow['Instagram Full Name'] = instagramData.full_name || '';
                updatedRow['Instagram Bio'] = instagramData.biography || '';
                updatedRow['Instagram Posts'] = String(instagramData.edge_owner_to_timeline_media?.count || 0);
                updatedRow['Instagram Followers'] = String(instagramData.edge_followed_by?.count || 0);
                updatedRow['Instagram Following'] = String(instagramData.edge_follow?.count || 0);
                updatedRow['Instagram Private'] = instagramData.is_private ? 'Yes' : 'No';
              }
              
              if (!domainQualificationData && instagramQualificationData) {
                updatedRow['Company Summary'] = instagramQualificationData.profile_summary || '';
                updatedRow['Company Industry'] = instagramQualificationData.profile_industry || '';
                updatedRow['Sales Opener Sentence'] = instagramQualificationData.sales_opener_sentence || '';
                updatedRow['Classification'] = instagramQualificationData.classification || '';
                if (instagramQualificationData.confidence_score !== undefined) {
                  updatedRow['Confidence Score'] = String(instagramQualificationData.confidence_score);
                }
                updatedRow['Sales Action'] = instagramQualificationData.sales_action || '';
                
                if (instagramQualificationData.product_types && Array.isArray(instagramQualificationData.product_types)) {
                  const productTypes = instagramQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
              }
            } else {
              const hasValidDomain = domainUrl && domainUrl.includes('.');
              const hasValidInstagram = instagramUrl && isInstagramUrl(instagramUrl);
              
              if (hasValidDomain || hasValidInstagram) {
                const error = domainName ? errorMap.get(domainName) : (instagramUrl ? errorMap.get(instagramUrl) : null);
                updatedRow['Research Status'] = error || 'Failed to fetch data';
              }
            }
          } else {
            // Single column mode
            const url = (selectedUrlColumn ? row[selectedUrlColumn]?.trim() : '') || '';
            
            if (researchMode === 'instagram') {
              if (url && isInstagramUrl(url)) {
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
                  
                  if (profileData.qualificationData) {
                    const qual = profileData.qualificationData;
                    updatedRow['Company Summary'] = qual.profile_summary || '';
                    updatedRow['Company Industry'] = qual.profile_industry || '';
                    updatedRow['Sales Opener Sentence'] = qual.sales_opener_sentence || '';
                    updatedRow['Classification'] = qual.classification || '';
                    if (qual.confidence_score !== undefined) {
                      updatedRow['Confidence Score'] = String(qual.confidence_score);
                    }
                    updatedRow['Sales Action'] = qual.sales_action || '';
                    
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
                      
                      productTypes.forEach((pt: string, index: number) => {
                        updatedRow[`PRODUCT${index + 1}`] = pt;
                      });
                    }
                  }
                } else {
                  const error = errorMap.get(url);
                  updatedRow['Research Status'] = error || 'Failed to fetch Instagram profile data';
                }
              }
            } else {
              // Domain mode
              const cleanedUrl = cleanUrl(url, researchMode);
              const domainName = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
              const qualificationData = domainName ? qualificationDataMap.get(domainName) : null;
              
              if (qualificationData) {
                updatedRow['Research Status'] = 'completed';
                updatedRow['Company Summary'] = qualificationData.company_summary || '';
                updatedRow['Company Industry'] = qualificationData.company_industry || '';
                updatedRow['Sales Opener Sentence'] = qualificationData.sales_opener_sentence || '';
                updatedRow['Classification'] = qualificationData.classification || '';
                updatedRow['Confidence Score'] = String(qualificationData.confidence_score || '');
                updatedRow['Sales Action'] = qualificationData.sales_action || '';
                
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
              } else if (domainName) {
                const error = errorMap.get(domainName);
                updatedRow['Research Status'] = error || 'Failed to fetch company qualification data';
              }
            }
          }
          
          return updatedRow;
        });
        
        const mergedCsvData = { headers: csvData.headers, rows: mergedRows };
        setCsvData(mergedCsvData);
        csvDataRef.current = mergedCsvData;
      } else {
        // Data structure changed, can't resume
        clearCsvProgress();
        savedProgress = null;
      }
    }

    // Collect all valid URLs from CSV for display in textarea
    const allValidUrls: string[] = [];
    if (useDualColumns) {
      csvData.rows.forEach(row => {
        // Collect from domain column
        if (selectedColumns.domain) {
          const domainUrl = row[selectedColumns.domain]?.trim() || '';
          if (domainUrl && domainUrl.includes('.')) {
            const cleaned = cleanUrl(domainUrl, 'domain');
            if (cleaned) {
              allValidUrls.push(cleaned);
            }
          }
        }
        // Collect from Instagram column
        if (selectedColumns.instagram) {
          const instagramUrl = row[selectedColumns.instagram]?.trim() || '';
          if (instagramUrl && isInstagramUrl(instagramUrl)) {
            allValidUrls.push(instagramUrl);
          }
        }
      });
    } else {
      csvData.rows.forEach(row => {
        const url = row[selectedUrlColumn!]?.trim() || '';
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
    }

    // If not resuming or resume failed, start fresh
    if (!savedProgress) {
      setCsvProcessingProgress({ current: 0, total: csvData.rows.length });
      lastSavedAt = null;
    } else {
      setCsvProcessingProgress({ current: startFromIndex, total: uniqueDomainsArray.length });
    }

    // Filter rows based on mode
    const rowsToProcess = csvData.rows.filter((row, index) => {
      if (useDualColumns) {
        // Dual column mode: include rows that have either domain or Instagram URL
        const domainUrl = selectedColumns.domain ? row[selectedColumns.domain]?.trim() || '' : '';
        const instagramUrl = selectedColumns.instagram ? row[selectedColumns.instagram]?.trim() || '' : '';
        
        const classification = row['Classification']?.trim() || '';
        // Skip if Classification is already filled
        if (classification) {
          return false;
        }
        
        // Include if we have at least one valid URL
        const hasValidDomain = domainUrl && domainUrl.includes('.');
        const hasValidInstagram = instagramUrl && isInstagramUrl(instagramUrl);
        
        return hasValidDomain || hasValidInstagram;
      } else {
        // Single column mode: existing logic
        const url = row[selectedUrlColumn!]?.trim() || '';
        
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
      }
    });

    if (useDualColumns) {
      // Dual column mode: process based on research mode, but save both values
      // Create mappings from domain/Instagram URL to rows for immediate saving
      const domainToRowsMap = new Map<string, CsvRow[]>();
      const instagramUrlToRowsMap = new Map<string, CsvRow[]>();
      
      rowsToProcess.forEach(row => {
        const domainUrl = selectedColumns.domain ? row[selectedColumns.domain]?.trim() || '' : '';
        const instagramUrl = selectedColumns.instagram ? row[selectedColumns.instagram]?.trim() || '' : '';
        
        if (domainUrl) {
          const cleanedUrl = cleanUrl(domainUrl, 'domain');
          if (cleanedUrl) {
            const domainName = extractDomain(cleanedUrl);
            if (domainName) {
              if (!domainToRowsMap.has(domainName)) {
                domainToRowsMap.set(domainName, []);
              }
              domainToRowsMap.get(domainName)!.push(row);
            }
          }
        }
        
        if (instagramUrl && isInstagramUrl(instagramUrl)) {
          if (!instagramUrlToRowsMap.has(instagramUrl)) {
            instagramUrlToRowsMap.set(instagramUrl, []);
          }
          instagramUrlToRowsMap.get(instagramUrl)!.push(row);
        }
      });

      // Helper function to save company for a row immediately after API response
      const saveCompanyForRow = async (row: CsvRow, qualificationData: any, source: 'domain' | 'instagram', identifier: string) => {
        if (!user) return;
        
        const domainUrl = selectedColumns.domain ? row[selectedColumns.domain]?.trim() || '' : '';
        const instagramUrl = selectedColumns.instagram ? row[selectedColumns.instagram]?.trim() || '' : '';
        
        let domainName: string | null = null;
        let instagramUsername: string | null = null;
        
        if (domainUrl) {
          const cleanedUrl = cleanUrl(domainUrl, 'domain');
          domainName = cleanedUrl ? extractDomain(cleanedUrl) : null;
        }
        
        if (instagramUrl && isInstagramUrl(instagramUrl)) {
          instagramUsername = extractUsernameFromUrl(instagramUrl);
        }
        
        if (!domainName && !instagramUsername) return;
        
        try {
          const email = qualificationData?.email || null;
          const phone = qualificationData?.phone || null;
          
          // Use domain as primary identifier if available, otherwise use Instagram
          const primaryIdentifier = domainName || instagramUsername!;
          const isDomain = !!domainName;
          
          // Check if company exists
          const { data: existingCompanyData } = await supabase
            .from('companies')
            .select('id, instagram, domain, email, phone')
            .eq('user_id', user.id)
            .eq(isDomain ? 'domain' : 'instagram', primaryIdentifier)
            .maybeSingle();
          
          const existingCompany = existingCompanyData;
          
          if (existingCompany) {
            // Update existing company, combining both fields from CSV
            await updateCompany(existingCompany.id, {
              summary: qualificationData,
              // Always save both values from CSV, even if we didn't research them
              domain: domainName || existingCompany.domain || '',
              instagram: instagramUsername || existingCompany.instagram || '',
              email: email || existingCompany.email || '',
              phone: phone || existingCompany.phone || '',
              owner: selectedOwner,
            });
          } else {
            // Create new company with both fields from CSV
            await createCompany({
              domain: domainName || '',
              instagram: instagramUsername || '',
              summary: qualificationData,
              email: email || '',
              phone: phone || '',
              set_name: setName || null,
              owner: selectedOwner,
            });
          }
        } catch (saveError) {
          console.error('Error saving company to database during CSV processing:', saveError);
        }
      };

      // Process domains from domain column (only if Domain Research mode)
      if (selectedColumns.domain && researchMode === 'domain') {
        if (!savedProgress) {
          const uniqueDomains = new Set<string>();
          domainToRowsMap.forEach((_, domainName) => {
            uniqueDomains.add(domainName);
          });
          uniqueDomainsArray = Array.from(uniqueDomains);
        }

        // Fetch qualification data for all unique domains in parallel batches
        const domainsToProcess = uniqueDomainsArray.slice(startFromIndex);
        await processInBatches(
          domainsToProcess,
          async (domainName, batchIndex) => {
            const actualIndex = startFromIndex + batchIndex;
            try {
              const data = await fetchCompanyMap(domainName, user?.id, personalizationSettings?.direct || null);
              if (data) {
                qualificationDataMap.set(domainName, data);
                
                // Save companies immediately after getting response for all rows with this domain
                const rowsForDomain = domainToRowsMap.get(domainName) || [];
                for (const row of rowsForDomain) {
                  await saveCompanyForRow(row, data, 'domain', domainName);
                }
              } else {
                errorMap.set(domainName, 'Failed to fetch company qualification data');
              }
            } catch (error) {
              console.error(`Error fetching data for ${domainName}:`, error);
              const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
              errorMap.set(domainName, errorMessage);
            }
            processedDomainIndices.push(actualIndex);
            // Save progress after each row is processed
            saveProgressAfterRow('domain', domainName);
            return domainName;
          },
          CONCURRENCY_LIMIT,
          (processed, total) => {
            setCsvProcessingProgress({ current: startFromIndex + processed, total: uniqueDomainsArray.length });
          }
        );
        
        // Check if processing was stopped
        if (shouldStopProcessingRef.current) {
          // Get latest CSV data from ref
          const currentCsvData = csvDataRef.current || csvData;
          // Generate and download processed and pending CSVs
          generateProcessedAndPendingCsvs(
            currentCsvData.rows,
            currentCsvData.headers,
            qualificationDataMap,
            errorMap,
            useDualColumns,
            selectedColumns,
            selectedUrlColumn || null,
            researchMode
          );
          
          setIsProcessingCsv(false);
          setConfirmationMessage('Processing stopped. Downloaded processed and pending CSVs.');
          setShowConfirmationModal(true);
          return;
        }
      }

      // Process Instagram URLs from Instagram column (only if Instagram Research mode)
      if (selectedColumns.instagram && researchMode === 'instagram') {
        if (!savedProgress) {
          const uniqueInstagramUrls = new Set<string>();
          instagramUrlToRowsMap.forEach((_, url) => {
            uniqueInstagramUrls.add(url);
          });
          uniqueDomainsArray = Array.from(uniqueInstagramUrls);
        }
        
        const instagramUrlsToProcess = uniqueDomainsArray.slice(startFromIndex);
        
        // Process Instagram URLs in parallel batches
        await processInBatches(
          instagramUrlsToProcess,
          async (instagramUrl, index) => {
            const actualIndex = startFromIndex + index;
            try {
              const data = await fetchInstagramProfile(instagramUrl, user?.id, personalizationSettings?.instagram || null);
              if (data) {
                qualificationDataMap.set(instagramUrl, data);
                
                // Save companies immediately after getting response for all rows with this Instagram URL
                const rowsForInstagram = instagramUrlToRowsMap.get(instagramUrl) || [];
                for (const row of rowsForInstagram) {
                  if (data.qualificationData) {
                    await saveCompanyForRow(row, data.qualificationData, 'instagram', instagramUrl);
                  }
                }
              } else {
                errorMap.set(instagramUrl, 'Failed to fetch Instagram profile data');
              }
            } catch (error) {
              console.error(`Error fetching Instagram profile for ${instagramUrl}:`, error);
              const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
              errorMap.set(instagramUrl, errorMessage);
            }
            processedDomainIndices.push(actualIndex);
            // Save progress after each row is processed
            saveProgressAfterRow('instagram', instagramUrl);
            return instagramUrl;
          },
          CONCURRENCY_LIMIT,
          (processed, total) => {
            setCsvProcessingProgress({ current: startFromIndex + processed, total: uniqueDomainsArray.length });
          }
        );
        
        // Check if processing was stopped
        if (shouldStopProcessingRef.current) {
          // Get latest CSV data from ref
          const currentCsvData = csvDataRef.current || csvData;
          // Generate and download processed and pending CSVs
          generateProcessedAndPendingCsvs(
            currentCsvData.rows,
            currentCsvData.headers,
            qualificationDataMap,
            errorMap,
            useDualColumns,
            selectedColumns,
            selectedUrlColumn || null,
            researchMode
          );
          
          setIsProcessingCsv(false);
          setConfirmationMessage('Processing stopped. Downloaded processed and pending CSVs.');
          setShowConfirmationModal(true);
          return;
        }
      }
    } else if (researchMode === 'instagram') {
      // Instagram mode processing
      // Extract unique Instagram URLs - only if not resuming
      if (!savedProgress) {
        const uniqueUrls = new Set<string>();
        
        rowsToProcess.forEach(row => {
          const url = row[selectedUrlColumn!]?.trim() || '';
          if (url && isInstagramUrl(url)) {
            uniqueUrls.add(url);
          }
        });

        uniqueDomainsArray = Array.from(uniqueUrls);
      }

      // Fetch Instagram profile data for all unique URLs in parallel batches (starting from saved index if resuming)
      const instagramUrlsToProcess = uniqueDomainsArray.slice(startFromIndex);
      await processInBatches(
        instagramUrlsToProcess,
        async (instagramUrl, batchIndex) => {
          const actualIndex = startFromIndex + batchIndex;
          try {
            const data = await fetchInstagramProfile(instagramUrl, user?.id, personalizationSettings?.instagram || null);
            if (data) {
              qualificationDataMap.set(instagramUrl, data); // Reusing map for Instagram profiles
              
              // Save/update company in database after summary is generated
              if (data.qualificationData) {
                try {
                  const username = extractUsernameFromUrl(instagramUrl);
                  if (username && user) {
                    // Check if company exists with this instagram username (query database directly)
                    const { data: existingCompanyData } = await supabase
                      .from('companies')
                      .select('id, instagram, domain, email, phone')
                      .eq('user_id', user.id)
                      .eq('instagram', username)
                      .maybeSingle();
                    
                    const existingCompany = existingCompanyData;
                    
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
                        set_name: setName || null,
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

          processedDomainIndices.push(actualIndex);
          // Save progress after each row is processed
          saveProgressAfterRow('instagram', instagramUrl);
          return instagramUrl;
        },
        CONCURRENCY_LIMIT,
        (processed, total) => {
          setCsvProcessingProgress({ current: startFromIndex + processed, total: uniqueDomainsArray.length });
        }
      );
      
      // Check if processing was stopped
      if (shouldStopProcessingRef.current) {
        // Get latest CSV data from ref
        const currentCsvData = csvDataRef.current || csvData;
        // Generate and download processed and pending CSVs
        generateProcessedAndPendingCsvs(
          currentCsvData.rows,
          currentCsvData.headers,
          qualificationDataMap,
          errorMap,
          false,
          { domain: null, instagram: null },
          selectedUrlColumn || null,
          researchMode
        );
        
        setIsProcessingCsv(false);
        setConfirmationMessage('Processing stopped. Downloaded processed and pending CSVs.');
        setShowConfirmationModal(true);
        return;
      }
    } else {
      // Domain mode processing (existing logic)
      // Extract unique domains from URLs (clean URLs first) - only if not resuming
      if (!savedProgress) {
        const urlToDomainMap = new Map<string, string>();
        const uniqueDomains = new Set<string>();
        
        rowsToProcess.forEach(row => {
          const url = (selectedUrlColumn ? row[selectedUrlColumn]?.trim() : '') || '';
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

      // Fetch qualification data for all unique domains in parallel batches (starting from saved index if resuming)
      const domainsToProcess = uniqueDomainsArray.slice(startFromIndex);
      await processInBatches(
        domainsToProcess,
        async (domainName, batchIndex) => {
          const actualIndex = startFromIndex + batchIndex;
          try {
            const data = await fetchCompanyMap(domainName, user?.id, personalizationSettings?.direct || null);
            if (data) {
              qualificationDataMap.set(domainName, data);
              
              // Save/update company in database after summary is generated
              try {
                if (!user) {
                  console.error('User not available, cannot save company');
                  return domainName;
                }
                
                // Check if company exists with this domain (query database directly)
                const { data: existingCompanyData } = await supabase
                  .from('companies')
                  .select('id, instagram, domain, email, phone')
                  .eq('user_id', user.id)
                  .eq('domain', domainName)
                  .maybeSingle();
                
                const existingCompany = existingCompanyData;
                
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
                    set_name: setName || null,
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
          processedDomainIndices.push(actualIndex);
          // Save progress after each row is processed
          saveProgressAfterRow('domain', domainName);
          return domainName;
        },
        CONCURRENCY_LIMIT,
        (processed, total) => {
          setCsvProcessingProgress({ current: startFromIndex + processed, total: uniqueDomainsArray.length });
        }
      );
      
      // Check if processing was stopped
      if (shouldStopProcessingRef.current) {
        // Get latest CSV data from ref
        const currentCsvData = csvDataRef.current || csvData;
        // Generate and download processed and pending CSVs
        generateProcessedAndPendingCsvs(
          currentCsvData.rows,
          currentCsvData.headers,
          qualificationDataMap,
          errorMap,
          false,
          { domain: null, instagram: null },
          selectedUrlColumn || null,
          researchMode
        );
        
        setIsProcessingCsv(false);
        setConfirmationMessage('Processing stopped. Downloaded processed and pending CSVs.');
        setShowConfirmationModal(true);
        return;
      }
    }

    // Merge data into CSV rows
    const updatedRows = csvData.rows.map(row => {
      const updatedRow = { ...row };
      
      if (useDualColumns) {
        // Dual column mode: combine data from both columns
        const domainUrl = selectedColumns.domain ? row[selectedColumns.domain]?.trim() || '' : '';
        const instagramUrl = selectedColumns.instagram ? row[selectedColumns.instagram]?.trim() || '' : '';
        
        const classification = row['Classification']?.trim() || '';
        if (classification) {
          if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
            updatedRow['Research Status'] = 'skipped (already classified)';
          }
          return updatedRow;
        }
        
        let domainName: string | null = null;
        let domainQualificationData: any = null;
        let instagramData: any = null;
        let instagramQualificationData: any = null;
        
        // Get domain data
        if (domainUrl) {
          const cleanedUrl = cleanUrl(domainUrl, 'domain');
          domainName = cleanedUrl ? extractDomain(cleanedUrl) : null;
          if (domainName) {
            domainQualificationData = qualificationDataMap.get(domainName);
          }
        }
        
        // Get Instagram data
        if (instagramUrl && isInstagramUrl(instagramUrl)) {
          instagramData = qualificationDataMap.get(instagramUrl);
          if (instagramData && instagramData.qualificationData) {
            instagramQualificationData = instagramData.qualificationData;
          }
        }
        
        // Use domain qualification data if available, otherwise use Instagram
        const finalQualificationData = domainQualificationData || instagramQualificationData;
        
        if (finalQualificationData) {
          updatedRow['Research Status'] = 'completed';
          
          // Add domain-based fields if we have domain data
          if (domainQualificationData) {
            updatedRow['Company Summary'] = domainQualificationData.company_summary || '';
            updatedRow['Company Industry'] = domainQualificationData.company_industry || '';
            updatedRow['Sales Opener Sentence'] = domainQualificationData.sales_opener_sentence || '';
            updatedRow['Classification'] = domainQualificationData.classification || '';
            updatedRow['Confidence Score'] = String(domainQualificationData.confidence_score || '');
            updatedRow['Sales Action'] = domainQualificationData.sales_action || '';
            
            if (domainQualificationData.product_types && Array.isArray(domainQualificationData.product_types)) {
              const productTypes = domainQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
          }
          
          // Add Instagram-based fields if we have Instagram data
          if (instagramData && !('error' in instagramData)) {
            updatedRow['Instagram Username'] = instagramData.username || '';
            updatedRow['Instagram Full Name'] = instagramData.full_name || '';
            updatedRow['Instagram Bio'] = instagramData.biography || '';
            updatedRow['Instagram Posts'] = String(instagramData.edge_owner_to_timeline_media?.count || 0);
            updatedRow['Instagram Followers'] = String(instagramData.edge_followed_by?.count || 0);
            updatedRow['Instagram Following'] = String(instagramData.edge_follow?.count || 0);
            updatedRow['Instagram Private'] = instagramData.is_private ? 'Yes' : 'No';
          }
          
          // If we only have Instagram qualification data, use those fields
          if (!domainQualificationData && instagramQualificationData) {
            updatedRow['Company Summary'] = instagramQualificationData.profile_summary || '';
            updatedRow['Company Industry'] = instagramQualificationData.profile_industry || '';
            updatedRow['Sales Opener Sentence'] = instagramQualificationData.sales_opener_sentence || '';
            updatedRow['Classification'] = instagramQualificationData.classification || '';
            if (instagramQualificationData.confidence_score !== undefined) {
              updatedRow['Confidence Score'] = String(instagramQualificationData.confidence_score);
            }
            updatedRow['Sales Action'] = instagramQualificationData.sales_action || '';
            
            if (instagramQualificationData.product_types && Array.isArray(instagramQualificationData.product_types)) {
              const productTypes = instagramQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
          }
        } else {
          // No qualification data found
          const hasValidDomain = domainUrl && domainUrl.includes('.');
          const hasValidInstagram = instagramUrl && isInstagramUrl(instagramUrl);
          
          if (hasValidDomain || hasValidInstagram) {
            const error = domainName ? errorMap.get(domainName) : (instagramUrl ? errorMap.get(instagramUrl) : null);
            updatedRow['Research Status'] = error || 'Failed to fetch data';
          } else {
            updatedRow['Research Status'] = 'skipped (no valid URLs)';
          }
        }
        
        return updatedRow;
      }
      
      const url = row[selectedUrlColumn!]?.trim() || '';
      
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
      if (useDualColumns) {
        // Dual column mode: combine data from both columns
        const domainUrl = selectedColumns.domain ? row[selectedColumns.domain]?.trim() || '' : '';
        const instagramUrl = selectedColumns.instagram ? row[selectedColumns.instagram]?.trim() || '' : '';
        
        let domainName: string | null = null;
        let domainQualificationData: any = null;
        let instagramData: any = null;
        let instagramQualificationData: any = null;
        
        // Get domain data
        if (domainUrl) {
          const cleanedUrl = cleanUrl(domainUrl, 'domain');
          domainName = cleanedUrl ? extractDomain(cleanedUrl) : null;
          if (domainName) {
            domainQualificationData = qualificationDataMap.get(domainName);
          }
        }
        
        // Get Instagram data
        if (instagramUrl && isInstagramUrl(instagramUrl)) {
          instagramData = qualificationDataMap.get(instagramUrl);
          if (instagramData && instagramData.qualificationData) {
            instagramQualificationData = instagramData.qualificationData;
          }
        }
        
        // Store results - prefer domain URL for key, fallback to Instagram
        const displayUrl = domainUrl || instagramUrl;
        if (displayUrl && (domainQualificationData || instagramData)) {
          const { qualificationData: _, ...profileDataWithoutQualification } = instagramData || {};
          
          newResults[displayUrl] = {
            qualificationData: domainQualificationData || null,
            instagramProfileData: profileDataWithoutQualification || null,
            instagramQualificationData: instagramQualificationData || null
          };
        }
      } else {
        // Single column mode: existing logic
        const url = (selectedUrlColumn ? row[selectedUrlColumn]?.trim() : '') || '';
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
      }
    });
    setResultsByCompany(prev => ({ ...prev, ...newResults }));
    
    setIsProcessingCsv(false);
    setCsvData(null);
    setShowColumnSelector(false);
    setSelectedUrlColumn(null);
    setSelectedColumns({ domain: null, instagram: null });
    
    // Show confirmation modal
    const message = `CSV processing complete! Processed ${rowsToProcess.length} rows.`;
    setConfirmationMessage(message);
    setShowConfirmationModal(true);
    
    // Send Slack notification
    sendSlackNotification(`✅ CSV Processing Complete: Processed ${rowsToProcess.length} rows.`).catch(
      (error) => console.error('Failed to send Slack notification:', error)
    );
  }, [csvData, selectedUrlColumn, selectedColumns, rawCompanyInput, activeCompany, parseCompanyInput, researchMode, createCompany, updateCompany, selectedOwner, user, personalizationSettings]);

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
    setSetName('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Download partial progress
  const handleDownloadPartialProgress = useCallback(() => {
    const savedProgress = loadCsvProgress();
    if (!savedProgress || !csvData) return;

    // Helper function to check if URL is Instagram URL
    const isInstagramUrl = (url: string): boolean => {
      if (!url || typeof url !== 'string') return false;
      return url.toLowerCase().includes('instagram.com');
    };

    // Reconstruct rows from qualification data (same logic as in load progress)
    const qualificationDataMap = deserializeQualificationDataMap(savedProgress.qualificationDataMap);
    const errorMap = new Map(Object.entries(savedProgress.errorMap || {}));
    const useDualColumns = !!savedProgress.selectedColumns;
    const savedSelectedColumns = savedProgress.selectedColumns || { domain: null, instagram: null };
    const savedSelectedUrlColumn = savedProgress.selectedUrlColumn;
    const savedResearchMode = savedProgress.researchMode || 'domain';

    const reconstructedRows = csvData.rows.map((row: CsvRow) => {
      const updatedRow = { ...row };
      
      if (useDualColumns) {
        const domainUrl = savedSelectedColumns.domain ? row[savedSelectedColumns.domain]?.trim() || '' : '';
        const instagramUrl = savedSelectedColumns.instagram ? row[savedSelectedColumns.instagram]?.trim() || '' : '';
        
        let domainName: string | null = null;
        let domainQualificationData: any = null;
        let instagramData: any = null;
        let instagramQualificationData: any = null;
        
        if (domainUrl) {
          const cleanedUrl = cleanUrl(domainUrl, 'domain');
          domainName = cleanedUrl ? extractDomain(cleanedUrl) : null;
          if (domainName) {
            domainQualificationData = qualificationDataMap.get(domainName);
          }
        }
        
        if (instagramUrl && isInstagramUrl(instagramUrl)) {
          instagramData = qualificationDataMap.get(instagramUrl);
          if (instagramData && instagramData.qualificationData) {
            instagramQualificationData = instagramData.qualificationData;
          }
        }
        
        const finalQualificationData = domainQualificationData || instagramQualificationData;
        
        if (finalQualificationData) {
          updatedRow['Research Status'] = 'completed';
          if (domainQualificationData) {
            updatedRow['Company Summary'] = domainQualificationData.company_summary || '';
            updatedRow['Company Industry'] = domainQualificationData.company_industry || '';
            updatedRow['Sales Opener Sentence'] = domainQualificationData.sales_opener_sentence || '';
            updatedRow['Classification'] = domainQualificationData.classification || '';
            updatedRow['Confidence Score'] = String(domainQualificationData.confidence_score || '');
            updatedRow['Sales Action'] = domainQualificationData.sales_action || '';
            
            if (domainQualificationData.product_types && Array.isArray(domainQualificationData.product_types)) {
              const productTypes = domainQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
          }
          
          if (instagramData && !('error' in instagramData)) {
            updatedRow['Instagram Username'] = instagramData.username || '';
            updatedRow['Instagram Full Name'] = instagramData.full_name || '';
            updatedRow['Instagram Bio'] = instagramData.biography || '';
            updatedRow['Instagram Posts'] = String(instagramData.edge_owner_to_timeline_media?.count || 0);
            updatedRow['Instagram Followers'] = String(instagramData.edge_followed_by?.count || 0);
            updatedRow['Instagram Following'] = String(instagramData.edge_follow?.count || 0);
            updatedRow['Instagram Private'] = instagramData.is_private ? 'Yes' : 'No';
          }
          
          if (!domainQualificationData && instagramQualificationData) {
            updatedRow['Company Summary'] = instagramQualificationData.profile_summary || '';
            updatedRow['Company Industry'] = instagramQualificationData.profile_industry || '';
            updatedRow['Sales Opener Sentence'] = instagramQualificationData.sales_opener_sentence || '';
            updatedRow['Classification'] = instagramQualificationData.classification || '';
            if (instagramQualificationData.confidence_score !== undefined) {
              updatedRow['Confidence Score'] = String(instagramQualificationData.confidence_score);
            }
            updatedRow['Sales Action'] = instagramQualificationData.sales_action || '';
            
            if (instagramQualificationData.product_types && Array.isArray(instagramQualificationData.product_types)) {
              const productTypes = instagramQualificationData.product_types.filter((pt: any) => pt && typeof pt === 'string');
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
          }
        } else {
          const hasValidDomain = domainUrl && domainUrl.includes('.');
          const hasValidInstagram = instagramUrl && isInstagramUrl(instagramUrl);
          
          if (hasValidDomain || hasValidInstagram) {
            const error = domainName ? errorMap.get(domainName) : (instagramUrl ? errorMap.get(instagramUrl) : null);
            updatedRow['Research Status'] = error || 'Failed to fetch data';
          }
        }
      } else {
        // Single column mode
        const url = (savedSelectedUrlColumn ? row[savedSelectedUrlColumn]?.trim() : '') || '';
        
        if (savedResearchMode === 'instagram') {
          if (url && isInstagramUrl(url)) {
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
              
              if (profileData.qualificationData) {
                const qual = profileData.qualificationData;
                updatedRow['Company Summary'] = qual.profile_summary || '';
                updatedRow['Company Industry'] = qual.profile_industry || '';
                updatedRow['Sales Opener Sentence'] = qual.sales_opener_sentence || '';
                updatedRow['Classification'] = qual.classification || '';
                if (qual.confidence_score !== undefined) {
                  updatedRow['Confidence Score'] = String(qual.confidence_score);
                }
                updatedRow['Sales Action'] = qual.sales_action || '';
                
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
                  
                  productTypes.forEach((pt: string, index: number) => {
                    updatedRow[`PRODUCT${index + 1}`] = pt;
                  });
                }
              }
            } else {
              const error = errorMap.get(url);
              updatedRow['Research Status'] = error || 'Failed to fetch Instagram profile data';
            }
          }
        } else {
          // Domain mode
          const cleanedUrl = cleanUrl(url, savedResearchMode);
          const domainName = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
          const qualificationData = domainName ? qualificationDataMap.get(domainName) : null;
          
          if (qualificationData) {
            updatedRow['Research Status'] = 'completed';
            updatedRow['Company Summary'] = qualificationData.company_summary || '';
            updatedRow['Company Industry'] = qualificationData.company_industry || '';
            updatedRow['Sales Opener Sentence'] = qualificationData.sales_opener_sentence || '';
            updatedRow['Classification'] = qualificationData.classification || '';
            updatedRow['Confidence Score'] = String(qualificationData.confidence_score || '');
            updatedRow['Sales Action'] = qualificationData.sales_action || '';
            
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
          } else if (domainName) {
            const error = errorMap.get(domainName);
            updatedRow['Research Status'] = error || 'Failed to fetch company qualification data';
          }
        }
      }
      
      return updatedRow;
    });

    // Ensure all required columns exist
    const updatedHeaders = ensureColumnsExist(savedProgress.headers);
    
    // Add PRODUCT columns if needed
    const maxProductTypes = reconstructedRows.reduce((max: number, row: CsvRow) => {
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

    const csvString = csvToString(finalHeaders, reconstructedRows);
    downloadCsv(csvString, `partial-progress-${new Date().toISOString().split('T')[0]}.csv`);
  }, [csvData]);

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
          <Link href="/" className="flex-shrink-0" aria-label="CapitalxAI CRM home">
            <Image 
              src="/logo.png?v=2" 
              alt="CapitalxAI CRM" 
              width={60} 
              height={60} 
              className="object-contain"
              unoptimized
            />
          </Link>
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

      {/* Set Name Input */}
      <div className="mb-6 opacity-0 animate-fade-up [animation-delay:400ms]">
        <label htmlFor="set-name" className="block text-sm font-medium text-gray-700 mb-2">
          Set Name (Optional)
        </label>
        <input
          id="set-name"
          type="text"
          value={setName}
          onChange={(e) => setSetName(e.target.value)}
          placeholder="Enter a name for this batch of companies (optional)"
          className="w-full bg-white p-3 border box-border outline-none rounded-sm ring-2 ring-gray-300 focus:ring-brand-default transition-colors"
        />
        <p className="text-xs text-gray-500 mt-1">
          All processed companies will be tagged with this set name for easy identification and grouping.
        </p>
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
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-700"></div>
                  <span>Processing CSV: {csvProcessingProgress.current} / {csvProcessingProgress.total}</span>
                </div>
                <button
                  onClick={() => {
                    shouldStopProcessingRef.current = true;
                  }}
                  className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-sm hover:bg-red-700 transition-colors"
                >
                  Stop Processing
                </button>
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

              // Filter out invalid domains
              const { filteredInput, removedDomains } = filterInvalidDomains(newValue);

              // Set the filtered input
              setRawCompanyInput(filteredInput);

              // Show toast if any invalid domains were removed
              if (removedDomains.length > 0) {
                const removedDomainsText = removedDomains.length === 1
                  ? `"${removedDomains[0]}"`
                  : `"${removedDomains.slice(0, -1).join('", "')}" and "${removedDomains[removedDomains.length - 1]}"`;

                setToastMessage(`Removed invalid domain${removedDomains.length > 1 ? 's' : ''}: ${removedDomainsText}`);
                setShowToast(true);
              }

              // Check if filtered input contains Instagram URL and switch mode accordingly
              if (containsInstagramUrl(filteredInput)) {
                // Switch to Instagram mode if Instagram URL is detected
                if (researchMode !== 'instagram') {
                  setResearchMode('instagram');
                }
              } else if (filteredInput.trim().length > 0 && researchMode === 'instagram') {
                // Switch back to Domain mode if no Instagram URL and there's content
                setResearchMode('domain');
              }
            }}
            placeholder={researchMode === 'instagram' 
              ? "Enter Instagram URLs (e.g., instagram.com/username, instagram.com/another_username)"
              : "Enter company URLs (e.g., capitalxai.com, another-company.com)"}
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
        selectedColumns={selectedColumns}
        mode={researchMode}
        allowBoth={true}
        onSelectColumn={(column) => {
          setSelectedUrlColumn(column);
        }}
        onSelectColumns={(columns) => {
          setSelectedColumns(columns);
        }}
        onConfirm={() => {
          if (selectedUrlColumn || selectedColumns.domain || selectedColumns.instagram) {
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
          setSelectedColumns({ domain: null, instagram: null });
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

      {/* Toast Notification */}
      <Toast
        message={toastMessage}
        isVisible={showToast}
        onClose={() => setShowToast(false)}
        duration={4000}
      />
    </div>
  );
}
