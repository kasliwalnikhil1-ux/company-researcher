/**
 * Research a recently funded company using fashion-deep-search, then upsert into new_fundings.
 * Accepts { description, domain? } for a single company.
 * description is the main input (required); domain is optional (deep search discovers it).
 * Returns the researched data and upsert result.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const FASHION_DEEP_SEARCH_URL = 'https://quycdewohkhmetiawogg.supabase.co/functions/v1/fashion-deep-search';
const RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 520, 521, 522, 523, 524];

/** Allowed user IDs (same as other data-pipelines tools) */
const ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

function getAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) throw new Error('Missing Supabase environment variables');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase service role key');
  return createClient(url, key);
}

function buildPrompt(description: string, domain: string): string {
  const companyInput = domain ? `${description} (${domain})` : description;
  return `${companyInput} company has recently raised funding. Research and tell me:
Individuals or firms in format [name](url) where url is domain for firm and LinkedIn URL for individual.

Founders in format [name](url) where url is LinkedIn URL for individual.
Reply in valid JSON only:
{
  "clean_name": str, // Company name without legal suffixes
  "company_website": str like domain.com,
  "founders": ["[Founder Name](linkedin_url)", ...],
  "what_they_do": str, // Brief description of what the company does in 1 line,
  "usp": str, // Unique selling proposition in 1 line,
  "how_much_funding": int like 5000000 for $5M,
  "founded_in_year": int like 2023,
  "investors": ["[Investor Name](url)", ...],
  "funding_date": str like "2023-01-01" for Jan 1, 2023
}

Important:
- how_much_funding should be a number in USD (e.g. 5000000 for $5M)
- funding_date should be in YYYY-MM-DD format
- founders should be an array of strings in [name](linkedin_url) format
- investors should be an array of strings in [name](url) format where url is domain for firms and LinkedIn URL for individuals
- company_website should be the clean domain without https://`;
}

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  const codeBlock = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const m = trimmed.match(codeBlock);
  if (m) return m[1].trim();
  return trimmed;
}

/** Parse [name](url) or name (url) format into { name, url } object */
function parseNameUrl(s: string): { name: string; url?: string } {
  if (typeof s !== 'string') return { name: String(s) };
  // [name](url) markdown-link format
  const mdMatch = s.match(/^\[([^\]]+)\]\(([^)]*)\)$/);
  if (mdMatch) {
    return { name: mdMatch[1].trim(), url: mdMatch[2].trim() || undefined };
  }
  // name (url) parenthesised format (Gemini sometimes returns this)
  const parenMatch = s.match(/^(.+?)\s*\((https?:\/\/[^)]+)\)$/);
  if (parenMatch) {
    return { name: parenMatch[1].trim(), url: parenMatch[2].trim() };
  }
  return { name: s.trim() };
}

/** Extract text content from fashion-deep-search response (may come in various formats) */
function extractDeepSearchText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  const obj = data as Record<string, unknown>;
  if (obj.data) {
    return typeof obj.data === 'string' ? obj.data : JSON.stringify(obj.data);
  }
  const literalKey = 'The response text from deep research is...';
  if (obj[literalKey]) return String(obj[literalKey]);
  const keys = Object.keys(obj);
  const textKey = keys.find((k) =>
    k.toLowerCase().includes('response') || k.toLowerCase().includes('text') || k.toLowerCase().includes('content')
  );
  if (textKey) return String(obj[textKey] || '');
  return String(obj.result || obj.output || JSON.stringify(obj));
}

interface ResearchResult {
  clean_name?: string;
  company_website?: string;
  founders?: string[];
  what_they_do?: string;
  usp?: string;
  how_much_funding?: number;
  founded_in_year?: number;
  investors?: string[];
  funding_date?: string;
}

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const authHeader = req.headers.get('authorization') || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authClient = getAuthClient(accessToken);
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!ALLOWED_USER_IDS.has(userData.user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body: { domain?: string; description?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) {
      return NextResponse.json({ error: 'Missing or empty description' }, { status: 400 });
    }

    console.log('[new-fundings/research] request', { description, domain });

    // Call fashion-deep-search
    const prompt = buildPrompt(description, domain);
    let lastError = '';
    let researchResult: ResearchResult | null = null;

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        console.log(`[new-fundings/research] fashion-deep-search attempt ${attempt}/${RETRIES}`);
        const res = await fetch(FASHION_DEEP_SEARCH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: prompt }),
          signal: AbortSignal.timeout(120000),
        });

        if (!res.ok) {
          const errText = await res.text();
          lastError = `Deep Search API ${res.status}: ${errText.slice(0, 300)}`;
          if (attempt < RETRIES && RETRYABLE_STATUS_CODES.includes(res.status)) {
            const backoffMs = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
            console.log(`[new-fundings/research] Retrying in ${backoffMs}ms...`);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          return NextResponse.json({ error: lastError }, { status: 502 });
        }

        const deepSearchData = await res.json();
        const rawText = extractDeepSearchText(deepSearchData);
        if (!rawText) {
          lastError = 'Empty content in Deep Search response';
          if (attempt < RETRIES) {
            const backoffMs = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          return NextResponse.json({ error: lastError }, { status: 502 });
        }

        const jsonStr = extractJsonFromText(rawText);
        researchResult = JSON.parse(jsonStr) as ResearchResult;
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < RETRIES) {
          const backoffMs = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        return NextResponse.json({ error: lastError }, { status: 502 });
      }
    }

    if (!researchResult) {
      return NextResponse.json({ error: lastError || 'Research failed' }, { status: 502 });
    }

    console.log('[new-fundings/research] deep search result', { description, result: researchResult });

    // Transform founders and investors from [name](url) strings into jsonb objects
    const founders = Array.isArray(researchResult.founders)
      ? researchResult.founders.filter((x): x is string => typeof x === 'string').map(parseNameUrl)
      : null;
    const investors = Array.isArray(researchResult.investors)
      ? researchResult.investors.filter((x): x is string => typeof x === 'string').map(parseNameUrl)
      : null;

    // Clean domain: use researched company_website (primary), fall back to user-provided domain
    const rawDomain = researchResult.company_website || domain;
    const cleanDomain = rawDomain
      ? rawDomain
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .replace(/\/+$/, '')
          .toLowerCase()
      : null;

    // Build the row for upsert
    const row = {
      name: researchResult.clean_name || null,
      domain: cleanDomain,
      founders,
      what_they_do: researchResult.what_they_do || null,
      usp: researchResult.usp || null,
      how_much_funding: typeof researchResult.how_much_funding === 'number' ? researchResult.how_much_funding : null,
      founded_in_year: typeof researchResult.founded_in_year === 'number' ? researchResult.founded_in_year : null,
      investors,
      funding_date: researchResult.funding_date || null,
    };

    // Upsert into new_fundings (update if domain already exists, else insert)
    const service = getServiceClient();

    let upsertData;
    let upsertError;

    if (cleanDomain) {
      // Domain found - upsert on domain conflict
      const result = await service
        .from('new_fundings')
        .upsert(row, { onConflict: 'domain' })
        .select()
        .single();
      upsertData = result.data;
      upsertError = result.error;
    } else {
      // No domain discovered - plain insert
      const result = await service
        .from('new_fundings')
        .insert(row)
        .select()
        .single();
      upsertData = result.data;
      upsertError = result.error;
    }

    if (upsertError) {
      console.error('[new-fundings/research] Upsert error:', upsertError.message);
      // Still return the researched data even if upsert fails
      return NextResponse.json({
        row,
        upsertError: upsertError.message,
      }, { status: 207 });
    }

    console.log('[new-fundings/research] upserted', { domain: cleanDomain, id: upsertData?.id });

    return NextResponse.json({ row: upsertData });
  } catch (err) {
    console.error('[new-fundings/research] Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
