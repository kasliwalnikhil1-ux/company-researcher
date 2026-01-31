/**
 * Twitter API helper functions (server-only)
 * Fetches Twitter timeline data using RapidAPI
 */

import 'server-only';
import { fetchWithRapidApi } from './rapidApiHelper';

const RAPIDAPI_HOST = 'twitter-api45.p.rapidapi.com';
const TIMELINE_API_URL = 'https://twitter-api45.p.rapidapi.com/timeline.php';

export interface TwitterAuthor {
  rest_id: string;
  name: string;
  screen_name: string;
  avatar: string;
  blue_verified?: boolean;
}

export interface TwitterTweet {
  tweet_id: string;
  bookmarks?: number;
  created_at: string;
  favorites?: number;
  text: string;
  lang?: string;
  views?: string;
  quotes?: number;
  replies?: number;
  retweets?: number;
  conversation_id?: string;
  media?: unknown;
  author?: TwitterAuthor;
  quoted?: unknown;
  retweeted_tweet?: unknown;
}

export interface TwitterTimelineResponse {
  pinned?: TwitterTweet;
  timeline?: TwitterTweet[];
}

/**
 * Extracts username from Twitter/X URL
 * Supports formats:
 * - https://twitter.com/username
 * - https://x.com/username
 * - twitter.com/username
 * - x.com/username
 * - @username
 * - username
 */
export function extractUsernameFromTwitterUrl(urlOrUsername: string): string | null {
  if (!urlOrUsername || typeof urlOrUsername !== 'string') {
    return null;
  }

  const trimmed = urlOrUsername.trim();

  // If it's already a username (no slashes, no protocol)
  if (!trimmed.includes('/') && !trimmed.includes('http')) {
    return trimmed.replace(/^@/, '');
  }

  // Try to extract from URL patterns
  const patterns = [
    /(?:twitter|x)\.com\/([^\/\?]+)/,
    /\/([^\/\?]+)(?:\/?\?|$)/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const username = match[1].replace(/^@/, '');
      // Filter out common non-username paths
      if (username && !['home', 'search', 'explore', 'settings', 'i'].includes(username.toLowerCase())) {
        return username;
      }
    }
  }

  return null;
}

/**
 * Fetches Twitter timeline for a given username
 */
export async function fetchTwitterTimeline(username: string): Promise<TwitterTimelineResponse> {
  const cleanUsername = extractUsernameFromTwitterUrl(username) || username.replace(/^@/, '');
  if (!cleanUsername) {
    throw new Error('Twitter username is required');
  }

  const url = `${TIMELINE_API_URL}?screenname=${encodeURIComponent(cleanUsername)}`;

  console.log(`[Twitter API] Fetching timeline for username: ${cleanUsername}`);

  const response = await fetchWithRapidApi(url, {
    method: 'GET',
    headers: {},
    rapidApiHost: RAPIDAPI_HOST,
    usePaidKey: true,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Twitter API] Error response: ${errorText}`);
    throw new Error(
      `Failed to fetch Twitter timeline: ${response.status} ${response.statusText}. ${errorText}`
    );
  }

  const data = await response.json();
  console.log(`[Twitter API] Successfully fetched timeline for ${cleanUsername}`);
  return data;
}
