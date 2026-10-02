/**
 * The demo `render_context`: the same JSON the SQL function returns (lead, sender, enrich, ai, account, now, seed), built
 * from the demo tables. The simulator renders every message with it through the app's own `renderTemplate`.
 */
import { buildContext, nowParts, renderTemplate } from '../../../render';
import type { DemoStore, Row } from '../store';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function enrichContext(store: DemoStore, leadId: string): Record<string, unknown> {
  const p = store.get('outreach_lead_profiles', leadId, 'lead_id');
  if (!p) return {};
  const started = p.current_started_on ? new Date(p.current_started_on) : null;
  const months = started ? Math.max(0, Math.floor((Date.now() - started.getTime()) / (30.44 * 86_400_000))) : null;
  const exp: Row[] = Array.isArray(p.experience) ? p.experience : [];
  const prev = exp.find((x) => !x.current && x.company && String(x.company).toLowerCase() !== String(p.current_company ?? '').toLowerCase());
  const posts: Row[] = Array.isArray(p.posts) ? p.posts : [];
  const recent = p.last_posted_at && Date.now() - Date.parse(p.last_posted_at) < 60 * 86_400_000 ? posts[0] : null;
  const out: Record<string, unknown> = {
    about: p.about ? String(p.about).slice(0, 600) : undefined,
    current_title: p.current_title, current_company: p.current_company,
    years_in_role: months != null ? Math.floor(months / 12) : undefined,
    months_in_role: months ?? undefined,
    previous_company: prev?.company, previous_title: prev?.title,
    school: p.education?.[0]?.school, degree: p.education?.[0]?.degree, education_field: p.education?.[0]?.field,
    top_skill: p.skills?.[0], skills: Array.isArray(p.skills) ? p.skills.slice(0, 3).join(', ') : undefined,
    language: p.profile_language ?? p.languages?.[0],
    follower_count: p.follower_count, connections_count: p.connections_count,
    recent_post: recent?.text ? String(recent.text).slice(0, 280) : undefined,
    recent_post_date: recent ? `${MONTHS[new Date(p.last_posted_at).getUTCMonth()]} ${String(new Date(p.last_posted_at).getUTCDate()).padStart(2, '0')}` : undefined,
    last_enrich_at: p.enriched_at ? new Date(p.enriched_at).toDateString().slice(4) : undefined,
    current_started_on: started ? `${MONTHS[started.getUTCMonth()]} ${started.getUTCFullYear()}` : undefined,
    current_duration: months != null ? (months >= 12 ? `${Math.floor(months / 12)} yr${months >= 24 ? 's' : ''} ${months % 12} mo` : `${months} mo`) : undefined,
    experience_summary: exp.slice(0, 3).map((x) => [x.title, x.company].filter(Boolean).join(' at ')).join('; ') || undefined,
    education_summary: (p.education ?? []).slice(0, 2).map((e: Row) => `${[e.degree, e.field].filter(Boolean).join(', ')}${e.degree || e.field ? ' — ' : ''}${e.school}`).join('; ') || undefined,
    last_3_posts: posts.slice(0, 3).map((x) => String(x.text ?? '').slice(0, 280)).join('\n\n') || undefined,
    location_city: typeof p.linkedin?.city === 'string' ? p.linkedin.city : undefined,
    location_country: typeof p.linkedin?.country === 'string' ? p.linkedin.country : undefined,
    is_enriched: true,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
  return out;
}

export function senderContext(s: Row | undefined): Record<string, unknown> {
  if (!s) return {};
  const name = String(s.display_name ?? '');
  const first = name.split(' ')[0] ?? '';
  return {
    id: s.id, display_name: s.display_name, full_name: s.display_name, first_name: first, last_name: name.slice(first.length + 1) || null,
    label: s.label ?? null, booking_link: s.booking_link, signature: s.signature, public_identifier: s.public_identifier, email: s.owner_email, timezone: s.timezone,
  };
}

export function renderContextJson(store: DemoStore, leadId: string, senderId?: string | null, enrollmentId?: string | null): Record<string, unknown> {
  const l = store.get('outreach_leads', leadId) ?? {};
  const s = senderId ? store.get('outreach_senders', senderId) : undefined;
  const ai: Record<string, unknown> = {};
  for (const v of store.t('outreach_ai_values')) {
    if (v.lead_id !== leadId || v.status !== 'approved') continue;
    const variable = store.get('outreach_ai_variables', v.variable_id);
    if (!variable) continue;
    ai[variable.key] = variable.output === 'fields' && v.data ? v.data : v.text;
  }
  const tagNames = store.t('outreach_lead_tags').filter((t) => t.lead_id === leadId).map((t) => store.get('outreach_tags', t.tag_id)?.name).filter(Boolean);
  const enrich = enrichContext(store, leadId);
  const company = l.company ? { name: l.company, domain: l.custom?.website ?? null, industry: l.custom?.industry ?? null, size: l.custom?.company_size ?? null } : {};
  return {
    lead: { ...l, tags: tagNames.join(', '), work_email_domain: typeof l.email_work === 'string' ? l.email_work.split('@')[1] ?? null : null },
    sender: senderContext(s),
    enrich,
    ai,
    account: company,
    now: nowParts((s?.timezone as string) ?? 'UTC'),
    seed: enrollmentId ?? `${leadId}:${senderId ?? ''}`,
  };
}

/** Renders a step's text for a lead the way the engine would send it. */
export function renderFor(store: DemoStore, template: string, leadId: string, senderId: string, enrollmentId?: string | null): string {
  const json = renderContextJson(store, leadId, senderId, enrollmentId);
  return renderTemplate(template, buildContext(json, { seed: (json.seed as string) ?? null, unsubscribe_link: '#unsubscribe' }));
}
