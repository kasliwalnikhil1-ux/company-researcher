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
 * Extracts domain from various input formats
 * Supports:
 * - Full URLs: https://example.com, https://www.example.com/path
 * - URLs with protocol: http://example.io
 * - Plain domains: example.com, example.io
 * 
 * @param input - Domain URL or plain domain
 * @returns The domain (e.g., example.com, example.io) without protocol, www, or paths
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