// /app/api/founder-search/route.ts
// Manually trigger founder-search for an investor's notable investments

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const FOUNDER_SEARCH_URL = 'https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/founder-search';

function getSupabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

function getSupabaseAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function extractDomainsFromNotableInvestments(investments: string[] | null): string[] {
  if (!investments || !Array.isArray(investments)) return [];
  const domains: string[] = [];
  for (const item of investments) {
    // Format: [name](url)
    const match = item.match(/\]\((https?:\/\/[^)]+)\)/);
    if (match && match[1]) {
      const domain = normalizeDomain(match[1]);
      if (domain && !domains.includes(domain)) {
        domains.push(domain);
      }
    }
  }
  return domains;
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const authClient = getSupabaseAuthClient(token);
    if (!authClient) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
    }

    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    const body = await req.json();
    const { investorId } = body as { investorId?: string };

    if (!investorId || typeof investorId !== 'string') {
      return NextResponse.json({ error: 'investorId is required' }, { status: 400 });
    }

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    // Fetch investor's notable_investments
    const { data: investor, error: fetchError } = await supabase
      .from('investors')
      .select('id, name, notable_investments')
      .eq('id', investorId)
      .single();

    if (fetchError || !investor) {
      return NextResponse.json(
        { error: 'Investor not found', details: fetchError?.message },
        { status: 404 }
      );
    }

    const notableInvestments = Array.isArray(investor.notable_investments)
      ? investor.notable_investments
      : null;
    const domains = extractDomainsFromNotableInvestments(notableInvestments);

    if (domains.length === 0) {
      return NextResponse.json({
        success: false,
        message: 'No domains found in notable investments',
        domains: [],
      });
    }

    console.log('[founder-search] Triggering for investor:', investor.name, '| domains:', domains.length);

    // Fire the founder-search request
    const founderSearchResponse = await fetch(FOUNDER_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains }),
    });

    if (!founderSearchResponse.ok) {
      const errorText = await founderSearchResponse.text();
      console.error('[founder-search] Request failed:', errorText);
      return NextResponse.json({
        success: false,
        message: 'Founder search request failed',
        error: errorText,
      }, { status: 500 });
    }

    console.log('[founder-search] Request completed for', domains.length, 'domains');

    return NextResponse.json({
      success: true,
      message: `Founder search triggered for ${domains.length} domains`,
      domains,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[founder-search] Error:', msg);
    return NextResponse.json({ error: 'Founder search failed', details: msg }, { status: 500 });
  }
}
