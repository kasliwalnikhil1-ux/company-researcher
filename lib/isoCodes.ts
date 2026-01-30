/**
 * Utilities to map ISO 3166-1 (country) and ISO 3166-2 (subdivision) codes
 * to human-readable names for display.
 */

import countries from 'i18n-iso-countries';
import iso3166 from 'iso-3166-2';

// Register English locale for i18n-iso-countries (required for browser/Next.js)
try {
  countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
} catch {
  // May fail in some bundling scenarios; getName will still work for many codes
}

/**
 * Get human-readable country name from ISO 3166-1 alpha-2 or alpha-3 code.
 * Returns the original code if no mapping is found.
 */
export function getCountryName(code: string | null | undefined): string {
  if (!code?.trim()) return '';
  const c = code.trim().toUpperCase();
  const name = countries.getName(c, 'en');
  return name ?? c;
}

/**
 * Get human-readable subdivision/state name from ISO 3166-2 code.
 * Accepts full code (e.g. "US-CA") or country + subdivision (e.g. "US", "CA").
 * Returns the original value if no mapping is found.
 */
export function getSubdivisionName(
  subdivisionCode: string | null | undefined,
  countryCode?: string | null
): string {
  if (!subdivisionCode?.trim()) return '';

  const sub = subdivisionCode.trim();
  const country = countryCode?.trim().toUpperCase();

  // Full ISO 3166-2 format: "US-CA", "GB-ENG"
  if (sub.includes('-')) {
    const result = iso3166.subdivision(sub);
    return result?.name ?? sub;
  }

  // Subdivision only (e.g. "CA") - need country to build full code
  if (country) {
    const fullCode = `${country}-${sub}`;
    const result = iso3166.subdivision(fullCode);
    return result?.name ?? sub;
  }

  return sub;
}

/**
 * Format HQ location for display: Tamil Nadu · India
 */
export function formatHqLocation(
  hqState: string | null | undefined,
  hqCountry: string | null | undefined
): string {
  const parts: string[] = [];
  if (hqState) {
    parts.push(getSubdivisionName(hqState, hqCountry));
  }
  if (hqCountry) {
    parts.push(getCountryName(hqCountry));
  }
  return parts.join(' · ') || '-';
}

/**
 * Format short location for cards: "California, United States"
 */
export function formatHqLocationShort(
  hqState: string | null | undefined,
  hqCountry: string | null | undefined
): string {
  const parts: string[] = [];
  if (hqState) {
    parts.push(getSubdivisionName(hqState, hqCountry));
  }
  if (hqCountry) {
    parts.push(getCountryName(hqCountry));
  }
  return parts.filter(Boolean).join(', ') || '';
}

/**
 * Resolve user input (name or code) to ISO 3166-1 alpha-2 country code for search.
 * Accepts: "India", "United States", "US", "USA", "IN", etc.
 */
export function resolveCountryInput(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  const lower = raw.toLowerCase();

  // Already a valid 2-letter code
  if (upper.length === 2 && countries.isValid(upper)) return upper;

  // 3-letter alpha-3 code
  if (upper.length === 3) {
    const alpha2 = countries.alpha3ToAlpha2(upper);
    if (alpha2) return alpha2;
  }

  // Try exact match by name
  const codeByExact = countries.getAlpha2Code(raw, 'en');
  if (codeByExact) return codeByExact;

  // Search names (case-insensitive, starts-with or equals)
  const names = countries.getNames('en');
  for (const [code, name] of Object.entries(names)) {
    const nameLower = (name as string).toLowerCase();
    if (nameLower === lower || nameLower.startsWith(lower)) return code;
  }

  // Fallback: pass through as-is (DB may have custom values)
  return raw;
}

/**
 * Resolve user input (name or code) to ISO 3166-2 subdivision code for search.
 * Accepts: "US-CA", "IN-TN", "California", "Tamil Nadu", etc.
 */
export function resolveSubdivisionInput(
  input: string | null | undefined,
  countryInput?: string | null
): string | null {
  const raw = input?.trim();
  if (!raw) return null;

  // Already full ISO 3166-2 format (e.g. US-CA, IN-TN)
  if (raw.includes('-')) {
    const result = iso3166.subdivision(raw);
    return result ? raw : null;
  }

  const countryCode = resolveCountryInput(countryInput);

  // Try subdivision by name within country
  if (countryCode) {
    const result = iso3166.subdivision(countryCode, raw);
    if (result?.code) return result.code;
  }

  // Search all subdivisions by name
  const data = iso3166.data as Record<string, { sub?: Record<string, { name: string }> }>;
  const lower = raw.toLowerCase();
  for (const [, countryData] of Object.entries(data)) {
    if (!countryData?.sub) continue;
    for (const [code, subData] of Object.entries(countryData.sub)) {
      const name = subData?.name ?? '';
      if (name.toLowerCase() === lower || name.toLowerCase().includes(lower)) return code;
    }
  }

  // Fallback: pass through (may be subdivision code only, e.g. "CA")
  return raw;
}
