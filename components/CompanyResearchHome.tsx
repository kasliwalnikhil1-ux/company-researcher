// CompanyResearchHome.tsx

"use client";
import { useState, FormEvent, useCallback, useMemo, useRef, useEffect } from "react";
import QualificationDisplay from './qualification/QualificationDisplay';
import InstagramProfileDisplay from './qualification/InstagramProfileDisplay';
import Image from "next/image";
import Link from "next/link";
import { fetchCompanyMap, fetchInstagramProfile, fetchInvestorResearch, fetchJobsResearch, fetchCompanyNewsEmailOpener, processContactsPending, cleanInvestorInput, sendSlackNotification } from "../lib/api";
import type { JobsResearchSummary, NewsEmailOpener } from "../lib/api";
import { mergeNewsDraftIntoSummary as mergeNewsDraftIntoSummaryHelper } from "../lib/reanalyzeCompany";
import ExportCsvButton from './ui/ExportCsvButton';
import ColumnSelectorDialog from './ui/ColumnSelectorDialog';
import ConfirmationModal from './ui/ConfirmationModal';
import ResumeDialog from './ui/ResumeDialog';
import Toast from './ui/Toast';
import { parseCsv, csvToString, mergeQualificationData, ensureColumnsExist, CsvRow } from "../lib/csvImport";
import { parseMarkdownTable, parseJsonArrayDetailed, detectDomainColumnIndex, moveColumnToFront, removeColumnAt, removeRowAt, buildRowNews, isLikelyDomain, TableData } from "../lib/tableImport";
import { downloadCsv } from "../lib/csvExport";
import { writeSummaryToCsvRow } from "../lib/summaryUtils";
import { saveCsvProgress, loadCsvProgress, clearCsvProgress, hasCsvProgress, serializeQualificationDataMap, deserializeQualificationDataMap, shouldAutoSave, CsvProgressState } from "../lib/csvProgress";
import { useCompanies } from "@/contexts/CompaniesContext";
import { useOwner } from "@/contexts/OwnerContext";
import { useAuth } from "@/contexts/AuthContext";
import { useOnboarding } from "@/contexts/OnboardingContext";
import { extractUsernameFromUrl } from "../utils/instagramUrl";
import { supabase } from "@/utils/supabase/client";

// Generic qualification/summary data - keys depend on personalization schema
type QualificationData = Record<string, any>;

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
// For person mode, preserves the full URL including the LinkedIn /in/handle path
// For investor mode, uses cleanInvestorInput (domain or LinkedIn)
const cleanUrl = (url: string, mode: 'domain' | 'instagram' | 'investor' | 'jobs' | 'person' = 'domain'): string | null => {
  if (mode === 'jobs') {
    if (!url) return null;
    let u = url.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      u = 'https://' + u;
    }
    return u;
  }
  if (mode === 'investor') {
    const { cleaned } = cleanInvestorInput(url);
    return cleaned || null;
  }
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

    // For person mode, preserve the full URL including the LinkedIn /in/handle path
    if (mode === 'person' && urlObj.hostname.includes('linkedin.com')) {
      const path = urlObj.pathname.replace(/\/+$/, '');
      return `${urlObj.protocol}//${urlObj.hostname}${path}`;
    }

    // For domain mode, extract just the origin (protocol + hostname)
    const hostname = urlObj.hostname;
    return `${urlObj.protocol}//${hostname}`;
  } catch (e) {
    console.error('Error cleaning URL:', e);
    return null;
  }
};

// Extract a stable key from a LinkedIn person URL — e.g. "linkedin.com/in/abhishekraniwala"
// Used as the unique identifier in the companies table (stored in `domain` column).
const extractPersonKey = (url: string): string | null => {
  if (!url) return null;
  try {
    let u = url.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      u = 'https://' + u;
    }
    const obj = new URL(u);
    if (!obj.hostname.includes('linkedin.com')) return null;
    // Drop country subdomain (in., uk., etc.) and any www. prefix so keys are consistent
    const host = obj.hostname.replace(/^www\./, '').replace(/^[a-z]{2}\./i, '');
    const path = obj.pathname.replace(/\/+$/, '');
    if (!path) return null;
    return `${host}${path}`.toLowerCase();
  } catch {
    return null;
  }
};

// LinkedIn person URL pattern (e.g. linkedin.com/in/abhishekraniwala, in.linkedin.com/in/...)
const LINKEDIN_PERSON_PATTERN = /(?:^|[^\w])(?:[a-z]{2}\.)?linkedin\.com\/in\/[\w\-%.]+/i;

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

// Job portal URL patterns for auto-detection
const JOB_URL_PATTERNS = [
  /linkedin\.com\/jobs/i,
  /shine\.com\/jobs/i,
  /naukri\.com\/job-listings/i,
  /naukri\.com\/job\//i,
  /indeed\.com\/viewjob/i,
  /indeed\.com\/jobs/i,
  /glassdoor\.com\/job-listing/i,
  /glassdoor\.com\/Jobs/i,
  /monster\.com\/job/i,
  /ziprecruiter\.com\/jobs/i,
  /wellfound\.com\/jobs/i,
  /angel\.co\/jobs/i,
  /lever\.co\//i,
  /greenhouse\.io\/.*\/jobs/i,
  /jobs\.lever\.co\//i,
  /boards\.greenhouse\.io\//i,
  /careers\./i,
  /\/careers\//i,
  /\/jobs\//i,
];

// Validate a job posting URL. Returns { valid: true, url } on success, or
// { valid: false, reason } with a user-friendly message. Detects LinkedIn
// search/collection URLs and suggests the canonical /jobs/view/<id> form
// when a currentJobId is available in the query string.
const validateJobUrl = (input: string): { valid: true; url: string } | { valid: false; reason: string } => {
  if (!input || !input.trim()) {
    return { valid: false, reason: 'Empty job URL.' };
  }
  let raw = input.trim();
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = 'https://' + raw;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, reason: `Not a valid URL: ${input}` };
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (host.endsWith('linkedin.com')) {
    // Canonical job posting URL: /jobs/view/<id>
    if (/^\/jobs\/view\/\d+/i.test(path)) {
      return { valid: true, url: raw };
    }
    // Search/collection URLs are not crawlable per-job — suggest the view URL
    // when we can extract a currentJobId from the query string.
    if (/^\/jobs\//i.test(path)) {
      const jobId = parsed.searchParams.get('currentJobId');
      if (jobId && /^\d+$/.test(jobId)) {
        const suggested = `https://www.linkedin.com/jobs/view/${jobId}`;
        return {
          valid: false,
          reason: `Invalid LinkedIn job URL: ${input}. This is a search URL — use the canonical job posting URL instead: ${suggested}`,
        };
      }
      return {
        valid: false,
        reason: `Invalid LinkedIn job URL: ${input}. Expected format: https://www.linkedin.com/jobs/view/<jobId>`,
      };
    }
    return {
      valid: false,
      reason: `Invalid LinkedIn job URL: ${input}. Expected format: https://www.linkedin.com/jobs/view/<jobId>`,
    };
  }

  return { valid: true, url: raw };
};

// Extract a clean company domain from a `company_website` value returned by
// the model. Returns null when the value is missing, unparseable, or points
// at a social/aggregator site (linkedin.com, facebook.com, etc.) — common
// when the model can't find the real company site and falls back to the
// LinkedIn company page.
const extractValidCompanyDomain = (companyWebsite: string | null | undefined): string | null => {
  if (!companyWebsite || typeof companyWebsite !== 'string') return null;
  const cleaned = companyWebsite
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[\/:?]/)[0]
    .toLowerCase();
  if (!cleaned || !cleaned.includes('.')) return null;
  if (INVALID_DOMAINS.some(invalid => cleaned === invalid.toLowerCase() || cleaned.endsWith('.' + invalid.toLowerCase()))) {
    return null;
  }
  return cleaned;
};

export default function CompanyResearcher() {
  // Companies context for saving summaries (but don't fetch companies list on mount)
  const { createCompany, updateCompany } = useCompanies();
  // Owner context for selected owner
  const { selectedOwner } = useOwner();
  // Auth context for user ID
  const { user } = useAuth();
  const { onboarding } = useOnboarding();
  
  const primaryUse = useMemo(
    () => onboarding?.flowType ?? onboarding?.step0?.primaryUse ?? 'fundraising',
    [onboarding]
  );
  const isFundraising = primaryUse === 'fundraising';
  const isB2B = primaryUse === 'b2b';
  
  // Personalization settings (fetched once on page load)
  const [personalizationSettings, setPersonalizationSettings] = useState<{
    direct?: { query?: string; schema?: any };
    instagram?: { systemPrompt?: string; userMessage?: string };
  } | null>(null);
  
  // Research mode: 'domain', 'instagram', 'investor', 'jobs', or 'person'
  const [researchMode, setResearchMode] = useState<'domain' | 'instagram' | 'investor' | 'jobs' | 'person'>('domain');

  // Sync researchMode when primaryUse changes
  useEffect(() => {
    if (isFundraising && researchMode !== 'investor') {
      setResearchMode('investor');
    } else if ((isB2B || !isFundraising) && researchMode === 'investor') {
      setResearchMode('domain');
    }
  }, [isFundraising, isB2B, researchMode]);

  const containsJobUrl = useCallback((text: string): boolean => {
    if (!text || typeof text !== 'string') return false;
    const lines = text.split(/[,\n]+/).map(l => l.trim()).filter(Boolean);
    return lines.some(line => JOB_URL_PATTERNS.some(pattern => pattern.test(line)));
  }, []);

  const containsLinkedInPersonUrl = useCallback((text: string): boolean => {
    if (!text || typeof text !== 'string') return false;
    return LINKEDIN_PERSON_PATTERN.test(text);
  }, []);

  // Set name for batch processing
  const [setName, setSetName] = useState('');
  const [newsInput, setNewsInput] = useState('');
  const newsDraftCacheRef = useRef<{ news: string; draft: NewsEmailOpener | null } | null>(null);
  
  // Input mode: link textarea, CSV upload, or markdown table paste
  const [inputMode, setInputMode] = useState<'link' | 'csv' | 'table'>('link');

  // Per-row news override used when processing a pasted table
  const newsOverrideRef = useRef<string | null>(null);

  // Table import state
  const [tableInput, setTableInput] = useState('');
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [tableParseError, setTableParseError] = useState<string | null>(null);
  const [isProcessingTable, setIsProcessingTable] = useState(false);
  const [tableProcessingProgress, setTableProcessingProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [pendingTableDelete, setPendingTableDelete] = useState<{ kind: 'row' | 'col'; index: number } | null>(null);

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
      instagramQualificationData: Record<string, any> | null;
      investorResearchData: {
        cleaned: string;
        skipped?: boolean;
        reason?: string;
        summary?: { entity_type?: string; is_investor?: boolean; investor_types?: string[]; clean_name?: string };
        links?: string[];
        updated?: boolean;
        contactsProcessing?: { current: number; total: number; failed: number };
      } | null;
      jobsResearchData: {
        url: string;
        summary?: JobsResearchSummary;
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
  const [csvProcessingProgress, setCsvProcessingProgress] = useState<{ current: number; total: number; contactsLabel?: string }>({ current: 0, total: 0 });
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [hasSavedProgress, setHasSavedProgress] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvDataRef = useRef<{ headers: string[]; rows: CsvRow[] } | null>(null);
  const shouldStopProcessingRef = useRef<boolean>(false);

  // Text-input batch processing progress (for large lists pasted in textarea)
  const [textBatchProgress, setTextBatchProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });

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
      instagramQualificationData: null,
      investorResearchData: null,
      jobsResearchData: null,
    };
  }, [resultsByCompany]); 

  // Get data for active company
  const { qualificationData, instagramProfileData, instagramQualificationData, investorResearchData, jobsResearchData } = activeCompany ? getCurrentCompanyData(activeCompany) : getCurrentCompanyData('');

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
    // Investor, jobs, and person modes accept various URLs - no filtering
    if (researchMode === 'investor' || researchMode === 'jobs' || researchMode === 'person') {
      return { filteredInput: input, removedDomains: [] };
    }
    const lines = input.split(/[,\n]/).map(line => line.trim()).filter(line => line.length > 0);
    const validLines: string[] = [];
    const removedDomains: string[] = [];

    lines.forEach(line => {
      // Never filter out job URLs — they should auto-switch to jobs mode
      if (JOB_URL_PATTERNS.some(pattern => pattern.test(line))) {
        validLines.push(line);
        return;
      }
      // Never filter out LinkedIn person URLs — they should auto-switch to person mode
      if (LINKEDIN_PERSON_PATTERN.test(line)) {
        validLines.push(line);
        return;
      }

      const cleanedUrl = cleanUrl(line, researchMode);
      const domain = cleanedUrl ? extractDomain(cleanedUrl) : null;

      if (domain && INVALID_DOMAINS.some(invalidDomain => domain.toLowerCase().includes(invalidDomain.toLowerCase()))) {
        removedDomains.push(line);
      } else {
        validLines.push(line);
      }
    });

    const filteredInput = validLines.join(', ');
    return { filteredInput, removedDomains };
  }, [researchMode]);

  // Parse company input into array of company names 
  const parseCompanyInput = useCallback((input: string): string[] => {
    const lines = input
      .split(/[,\n]/)
      .map(company => company.trim())
      .filter(company => company.length > 0);

    // Use Set for O(n) deduplication instead of findIndex which is O(n²)
    const seen = new Set<string>();
    const dedupe = (arr: string[]): string[] => {
      const result: string[] = [];
      for (const item of arr) {
        const key = item.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          result.push(item);
        }
      }
      return result;
    };

    if (researchMode === 'investor') {
      const cleaned = lines.map(line => {
        const { cleaned } = cleanInvestorInput(line);
        return cleaned || line;
      });
      const result = dedupe(cleaned);
      console.log('[CompanyResearchHome] parseCompanyInput (investor):', { lines: lines.length, result: result.length });
      return result;
    }

    if (researchMode === 'jobs') {
      const result = dedupe(lines.map(line => {
        let u = line.trim();
        if (u && !u.startsWith('http://') && !u.startsWith('https://')) {
          u = 'https://' + u;
        }
        return u;
      }));
      console.log('[CompanyResearchHome] parseCompanyInput (jobs):', { lines: lines.length, result: result.length });
      return result;
    }

    if (researchMode === 'person') {
      const cleaned = lines.map(line => cleanUrl(line, 'person') || line);
      const result = dedupe(cleaned);
      console.log('[CompanyResearchHome] parseCompanyInput (person):', { lines: lines.length, result: result.length });
      return result;
    }

    const cleaned = lines.map(company => {
      const c = cleanUrl(company, researchMode);
      return c || company;
    });
    return dedupe(cleaned);
  }, [researchMode]);

  const shouldGenerateNewsOpener = useMemo(
    () => isB2B && researchMode !== 'investor' && (newsInput.trim().length > 0 || newsOverrideRef.current !== null),
    [isB2B, researchMode, newsInput]
  );

  const getNewsEmailOpener = useCallback(async (): Promise<NewsEmailOpener | null> => {
    if (!isB2B || researchMode === 'investor') {
      return null;
    }

    const sourceText = newsOverrideRef.current ?? newsInput;
    const trimmedNews = (sourceText || '').trim();
    if (!trimmedNews) {
      return null;
    }

    const cached = newsDraftCacheRef.current;
    if (cached && cached.news === trimmedNews) {
      return cached.draft;
    }

    const draft = await fetchCompanyNewsEmailOpener(trimmedNews);
    newsDraftCacheRef.current = { news: trimmedNews, draft };
    return draft;
  }, [newsInput, isB2B, researchMode]);

  const mergeNewsDraftIntoSummary = useCallback(
    <T extends Record<string, any> | null | undefined>(summary: T, draft: NewsEmailOpener | null): T =>
      mergeNewsDraftIntoSummaryHelper(summary, draft),
    []
  );

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
          instagramQualificationData: null,
          investorResearchData: null,
          jobsResearchData: null,
        }
      }));
      
      setErrorsByCompany(prev => ({
        ...prev,
        [company]: {}
      }));

      try {
        const newsDraft = await getNewsEmailOpener();
        const _sourceNewsTextIg = (newsOverrideRef.current ?? newsInput).trim();
        const newsToSaveIg = newsDraft && _sourceNewsTextIg ? {
          answer: _sourceNewsTextIg,
          citations: [] as string[],
          first_line_to_start_email: newsDraft.first_line_to_start_email ?? undefined,
          subject_line: newsDraft.subject_line ?? undefined,
          date: new Date().toISOString(),
        } : null;
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
        const instagramQualificationData = mergeNewsDraftIntoSummary(
          instagramProfileData?.qualificationData || null,
          newsDraft
        );
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
                  ...(newsToSaveIg ? { news: newsToSaveIg } : {}),
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
                  ...(newsToSaveIg ? { news: newsToSaveIg } : {}),
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
    } else if (researchMode === 'investor') {
      // Investor research mode: domain or LinkedIn URL
      console.log('[CompanyResearchHome] researchCompany (investor) starting:', company);
      const { cleaned } = cleanInvestorInput(company);
      if (!cleaned) {
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: { form: `Invalid input: ${company}. Please provide a domain (e.g. boldcap.com) or LinkedIn URL.` }
        }));
        return;
      }

      setResultsByCompany(prev => ({
        ...prev,
        [company]: {
          ...prev[company],
          qualificationData: null,
          instagramProfileData: null,
          instagramQualificationData: null,
          investorResearchData: { cleaned }
        }
      }));
      setErrorsByCompany(prev => ({ ...prev, [company]: {} }));

      try {
        const data = await fetchInvestorResearch(cleaned, undefined);
        console.log('[CompanyResearchHome] researchCompany (investor) API result:', { company: cleaned, data: data ? { ...data, links: data?.links?.length } : null });
        if (data?.error) {
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: { investorResearch: data.error + (data.details ? `: ${data.details}` : '') }
          }));
          return;
        }
        setResultsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            investorResearchData: {
              cleaned: data?.cleaned || cleaned,
              skipped: data?.skipped,
              reason: data?.reason,
              summary: data?.summary,
              links: data?.links,
              updated: data?.updated,
              contactsProcessing: data?.contacts_pending ? { current: 0, total: data.contacts_pending.contacts.length, failed: 0 } : undefined,
            }
          }
        }));

        if (data?.contacts_pending?.contacts?.length) {
          const { firm_id, contacts } = data.contacts_pending;
          const result = await processContactsPending(firm_id, contacts, {
            concurrency: 3,
            maxRetries: 3,
            onProgress: (current, total, failed) => {
              setResultsByCompany(prev => {
                const existing = prev[company]?.investorResearchData;
                if (!existing) return prev;
                return {
                  ...prev,
                  [company]: {
                    ...prev[company],
                    investorResearchData: { ...existing, contactsProcessing: { current, total, failed } },
                  }
                };
              });
            },
          });
          setResultsByCompany(prev => ({
            ...prev,
            [company]: {
              ...prev[company],
              investorResearchData: prev[company]?.investorResearchData
                ? { ...prev[company].investorResearchData!, contactsProcessing: undefined }
                : (prev[company]?.investorResearchData ?? null),
            }
          }));
          setToastMessage(`Contacts: ${result.processed} processed, ${result.failed} failed${result.errors.length ? ` (${result.errors.length} errors)` : ''}`);
          setShowToast(true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: { investorResearch: msg }
        }));
      }
    } else if (researchMode === 'jobs') {
      // Jobs research mode
      console.log('[CompanyResearchHome] researchCompany (jobs) starting:', company);

      const jobCheck = validateJobUrl(company);
      if (!jobCheck.valid) {
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: { form: jobCheck.reason }
        }));
        return;
      }

      setResultsByCompany(prev => ({
        ...prev,
        [company]: {
          ...prev[company],
          qualificationData: null,
          instagramProfileData: null,
          instagramQualificationData: null,
          investorResearchData: null,
          jobsResearchData: { url: company },
        }
      }));
      setErrorsByCompany(prev => ({ ...prev, [company]: {} }));

      try {
        const newsDraft = await getNewsEmailOpener();
        const _sourceNewsTextJobs = (newsOverrideRef.current ?? newsInput).trim();
        const newsToSaveJobs = newsDraft && _sourceNewsTextJobs ? {
          answer: _sourceNewsTextJobs,
          citations: [] as string[],
          first_line_to_start_email: newsDraft.first_line_to_start_email ?? undefined,
          subject_line: newsDraft.subject_line ?? undefined,
          date: new Date().toISOString(),
        } : null;
        const data = await fetchJobsResearch(company);
        console.log('[CompanyResearchHome] researchCompany (jobs) API result:', data);
        if (data?.error) {
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: { jobsResearch: data.error + (data.details ? `: ${data.details}` : '') }
          }));
          return;
        }

        const summary = mergeNewsDraftIntoSummary(data?.summary, newsDraft);
        setResultsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            jobsResearchData: {
              url: data?.url || company,
              summary,
            },
          }
        }));

        // Save as company in database using extracted company info
        if (summary?.company_name) {
          try {
            if (!user) {
              console.error('User not available, cannot save company');
              return;
            }

            const companyDomain = extractValidCompanyDomain(summary.company_website);
            if (summary.company_website && !companyDomain) {
              console.warn('[CompanyResearchHome] Dropping invalid company_website for', company, '→', summary.company_website);
            }

            const qualificationSummary: Record<string, any> = {
              ...summary,
              company_website: companyDomain || '',
              source_job_url: data?.url || company,
            };

            if (companyDomain) {
              const { data: existingCompanyData } = await supabase
                .from('companies')
                .select('id, domain, email, phone')
                .eq('user_id', user.id)
                .eq('domain', companyDomain)
                .maybeSingle();

              if (existingCompanyData) {
                await updateCompany(existingCompanyData.id, {
                  summary: qualificationSummary,
                  email: existingCompanyData.email || '',
                  phone: existingCompanyData.phone || '',
                  owner: selectedOwner,
                  ...(newsToSaveJobs ? { news: newsToSaveJobs } : {}),
                });
              } else {
                await createCompany({
                  domain: companyDomain,
                  instagram: '',
                  summary: qualificationSummary,
                  email: '',
                  phone: '',
                  set_name: setName || null,
                  owner: selectedOwner,
                  ...(newsToSaveJobs ? { news: newsToSaveJobs } : {}),
                });
              }
            } else {
              await createCompany({
                domain: '',
                instagram: '',
                summary: qualificationSummary,
                email: '',
                phone: '',
                set_name: setName || null,
                owner: selectedOwner,
                ...(newsToSaveJobs ? { news: newsToSaveJobs } : {}),
              });
            }
          } catch (saveError) {
            console.error('Error saving company from job research:', saveError);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: { jobsResearch: msg }
        }));
      }
    } else if (researchMode === 'person') {
      // Person research mode — uses the same fetchCompanyMap pipeline as company analysis
      // but passes the full LinkedIn /in/<handle> URL so Exa crawls the person page.
      console.log('[CompanyResearchHome] researchCompany (person) starting:', company);

      const cleanedUrl = cleanUrl(company, 'person');
      if (!cleanedUrl || !/linkedin\.com\/in\//i.test(cleanedUrl)) {
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: { form: `Invalid LinkedIn person URL: ${company}. Expected format like https://in.linkedin.com/in/handle` }
        }));
        return;
      }

      const personKey = extractPersonKey(cleanedUrl) || cleanedUrl;

      setResultsByCompany(prev => ({
        ...prev,
        [company]: {
          qualificationData: null,
          instagramProfileData: null,
          instagramQualificationData: null,
          investorResearchData: null,
          jobsResearchData: null,
        }
      }));
      setErrorsByCompany(prev => ({ ...prev, [company]: {} }));

      try {
        const newsDraft = await getNewsEmailOpener();
        const _sourceNewsTextPerson = (newsOverrideRef.current ?? newsInput).trim();
        const newsToSavePerson = newsDraft && _sourceNewsTextPerson ? {
          answer: _sourceNewsTextPerson,
          citations: [] as string[],
          first_line_to_start_email: newsDraft.first_line_to_start_email ?? undefined,
          subject_line: newsDraft.subject_line ?? undefined,
          date: new Date().toISOString(),
        } : null;
        let qualificationData = null;

        try {
          const rawQualificationData = await fetchCompanyMap(cleanedUrl, user?.id, personalizationSettings?.direct || null);
          qualificationData = mergeNewsDraftIntoSummary(rawQualificationData, newsDraft);
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
          console.error('Error fetching person qualification:', error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: {
              ...prev[company],
              qualificationData: 'Could not load qualification data.'
            }
          }));
          sendSlackNotification(`❌ Unexpected error for ${company}\nError: ${errorMessage}`).catch(
            (slackError) => console.error('Failed to send Slack notification:', slackError)
          );
        }

        setResultsByCompany(prev => ({
          ...prev,
          [company]: {
            ...prev[company],
            ...(qualificationData && { qualificationData: qualificationData })
          }
        }));

        // Save/update in companies table — keyed by the LinkedIn handle path stored in `domain`.
        if (qualificationData) {
          try {
            if (!user) {
              console.error('User not available, cannot save person');
              return;
            }
            const email = qualificationData.email || null;
            const phone = qualificationData.phone || null;

            const { data: existingCompanyData } = await supabase
              .from('companies')
              .select('id, instagram, domain, email, phone')
              .eq('user_id', user.id)
              .eq('domain', personKey)
              .maybeSingle();

            if (existingCompanyData) {
              await updateCompany(existingCompanyData.id, {
                summary: qualificationData,
                instagram: existingCompanyData.instagram || '',
                email: email || existingCompanyData.email || '',
                phone: phone || existingCompanyData.phone || '',
                owner: selectedOwner,
                ...(newsToSavePerson ? { news: newsToSavePerson } : {}),
              });
            } else {
              await createCompany({
                domain: personKey,
                instagram: '',
                summary: qualificationData,
                email: email || '',
                phone: phone || '',
                set_name: setName || null,
                owner: selectedOwner,
                ...(newsToSavePerson ? { news: newsToSavePerson } : {}),
              });
            }
          } catch (saveError) {
            console.error('Error saving person to database:', saveError);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: { ...prev[company], general: errorMessage }
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
          instagramQualificationData: null,
          investorResearchData: null,
          jobsResearchData: null,
        }
      }));
      
      setErrorsByCompany(prev => ({
        ...prev,
        [company]: {}
      }));

      try {
        const newsDraft = await getNewsEmailOpener();
        const _sourceNewsText = (newsOverrideRef.current ?? newsInput).trim();
        const newsToSave = newsDraft && _sourceNewsText ? {
          answer: _sourceNewsText,
          citations: [] as string[],
          first_line_to_start_email: newsDraft.first_line_to_start_email ?? undefined,
          subject_line: newsDraft.subject_line ?? undefined,
          date: new Date().toISOString(),
        } : null;
        // Fetch company qualification data
        let qualificationData = null;
        
        try {
          const rawQualificationData = await fetchCompanyMap(domainName, user?.id, personalizationSettings?.direct || null);
          qualificationData = mergeNewsDraftIntoSummary(rawQualificationData, newsDraft);
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
                ...(newsToSave ? { news: newsToSave } : {}),
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
                ...(newsToSave ? { news: newsToSave } : {}),
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
  }, [researchMode, createCompany, updateCompany, selectedOwner, user, personalizationSettings, getNewsEmailOpener, mergeNewsDraftIntoSummary]);

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
    researchMode: 'domain' | 'instagram' | 'investor' | 'jobs' | 'person'
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
        } else if (researchMode === 'investor') {
          if (url && (url.includes('.') || url.toLowerCase().includes('linkedin'))) {
            const { cleaned } = cleanInvestorInput(url);
            if (cleaned) {
              isProcessed = qualificationDataMap.has(cleaned) || errorMap.has(cleaned) ||
                           !!(row['Research Status'] && row['Research Status'].trim() !== '');
            }
          }
        } else if (researchMode === 'jobs') {
          if (url && url.includes('.')) {
            const cleaned = cleanUrl(url, 'jobs');
            if (cleaned) {
              isProcessed = qualificationDataMap.has(cleaned) || errorMap.has(cleaned) ||
                           !!(row['Research Status'] && row['Research Status'].trim() !== '');
            }
          }
        } else if (researchMode === 'person') {
          if (url && /linkedin\.com\/in\//i.test(url)) {
            const cleaned = cleanUrl(url, 'person');
            if (cleaned) {
              isProcessed = qualificationDataMap.has(cleaned) || errorMap.has(cleaned) ||
                           !!(row['Research Status'] && row['Research Status'].trim() !== '');
            }
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
              writeSummaryToCsvRow(domainQualificationData, updatedRow);
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
              writeSummaryToCsvRow(instagramQualificationData, updatedRow);
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
                  writeSummaryToCsvRow(profileData.qualificationData, updatedRow);
                }
              } else {
                const error = errorMap.get(url);
                updatedRow['Research Status'] = error || 'Failed to fetch Instagram profile data';
              }
            }
          } else if (researchMode === 'investor') {
            if (url && (url.includes('.') || url.toLowerCase().includes('linkedin'))) {
              const { cleaned } = cleanInvestorInput(url);
              const investorData = cleaned ? qualificationDataMap.get(cleaned) : null;
              const investorError = cleaned ? errorMap.get(cleaned) : null;
              if (investorData && !investorData.error) {
                updatedRow['Research Status'] = investorData.skipped
                  ? (investorData.reason === 'not_an_investor' || investorData.reason === 'not_investor' ? 'skipped (not an investor)' : 'skipped (exists)')
                  : 'completed';
                updatedRow['Cleaned URL'] = investorData.cleaned || cleaned;
                if (investorData.summary) {
                  updatedRow['Entity Type'] = investorData.summary.entity_type || '';
                  updatedRow['Is Investor'] = investorData.summary.is_investor ? 'Yes' : 'No';
                  updatedRow['Clean Name'] = investorData.summary.clean_name || '';
                  updatedRow['Investor Types'] = investorData.summary.investor_types?.join(', ') || '';
                }
                if (investorData.links?.length) {
                  updatedRow['Links'] = investorData.links.join('; ');
                }
              } else if (investorError) {
                updatedRow['Research Status'] = investorError;
              } else {
                updatedRow['Research Status'] = 'Failed to fetch investor data';
              }
            }
          } else if (researchMode === 'jobs') {
            if (url && url.includes('.')) {
              const cleaned = cleanUrl(url, 'jobs');
              const jobData = cleaned ? qualificationDataMap.get(cleaned) : null;
              const jobError = cleaned ? errorMap.get(cleaned) : null;
              if (jobData && !jobData.error) {
                updatedRow['Research Status'] = 'completed';
                const s = jobData.summary || {};
                writeSummaryToCsvRow(s, updatedRow);
                if (s.company_website) {
                  updatedRow['Company Website'] = extractValidCompanyDomain(s.company_website) || '';
                }
              } else if (jobError) {
                updatedRow['Research Status'] = jobError;
              } else {
                updatedRow['Research Status'] = 'Failed to fetch job data';
              }
            }
          } else if (researchMode === 'person') {
            if (url && /linkedin\.com\/in\//i.test(url)) {
              const cleaned = cleanUrl(url, 'person');
              const personData = cleaned ? qualificationDataMap.get(cleaned) : null;
              const personError = cleaned ? errorMap.get(cleaned) : null;
              if (personData) {
                updatedRow['Research Status'] = 'completed';
                writeSummaryToCsvRow(personData, updatedRow);
              } else if (personError) {
                updatedRow['Research Status'] = personError;
              } else {
                updatedRow['Research Status'] = 'Failed to fetch person qualification data';
              }
            }
          } else {
            const cleanedUrl = cleanUrl(url, researchMode);
            const domainNameValue = cleanedUrl ? extractDomain(cleanedUrl) : extractDomain(url);
            const qualificationData = domainNameValue ? qualificationDataMap.get(domainNameValue) : null;

            if (qualificationData) {
              updatedRow['Research Status'] = 'completed';
              writeSummaryToCsvRow(qualificationData, updatedRow);
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
    const CONCURRENCY_LIMIT = 30;
    const newsDraft = await getNewsEmailOpener();

    // Helper function to save progress after each row is processed
    const saveProgressAfterRow = (mode: 'domain' | 'instagram' | 'investor' | 'jobs' | 'person', identifier: string) => {
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
                writeSummaryToCsvRow(domainQualificationData, updatedRow);
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
                writeSummaryToCsvRow(instagramQualificationData, updatedRow);
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
            
            if (mode === 'investor') {
              if (!url || (!url.includes('.') && !url.toLowerCase().includes('linkedin'))) {
                if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
                  updatedRow['Research Status'] = 'skipped (no valid domain or LinkedIn URL)';
                }
                return updatedRow;
              }
              const { cleaned } = cleanInvestorInput(url);
              const investorData = cleaned ? qualificationDataMap.get(cleaned) : null;
              const investorError = cleaned ? errorMap.get(cleaned) : null;
              if (investorData && !investorData.error) {
                updatedRow['Research Status'] = investorData.skipped
                  ? (investorData.reason === 'not_an_investor' || investorData.reason === 'not_investor' ? 'skipped (not an investor)' : 'skipped (exists)')
                  : 'completed';
                updatedRow['Cleaned URL'] = investorData.cleaned || cleaned;
                if (investorData.summary) {
                  updatedRow['Entity Type'] = investorData.summary.entity_type || '';
                  updatedRow['Is Investor'] = investorData.summary.is_investor ? 'Yes' : 'No';
                  updatedRow['Clean Name'] = investorData.summary.clean_name || '';
                  updatedRow['Investor Types'] = investorData.summary.investor_types?.join(', ') || '';
                }
                if (investorData.links?.length) {
                  updatedRow['Links'] = investorData.links.join('; ');
                }
              } else if (investorError) {
                updatedRow['Research Status'] = investorError;
              } else {
                updatedRow['Research Status'] = 'Failed to fetch investor data';
              }
              return updatedRow;
            }
            
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
                  writeSummaryToCsvRow(profileData.qualificationData, updatedRow);
                }
              } else {
                const error = errorMap.get(url);
                updatedRow['Research Status'] = error || 'Failed to fetch Instagram profile data';
              }
            } else if (mode === 'person') {
              if (!url || !/linkedin\.com\/in\//i.test(url)) {
                if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
                  updatedRow['Research Status'] = 'skipped (not LinkedIn person URL)';
                }
                return updatedRow;
              }
              const cleaned = cleanUrl(url, 'person');
              const personData = cleaned ? qualificationDataMap.get(cleaned) : null;
              if (personData) {
                updatedRow['Research Status'] = 'completed';
                writeSummaryToCsvRow(personData, updatedRow);
              } else if (cleaned) {
                const error = errorMap.get(cleaned);
                updatedRow['Research Status'] = error || 'Failed to fetch person qualification data';
              } else {
                updatedRow['Research Status'] = 'Invalid URL';
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
                writeSummaryToCsvRow(qualificationData, updatedRow);
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
                writeSummaryToCsvRow(domainQualificationData, updatedRow);
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
                writeSummaryToCsvRow(instagramQualificationData, updatedRow);
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
                    writeSummaryToCsvRow(profileData.qualificationData, updatedRow);
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
                writeSummaryToCsvRow(qualificationData, updatedRow);
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
        } else if (researchMode === 'investor') {
          if (url && (url.includes('.') || url.toLowerCase().includes('linkedin'))) {
            const { cleaned } = cleanInvestorInput(url);
            if (cleaned) allValidUrls.push(cleaned);
          }
        } else if (researchMode === 'jobs') {
          if (url && url.includes('.')) {
            const cleaned = cleanUrl(url, 'jobs');
            if (cleaned) allValidUrls.push(cleaned);
          }
        } else if (researchMode === 'person') {
          if (url && /linkedin\.com\/in\//i.test(url)) {
            const cleaned = cleanUrl(url, 'person');
            if (cleaned) allValidUrls.push(cleaned);
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
        } else if (researchMode === 'investor') {
          // Investor mode: include domain or LinkedIn URLs
          if (!url || (!url.includes('.') && !url.toLowerCase().includes('linkedin'))) {
            return false;
          }
          const { cleaned } = cleanInvestorInput(url);
          if (!cleaned) return false;
        } else if (researchMode === 'jobs') {
          // Jobs mode: include any URL with a dot
          if (!url || !url.includes('.')) {
            return false;
          }
        } else if (researchMode === 'person') {
          // Person mode: include only LinkedIn person URLs
          if (!url || !/linkedin\.com\/in\//i.test(url)) {
            return false;
          }
          const cleaned = cleanUrl(url, 'person');
          if (!cleaned) return false;
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
              const rawData = await fetchCompanyMap(domainName, user?.id, personalizationSettings?.direct || null);
              const data = mergeNewsDraftIntoSummary(rawData, newsDraft);
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
                const mergedProfileData = data.qualificationData
                  ? { ...data, qualificationData: mergeNewsDraftIntoSummary(data.qualificationData, newsDraft) }
                  : data;
                qualificationDataMap.set(instagramUrl, mergedProfileData);
                
                // Save companies immediately after getting response for all rows with this Instagram URL
                const rowsForInstagram = instagramUrlToRowsMap.get(instagramUrl) || [];
                for (const row of rowsForInstagram) {
                  if (mergedProfileData.qualificationData) {
                    await saveCompanyForRow(row, mergedProfileData.qualificationData, 'instagram', instagramUrl);
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
              const mergedProfileData = data.qualificationData
                ? { ...data, qualificationData: mergeNewsDraftIntoSummary(data.qualificationData, newsDraft) }
                : data;
              qualificationDataMap.set(instagramUrl, mergedProfileData); // Reusing map for Instagram profiles
              
              // Save/update company in database after summary is generated
              if (mergedProfileData.qualificationData) {
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
                        summary: mergedProfileData.qualificationData,
                        domain: existingCompany.domain || '', // Keep existing domain if any
                        owner: selectedOwner,
                      });
                    } else {
                      // Create new company
                      await createCompany({
                        domain: '',
                        instagram: username,
                        summary: mergedProfileData.qualificationData,
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
    } else if (researchMode === 'investor') {
      // Investor mode: single column with domain or LinkedIn URLs
      console.log('[CompanyResearchHome] processCsvRows investor mode:', { rowsToProcess: rowsToProcess.length, selectedUrlColumn });
      if (!savedProgress) {
        const uniqueCleaned = new Set<string>();
        rowsToProcess.forEach(row => {
          const url = row[selectedUrlColumn!]?.trim() || '';
          if (url) {
            const { cleaned } = cleanInvestorInput(url);
            if (cleaned) uniqueCleaned.add(cleaned);
          }
        });
        uniqueDomainsArray = Array.from(uniqueCleaned);
        console.log('[CompanyResearchHome] processCsvRows investor unique URLs:', uniqueDomainsArray);
      }

      const investorUrlsToProcess = uniqueDomainsArray.slice(startFromIndex);
      console.log('[CompanyResearchHome] processCsvRows investor batch:', { startFromIndex, toProcess: investorUrlsToProcess.length, total: uniqueDomainsArray.length });

      // Collect contacts_pending items to process AFTER all primary investor research
      // This avoids nested concurrency (30 investors × 5 contacts = 150 simultaneous requests)
      const deferredContacts: { firmId: string; contacts: { input: string; affiliateContactEmail?: string; full_name?: string }[] }[] = [];

      await processInBatches(
        investorUrlsToProcess,
        async (cleanedUrl, batchIndex) => {
          const actualIndex = startFromIndex + batchIndex;
          try {
            const data = await fetchInvestorResearch(cleanedUrl, undefined);
            if (data?.error) {
              errorMap.set(cleanedUrl, data.error + (data.details ? `: ${data.details}` : ''));
            } else {
              qualificationDataMap.set(cleanedUrl, data);
              // Defer contacts processing to avoid nested concurrency explosion
              if (data?.contacts_pending?.contacts?.length) {
                deferredContacts.push({ firmId: data.contacts_pending.firm_id, contacts: data.contacts_pending.contacts });
              }
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            errorMap.set(cleanedUrl, msg);
          }
          processedDomainIndices.push(actualIndex);
          saveProgressAfterRow('investor', cleanedUrl);
          return cleanedUrl;
        },
        CONCURRENCY_LIMIT,
        (processed, total) => {
          setCsvProcessingProgress({ current: startFromIndex + processed, total: uniqueDomainsArray.length });
        }
      );

      // Process deferred contacts sequentially (one firm at a time) to avoid overloading
      if (deferredContacts.length > 0 && !shouldStopProcessingRef.current) {
        console.log(`[CompanyResearchHome] Processing deferred contacts for ${deferredContacts.length} firms`);
        let contactsFirmsDone = 0;
        for (const { firmId, contacts } of deferredContacts) {
          if (shouldStopProcessingRef.current) break;
          setCsvProcessingProgress(prev => ({
            ...prev,
            contactsLabel: `Contacts: firm ${contactsFirmsDone + 1}/${deferredContacts.length}`,
          }));
          await processContactsPending(firmId, contacts, {
            concurrency: 3,
            maxRetries: 3,
            onProgress: (current, total, failed) => {
              setCsvProcessingProgress(prev => ({
                ...prev,
                contactsLabel: `Contacts: firm ${contactsFirmsDone + 1}/${deferredContacts.length} — ${current}/${total}${failed ? ` (${failed} failed)` : ''}`,
              }));
            },
          });
          contactsFirmsDone++;
        }
        setCsvProcessingProgress(prev => ({ ...prev, contactsLabel: undefined }));
      }

      if (shouldStopProcessingRef.current) {
        const currentCsvData = csvDataRef.current || csvData;
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
    } else if (researchMode === 'jobs') {
      // Jobs mode: single column with job posting URLs
      console.log('[CompanyResearchHome] processCsvRows jobs mode:', { rowsToProcess: rowsToProcess.length, selectedUrlColumn });
      if (!savedProgress) {
        const uniqueUrls = new Set<string>();
        rowsToProcess.forEach(row => {
          const url = row[selectedUrlColumn!]?.trim() || '';
          if (url && url.includes('.')) {
            const cleaned = cleanUrl(url, 'jobs');
            if (cleaned) uniqueUrls.add(cleaned);
          }
        });
        uniqueDomainsArray = Array.from(uniqueUrls);
        console.log('[CompanyResearchHome] processCsvRows jobs unique URLs:', uniqueDomainsArray.length);
      }

      const jobUrlsToProcess = uniqueDomainsArray.slice(startFromIndex);

      await processInBatches(
        jobUrlsToProcess,
        async (jobUrl, batchIndex) => {
          const actualIndex = startFromIndex + batchIndex;
          try {
            const jobCheck = validateJobUrl(jobUrl);
            if (!jobCheck.valid) {
              errorMap.set(jobUrl, jobCheck.reason);
            } else {
            const data = await fetchJobsResearch(jobUrl);
            if (data?.error) {
              errorMap.set(jobUrl, data.error + (data.details ? `: ${data.details}` : ''));
            } else {
              const mergedJobData = data?.summary
                ? { ...data, summary: mergeNewsDraftIntoSummary(data.summary, newsDraft) }
                : data;
              qualificationDataMap.set(jobUrl, mergedJobData);

              // Save as company
              const summary = mergedJobData?.summary;
              if (summary?.company_name && user) {
                try {
                  const companyDomain = extractValidCompanyDomain(summary.company_website);
                  if (summary.company_website && !companyDomain) {
                    console.warn('[CompanyResearchHome] Dropping invalid company_website for', jobUrl, '→', summary.company_website);
                  }

                  const qualificationSummary: Record<string, any> = {
                    ...summary,
                    company_website: companyDomain || '',
                    source_job_url: mergedJobData?.url || jobUrl,
                  };

                  if (companyDomain) {
                    const { data: existingCompanyData } = await supabase
                      .from('companies')
                      .select('id, domain, email, phone')
                      .eq('user_id', user.id)
                      .eq('domain', companyDomain)
                      .maybeSingle();

                    if (existingCompanyData) {
                      await updateCompany(existingCompanyData.id, {
                        summary: qualificationSummary,
                        email: existingCompanyData.email || '',
                        phone: existingCompanyData.phone || '',
                        owner: selectedOwner,
                      });
                    } else {
                      await createCompany({
                        domain: companyDomain,
                        instagram: '',
                        summary: qualificationSummary,
                        email: '',
                        phone: '',
                        set_name: setName || null,
                        owner: selectedOwner,
                      });
                    }
                  } else {
                    await createCompany({
                      domain: '',
                      instagram: '',
                      summary: qualificationSummary,
                      email: '',
                      phone: '',
                      set_name: setName || null,
                      owner: selectedOwner,
                    });
                  }
                } catch (saveError) {
                  console.error('Error saving company from job CSV processing:', saveError);
                }
              }
            }
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            errorMap.set(jobUrl, msg);
          }
          processedDomainIndices.push(actualIndex);
          saveProgressAfterRow('jobs', jobUrl);
          return jobUrl;
        },
        CONCURRENCY_LIMIT,
        (processed, total) => {
          setCsvProcessingProgress({ current: startFromIndex + processed, total: uniqueDomainsArray.length });
        }
      );

      if (shouldStopProcessingRef.current) {
        const currentCsvData = csvDataRef.current || csvData;
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
    } else if (researchMode === 'person') {
      // Person mode: single column with LinkedIn person URLs, processed via fetchCompanyMap
      console.log('[CompanyResearchHome] processCsvRows person mode:', { rowsToProcess: rowsToProcess.length, selectedUrlColumn });
      if (!savedProgress) {
        const uniqueUrls = new Set<string>();
        rowsToProcess.forEach(row => {
          const url = row[selectedUrlColumn!]?.trim() || '';
          if (url && /linkedin\.com\/in\//i.test(url)) {
            const cleaned = cleanUrl(url, 'person');
            if (cleaned) uniqueUrls.add(cleaned);
          }
        });
        uniqueDomainsArray = Array.from(uniqueUrls);
        console.log('[CompanyResearchHome] processCsvRows person unique URLs:', uniqueDomainsArray.length);
      }

      const personUrlsToProcess = uniqueDomainsArray.slice(startFromIndex);

      await processInBatches(
        personUrlsToProcess,
        async (personUrl, batchIndex) => {
          const actualIndex = startFromIndex + batchIndex;
          const personKey = extractPersonKey(personUrl) || personUrl;
          try {
            const rawData = await fetchCompanyMap(personUrl, user?.id, personalizationSettings?.direct || null);
            const data = mergeNewsDraftIntoSummary(rawData, newsDraft);
            if (data) {
              qualificationDataMap.set(personUrl, data);

              try {
                if (!user) {
                  console.error('User not available, cannot save person');
                  return personUrl;
                }
                const email = data.email || null;
                const phone = data.phone || null;

                const { data: existingCompanyData } = await supabase
                  .from('companies')
                  .select('id, instagram, domain, email, phone')
                  .eq('user_id', user.id)
                  .eq('domain', personKey)
                  .maybeSingle();

                if (existingCompanyData) {
                  await updateCompany(existingCompanyData.id, {
                    summary: data,
                    instagram: existingCompanyData.instagram || '',
                    email: email || existingCompanyData.email || '',
                    phone: phone || existingCompanyData.phone || '',
                    owner: selectedOwner,
                  });
                } else {
                  await createCompany({
                    domain: personKey,
                    instagram: '',
                    summary: data,
                    email: email || '',
                    phone: phone || '',
                    set_name: setName || null,
                    owner: selectedOwner,
                  });
                }
              } catch (saveError) {
                console.error('Error saving person to database during CSV processing:', saveError);
              }
            } else {
              errorMap.set(personUrl, 'Failed to fetch person qualification data');
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            errorMap.set(personUrl, msg);
          }
          processedDomainIndices.push(actualIndex);
          saveProgressAfterRow('person', personUrl);
          return personUrl;
        },
        CONCURRENCY_LIMIT,
        (processed, total) => {
          setCsvProcessingProgress({ current: startFromIndex + processed, total: uniqueDomainsArray.length });
        }
      );

      if (shouldStopProcessingRef.current) {
        const currentCsvData = csvDataRef.current || csvData;
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
            const rawData = await fetchCompanyMap(domainName, user?.id, personalizationSettings?.direct || null);
            const data = mergeNewsDraftIntoSummary(rawData, newsDraft);
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
            writeSummaryToCsvRow(domainQualificationData, updatedRow);
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
            writeSummaryToCsvRow(instagramQualificationData, updatedRow);
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
      } else if (researchMode === 'jobs') {
        // Jobs mode: update with job research data
        if (!url || !url.includes('.')) {
          if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
            updatedRow['Research Status'] = 'skipped (invalid URL)';
          }
          return updatedRow;
        }

        const cleaned = cleanUrl(url, 'jobs');
        const jobData = cleaned ? qualificationDataMap.get(cleaned) : null;
        const jobError = cleaned ? errorMap.get(cleaned) : null;

        if (jobData && !jobData.error) {
          updatedRow['Research Status'] = 'completed';
          const s = jobData.summary || {};
          writeSummaryToCsvRow(s, updatedRow);
          if (s.company_website) {
            updatedRow['Company Website'] = extractValidCompanyDomain(s.company_website) || '';
          }
        } else if (jobError) {
          updatedRow['Research Status'] = jobError;
        } else {
          updatedRow['Research Status'] = 'Failed to fetch job data';
        }
      } else if (researchMode === 'person') {
        // Person mode: update with company-style qualification data fetched from LinkedIn person URL
        if (!url || !/linkedin\.com\/in\//i.test(url)) {
          if (!updatedRow['Research Status'] || updatedRow['Research Status'].trim() === '') {
            updatedRow['Research Status'] = 'skipped (not LinkedIn person URL)';
          }
          return updatedRow;
        }
        const cleaned = cleanUrl(url, 'person');
        const personData = cleaned ? qualificationDataMap.get(cleaned) : null;
        const personError = cleaned ? errorMap.get(cleaned) : null;
        if (personData) {
          updatedRow['Research Status'] = 'completed';
          writeSummaryToCsvRow(personData, updatedRow);
        } else if (personError) {
          updatedRow['Research Status'] = personError;
        } else {
          updatedRow['Research Status'] = 'Failed to fetch person qualification data';
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
          writeSummaryToCsvRow(qualificationData, updatedRow);
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
            instagramQualificationData: instagramQualificationData || null,
            investorResearchData: null,
            jobsResearchData: null,
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
                instagramQualificationData: instagramQualificationData,
                investorResearchData: null,
                jobsResearchData: null,
              };
            }
          } else if (researchMode === 'investor') {
            const { cleaned } = cleanInvestorInput(url);
            const investorData = cleaned ? qualificationDataMap.get(cleaned) : null;
            if (investorData && !investorData.error) {
              newResults[cleaned] = {
                qualificationData: null,
                instagramProfileData: null,
                instagramQualificationData: null,
                investorResearchData: {
                  cleaned: investorData.cleaned || cleaned,
                  skipped: investorData.skipped,
                  reason: investorData.reason,
                  summary: investorData.summary,
                  links: investorData.links,
                  updated: investorData.updated,
                },
                jobsResearchData: null,
              };
            }
          } else if (researchMode === 'jobs') {
            const cleaned = cleanUrl(url, 'jobs');
            const jobData = cleaned ? qualificationDataMap.get(cleaned) : null;
            if (cleaned && jobData && !jobData.error) {
              newResults[cleaned] = {
                qualificationData: null,
                instagramProfileData: null,
                instagramQualificationData: null,
                investorResearchData: null,
                jobsResearchData: {
                  url: jobData.url || cleaned,
                  summary: jobData.summary,
                },
              };
            }
          } else if (researchMode === 'person') {
            const cleaned = cleanUrl(url, 'person');
            const personData = cleaned ? qualificationDataMap.get(cleaned) : null;
            if (cleaned && personData) {
              newResults[cleaned] = {
                qualificationData: personData,
                instagramProfileData: null,
                instagramQualificationData: null,
                investorResearchData: null,
                jobsResearchData: null,
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
                instagramQualificationData: null,
                investorResearchData: null,
                jobsResearchData: null,
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
  }, [csvData, selectedUrlColumn, selectedColumns, rawCompanyInput, activeCompany, parseCompanyInput, researchMode, createCompany, updateCompany, selectedOwner, user, personalizationSettings, getNewsEmailOpener, mergeNewsDraftIntoSummary]);

  // Switch between Link, CSV, and Table input modes; clears entries from the other tabs
  const handleSwitchInputMode = useCallback((mode: 'link' | 'csv' | 'table') => {
    setInputMode(prev => {
      if (prev === mode) return prev;
      // Always clear the link textarea + news (only Link tab uses these)
      if (mode !== 'link') {
        setRawCompanyInput('');
        setNewsInput('');
        newsDraftCacheRef.current = null;
      }
      // Clear CSV state unless going to CSV
      if (mode !== 'csv') {
        setCsvData(null);
        setSelectedUrlColumn(null);
        setSelectedColumns({ domain: null, instagram: null });
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
      // Clear table state unless going to Table
      if (mode !== 'table') {
        setTableInput('');
        setTableData(null);
        setTableParseError(null);
      }
      return mode;
    });
  }, []);

  // Clear all data function
  const handleClearAll = useCallback(() => {
    // Stop any in-flight batch processing (text-input or CSV)
    shouldStopProcessingRef.current = true;
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
    setTextBatchProgress({ current: 0, total: 0 });
    clearCsvProgress();
    setHasSavedProgress(false);
    setSetName('');
    setNewsInput('');
    newsDraftCacheRef.current = null;
    newsOverrideRef.current = null;
    setTableInput('');
    setTableData(null);
    setTableParseError(null);
    setIsProcessingTable(false);
    setTableProcessingProgress({ current: 0, total: 0 });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Parse the table input (markdown table or JSON array of objects) and
  // auto-detect/move the domain column to the front.
  const handleParseTable = useCallback(() => {
    const trimmed = tableInput.trim();
    const looksLikeJson = trimmed.startsWith('[') || trimmed.startsWith('{');
    let parsed: TableData | null = null;
    if (looksLikeJson) {
      const jsonResult = parseJsonArrayDetailed(tableInput);
      if (!jsonResult.ok) {
        setTableData(null);
        setTableParseError(jsonResult.error);
        return;
      }
      parsed = jsonResult.table;
    } else {
      parsed = parseMarkdownTable(tableInput);
    }
    if (!parsed) {
      setTableData(null);
      setTableParseError('Could not parse input. Provide a markdown table (header row + dashes separator + data rows) or a JSON array of objects.');
      return;
    }
    const domainIdx = detectDomainColumnIndex(parsed.headers, parsed.rows);
    const reordered = moveColumnToFront(parsed, domainIdx);
    // Normalize each row's domain cell (strip protocol/www/path, lowercase) and
    // drop rows whose domain is empty or invalid. Dedupe by normalized domain.
    const seenDomains = new Set<string>();
    const normalizedRows: string[][] = [];
    let droppedInvalid = 0;
    let droppedDuplicate = 0;
    for (const row of reordered.rows) {
      const raw = (row[0] || '').trim();
      const normalized = (extractDomain(raw) || '').toLowerCase();
      if (!normalized || !isLikelyDomain(normalized)) {
        droppedInvalid++;
        continue;
      }
      if (seenDomains.has(normalized)) {
        droppedDuplicate++;
        continue;
      }
      seenDomains.add(normalized);
      normalizedRows.push([normalized, ...row.slice(1)]);
    }
    if (normalizedRows.length === 0) {
      setTableData(null);
      setTableParseError('No rows have a valid domain in the detected domain column.');
      return;
    }
    setTableData({ headers: reordered.headers, rows: normalizedRows });
    const notes: string[] = [];
    if (droppedInvalid > 0) notes.push(`skipped ${droppedInvalid} row${droppedInvalid === 1 ? '' : 's'} with no valid domain`);
    if (droppedDuplicate > 0) notes.push(`removed ${droppedDuplicate} duplicate domain${droppedDuplicate === 1 ? '' : 's'}`);
    setTableParseError(notes.length > 0 ? `${notes.join('; ')}.` : null);
  }, [tableInput]);

  const handleRemoveTableColumn = useCallback((colIndex: number) => {
    setTableData(prev => (prev ? removeColumnAt(prev, colIndex) : prev));
  }, []);

  const handleRemoveTableRow = useCallback((rowIndex: number) => {
    setTableData(prev => (prev ? removeRowAt(prev, rowIndex) : prev));
  }, []);

  // Process table rows: domain column = company URL, other columns = per-row news context
  const processTableRows = useCallback(async () => {
    if (!tableData || tableData.rows.length === 0) return;

    const domainColIndex = 0;
    const validRows = tableData.rows
      .map((row, originalIndex) => ({ row, originalIndex }))
      .filter(({ row }) => isLikelyDomain(row[domainColIndex]));

    if (validRows.length === 0) {
      setTableParseError('No rows have a valid domain in the domain column.');
      return;
    }

    setTableParseError(null);
    setIsProcessingTable(true);
    shouldStopProcessingRef.current = false;
    setTableProcessingProgress({ current: 0, total: validRows.length });

    const companies = validRows.map(({ row }) => (row[domainColIndex] || '').trim());
    setErrorsByCompany({});
    setSubmittedCompanies(companies);
    setActiveCompany(companies[0]);

    // Sequential processing because the per-row news override is shared via a ref
    for (let i = 0; i < validRows.length; i++) {
      if (shouldStopProcessingRef.current) break;
      const { originalIndex } = validRows[i];
      const company = companies[i];
      const rowNews = buildRowNews(tableData, originalIndex, domainColIndex);

      newsOverrideRef.current = rowNews || null;
      newsDraftCacheRef.current = null;

      try {
        await researchCompany(company);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[CompanyResearchHome] Unexpected error researching ${company} from table:`, error);
        setErrorsByCompany(prev => ({
          ...prev,
          [company]: { general: `Unexpected error: ${msg}` }
        }));
      }

      setTableProcessingProgress({ current: i + 1, total: validRows.length });
    }

    newsOverrideRef.current = null;
    newsDraftCacheRef.current = null;
    setIsProcessingTable(false);
    setTableProcessingProgress({ current: 0, total: 0 });
  }, [tableData, researchCompany]);

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
            writeSummaryToCsvRow(domainQualificationData, updatedRow);
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
            writeSummaryToCsvRow(instagramQualificationData, updatedRow);
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
                writeSummaryToCsvRow(profileData.qualificationData, updatedRow);
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
            writeSummaryToCsvRow(qualificationData, updatedRow);
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
    console.log('[CompanyResearchHome] handleResearch:', { researchMode, rawCompanyInput: rawCompanyInput?.slice(0, 100), companies });
    
    if (companies.length === 0) {
      setErrorsByCompany(prev => ({
        ...prev,
        _form: { form: researchMode === 'investor' ? 'Please enter at least one domain or LinkedIn URL' : researchMode === 'jobs' ? 'Please enter at least one job URL' : researchMode === 'person' ? 'Please enter at least one LinkedIn person URL' : 'Please enter at least one company URL' }
      }));
      return;
    }

    setIsSearching(true);
    setSubmittedCompanies(companies);
    setActiveCompany(companies[0]);
    
    // Clear previous errors (each company's results are initialized lazily in researchCompany)
    setErrorsByCompany({});

    // Process companies in batches with concurrency limit
    const TEXT_BATCH_CONCURRENCY = 30;
    shouldStopProcessingRef.current = false;
    setTextBatchProgress({ current: 0, total: companies.length });

    await processInBatches(
      companies,
      async (company) => {
        try {
          await researchCompany(company);
        } catch (error) {
          // Catch any unexpected errors to prevent stopping other researches
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[CompanyResearchHome] Unexpected error researching ${company}:`, error);
          setErrorsByCompany(prev => ({
            ...prev,
            [company]: { general: `Unexpected error: ${msg}` }
          }));
        }
        return null;
      },
      TEXT_BATCH_CONCURRENCY,
      (processed, total) => {
        setTextBatchProgress({ current: processed, total });
      }
    );

    if (shouldStopProcessingRef.current) {
      console.log('[CompanyResearchHome] Text batch processing was stopped by user.');
    }
    
    setTextBatchProgress({ current: 0, total: 0 });
    setIsSearching(false);
  }, [rawCompanyInput, researchCompany, researchMode]);

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
            <span className="text-brand-default">
              {isFundraising ? 'Investor' : 'Company'}
            </span>
            {' Researcher'}
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
          {isFundraising ? (
            <button
              className="px-6 py-3 rounded-sm font-medium bg-brand-default text-white ring-2 ring-brand-default"
              aria-label="Investor Research"
            >
              Investor Research
            </button>
          ) : (
            <>
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
              <button
                onClick={() => {
                  setResearchMode('jobs');
                  handleClearAll();
                }}
                className={`px-6 py-3 rounded-sm font-medium transition-colors ${
                  researchMode === 'jobs'
                    ? 'bg-brand-default text-white ring-2 ring-brand-default'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Jobs Research
              </button>
              <button
                onClick={() => {
                  setResearchMode('person');
                  handleClearAll();
                }}
                className={`px-6 py-3 rounded-sm font-medium transition-colors ${
                  researchMode === 'person'
                    ? 'bg-brand-default text-white ring-2 ring-brand-default'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Person Research
              </button>
            </>
          )}
        </div>
      </div>

      {/* Set Name Input - not shown in investor mode */}
      {researchMode !== 'investor' && (
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
      )}

      {/* Input mode tabs: Via Link / Via Table / Via CSV */}
      <div className="mb-6 border-b border-gray-200 opacity-0 animate-fade-up [animation-delay:400ms]">
        <nav className="-mb-px flex space-x-8">
          <button
            type="button"
            onClick={() => handleSwitchInputMode('link')}
            disabled={isProcessingCsv || isSearching || isProcessingTable}
            className={`whitespace-nowrap py-3 px-1 border-b-2 font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              inputMode === 'link'
                ? 'border-brand-default text-brand-default'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Via Link
          </button>
          <button
            type="button"
            onClick={() => handleSwitchInputMode('table')}
            disabled={isProcessingCsv || isSearching || isProcessingTable}
            className={`whitespace-nowrap py-3 px-1 border-b-2 font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              inputMode === 'table'
                ? 'border-brand-default text-brand-default'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Via Table
          </button>
          <button
            type="button"
            onClick={() => handleSwitchInputMode('csv')}
            disabled={isProcessingCsv || isSearching || isProcessingTable}
            className={`whitespace-nowrap py-3 px-1 border-b-2 font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              inputMode === 'csv'
                ? 'border-brand-default text-brand-default'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Via CSV
          </button>
        </nav>
      </div>

      {inputMode === 'link' && (
        <p className="block text-sm font-medium text-gray-700 mb-2 opacity-0 animate-fade-up [animation-delay:400ms]">
          {researchMode === 'investor'
            ? 'Enter domains (e.g. boldcap.com) or LinkedIn URLs (comma or newline separated) for investor research.'
            : researchMode === 'instagram'
            ? 'Enter Instagram URLs (comma or newline separated) for profile research.'
            : researchMode === 'jobs'
            ? 'Enter job posting URLs from LinkedIn, Naukri, Shine, Indeed, etc. (comma or newline separated) to extract company info and B2B fit.'
            : researchMode === 'person'
            ? 'Enter LinkedIn person URLs (e.g. https://in.linkedin.com/in/abhishekraniwala) for person research.'
            : 'Enter company URLs (comma or newline separated) for qualification assessment.'}
        </p>
      )}

      {/* CSV Import Section */}
      {inputMode === 'csv' && (
      <>
      <div className="mb-8 opacity-0 animate-fade-up [animation-delay:500ms]">
        <div className="border-2 border-dashed border-gray-300 rounded-sm p-6 bg-gray-50">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold mb-1">Import from CSV</h3>
              <p className="text-sm text-gray-600">
                {researchMode === 'investor'
                  ? 'Upload a CSV file to process multiple investors. Select the column containing domains or LinkedIn URLs.'
                  : researchMode === 'instagram'
                  ? 'Upload a CSV file to process multiple Instagram profiles. Select the column containing Instagram URLs.'
                  : researchMode === 'jobs'
                  ? 'Upload a CSV file to process multiple job postings. Select the column containing job URLs.'
                  : researchMode === 'person'
                  ? 'Upload a CSV file to process multiple people. Select the column containing LinkedIn person URLs.'
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
                  <span>Processing CSV: {csvProcessingProgress.current} / {csvProcessingProgress.total}{csvProcessingProgress.contactsLabel ? ` — ${csvProcessingProgress.contactsLabel}` : ''}</span>
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
          {csvData && !isProcessingCsv && (selectedUrlColumn || selectedColumns.domain || selectedColumns.instagram) && (
            <div className="mt-4 flex items-center justify-between gap-4 p-3 bg-white border border-gray-200 rounded-sm">
              <div className="text-sm text-gray-700">
                <span className="font-medium">{csvData.rows.length}</span> row{csvData.rows.length === 1 ? '' : 's'} loaded
                {selectedUrlColumn && (
                  <span className="text-gray-500"> · column: <span className="font-medium text-gray-700">{selectedUrlColumn}</span></span>
                )}
                {!selectedUrlColumn && (selectedColumns.domain || selectedColumns.instagram) && (
                  <span className="text-gray-500">
                    {selectedColumns.domain && <> · domain: <span className="font-medium text-gray-700">{selectedColumns.domain}</span></>}
                    {selectedColumns.instagram && <> · instagram: <span className="font-medium text-gray-700">{selectedColumns.instagram}</span></>}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowColumnSelector(true)}
                className="px-3 py-1.5 text-xs bg-gray-200 text-gray-700 rounded-sm hover:bg-gray-300 transition-colors"
              >
                Change column
              </button>
            </div>
          )}
        </div>
      </div>
      {csvData && !isProcessingCsv && (selectedUrlColumn || selectedColumns.domain || selectedColumns.instagram) && (
        <button
          type="button"
          onClick={() => {
            if (hasSavedProgress) {
              setShowResumeDialog(true);
            } else {
              processCsvRows(false);
            }
          }}
          className="w-full text-white font-semibold px-2 py-2 rounded-sm transition-opacity opacity-0 animate-fade-up [animation-delay:600ms] min-h-[50px] bg-brand-default ring-2 ring-brand-default transition-colors mb-8"
        >
          {researchMode === 'investor' ? 'Analyze Investors' : researchMode === 'instagram' ? 'Analyze Instagram Profiles' : researchMode === 'jobs' ? 'Analyze Job Postings' : researchMode === 'person' ? 'Analyze People' : 'Analyze Companies'}
        </button>
      )}
      </>
      )}

      {/* Table Import Section */}
      {inputMode === 'table' && (
      <>
      <div className="mb-6 opacity-0 animate-fade-up [animation-delay:500ms]">
        <label htmlFor="table-input" className="block text-sm font-medium text-gray-700 mb-2">
          Paste Table (Markdown or JSON)
        </label>
        <textarea
          id="table-input"
          value={tableInput}
          onChange={(e) => setTableInput(e.target.value)}
          placeholder={'| Domain | Headline | What happened |\n| --- | --- | --- |\n| brand.com | ... | ... |\n\nor a JSON array:\n[{"domain": "brand.com", "title": "..."}]'}
          rows={8}
          className="w-full bg-white p-3 border box-border outline-none rounded-sm ring-2 ring-gray-300 focus:ring-brand-default transition-colors font-mono text-xs"
          disabled={isProcessingTable}
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={handleParseTable}
            disabled={isProcessingTable || tableInput.trim().length === 0}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-sm hover:bg-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
          >
            Parse Table
          </button>
          <p className="text-xs text-gray-500">
            The domain/website column will be auto-detected and moved to the first position. Other columns will be concatenated as per-row news context.
          </p>
        </div>
        {tableParseError && (
          <p className="mt-2 text-sm text-red-600">{tableParseError}</p>
        )}
      </div>

      {tableData && (
        <div className="mb-6 opacity-0 animate-fade-up [animation-delay:600ms]">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-gray-700">
              <span className="font-medium">{tableData.rows.length}</span> row{tableData.rows.length === 1 ? '' : 's'} ·{' '}
              <span className="font-medium">{tableData.headers.length}</span> column{tableData.headers.length === 1 ? '' : 's'}
              {tableData.headers[0] && (
                <> · domain column: <span className="font-medium">{tableData.headers[0]}</span></>
              )}
            </p>
          </div>
          <div className="overflow-x-auto border border-gray-200 rounded-sm">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-2 w-8"></th>
                  {tableData.headers.map((header, ci) => (
                    <th key={ci} className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap border-l border-gray-200">
                      <div className="flex items-center gap-2">
                        <span>
                          {header}
                          {ci === 0 && <span className="ml-1 text-[10px] uppercase text-brand-default">domain</span>}
                        </span>
                        {ci > 0 && (
                          <button
                            type="button"
                            onClick={() => setPendingTableDelete({ kind: 'col', index: ci })}
                            disabled={isProcessingTable}
                            title="Remove column"
                            className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableData.rows.map((row, ri) => (
                  <tr key={ri} className="border-t border-gray-200 hover:bg-gray-50">
                    <td className="px-2 py-2 align-top">
                      <button
                        type="button"
                        onClick={() => setPendingTableDelete({ kind: 'row', index: ri })}
                        disabled={isProcessingTable}
                        title="Remove row"
                        className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                      >
                        ×
                      </button>
                    </td>
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-3 py-2 align-top text-gray-700 border-l border-gray-200 min-w-[16rem] max-w-md" title={cell}>
                        {ci === 0 && cell ? (
                          <div className="flex items-center gap-2">
                            <img
                              src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(cell)}&sz=32`}
                              alt=""
                              width={16}
                              height={16}
                              className="flex-shrink-0 rounded-sm"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                            />
                            <a
                              href={`https://${cell.replace(/^https?:\/\//, '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-brand-default hover:underline break-all"
                            >
                              {cell}
                            </a>
                          </div>
                        ) : (
                          <div className="line-clamp-3 break-words whitespace-pre-wrap">{cell}</div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tableData && tableData.rows.length > 0 && (
        <button
          type="button"
          onClick={processTableRows}
          disabled={isProcessingTable}
          className="w-full text-white font-semibold px-2 py-2 rounded-sm transition-opacity opacity-0 animate-fade-up [animation-delay:700ms] min-h-[50px] bg-brand-default ring-2 ring-brand-default transition-colors mb-8 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isProcessingTable
            ? `Analyzing… ${tableProcessingProgress.current} / ${tableProcessingProgress.total}`
            : (researchMode === 'investor' ? 'Analyze Investors' : researchMode === 'instagram' ? 'Analyze Instagram Profiles' : researchMode === 'jobs' ? 'Analyze Job Postings' : researchMode === 'person' ? 'Analyze People' : 'Analyze Companies')}
        </button>
      )}

      {isProcessingTable && (
        <div className="mb-6 p-3 bg-blue-50 text-blue-700 rounded-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-700"></div>
              <span>Processing table: {tableProcessingProgress.current} / {tableProcessingProgress.total}</span>
            </div>
            <button
              onClick={() => { shouldStopProcessingRef.current = true; }}
              className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-sm hover:bg-red-700 transition-colors"
            >
              Stop Processing
            </button>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all"
              style={{ width: `${tableProcessingProgress.total > 0 ? (tableProcessingProgress.current / tableProcessingProgress.total) * 100 : 0}%` }}
            ></div>
          </div>
        </div>
      )}

      {pendingTableDelete && tableData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <div className="flex items-center justify-center mb-4">
              <div className="flex-shrink-0 w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                </svg>
              </div>
            </div>
            <h2 className="text-xl font-semibold text-center mb-2">
              {pendingTableDelete.kind === 'row' ? 'Remove this row?' : 'Remove this column?'}
            </h2>
            <p className="text-gray-600 text-center mb-6 text-sm">
              {pendingTableDelete.kind === 'row' ? (
                <>
                  Domain: <span className="font-medium text-gray-800">{(tableData.rows[pendingTableDelete.index]?.[0] || '—').slice(0, 60)}</span>
                </>
              ) : (
                <>
                  Column: <span className="font-medium text-gray-800">{tableData.headers[pendingTableDelete.index]}</span>
                </>
              )}
              <br />
              This action cannot be undone.
            </p>
            <div className="flex justify-center gap-3">
              <button
                type="button"
                onClick={() => setPendingTableDelete(null)}
                className="px-6 py-2 bg-gray-200 text-gray-700 rounded-sm hover:bg-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (pendingTableDelete.kind === 'row') {
                    handleRemoveTableRow(pendingTableDelete.index);
                  } else {
                    handleRemoveTableColumn(pendingTableDelete.index);
                  }
                  setPendingTableDelete(null);
                }}
                className="px-6 py-2 bg-red-600 text-white rounded-sm hover:bg-red-700 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      </>
      )}

      {inputMode === 'link' && !isProcessingCsv && (
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

              // Auto-detect input type and switch mode accordingly (skip for investor mode)
              if (researchMode !== 'investor') {
                if (containsJobUrl(filteredInput)) {
                  if (researchMode !== 'jobs') {
                    setResearchMode('jobs');
                  }
                } else if (containsLinkedInPersonUrl(filteredInput)) {
                  if (researchMode !== 'person') {
                    setResearchMode('person');
                  }
                } else if (containsInstagramUrl(filteredInput)) {
                  if (researchMode !== 'instagram') {
                    setResearchMode('instagram');
                  }
                } else if (filteredInput.trim().length > 0 && (researchMode === 'instagram' || researchMode === 'jobs' || researchMode === 'person')) {
                  setResearchMode('domain');
                }
              }
            }}
            placeholder={researchMode === 'investor'
              ? "Enter domains or LinkedIn URLs (e.g., boldcap.com, linkedin.com/in/garrytan)"
              : researchMode === 'instagram'
              ? "Enter Instagram URLs (e.g., instagram.com/username, instagram.com/another_username)"
              : researchMode === 'jobs'
              ? "Enter job URLs (e.g., linkedin.com/jobs/view/123456, shine.com/jobs/..., naukri.com/job-listings-...)"
              : researchMode === 'person'
              ? "Enter LinkedIn person URLs (e.g., https://in.linkedin.com/in/abhishekraniwala)"
              : "Enter company URLs (e.g., capitalxai.com, another-company.com)"}
            rows={4}
            className="w-full bg-white p-3 border box-border outline-none rounded-sm ring-2 ring-brand-default resize-none opacity-0 animate-fade-up [animation-delay:600ms]"
          />
          {isB2B && researchMode !== 'investor' && (
            <div className="opacity-0 animate-fade-up [animation-delay:700ms]">
              <label htmlFor="research-news" className="block text-sm font-medium text-gray-700 mb-2">
                News (Optional)
              </label>
              <textarea
                id="research-news"
                value={newsInput}
                onChange={(e) => {
                  setNewsInput(e.target.value);
                  newsDraftCacheRef.current = null;
                }}
                placeholder="Paste one or more news items. We will use one to generate an opener and subject line."
                rows={4}
                className="w-full bg-white p-3 border box-border outline-none rounded-sm ring-2 ring-gray-300 focus:ring-brand-default transition-colors"
              />
            </div>
          )}
          <button
            type="submit"
            className={`w-full text-white font-semibold px-2 py-2 rounded-sm transition-opacity opacity-0 animate-fade-up [animation-delay:800ms] min-h-[50px] ${
              isSearching ? 'bg-gray-400' : 'bg-brand-default ring-2 ring-brand-default'
            } transition-colors`}
            disabled={isSearching}
          >
            {isSearching
              ? (researchMode === 'investor' ? 'Researching investor...' : researchMode === 'instagram' ? 'Researching Instagram...' : researchMode === 'jobs' ? 'Researching job posting...' : researchMode === 'person' ? 'Researching person...' : 'Analyzing...')
              : (researchMode === 'investor' ? 'Research Investor' : researchMode === 'instagram' ? 'Research Instagram Profiles' : researchMode === 'jobs' ? 'Research Job Postings' : researchMode === 'person' ? 'Research Person' : 'Analyze Companies')}
          </button>
        </form>
      )}

      {/* Global loading indicator with progress for large batches */}
      {isSearching && (
        <div className="mb-6 p-3 bg-blue-50 text-blue-700 rounded-sm">
          {textBatchProgress.total > 1 ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-700"></div>
                  <span>Processing: {textBatchProgress.current} / {textBatchProgress.total}</span>
                </div>
                <button
                  onClick={() => { shouldStopProcessingRef.current = true; }}
                  className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-sm hover:bg-red-700 transition-colors"
                >
                  Stop Processing
                </button>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${textBatchProgress.total > 0 ? (textBatchProgress.current / textBatchProgress.total) * 100 : 0}%` }}
                ></div>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-700"></div>
              <span>{researchMode === 'investor' ? 'Researching investor...' : researchMode === 'instagram' ? 'Researching Instagram profiles...' : researchMode === 'jobs' ? 'Researching job posting...' : researchMode === 'person' ? 'Researching person profile...' : 'Analyzing company qualification...'}</span>
            </div>
          )}
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
        {(isSearching || qualificationData || instagramProfileData || investorResearchData || jobsResearchData) && (
          <div className="space-y-8">
            <div className="flex items-center">
              <h2 className="text-3xl font-medium">
                {researchMode === 'investor' ? 'Investor Research' : researchMode === 'instagram' ? 'Instagram Profile' : researchMode === 'jobs' ? 'Jobs Research' : researchMode === 'person' ? 'Person Research' : 'Qualification Assessment'}
              </h2>
            </div>

            <div className="opacity-0 animate-fade-up [animation-delay:300ms]">
              {researchMode === 'jobs' ? (
                // Jobs Research Display
                isSearching && (!jobsResearchData || !jobsResearchData.summary) ? (
                  <div className="animate-pulse">
                    <div className="h-[300px] bg-gray-100 rounded-lg flex items-center justify-center">
                      <div className="text-center">
                        <div className="text-gray-500 mb-2">Researching job posting...</div>
                        <div className="flex justify-center">
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-700"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : jobsResearchData?.summary ? (
                  <div className="space-y-4">
                    <div className="bg-white border border-gray-200 rounded-lg p-4 text-sm text-gray-600 break-all">
                      <span className="font-medium">Source URL:</span>{' '}
                      <a href={jobsResearchData.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        {jobsResearchData.url}
                      </a>
                    </div>
                    <QualificationDisplay data={jobsResearchData.summary} />
                    <p className="text-sm text-green-600">Company saved to database.</p>
                  </div>
                ) : (
                  <div className="h-[300px] bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                    <div className="text-center p-6">
                      <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <h3 className="mt-2 text-sm font-medium text-gray-900">No job data available</h3>
                      <p className="mt-1 text-sm text-gray-500">We couldn&apos;t fetch job posting data for this URL.</p>
                      {errorsByCompany[activeCompany || '']?.jobsResearch && (
                        <p className="mt-2 text-sm text-red-600">{errorsByCompany[activeCompany || ''].jobsResearch}</p>
                      )}
                    </div>
                  </div>
                )
              ) : researchMode === 'investor' ? (
                // Investor Research Display
                isSearching && (!investorResearchData || (!investorResearchData.summary && !investorResearchData.skipped)) ? (
                  <div className="animate-pulse">
                    <div className="h-[300px] bg-gray-100 rounded-lg flex items-center justify-center">
                      <div className="text-center">
                        <div className="text-gray-500 mb-2">Researching investor...</div>
                        <div className="flex justify-center">
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-700"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : investorResearchData ? (
                  <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
                    <div className="text-sm text-gray-600">
                      <span className="font-medium">Cleaned URL:</span> {investorResearchData.cleaned}
                    </div>
                    {investorResearchData.skipped ? (
                      <div className="p-4 bg-amber-50 border border-amber-200 rounded-sm text-amber-800">
                        {investorResearchData.reason === 'not_an_investor' || investorResearchData.reason === 'not_investor'
                          ? 'Skipped (marked as not an investor)'
                          : 'Skipped (already exists in investors table)'}
                        {investorResearchData.reason && (
                          <span className="ml-2 text-amber-700">({investorResearchData.reason})</span>
                        )}
                      </div>
                    ) : investorResearchData.summary ? (
                      <>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <span className="text-sm font-medium text-gray-500">Entity Type</span>
                            <p className="text-base">{investorResearchData.summary.entity_type || '-'}</p>
                          </div>
                          <div>
                            <span className="text-sm font-medium text-gray-500">Is Investor</span>
                            <p className="text-base">{investorResearchData.summary.is_investor ? 'Yes' : 'No (Not an Investor)'}</p>
                          </div>
                          <div>
                            <span className="text-sm font-medium text-gray-500">Clean Name</span>
                            <p className="text-base">{investorResearchData.summary.clean_name || '-'}</p>
                          </div>
                          <div>
                            <span className="text-sm font-medium text-gray-500">Investor Types</span>
                            <p className="text-base">
                              {investorResearchData.summary.investor_types?.length
                                ? investorResearchData.summary.investor_types.join(', ')
                                : '-'}
                            </p>
                          </div>
                        </div>
                        {investorResearchData.links && investorResearchData.links.length > 0 && (
                          <div>
                            <span className="text-sm font-medium text-gray-500 block mb-2">Links</span>
                            <ul className="list-disc list-inside space-y-1 text-sm">
                              {investorResearchData.links.map((link, i) => (
                                <li key={i} className="break-all">{link}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {investorResearchData.updated && (
                          <p className="text-sm text-green-600">Updated existing investor in database.</p>
                        )}
                        {investorResearchData.contactsProcessing && (
                          <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-sm text-blue-800">
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                            <span className="text-sm">Processing contacts: {investorResearchData.contactsProcessing.current}/{investorResearchData.contactsProcessing.total}{investorResearchData.contactsProcessing.failed ? ` (${investorResearchData.contactsProcessing.failed} failed)` : ''}</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-gray-500">No summary data available.</p>
                    )}
                  </div>
                ) : (
                  <div className="h-[300px] bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                    <div className="text-center p-6">
                      <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <h3 className="mt-2 text-sm font-medium text-gray-900">No investor data available</h3>
                      <p className="mt-1 text-sm text-gray-500">We couldn&apos;t fetch investor research for this URL.</p>
                      {errorsByCompany[activeCompany || '']?.investorResearch && (
                        <p className="mt-2 text-sm text-red-600">{errorsByCompany[activeCompany || ''].investorResearch}</p>
                      )}
                    </div>
                  </div>
                )
              ) : researchMode === 'instagram' ? (
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
        allowBoth={researchMode !== 'investor' && researchMode !== 'jobs'}
        onSelectColumn={(column) => {
          setSelectedUrlColumn(column);
        }}
        onSelectColumns={(columns) => {
          setSelectedColumns(columns);
        }}
        onConfirm={() => {
          if (selectedUrlColumn || selectedColumns.domain || selectedColumns.instagram) {
            setShowColumnSelector(false);
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
