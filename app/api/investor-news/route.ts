// Fetch latest news about an investor via Exa chat completions
// Updates investor_personalization.investor_news
// Rotates EXA_API_KEYS like investor-research

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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
  publishedDate?: string;
}

/** GET: Return current investor_news from DB (no Exa fetch) */
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
    const investorId = searchParams.get('investorId');

    if (!investorId) {
      return NextResponse.json({ error: 'investorId is required' }, { status: 400 });
    }

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const { data, error } = await supabase
      .from('investor_personalization')
      .select('investor_news')
      .eq('investor_id', investorId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: 'Failed to load news', details: error.message }, { status: 500 });
    }

    const investorNews = data?.investor_news ?? null;
    return NextResponse.json({ investor_news: investorNews });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[investor-news] GET Error:', msg);
    return NextResponse.json({ error: 'Something went wrong', details: msg }, { status: 500 });
  }
}

function cleanInvestorNews(answer: string, citations: ExaCitation[]): {
  answer: string;
  citations: string[];
  date: string;
} {
  const date = new Date().toISOString();
  const citationLinks: string[] = [];
  if (Array.isArray(citations)) {
    for (const c of citations) {
      const title = (c.title || c.snippet || c.url || '').trim();
      const url = (c.url || c.id || '').trim();
      if (url) {
        citationLinks.push(`[${title || url}](${url})`);
      }
    }
  }
  return {
    answer: (answer || '').trim(),
    citations: citationLinks,
    date,
  };
}

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
    const investorId = typeof body?.investorId === 'string' ? body.investorId : undefined;
    const name = typeof body?.name === 'string' ? body.name : null;
    const domain = typeof body?.domain === 'string' ? body.domain : null;
    const type = body?.type === 'firm' || body?.type === 'person' ? body.type : null;
    const investorType = body?.investor_type;
    const associatedFirmName = typeof body?.associated_firm_name === 'string' ? body.associated_firm_name : null;

    if (!investorId) {
      return NextResponse.json({ error: 'investorId is required' }, { status: 400 });
    }

    if (EXA_API_KEYS.length === 0) {
      return NextResponse.json({ error: 'No Exa API keys configured' }, { status: 500 });
    }

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const investorTypes = Array.isArray(investorType)
      ? investorType.join(', ')
      : typeof investorType === 'string'
        ? investorType
        : '';

    const nameStr = name || 'the investor';
    let query: string;
    if (type === 'person') {
      const parts = [nameStr, associatedFirmName, investorTypes].filter(Boolean);
      query = `Latest news, videos, articles, and updates about ${parts.join(' ')}. Be comprehensive and accurate.`.trim();
    } else {
      const domainStr = domain ? String(domain) : '';
      const parts = [nameStr, domainStr, investorTypes].filter(Boolean);
      query = `Latest news, videos, articles, and updates about ${parts.join(' ')}. Be comprehensive and accurate.`.trim();
    }

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
      console.error('[investor-news] Exa API error:', exaRes.status, errText);
      return NextResponse.json(
        { error: 'Exa API failed', details: errText },
        { status: exaRes.status >= 500 ? 502 : 400 }
      );
    }

    const exaData = await exaRes.json();
    // Exa chat completions returns OpenAI-style: choices[0].message.content, choices[0].message.citations
    // Direct /answer endpoint returns: answer, citations at top level
    const message = exaData?.choices?.[0]?.message;
    const answer =
      (typeof message?.content === 'string' ? message.content : null) ?? exaData?.answer ?? '';
    const citations =
      (Array.isArray(message?.citations) ? message.citations : null) ?? exaData?.citations ?? [];

    const investorNews = cleanInvestorNews(answer, citations);

    const { error: updateError } = await supabase
      .from('investor_personalization')
      .update({ investor_news: investorNews })
      .eq('investor_id', investorId)
      .eq('user_id', user.id);

    if (updateError) {
      console.error('[investor-news] Update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to save news', details: updateError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ investor_news: investorNews });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[investor-news] Error:', msg);
    return NextResponse.json({ error: 'Something went wrong', details: msg }, { status: 500 });
  }
}
