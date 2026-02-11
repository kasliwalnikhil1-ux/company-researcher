/**
 * Find investors of a company using fashion-deep-search.
 * Accepts company name/details, returns list of [name](url) strings for use with
 * parseNameUrlListToSearchParams and search_investors (p_domains, p_linkedin_urls).
 */

import { NextRequest, NextResponse } from 'next/server';

const FASHION_DEEP_SEARCH_URL = 'https://quycdewohkhmetiawogg.supabase.co/functions/v1/fashion-deep-search';
const RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 520, 521, 522, 523, 524];

function buildPrompt(companyInput: string): string {
  return `Find all investors of "${companyInput}"

Individuals or firms in format [name](url) where url is domain for firm and LinkedIn URL for individual.

Reply in valid JSON only:
{
  "investors": [ "list of strings in format [name](url)" ]
}`;
}

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  const codeBlock = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const m = trimmed.match(codeBlock);
  if (m) return m[1].trim();
  return trimmed;
}

/** Normalise an investor string into [name](url) markdown-link format.
 *  Handles variants the model may return:
 *    "Accel(accel.com)"               →  "[Accel](accel.com)"
 *    "Accel (accel.com)"              →  "[Accel](accel.com)"
 *    "Accel (https://www.accel.com)"  →  "[Accel](https://www.accel.com)"
 *    "[Accel](https://www.accel.com)" →  kept as-is
 *    "[Accel](accel.com)"             →  kept as-is
 */
function normalizeInvestorFormat(s: string): string {
  const t = s.trim();
  // Already in [name](url) format
  if (/^\[.+\]\(.+\)$/.test(t)) return t;
  // Convert "name(url)" or "name (url)" → "[name](url)"
  // The url may or may not have a protocol prefix (https://, http://)
  const match = t.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (match) {
    const name = match[1].trim();
    const url = match[2].trim();
    if (name && url) return `[${name}](${url})`;
  }
  return t;
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

export async function POST(request: NextRequest) {
  let body: { company?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const companyInput = typeof body.company === 'string' ? body.company.trim() : '';
  if (!companyInput) {
    return NextResponse.json({ error: 'Missing or empty company' }, { status: 400 });
  }
  console.log('[find-company-investors] request', { company: companyInput });

  const prompt = buildPrompt(companyInput);
  let lastError: string = '';

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      console.log(`[find-company-investors] fashion-deep-search attempt ${attempt}/${RETRIES}`);
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
          console.log(`[find-company-investors] Retrying in ${backoffMs}ms...`);
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
      const parsed = JSON.parse(jsonStr) as { investors?: unknown };
      const list = Array.isArray(parsed.investors)
        ? parsed.investors
            .filter((x): x is string => typeof x === 'string')
            .map(normalizeInvestorFormat)
        : [];
      console.log('[find-company-investors] success', { company: companyInput, investorsCount: list.length, investors: list });
      return NextResponse.json({ investors: list });
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

  return NextResponse.json({ error: lastError || 'Request failed' }, { status: 502 });
}
