// /app/api/investor-research/route.ts
// Step 1: Exa contents API for investor classification + upsert to investors table
// Step 2 (investors only): fashion-deep-search for full profile
// Step 3 (investors only): Azure structured JSON extraction + DB update

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';

const FASHION_DEEP_SEARCH_URL = 'https://quycdewohkhmetiawogg.supabase.co/functions/v1/fashion-deep-search';

const STEP2_INPUT_TEMPLATE = `Act as a research analyst.

Create a full investor profile for {clean_name} ({investor_type}) including:
Background and career/professional/business history
Contact details, including verified emails, LinkedIn url, twitter url 
Current fund or firm and role and hq state, hq country
Investment stage and check size min and max, fund size, and lead investor or follow-on investor
Industry and technology focus
Geographic preference and investment geographies
Notable investments and exits in format [name](url)
Recent deals or activity
Public quotes, essays, or interviews that reveal investment philosophy
What this investor looks for in founders
Red flags or common reasons they pass
Best way to approach or pitch them
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
  const roleField = isPerson ? '  "role": "",\n' : '';
  const roleHint = isPerson
    ? 'role: pick from "CEO / Founder","Partner","Managing Partner","General Partner","Principal","Venture Partner","Operating Partner","Independent Investor / Angel","Associate","Research Analyst","Scout"\n'
    : '';
  return (
    '{\n' +
    '  "linkedin_url": "",\n' +
    '  "twitter_url": "",\n' +
    '  "emails": [],\n' +
    roleField +
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
    '  "notable_investments": []\n' +
    '}\n\n' +
    roleHint +
    'hq_state, hq_country: as per ISO 3166-2 standard\n' +
    'investment_stages: pick from "pre-seed","seed","post-seed","series-a","series-b","series-c","growth","late-stage","pre-ipo","public-equity","angel"\n' +
    'investment_industries: pick from "artificial-intelligence","machine-learning","healthtech","biotech","digital-health","mental-health","wellness","longevity","fitness","consumer-health","medtech","pharma","genomics","bioinformatics","neuroscience","consumer-tech","enterprise-software","saas","vertical-saas","developer-tools","productivity","collaboration","fintech","payments","lending","credit","insurtech","regtech","wealthtech","climate-tech","energy","clean-energy","carbon-removal","sustainability","web3","blockchain","crypto","defi","nft","social-platforms","marketplaces","creator-economy","edtech","hr-tech","future-of-work","mobility","transportation","autonomous-vehicles","robotics","hardware","deep-tech","semiconductors","data-infrastructure","cloud-infrastructure","devops","cybersecurity","security","privacy","identity","digital-identity","consumer-internet","ecommerce","retail-tech","proptech","real-estate","construction-tech","smart-cities","supply-chain","logistics","manufacturing","industrial-tech","agtech","foodtech","gaming","esports","media","entertainment","music-tech","sports-tech","travel-tech","hospitality","martech","adtech","legal-tech","govtech","defense-tech","space-tech","aerospace","iot","edge-computing","network-effects"\n' +
    'investment_geographies: as per ISO 3166-2 standard\n' +
    'investment_thesis: Precise criteria to qualify, starts with Invests in....\n' +
    'notable_investments: list of strings in format [name](url)'
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

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

// Clean domain or LinkedIn URL for display and API use
export function cleanInvestorInput(input: string): { cleaned: string; type: 'domain' | 'linkedin'; domain: string | null; linkedinUrl: string | null } {
  if (!input || typeof input !== 'string') {
    return { cleaned: '', type: 'domain', domain: null, linkedinUrl: null };
  }
  let s = input.trim();
  if (!s) return { cleaned: '', type: 'domain', domain: null, linkedinUrl: null };

  const isLinkedIn =
    /linkedin\.com\/(company|in)\/[\w.-]+/i.test(s) ||
    s.toLowerCase().includes('linkedin.com') ||
    /^(in|company)\/[\w.-]+$/i.test(s); // path-only e.g. in/namankas

  if (isLinkedIn) {
    // Path-only input (e.g. in/namankas) - use as-is
    if (/^(in|company)\/[\w.-]+$/i.test(s)) {
      return { cleaned: s, type: 'linkedin', domain: null, linkedinUrl: s };
    }
    if (!s.startsWith('http')) s = 'https://' + s;
    try {
      const u = new URL(s);
      // Store just the path (e.g. in/namankas, company/accel) for efficiency
      const path = u.pathname.replace(/^\/+|\/+$/g, '') || '';
      const cleaned = path;
      return { cleaned, type: 'linkedin', domain: null, linkedinUrl: cleaned };
    } catch {
      const path = s.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '') || s;
      return { cleaned: path, type: 'linkedin', domain: null, linkedinUrl: path };
    }
  }

  // Domain: cleaned is always just the domain (e.g. accel.com), not the full URL
  if (!s.startsWith('http')) s = 'https://' + s;
  try {
    const u = new URL(s);
    const hostname = u.hostname;
    const domain = hostname.replace(/^www\./, '');
    return { cleaned: domain, type: 'domain', domain, linkedinUrl: null };
  } catch {
    const domain = s.replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0] || s;
    return { cleaned: domain, type: 'domain', domain, linkedinUrl: null };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { input, skipExisting } = body;

    console.log('[investor-research] POST received:', { input, skipExisting });

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
          return NextResponse.json({
            skipped: true,
            reason: 'domain_exists',
            cleaned,
            domain,
            linkedinUrl: null,
          });
        }
      }
      if (linkedinUrl) {
        const { data: byLinkedIn } = await supabase
          .from('investors')
          .select('id')
          .eq('linkedin_url', linkedinUrl)
          .limit(1)
          .maybeSingle();
        if (byLinkedIn) {
          console.log('[investor-research] Skipped (linkedin exists):', linkedinUrl);
          return NextResponse.json({
            skipped: true,
            reason: 'linkedin_exists',
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

    const exaKey = EXA_API_KEYS[Math.floor(Math.random() * EXA_API_KEYS.length)];
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
          'You are analyzing a website to determine whether it represents an investor.\n\nYour task:\n1. Determine whether the subject is a Person or an Organization.\n2. Determine whether the subject is an investor.\n3. If an investor, assign one or more investor types.\n4. Extract a clean, normalized name.\n\nDefinitions:\n- A Person is an individual acting under their own name.\n- An Organization is a company, fund, firm, or structured entity.\n- An investor may have multiple investor types.\n- If the subject does not clearly invest capital, mark it as Not an Investor.\n\nInvestor types may include:\n- Venture Capital\n- Angel Investor\n- Family Office\n- Private Equity\n- Hedge Fund\n- Corporate Venture\n- Accelerator / Incubator\n- Investment Holding Company\n\nRules:\n- Base decisions only on visible website content.\n- Do not infer or assume.\n- A person can be an investor.\n- An organization can have multiple investor types.\n- If no investment activity is clearly stated, classify as Not an Investor.\n- The clean_name should remove legal suffixes, fund numbers, and marketing terms.\n\nReturn the result strictly in the JSON format defined below.',
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
                  'Corporate Venture',
                  'Accelerator / Incubator',
                  'Investment Holding Company',
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

    const exaRes = await fetch(exaUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': exaKey,
      },
      body: JSON.stringify(payload),
    });

    if (!exaRes.ok) {
      const errText = await exaRes.text();
      console.error('Exa API error:', exaRes.status, errText);
      return NextResponse.json(
        { error: 'Exa API failed', details: errText },
        { status: exaRes.status >= 500 ? 502 : 400 }
      );
    }

    const exaData = await exaRes.json();
    const results = exaData?.results;
    console.log('[investor-research] Exa API response:', { hasResults: !!results, resultsLength: results?.length, firstResultKeys: results?.[0] ? Object.keys(results[0]) : [] });
    if (!results || !Array.isArray(results) || results.length === 0) {
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

    console.log('[investor-research] Parsed summary:', { summary, isInvestor, entityType, cleanName, investorTypes });

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

    // Non-investor: mark as to_do for future processing
    if (!isInvestor) {
      const row = {
        ...baseRow,
        research_status: 'to_do',
      };
      console.log('[investor-research] Non-investor: marking as to_do:', row);

      if (existingId) {
        const { error: updErr } = await supabase.from('investors').update(row).eq('id', existingId);
        if (updErr) {
          console.error('Investor update error:', updErr);
          return NextResponse.json({ error: 'Failed to update investor', details: updErr.message }, { status: 500 });
        }
      } else {
        const { error: insErr } = await supabase.from('investors').insert({
          ...row,
          id: randomUUID(),
        });
        if (insErr) {
          console.error('Investor insert error:', insErr);
          return NextResponse.json({ error: 'Failed to insert investor', details: insErr.message }, { status: 500 });
        }
      }

      return NextResponse.json({
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
        research_status: 'to_do',
        message: 'Not an investor. Marked as to_do for future processing.',
      });
    }

    // Investor: upsert base row first, then Step 2 + Step 3
    const rowId = existingId || randomUUID();
    if (existingId) {
      const { error: updErr } = await supabase.from('investors').update(baseRow).eq('id', existingId);
      if (updErr) {
        console.error('Investor update error:', updErr);
        return NextResponse.json({ error: 'Failed to update investor', details: updErr.message }, { status: 500 });
      }
    } else {
      const { error: insErr } = await supabase.from('investors').insert({
        ...baseRow,
        id: rowId,
      });
      if (insErr) {
        console.error('Investor insert error:', insErr);
        return NextResponse.json({ error: 'Failed to insert investor', details: insErr.message }, { status: 500 });
      }
    }

    // Step 2: fashion-deep-search
    const investorTypeStr = investorTypes?.join(', ') || '';
    const step2Input = STEP2_INPUT_TEMPLATE
      .replace('{clean_name}', cleanName || '')
      .replace('{investor_type}', investorTypeStr);

    console.log('[investor-research] Step 2: Calling fashion-deep-search for:', cleanName);

    const deepSearchRes = await fetch(FASHION_DEEP_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: step2Input }),
    });

    if (!deepSearchRes.ok) {
      const errText = await deepSearchRes.text();
      console.error('[investor-research] fashion-deep-search error:', deepSearchRes.status, errText);
      return NextResponse.json(
        { error: 'Deep search API failed', details: errText },
        { status: deepSearchRes.status >= 500 ? 502 : 400 }
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
      return NextResponse.json(
        { error: 'Invalid deep search response format', details: deepSearchData },
        { status: 502 }
      );
    }

    console.log('[investor-research] Step 2 complete, deep research length:', deepResearchText.length);

    // Step 3: Azure structured JSON extraction (role only when Person)
    const step3Schema = buildStep3Schema(entityType === 'Person');
    const step3UserMessage = `Analyze the investment profile.\n\n${step3Schema}\n\nInput text:\n<<<<${deepResearchText}>>>>`;

    const extracted = await getJsonCompletion(
      [
        { role: 'system', content: STEP3_SYSTEM_MESSAGE },
        { role: 'user', content: step3UserMessage },
      ],
      { max_tokens: 4000 }
    );

    if (extracted?.error) {
      console.error('[investor-research] Azure extraction error:', extracted);
      return NextResponse.json(
        { error: 'Structured extraction failed', details: extracted.error },
        { status: 500 }
      );
    }

    // Build update row from extracted JSON (role only when Person)
    const emailStr = Array.isArray(extracted?.emails) ? extracted.emails.filter(Boolean).join(', ') : null;
    const updateRow: Record<string, unknown> = {
      linkedin_url: extracted?.linkedin_url ?? null,
      twitter_url: extracted?.twitter_url ?? null,
      active: extracted?.active ?? null,
      email: emailStr ?? null,
      ...(entityType === 'Person' && { role: extracted?.role ?? null }),
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
    };

    const { error: finalUpdErr } = await supabase.from('investors').update(updateRow).eq('id', rowId);
    if (finalUpdErr) {
      console.error('[investor-research] Final update error:', finalUpdErr);
      return NextResponse.json({ error: 'Failed to update investor with deep research', details: finalUpdErr.message }, { status: 500 });
    }

    console.log('[investor-research] Step 3 complete, updated investor:', rowId);

    return NextResponse.json({
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
    });
  } catch (err) {
    console.error('Investor research error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'Investor research failed', details: msg }, { status: 500 });
  }
}
