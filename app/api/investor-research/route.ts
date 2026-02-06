// /app/api/investor-research/route.ts
// Step 1: Exa contents API for investor classification + upsert to investors table
// Step 2 (investors only): fashion-deep-search for full profile
// Step 3 (investors only): Azure structured JSON extraction + DB update

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';

const FASHION_DEEP_SEARCH_URL = 'https://quycdewohkhmetiawogg.supabase.co/functions/v1/fashion-deep-search';
const FOUNDER_SEARCH_URL = 'https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/founder-search';
const INVESTOR_SEARCH_URL = 'https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/investor-search';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Helper function to send Slack notification
async function sendSlackNotification(message: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL not configured, skipping notification');
    return;
  }

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (error) {
    console.error('Failed to send Slack notification:', error);
  }
}

// Helper function to add failed investor to missing_investors table
async function addToMissingInvestors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  input: string,
  cleaned: string,
  type: 'domain' | 'linkedin',
  errorStep: string,
  errorMessage: string
): Promise<void> {
  try {
    // Store all details as JSON in the content field
    const content = JSON.stringify({
      input,
      cleaned,
      type,
      error_step: errorStep,
      error_message: errorMessage.substring(0, 1000), // Limit error message length
    });
    
    const { error } = await supabase.from('missing_investors').insert({
      id: randomUUID(),
      content,
    });
    if (error) {
      console.error('[investor-research] Failed to add to missing_investors:', error.message);
    } else {
      console.log('[investor-research] Added to missing_investors:', cleaned, '| step:', errorStep);
    }
  } catch (e) {
    console.error('[investor-research] Error adding to missing_investors:', e);
  }
}

const STEP2_INPUT_TEMPLATE = `Act as a research analyst.

Create a full investor profile for {clean_name} ({investor_type}) including:
Background and career/professional/business history{person_background_detail}
Contact details, including verified emails, LinkedIn url, twitter url 
Best way to approach or pitch them or link to apply online/form/connect/submission page if available
Current fund or firm (including [name](url) for firm name and domain) and role and hq state, hq country
Investment stage and check size min and max, fund size, and lead investor or follow-on investor
Industry and technology focus
Geographic preference and investment geographies
Notable investments, portfolio companies and exits in format [name](url)
Co-Investors they back deals with (individuals or firms) in format [name](url) where url is domain for firm and LinkedIn URL for individual
Recent deals or activity
Public quotes, essays, or interviews that reveal investment philosophy
What this investor looks for in founders
Red flags or common reasons they pass
Recent exclusive articles, podcasts, videos with links

Use structured sections and keep the analysis concise but thorough.
For each section, give links for citations to ensure 100% correct information
Give a high-quality answer.`;

const STEP3_SYSTEM_MESSAGE = `Convert the following investor profile into a structured JSON object using the schema below.

Rules:
Use null if a field cannot be confidently inferred.
Use arrays where specified.
Normalize values where possible.
Do not invent data.
Dates should be in ISO format when available.
If multiple values apply, include all of them.
Use accurate text.
Output valid JSON only`;

function buildStep3Schema(isPerson: boolean): string {
  const personFields = isPerson
    ? '  "role": "",\n  "current_firm": "",\n  "work_experience_orgs": [],\n  "education_orgs": [],\n'
    : '  "current_firm": "",\n';
  const roleHint = isPerson
    ? 'role: pick from "CEO / Founder","Partner","Managing Partner","General Partner","Principal","Venture Partner","Operating Partner","Independent Investor / Angel","Associate","Research Analyst","Scout"\n'
    : '';
  const currentFirmHint = 'current_firm: str, firm name and domain in format [name](url), e.g. [Accel](accel.com)\n';
  const personHints = isPerson
    ? 'work_experience_orgs, education_orgs: list of strings in format [name](url) like coinvestors\n'
    : '';
  return (
    '{\n' +
    '  "linkedin_url": "",\n' +
    '  "twitter_url": "",\n' +
    '  "emails": [],\n' +
    '  "apply_url": "",\n' +
    personFields +
    '  "hq_state": "",\n' +
    '  "hq_country": "",\n' +
    '  "leads_round": true,\n' +
    '  "active": true,\n' +
    '  "fund_size_usd": null,\n' +
    '  "check_size_min_usd": null,\n' +
    '  "check_size_max_usd": null,\n' +
    '  "investment_stages": [],\n' +
    '  "investment_industries": [],\n' +
    '  "investment_geographies": [],\n' +
    '  "investment_thesis": "",\n' +
    '  "notable_investments": [],\n' +
    '  "coinvestors": [],\n' +
    '  "tier": ""\n' +
    '}\n\n' +
    roleHint +
    currentFirmHint +
    'hq_state, hq_country: as per ISO 3166-2 standard\n' +
    'investment_stages: pick all those that apply to the investor "pre-seed","seed","post-seed","series-a","series-b","series-c","growth","late-stage","pre-ipo","public-equity","angel"\n' +
    'investment_industries: pick all those that apply to the investor "artificial-intelligence","machine-learning","healthtech","biotech","digital-health","mental-health","wellness","longevity","fitness","consumer-health","medtech","pharma","genomics","bioinformatics","neuroscience","consumer-tech","enterprise-software","saas","vertical-saas","developer-tools","productivity","collaboration","fintech","payments","lending","credit","insurtech","regtech","wealthtech","climate-tech","energy","clean-energy","carbon-removal","sustainability","web3","blockchain","crypto","defi","nft","social-platforms","marketplaces","creator-economy","edtech","hr-tech","future-of-work","mobility","transportation","autonomous-vehicles","robotics","hardware","deep-tech","semiconductors","data-infrastructure","cloud-infrastructure","devops","cybersecurity","security","privacy","identity","digital-identity","consumer-internet","ecommerce","retail-tech","proptech","real-estate","construction-tech","smart-cities","supply-chain","logistics","manufacturing","industrial-tech","agtech","foodtech","gaming","esports","media","entertainment","music-tech","sports-tech","travel-tech","hospitality","martech","adtech","legal-tech","govtech","defense-tech","space-tech","aerospace","iot","edge-computing","network-effects"\n' +
    'investment_geographies: as per ISO 3166-2 standard\n' +
    'investment_thesis: Precise criteria to qualify, starts with Invests in....\n' +
    'notable_investments and coinvestors: list of strings in format [name](url)\n' +
    'tier: A|B|C - Grade this investor A, B, or C based on how popular, reputable, helpful, strong network, and founder-friendly they are\n' +
    personHints
  );
}

export const maxDuration = 100;

const EXA_API_KEYS = process.env.EXA_API_KEYS
  ? process.env.EXA_API_KEYS.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
  : [];

// skip_existing_values: true by default (from env)
const SKIP_EXISTING_VALUES =
  process.env.SKIP_EXISTING_VALUES !== undefined
    ? process.env.SKIP_EXISTING_VALUES === 'true' || process.env.SKIP_EXISTING_VALUES === '1'
    : true;

// pause_contacts: true by default - skip Organization flow (fetch contacts) after Step 3
const PAUSE_CONTACTS =
  process.env.PAUSE_CONTACTS !== undefined
    ? process.env.PAUSE_CONTACTS === 'true' || process.env.PAUSE_CONTACTS === '1'
    : true;

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

// Exa API retry configuration
const EXA_RETRYABLE_STATUS_CODES = [401, 402, 403, 429, 500, 501, 502, 503];
const EXA_KEY_SWITCH_STATUS_CODES = [401, 402, 403, 429]; // Switch to key index 0 for these
const EXA_MAX_RETRIES = 3;
const EXA_INITIAL_BACKOFF_MS = 1000;

// Deep Search API retry configuration
const DEEP_SEARCH_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 520, 521, 522, 523, 524];
const DEEP_SEARCH_MAX_RETRIES = 3;
const DEEP_SEARCH_INITIAL_BACKOFF_MS = 2000;

// Helper function to call Exa API with retry logic
async function callExaApiWithRetry(
  exaUrl: string,
  payload: object,
  exaKeys: string[],
  initialKeyIndex: number
): Promise<{ response: Response; usedKeyIndex: number }> {
  let lastError: { status: number; text: string } | null = null;
  let currentKeyIndex = initialKeyIndex;

  for (let attempt = 0; attempt < EXA_MAX_RETRIES; attempt++) {
    const exaKey = exaKeys[currentKeyIndex];
    
    console.log(`[investor-research] Exa API attempt ${attempt + 1}/${EXA_MAX_RETRIES}, key index: ${currentKeyIndex}`);
    console.log(JSON.stringify(payload, null, 2));
    const response = await fetch(exaUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': exaKey,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return { response, usedKeyIndex: currentKeyIndex };
    }

    const status = response.status;
    const errText = await response.text();
    lastError = { status, text: errText };

    console.warn(`[investor-research] Exa API error (attempt ${attempt + 1}): status=${status}, error=${errText}`);

    // Check if this is a retryable error
    if (!EXA_RETRYABLE_STATUS_CODES.includes(status)) {
      // Non-retryable error, throw immediately
      throw { status, text: errText, retryable: false };
    }

    // For auth/payment/rate limit errors (401, 402, 403, 429), switch to key at index 0 if not already using it
    if (EXA_KEY_SWITCH_STATUS_CODES.includes(status) && currentKeyIndex !== 0 && exaKeys.length > 1) {
      console.log(`[investor-research] Key issue (${status}), switching to Exa API key at index 0`);
      currentKeyIndex = 0;
    }

    // If we have more retries left, apply exponential backoff
    if (attempt < EXA_MAX_RETRIES - 1) {
      const backoffMs = EXA_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.log(`[investor-research] Retrying Exa API in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // All retries exhausted
  throw { status: lastError?.status || 500, text: lastError?.text || 'Max retries exceeded', retryable: true };
}

// Helper function to call Deep Search API with retry logic
async function callDeepSearchWithRetry(
  url: string,
  payload: object
): Promise<Response> {
  let lastError: { status: number; text: string } | null = null;

  for (let attempt = 0; attempt < DEEP_SEARCH_MAX_RETRIES; attempt++) {
    console.log(`[investor-research] Deep Search API attempt ${attempt + 1}/${DEEP_SEARCH_MAX_RETRIES}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return response;
    }

    const status = response.status;
    const errText = await response.text();
    lastError = { status, text: errText };

    console.warn(`[investor-research] Deep Search API error (attempt ${attempt + 1}): status=${status}, error=${errText.substring(0, 200)}`);

    // Check if this is a retryable error
    if (!DEEP_SEARCH_RETRYABLE_STATUS_CODES.includes(status)) {
      // Non-retryable error, throw immediately
      throw { status, text: errText, retryable: false };
    }

    // If we have more retries left, apply exponential backoff
    if (attempt < DEEP_SEARCH_MAX_RETRIES - 1) {
      const backoffMs = DEEP_SEARCH_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.log(`[investor-research] Retrying Deep Search API in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // All retries exhausted
  throw { status: lastError?.status || 500, text: lastError?.text || 'Max retries exceeded', retryable: true };
}

// Parse [name](url) format into { name, url }
function parseNameUrlFormat(s: string | null | undefined): { name: string; url: string } | null {
  if (!s || typeof s !== 'string') return null;
  const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(s.trim());
  if (!m) return null;
  const name = (m[1] || '').trim();
  const url = (m[2] || '').trim();
  return name || url ? { name, url } : null;
}

// Extract URLs from notable_investments in format [name](url)
function extractDomainsFromNotableInvestments(notableInvestments: string[] | null): string[] {
  if (!Array.isArray(notableInvestments) || notableInvestments.length === 0) return [];
  const re = /\[([^\]]*)\]\(([^)]*)\)/g;
  const urls = new Set<string>();
  for (const s of notableInvestments) {
    if (typeof s !== 'string') continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(s)) !== null) {
      const url = (m[2] || '').trim();
      if (!url) continue;
      const normalized = url.startsWith('http') ? url : `https://${url}`;
      urls.add(normalized);
    }
  }
  return [...urls];
}

// Normalize URL for comparison (origin + normalized path)
function normalizeUrlForCompare(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const s = url.trim();
  if (!s) return null;
  try {
    const full = s.startsWith('http') ? s : `https://${s}`;
    const u = new URL(full);
    const host = u.hostname.replace(/^www\./, '');
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    return `https://${host}${path}`;
  } catch {
    return null;
  }
}

// Clean domain or LinkedIn URL for display and API use
// Ensures lowercase and consistent formatting (e.g. accel.com, in/scottshleifer, company/accel, school/stanford)
export function cleanInvestorInput(input: string): { cleaned: string; type: 'domain' | 'linkedin'; domain: string | null; linkedinUrl: string | null } {
  if (!input || typeof input !== 'string') {
    return { cleaned: '', type: 'domain', domain: null, linkedinUrl: null };
  }
  let s = input.trim();
  if (!s) return { cleaned: '', type: 'domain', domain: null, linkedinUrl: null };

  // Detect LinkedIn: URL contains linkedin.com OR path-only format like in/name, company/name, school/name
  const isLinkedIn =
    /linkedin\.com\/[a-z]+\/[\w.-]+/i.test(s) ||
    s.toLowerCase().includes('linkedin.com') ||
    /^[a-z]+\/[\w.-]+$/i.test(s); // path-only e.g. in/namankas, company/accel, school/stanford

  if (isLinkedIn) {
    // Path-only input (e.g. in/namankas, company/accel, school/stanford) - lowercase and clean
    if (/^[a-z]+\/[\w.-]+$/i.test(s)) {
      const cleaned = s.toLowerCase().replace(/^\/+|\/+$/g, '');
      return { cleaned, type: 'linkedin', domain: null, linkedinUrl: cleaned };
    }
    if (!s.startsWith('http')) s = 'https://' + s;
    try {
      const u = new URL(s);
      // Store just the path (e.g. in/namankas, company/accel, school/stanford) - lowercase, no leading/trailing slashes
      const path = u.pathname.toLowerCase().replace(/^\/+|\/+$/g, '') || '';
      return { cleaned: path, type: 'linkedin', domain: null, linkedinUrl: path };
    } catch {
      const path = s.replace(/^https?:\/\/[^/]+/i, '').toLowerCase().replace(/^\/+|\/+$/g, '') || s.toLowerCase();
      return { cleaned: path, type: 'linkedin', domain: null, linkedinUrl: path };
    }
  }

  // Domain: cleaned is always just the domain (e.g. accel.com), lowercase, no www
  if (!s.startsWith('http')) s = 'https://' + s;
  try {
    const u = new URL(s);
    // URL.hostname is already lowercase per spec
    const domain = u.hostname.replace(/^www\./, '');
    return { cleaned: domain, type: 'domain', domain, linkedinUrl: null };
  } catch {
    const domain = s.toLowerCase().replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0] || s.toLowerCase();
    return { cleaned: domain, type: 'domain', domain, linkedinUrl: null };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { input, skipExisting, researchContext, affiliateWithFirmId, affiliateContactEmail } = body;

    console.log('[investor-research] POST received:', { input, skipExisting, researchContext, affiliateWithFirmId: !!affiliateWithFirmId });

    const skipExistingValues = skipExisting !== undefined ? !!skipExisting : SKIP_EXISTING_VALUES;
    console.log('[investor-research] skipExistingValues:', skipExistingValues, '(env default:', SKIP_EXISTING_VALUES, ')');

    if (!input || typeof input !== 'string') {
      return NextResponse.json({ error: 'Input (domain or LinkedIn URL) is required' }, { status: 400 });
    }

    const { cleaned, type, domain, linkedinUrl } = cleanInvestorInput(input);
    console.log('[investor-research] cleanInvestorInput result:', { cleaned, type, domain, linkedinUrl });
    if (!cleaned) {
      return NextResponse.json({ error: 'Could not parse domain or LinkedIn URL' }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    // Check existing if skip_existing_values
    if (skipExistingValues) {
      if (domain) {
        const { data: byDomain } = await supabase
          .from('investors')
          .select('id')
          .eq('domain', domain)
          .limit(1)
          .maybeSingle();
        if (byDomain) {
          console.log('[investor-research] Skipped (domain exists):', domain);
          if (affiliateWithFirmId) {
            const { data: existingAff } = await supabase
              .from('investor_affiliations')
              .select('id')
              .eq('person_id', byDomain.id)
              .eq('firm_id', affiliateWithFirmId)
              .maybeSingle();
            if (!existingAff) {
              await supabase.from('investor_affiliations').insert({
                id: randomUUID(),
                person_id: byDomain.id,
                firm_id: affiliateWithFirmId,
              });
            }
            if (affiliateContactEmail) {
              const { data: inv } = await supabase.from('investors').select('email').eq('id', byDomain.id).single();
              const currentEmails = inv?.email ? String(inv.email).split(/[,;]\s*/).filter(Boolean) : [];
              const merged = [...new Set([...currentEmails, affiliateContactEmail].filter(Boolean))];
              await supabase.from('investors').update({ email: merged.join(', ') }).eq('id', byDomain.id);
            }
          }
          return NextResponse.json({
            skipped: true,
            reason: 'domain_exists',
            investor_id: byDomain.id,
            cleaned,
            domain,
            linkedinUrl: null,
          });
        }
      }
      if (linkedinUrl) {
        // Extract the linkedin username (e.g. "anton-generalov" from "in/anton-generalov-a2827281")
        // LinkedIn URLs can have a numeric suffix that may vary, so we also check by username prefix
        const linkedinUsername = linkedinUrl.replace(/^in\//, '').replace(/-[a-z0-9]+$/i, '');
        console.log('[investor-research] Checking for existing linkedin_url:', linkedinUrl, '| username:', linkedinUsername);
        
        // First try exact match
        const { data: byLinkedIn } = await supabase
          .from('investors')
          .select('id, linkedin_url')
          .eq('linkedin_url', linkedinUrl)
          .limit(1)
          .maybeSingle();
        
        // If no exact match, try matching by username prefix (in/username or in/username-SUFFIX)
        let matchedInvestor = byLinkedIn;
        if (!matchedInvestor && linkedinUsername) {
          const { data: byLinkedInPrefix } = await supabase
            .from('investors')
            .select('id, linkedin_url')
            .like('linkedin_url', `in/${linkedinUsername}%`)
            .limit(1)
            .maybeSingle();
          if (byLinkedInPrefix) {
            console.log('[investor-research] Found by linkedin prefix match:', byLinkedInPrefix.linkedin_url);
            matchedInvestor = byLinkedInPrefix;
          }
        }
        
        if (matchedInvestor) {
          console.log('[investor-research] Skipped (linkedin exists):', linkedinUrl, '| matched:', matchedInvestor.linkedin_url);
          if (affiliateWithFirmId) {
            const { data: existingAff } = await supabase
              .from('investor_affiliations')
              .select('id')
              .eq('person_id', matchedInvestor.id)
              .eq('firm_id', affiliateWithFirmId)
              .maybeSingle();
            if (!existingAff) {
              await supabase.from('investor_affiliations').insert({
                id: randomUUID(),
                person_id: matchedInvestor.id,
                firm_id: affiliateWithFirmId,
              });
            }
            if (affiliateContactEmail) {
              const { data: inv } = await supabase.from('investors').select('email').eq('id', matchedInvestor.id).single();
              const currentEmails = inv?.email ? String(inv.email).split(/[,;]\s*/).filter(Boolean) : [];
              const merged = [...new Set([...currentEmails, affiliateContactEmail].filter(Boolean))];
              await supabase.from('investors').update({ email: merged.join(', ') }).eq('id', matchedInvestor.id);
            }
          }
          return NextResponse.json({
            skipped: true,
            reason: 'linkedin_exists',
            investor_id: matchedInvestor.id,
            cleaned,
            domain: null,
            linkedinUrl,
          });
        }
      }
    }

    if (EXA_API_KEYS.length === 0) {
      return NextResponse.json({ error: 'No Exa API keys configured' }, { status: 500 });
    }

    const initialKeyIndex = Math.floor(Math.random() * EXA_API_KEYS.length);
    const exaUrl = 'https://api.exa.ai/contents';

    // Exa API needs full URL; for domain use https://domain, for linkedin use full URL
    const exaUrlForIds = type === 'domain' ? `https://${cleaned}` : `https://www.linkedin.com/${cleaned}`;
    console.log('[investor-research] Calling Exa API for:', exaUrlForIds);

    const payload = {
      ids: [exaUrlForIds],
      text: { verbosity: 'compact' },
      subpages: 5,
      subpageTarget: ['about', 'portfolio', 'team', 'contact', 'thesis', 'investments', 'apply link'],
      summary: {
        query:
          'You are analyzing a website to determine whether it represents an investor.\n\nYour task:\n1. Determine whether the subject is a Person or an Organization.\n2. Determine whether the subject is an investor.\n3. If an investor, assign one or more investor types.\n4. Extract a clean, normalized name.\n\nDefinitions:\n- A Person is an individual acting under their own name.\n- An Organization is a company, fund, firm, or structured entity.\n- An investor may have multiple investor types.\n- If the subject does not clearly invest capital, mark it as Not an Investor.\n\nInvestor types may include:\n- Venture Capital\n- Angel Investor\n- Family Office\n- Private Equity\n- Hedge Fund\n- Corporate Venture Capital\n- Accelerator / Incubator\n- Investment Holding Company\n- Sovereign Wealth Fund\n- Institutional Investor\n- Fund of Funds\n- Venture Debt / Credit Investor\n- Crowdfunding / Community Investor\n- Government or Public Investment Fund\n\nRules:\n- Base decisions only on visible website content.\n- Do not infer or assume.\n- A person can be an investor.\n- An organization can have multiple investor types.\n- If no investment activity is clearly stated, classify as Not an Investor.\n- The clean_name should remove legal suffixes, fund numbers, and marketing terms.\n\nReturn the result strictly in the JSON format below.',
        schema: {
          description:
            'Schema for entities that can be either people or organizations, with investor classification and normalized naming',
          type: 'object',
          properties: {
            entity_type: {
              type: 'string',
              enum: ['Person', 'Organization'],
              description: 'Type of entity being described',
            },
            is_investor: {
              type: 'boolean',
              description: 'Whether this entity is an investor',
            },
              investor_types: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'Venture Capital',
                  'Angel Investor',
                  'Family Office',
                  'Private Equity',
                  'Hedge Fund',
                  'Corporate Venture Capital',
                  'Accelerator / Incubator',
                  'Investment Holding Company',
                  'Sovereign Wealth Fund',
                  'Institutional Investor',
                  'Fund of Funds',
                  'Venture Debt / Credit Investor',
                  'Crowdfunding / Community Investor',
                  'Government or Public Investment Fund'
                ],
              },
              description: 'Types of investment activities this entity engages in',
            },
            clean_name: {
              type: 'string',
              description: 'Normalized name without legal suffixes or branding noise',
            },
          },
          required: ['entity_type', 'is_investor', 'investor_types', 'clean_name'],
          additionalProperties: false,
        },
      },
    };

    let exaRes: Response;
    try {
      const result = await callExaApiWithRetry(exaUrl, payload, EXA_API_KEYS, initialKeyIndex);
      exaRes = result.response;
    } catch (exaError: unknown) {
      const err = exaError as { status?: number; text?: string; retryable?: boolean };
      const status = err?.status || 500;
      const errText = err?.text || 'Unknown Exa API error';
      console.error('Exa API error after retries:', status, errText);
      sendSlackNotification(`❌ Investor Research - Exa API Error (after ${EXA_MAX_RETRIES} retries)\nInput: ${cleaned}\nStatus: ${status}\nError: ${errText}`).catch(
        (slackErr) => console.error('Failed to send Slack notification:', slackErr)
      );
      // Add to missing_investors table
      await addToMissingInvestors(supabase, input, cleaned, type, 'exa_api', `Status ${status}: ${errText}`);
      return NextResponse.json(
        { error: 'Exa API failed', details: errText },
        { status: status >= 500 ? 502 : 400 }
      );
    }

    const exaData = await exaRes.json();
    const results = exaData?.results;
    console.log('[investor-research] Exa API response:', { hasResults: !!results, resultsLength: results?.length, firstResultKeys: results?.[0] ? Object.keys(results[0]) : [] });
    if (!results || !Array.isArray(results) || results.length === 0) {
      sendSlackNotification(`❌ Investor Research - Exa API No Results\nInput: ${cleaned}\nError: No results returned from Exa API`).catch(
        (err) => console.error('Failed to send Slack notification:', err)
      );
      // Add to missing_investors table
      await addToMissingInvestors(supabase, input, cleaned, type, 'exa_no_results', 'No results returned from Exa API');
      return NextResponse.json(
        { error: 'No results from Exa API', cleaned },
        { status: 502 }
      );
    }

    const first = results[0];
    let summary: {
      entity_type?: string;
      is_investor?: boolean;
      investor_types?: string[];
      clean_name?: string;
    } | null = null;

    if (first?.summary) {
      try {
        summary = typeof first.summary === 'string' ? JSON.parse(first.summary) : first.summary;
      } catch (e) {
        console.error('Failed to parse Exa summary:', e);
      }
    }

    const isInvestor = summary?.is_investor === true && summary?.investor_types?.length;
    const entityType = summary?.entity_type;
    const cleanName = summary?.clean_name || null;
    const investorTypes = isInvestor && summary?.investor_types ? summary.investor_types : null;

    console.log('[investor-research] Step 1: entity_type=', entityType, '| is_investor=', isInvestor, '| clean_name=', cleanName);

    // Build links from subpages: [title](url)
    const links: string[] = [];
    const subpages = first?.subpages;
    if (Array.isArray(subpages)) {
      for (const sp of subpages) {
        const title = sp?.title || sp?.url || '';
        const url = sp?.url || sp?.id || '';
        if (url) links.push(`[${title || url}](${url})`);
      }
    }

    const typeDb = entityType === 'Person' ? 'person' : entityType === 'Organization' ? 'firm' : null;

    const baseRow = {
      type: typeDb,
      name: cleanName,
      domain: domain || null,
      linkedin_url: linkedinUrl || null,
      investor_type: investorTypes,
      links: links.length ? links : null,
    };

    // Upsert: match by domain or linkedin_url
    let existingId: string | null = null;
    if (domain) {
      const { data } = await supabase.from('investors').select('id').eq('domain', domain).limit(1).maybeSingle();
      existingId = data?.id || null;
    }
    if (!existingId && linkedinUrl) {
      const { data } = await supabase.from('investors').select('id').eq('linkedin_url', linkedinUrl).limit(1).maybeSingle();
      existingId = data?.id || null;
    }

    // Non-investor: skip entirely (do not add to database)
    if (!isInvestor) {
      console.log('[investor-research] Non-investor: skipping:', { cleaned, entityType, cleanName });
      return NextResponse.json({
        skipped: true,
        reason: 'not_investor',
        cleaned,
        domain,
        linkedinUrl,
        summary: {
          entity_type: entityType,
          is_investor: false,
          investor_types: null,
          clean_name: cleanName,
        },
        links,
        message: 'Not an investor. Skipped.',
      });
    }

    // Investor: upsert base row first, then Step 2 + Step 3
    const rowId = existingId || randomUUID();
    if (existingId) {
      const { error: updErr } = await supabase.from('investors').update(baseRow).eq('id', existingId);
      if (updErr) {
        console.error('Investor update error:', updErr);
        sendSlackNotification(`❌ Investor Research - Database Update Error\nInput: ${cleaned}\nInvestor: ${cleanName}\nError: ${updErr.message}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        return NextResponse.json({ error: 'Failed to update investor', details: updErr.message }, { status: 500 });
      }
    } else {
      const { error: insErr } = await supabase.from('investors').insert({
        ...baseRow,
        id: rowId,
      });
      if (insErr) {
        console.error('Investor insert error:', insErr);
        sendSlackNotification(`❌ Investor Research - Database Insert Error\nInput: ${cleaned}\nInvestor: ${cleanName}\nError: ${insErr.message}`).catch(
          (err) => console.error('Failed to send Slack notification:', err)
        );
        return NextResponse.json({ error: 'Failed to insert investor', details: insErr.message }, { status: 500 });
      }
    }

    // Step 2: fashion-deep-search
    const investorTypeStr = investorTypes?.join(', ') || '';
    const personBackgroundDetail =
      entityType === 'Person'
        ? ', including companies they worked at and schools/universities they attended in format [name](url)'
        : '';
    const step2Input = STEP2_INPUT_TEMPLATE
      .replace('{clean_name}', cleanName || '')
      .replace('{investor_type}', investorTypeStr)
      .replace('{person_background_detail}', personBackgroundDetail);

    console.log('[investor-research] Step 2: Calling fashion-deep-search for:', cleanName);

    let deepSearchRes: Response;
    try {
      deepSearchRes = await callDeepSearchWithRetry(FASHION_DEEP_SEARCH_URL, { input: step2Input });
    } catch (deepSearchError: unknown) {
      const err = deepSearchError as { status?: number; text?: string; retryable?: boolean };
      const status = err?.status || 500;
      const errText = err?.text || 'Unknown Deep Search API error';
      console.error('[investor-research] fashion-deep-search error after retries:', status, errText.substring(0, 200));
      sendSlackNotification(`❌ Investor Research - Deep Search API Error (after ${DEEP_SEARCH_MAX_RETRIES} retries)\nInput: ${cleaned}\nInvestor: ${cleanName}\nStatus: ${status}\nError: ${errText.substring(0, 500)}`).catch(
        (slackErr) => console.error('Failed to send Slack notification:', slackErr)
      );
      // Add to missing_investors table
      await addToMissingInvestors(supabase, input, cleaned, type, 'deep_search_api', `Status ${status}: ${errText.substring(0, 500)}`);
      return NextResponse.json(
        { error: 'Deep search API failed', details: errText.substring(0, 1000) },
        { status: status >= 500 ? 502 : 400 }
      );
    }

    const deepSearchData = await deepSearchRes.json();
    // Response may be { data: "..." } or { "The response text from deep research is...": "..." } or similar
    let deepResearchText = '';
    if (typeof deepSearchData === 'string') {
      deepResearchText = deepSearchData;
    } else if (deepSearchData?.data) {
      deepResearchText = typeof deepSearchData.data === 'string' ? deepSearchData.data : JSON.stringify(deepSearchData.data);
    } else if (typeof deepSearchData === 'object') {
      const literalKey = 'The response text from deep research is...';
      if (deepSearchData[literalKey]) {
        deepResearchText = String(deepSearchData[literalKey]);
      } else {
        const keys = Object.keys(deepSearchData);
        const textKey = keys.find((k) => k.toLowerCase().includes('response') || k.toLowerCase().includes('text') || k.toLowerCase().includes('content'));
        deepResearchText = textKey ? (deepSearchData[textKey] || '') : (deepSearchData.result || deepSearchData.output || JSON.stringify(deepSearchData));
      }
    }

    if (!deepResearchText) {
      console.error('[investor-research] Could not extract deep research text from:', deepSearchData);
      sendSlackNotification(`❌ Investor Research - Deep Search Invalid Response\nInput: ${cleaned}\nInvestor: ${cleanName}\nError: Could not extract deep research text from response`).catch(
        (err) => console.error('Failed to send Slack notification:', err)
      );
      // Add to missing_investors table
      await addToMissingInvestors(supabase, input, cleaned, type, 'deep_search_invalid_response', 'Could not extract deep research text from response');
      return NextResponse.json(
        { error: 'Invalid deep search response format', details: deepSearchData },
        { status: 502 }
      );
    }

    console.log('[investor-research] Step 2 complete, deep research length:', deepResearchText.length, 'chars');

    // Step 3: Azure structured JSON extraction (role only when Person)
    const step3Schema = buildStep3Schema(entityType === 'Person');
    const step3UserMessage = `Analyze the investment profile.\n\n${step3Schema}\n\nInput text:\n<<<<${deepResearchText}>>>>`;

    const extracted = await getJsonCompletion(
      [
        { role: 'system', content: STEP3_SYSTEM_MESSAGE },
        { role: 'user', content: step3UserMessage },
      ]
    );

    if (extracted?.error) {
      console.error('[investor-research] Azure extraction error:', extracted);
      sendSlackNotification(`❌ Investor Research - Gemini/Azure Extraction Error\nInput: ${cleaned}\nInvestor: ${cleanName}\nError: ${typeof extracted.error === 'string' ? extracted.error : JSON.stringify(extracted.error)}`).catch(
        (err) => console.error('Failed to send Slack notification:', err)
      );
      // Add to missing_investors table
      const extractionErrMsg = typeof extracted.error === 'string' ? extracted.error : JSON.stringify(extracted.error);
      await addToMissingInvestors(supabase, input, cleaned, type, 'extraction_error', extractionErrMsg);
      return NextResponse.json(
        { error: 'Structured extraction failed', details: extracted.error },
        { status: 500 }
      );
    }

    // Extract current_firm [name](url) as JSON and console.log (do not update investor table)
    const currentFirmRaw = extracted?.current_firm;
    const currentFirmParsed = parseNameUrlFormat(
      typeof currentFirmRaw === 'string' ? currentFirmRaw : null
    );
    const currentFirmJson = currentFirmParsed
      ? JSON.stringify(currentFirmParsed)
      : JSON.stringify({ name: null, url: null });
    console.log('[investor-research] current_firm extracted:', currentFirmJson);

    // Build update row from extracted JSON (role only when Person)
    const emailStr = Array.isArray(extracted?.emails) ? extracted.emails.filter(Boolean).join(', ') : null;
    let applyUrl = extracted?.apply_url ?? null;
    // If apply_url is same as website (from domain), set to null
    if (applyUrl && domain) {
      const websiteNorm = normalizeUrlForCompare(`https://${domain}`);
      const applyNorm = normalizeUrlForCompare(applyUrl);
      if (websiteNorm && applyNorm && websiteNorm === applyNorm) {
        applyUrl = null;
      }
    }
    // Clean extracted linkedin_url (AI may return full URL) - lowercase, no leading/trailing slashes
    const extractedLinkedinUrl = extracted?.linkedin_url
      ? cleanInvestorInput(extracted.linkedin_url).linkedinUrl
      : null;
    // Prefer the original input linkedinUrl over AI-extracted one for consistency in duplicate detection
    // The input URL is the source of truth; AI extraction may return a different format (e.g., without numeric suffix)
    const updateRow: Record<string, unknown> = {
      linkedin_url: linkedinUrl ?? extractedLinkedinUrl ?? null,
      twitter_url: extracted?.twitter_url ?? null,
      active: extracted?.active ?? null,
      apply_url: applyUrl,
      coinvestors: Array.isArray(extracted?.coinvestors) ? extracted.coinvestors : null,
      email: emailStr ?? null,
      ...(entityType === 'Person' && {
        role: extracted?.role ?? null,
        work_experience_orgs: Array.isArray(extracted?.work_experience_orgs) ? extracted.work_experience_orgs : null,
        education_orgs: Array.isArray(extracted?.education_orgs) ? extracted.education_orgs : null,
      }),
      hq_state: extracted?.hq_state ?? null,
      hq_country: extracted?.hq_country ?? null,
      investor_type: Array.isArray(extracted?.investor_type) ? extracted.investor_type : investorTypes,
      fund_size_usd: typeof extracted?.fund_size_usd === 'number' ? extracted.fund_size_usd : null,
      check_size_min_usd: typeof extracted?.check_size_min_usd === 'number' ? extracted.check_size_min_usd : null,
      check_size_max_usd: typeof extracted?.check_size_max_usd === 'number' ? extracted.check_size_max_usd : null,
      investment_stages: Array.isArray(extracted?.investment_stages) ? extracted.investment_stages : null,
      investment_industries: Array.isArray(extracted?.investment_industries) ? extracted.investment_industries : null,
      investment_geographies: Array.isArray(extracted?.investment_geographies) ? extracted.investment_geographies : null,
      investment_thesis: extracted?.investment_thesis ?? null,
      notable_investments: Array.isArray(extracted?.notable_investments) ? extracted.notable_investments : null,
      deep_research: deepResearchText,
      leads_round: typeof extracted?.leads_round === 'boolean' ? extracted.leads_round : null,
      tier: typeof extracted?.tier === 'string' && ['A', 'B', 'C'].includes(extracted.tier) ? extracted.tier : null,
    };

    const { error: finalUpdErr } = await supabase.from('investors').update(updateRow).eq('id', rowId);
    if (finalUpdErr) {
      console.error('[investor-research] Final update error:', finalUpdErr);
      sendSlackNotification(`❌ Investor Research - Database Final Update Error\nInput: ${cleaned}\nInvestor: ${cleanName}\nError: ${finalUpdErr.message}`).catch(
        (err) => console.error('Failed to send Slack notification:', err)
      );
      return NextResponse.json({ error: 'Failed to update investor with deep research', details: finalUpdErr.message }, { status: 500 });
    }

    console.log('[investor-research] Step 3 complete, updated investor:', rowId);

    let contactsPendingResponse: { firm_id: string; contacts: { input: string; affiliateContactEmail?: string; full_name?: string }[] } | null = null;

    // --- Organization flow: get contacts, return for frontend to process ---
    if (PAUSE_CONTACTS) {
      if (entityType === 'Organization' && domain) {
        console.log('[investor-research] Organization flow: skipped (PAUSE_CONTACTS=true)');
      }
    } else if (entityType === 'Organization' && domain) {
      console.log('[investor-research] Organization flow: fetching contacts for domain:', domain);
      try {
        const investorSearchRes = await fetch(INVESTOR_SEARCH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });
        if (investorSearchRes.ok) {
          const investorSearchData = await investorSearchRes.json();
          const contacts = Array.isArray(investorSearchData?.results) ? investorSearchData.results : [];
          console.log('[investor-research] Organization flow: got', contacts.length, 'contacts from investor-search');
          const contactsPending: { input: string; affiliateContactEmail?: string; full_name?: string }[] = [];
          for (const contact of contacts) {
            const contactLinkedIn = contact?.linkedin_url;
            if (!contactLinkedIn || typeof contactLinkedIn !== 'string') {
              console.log('[investor-research] Organization flow: skipping contact (no linkedin_url):', contact?.full_name || contact?.person_id);
              continue;
            }
            const linkedInInput = contactLinkedIn.startsWith('http') ? contactLinkedIn : `https://www.linkedin.com/${contactLinkedIn.replace(/^\//, '')}`;
            const affiliateContactEmail = contact?.email && contact?.email_status === 'verified' ? contact.email : undefined;
            contactsPending.push({
              input: linkedInInput,
              affiliateContactEmail,
              full_name: contact?.full_name,
            });
          }
          if (contactsPending.length > 0) {
            contactsPendingResponse = { firm_id: rowId, contacts: contactsPending };
            console.log('[investor-research] Organization flow: returning', contactsPending.length, 'contacts for frontend to process');
          }
        } else {
          console.log('[investor-research] Organization flow: investor-search failed', investorSearchRes.status);
        }
      } catch (e) {
        // Extract cause for fetch errors
        let errMsg = e instanceof Error ? e.message : String(e);
        const errCause = e instanceof Error && 'cause' in e ? e.cause : undefined;
        if (errCause instanceof Error) {
          errMsg += ` | Cause: ${errCause.message}`;
        }
        console.error('[investor-research] investor-search error:', errMsg);
      }
    } else if (entityType === 'Organization' && !domain) {
      console.log('[investor-research] Organization flow: skipped (no domain for org)');
    }

    // --- Person flow: get firm, lookup or research, create affiliation ---
    // Skip if: (1) already researching firm from person (infinite loop prevention), or (2) affiliateWithFirmId is provided (we already know the firm)
    if (entityType === 'Person' && researchContext === 'firm_from_person') {
      console.log('[investor-research] Person flow: skipped (researchContext=firm_from_person, infinite loop prevention)');
    }
    if (entityType === 'Person' && affiliateWithFirmId) {
      console.log('[investor-research] Person flow: skipped (affiliateWithFirmId provided, firm already known)');
    }
    if (entityType === 'Person' && researchContext !== 'firm_from_person' && !affiliateWithFirmId && currentFirmParsed?.url) {
      const { domain: firmDomain } = cleanInvestorInput(currentFirmParsed.url);
      const firmDomainForRpc = firmDomain || currentFirmParsed.url;
      console.log('[investor-research] Person flow: looking up firm for person', cleanName, '| firm domain:', firmDomainForRpc);
      const { data: firmIdFromRpc } = await supabase.rpc('get_investor_id_by_domain_or_linkedin', {
        p_domain: firmDomainForRpc,
      });
      if (firmIdFromRpc) {
        console.log('[investor-research] Person flow: firm found in DB:', firmIdFromRpc);
        const { data: existingAff } = await supabase
          .from('investor_affiliations')
          .select('id')
          .eq('person_id', rowId)
          .eq('firm_id', firmIdFromRpc)
          .maybeSingle();
        if (!existingAff) {
          const { error: affErr } = await supabase.from('investor_affiliations').insert({
            id: randomUUID(),
            person_id: rowId,
            firm_id: firmIdFromRpc,
          });
          if (affErr) console.error('[investor-research] Affiliation insert error:', affErr);
          else console.log('[investor-research] Person flow: created affiliation person', rowId, '-> firm', firmIdFromRpc);
        } else {
          console.log('[investor-research] Person flow: affiliation already exists');
        }
      } else {
        console.log('[investor-research] Person flow: firm not in DB, researching firm:', firmDomainForRpc);
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (req.url ? new URL(req.url).origin : '');
        if (baseUrl) {
        try {
          const firmRes = await fetch(`${baseUrl}/api/investor-research`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: firmDomainForRpc,
              skipExisting: true,
              researchContext: 'firm_from_person',
            }),
          });
          
          // Check if response is OK and has JSON content-type before parsing
          const contentType = firmRes.headers.get('content-type') || '';
          if (!firmRes.ok || !contentType.includes('application/json')) {
            const errText = await firmRes.text();
            console.error('[investor-research] Person flow: firm research API error:', firmRes.status, errText.substring(0, 200));
            throw new Error(`Firm research failed: ${firmRes.status} - ${errText.substring(0, 100)}`);
          }
          
          const firmData = await firmRes.json();
          const firmInvestorId = firmData?.investor_id;
          console.log('[investor-research] Person flow: firm research result:', { firmInvestorId, error: firmData?.error, research_status: firmData?.research_status });
          if (firmInvestorId && !firmData?.error && !firmData?.skipped) {
            const { data: existingAff } = await supabase
              .from('investor_affiliations')
              .select('id')
              .eq('person_id', rowId)
              .eq('firm_id', firmInvestorId)
              .maybeSingle();
            if (!existingAff) {
              const { error: affErr } = await supabase.from('investor_affiliations').insert({
                id: randomUUID(),
                person_id: rowId,
                firm_id: firmInvestorId,
              });
              if (affErr) console.error('[investor-research] Affiliation insert error:', affErr);
              else console.log('[investor-research] Person flow: created affiliation person', rowId, '-> firm', firmInvestorId);
            }
          } else {
            console.log('[investor-research] Person flow: firm not added (not investor or error)');
          }
        } catch (e) {
          // Extract cause for fetch errors
          let errMsg = e instanceof Error ? e.message : String(e);
          const errCause = e instanceof Error && 'cause' in e ? e.cause : undefined;
          if (errCause instanceof Error) {
            errMsg += ` | Cause: ${errCause.message}`;
          }
          console.error('[investor-research] Firm research from person error:', errMsg);
        }
        } else {
          console.warn('[investor-research] baseUrl not set, skipping firm research self-call');
        }
      }
    } else if (entityType === 'Person' && researchContext !== 'firm_from_person' && !affiliateWithFirmId && !currentFirmParsed?.url) {
      console.log('[investor-research] Person flow: skipped (no current_firm in Step 3)');
    }

    // Fire-and-forget founder-search for all notable investment domains
    // PAUSE_FOUNDER_SEARCH env var: 'true' or unset = paused (default), 'false' = enabled
    const pauseFounderSearch = process.env.PAUSE_FOUNDER_SEARCH !== 'false';
    const notableInvestments = Array.isArray(extracted?.notable_investments) ? extracted.notable_investments : null;
    const domains = extractDomainsFromNotableInvestments(notableInvestments);
    if (domains.length > 0 && !pauseFounderSearch) {
      fetch(FOUNDER_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains }),
      }).catch((e) => {
        let errMsg = e instanceof Error ? e.message : String(e);
        const errCause = e instanceof Error && 'cause' in e ? e.cause : undefined;
        if (errCause instanceof Error) errMsg += ` | Cause: ${errCause.message}`;
        console.error('[investor-research] founder-search fire-and-forget error:', errMsg);
      });
    } else if (domains.length > 0 && pauseFounderSearch) {
      console.log('[investor-research] founder-search paused (PAUSE_FOUNDER_SEARCH=true), skipped', domains.length, 'domains');
    }

    // When called with affiliateWithFirmId (e.g. from Organization flow fire-and-forget), create affiliation
    if (affiliateWithFirmId && isInvestor) {
      const { data: existingAff } = await supabase
        .from('investor_affiliations')
        .select('id')
        .eq('person_id', rowId)
        .eq('firm_id', affiliateWithFirmId)
        .maybeSingle();
      if (!existingAff) {
        await supabase.from('investor_affiliations').insert({
          id: randomUUID(),
          person_id: rowId,
          firm_id: affiliateWithFirmId,
        });
        console.log('[investor-research] Created affiliation (affiliateWithFirmId): person', rowId, '-> firm', affiliateWithFirmId);
      }
      if (affiliateContactEmail) {
        const { data: inv } = await supabase.from('investors').select('email').eq('id', rowId).single();
        const currentEmails = inv?.email ? String(inv.email).split(/[,;]\s*/).filter(Boolean) : [];
        const merged = [...new Set([...currentEmails, affiliateContactEmail].filter(Boolean))];
        await supabase.from('investors').update({ email: merged.join(', ') }).eq('id', rowId);
        console.log('[investor-research] Merged affiliateContactEmail for person', rowId);
      }
    }

    console.log('[investor-research] Done. investor_id=', rowId, '| entity_type=', entityType);
    const response: Record<string, unknown> = {
      investor_id: rowId,
      cleaned,
      domain,
      linkedinUrl,
      summary: {
        entity_type: entityType,
        is_investor: isInvestor,
        investor_types: investorTypes,
        clean_name: cleanName,
      },
      links,
      updated: true,
      deep_research_complete: true,
    };
    if (contactsPendingResponse) {
      response.contacts_pending = contactsPendingResponse;
    }
    return NextResponse.json(response);
  } catch (err) {
    console.error('Investor research error:', err);
    // Extract detailed error info including cause (for fetch errors like ECONNREFUSED, ETIMEDOUT, etc.)
    let msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && 'cause' in err ? err.cause : undefined;
    let causeMsg = '';
    if (cause) {
      if (cause instanceof Error) {
        causeMsg = cause.message;
        // Check for nested cause (common with fetch errors)
        if ('cause' in cause && cause.cause instanceof Error) {
          causeMsg += ` -> ${cause.cause.message}`;
        }
      } else if (typeof cause === 'string') {
        causeMsg = cause;
      } else if (typeof cause === 'object') {
        causeMsg = JSON.stringify(cause);
      }
    }
    const fullMsg = causeMsg ? `${msg} | Cause: ${causeMsg}` : msg;
    console.error('Investor research error details:', { message: msg, cause: causeMsg, stack: err instanceof Error ? err.stack : undefined });
    sendSlackNotification(`❌ Investor Research - Unexpected Error\nError: ${fullMsg}`).catch(
      (slackErr) => console.error('Failed to send Slack notification:', slackErr)
    );
    // Try to add to missing_investors if we have the required info
    try {
      const body = await req.clone().json().catch(() => null);
      const inputForMissing = body?.input;
      if (inputForMissing && typeof inputForMissing === 'string') {
        const { cleaned: cleanedForMissing, type: typeForMissing } = cleanInvestorInput(inputForMissing);
        if (cleanedForMissing) {
          const supabaseForMissing = getSupabaseClient();
          if (supabaseForMissing) {
            await addToMissingInvestors(supabaseForMissing, inputForMissing, cleanedForMissing, typeForMissing, 'unexpected_error', fullMsg);
          }
        }
      }
    } catch (missingErr) {
      console.error('[investor-research] Failed to add to missing_investors in catch block:', missingErr);
    }
    return NextResponse.json({ error: 'Investor research failed', details: fullMsg }, { status: 500 });
  }
}
