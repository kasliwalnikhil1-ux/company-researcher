/**
 * Enrichment in the demo (outreach_request_enrichment, 014): leads are marked `waiting`, and a few seconds later their
 * profile is "read": filled from a local pool of fictional profile parts (seed/names.ts). Pending work is kept in the
 * store's meta, so a reload in between finishes it on the next read instead of leaving the lead waiting forever.
 */
import { COMPANIES, LOCATIONS, POST_TOPICS, SCHOOLS, SKILLS, TITLES } from '../seed/names';
import { SENDER } from '../seed/ids';
import type { DemoStore, Row } from '../store';
import { profileSearchText } from './util';

const D = 86_400_000;
const PENDING = 'leads:enrichPending';
const NOTE = "Background enrichment only uses profile views left over after the day's sequence actions, at most 30% of a sender's allowance, inside working hours. Senders at warm-up level 0–1 do none.";
const LANGS = [['English'], ['English', 'Spanish'], ['English', 'German'], ['English', 'French'], ['English', 'Portuguese'], ['English', 'Hindi']];

type Pending = { lead_id: string; due: number; want_posts: boolean; source: string };

export interface EnrichResult { queued: number; skipped_fresh: number; skipped_no_linkedin_id: number; note: string }

const timers = new WeakMap<DemoStore, ReturnType<typeof setTimeout>>();

export function requestEnrichment(store: DemoStore, ws: string, leadIds: string[], o: { wantPosts?: boolean; force?: boolean; reason?: string; delayMs?: [number, number] } = {}): EnrichResult {
  const ids = new Set(leadIds);
  const leads = store.t('outreach_leads').filter((l) => l.workspace_id === ws && ids.has(l.id));
  const profiles = new Map(store.t('outreach_lead_profiles').map((p) => [p.lead_id, p]));
  const now = Date.now();
  const fresh = (l: Row) => { const p = profiles.get(l.id); return !!p?.enriched_at && Date.parse(p.enriched_at) > now - 90 * D; };
  const noId = leads.filter((l) => !l.public_identifier && !l.provider_id).length;
  const skippedFresh = o.force ? 0 : leads.filter(fresh).length;
  const take = leads.filter((l) => (l.public_identifier || l.provider_id) && !l.do_not_contact && (o.force || !fresh(l)));
  const source = o.reason === 'import' ? 'background' : o.reason === 'step' || o.reason === 'prefetch' || o.reason === 'draft' ? o.reason : 'manual';
  const pending = store.meta<Pending[]>(PENDING, () => []).filter((p) => !take.some((l) => l.id === p.lead_id));
  const [lo, hi] = o.delayMs ?? [2500, 6000];
  for (const l of take) pending.push({ lead_id: l.id, due: now + store.int(lo, hi), want_posts: !!o.wantPosts, source });
  store.setMeta(PENDING, pending);
  const set = new Set(take.map((l) => l.id));
  if (set.size) store.update('outreach_leads', (r) => set.has(r.id) && r.enrich_status !== 'waiting', { enrich_status: 'waiting' });
  schedule(store);
  return { queued: take.length, skipped_fresh: skippedFresh, skipped_no_linkedin_id: noId, note: NOTE };
}

function schedule(store: DemoStore) {
  const pending = store.meta<Pending[]>(PENDING, () => []);
  if (!pending.length) return;
  const next = Math.min(...pending.map((p) => p.due));
  const prev = timers.get(store);
  if (prev) clearTimeout(prev);
  timers.set(store, setTimeout(() => { timers.delete(store); processDueEnrichment(store); }, Math.max(50, next - Date.now() + 20)));
}

/** Finishes every enrichment whose time has come. Cheap when nothing is pending (called before lead / profile reads). */
export function processDueEnrichment(store: DemoStore, now = Date.now()): number {
  const pending = store.has('outreach_leads') ? store.meta<Pending[]>(PENDING, () => []) : [];
  if (!pending.length) return 0;
  const due = pending.filter((p) => p.due <= now);
  if (!due.length) { schedule(store); return 0; }
  store.setMeta(PENDING, pending.filter((p) => p.due > now));
  for (const p of due) fillProfile(store, p, now);
  schedule(store);
  return due.length;
}

function enricher(store: DemoStore): Row | undefined {
  const li = store.t('outreach_senders').filter((s) => s.provider === 'LINKEDIN' && s.status === 'ok' && !s.deleted_at);
  return li.find((s) => s.id === SENDER.li_maya) ?? li[0];
}

/** Writes a full, fictional profile for the lead and marks it enriched. */
export function fillProfile(store: DemoStore, p: { lead_id: string; want_posts: boolean; source: string }, now = Date.now()): Row | null {
  const lead = store.get('outreach_leads', p.lead_id);
  if (!lead) return null;
  const iso = (ms: number) => new Date(ms).toISOString();
  const pick = <T,>(xs: readonly T[]) => store.pick(xs);
  const title = lead.title ?? pick(TITLES);
  const company = lead.company ?? pick(COMPANIES);
  const location = lead.location ?? pick(LOCATIONS);
  const prevCompany = pick(COMPANIES.filter((c) => c !== company));
  const startedMonths = store.int(4, 70);
  const started = now - startedMonths * 30 * D;
  const old = store.get('outreach_lead_profiles', p.lead_id, 'lead_id');
  const posts = p.want_posts || old?.posts?.length
    ? [0, 1, 2].map((k) => ({ id: `demo-post-${lead.id.slice(-6)}-${k}`, text: `Some thoughts on ${pick(POST_TOPICS)}. What has worked for your team?`, date: iso(now - (3 + k * 8 + store.int(0, 6)) * D), reactions: store.int(8, 180), comments: store.int(0, 30) }))
    : [];
  const sender = enricher(store);
  const school = pick(SCHOOLS);
  const skills = [...new Set([pick(SKILLS), pick(SKILLS), pick(SKILLS), pick(SKILLS)])];
  const profile: Row = {
    lead_id: lead.id, workspace_id: lead.workspace_id,
    about: `${title} at ${company}. I like building teams that grow without burning out, and I write about what works in B2B. Previously at ${prevCompany}.`,
    current_title: title, current_company: company, current_started_on: iso(started).slice(0, 10),
    experience: [
      { company, title, start: iso(started).slice(0, 7), current: true, location },
      { company: prevCompany, title: pick(TITLES), start: iso(started - store.int(500, 1500) * D).slice(0, 7), end: iso(started - 30 * D).slice(0, 7), current: false },
    ],
    education: [{ school, degree: store.chance(0.5) ? 'BSc' : 'MBA', field: store.chance(0.5) ? 'Business Administration' : 'Computer Science', start: '2009', end: '2013' }],
    skills, languages: pick(LANGS), profile_language: 'en',
    follower_count: store.int(250, 9000), connections_count: store.int(200, 4800),
    linkedin: {
      is_open_profile: lead.is_open_profile ?? store.chance(0.12), is_premium: store.chance(0.3), network_distance: 'SECOND_DEGREE', shared_connections_count: store.int(0, 40),
      can_send_inmail: store.chance(0.4), is_hiring: store.chance(0.15), country: String(location).split(', ').pop(),
      websites: lead.custom?.website ? [String(lead.custom.website)] : [],
    },
    posts: posts.length ? posts : (old?.posts ?? []), posts_fetched_at: posts.length ? iso(now) : old?.posts_fetched_at ?? null,
    last_posted_at: posts[0]?.date ?? old?.last_posted_at ?? null,
    enriched_at: iso(now), enriched_by_sender: sender?.id ?? null, source: p.source, empty_sections: posts.length || !p.want_posts ? [] : ['posts'], updated_at: iso(now),
  };
  profileSearchText(profile);
  if (old) store.update('outreach_lead_profiles', (r) => r === old, profile);
  else store.insert('outreach_lead_profiles', profile, { noId: true });
  store.update('outreach_leads', lead.id, (l) => ({
    enrich_status: 'done', enriched_at: iso(now), last_profile_fetch_at: iso(now), title: l.title ?? title, company: l.company ?? company, location: l.location ?? location,
    headline: l.headline ?? `${title} at ${company}`, is_open_profile: l.is_open_profile ?? profile.linkedin.is_open_profile,
  }));
  return profile;
}
