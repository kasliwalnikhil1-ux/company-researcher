// API client for fetching company qualification data

import { supabase } from '@/utils/supabase/client';

export const fetchCompanyMap = async (
  domain: string, 
  userId?: string | null,
  personalization?: { query?: string; schema?: any } | null
): Promise<any> => {
  try {
    const response = await fetch('/api/companymap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        websiteurl: domain,
        userId: userId || null,
        personalization: personalization || null
      }),
    });
    
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

  const isLinkedIn =
    /linkedin\.com\/(company|in)\/[\w.-]+/i.test(s) ||
    s.toLowerCase().includes('linkedin.com') ||
    /^(in|company)\/[\w.-]+$/i.test(s); // path-only e.g. in/namankas

  if (isLinkedIn) {
    // Path-only input (e.g. in/namankas) - use as-is
    if (/^(in|company)\/[\w.-]+$/i.test(s)) {
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
  skipExisting?: boolean
): Promise<{
  cleaned?: string;
  skipped?: boolean;
  reason?: string;
  summary?: { entity_type?: string; is_investor?: boolean; investor_types?: string[]; clean_name?: string };
  links?: string[];
  updated?: boolean;
  error?: string;
  details?: string;
} | null> => {
  try {
    console.log('[fetchInvestorResearch] Calling API:', { input, skipExisting });
    const res = await fetch('/api/investor-research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, skipExisting }),
    });
    const data = await res.json();
    console.log('[fetchInvestorResearch] API response:', { ok: res.ok, status: res.status, data: { ...data, links: data?.links?.length } });
    if (!res.ok) {
      console.error('Investor research API error:', data);
      return { error: data.error || 'Failed', details: data.details };
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Investor research error:', err);
    return { error: 'Network error', details: msg };
  }
};

// Error codes from investor-analyze API for user-facing handling
export type InvestorAnalyzeErrorCode =
  | 'UNAUTHORIZED'
  | 'ACCOUNT_INACTIVE'
  | 'INSUFFICIENT_CREDITS'
  | 'NULL_CONSTRAINT'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN';

// Fetch investor deep_research for display
export const fetchInvestorDeepResearch = async (investorId: string): Promise<{
  deep_research: string | null;
  error?: string;
  details?: string;
} | null> => {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

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
export const fetchInvestorAnalyze = async (investorId: string): Promise<{
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
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

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
      body: JSON.stringify({ investorId }),
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

// Fetch Instagram profile data
export const fetchInstagramProfile = async (
  instagramUrl: string, 
  userId?: string | null,
  personalization?: { systemPrompt?: string; userMessage?: string } | null
): Promise<any> => {
  try {
    const response = await fetch('/api/instagram-profile', {
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