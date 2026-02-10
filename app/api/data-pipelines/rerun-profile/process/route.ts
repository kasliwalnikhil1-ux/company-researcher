import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getJsonCompletion } from '@/utils/azureOpenAiHelper';
import {
  STEP3_SYSTEM_MESSAGE,
  buildStep3Schema,
  cleanInvestorInput,
  normalizeUrlForCompare,
} from '@/app/api/investor-research/route';

/** Allowed user IDs (same as Data Pipelines page) */
const ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

/** Auth client (anon key + user token) for verifying user identity */
function getAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) throw new Error('Missing Supabase environment variables');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Service role client for data queries (bypasses RLS) */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase service role key');
  return createClient(url, key);
}

export const maxDuration = 60;

/**
 * POST /api/data-pipelines/rerun-profile/process
 *
 * Process a single investor by re-running Step 3 (LLM structured extraction) on their
 * existing deep_research text. Does NOT re-run deep search — only re-extracts structured
 * fields via LLM and updates the investor row.
 *
 * Body: { investorId: string }
 * Returns: { success: true, investorId, name, fieldsUpdated: string[] } or { error: string }
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // Auth check with anon key
    const authClient = getAuthClient(token);
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    if (!ALLOWED_USER_IDS.has(user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const supabase = getServiceClient();

    const body = await request.json();
    const { investorId } = body;

    if (!investorId || typeof investorId !== 'string') {
      return NextResponse.json({ error: 'investorId is required' }, { status: 400 });
    }

    // Fetch investor record
    const { data: investor, error: fetchError } = await supabase
      .from('investors')
      .select('id, name, type, domain, linkedin_url, investor_type, deep_research')
      .eq('id', investorId)
      .single();

    if (fetchError || !investor) {
      return NextResponse.json({ error: 'Investor not found' }, { status: 404 });
    }

    const deepResearchText = investor.deep_research;
    if (!deepResearchText || typeof deepResearchText !== 'string' || deepResearchText.trim().length === 0) {
      return NextResponse.json({ error: 'Investor has no deep_research text to process' }, { status: 400 });
    }

    const isPerson = investor.type === 'person';
    const entityType = isPerson ? 'Person' : 'Organization';

    console.log(`[rerun-profile] Processing investor ${investorId} (${investor.name}) | type=${entityType} | deep_research length=${deepResearchText.length}`);

    // ── Step 3: LLM structured extraction (reusing prompts from investor-research) ──
    const step3Schema = buildStep3Schema(isPerson);
    const step3UserMessage = `Analyze the investment profile.\n\n${step3Schema}\n\nInput text:\n<<<<${deepResearchText}>>>>`;

    const extracted = await getJsonCompletion([
      { role: 'system', content: STEP3_SYSTEM_MESSAGE },
      { role: 'user', content: step3UserMessage },
    ]);

    if (extracted?.error) {
      console.error('[rerun-profile] LLM extraction error:', extracted);
      return NextResponse.json(
        { error: 'Structured extraction failed', details: extracted.error },
        { status: 500 }
      );
    }

    // ── Build update row (same logic as investor-research Step 3) ──
    const emailStr = Array.isArray(extracted?.emails)
      ? extracted.emails.filter(Boolean).join(', ')
      : null;

    let applyUrl = extracted?.apply_url ?? null;
    // If apply_url is same as website (from domain), set to null
    if (applyUrl && investor.domain) {
      const websiteNorm = normalizeUrlForCompare(`https://${investor.domain}`);
      const applyNorm = normalizeUrlForCompare(applyUrl);
      if (websiteNorm && applyNorm && websiteNorm === applyNorm) {
        applyUrl = null;
      }
    }

    // Clean extracted linkedin_url (AI may return full URL)
    const extractedLinkedinUrl = extracted?.linkedin_url
      ? cleanInvestorInput(extracted.linkedin_url).linkedinUrl
      : null;

    // Prefer existing DB linkedin_url over AI-extracted one
    const updateRow: Record<string, unknown> = {
      linkedin_url: investor.linkedin_url ?? extractedLinkedinUrl ?? null,
      twitter_url: extracted?.twitter_url ?? null,
      active: extracted?.active ?? null,
      apply_url: applyUrl,
      coinvestors: Array.isArray(extracted?.coinvestors) ? extracted.coinvestors : null,
      email: emailStr ?? null,
      ...(isPerson && {
        role: extracted?.role ?? null,
        work_experience_orgs: Array.isArray(extracted?.work_experience_orgs) ? extracted.work_experience_orgs : null,
        education_orgs: Array.isArray(extracted?.education_orgs) ? extracted.education_orgs : null,
      }),
      hq_state: extracted?.hq_state ?? null,
      hq_country: extracted?.hq_country ?? null,
      investor_type: Array.isArray(extracted?.investor_type)
        ? extracted.investor_type
        : investor.investor_type,
      fund_size_usd: typeof extracted?.fund_size_usd === 'number' ? extracted.fund_size_usd : null,
      check_size_min_usd: typeof extracted?.check_size_min_usd === 'number' ? extracted.check_size_min_usd : null,
      check_size_max_usd: typeof extracted?.check_size_max_usd === 'number' ? extracted.check_size_max_usd : null,
      investment_stages: Array.isArray(extracted?.investment_stages) ? extracted.investment_stages : null,
      investment_industries: Array.isArray(extracted?.investment_industries) ? extracted.investment_industries : null,
      investment_geographies: Array.isArray(extracted?.investment_geographies) ? extracted.investment_geographies : null,
      investment_thesis: extracted?.investment_thesis ?? null,
      notable_investments: Array.isArray(extracted?.notable_investments) ? extracted.notable_investments : null,
      leads_round: typeof extracted?.leads_round === 'boolean' ? extracted.leads_round : null,
      tier: typeof extracted?.tier === 'string' && ['A', 'B', 'C'].includes(extracted.tier)
        ? extracted.tier
        : null,
    };

    const { error: updateError } = await supabase
      .from('investors')
      .update(updateRow)
      .eq('id', investorId);

    if (updateError) {
      console.error('[rerun-profile] Update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update investor', details: updateError.message },
        { status: 500 }
      );
    }

    // Count which fields were actually set (non-null)
    const fieldsUpdated = Object.entries(updateRow)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k]) => k);

    console.log(`[rerun-profile] Updated investor ${investorId} (${investor.name}) | fields: ${fieldsUpdated.length}`);

    return NextResponse.json({
      success: true,
      investorId,
      name: investor.name,
      fieldsUpdated,
    });
  } catch (error) {
    console.error('rerun-profile/process error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
