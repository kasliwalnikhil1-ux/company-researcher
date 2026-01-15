/**
 * RapidAPI helper with key rotation
 * Automatically rotates through multiple API keys if one fails
 */

const RAPIDAPI_KEYS = [
  'a19ab35cd6msh38cc3d4aaad7fddp13d081jsna5b4e51e9a2f',
  '081e6b5b7amsh9a48d0e612ac1ccp1f9c32jsn8a98877df9e2',
  '5654c1d2f1msh0d280f451bae69cp165facjsn3b5fdcd6b762',
  'a669dc3de3msh3e331732977f8f9p10a91bjsnfcc1977fa8a4',
  '8e207135d7mshcd613c4e7c832bdp1723e5jsn175f9d767a9a',
];

// Track current key index for rotation
let currentKeyIndex = 0;

/**
 * Gets the current RapidAPI key
 */
export function getCurrentRapidApiKey(): string {
  return RAPIDAPI_KEYS[currentKeyIndex];
}

/**
 * Rotates to the next RapidAPI key
 */
export function rotateRapidApiKey(): string {
  currentKeyIndex = (currentKeyIndex + 1) % RAPIDAPI_KEYS.length;
  return RAPIDAPI_KEYS[currentKeyIndex];
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
 * @param retryCount - Internal counter for retry attempts (default: 0)
 * @returns Promise<Response>
 */
export async function fetchWithRapidApi(
  url: string,
  options: RequestInit & { rapidApiHost: string },
  retryCount: number = 0
): Promise<Response> {
  const { rapidApiHost, ...fetchOptions } = options;
  const maxRetries = RAPIDAPI_KEYS.length - 1;
  
  const currentKey = getCurrentRapidApiKey();
  const headers = {
    'x-rapidapi-host': rapidApiHost,
    'x-rapidapi-key': currentKey,
    ...fetchOptions.headers,
  };

  console.log(`[RapidAPI] Making request to: ${url}`);
  console.log(`[RapidAPI] Using key index: ${currentKeyIndex} (retry count: ${retryCount})`);
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

    // If request failed with 401, 403, or 429 (rate limit), try next key
    if (!response.ok && (response.status === 401 || response.status === 403 || response.status === 429)) {
      if (retryCount < maxRetries) {
        console.warn(
          `RapidAPI key failed with status ${response.status}, rotating to next key (attempt ${retryCount + 1}/${maxRetries})`
        );
        rotateRapidApiKey();
        return fetchWithRapidApi(url, { ...options, rapidApiHost }, retryCount + 1);
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
    // For network errors or other failures, try next key if available
    if (retryCount < maxRetries && error instanceof TypeError) {
      console.warn(
        `RapidAPI request failed with network error, rotating to next key (attempt ${retryCount + 1}/${maxRetries})`
      );
      rotateRapidApiKey();
      return fetchWithRapidApi(url, { ...options, rapidApiHost }, retryCount + 1);
    }
    
    throw error;
  }
}

