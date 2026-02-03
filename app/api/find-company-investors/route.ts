/**
 * Find investors of a company using Gemini (no streaming).
 * Accepts company name/details, returns list of [name](url) strings for use with
 * parseNameUrlListToSearchParams and search_investors (p_domains, p_linkedin_urls).
 */

import { NextRequest, NextResponse } from 'next/server';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL_ID = process.env.GEMINI_MODEL_ID || 'gemini-3-flash-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;
const RETRIES = 3;
const RETRY_BACKOFF_MS = 1500;

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

export async function POST(request: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: 'GEMINI_API_KEY is not configured' }, { status: 500 });
  }

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
  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: 'HIGH',
      },
      responseMimeType: 'application/json',
    },
    tools: [{ urlContext: {} }],
  };

  const url = `${GEMINI_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  let lastError: string = '';

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(90000),
      });

      if (!res.ok) {
        const errText = await res.text();
        lastError = `Gemini API ${res.status}: ${errText.slice(0, 300)}`;
        if (attempt < RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
          continue;
        }
        return NextResponse.json({ error: lastError }, { status: 502 });
      }

      const data = await res.json();
      const candidates = data.candidates || [];
      if (candidates.length === 0) {
        lastError = 'No candidates in Gemini response';
        if (attempt < RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
          continue;
        }
        return NextResponse.json({ error: lastError }, { status: 502 });
      }

      const parts = candidates[0].content?.parts || [];
      const rawText = (parts[0]?.text || '').trim();
      if (!rawText) {
        lastError = 'Empty content in Gemini response';
        if (attempt < RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
          continue;
        }
        return NextResponse.json({ error: lastError }, { status: 502 });
      }

      const jsonStr = extractJsonFromText(rawText);
      const parsed = JSON.parse(jsonStr) as { investors?: unknown };
      const list = Array.isArray(parsed.investors)
        ? parsed.investors.filter((x): x is string => typeof x === 'string')
        : [];
      console.log('[find-company-investors] success', { company: companyInput, investorsCount: list.length, investors: list });
      return NextResponse.json({ investors: list });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
        continue;
      }
      return NextResponse.json({ error: lastError }, { status: 502 });
    }
  }

  return NextResponse.json({ error: lastError || 'Request failed' }, { status: 502 });
}
