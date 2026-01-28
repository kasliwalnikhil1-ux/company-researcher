/**
 * Client-safe Instagram URL parsing (no API keys or server-only deps).
 * Use this from client components. For profile fetch/qualify use instagramApi on the server.
 */

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
