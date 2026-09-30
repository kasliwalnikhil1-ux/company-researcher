// /app/api/leads/track — the signed-in user's own sign-up lead row (platform_leads, source = app_signup).
//
// Called from the account gate (components/ProtectedRoute) with the user's session:
//   POST {}                                   → fill the row's location from this request's geo headers (only empty fields)
//   POST { booked: true, booking: {...} }     → record the Calendly onboarding call (status → booked)
// The row itself is created by the auth.users trigger (migrations/platform/002_leads.sql); this only patches it,
// and creates it when the trigger predates the account.

import { NextRequest } from 'next/server';
import { authClient, geoFromHeaders, geoLookup, json, rateLimited, serviceClient, str } from '@/lib/platform/leads-server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json(req, { error: 'Authentication required' }, 401);
  const auth = authClient(token);
  const service = serviceClient();
  if (!auth || !service) return json(req, { error: 'Not configured' }, 500);

  const { data: { user }, error: authError } = await auth.auth.getUser(token);
  if (authError || !user) return json(req, { error: 'Invalid or expired session' }, 401);
  if (rateLimited(`track:${user.id}`, 30)) return json(req, { error: 'Too many requests' }, 429);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) ?? {}; } catch { /* empty body is fine */ }

  const { data: existing } = await service.from('platform_leads').select('*').eq('source', 'app_signup').eq('user_id', user.id).maybeSingle();

  const geo = await geoLookup(geoFromHeaders(req));
  const patch: Record<string, unknown> = {};
  const fill = (k: keyof typeof geo, v: unknown) => { if (v !== null && v !== undefined && (!existing || existing[k] == null)) patch[k] = v; };
  fill('ip', geo.ip); fill('country', geo.country); fill('region', geo.region); fill('city', geo.city);
  fill('timezone', geo.timezone ?? str(body.timezone, 80)); fill('latitude', geo.latitude); fill('longitude', geo.longitude);
  if (!existing?.user_agent) patch.user_agent = str(req.headers.get('user-agent'), 500);
  if (!existing?.referrer) { const r = str(body.referrer, 1000); if (r) patch.referrer = r; }

  if (body.booked === true) {
    patch.booked_at = new Date().toISOString();
    patch.status = existing && ['converted'].includes(existing.status) ? existing.status : 'booked';
    const b = body.booking && typeof body.booking === 'object' ? (body.booking as Record<string, unknown>) : {};
    patch.booking = {
      provider: 'calendly',
      event: str(b.event, 500),
      invitee: str(b.invitee, 500),
      ...(existing?.booking && typeof existing.booking === 'object' ? { previous: existing.booking } : {}),
    };
  }

  if (existing) {
    if (Object.keys(patch).length === 0) return json(req, { ok: true, id: existing.id });
    const { error } = await service.from('platform_leads').update(patch).eq('id', existing.id);
    if (error) { console.error('platform_leads track update error:', error); return json(req, { error: 'Could not save' }, 500); }
    return json(req, { ok: true, id: existing.id });
  }

  const { data, error } = await service
    .from('platform_leads')
    .insert({ source: 'app_signup', email: user.email ?? null, user_id: user.id, name: str(user.user_metadata?.full_name ?? user.user_metadata?.name, 200), answers: { provider: user.app_metadata?.provider ?? 'email' }, ...patch })
    .select('id')
    .single();
  if (error) { console.error('platform_leads track insert error:', error); return json(req, { error: 'Could not save' }, 500); }
  return json(req, { ok: true, id: data.id });
}
