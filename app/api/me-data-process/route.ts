// /app/api/me-data-process/route.ts
// Process me_data JSON: extract prospects, find LinkedIn URLs via Exa, save to me_data_prospects

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;

const DEBUG = false; // Process only 1 prospect for testing

const EXA_API_KEYS = process.env.EXA_API_KEYS
  ? process.env.EXA_API_KEYS.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
  : [];

function getSupabaseClient(accessToken?: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = accessToken
    ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    : process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {});
}

function extractProspects(raw: unknown): Array<{ name: string | null; headline: string | null; status: string | null; intent: string; lastConversationDate: string | null }> {
  const threads = (raw as { data?: { threads?: unknown[] } })?.data?.threads || [];

  return threads.map((thread) => {
    const t = thread as Record<string, unknown>;
    const participants = (t.participants as Array<{ name?: string; headlineText?: string }>) || [];
    const credential = t.credential as { name?: string } | undefined;
    const credentialName = credential?.name;

    const prospect = participants.find((p) => p.name !== credentialName);

    const conversations = (t.conversations as Array<{ name?: string; text?: string; createdAt?: string }>) || [];
    const prospectMessages = conversations
      .filter((c) => c.name === prospect?.name)
      .map((c) => c.text || '');

    let intent = 'No clear intent';
    const combinedText = prospectMessages.join(' ').toLowerCase();

    if (combinedText.includes('raising') || combinedText.includes('fundraising')) {
      intent = 'Actively fundraising';
    } else if (combinedText.includes('book') || combinedText.includes('call')) {
      intent = 'Interested in a call';
    } else if (combinedText.includes('potentially') || combinedText.includes('open')) {
      intent = 'Potentially interested';
    } else if (combinedText.includes('three month') || combinedText.includes('later')) {
      intent = 'Interested later';
    } else if (combinedText.includes('$') || combinedText.includes('funding')) {
      intent = 'Seeking funding';
    } else if (combinedText.includes('fee') || combinedText.includes('structure')) {
      intent = 'Evaluating service terms';
    }

    let lastConversationDate: string | null = null;
    const toMs = (val: string | number): number | null => {
      if (val == null || val === '') return null;
      const n = typeof val === 'string' && /^\d+$/.test(val) ? parseInt(val, 10) : typeof val === 'number' ? val : NaN;
      if (!Number.isFinite(n)) return null;
      return n > 1e12 ? n : n * 1000;
    };
    const getDateVal = (obj: Record<string, unknown>, keys: string[]): string | number | null => {
      for (const k of keys) {
        const v = obj[k];
        if (v != null && v !== '') return v as string | number;
      }
      return null;
    };
    // Thread-level: updatedAt, createdAt, syncedAt, firstConTimestamp (all numeric ms or string number)
    const threadDateVal = getDateVal(t, ['updatedAt', 'createdAt', 'syncedAt', 'firstConTimestamp']);
    const threadMs = threadDateVal != null ? toMs(threadDateVal as string | number) : null;
    if (threadMs != null) {
      lastConversationDate = new Date(threadMs).toISOString();
    }
    // Fallback: max of conversation timestamps (conversations have numeric `timestamp` in ms)
    if (!lastConversationDate && conversations.length > 0) {
      const timestamps = conversations
        .map((c) => {
          const val = getDateVal(c as Record<string, unknown>, ['timestamp', 'createdAt', 'created_at', 'date']);
          if (val == null) return null;
          const ms = typeof val === 'number' || (typeof val === 'string' && /^\d+$/.test(val)) ? toMs(val as string | number) : null;
          if (ms != null) return ms;
          const d = new Date(val as string);
          return Number.isFinite(d.getTime()) ? d.getTime() : null;
        })
        .filter((ts): ts is number => ts != null);
      if (timestamps.length > 0) {
        const maxTs = Math.max(...timestamps);
        lastConversationDate = new Date(maxTs).toISOString();
      }
    }

    return {
      name: prospect?.name ?? null,
      headline: prospect?.headlineText ?? null,
      status: (t.status as string) ?? null,
      intent,
      lastConversationDate,
    };
  });
}

function isCreditError(error: unknown): boolean {
  if (error instanceof Error) {
    const m = error.message.toLowerCase();
    return m.includes('credit') || m.includes('quota') || m.includes('limit') || m.includes('insufficient') || m.includes('429') || m.includes('403');
  }
  return false;
}

async function searchLinkedInProfile(query: string): Promise<string | null> {
  if (EXA_API_KEYS.length === 0) return null;

  const shuffledKeys = [...EXA_API_KEYS].sort(() => Math.random() - 0.5);
  let lastError: unknown;

  for (const key of shuffledKeys) {
    try {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
        },
        body: JSON.stringify({
          query: `linkedin profile of ${query}`,
          category: 'people',
          numResults: 1,
          type: 'auto',
          contents: { text: true },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Exa API ${res.status}: ${text}`);
      }

      const data = (await res.json()) as { results?: Array<{ url?: string }> };
      const url = data?.results?.[0]?.url;
      if (url && /linkedin\.com\/in\//i.test(url)) {
        return url;
      }
      return url || null;
    } catch (err) {
      if (isCreditError(err)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error('All Exa API keys exhausted');
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const userSupabase = getSupabaseClient(token);
    if (!userSupabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const { data: { user }, error: authError } = await userSupabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    const body = await req.json();
    const { meDataId } = body;

    if (!meDataId || typeof meDataId !== 'string') {
      return NextResponse.json({ error: 'meDataId is required' }, { status: 400 });
    }

    const { data: meDataRow, error: fetchError } = await userSupabase
      .from('me_data')
      .select('id, user_id, data')
      .eq('id', meDataId)
      .eq('user_id', user.id)
      .single();

    if (fetchError || !meDataRow) {
      return NextResponse.json({ error: 'ME data entry not found' }, { status: 404 });
    }

    const raw = meDataRow.data;
    const prospects = extractProspects(raw);

    if (DEBUG && raw) {
      const threads = (raw as { data?: { threads?: unknown[] } })?.data?.threads || [];
      const first = threads[0];
      console.log('[me-data-process] DEBUG: first thread keys:', first ? Object.keys(first as object) : []);
      console.log('[me-data-process] DEBUG: first thread sample:', first ? JSON.stringify(first, null, 2).slice(0, 1500) : null);
      if (Array.isArray((first as Record<string, unknown>)?.conversations)) {
        const conv = ((first as Record<string, unknown>).conversations as unknown[])[0];
        console.log('[me-data-process] DEBUG: first conversation keys:', conv ? Object.keys(conv as object) : []);
      }
    }

    if (prospects.length === 0) {
      return NextResponse.json({ error: 'No prospects found in data' }, { status: 400 });
    }

    const prospectsToProcess = DEBUG ? prospects.slice(0, 1) : prospects;

    const serviceSupabase = getSupabaseClient();
    if (!serviceSupabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    if (EXA_API_KEYS.length === 0) {
      return NextResponse.json({ error: 'No Exa API keys configured' }, { status: 500 });
    }

    const saved: Array<{ linkedin_url: string; name: string | null; headline: string | null; intent: string; status: string | null; convo_date: string | null }> = [];

    for (const p of prospectsToProcess) {
      const name = p.name || '';
      const headline = p.headline || '';
      const searchQuery = [name, headline].filter(Boolean).join(' ').trim();
      if (!searchQuery) continue;

      let linkedinUrl: string | null = null;
      try {
        linkedinUrl = await searchLinkedInProfile(searchQuery);
      } catch (err) {
        console.error('[me-data-process] Exa search failed for:', searchQuery, err);
        continue;
      }

      if (!linkedinUrl) continue;

      const convoDate = p.lastConversationDate ? p.lastConversationDate.split('T')[0] : null;
      const row = {
        linkedin_url: linkedinUrl,
        user_id: user.id,
        name: p.name,
        headline: p.headline,
        intent: p.intent,
        status: p.status,
        convo_date: convoDate,
      };

      const { error: upsertErr } = await serviceSupabase
        .from('me_data_prospects')
        .upsert(row, { onConflict: 'linkedin_url' });

      if (upsertErr) {
        console.error('[me-data-process] Upsert error:', upsertErr);
        continue;
      }
      saved.push(row);
    }

    const { error: updateErr } = await serviceSupabase
      .from('me_data')
      .update({ processed: true })
      .eq('id', meDataId)
      .eq('user_id', user.id);

    if (updateErr) {
      console.error('[me-data-process] Failed to mark processed:', updateErr);
      return NextResponse.json(
        { error: 'Failed to mark entry as processed', prospectsSaved: saved.length },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      prospectsExtracted: prospects.length,
      prospectsSaved: saved.length,
      saved,
      debug: DEBUG,
      debugFirstProspect: DEBUG && prospects[0] ? { ...prospects[0] } : undefined,
    });
  } catch (err) {
    console.error('[me-data-process] Error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'Processing failed', details: msg }, { status: 500 });
  }
}
