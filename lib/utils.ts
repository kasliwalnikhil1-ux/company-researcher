import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Extracts Instagram ID/username from various input formats
 * Supports:
 * - Full URLs: https://instagram.com/username, https://www.instagram.com/username/
 * - URLs with paths: https://instagram.com/username/posts/123
 * - @username format: @username
 * - Plain username: username
 * 
 * @param input - Instagram URL, @username, or plain username
 * @returns The Instagram ID/username (without @ or URL parts)
 */
export function extractInstagramId(input: string): string {
  if (!input || typeof input !== 'string') return '';
  
  const trimmed = input.trim();
  if (!trimmed) return '';
  
  try {
    // If it's a URL, extract the username from the path
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = new URL(trimmed);
      // Handle instagram.com or www.instagram.com
      if (url.hostname.includes('instagram.com')) {
        // Get the pathname and remove leading/trailing slashes
        const pathParts = url.pathname.split('/').filter(part => part.length > 0);
        // The first non-empty part is usually the username
        if (pathParts.length > 0) {
          return pathParts[0];
        }
      }
      // If it's not an Instagram URL, return empty
      return '';
    }
    
    // If it starts with @, remove it
    if (trimmed.startsWith('@')) {
      return trimmed.substring(1);
    }
    
    // Otherwise, assume it's already a username
    return trimmed;
  } catch (error) {
    // If URL parsing fails, try to extract from string
    // Remove @ if present
    const withoutAt = trimmed.startsWith('@') ? trimmed.substring(1) : trimmed;
    // If it looks like it might have been a URL, try to extract the last part
    const parts = withoutAt.split('/').filter(part => part.length > 0);
    return parts[parts.length - 1] || withoutAt;
  }
}

/**
 * Extracts and cleans phone numbers from text
 * Matches phone number patterns and normalizes them
 * 
 * @param text - Text that may contain phone numbers
 * @returns Array of cleaned phone numbers (with + prefix and digits only)
 */
export function extractPhoneNumbers(text: string): string[] {
  if (!text) return [];

  // Match possible phone numbers
  const matches = text.match(
    /(\+?\d[\d\s().-]{7,}\d)/g
  );

  if (!matches) return [];

  return matches.map(num =>
    num
      .replace(/[^\d+]/g, '')   // remove spaces, dashes, brackets
      .replace(/^00/, '+')      // convert 00 prefix to +
  );
}

/**
 * Extracts and cleans a single phone number from text
 * Returns the first phone number found, or the cleaned input if no match
 * 
 * @param text - Text that may contain a phone number
 * @returns The first cleaned phone number, or empty string if none found
 */
export function extractPhoneNumber(text: string): string {
  if (!text) return '';
  
  const numbers = extractPhoneNumbers(text);
  if (numbers.length > 0) {
    return numbers[0];
  }
  
  // If no match, try to clean the input directly (might already be a number)
  const cleaned = text.trim().replace(/[^\d+]/g, '').replace(/^00/, '+');
  return cleaned;
}

/**
 * Extracts domain from various input formats
 * Supports:
 * - Full URLs: https://capitalxai.com, https://www.capitalxai.com/path
 * - URLs with protocol: http://example.io
 * - Plain domains: capitalxai.com, example.io
 * 
 * @param input - Domain URL or plain domain
 * @returns The domain (e.g., capitalxai.com, example.io) without protocol, www, or paths
 */
export function extractDomain(input: string): string {
  if (!input || typeof input !== 'string') return '';
  
  const trimmed = input.trim();
  if (!trimmed) return '';
  
  try {
    // If it's a URL, extract the hostname
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = new URL(trimmed);
      // Remove www. prefix if present
      return url.hostname.replace(/^www\./i, '');
    }
    
    // If it looks like it might have a protocol but URL parsing failed, try manual extraction
    if (trimmed.includes('://')) {
      const parts = trimmed.split('://');
      if (parts.length > 1) {
        const afterProtocol = parts[1].split('/')[0].split('?')[0];
        return afterProtocol.replace(/^www\./i, '');
      }
    }
    
    // Remove www. prefix if present and extract domain (remove paths, query params, etc.)
    const cleaned = trimmed.replace(/^www\./i, '').split('/')[0].split('?')[0].split(':')[0];
    return cleaned;
  } catch (error) {
    // If URL parsing fails, try manual extraction
    // Remove protocol if present
    let cleaned = trimmed.replace(/^https?:\/\//i, '');
    // Remove www. prefix
    cleaned = cleaned.replace(/^www\./i, '');
    // Remove paths, query params, and port
    cleaned = cleaned.split('/')[0].split('?')[0].split(':')[0];
    return cleaned;
  }
}

/** Human-readable labels for onboarding coded values */
const CAPITAL_RAISED_LABELS: Record<string, string> = {
  none: 'No amount raised',
  less_than_100k: 'Less than $100K',
  '100k_500k': '$100K–$500K',
  '500k_2m': '$500K–$2M',
  '2m_10m': '$2M–$10M',
  more_than_10m: 'More than $10M',
};

const TARGET_ROUND_LABELS: Record<string, string> = {
  less_than_500k: 'Less than $500K',
  '500k_2m': '$500K–$2M',
  '2m_10m': '$2M–$10M',
  more_than_10m: 'More than $10M',
};

export interface OnboardingDataForSummary {
  step2?: { bio?: string; title?: string };
  step4?: { capitalRaised?: string };
  step5?: { companyName?: string; website?: string };
  step6?: { sector?: string[] };
  step7?: { stage?: string };
  step8?: { hqCountry?: string };
  step9?: { productDescription?: string };
  step10?: { arr?: Array<{ month?: string; year?: string; amount?: string }>; revenueStatus?: string };
  step11?: { targetRoundSize?: string };
}

/**
 * Formats onboarding data into a beautiful company pitch summary.
 * Use for investor outreach, AI prompts, or display.
 */
export function formatOnboardingCompanySummary(data: OnboardingDataForSummary | null | undefined): string {
  if (!data) return '';

  const parts: string[] = [];

  // Product description (step9)
  const productDesc = data.step9?.productDescription?.trim();
  if (productDesc) {
    parts.push(productDesc);
  }

  // Stage & target round (step7, step11)
  const stage = data.step7?.stage?.trim();
  const targetRound = data.step11?.targetRoundSize;
  const targetRoundLabel = targetRound ? TARGET_ROUND_LABELS[targetRound] ?? targetRound : null;
  if (stage || targetRoundLabel) {
    const raiseLine = [
      'They are raising',
      stage ? `at ${stage} stage` : null,
      targetRoundLabel ? `with a target round size of ${targetRoundLabel}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    if (raiseLine.trim()) parts.push(raiseLine + '.');
  }

  // Revenue status (step10)
  const revenueStatus = data.step10?.revenueStatus;
  const arr = data.step10?.arr;
  if (revenueStatus === 'yes') {
    parts.push('Current Revenue: Yes.');
    if (Array.isArray(arr) && arr.length > 0) {
      const arrLines = arr
        .filter((e) => e && (e.amount || e.month || e.year))
        .map((e) => `${e.month || ''} ${e.year || ''}: ${e.amount || '—'}`.trim())
        .filter(Boolean);
      if (arrLines.length > 0) {
        parts.push(`ARR: ${arrLines.join('; ')}`);
      }
    }
  } else {
    parts.push('Current Revenue: No revenue yet.');
  }

  // HQ (step8)
  const hq = data.step8?.hqCountry?.trim();
  if (hq) {
    parts.push(`Company has HQ in ${hq}.`);
  }

  // Capital raised (step4)
  const capitalRaised = data.step4?.capitalRaised;
  if (capitalRaised) {
    const label = CAPITAL_RAISED_LABELS[capitalRaised] ?? capitalRaised;
    parts.push(`They have raised ${label}.`);
  }

  // Founders (step2)
  const bio = data.step2?.bio?.trim();
  if (bio) {
    parts.push(`Founders: ${bio}`);
  }

  const summary = parts.filter(Boolean).join(' ');
  // Debug: log formatted summary and raw data
  console.log('[formatOnboardingCompanySummary] Formatted output:\n', summary);
  console.log('[formatOnboardingCompanySummary] Raw data:', JSON.stringify(data, null, 2));
  return summary;
}

/**
 * Copies text to clipboard with fallback support
 * Uses the modern Clipboard API if available, otherwise falls back to the legacy method
 * 
 * @param text - Text to copy to clipboard
 * @returns Promise that resolves when text is copied, or rejects if copying fails
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (!text) {
    throw new Error('No text provided to copy');
  }

  // Try modern Clipboard API first (must be called synchronously within user gesture)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      // If Clipboard API fails (e.g., permission denied), fall back to legacy method
      console.warn('Clipboard API failed, trying fallback method:', error);
    }
  }

  // Fallback: Use legacy execCommand method
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    
    if (!successful) {
      throw new Error('execCommand copy failed');
    }
  } catch (error) {
    throw new Error(`Failed to copy text to clipboard: ${error instanceof Error ? error.message : String(error)}`);
  }
}