import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const GETSALES_BASE = 'https://amazing.getsales.io';

/* ──────────────────────────────────────────────────────────────
 * Email → Sender-Profile Access Map
 *
 *   '*'           → user can see ALL sender profiles / conversations
 *   string[]      → user can only see profiles whose `label`
 *                    (case-insensitive) is in the array
 *
 * Keep in sync with /api/sender-profiles/route.ts and
 * /api/linkedin-conversations/sender-profiles/route.ts
 * Any authenticated email NOT in this map is denied access (403).
 * ────────────────────────────────────────────────────────────── */
const EMAIL_ACCESS_MAP: Record<string, '*' | string[]> = {
  'founders@capitalxai.com': '*',
  'kasliwalnikhil1@gmail.com': ['kaptured'],
};

function getAllowedLabels(email: string): '*' | string[] | null {
  const entry = EMAIL_ACCESS_MAP[email.toLowerCase()];
  return entry ?? null;
}

/** Auth client (anon key + user token) for verifying user identity */
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

/**
 * For restricted users, resolve their allowed label list into
 * a Set of sender-profile UUIDs by fetching all profiles from GetSales.
 * Results are NOT cached across requests (stateless).
 */
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
 * GET /api/linkedin-conversations
 * Proxy to GetSales: GET /flows/api/linkedin-messages
 * Query params: limit, offset, order_field, order_type, filter[...]
 *
 * Access control: messages are filtered to only include those
 * belonging to the user's allowed sender profiles.
 */
export async function GET(req: NextRequest) {
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

    // Forward all query params to GetSales
    const url = new URL(req.url);
    const params = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
      params.append(key, value);
    });

    // Defaults
    if (!params.has('limit')) params.set('limit', '50');
    if (!params.has('offset')) params.set('offset', '0');
    if (!params.has('order_field')) params.set('order_field', 'created_at');
    if (!params.has('order_type')) params.set('order_type', 'desc');

    // ── Unrestricted user ('*') → pass through as-is ──
    if (allowedLabels === '*') {
      const gsUrl = `${GETSALES_BASE}/flows/api/linkedin-messages?${params.toString()}`;
      const gsRes = await fetch(gsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${getGetsalesKey()}`,
          'Content-Type': 'application/json',
        },
      });

      if (!gsRes.ok) {
        const errText = await gsRes.text();
        console.error('[linkedin-conversations] GetSales GET error:', gsRes.status, errText);
        return NextResponse.json(
          { error: `GetSales API error: ${gsRes.status}`, details: errText },
          { status: gsRes.status }
        );
      }

      const data = await gsRes.json();
      return NextResponse.json(data);
    }

    // ── Restricted user → fetch messages, filter by allowed sender profiles ──
    const allowedUuids = await resolveAllowedSenderUuids(allowedLabels);
    if (allowedUuids.size === 0) {
      return NextResponse.json({
        data: [],
        total: 0,
        limit: parseInt(params.get('limit') || '50', 10),
        offset: parseInt(params.get('offset') || '0', 10),
        has_more: false,
      });
    }

    // If the API supports filter[sender_profile_uuid], use it for single-profile users
    // to reduce data transfer. Otherwise, fetch more and filter server-side.
    const requestedLimit = parseInt(params.get('limit') || '50', 10);
    const requestedOffset = parseInt(params.get('offset') || '0', 10);

    if (allowedUuids.size === 1) {
      const singleUuid = [...allowedUuids][0];
      params.set('filter[sender_profile_uuid]', singleUuid);
      const gsUrl = `${GETSALES_BASE}/flows/api/linkedin-messages?${params.toString()}`;
      const gsRes = await fetch(gsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${getGetsalesKey()}`,
          'Content-Type': 'application/json',
        },
      });

      if (!gsRes.ok) {
        const errText = await gsRes.text();
        console.error('[linkedin-conversations] GetSales GET error:', gsRes.status, errText);
        return NextResponse.json(
          { error: `GetSales API error: ${gsRes.status}`, details: errText },
          { status: gsRes.status }
        );
      }

      const data = await gsRes.json();
      return NextResponse.json(data);
    }

    // Multiple allowed profiles: fetch a larger batch and filter server-side
    const fetchParams = new URLSearchParams(params);
    fetchParams.set('limit', '1000');
    fetchParams.set('offset', '0');

    const gsUrl = `${GETSALES_BASE}/flows/api/linkedin-messages?${fetchParams.toString()}`;
    const gsRes = await fetch(gsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
    });

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[linkedin-conversations] GetSales GET error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const rawData = await gsRes.json();
    const allMessages: Array<{ sender_profile_uuid?: string; [key: string]: unknown }> =
      rawData.data || [];

    const filtered = allMessages.filter(
      (m) => m.sender_profile_uuid && allowedUuids.has(m.sender_profile_uuid)
    );

    const paginated = filtered.slice(requestedOffset, requestedOffset + requestedLimit);

    return NextResponse.json({
      data: paginated,
      total: filtered.length,
      limit: requestedLimit,
      offset: requestedOffset,
      has_more: requestedOffset + requestedLimit < filtered.length,
    });
  } catch (err) {
    console.error('[linkedin-conversations] Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/linkedin-conversations
 * Proxy to GetSales: POST /flows/api/linkedin-messages
 * Body: { sender_profile_uuid, lead_uuid, text, template_uuid?, attachments? }
 *
 * Access control: restricted users can only send from allowed sender profiles.
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
        { error: 'Forbidden – your account does not have access to send messages' },
        { status: 403 }
      );
    }

    const body = await req.json();

    // For restricted users, verify the sender_profile_uuid is allowed
    if (allowedLabels !== '*' && body.sender_profile_uuid) {
      const allowedUuids = await resolveAllowedSenderUuids(allowedLabels);
      if (!allowedUuids.has(body.sender_profile_uuid)) {
        return NextResponse.json(
          { error: 'Forbidden – you are not allowed to send from this sender profile' },
          { status: 403 }
        );
      }
    }

    const gsRes = await fetch(`${GETSALES_BASE}/flows/api/linkedin-messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[linkedin-conversations] GetSales POST error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const data = await gsRes.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[linkedin-conversations] POST Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
