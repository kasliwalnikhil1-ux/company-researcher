// /app/api/admin/users/route.ts
// The parts of account administration that need the GoTrue admin API (service role): create an account,
// ban / unban, issue a password-recovery link, delete an account. Everything else (status, features, plan,
// credits, outreach, CRM) is a `platform_admin_*` SQL RPC called from the browser with the admin's own session
// (see migrations/platform/001_admin.sql and lib/platform/access.ts).
//
// Who is an admin: the `platform_admins` table, checked through the caller's own token (`platform_is_admin`).

import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ~100 years — effectively permanent until unbanned
const BAN_DURATION = '876000h';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getSupabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function getSupabaseAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type Admin = { id: string; email: string | null };

async function authenticateAdmin(req: NextRequest): Promise<{ ok: true; admin: Admin } | { ok: false; response: NextResponse }> {
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };

  const authClient = getSupabaseAuthClient(token);
  if (!authClient) return { ok: false, response: NextResponse.json({ error: 'Auth not configured' }, { status: 500 }) };

  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user) return { ok: false, response: NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 }) };

  const { data: isAdmin, error: adminError } = await authClient.rpc('platform_is_admin');
  if (adminError) {
    console.error('platform_is_admin error:', adminError);
    return { ok: false, response: NextResponse.json({ error: 'Could not verify admin access' }, { status: 500 }) };
  }
  if (!isAdmin) return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };

  return { ok: true, admin: { id: user.id, email: user.email ?? null } };
}

async function audit(service: SupabaseClient, admin: Admin, action: string, target: { id: string | null; email: string | null }, details: Record<string, unknown> = {}) {
  const { error } = await service.from('platform_audit_log').insert({
    admin_id: admin.id, admin_email: admin.email, target_user_id: target.id, target_email: target.email, action, details,
  });
  if (error) console.error('platform_audit_log insert error:', error);
}

async function targetEmail(service: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await service.auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── POST: create an account ────────────────────────────────────────
// { email, password?, note? }
// With a password the account is created confirmed and usable at once; without one an invitation email is sent
// (needs the project's SMTP) and a copyable invite link is returned as well.
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateAdmin(req);
    if (!auth.ok) return auth.response;
    const service = getSupabaseServiceClient();
    if (!service) return NextResponse.json({ error: 'Service role not configured' }, { status: 500 });

    const body = await req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' && body.password.length > 0 ? body.password : null;
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    if (password !== null && password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });

    let userId: string | null = null;
    let inviteLink: string | null = null;

    if (password) {
      const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) return NextResponse.json({ error: error.message }, { status: error.status === 422 ? 409 : 500 });
      userId = data.user?.id ?? null;
    } else {
      const redirectTo = process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/auth/callback` : undefined;
      const { data, error } = await service.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
      if (error) return NextResponse.json({ error: error.message }, { status: error.status === 422 ? 409 : 500 });
      userId = data.user?.id ?? null;
      inviteLink = data.properties?.action_link ?? null;
      // generateLink creates the account but sends nothing: try the built-in invite mail as well (no-op without SMTP).
      await service.auth.admin.inviteUserByEmail(email, { redirectTo }).catch(() => undefined);
    }
    if (!userId) return NextResponse.json({ error: 'Account was not created' }, { status: 500 });

    // Admin-created accounts are approved from the start.
    const { error: accessError } = await service.from('platform_user_access').upsert(
      { user_id: userId, status: 'active', approved_at: new Date().toISOString(), approved_by: auth.admin.id, updated_by: auth.admin.id, updated_at: new Date().toISOString(), note: note || null },
      { onConflict: 'user_id' },
    );
    if (accessError) console.error('platform_user_access upsert error:', accessError);

    await audit(service, auth.admin, 'account.created', { id: userId, email }, { method: password ? 'password' : 'invite', note: note || undefined });
    return NextResponse.json({ userId, email, inviteLink });
  } catch (err) {
    console.error('Admin users POST error:', err);
    return NextResponse.json({ error: describe(err) }, { status: 500 });
  }
}

// ─── PATCH: ban / unban, recovery link ──────────────────────────────
// { userId, banned: boolean }  |  { userId, action: 'recovery_link' }
export async function PATCH(req: NextRequest) {
  try {
    const auth = await authenticateAdmin(req);
    if (!auth.ok) return auth.response;
    const service = getSupabaseServiceClient();
    if (!service) return NextResponse.json({ error: 'Service role not configured' }, { status: 500 });

    const body = await req.json().catch(() => null);
    const userId = typeof body?.userId === 'string' && UUID_RE.test(body.userId) ? body.userId : null;
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    const email = await targetEmail(service, userId);
    if (email === null) return NextResponse.json({ error: 'No such account' }, { status: 404 });

    if (typeof body?.banned === 'boolean') {
      if (userId === auth.admin.id && body.banned) return NextResponse.json({ error: 'You cannot ban your own account' }, { status: 400 });
      const { error } = await service.auth.admin.updateUserById(userId, { ban_duration: body.banned ? BAN_DURATION : 'none' });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await audit(service, auth.admin, body.banned ? 'account.banned' : 'account.unbanned', { id: userId, email });
      return NextResponse.json({ success: true, banned: body.banned });
    }

    if (body?.action === 'recovery_link') {
      const redirectTo = process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/reset-password` : undefined;
      const { data, error } = await service.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await audit(service, auth.admin, 'account.recovery_link', { id: userId, email });
      return NextResponse.json({ link: data.properties?.action_link ?? null });
    }

    return NextResponse.json({ error: 'Nothing to do' }, { status: 400 });
  } catch (err) {
    console.error('Admin users PATCH error:', err);
    return NextResponse.json({ error: describe(err) }, { status: 500 });
  }
}

// ─── DELETE: remove an account (and, through the foreign keys, everything it owns) ──
// { userId, confirmEmail }
export async function DELETE(req: NextRequest) {
  try {
    const auth = await authenticateAdmin(req);
    if (!auth.ok) return auth.response;
    const service = getSupabaseServiceClient();
    if (!service) return NextResponse.json({ error: 'Service role not configured' }, { status: 500 });

    const body = await req.json().catch(() => null);
    const userId = typeof body?.userId === 'string' && UUID_RE.test(body.userId) ? body.userId : null;
    const confirmEmail = typeof body?.confirmEmail === 'string' ? body.confirmEmail.trim().toLowerCase() : '';
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    if (userId === auth.admin.id) return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 });

    const email = await targetEmail(service, userId);
    if (email === null) return NextResponse.json({ error: 'No such account' }, { status: 404 });
    if (confirmEmail !== email.toLowerCase()) return NextResponse.json({ error: 'Type the account email to confirm' }, { status: 400 });

    const { data: isTargetAdmin } = await service.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
    if (isTargetAdmin) return NextResponse.json({ error: 'Remove admin access first' }, { status: 400 });

    // Write the audit row first: the account row (and its FK-linked rows) disappears with the delete.
    await audit(service, auth.admin, 'account.deleted', { id: userId, email });
    const { error } = await service.auth.admin.deleteUser(userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Admin users DELETE error:', err);
    return NextResponse.json({ error: describe(err) }, { status: 500 });
  }
}
