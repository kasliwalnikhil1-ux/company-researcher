/**
 * Instagram API helper functions
 * Fetches Instagram profile data using RapidAPI
 * Qualifies Instagram profiles using Azure OpenAI
 */

import { fetchWithRapidApi } from './rapidApiHelper';
import { getJsonCompletion, Message } from './azureOpenAiHelper';

const RAPIDAPI_HOST = 'instagram120.p.rapidapi.com';
const PROFILE_API_URL = 'https://instagram120.p.rapidapi.com/api/instagram/profile';

export interface InstagramProfileResponse {
  result: {
    id: string;
    username: string;
    is_private: boolean;
    profile_pic_url: string;
    profile_pic_url_hd: string;
    biography: string;
    full_name: string;
    edge_owner_to_timeline_media: {
      count: number;
    };
    edge_followed_by: {
      count: number;
    };
    edge_follow: {
      count: number;
    };
    profile_pic_url_wrapped?: string;
    profile_pic_url_hd_wrapped?: string;
  };
}

/**
 * Extracts username from Instagram URL
 * Supports formats:
 * - https://www.instagram.com/username/
 * - https://instagram.com/username/
 * - instagram.com/username/
 * - /username/
 * - username
 */
export function extractUsernameFromUrl(urlOrUsername: string): string | null {
  if (!urlOrUsername || typeof urlOrUsername !== 'string') {
    return null;
  }

  const trimmed = urlOrUsername.trim();
  
  // If it's already a username (no slashes, no protocol, no @), return as-is
  if (!trimmed.includes('/') && !trimmed.includes('http') && !trimmed.includes('@')) {
    return trimmed.replace('@', '');
  }

  // Try to extract from URL patterns
  const patterns = [
    /instagram\.com\/([^\/\?]+)/,
    /\/([^\/\?]+)/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const username = match[1].replace('@', '');
      // Filter out common non-username paths
      if (username && !['p', 'reel', 'tv', 'stories'].includes(username.toLowerCase())) {
        return username;
      }
    }
  }

  return null;
}

/**
 * Fetches Instagram profile information by username
 */
export async function fetchInstagramProfile(
  username: string
): Promise<InstagramProfileResponse> {
  if (!username) {
    throw new Error('Username is required');
  }

  // Remove @ if present
  const cleanUsername = username.replace('@', '');

  console.log(`[Instagram API] Fetching profile for username: ${cleanUsername}`);
  console.log(`[Instagram API] API URL: ${PROFILE_API_URL}`);
  console.log(`[Instagram API] RapidAPI Host: ${RAPIDAPI_HOST}`);

  const response = await fetchWithRapidApi(PROFILE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: cleanUsername }),
    rapidApiHost: RAPIDAPI_HOST,
  });

  console.log(`[Instagram API] Response status: ${response.status}`);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Instagram API] Error response: ${errorText}`);
    throw new Error(
      `Failed to fetch Instagram profile: ${response.status} ${response.statusText}. ${errorText}`
    );
  }

  const data = await response.json();
  console.log(`[Instagram API] Successfully fetched profile data`);
  return data;
}

/**
 * Qualification result interface for Instagram profiles
 */
export interface InstagramQualificationResult {
  profile_summary: string;
  profile_industry: string;
  sales_opener_sentence: string;
  classification: 'QUALIFIED' | 'NOT_QUALIFIED' | 'MAYBE';
  confidence_score?: number; // Optional - only include if provided by LLM
  product_types: string[] | null;
  sales_action: 'OUTREACH' | 'EXCLUDE' | 'PARTNERSHIP' | 'MANUAL_REVIEW';
  email: string | null;
  phone: string | null;
}

/**
 * Qualifies an Instagram profile using Azure OpenAI (similar to Exa's summary call)
 * Analyzes the profile data to determine if it's a qualified fashion/apparel/jewelry brand
 */
export async function qualifyInstagramProfile(
  profileData: InstagramProfileResponse,
  provider: 'azure' | 'gemini' = 'azure',
  personalizedPrompts?: { systemPrompt?: string; userMessage?: string }
): Promise<InstagramQualificationResult> {
  const profile = profileData.result;

  // Build profile context for the LLM
  const profileContext = `
Instagram Profile Data:
- Username: ${profile.username}
- Full Name: ${profile.full_name}
- Biography: ${profile.biography || 'No biography'}
- Is Private: ${profile.is_private}
- Posts Count: ${profile.edge_owner_to_timeline_media.count}
- Followers: ${profile.edge_followed_by.count}
- Following: ${profile.edge_follow.count}
- Profile Picture URL: ${profile.profile_pic_url_hd || profile.profile_pic_url}
`;

  // Default system prompt
  const defaultSystemPrompt = `You are a sales qualification assistant for a company that sells an AI software service to fashion/apparel/jewelry BRANDS that sell PHYSICAL products.

Your job: classify the input Instagram profile as:
- QUALIFIED (sells physical fashion/apparel/jewelry products)
- NOT_QUALIFIED (does NOT sell physical products; or is software/SaaS/IT/service provider)

CRITICAL RULE:
Only mark QUALIFIED if the profile represents a brand/company that sells PHYSICAL consumer products (apparel, jewelry, accessories, etc.) to customers.
If the profile is for software, SaaS, IT services, consulting, agencies, marketplaces, manufacturing/export services, or is a tool/vendor/provider, it is NOT_QUALIFIED.

Reply as a JSON object with keys: 
{sales_opener_sentence: 
classification: QUALIFIED, NOT_QUALIFIED
product_types: Array of product types [""]
sales_action: OUTREACH, EXCLUDE, PARTNERSHIP, MANUAL_REVIEW
email: string (empty string if not present)
phone: string (empty string if not present)
}

Qualification Rules
QUALIFIED ✅

Mark QUALIFIED only if you see some evidence of physical product commerce in the profile, such as:
- product categories mentioned in bio (e.g., "shirts", "kurtas", "rings", "earrings")
- shop links, website links, or e-commerce indicators
- product-focused content in bio
- brand/store indicators
- fashion/apparel/jewelry business signals
- fashion/apparel/jewelry Manufacturer / exporter / OEM / ODM / supplier / wholesaler
- fashion/apparel/jewelry marketplace indicators (e.g., "shop on Amazon", "shop on Flipkart", "shop on Myntra", "shop on Etsy")

NOT_QUALIFIED ❌

Mark NOT_QUALIFIED if ANY are true:
- Sells software subscription / Is SaaS / Is app / Is AI tool
- "We provide services to brands" (not selling products, like IT services / marketing agency / consulting)

Only return product_types when classification = "QUALIFIED".

product_types must be 1 item:
- generic physical product type (e.g., "earrings", "rings", "kurtas", "shirts", "jewelry", "clothing")
- NOT services ("photoshoots", "videography")
- NOT software ("platform", "tool", "API")

sales_opener_sentence: Message to send to founder, follow exact sentence structure, starting with "I think your..."
[usp, specialization, history // anything ] unique/impressive/stunning/special/different/etc, <10 words only.
Don't use words that feel AI like captivating, captivating, transforming, etc.

email and phone as strings if present in bio, otherwise use empty string ""
`;

  // Use personalized system prompt if provided, otherwise use default
  const systemPrompt = personalizedPrompts?.systemPrompt || defaultSystemPrompt;
  
  // Default user message
  const defaultUserMessage = `Analyze this Instagram profile and provide qualification assessment:

${profileContext}

Return the assessment in the exact JSON schema format.`;

  // Use personalized user message if provided, otherwise use default
  // Replace placeholders in personalized user message
  let userMessage = personalizedPrompts?.userMessage || defaultUserMessage;
  if (personalizedPrompts?.userMessage) {
    userMessage = userMessage
      .replace(/{username}/g, profile.username)
      .replace(/{full_name}/g, profile.full_name || '')
      .replace(/{biography}/g, profile.biography || 'No biography')
      .replace(/{is_private}/g, String(profile.is_private))
      .replace(/{posts_count}/g, String(profile.edge_owner_to_timeline_media.count))
      .replace(/{followers}/g, String(profile.edge_followed_by.count))
      .replace(/{following}/g, String(profile.edge_follow.count))
      .replace(/{profile_pic_url}/g, profile.profile_pic_url_hd || profile.profile_pic_url || '');
  } else {
    userMessage = defaultUserMessage;
  }

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  console.log(`[Instagram Qualification] Calling ${provider} API for profile: ${profile.username}`);

  try {
    const result = await getJsonCompletion(messages, {
      provider,
      temperature: 0.5,
      top_p: 0.85,
      max_tokens: 2000,
    });

    // Validate the result structure
    if (result.error) {
      throw new Error(`API returned error: ${result.error}`);
    }

    // Ensure all required fields are present
    const qualification: InstagramQualificationResult = {
      profile_summary: result.profile_summary || '',
      profile_industry: result.profile_industry || '',
      sales_opener_sentence: result.sales_opener_sentence || '',
      classification: result.classification || 'MAYBE',
      // Only include confidence_score if provided by LLM
      ...(result.confidence_score !== undefined && { confidence_score: result.confidence_score }),
      product_types: result.product_types && Array.isArray(result.product_types) && result.product_types.length > 0 
        ? result.product_types.filter((pt: any) => pt && typeof pt === 'string')
        : null,
      sales_action: result.sales_action || 'MANUAL_REVIEW',
      email: result.email || null,
      phone: result.phone || null,
    };
    
    // Log product_types for debugging
    if (qualification.classification === 'QUALIFIED') {
      console.log(`[Instagram Qualification] Product types for ${profile.username}:`, qualification.product_types);
    }

    console.log(`[Instagram Qualification] Successfully qualified profile: ${profile.username} as ${qualification.classification}`);
    return qualification;
  } catch (error) {
    console.error(`[Instagram Qualification] Error qualifying profile ${profile.username}:`, error);
    throw error;
  }
}