/**
 * RapidAPI helper with key rotation (server-only)
 * Automatically rotates through multiple API keys if one fails
 * Keys are read from env: RAPIDAPI_KEYS (comma-separated for multiple keys)
 * Paid APIs (e.g. Twitter) use RAPIDAPI_PAID_KEY when set
 */

import 'server-only';

function getRapidApiPaidKey(): string {
  const raw = process.env.RAPIDAPI_PAID_KEY;
  return raw && typeof raw === 'string' ? raw.trim() : '';
}

function getRapidApiKeys(): string[] {
  const raw = process.env.RAPIDAPI_KEYS;
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

// Lazy-initialized so env is read at first use (server-side)
let _keys: string[] | null = null;
function keys(): string[] {
  if (_keys === null) _keys = getRapidApiKeys();
  return _keys;
}

// Track current key index for rotation
let currentKeyIndex = 0;

/**
 * Gets the current RapidAPI key
 */
export function getCurrentRapidApiKey(): string {
  const k = keys();
  return k[currentKeyIndex] ?? '';
}

/**
 * Rotates to the next RapidAPI key
 */
export function rotateRapidApiKey(): string {
  const k = keys();
  currentKeyIndex = (currentKeyIndex + 1) % Math.max(k.length, 1);
  return k[currentKeyIndex] ?? '';
}

/**
 * Resets the key rotation to start from the first key
 */
export function resetRapidApiKeyRotation(): void {
  currentKeyIndex = 0;
}

/**
 * Makes a fetch request with RapidAPI headers, automatically rotating keys on failure
 * @param url - The URL to fetch
 * @param options - Fetch options (method, body, etc.)
 * @param rapidApiHost - The RapidAPI host header value
 * @param usePaidKey - If true, use RAPIDAPI_PAID_KEY instead of RAPIDAPI_KEYS
 * @param retryCount - Internal counter for retry attempts (default: 0)
 * @returns Promise<Response>
 */
export async function fetchWithRapidApi(
  url: string,
  options: RequestInit & { rapidApiHost: string; usePaidKey?: boolean },
  retryCount: number = 0
): Promise<Response> {
  const { rapidApiHost, usePaidKey, ...fetchOptions } = options;
  const rapidApiKeys = keys();
  const paidKey = getRapidApiPaidKey();

  let currentKey: string;

  if (usePaidKey) {
    if (!paidKey) {
      throw new Error(
        'RAPIDAPI_PAID_KEY is not set. Add it to your .env.local for paid APIs (e.g. Twitter).'
      );
    }
    currentKey = paidKey;
  } else {
    if (rapidApiKeys.length === 0) {
      throw new Error(
        'RAPIDAPI_KEYS is not set. Add comma-separated RapidAPI key(s) to your .env.local (e.g. RAPIDAPI_KEYS=key1,key2).'
      );
    }
    currentKey = getCurrentRapidApiKey();
  }

  const effectiveMaxRetries = usePaidKey ? 0 : rapidApiKeys.length - 1;
  const headers = {
    'x-rapidapi-host': rapidApiHost,
    'x-rapidapi-key': currentKey,
    ...fetchOptions.headers,
  };

  console.log(`[RapidAPI] Making request to: ${url}`);
  console.log(`[RapidAPI] Using ${usePaidKey ? 'paid' : 'standard'} key (retry count: ${retryCount})`);
  console.log(`[RapidAPI] Headers:`, {
    'x-rapidapi-host': rapidApiHost,
    'x-rapidapi-key': `${currentKey.substring(0, 10)}...` // Log only first 10 chars for security
  });
  console.log(`[RapidAPI] Request body:`, options.body);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers,
    });

    console.log(`[RapidAPI] Response received: ${response.status} ${response.statusText}`);

    // If request failed with 401, 403, or 429 (rate limit), try next key (only for standard keys)
    if (!response.ok && (response.status === 401 || response.status === 403 || response.status === 429)) {
      if (!usePaidKey && retryCount < effectiveMaxRetries) {
        console.warn(
          `RapidAPI key failed with status ${response.status}, rotating to next key (attempt ${retryCount + 1}/${effectiveMaxRetries})`
        );
        rotateRapidApiKey();
        return fetchWithRapidApi(url, { ...options, rapidApiHost, usePaidKey }, retryCount + 1);
      } else {
        // All keys exhausted
        const errorText = await response.text().catch(() => '');
        throw new Error(
          `All RapidAPI keys exhausted. Last error: ${response.status} ${response.statusText}. ${errorText}`
        );
      }
    }

    return response;
  } catch (error) {
    // For network errors or other failures, try next key if available (only for standard keys)
    if (!usePaidKey && retryCount < effectiveMaxRetries && error instanceof TypeError) {
      console.warn(
        `RapidAPI request failed with network error, rotating to next key (attempt ${retryCount + 1}/${effectiveMaxRetries})`
      );
      rotateRapidApiKey();
      return fetchWithRapidApi(url, { ...options, rapidApiHost, usePaidKey }, retryCount + 1);
    }
    
    throw error;
  }
}

