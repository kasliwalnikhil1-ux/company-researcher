// /app/api/admin/users/route.ts
// Admin user management: list all accounts, update plan/credits/status,
// and ban/unban accounts. Service role, restricted to ADMIN_USER_IDS.

import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const ADMIN_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

const ALLOWED_PLANS = new Set(['free', 'basic', 'pro']);
const ALLOWED_STATUSES = new Set(['active', 'inactive', 'cancelled', 'past_due']);
const ALLOWED_BILLING_CYCLES = new Set(['monthly', 'quarterly', 'yearly']);

// ~100 years — effectively permanent until unbanned
const BAN_DURATION = '876000h';

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

async function authenticateAdmin(req: NextRequest): Promise<
  | { ok: true; adminId: string }
  | { ok: false; response: NextResponse }
> {
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }

  const authClient = getSupabaseAuthClient(token);
  if (!authClient) {
    return { ok: false, response: NextResponse.json({ error: 'Auth not configured' }, { status: 500 }) };
  }

  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 }) };
  }

  if (!ADMIN_USER_IDS.has(user.id)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { ok: true, adminId: user.id };
}

async function listAllAuthUsers(serviceClient: SupabaseClient) {
  const users: {
    id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
    banned_until: string | null;
  }[] = [];

  let page = 1;
  const perPage = 1000;
  // Paginate until a short page is returned
  for (;;) {
    const { data, error } = await serviceClient.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    for (const u of data.users) {
      users.push({
        id: u.id,
        email: u.email ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        banned_until: (u as { banned_until?: string | null }).banned_until ?? null,
      });
    }
    if (data.users.length < perPage) break;
    page += 1;
  }

  return users;
}

// ─── GET: list all accounts with their settings ─────────────────────
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateAdmin(req);
    if (!auth.ok) return auth.response;

    const serviceClient = getSupabaseServiceClient();
    if (!serviceClient) {
      return NextResponse.json({ error: 'Service role not configured' }, { status: 500 });
    }

    const [authUsers, settingsRes] = await Promise.all([
      listAllAuthUsers(serviceClient),
      serviceClient
        .from('user_settings')
        .select('id, plan, billing_cycle, renewal_date, last_billed_at, status, credits_remaining'),
    ]);

    if (settingsRes.error) {
      console.error('user_settings fetch error:', settingsRes.error);
      return NextResponse.json({ error: settingsRes.error.message }, { status: 500 });
    }

    const settingsById = new Map(
      (settingsRes.data ?? []).map((s) => [s.id as string, s])
    );

    const users = authUsers.map((u) => {
      const s = settingsById.get(u.id);
      return {
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        banned: !!(u.banned_until && new Date(u.banned_until) > new Date()),
        plan: s?.plan ?? null,
        billing_cycle: s?.billing_cycle ?? null,
        renewal_date: s?.renewal_date ?? null,
        last_billed_at: s?.last_billed_at ?? null,
        status: s?.status ?? null,
        credits_remaining: s?.credits_remaining ?? null,
      };
    });

    users.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

    return NextResponse.json({ users });
  } catch (err) {
    console.error('Admin users GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── PATCH: update a user's plan/credits/status or ban/unban ────────
export async function PATCH(req: NextRequest) {
  try {
    const auth = await authenticateAdmin(req);
    if (!auth.ok) return auth.response;

    const serviceClient = getSupabaseServiceClient();
    if (!serviceClient) {
      return NextResponse.json({ error: 'Service role not configured' }, { status: 500 });
    }

    const body = await req.json().catch(() => null);
    const userId = typeof body?.userId === 'string' ? body.userId : null;
    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    // ── Access control: ban / unban ──
    if (typeof body?.banned === 'boolean') {
      if (userId === auth.adminId && body.banned) {
        return NextResponse.json({ error: 'You cannot ban your own account' }, { status: 400 });
      }
      const { error: banError } = await serviceClient.auth.admin.updateUserById(userId, {
        ban_duration: body.banned ? BAN_DURATION : 'none',
      });
      if (banError) {
        console.error('Ban update error:', banError);
        return NextResponse.json({ error: banError.message }, { status: 500 });
      }
    }

    // ── Settings updates (whitelisted fields only) ──
    const updates: Record<string, unknown> = {};

    if (body?.plan !== undefined) {
      if (typeof body.plan !== 'string' || !ALLOWED_PLANS.has(body.plan)) {
        return NextResponse.json({ error: `Invalid plan. Allowed: ${[...ALLOWED_PLANS].join(', ')}` }, { status: 400 });
      }
      updates.plan = body.plan;
    }

    if (body?.credits_remaining !== undefined) {
      const credits = Number(body.credits_remaining);
      if (!Number.isFinite(credits) || credits < 0) {
        return NextResponse.json({ error: 'credits_remaining must be a non-negative number' }, { status: 400 });
      }
      updates.credits_remaining = Math.floor(credits);
    }

    if (body?.status !== undefined) {
      if (typeof body.status !== 'string' || !ALLOWED_STATUSES.has(body.status)) {
        return NextResponse.json({ error: `Invalid status. Allowed: ${[...ALLOWED_STATUSES].join(', ')}` }, { status: 400 });
      }
      updates.status = body.status;
    }

    if (body?.billing_cycle !== undefined) {
      if (typeof body.billing_cycle !== 'string' || !ALLOWED_BILLING_CYCLES.has(body.billing_cycle)) {
        return NextResponse.json({ error: `Invalid billing_cycle. Allowed: ${[...ALLOWED_BILLING_CYCLES].join(', ')}` }, { status: 400 });
      }
      updates.billing_cycle = body.billing_cycle;
    }

    if (body?.renewal_date !== undefined) {
      if (body.renewal_date !== null && Number.isNaN(Date.parse(body.renewal_date))) {
        return NextResponse.json({ error: 'renewal_date must be a valid date or null' }, { status: 400 });
      }
      updates.renewal_date = body.renewal_date;
    }

    if (Object.keys(updates).length > 0) {
      const { error: upsertError } = await serviceClient
        .from('user_settings')
        .upsert({ id: userId, ...updates }, { onConflict: 'id' });

      if (upsertError) {
        console.error('user_settings upsert error:', upsertError);
        return NextResponse.json({ error: upsertError.message }, { status: 500 });
      }
    } else if (typeof body?.banned !== 'boolean') {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Admin users PATCH error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
