// /app/api/onboarding-enrich/route.ts
// Exa-based company info prefilling for onboarding (B2B vs fundraising flows)
import { NextRequest, NextResponse } from 'next/server';
import Exa from 'exa-js';

export const maxDuration = 60;

const EXA_API_KEYS = process.env.EXA_API_KEYS
  ? process.env.EXA_API_KEYS.split(',').map(key => key.trim()).filter(key => key.length > 0)
  : [];

function createExaClient(key: string): Exa {
  return new Exa(key);
}

function isCreditError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('credit') ||
      message.includes('quota') ||
      message.includes('limit') ||
      message.includes('insufficient') ||
      message.includes('429') ||
      message.includes('403')
    );
  }
  return false;
}

async function makeExaCall(
  url: string,
  key: string,
  query: string,
  schema: Record<string, unknown>
): Promise<{ results?: Array<{ summary?: string }> }> {
  const exa = createExaClient(key);
  const response = await exa.getContents(
    [url],
    {
      livecrawl: 'fallback',
      summary: { query, schema },
      text: true,
    }
  );
  return response as { results?: Array<{ summary?: string }> };
}

async function processUrlWithKeys(
  url: string,
  query: string,
  schema: Record<string, unknown>
): Promise<{ results?: Array<{ summary?: string }> }> {
  if (EXA_API_KEYS.length === 0) {
    throw new Error('No Exa API keys configured');
  }
  const shuffledKeys = [...EXA_API_KEYS].sort(() => Math.random() - 0.5);
  let lastError: unknown;
  for (const key of shuffledKeys) {
    try {
      return await makeExaCall(url, key, query, schema);
    } catch (error) {
      if (isCreditError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error('All API keys exhausted');
}

// B2B flow: query and schema for prefilling (user provides company name; no company_size)
const B2B_QUERY = `You are an assistant that extracts company information from a company website for B2B onboarding.

Your job: from the website content, extract and return STRICT JSON following the schema. The user will provide company name separately; do not include it.

Rules:
- product_or_service: What product or service does this company offer? Brief description (2–4 sentences) for "What You Sell". Empty string if not found.
- features: Up to 5 key product/service features or capabilities. Array of strings; use empty array if none found.
- why_different: What makes this company's product stand out (e.g. "Faster to deploy", "Lower cost", "Better UX", "More accurate results", "Better support", "Easier integration", "Industry-specific", "Scalable", "Secure"). Array of strings; empty array if unclear.
- industry: Primary industry this company sells to or operates in (e.g. SaaS, E-commerce, Fintech, Fashion). Single string; empty string if not found.
- buyer_role: Who at the customer company typically buys or evaluates this product. Return 1–4 values from exactly: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern. Array of strings; empty array if unclear.
- problems_you_solve: What customer problems or pain points does this product solve? Short paragraph. Empty string if not found.
- when_customers_buy: When do customers usually buy or what triggers a purchase (e.g. new funding, expansion, pain point). Short paragraph. Empty string if not found.

Return only valid JSON matching the schema.`;

const B2B_SCHEMA = {
  description: 'B2B onboarding prefilling from website',
  type: 'object',
  required: ['product_or_service', 'features', 'why_different', 'industry', 'buyer_role', 'problems_you_solve', 'when_customers_buy'],
  additionalProperties: false,
  properties: {
    product_or_service: { type: 'string', description: 'What product or service does the company offer (What You Sell)' },
    features: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
      description: 'Key features, optional, up to 5',
    },
    why_different: {
      type: 'array',
      items: { type: 'string' },
      description: "Why you're different / unique selling points",
    },
    industry: { type: 'string', description: 'Primary industry' },
    buyer_role: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'],
      },
      description: 'Buyer roles this company should sell to',
    },
    problems_you_solve: { type: 'string', description: 'Problems you solve' },
    when_customers_buy: { type: 'string', description: 'When do customers usually buy' },
  },
};

// Fundraising flow: query and schema for startup/company prefilling (no company_name; user provides)
const FUNDRAISING_QUERY = `You are an assistant that extracts startup/company information from a company website for fundraising onboarding.

Your job: from the website content, extract and return STRICT JSON following the schema. The user will provide company name separately; do not include it.

Rules:
- company_summary: One or two sentence description of what the company does and who it serves. Empty string if not found.
- sector: List of relevant sectors from: B2B, B2C, Marketplace, SaaS, Fintech, Healthtech, Edtech, E-commerce, AI/ML, Blockchain/Crypto, Gaming, Media/Entertainment, Real Estate, Transportation, Food & Beverage, Fashion, Travel, Energy, Manufacturing, Agriculture, Construction, Legal, HR/Recruiting, Marketing/Advertising, Security, IoT, Robotics, Biotech, Pharma, Telecom, Hardware, Other. Return 1-3 most relevant; empty array if unclear.
- product_description: Clear description of the product or service (2-4 sentences). Empty string if not found.
- who_are_your_customers: Who are this company's customers? Target audience, customer segments, or who they sell to. Short paragraph. Empty string if not found.

Return only valid JSON matching the schema.`;

const FUNDRAISING_SCHEMA = {
  description: 'Fundraising onboarding company info from website',
  type: 'object',
  required: ['company_summary', 'sector', 'product_description', 'who_are_your_customers'],
  additionalProperties: false,
  properties: {
    company_summary: { type: 'string', description: 'Brief description of the company' },
    sector: {
      type: 'array',
      items: { type: 'string' },
      description: 'Relevant sectors from the allowed list',
    },
    product_description: { type: 'string', description: 'Product or service description' },
    who_are_your_customers: { type: 'string', description: 'Who are your customers?' },
  },
};

function getQueryAndSchema(flowType: 'b2b' | 'fundraising'): {
  query: string;
  schema: Record<string, unknown>;
} {
  if (flowType === 'b2b') {
    return { query: B2B_QUERY, schema: B2B_SCHEMA as Record<string, unknown> };
  }
  return { query: FUNDRAISING_QUERY, schema: FUNDRAISING_SCHEMA as Record<string, unknown> };
}

function cleanUrl(url: string): string {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.hostname}`;
  } catch {
    return url.startsWith('http') ? url : `https://${url}`;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { websiteurl, flowType } = body;

    if (!websiteurl || typeof websiteurl !== 'string') {
      return NextResponse.json(
        { error: 'websiteurl is required' },
        { status: 400 }
      );
    }

    const flow = flowType === 'fundraising' ? 'fundraising' : 'b2b';
    const { query, schema } = getQueryAndSchema(flow);
    const normalizedUrl = cleanUrl(websiteurl);

    const result = await processUrlWithKeys(normalizedUrl, query, schema);

    if (!result?.results?.length) {
      return NextResponse.json(
        { error: 'No results returned from Exa API' },
        { status: 500 }
      );
    }

    const first = result.results[0];
    if (!first?.summary) {
      return NextResponse.json(
        { error: 'No summary in Exa API response' },
        { status: 500 }
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(first.summary);
    } catch (e) {
      return NextResponse.json(
        { error: 'Failed to parse summary data', raw_summary: first.summary },
        { status: 500 }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Onboarding enrich API error:', error);
    return NextResponse.json(
      { error: 'Onboarding enrich failed', details: message },
      { status: 500 }
    );
  }
}
