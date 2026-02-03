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
    console.error('[onboarding-enrich] No Exa API keys configured');
    throw new Error('No Exa API keys configured');
  }
  const shuffledKeys = [...EXA_API_KEYS].sort(() => Math.random() - 0.5);
  let lastError: unknown;
  for (const key of shuffledKeys) {
    try {
      return await makeExaCall(url, key, query, schema);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isCreditError(error)) {
        console.warn('[onboarding-enrich] Exa credit/quota error, trying next key:', msg);
        lastError = error;
        continue;
      }
      console.error('[onboarding-enrich] Exa API call failed for url:', url, 'error:', msg);
      throw error;
    }
  }
  console.error('[onboarding-enrich] All Exa API keys exhausted for url:', url, 'lastError:', lastError instanceof Error ? lastError.message : lastError);
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
- sector: List of relevant sectors (use exact slugs) from: artificial-intelligence, machine-learning, healthtech, biotech, digital-health, mental-health, wellness, longevity, fitness, consumer-health, medtech, pharma, genomics, bioinformatics, neuroscience, consumer-tech, enterprise-software, saas, vertical-saas, developer-tools, productivity, collaboration, fintech, payments, lending, credit, insurtech, regtech, wealthtech, climate-tech, energy, clean-energy, carbon-removal, sustainability, web3, blockchain, crypto, defi, nft, social-platforms, marketplaces, creator-economy, edtech, hr-tech, future-of-work, mobility, transportation, autonomous-vehicles, robotics, hardware, deep-tech, semiconductors, data-infrastructure, cloud-infrastructure, devops, cybersecurity, security, privacy, identity, digital-identity, consumer-internet, ecommerce, retail-tech, proptech, real-estate, construction-tech, smart-cities, supply-chain, logistics, manufacturing, industrial-tech, agtech, foodtech, gaming, esports, media, entertainment, music-tech, sports-tech, travel-tech, hospitality, martech, adtech, legal-tech, govtech, defense-tech, space-tech, aerospace, iot, edge-computing, network-effects. Return 1-3 most relevant; empty array if unclear.
- product_description: Clear description of the product or service (2-4 sentences). Empty string if not found.
- who_are_your_customers: Who are this company's customers? Target audience, customer segments, or who they sell to. Short paragraph. Empty string if not found.
- business_model: Which business model(s) apply? Select all that apply from exactly: B2B, B2C, B2G, Marketplace. Return 1-4 values; empty array if unclear.
- what_makes_you_unique: What differentiates this company from competitors? Unique value proposition, key differentiators, or why they stand out. Short paragraph. Empty string if not found.
- key_milestones_or_traction: Key milestones achieved and early traction (e.g. users, revenue, partnerships, launches, growth metrics). Short paragraph. Empty string if not found.

Return only valid JSON matching the schema.`;

const BUSINESS_MODEL_VALUES = ['B2B', 'B2C', 'B2G', 'Marketplace'];

const FUNDRAISING_SCHEMA = {
  description: 'Fundraising onboarding company info from website',
  type: 'object',
  required: ['company_summary', 'sector', 'product_description', 'who_are_your_customers', 'business_model', 'what_makes_you_unique', 'key_milestones_or_traction'],
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
    business_model: {
      type: 'array',
      items: { type: 'string', enum: BUSINESS_MODEL_VALUES },
      description: 'Business model(s): B2B, B2C, B2G, Marketplace (select all that apply)',
    },
    what_makes_you_unique: { type: 'string', description: 'What differentiates the company from competitors' },
    key_milestones_or_traction: { type: 'string', description: 'Key milestones achieved and early traction' },
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
      console.error('[onboarding-enrich] Bad request: websiteurl missing or invalid', { websiteurl: body?.websiteurl });
      return NextResponse.json(
        { error: 'websiteurl is required' },
        { status: 400 }
      );
    }

    const flow = flowType === 'fundraising' ? 'fundraising' : 'b2b';
    const { query, schema } = getQueryAndSchema(flow);
    const normalizedUrl = cleanUrl(websiteurl);

    console.log('[onboarding-enrich] Starting enrich for url:', normalizedUrl, 'flow:', flow);

    const result = await processUrlWithKeys(normalizedUrl, query, schema);

    if (!result?.results?.length) {
      console.error('[onboarding-enrich] No results from Exa API for url:', normalizedUrl, 'raw:', JSON.stringify(result));
      return NextResponse.json(
        { error: 'No results returned from Exa API' },
        { status: 500 }
      );
    }

    const first = result.results[0];
    if (!first?.summary) {
      console.error('[onboarding-enrich] No summary in Exa response for url:', normalizedUrl, 'first:', JSON.stringify(first));
      return NextResponse.json(
        { error: 'No summary in Exa API response' },
        { status: 500 }
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(first.summary);
    } catch (e) {
      const parseErr = e instanceof Error ? e.message : String(e);
      console.error('[onboarding-enrich] JSON parse failed for url:', normalizedUrl, 'error:', parseErr, 'raw_summary_length:', first.summary?.length);
      return NextResponse.json(
        { error: 'Failed to parse summary data', raw_summary: first.summary },
        { status: 500 }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[onboarding-enrich] API error:', message, 'stack:', stack);
    return NextResponse.json(
      { error: 'Onboarding enrich failed', details: message },
      { status: 500 }
    );
  }
}
