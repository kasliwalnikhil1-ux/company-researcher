// /app/api/leads — public intake for the marketing site's forms (growthxai.com → app.growthxai.com).
//
// The site (outreach-app-website, `site.formEndpoint`) POSTs one JSON object per submission:
//   { form: "waitlist" | "demo" | "contact", ... }   or   { type: "integration_request", ... }
//   plus name, email, company, the form's own answers, page, referrer, utm, timezone.
// One row lands in platform_leads (migrations/platform/002_leads.sql) with the visitor's location from the request's
// geo headers when the host provides them (Vercel), else a best-effort IP lookup; location is always optional.
// Admins see the rows under /admin → Leads.
//
// No auth (the site is static, a shared secret would be public). Protection: CORS allow-list, honeypot field,
// per-IP rate limit, size caps, email validation.

import { NextRequest, NextResponse } from 'next/server';
import { EMAIL_RE, allowedOrigin, corsHeaders, geoFromHeaders, geoLookup, json, rateLimited, serviceClient, str, type LeadSource } from '@/lib/platform/leads-server';

export const runtime = 'nodejs';

const SOURCE_BY_FORM: Record<string, LeadSource> = {
  waitlist: 'website_waitlist',
  demo: 'website_demo',
  switch: 'website_demo',
  contact: 'website_contact',
  integration: 'website_integration',
  integration_request: 'website_integration',
};

// fields that are stored in their own columns; everything else goes into `answers`
const META = new Set(['form', 'type', 'name', 'email', 'company', 'page', 'referrer', 'utm', 'timezone', 'website', 'landing']);

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function POST(req: NextRequest) {
  // A browser always sends Origin: only the marketing site (and local dev) may post. Requests without an Origin
  // (server-side scripts, automation) are allowed through.
  if (req.headers.get('origin') && !allowedOrigin(req)) return json(req, { error: 'Origin not allowed' }, 403);

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 16_000) return json(req, { error: 'Payload too large' }, 413);
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    return json(req, { error: 'Invalid JSON' }, 400);
  }

  // honeypot: real people never fill the hidden "website" field
  if (str(body.website)) return json(req, { ok: true });

  const email = str(body.email, 320)?.toLowerCase() ?? null;
  if (!email || !EMAIL_RE.test(email)) return json(req, { error: 'A valid email is required' }, 400);

  const geo = geoFromHeaders(req);
  if (rateLimited(`lead:${geo.ip ?? 'unknown'}`)) return json(req, { error: 'Too many requests' }, 429);

  const formKey = (str(body.form) ?? str(body.type) ?? 'other').toLowerCase();
  const source: LeadSource = SOURCE_BY_FORM[formKey] ?? 'website_other';

  const answers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (META.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'string') answers[k] = v.slice(0, 2000);
    else if (typeof v === 'number' || typeof v === 'boolean') answers[k] = v;
    else if (typeof v === 'object') answers[k] = JSON.parse(JSON.stringify(v).slice(0, 2000));
    if (Object.keys(answers).length >= 40) break;
  }
  if (formKey !== 'other' && !SOURCE_BY_FORM[formKey]) answers.form = formKey;

  const utmIn = body.utm && typeof body.utm === 'object' && !Array.isArray(body.utm) ? (body.utm as Record<string, unknown>) : {};
  const utm: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = str(utmIn[k], 200) ?? str(utmIn[`utm_${k}`], 200);
    if (v) utm[k] = v;
  }

  const located = await geoLookup(geo);
  const timezone = located.timezone ?? str(body.timezone, 80);

  const service = serviceClient();
  if (!service) return json(req, { error: 'Not configured' }, 500);

  const { data, error } = await service
    .from('platform_leads')
    .insert({
      source,
      email,
      name: str(body.name, 200),
      company: str(body.company, 200),
      answers,
      page: str(body.page, 500),
      referrer: str(body.referrer, 1000),
      utm,
      ip: located.ip,
      country: located.country,
      region: located.region,
      city: located.city,
      timezone,
      latitude: located.latitude,
      longitude: located.longitude,
      user_agent: str(req.headers.get('user-agent'), 500),
    })
    .select('id')
    .single();

  if (error) {
    console.error('platform_leads insert error:', error);
    return json(req, { error: 'Could not save' }, 500);
  }
  return json(req, { ok: true, id: data.id });
}
