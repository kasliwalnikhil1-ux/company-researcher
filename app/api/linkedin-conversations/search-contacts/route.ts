import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const GETSALES_BASE = 'https://amazing.getsales.io';

const EMAIL_ACCESS_MAP: Record<string, '*' | string[]> = {
  'founders@capitalxai.com': '*',
  'kasliwalnikhil1@gmail.com': ['kaptured'],
};

function getAllowedLabels(email: string): '*' | string[] | null {
  const entry = EMAIL_ACCESS_MAP[email.toLowerCase()];
  return entry ?? null;
}

function getAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) throw new Error('Missing Supabase environment variables');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function getGetsalesKey() {
  const key = process.env.GETSALES_KEY;
  if (!key) throw new Error('Missing GETSALES_KEY environment variable');
  return key;
}

async function resolveAllowedSenderUuids(labels: string[]): Promise<Set<string>> {
  const gsRes = await fetch(
    `${GETSALES_BASE}/flows/api/sender-profiles?limit=1000&offset=0`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!gsRes.ok) return new Set();
  const data = await gsRes.json();
  const profiles: Array<{ uuid: string; label?: string }> = data.data || [];
  const allowedLower = labels.map((l) => l.toLowerCase());
  return new Set(
    profiles
      .filter((p) => p.label && allowedLower.includes(p.label.toLowerCase()))
      .map((p) => p.uuid)
  );
}

/**
 * POST /api/linkedin-conversations/search-contacts
 *
 * Body: { query: string, limit?: number, offset?: number }
 *
 * Uses filter.q (text search) on GetSales /leads/api/leads/search,
 * then fetches LinkedIn messages for matched contacts and groups
 * them by linkedin_conversation_uuid. Honours EMAIL_ACCESS_MAP.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authClient = getAuthClient(accessToken);
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userEmail = userData.user.email?.toLowerCase() || '';
    const allowedLabels = getAllowedLabels(userEmail);
    if (allowedLabels === null) {
      return NextResponse.json(
        { error: 'Forbidden – your account does not have access to conversations' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const query = (body.query || '').trim();
    if (!query) {
      return NextResponse.json({ error: 'Missing search query' }, { status: 400 });
    }

    const listUuid = (body.list_uuid || '').trim();
    const tagUuid = (body.tag_uuid || '').trim();

    const gsKey = getGetsalesKey();
    const headers = {
      Authorization: `Bearer ${gsKey}`,
      'Content-Type': 'application/json',
    };

    // Fetch up to 500 candidates; message fetches are batched (50 UUIDs
    // per request) so this stays fast. We filter down to only those with
    // actual conversation threads.
    const SEARCH_LIMIT = 500;

    const filter: Record<string, unknown> = { q: query };
    if (listUuid) filter.list_uuid = listUuid;
    if (tagUuid) filter.tags = tagUuid;

    const searchRes = await fetch(`${GETSALES_BASE}/leads/api/leads/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filter,
        limit: SEARCH_LIMIT,
        offset: 0,
        order_field: 'created_at',
        order_type: 'desc',
        disable_aggregation: true,
      }),
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      console.error('[search-contacts] GetSales search failed:', searchRes.status, errText);
      return NextResponse.json({ error: 'Search failed' }, { status: 502 });
    }

    const searchData = await searchRes.json();
    const contacts: Array<Record<string, unknown>> = searchData.data || [];
    if (contacts.length === 0) {
      return NextResponse.json({ contacts: [], conversations: [], total_contacts: 0 });
    }

    // Resolve allowed sender profile UUIDs for restricted users
    let allowedUuids: Set<string> | null = null;
    if (allowedLabels !== '*') {
      allowedUuids = await resolveAllowedSenderUuids(allowedLabels);
      if (allowedUuids.size === 0) {
        return NextResponse.json({
          contacts: [],
          conversations: [],
          total_contacts: 0,
        });
      }
    }

    // Batch lead UUIDs into groups of 50 and fetch messages with array
    // filter (filter[lead_uuid][]=...) — one API call per batch.
    const leadUuids = contacts.map((c) => c.uuid as string);
    const UUIDS_PER_BATCH = 50;
    const allMessages: Array<Record<string, unknown>> = [];

    const uuidBatches: string[][] = [];
    for (let i = 0; i < leadUuids.length; i += UUIDS_PER_BATCH) {
      uuidBatches.push(leadUuids.slice(i, i + UUIDS_PER_BATCH));
    }

    // Run batches 3 at a time
    const CONCURRENT_BATCHES = 3;
    for (let i = 0; i < uuidBatches.length; i += CONCURRENT_BATCHES) {
      const chunk = uuidBatches.slice(i, i + CONCURRENT_BATCHES);
      const results = await Promise.all(
        chunk.map(async (batch) => {
          const params = new URLSearchParams({
            limit: '500',
            offset: '0',
            order_field: 'created_at',
            order_type: 'desc',
          });
          batch.forEach((uuid) => params.append('filter[lead_uuid][]', uuid));
          const res = await fetch(
            `${GETSALES_BASE}/flows/api/linkedin-messages?${params.toString()}`,
            { method: 'GET', headers }
          );
          if (!res.ok) return [];
          const json = await res.json();
          return json.data || [];
        })
      );
      for (const msgs of results) {
        allMessages.push(...msgs);
      }
    }

    // Filter by allowed sender profiles for restricted users
    const filteredMessages = allowedUuids
      ? allMessages.filter(
          (m) =>
            m.sender_profile_uuid &&
            allowedUuids!.has(m.sender_profile_uuid as string)
        )
      : allMessages;

    // Group by linkedin_conversation_uuid
    interface ConvBucket {
      messages: Array<Record<string, unknown>>;
      lead_uuid: string;
      sender_profile_uuid?: string;
    }

    const convMap = new Map<string, ConvBucket>();
    for (const msg of filteredMessages) {
      const key = msg.linkedin_conversation_uuid as string;
      if (!key) continue;
      if (!convMap.has(key)) {
        convMap.set(key, {
          messages: [],
          lead_uuid: msg.lead_uuid as string,
        });
      }
      const entry = convMap.get(key)!;
      entry.messages.push(msg);
      if (msg.sender_profile_uuid && !entry.sender_profile_uuid) {
        entry.sender_profile_uuid = msg.sender_profile_uuid as string;
      }
    }

    // Build conversation summaries sorted by most recent
    const conversations = Array.from(convMap.entries())
      .map(([uuid, bucket]) => {
        const sorted = bucket.messages.sort(
          (a, b) =>
            new Date(b.created_at as string).getTime() -
            new Date(a.created_at as string).getTime()
        );
        const lastMsg = sorted[0];
        return {
          linkedin_conversation_uuid: uuid,
          lead_uuid: bucket.lead_uuid,
          last_message: lastMsg,
          message_count: sorted.length,
          sender_profile_uuid: bucket.sender_profile_uuid,
          has_unread: lastMsg.type === 'inbox',
        };
      })
      .sort(
        (a, b) =>
          new Date(b.last_message.created_at as string).getTime() -
          new Date(a.last_message.created_at as string).getTime()
      );

    const leadUuidsWithConvos = new Set(conversations.map((c) => c.lead_uuid));
    const contactsWithConvos = contacts.filter(
      (c) => leadUuidsWithConvos.has(c.uuid as string)
    );

    const totalSearchHits = searchData.total || contacts.length;
    const truncated = totalSearchHits > SEARCH_LIMIT;

    return NextResponse.json({
      contacts: contactsWithConvos,
      conversations,
      total_contacts: contactsWithConvos.length,
      total_search_hits: totalSearchHits,
      truncated,
    });
  } catch (err) {
    console.error('[search-contacts] Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
