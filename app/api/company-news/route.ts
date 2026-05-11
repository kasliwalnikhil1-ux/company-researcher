// Fetch latest news about a company via Exa chat completions
// Step 1 only — raw news (answer + citations) stored in companies.news
// Step 2 (email opener generation) is triggered separately by the user

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;

const EXA_API_KEYS = process.env.EXA_API_KEYS
  ? process.env.EXA_API_KEYS.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
  : [];

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

interface ExaCitation {
  id?: string;
  title?: string;
  url?: string;
  snippet?: string;
}

function buildCitationLinks(citations: ExaCitation[]): string[] {
  const links: string[] = [];
  if (!Array.isArray(citations)) return links;
  for (const c of citations) {
    const title = (c.title || c.snippet || c.url || '').trim();
    const url = (c.url || c.id || '').trim();
    if (url) links.push(`[${title || url}](${url})`);
  }
  return links;
}

/** GET: Return current news from companies table (no Exa fetch) */
export async function GET(req: NextRequest) {
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

    const { searchParams } = new URL(req.url);
    const companyId = searchParams.get('companyId');

    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const { data, error } = await supabase
      .from('companies')
      .select('news')
      .eq('id', companyId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: 'Failed to load news', details: error.message }, { status: 500 });
    }

    return NextResponse.json({ news: data?.news ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[company-news] GET Error:', msg);
    return NextResponse.json({ error: 'Something went wrong', details: msg }, { status: 500 });
  }
}

/** POST: Fetch latest news from Exa and save to companies.news */
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
    const companyId = typeof body?.companyId === 'string' ? body.companyId : undefined;
    const domain = typeof body?.domain === 'string' ? body.domain : null;
    const name = typeof body?.name === 'string' ? body.name : null;

    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    if (EXA_API_KEYS.length === 0) {
      return NextResponse.json({ error: 'No Exa API keys configured' }, { status: 500 });
    }

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const identifier = name || domain || 'this company';
    const domainStr = domain ? ` (${domain})` : '';
    const query = `Latest news, updates, announcements, and articles on ${identifier}${domainStr}. Be comprehensive and accurate.`;

    const exaKey = EXA_API_KEYS[Math.floor(Math.random() * EXA_API_KEYS.length)];
    const exaRes = await fetch('https://api.exa.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': exaKey,
      },
      body: JSON.stringify({
        model: 'exa',
        messages: [{ role: 'user', content: query }],
      }),
    });

    if (!exaRes.ok) {
      const errText = await exaRes.text();
      console.error('[company-news] Exa API error:', exaRes.status, errText);
      return NextResponse.json(
        { error: 'Exa API failed', details: errText },
        { status: exaRes.status >= 500 ? 502 : 400 }
      );
    }

    const exaData = await exaRes.json();
    const message = exaData?.choices?.[0]?.message;
    const answer: string =
      (typeof message?.content === 'string' ? message.content : null) ?? exaData?.answer ?? '';
    const rawCitations: ExaCitation[] =
      (Array.isArray(message?.citations) ? message.citations : null) ?? exaData?.citations ?? [];

    const companyNews = {
      answer: answer.trim(),
      citations: buildCitationLinks(rawCitations),
      date: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from('companies')
      .update({ news: companyNews })
      .eq('id', companyId)
      .eq('user_id', user.id);

    if (updateError) {
      console.error('[company-news] Update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to save news', details: updateError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ news: companyNews });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[company-news] Error:', msg);
    return NextResponse.json({ error: 'Something went wrong', details: msg }, { status: 500 });
  }
}
