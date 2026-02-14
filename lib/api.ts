// API client for fetching company qualification data

import { supabase } from '@/utils/supabase/client';
import type { OnboardingDataForSummary } from '@/lib/utils';

/**
 * Get a valid access token, refreshing automatically if expired or about to expire.
 * This prevents "session expired" errors after periods of inactivity where
 * background tab throttling may have prevented Supabase's auto-refresh timer
 * from firing.
 *
 * Returns null if no session exists or the refresh token is also invalid.
 */
export const getValidAccessToken = async (): Promise<string | null> => {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) return null;

  // Check if the token is expired or will expire within 60 seconds
  const expiresAt = session.expires_at; // Unix timestamp in seconds
  if (expiresAt != null) {
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt - now < 60) {
      // Token is expired or about to expire — force a refresh
      const {
        data: { session: refreshed },
        error,
      } = await supabase.auth.refreshSession();

      if (error || !refreshed) {
        return null;
      }
      return refreshed.access_token;
    }
  }

  return session.access_token;
};

// Fetch with timeout to prevent hung requests from blocking batch processing
const fetchWithTimeout = (url: string, options: RequestInit, timeoutMs: number = 120_000): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
};

export const fetchCompanyMap = async (
  domain: string, 
  userId?: string | null,
  personalization?: { query?: string; schema?: any } | null
): Promise<any> => {
  try {
    const response = await fetchWithTimeout('/api/companymap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        websiteurl: domain,
        userId: userId || null,
        personalization: personalization || null
      }),
    }, 120_000); // 2-minute timeout per request
    
    if (!response.ok) {
      // Try to get error message from response
      let errorMessage = `Failed to fetch company qualification data (${response.status})`;
      let errorDetails = '';
      let errorData: any = null;
      try {
        errorData = await response.json();
        if (errorData.error || errorData.message) {
          errorMessage = errorData.error || errorData.message;
        }
        if (errorData.details) {
          errorDetails = errorData.details;
        }
      } catch (e) {
        // If response is not JSON, use status text
        errorMessage = response.statusText || errorMessage;
      }
      
      const fullErrorMessage = errorDetails 
        ? `${errorMessage}. ${errorDetails}`
        : errorMessage;
      
      // Check if this is the "No results returned from Exa API" error with status 500
      // In this case, return an EXPIRED classification instead of null
      if (response.status === 500 && errorMessage.includes('No results returned from Exa API')) {
        console.warn(`Marking ${domain} as EXPIRED due to Exa API returning no results`);
        return {
          classification: 'EXPIRED',
          company_summary: '',
          company_industry: '',
          sales_opener_sentence: '',
          confidence_score: 0,
          product_types: null,
          sales_action: 'MANUAL_REVIEW'
        };
      }
      
      console.error(`API Error for ${domain}:`, fullErrorMessage, `Status: ${response.status}`);
      
      // Send Slack notification for API error
      const slackMessage = `❌ API Error for ${domain}\nStatus: ${response.status}\nError: ${fullErrorMessage}`;
      sendSlackNotification(slackMessage).catch(
        (slackError) => console.error('Failed to send Slack notification:', slackError)
      );
      
      return null;
    }
    
    return await response.json();
  } catch (error) {
    // Handle network errors or other exceptions
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof TypeError && error.message.includes('fetch') 
      ? 'Network error' 
      : 'Error';
    
    console.error(`${errorType} fetching company qualification:`, error);
    
    // Send Slack notification for network/other errors
    const slackMessage = `❌ ${errorType} for ${domain}\nError: ${errorMessage}`;
    sendSlackNotification(slackMessage).catch(
      (slackError) => console.error('Failed to send Slack notification:', slackError)
    );
    
    return null;
  }
};

// Send Slack notification
export const sendSlackNotification = async (message: string): Promise<boolean> => {
  try {
    const response = await fetch('/api/slack-notification', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to send Slack notification');
    }
    
    return true;
  } catch (error) {
    console.error('Error sending Slack notification:', error);
    return false;
  }
};

// Clean domain or LinkedIn URL for investor research
export function cleanInvestorInput(input: string): {
  cleaned: string;
  type: 'domain' | 'linkedin';
  domain: string | null;
  linkedinUrl: string | null;
} {
  console.log('[cleanInvestorInput] input:', input);
  if (!input || typeof input !== 'string') {
    return { cleaned: '', type: 'domain', domain: null, linkedinUrl: null };
  }
  let s = input.trim();
  if (!s) return { cleaned: '', type: 'domain', domain: null, linkedinUrl: null };

  // Path-only: "word/word" where first segment has no dot (so it's not a domain like foo.com/bar)
  const isPathOnly = /^[a-z][\w-]*\/[\w.-]+$/i.test(s) && !s.includes('.');

  const isLinkedIn =
    s.toLowerCase().includes('linkedin.com') ||
    isPathOnly; // path-only e.g. in/namankas, company/accel, pub/john

  if (isLinkedIn) {
    // Path-only input (e.g. in/namankas, pub/john) - use as-is
    if (isPathOnly) {
      console.log('[cleanInvestorInput] LinkedIn path-only:', { cleaned: s, type: 'linkedin' });
      return { cleaned: s, type: 'linkedin', domain: null, linkedinUrl: s };
    }
    if (!s.startsWith('http')) s = 'https://' + s;
    try {
      const u = new URL(s);
      // Store just the path (e.g. in/namankas, company/accel) for efficiency
      const path = u.pathname.replace(/^\/+|\/+$/g, '') || '';
      const cleaned = path;
      console.log('[cleanInvestorInput] LinkedIn result:', { cleaned, type: 'linkedin' });
      return { cleaned, type: 'linkedin', domain: null, linkedinUrl: cleaned };
    } catch {
      const path = s.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '') || s;
      return { cleaned: path, type: 'linkedin', domain: null, linkedinUrl: path };
    }
  }

  // Domain: cleaned is always just the domain (e.g. accel.com), not the full URL
  if (!s.startsWith('http')) s = 'https://' + s;
  try {
    const u = new URL(s);
    const hostname = u.hostname;
    const domain = hostname.replace(/^www\./, '');
    console.log('[cleanInvestorInput] Domain result:', { cleaned: domain, type: 'domain', domain });
    return { cleaned: domain, type: 'domain', domain, linkedinUrl: null };
  } catch {
    const domain = s.replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0] || s;
    return { cleaned: domain, type: 'domain', domain, linkedinUrl: null };
  }
}

// Fetch investor research (Exa + upsert to investors table)
export const fetchInvestorResearch = async (
  input: string,
  skipExisting?: boolean,
  options?: { affiliateWithFirmId?: string; affiliateContactEmail?: string }
): Promise<{
  cleaned?: string;
  skipped?: boolean;
  reason?: string;
  summary?: { entity_type?: string; is_investor?: boolean; investor_types?: string[]; clean_name?: string };
  links?: string[];
  updated?: boolean;
  contacts_pending?: { firm_id: string; contacts: { input: string; affiliateContactEmail?: string; full_name?: string }[] };
  error?: string;
  details?: string;
} | null> => {
  try {
    const body: Record<string, unknown> = { input, skipExisting };
    if (options?.affiliateWithFirmId) body.affiliateWithFirmId = options.affiliateWithFirmId;
    if (options?.affiliateContactEmail) body.affiliateContactEmail = options.affiliateContactEmail;
    console.log('[fetchInvestorResearch] Calling API:', { input, skipExisting, affiliateWithFirmId: !!options?.affiliateWithFirmId });
    // 8-minute timeout: investor-research can call fashion-deep-search which takes up to 4+ minutes
    const res = await fetchWithTimeout('/api/investor-research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 480_000);
    const data = await res.json();
    console.log('[fetchInvestorResearch] API response:', { ok: res.ok, status: res.status, data: { ...data, links: data?.links?.length } });
    if (!res.ok) {
      // Handle rate limiting: return retryable error so callers can back off
      if (res.status === 429) {
        return { error: 'Rate limited (429)', details: 'Too many requests. Will retry with backoff.' };
      }
      console.error('Investor research API error:', data);
      return { error: data.error || 'Failed', details: data.details };
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish abort (timeout) from other errors
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.error('Investor research timeout:', input);
      return { error: 'Request timed out', details: `Request for ${input} timed out after 8 minutes` };
    }
    console.error('Investor research error:', err);
    return { error: 'Network error', details: msg };
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Process contacts_pending with concurrency limit and retries. Returns { processed, failed, errors }. */
export const processContactsPending = async (
  firmId: string,
  contacts: { input: string; affiliateContactEmail?: string; full_name?: string }[],
  options: {
    concurrency?: number;
    maxRetries?: number;
    onProgress?: (processed: number, total: number, failed: number) => void;
  } = {}
): Promise<{ processed: number; failed: number; errors: { name?: string; input: string; error: string }[] }> => {
  // Reduced default concurrency from 5 to 3 to limit total simultaneous requests
  // when called from within batch processing (30 outer × 3 inner = 90 max)
  const { concurrency = 3, maxRetries = 3, onProgress } = options;
  const errors: { name?: string; input: string; error: string }[] = [];
  let processed = 0;
  let failed = 0;

  const processOne = async (contact: (typeof contacts)[0], retriesLeft: number): Promise<boolean> => {
    const result = await fetchInvestorResearch(contact.input, true, {
      affiliateWithFirmId: firmId,
      affiliateContactEmail: contact.affiliateContactEmail,
    });
    if (result?.error) {
      if (retriesLeft > 0) {
        // Use exponential backoff; longer delay for rate limits
        const isRateLimit = result.error.includes('429') || result.error.includes('Rate limit');
        const baseDelay = isRateLimit ? 3000 : 1000;
        const attempt = maxRetries - retriesLeft + 1;
        await sleep(baseDelay * Math.pow(2, attempt - 1));
        return processOne(contact, retriesLeft - 1);
      }
      errors.push({ name: contact.full_name, input: contact.input, error: result.error + (result.details ? `: ${result.details}` : '') });
      return false;
    }
    return true;
  };

  for (let i = 0; i < contacts.length; i += concurrency) {
    const batch = contacts.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((c) => processOne(c, maxRetries)));
    for (let j = 0; j < results.length; j++) {
      if (results[j]) processed++;
      else failed++;
    }
    onProgress?.(processed + failed, contacts.length, failed);
  }

  return { processed, failed, errors };
};

// Error codes from investor-analyze API for user-facing handling
export type InvestorAnalyzeErrorCode =
  | 'UNAUTHORIZED'
  | 'ACCOUNT_INACTIVE'
  | 'INSUFFICIENT_CREDITS'
  | 'NULL_CONSTRAINT'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN';

/** investor_news structure: { answer: string, citations: string[], date: string } */
export interface InvestorNews {
  answer: string;
  citations: string[];
  date: string;
}

// Fetch current investor_news from DB (no Exa fetch)
export const fetchInvestorNewsCurrent = async (investorId: string): Promise<{
  investor_news: InvestorNews | null;
  error?: string;
} | null> => {
  try {
    const token = await getValidAccessToken();

    if (!token) {
      return { investor_news: null, error: 'You need to be signed in.' };
    }

    const res = await fetch(`/api/investor-news?investorId=${encodeURIComponent(investorId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      return { investor_news: null, error: data.error || 'Failed to load news' };
    }
    return { investor_news: data.investor_news ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Investor news fetch error:', msg);
    return { investor_news: null, error: 'Failed to load' };
  }
};

/** Context passed from drawer - investor data already loaded */
export interface InvestorNewsContext {
  investorId: string;
  name?: string | null;
  domain?: string | null;
  type?: 'firm' | 'person' | null;
  investor_type?: string[] | null;
  associated_firm_name?: string | null;
}

// Fetch latest news from Exa and update DB
export const fetchInvestorNews = async (context: InvestorNewsContext): Promise<{
  investor_news: InvestorNews | null;
  error?: string;
} | null> => {
  try {
    const token = await getValidAccessToken();

    if (!token) {
      return { investor_news: null, error: 'You need to be signed in.' };
    }

    const res = await fetch('/api/investor-news', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        investorId: context.investorId,
        name: context.name ?? undefined,
        domain: context.domain ?? undefined,
        type: context.type ?? undefined,
        investor_type: context.investor_type ?? undefined,
        associated_firm_name: context.associated_firm_name ?? undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { investor_news: null, error: data.error || 'Failed to fetch news' };
    }
    return { investor_news: data.investor_news ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Investor news fetch error:', msg);
    return { investor_news: null, error: 'Failed to fetch' };
  }
};

// Fetch investor deep_research for display
export const fetchInvestorDeepResearch = async (investorId: string): Promise<{
  deep_research: string | null;
  error?: string;
  details?: string;
} | null> => {
  try {
    const token = await getValidAccessToken();

    if (!token) {
      return { deep_research: null, error: 'You need to be signed in.' };
    }

    const res = await fetch('/api/investor-deep-research', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ investorId }),
    });
    const data = await res.json();
    if (!res.ok) {
      return {
        deep_research: null,
        error: data.error || 'Failed to fetch deep research',
        details: data.details,
      };
    }
    return { deep_research: data.deep_research ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Investor deep research fetch error:', err);
    return { deep_research: null, error: 'Failed to fetch', details: msg };
  }
};

// Fetch investor AI analysis (analyze fit, store ai_metadata, mark as reviewed)
// Pass onboarding so the API can use the real company name instead of "the company"
// Pass plan (free, basic, pro) so the API can skip Twitter personalization for basic
export const fetchInvestorAnalyze = async (
  investorId: string,
  onboarding?: OnboardingDataForSummary | null,
  plan?: string | null
): Promise<{
  success?: boolean;
  investor_fit?: boolean | null;
  reason?: string | null;
  line1?: string;
  line2?: string;
  mutual_interests?: string[];
  error?: string;
  errorCode?: InvestorAnalyzeErrorCode;
  details?: string;
} | null> => {
  try {
    const token = await getValidAccessToken();

    if (!token) {
      return {
        error: 'You need to be signed in to perform this action.',
        errorCode: 'UNAUTHORIZED',
      };
    }

    const res = await fetch('/api/investor-analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ investorId, onboarding: onboarding ?? undefined, plan: plan ?? undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      return {
        error: data.error || 'Something went wrong while processing your request. Please try again.',
        errorCode: data.errorCode || 'UNKNOWN',
        details: data.details,
      };
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Investor analyze error:', err);
    return {
      error: 'Something went wrong while processing your request. Please try again.',
      errorCode: 'UNKNOWN',
      details: msg,
    };
  }
};

// Generate AI investor outreach emails from company context
export const fetchGenerateMessages = async (
  onboarding?: OnboardingDataForSummary | null
): Promise<{
  success?: boolean;
  subjectline?: string;
  email1?: string;
  email2?: string;
  error?: string;
} | null> => {
  try {
    const token = await getValidAccessToken();

    if (!token) {
      return { error: 'You need to be signed in to perform this action.' };
    }

    const res = await fetch('/api/generate-messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ onboarding: onboarding ?? undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      return {
        error: data.error || 'Something went wrong while generating messages. Please try again.',
      };
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Generate messages error:', err);
    return {
      error: 'Something went wrong while generating messages. Please try again.',
    };
  }
};

// Investor analytics response from get_investor_analytics RPC
export interface InvestorAnalytics {
  funnel?: {
    total: number;
    identified: number;
    contacted: number;
    interested: number;
    passed: number;
    funded: number;
    unreviewed: number;
  };
  fit?: {
    fit_true: number;
    fit_false: number;
    fit_unknown: number;
  };
  activity?: {
    added_last_7d: number;
    added_last_30d: number;
  };
  geography?: Array<{ hq_country: string; count: number }>;
  stages?: Array<{ stage: string; count: number }>;
  industries?: Array<{ industry: string; count: number }>;
}

// Fetch investor analytics for fundraising dashboard
export const fetchInvestorAnalytics = async (): Promise<InvestorAnalytics | null> => {
  try {
    const token = await getValidAccessToken();

    if (!token) {
      return null;
    }

    const res = await fetch('/api/investor-analytics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();

    if (!res.ok) {
      console.error('Investor analytics API error:', data);
      return null;
    }

    return data as InvestorAnalytics;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Investor analytics fetch error:', err);
    return null;
  }
};

// Fetch Instagram profile data
export const fetchInstagramProfile = async (
  instagramUrl: string, 
  userId?: string | null,
  personalization?: { systemPrompt?: string; userMessage?: string } | null
): Promise<any> => {
  try {
    const response = await fetchWithTimeout('/api/instagram-profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        instagramUrl: instagramUrl,
        userId: userId || null,
        personalization: personalization || null
      }),
    });
    
    if (!response.ok) {
      let errorMessage = `Failed to fetch Instagram profile (${response.status})`;
      let errorDetails = '';
      try {
        const errorData = await response.json();
        if (errorData.error || errorData.message) {
          errorMessage = errorData.error || errorData.message;
        }
        if (errorData.details) {
          errorDetails = errorData.details;
        }
      } catch (e) {
        errorMessage = response.statusText || errorMessage;
      }
      
      const fullErrorMessage = errorDetails 
        ? `${errorMessage}. ${errorDetails}`
        : errorMessage;
      
      console.error(`Instagram API Error for ${instagramUrl}:`, fullErrorMessage, `Status: ${response.status}`);
      
      const slackMessage = `❌ Instagram API Error for ${instagramUrl}\nStatus: ${response.status}\nError: ${fullErrorMessage}`;
      sendSlackNotification(slackMessage).catch(
        (slackError) => console.error('Failed to send Slack notification:', slackError)
      );
      
      return null;
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof TypeError && error.message.includes('fetch') 
      ? 'Network error' 
      : 'Error';
    
    console.error(`${errorType} fetching Instagram profile:`, error);
    
    const slackMessage = `❌ ${errorType} for ${instagramUrl}\nError: ${errorMessage}`;
    sendSlackNotification(slackMessage).catch(
      (slackError) => console.error('Failed to send Slack notification:', slackError)
    );
    
    return null;
  }
};