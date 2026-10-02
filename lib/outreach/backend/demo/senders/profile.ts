/**
 * Profile Studio in the demo (migrations 021–023): snapshots, changes and their lifecycle, ceilings, authority, templates,
 * bulk runs, experiments and the QA score, on small tables of the demo store. A submitted change is scheduled inside the
 * sender's working hours like outreach_profile_schedule does, and `settleProfiles` applies it locally once the demo clock
 * reaches that time: a post-change snapshot is written and the QA score recomputed. Nothing reaches LinkedIn.
 */
import { demoError, type Ctx } from '../ctx';
import type { DemoStore, Row } from '../store';
import { localParts, simWallClock } from '../sim/caps';
import { D, effectiveCap, H, inHours, iso, MIN, randomHex } from './util';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from '../seed/ids';

export const T = {
  snapshots: 'outreach_profile_snapshots', changes: 'outreach_profile_changes', templates: 'outreach_profile_templates', experiments: 'outreach_profile_experiments',
  authority: 'outreach_profile_authority', links: 'outreach_profile_authority_links', runs: 'outreach_profile_bulk_runs', qa: 'outreach_profile_qa',
} as const;

export const GROUPS = ['headline', 'about', 'photo', 'cover', 'location', 'experience', 'education', 'skills', 'custom_link'] as const;
/** outreach_profile_ceilings (022). */
export const CEILINGS: Record<string, { max: number; window_days: number }> = {
  photo: { max: 1, window_days: 30 }, cover: { max: 2, window_days: 30 }, headline: { max: 2, window_days: 7 }, about: { max: 2, window_days: 7 },
  experience: { max: 3, window_days: 7 }, experience_new: { max: 1, window_days: 30 }, education: { max: 1, window_days: 30 }, location: { max: 1, window_days: 90 },
  skills: { max: 2, window_days: 7 }, custom_link: { max: 2, window_days: 7 }, all: { max: 4, window_days: 7 }, all_daily: { max: 1, window_days: 1 },
};
const PENDING = ['draft', 'awaiting_owner', 'approved', 'queued'];
const COUNTED = ['queued', 'applied', 'partially_applied'];
const label = (g: string) => g.replace(/_/g, ' ');

export function groupsOf(p: Row = {}, a: Row = {}): string[] {
  const hit: Record<string, boolean> = {
    headline: 'headline' in p, about: 'summary' in p, photo: 'picture_settings' in p || !!a.picture || !!a.picture_url,
    cover: 'cover_picture_settings' in p || !!a.cover_picture || !!a.cover_url, location: 'location' in p, experience: 'experience' in p,
    education: 'education' in p, skills: 'skills' in p || 'skills_follow' in p, custom_link: 'custom_link' in p,
  };
  return GROUPS.filter((g) => hit[g]);
}

export function prohibited(p: Row): string | null {
  if ('open_to_work' in p) return 'open_to_work';
  if (JSON.stringify(p).includes('"notify_network"')) return 'notify_network';
  if ('first_name' in p || 'last_name' in p || 'pronouns' in p || 'public_identifier' in p) return 'name';
  return null;
}

export function payloadProblem(p: Row): string | null {
  const len = (v: unknown) => String(v ?? '').length;
  if ('headline' in p && len(p.headline) > 220) return 'The headline is over 220 characters';
  if ('headline' in p && !String(p.headline ?? '').trim()) return 'The headline is empty';
  if ('summary' in p && len(p.summary) > 2600) return 'The About section is over 2,600 characters';
  if ('experience' in p && len(p.experience?.description) > 2000) return 'The experience description is over 2,000 characters';
  if ('experience' in p && !p.experience?.id && (!p.experience?.role || !p.experience?.company)) return 'A new experience entry needs a role and a company';
  if ('education' in p && len(p.education?.description) > 1000) return 'The education description is over 1,000 characters';
  if ('education' in p && !p.education?.id && !p.education?.school) return 'A new education entry needs a school';
  if ('skills' in p && !Array.isArray(p.skills)) return 'Skills must be a list';
  if ('skills' in p && p.skills.length > 50) return 'At most 50 skills';
  if ('custom_link' in p && !/^https?:\/\//i.test(String(p.custom_link?.url ?? ''))) return 'The custom link must start with http:// or https://';
  if ('custom_link' in p && !['STORE', 'WEBSITE', 'PORTFOLIO', 'BLOG', 'NEWSLETTER'].includes(String(p.custom_link?.type ?? ''))) return 'Pick a link type';
  if ('location' in p && !p.location?.id && !p.location?.postal_code) return 'A location needs a LinkedIn location id or a postal code';
  if ('picture_settings' in p && !['ORIGINAL', 'STUDIO', 'SPOTLIGHT', 'PRIME', 'CLASSIC', 'EDGE', 'LUMINATE'].includes(String(p.picture_settings?.filter ?? 'ORIGINAL'))) return 'Unknown photo filter';
  return null;
}

const permissionRequired = (store: DemoStore, ws: string) => !!store.get('outreach_workspaces', ws)?.settings?.profile_owner_permission;
const identityVerified = (s: Row) => ['credentials', 'browser', 'oauth'].includes(s.auth_method) && !s.profile_identity_unverified;

export function authorityFor(store: DemoStore, senderId: string, group: string): Row | undefined {
  const now = Date.now();
  return store.t(T.authority).filter((a) => a.sender_id === senderId && a.field_group === group && !a.revoked_at && (!a.expires_at || Date.parse(a.expires_at) > now))
    .sort((a, b) => String(b.granted_at).localeCompare(String(a.granted_at)))[0];
}

const changeAt = (c: Row) => c.applied_at ?? c.scheduled_for ?? c.submitted_at ?? c.created_at;

export function ceilingUsed(store: DemoStore, senderId: string, key: string, exclude?: string | null): Row {
  const c = CEILINGS[key];
  if (!c) return { key, max: null, used: 0, remaining: 999, next_at: null };
  const since = Date.now() - c.window_days * D;
  const rows = store.t(T.changes).filter((ch) => ch.sender_id === senderId && COUNTED.includes(ch.status) && ch.id !== exclude && Date.parse(changeAt(ch)) > since
    && (key === 'all' || key === 'all_daily' ? true : key === 'experience_new' ? ch.field_groups.includes('experience') && !ch.payload?.experience?.id : ch.field_groups.includes(key)));
  const first = rows.reduce((m, r) => Math.min(m, Date.parse(changeAt(r))), Infinity);
  return { key, max: c.max, window_days: c.window_days, used: rows.length, remaining: Math.max(c.max - rows.length, 0), next_at: rows.length >= c.max && Number.isFinite(first) ? iso(first + c.window_days * D) : null };
}

const dm = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

/** outreach_profile_validate: {ok, mode, groups, causes}. */
export function validate(store: DemoStore, s: Row | undefined, p: Row, a: Row = {}, opts: { bulk?: number; change?: string | null; experiment?: string | null } = {}): Row {
  if (!s || s.deleted_at) return { ok: false, mode: 'direct', groups: [], causes: [{ code: 'E_NOT_FOUND', blocking: true, detail: 'Sender not found', remedy: 'Check the sender id' }] };
  const now = Date.now();
  const groups = groupsOf(p, a);
  const causes: Row[] = [];
  let mode = 'direct';
  const needAuth = permissionRequired(store, s.workspace_id);
  if (s.provider !== 'LINKEDIN') causes.push({ code: 'E_PROFILE_PROVIDER', blocking: true, detail: 'Profile editing is available for LinkedIn accounts', remedy: 'Pick a LinkedIn sender' });
  if (s.status !== 'ok') causes.push({ code: 'E_PROFILE_SENDER_NOT_OK', blocking: true, detail: `The account is ${s.status === 'credentials' ? 'waiting for a fresh login' : s.status}`, remedy: 'Reconnect or resume the sender first. Profile changes are never applied while it is disconnected.' });
  if (s.paused_until && Date.parse(s.paused_until) > now) causes.push({ code: 'E_PROFILE_SENDER_NOT_OK', blocking: true, detail: `The account is resting until ${dm(Date.parse(s.paused_until))}`, remedy: 'Wait for the pause to end' });
  if (Number(s.health_score ?? 100) < 50) causes.push({ code: 'E_PROFILE_HEALTH', blocking: true, detail: 'Health is below 50, so the account has no daily allowance', remedy: 'Fix the health causes on the Insights tab first' });
  if (!identityVerified(s)) causes.push({ code: 'E_PROFILE_IDENTITY_UNVERIFIED', blocking: true, detail: 'This account was not connected by its owner through a hosted login, so its identity is unverified', remedy: 'Ask the owner to reconnect through the hosted login page. Profiles connected by cookie cannot be edited.' });
  if (Number(s.warmup_level ?? 0) < 1) causes.push({ code: 'E_PROFILE_WARMUP', blocking: true, detail: 'The account is at warm-up level 0', remedy: 'Profile changes on a brand-new or thin account look like a takeover. Wait for level 1.' });
  const quietFrom = Math.max(s.connected_at ? Date.parse(s.connected_at) : 0, s.last_reconnect_at ? Date.parse(s.last_reconnect_at) : 0);
  if (quietFrom > now - 72 * H) causes.push({ code: 'E_PROFILE_QUIET_PERIOD', blocking: true, detail: 'The account connected or reconnected less than 72 hours ago', remedy: `Wait until ${new Date(quietFrom + 72 * H).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: s.timezone || 'UTC' })}. Edits right after a new login are what LinkedIn watches for.` });
  if (!groups.length) causes.push({ code: 'E_PAYLOAD_INVALID', blocking: true, detail: 'Nothing to change', remedy: 'Edit at least one field' });
  const bad = prohibited(p);
  if (bad) causes.push({ code: 'E_PROFILE_PROHIBITED', blocking: true, detail: `The platform never writes ${bad}`, remedy: 'Remove it. Open-to-work, network broadcasts and names are not editable here, by design.' });
  const prob = payloadProblem(p);
  if (prob) causes.push({ code: 'E_PAYLOAD_INVALID', blocking: true, detail: prob, remedy: 'Fix the field and try again' });
  if ((opts.bulk ?? 1) > 1 && 'experience' in p && !p.experience?.id) causes.push({ code: 'E_PROFILE_PROHIBITED', blocking: true, detail: 'Creating a job entry on several profiles in one operation is not allowed', remedy: "Add a position one sender at a time, with that person's confirmation." });
  for (const g of groups) {
    if (needAuth) {
      const au = authorityFor(store, s.id, g);
      if (!au) causes.push({ code: 'E_NO_PROFILE_AUTHORITY', blocking: true, group: g, detail: `No authority from the account owner to edit ${label(g)}`, remedy: 'Send the owner a permission link from the Profile tab, grant it yourself if you own this account, or switch off owner permission in Settings, Workspace.' });
      else if (au.mode === 'propose_only') mode = 'propose_only';
    }
    const c = ceilingUsed(store, s.id, g, opts.change);
    if (c.remaining <= 0) causes.push({ code: 'E_PROFILE_CEILING', blocking: true, group: g, detail: `${label(g)}: ${c.max} change(s) per ${c.window_days} days already used`, remedy: `Next change possible on ${c.next_at ? dm(Date.parse(c.next_at)) : 'soon'}` });
    if (g === 'experience' && !p.experience?.id) {
      const n = ceilingUsed(store, s.id, 'experience_new', opts.change);
      if (n.remaining <= 0) causes.push({ code: 'E_PROFILE_CEILING', blocking: true, group: g, detail: 'A new position was added in the last 30 days', remedy: `Next new entry possible on ${n.next_at ? dm(Date.parse(n.next_at)) : 'soon'}` });
    }
    const lock = store.t(T.experiments).find((e) => ['washout', 'running', 'ready'].includes(e.status) && e.field_group === g && (e.sender_ids ?? []).includes(s.id) && e.id !== opts.experiment);
    if (lock) causes.push({ code: 'E_EXPERIMENT_LOCK', blocking: true, group: g, detail: `${label(g)} is locked by the running experiment "${lock.name}"`, remedy: 'Conclude or abandon the experiment first' });
  }
  const all = ceilingUsed(store, s.id, 'all', opts.change);
  if (all.remaining <= 0) causes.push({ code: 'E_PROFILE_CEILING', blocking: true, detail: `The combined limit of ${all.max} profile changes per week is used`, remedy: `Next change possible on ${all.next_at ? dm(Date.parse(all.next_at)) : 'soon'}` });
  const eff = effectiveCap(store, s, 'profile_edit');
  if (eff < 1 && Number(s.warmup_level ?? 0) >= 1 && Number(s.health_score ?? 100) >= 50) causes.push({ code: 'E_PROFILE_CEILING', blocking: true, detail: 'The daily allowance for profile edits is 0 (manual cap)', remedy: 'Raise the profile_edit cap on the Budgets tab' });
  return { ok: !causes.some((c) => c.blocking), mode, groups, causes };
}

/** outreach_profile_why_not: the editor's status panel. */
export function whyNot(store: DemoStore, s: Row): Row {
  const groups = GROUPS.map((g) => {
    const au = authorityFor(store, s.id, g);
    const lock = store.t(T.experiments).find((e) => ['washout', 'running', 'ready'].includes(e.status) && e.field_group === g && (e.sender_ids ?? []).includes(s.id));
    const ceiling = ceilingUsed(store, s.id, g);
    if (g === 'experience') ceiling.new_entry = ceilingUsed(store, s.id, 'experience_new');
    return { group: g, authority: au ? { id: au.id, mode: au.mode, granted_by: au.granted_by_email, via: au.granted_via, expires_at: au.expires_at ?? null } : null, ceiling, locked_by: lock ? { experiment_id: lock.id, name: lock.name } : null };
  });
  const v = validate(store, s, {}, {});
  return {
    groups, combined: { week: ceilingUsed(store, s.id, 'all'), day: ceilingUsed(store, s.id, 'all_daily') },
    blockers: v.causes.filter((c: Row) => c.code !== 'E_PAYLOAD_INVALID'),
    identity_verified: identityVerified(s), warmup_level: s.warmup_level, owner_email: s.owner_email ?? null,
    permission_required: permissionRequired(store, s.workspace_id), daily_allowance: effectiveCap(store, s, 'profile_edit'),
  };
}

// ---------------------------------------------------------------------------
// Snapshots and the QA score
// ---------------------------------------------------------------------------
export function latestSnapshot(store: DemoStore, senderId: string): Row | undefined {
  return store.t(T.snapshots).filter((x) => x.sender_id === senderId).sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)))[0];
}

/** A plausible first read of a sender's own profile (for senders connected in the demo). */
export function baselineDoc(store: DemoStore, s: Row): Row {
  const [first, ...rest] = String(s.display_name ?? 'Demo Sender').split(' ');
  const company = store.get('outreach_workspaces', s.workspace_id)?.name ?? 'Northwind Growth';
  return {
    headline: `Account Executive at ${company}`, summary: null, location: 'New York, United States', picture_url: s.picture_url ?? null, cover_url: null,
    first_name: first, last_name: rest.join(' ') || null, public_identifier: s.public_identifier ?? null, connections_count: s.connections_count ?? null, follower_count: s.connections_count ? Math.round(s.connections_count * 1.1) : null,
    experience: [{ id: `demo-pos-${s.id.slice(-4)}`, title: 'Account Executive', company, company_id: null, start: '2024-02', end: null, current: true, location: 'New York, United States', description: null, skills: [] }],
    education: [{ id: `demo-edu-${s.id.slice(-4)}`, school: 'Riverside University', degree: 'BA', field: 'Economics', start: '2012', end: '2016', description: null }],
    skills: [{ name: 'B2B sales', endorsements: 4 }, { name: 'Negotiation', endorsements: 2 }],
    languages: ['English'], certifications: [], projects: [], websites: [],
    fetched_sections: ['headline', 'about', 'experience', 'education', 'skills'], fetched_at: store.nowIso(),
  };
}

export function recordSnapshot(store: DemoStore, s: Row, kind: string, data: Row, opts: { change?: string | null; at?: string; fidelity?: string } = {}): Row {
  const at = opts.at ?? store.nowIso();
  const row = store.insert(T.snapshots, {
    workspace_id: s.workspace_id, sender_id: s.id, kind, sections: data.fetched_sections ?? ['headline', 'about', 'experience', 'education', 'skills'], fidelity: opts.fidelity ?? 'full',
    data: { ...data, fetched_at: at }, unwritten_fields: [], drift: null, captured_at: at, captured_by: null, action_id: null, change_id: opts.change ?? null,
  })[0];
  store.update('outreach_senders', s.id, { profile_snapshot_at: at });
  return row;
}

/** outreach_profile_qa_compute. */
export function computeQa(store: DemoStore, s: Row, at?: string): Row {
  const snap = latestSnapshot(store, s.id);
  const d: Row = snap?.data ?? {};
  const hl = String(d.headline ?? ''); const ab = String(d.summary ?? '');
  const pic = String(d.picture_url ?? s.picture_url ?? '');
  const conns = d.connections_count ?? s.connections_count ?? null;
  const exp: Row[] = Array.isArray(d.experience) ? d.experience : [];
  const cur = exp.find((e) => e.current) ?? exp[0] ?? null;
  const nskills = Array.isArray(d.skills) ? d.skills.length : 0;
  const sections: string[] = snap?.sections ?? [];
  const link = store.t(T.changes).filter((c) => c.sender_id === s.id && ['applied', 'partially_applied'].includes(c.status) && c.payload?.custom_link).length > 0;
  const plain = /^\s*[^|•·–—]{2,60}\s+at\s+[^|•·–—]{2,60}\s*$/i.test(hl);
  const checks: Row[] = [
    { code: 'no_photo', severity: 'critical', pass: pic !== '', detail: pic === '' ? 'No profile photo' : 'Custom photo present', fix_hint: 'Upload a clear head-and-shoulders photo on a plain background. Profiles with a real photo get accepted far more often.' },
    { code: 'headline_default', severity: 'high', pass: !plain, detail: plain ? 'The headline is the bare default ("Role at Company")' : 'Headline is customised', fix_hint: 'Say who you help and how, not just your title.' },
    { code: 'headline_length', severity: 'medium', pass: hl !== '' && hl.length >= 40 && hl.length <= 200, detail: hl === '' ? 'No headline' : hl.length < 40 ? 'Headline is under 40 characters' : hl.length > 200 ? 'Headline is over 200 characters and will be cut off' : 'Headline length is fine', fix_hint: 'Aim for 40 to 200 characters.' },
    { code: 'about_empty', severity: 'high', pass: !snap || !sections.includes('about') ? null : ab !== '', detail: ab === '' ? 'The About section is empty' : 'About section present', fix_hint: 'Write 3 short paragraphs: who you help, how, and proof.' },
    { code: 'about_short', severity: 'medium', pass: ab === '' ? null : ab.length >= 300, detail: ab === '' ? 'No About section' : ab.length < 300 ? 'The About section is under 300 characters' : 'About section is long enough', fix_hint: 'Give prospects enough to trust you: at least 300 characters.' },
    { code: 'about_no_breaks', severity: 'low', pass: ab.length < 300 ? null : ab.includes('\n'), detail: ab.length >= 300 && !ab.includes('\n') ? 'The About section is one block of text' : 'About section has paragraphs', fix_hint: 'Break it into short paragraphs.' },
    { code: 'no_cover', severity: 'medium', pass: 'cover_url' in d ? !!d.cover_url : null, detail: 'cover_url' in d && !d.cover_url ? 'No cover image' : 'cover_url' in d ? 'Cover image present' : 'Cover image not reported by LinkedIn', fix_hint: 'Add a cover image that states your offer in one line.' },
    { code: 'experience_no_description', severity: 'medium', pass: cur ? !!cur.description : null, detail: !cur ? 'No current position found' : !cur.description ? 'The current position has no description' : 'Current position has a description', fix_hint: 'Describe what you do for whom in 2 to 4 lines.' },
    { code: 'few_skills', severity: 'low', pass: !snap || !sections.includes('skills') ? null : nskills >= 5, detail: `${nskills} skills listed`, fix_hint: 'List at least 5 relevant skills.' },
    { code: 'no_custom_link', severity: 'low', pass: link ? true : null, detail: link ? 'Custom link set' : 'No custom link set through the platform (LinkedIn does not report this field)', fix_hint: 'Add a link to a booking page or case study.' },
    { code: 'location_unset', severity: 'medium', pass: !!d.location, detail: d.location ? 'Location set' : 'No location set', fix_hint: 'Set your location; prospects filter by it.' },
    { code: 'connections_low', severity: 'critical', pass: conns == null ? null : conns >= 150, detail: conns == null ? 'Connections count unknown' : `${conns} connections`, fix_hint: 'Below 150 connections the account stays at warm-up level 0.' },
  ];
  const penalty: Record<string, number> = { critical: 25, high: 15, medium: 8, low: 4 };
  const score = Math.max(0, Math.min(100, 100 - checks.filter((c) => c.pass === false).reduce((x, c) => x + penalty[c.severity], 0)));
  const computed_at = at ?? store.nowIso();
  store.upsert(T.qa, { sender_id: s.id, workspace_id: s.workspace_id, score, checks, snapshot_id: snap?.id ?? null, computed_at }, ['sender_id']);
  if (s.profile_qa_score !== score) store.update('outreach_senders', s.id, { profile_qa_score: score });
  return { score, checks, snapshot_id: snap?.id ?? null, computed_at };
}

/** The profile document after a change: what LinkedIn would show once it is applied. */
export function applyToDoc(doc: Row, p: Row, a: Row, assetUrl: (path: string) => string | null): Row {
  const d: Row = structuredClone(doc ?? {});
  if ('headline' in p) d.headline = p.headline;
  if ('summary' in p) d.summary = p.summary;
  if ('location' in p) d.location = p.location?.postal_code ? `Postal code ${p.location.postal_code}` : `Location ${p.location?.id ?? ''}`.trim();
  if (a.picture_url) d.picture_url = a.picture_url; else if (a.picture) d.picture_url = assetUrl(a.picture) ?? d.picture_url ?? null;
  if (a.cover_url) d.cover_url = a.cover_url; else if (a.cover_picture) d.cover_url = assetUrl(a.cover_picture) ?? d.cover_url ?? null;
  const ym = (v: Row | undefined) => (v?.year ? `${v.year}${v.month ? `-${String(v.month).padStart(2, '0')}` : ''}` : null);
  if (p.experience) {
    const x = p.experience;
    const list: Row[] = Array.isArray(d.experience) ? d.experience : (d.experience = []);
    const e = x.id ? list.find((r) => r.id === x.id) : undefined;
    if (e) {
      if ('description' in x) e.description = x.description ?? null;
      if ('role' in x) e.title = x.role; if ('company' in x) e.company = x.company; if ('location' in x) e.location = x.location;
      if ('skills' in x) e.skills = x.skills ?? [];
    } else {
      list.unshift({ id: x.id ?? `demo-pos-${list.length + 1}`, title: x.role ?? null, company: x.company ?? null, company_id: x.company_id ?? null, start: ym(x.start_date), end: ym(x.end_date), current: !x.end_date, location: x.location ?? null, description: x.description ?? null, skills: x.skills ?? [] });
    }
  }
  if (p.education) {
    const x = p.education;
    const list: Row[] = Array.isArray(d.education) ? d.education : (d.education = []);
    const e = x.id ? list.find((r) => r.id === x.id) : undefined;
    if (e) { if ('description' in x) e.description = x.description ?? null; if ('degree' in x) e.degree = x.degree; if ('field_of_study' in x) e.field = x.field_of_study; }
    else list.unshift({ id: x.id ?? `demo-edu-${list.length + 1}`, school: x.school ?? null, degree: x.degree ?? null, field: x.field_of_study ?? null, start: ym(x.start_date), end: ym(x.end_date), description: x.description ?? null });
  }
  if (Array.isArray(p.skills)) {
    const old = new Map<string, Row>((Array.isArray(d.skills) ? d.skills : []).map((k: Row) => [String(k.name).toLowerCase(), k]));
    const seen = new Set<string>();
    d.skills = p.skills.map((n: string) => String(n).trim()).filter((n: string) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())).map((n: string) => old.get(n.toLowerCase()) ?? { name: n, endorsements: 0 });
  }
  if (p.custom_link?.url) d.websites = [p.custom_link.url];
  return d;
}

// ---------------------------------------------------------------------------
// Scheduling and applying
// ---------------------------------------------------------------------------
/** outreach_profile_schedule: the next slot in the sender's hours, one profile edit a day per sender, one sender an hour per workspace. */
export function scheduleChange(store: DemoStore, ch: Row): string {
  const s = store.get('outreach_senders', ch.sender_id)!;
  const tz = s.timezone ?? 'UTC';
  const edits = store.t('outreach_actions').filter((a) => a.action_type === 'profile_edit' && ['queued', 'reserved', 'sent'].includes(a.status) && a.payload?.change_id !== ch.id);
  const mineDays = new Set(edits.filter((a) => a.sender_id === s.id).map((a) => localParts(simWallClock(store, Date.parse(a.executed_at ?? a.scheduled_for)), tz).day));
  const wsTimes = edits.filter((a) => a.workspace_id === ch.workspace_id && a.status !== 'sent').map((a) => Date.parse(a.scheduled_for));
  const step = 10 * MIN;
  const from = Math.ceil((Date.now() + 3 * MIN) / step) * step;
  let when: number | null = null;
  for (let t = from; t < from + 31 * D; t += step) {
    if (!inHours(store, s, t) || mineDays.has(localParts(simWallClock(store, t), tz).day) || wsTimes.some((x) => Math.abs(x - t) < H)) continue;
    const j = t + store.int(0, 9) * MIN;
    when = inHours(store, s, j) ? j : t;
    break;
  }
  if (when == null) demoError('E_NO_SCHEDULE', 'the sender has no working hours in the next 30 days');
  const at = iso(when);
  const key = `profile:${ch.id}`;
  const existing = store.t('outreach_actions').find((a) => a.idempotency_key === key);
  let actionId: string;
  if (existing) { store.update('outreach_actions', existing.id, { scheduled_for: at, status: 'queued', reserved_at: null }); actionId = existing.id; }
  else {
    actionId = store.insert('outreach_actions', {
      workspace_id: ch.workspace_id, sender_id: s.id, action_type: 'profile_edit', scheduled_for: at, idempotency_key: key, payload: { change_id: ch.id, field_groups: ch.field_groups },
      enrollment_id: null, lead_id: null, node_id: null, variant_id: null, attempt: 1, decision: null, status: 'queued', executed_at: null, reserved_at: null, response: null, error_code: null,
    })[0].id;
  }
  store.update(T.changes, ch.id, { status: 'queued', action_id: actionId, scheduled_for: at, updated_at: store.nowIso() });
  return at;
}

/** outreach_profile_submit_change. */
export function submitChange(ctx: Ctx, changeId: string): Row {
  const store = ctx.store;
  const ch = store.get(T.changes, changeId);
  if (!ch || ch.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Change not found');
  const s = store.get('outreach_senders', ch.sender_id);
  if (!['draft', 'approved'].includes(ch.status)) demoError('E_PROFILE_STATE', `change is ${ch.status} (only drafts can be submitted)`);
  const v = validate(store, s, ch.payload, ch.assets, { change: ch.id, experiment: ch.experiment_id });
  if (!v.ok) { const first = v.causes.find((c: Row) => c.blocking); demoError(first.code, first.detail); }
  const now = store.nowIso();
  if (v.mode === 'propose_only') {
    store.update(T.changes, ch.id, { status: 'awaiting_owner', mode: 'propose_only', submitted_at: now, approval_expires_at: iso(Date.now() + 14 * D), requested_by_email: ch.requested_by_email ?? DEMO_USER_EMAIL, updated_at: now });
    return { id: ch.id, status: 'awaiting_owner', mode: 'propose_only', owner_email: s?.owner_email ?? null };
  }
  store.update(T.changes, ch.id, { status: 'approved', mode: 'direct', submitted_at: now, approved_by_email: ch.approved_by_email ?? DEMO_USER_EMAIL, requested_by_email: ch.requested_by_email ?? DEMO_USER_EMAIL, updated_at: now });
  const at = scheduleChange(store, store.get(T.changes, ch.id)!);
  return { id: ch.id, status: 'queued', mode: 'direct', scheduled_for: at };
}

/** The owner approved a proposal (the demo plays the owner in a fake approval screen). */
export function ownerApprove(store: DemoStore, changeId: string, email: string): string {
  store.update(T.changes, changeId, { status: 'approved', approved_by_email: email, owner_notified_at: store.nowIso(), updated_at: store.nowIso() });
  return scheduleChange(store, store.get(T.changes, changeId)!);
}

export function cancelChange(store: DemoStore, ch: Row, reason: string) {
  if (!PENDING.includes(ch.status)) demoError('E_PROFILE_STATE', `a ${ch.status} change cannot be cancelled`);
  if (ch.action_id) store.update('outreach_actions', (a) => a.id === ch.action_id && (a.status === 'queued' || a.status === 'reserved'), { status: 'cancelled', decision: 'cancel', error_code: 'profile_change_cancelled' });
  store.update(T.changes, ch.id, { status: 'cancelled', cancelled_reason: String(reason).slice(0, 200), updated_at: store.nowIso() });
}

/** Applies one queued change locally: pre / post snapshots, the change marked applied and verified, QA recomputed. */
export function applyChange(store: DemoStore, ch: Row, atMs = Date.now(), assetUrl: (path: string) => string | null = () => null): void {
  const s = store.get('outreach_senders', ch.sender_id);
  if (!s) return;
  const at = iso(atMs);
  const before = latestSnapshot(store, s.id)?.data ?? baselineDoc(store, s);
  const pre = recordSnapshot(store, s, 'pre_change', before, { change: ch.id, at: iso(atMs - MIN) });
  const after = applyToDoc(before, ch.payload ?? {}, ch.assets ?? {}, assetUrl);
  const post = recordSnapshot(store, s, 'post_change', after, { change: ch.id, at });
  const fields = [...Object.keys(ch.payload ?? {}), ...Object.keys(ch.assets ?? {})];
  store.update(T.changes, ch.id, {
    status: 'applied', applied_at: at, verified_at: iso(atMs + 5 * MIN), verify_after: null, applied_fields: fields, failed_fields: {}, pre_snapshot_id: pre.id, post_snapshot_id: post.id,
    owner_notified_at: at, updated_at: at, revert_expires_at: iso(atMs + 30 * D),
  });
  if (ch.action_id) store.update('outreach_actions', ch.action_id, { status: 'sent', executed_at: at, reserved_at: iso(atMs - MIN), response: { ok: true, demo: true } });
  const patch: Row = {};
  if (after.picture_url && after.picture_url !== s.picture_url) patch.picture_url = after.picture_url;
  if (Object.keys(patch).length) store.update('outreach_senders', s.id, patch);
  computeQa(store, store.get('outreach_senders', s.id)!, at);
}

/** Applies every queued change that fell due, and moves experiments along (washout → running → ready). Called before reads. */
export function settleProfiles(store: DemoStore, assetUrl?: (path: string) => string | null): void {
  const now = Date.now();
  const due = store.t(T.changes).filter((c) => c.status === 'queued' && c.scheduled_for && Date.parse(c.scheduled_for) <= now)
    .sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)));
  for (const c of due) {
    const s = store.get('outreach_senders', c.sender_id);
    if (!s || s.deleted_at) continue;
    if (s.status !== 'ok') continue;   // never applied while disconnected; it lands once the sender is back
    applyChange(store, c, Math.max(Date.parse(c.scheduled_for), now - 30 * D), assetUrl);
  }
  // pending approvals and previews expire like outreach_profile_expire
  for (const c of store.t(T.changes)) if (c.status === 'awaiting_owner' && c.approval_expires_at && Date.parse(c.approval_expires_at) < now) store.update(T.changes, c.id, { status: 'cancelled', cancelled_reason: 'approval_expired' });
  for (const e of store.t(T.experiments)) {
    if (e.status === 'washout') {
      const chs = store.t(T.changes).filter((c) => c.experiment_id === e.id);
      if (chs.some((c) => c.status === 'failed' || c.status === 'cancelled')) {
        store.update(T.experiments, e.id, { status: 'abandoned', concluded_at: iso(now), result: { reason: 'A profile change for a participating sender failed or was declined, so the arms are incomplete.' } });
        continue;
      }
      const open = chs.some((c) => PENDING.includes(c.status));
      const last = chs.reduce((m, c) => (c.applied_at ? Math.max(m, Date.parse(c.applied_at)) : m), 0);
      if (!open && last) {
        const until = e.washout_until ?? iso(last + (e.washout_days ?? 3) * D);
        store.update(T.experiments, e.id, Date.parse(until) <= now ? { washout_until: until, status: 'running' } : { washout_until: until });
      }
    } else if (e.status === 'running') {
      const r = experimentResult(store, e);
      store.update(T.experiments, e.id, r.ready ? { result: r, status: 'ready' } : { result: r });
    }
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------
export function revertBuild(store: DemoStore, ch: Row): Row {
  if (!['applied', 'partially_applied'].includes(ch.status)) demoError('E_PROFILE_STATE', `only an applied change can be reverted (this one is ${ch.status})`);
  const pre = ch.pre_snapshot_id ? store.get(T.snapshots, ch.pre_snapshot_id) : undefined;
  const d: Row = pre?.data ?? {};
  const prev = store.t(T.changes).filter((c) => c.sender_id === ch.sender_id && ['applied', 'partially_applied'].includes(c.status) && c.applied_at && c.applied_at < ch.applied_at)
    .sort((a, b) => String(b.applied_at).localeCompare(String(a.applied_at)))[0];
  const payload: Row = {}; const assets: Row = {}; const fields: Row[] = []; const unrec: Row[] = [];
  const full = (key: string) => fields.push({ key, fidelity: 'full', note: 'Restored from the snapshot taken before the change' });
  for (const k of Object.keys(ch.payload ?? {})) {
    const v = ch.payload[k];
    if (k === 'headline' || k === 'summary') {
      if (d[k] != null) { payload[k] = d[k]; full(k); } else unrec.push({ key: k, why: k === 'headline' ? 'No snapshot of the previous headline' : 'No snapshot of the previous About section' });
    } else if (k === 'experience' || k === 'education') {
      if (v?.id) {
        const entry = (d[k] ?? []).find((e: Row) => e.id === v.id);
        if (entry) {
          payload[k] = k === 'experience'
            ? Object.fromEntries(Object.entries({ id: entry.id, description: 'description' in v ? entry.description ?? '' : undefined, role: 'role' in v ? entry.title : undefined, location: 'location' in v ? entry.location : undefined, skills: 'skills' in v ? entry.skills : undefined }).filter(([, x]) => x !== undefined))
            : Object.fromEntries(Object.entries({ id: entry.id, description: 'description' in v ? entry.description ?? '' : undefined, degree: 'degree' in v ? entry.degree : undefined, field_of_study: 'field_of_study' in v ? entry.field : undefined }).filter(([, x]) => x !== undefined));
          full(k);
        } else unrec.push({ key: k, why: k === 'experience' ? 'The previous state of this position was not in the snapshot' : 'The previous state of this entry was not in the snapshot' });
      } else unrec.push({ key: k, why: k === 'experience' ? 'A position that was added cannot be removed through the connector. Remove it on LinkedIn.' : 'An education entry that was added cannot be removed through the connector. Remove it on LinkedIn.' });
    } else if (k === 'skills') {
      if (Array.isArray(d.skills)) { payload.skills = d.skills.map((x: Row) => x.name ?? String(x)); full('skills'); } else unrec.push({ key: k, why: 'No snapshot of the previous skills' });
    } else if (k === 'location') {
      const pv = prev?.payload?.location;
      if (pv) { payload.location = pv; fields.push({ key: 'location', fidelity: 'written_only', note: 'Restored to the location the platform last wrote. LinkedIn reports the location as text, not as the id the edit needs.' }); }
      else unrec.push({ key: 'location', why: `The previous location ("${d.location ?? 'unknown'}") was never written by the platform, so its id is unknown. Set it on LinkedIn.` });
    } else if (['picture_settings', 'cover_picture_settings', 'custom_link', 'skills_follow'].includes(k)) {
      const pv = prev?.payload?.[k];
      if (pv !== undefined) { payload[k] = pv; fields.push({ key: k, fidelity: 'written_only', note: 'Restored to the value the platform last wrote. If it was changed on LinkedIn since, that state cannot be recovered.' }); }
      else unrec.push({ key: k, why: 'LinkedIn does not report this field and the platform never wrote it before, so there is nothing to restore it to' });
    }
  }
  for (const k of Object.keys(ch.assets ?? {})) {
    if (k === 'picture' || k === 'picture_url') {
      if (prev?.assets?.picture) { assets.picture = prev.assets.picture; fields.push({ key: 'picture', fidelity: 'full', note: 'The previous photo was uploaded through the platform and is kept' }); }
      else if (d.picture_url) { assets.picture_url = d.picture_url; fields.push({ key: 'picture', fidelity: 'partial', note: "The previous photo is restored from its URL; LinkedIn's crop and filter state cannot be restored" }); }
      else unrec.push({ key: 'picture', why: 'No record of the previous photo' });
    } else if (k === 'cover_picture' || k === 'cover_url') {
      if (prev?.assets?.cover_picture) { assets.cover_picture = prev.assets.cover_picture; fields.push({ key: 'cover_picture', fidelity: 'full', note: 'The previous cover was uploaded through the platform and is kept' }); }
      else if (d.cover_url) { assets.cover_url = d.cover_url; fields.push({ key: 'cover_picture', fidelity: 'partial', note: 'The previous cover is restored from its URL; the crop state cannot be restored' }); }
      else unrec.push({ key: 'cover_picture', why: 'No record of the previous cover image' });
    }
  }
  return { change_id: ch.id, payload, assets, fields, unrecoverable: unrec, possible: Object.keys(payload).length > 0 || Object.keys(assets).length > 0, pre_snapshot_id: ch.pre_snapshot_id ?? null };
}

export function newChange(store: DemoStore, s: Row, o: Row): Row {
  return store.insert(T.changes, {
    workspace_id: s.workspace_id, sender_id: s.id, field_groups: groupsOf(o.payload ?? {}, o.assets ?? {}), payload: o.payload ?? {}, assets: o.assets ?? {}, source: o.source ?? 'manual',
    template_id: o.template_id ?? null, experiment_id: o.experiment_id ?? null, bulk_run_id: o.bulk_run_id ?? null, reverts_change_id: o.reverts_change_id ?? null,
    status: o.status ?? 'draft', mode: o.mode ?? null, pre_snapshot_id: null, post_snapshot_id: null, applied_fields: [], failed_fields: {}, action_id: null, scheduled_for: null,
    requested_by: DEMO_USER_ID, requested_by_email: o.requested_by_email ?? DEMO_USER_EMAIL, approved_by_email: null, approval_expires_at: null, revert_expires_at: null,
    owner_notified_at: null, verify_after: null, verified_at: null, error_code: null, note: o.note ? String(o.note).slice(0, 500) : null, submitted_at: null, applied_at: null,
    reverted_at: null, cancelled_reason: null, created_at: o.created_at ?? store.nowIso(), updated_at: o.created_at ?? store.nowIso(),
  })[0];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export function renderText(text: string, vars: Row): string {
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:\|([^}]*))?\}\}/g, (_m, key: string, fb?: string) => {
    const v = key.startsWith('custom.') ? vars.custom?.[key.slice(7)] : vars[key];
    const s = v == null ? '' : String(v).trim();
    return s || String(fb ?? '').trim();
  });
}
export function renderJson(v: unknown, vars: Row): unknown {
  if (typeof v === 'string') return renderText(v, vars);
  if (Array.isArray(v)) return v.map((x) => renderJson(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, renderJson(x, vars)]));
  return v;
}
export function senderVars(store: DemoStore, s: Row): Row {
  const d: Row = latestSnapshot(store, s.id)?.data ?? {};
  const exp: Row[] = Array.isArray(d.experience) ? d.experience : [];
  const cur = exp.find((e) => e.current) ?? exp[0];
  const name = String(s.display_name ?? '');
  const out: Row = {
    first_name: name.split(' ')[0] || undefined, last_name: name.replace(/^\S+\s*/, '') || undefined, full_name: s.display_name ?? undefined, headline: d.headline ?? undefined,
    company: cur?.company ?? undefined, title: cur?.title ?? undefined, client: s.client_id ? store.get('outreach_clients', s.client_id)?.name : undefined, location: d.location ?? undefined,
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const r = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-(z * z) / 2) * (0.319381530 * t - 0.356563782 * t ** 2 + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5);
  return z < 0 ? 1 - r : r;
}
const r1 = (x: number) => Math.round(x * 10) / 10;

/** outreach_profile_experiment_result: acceptance per arm from invitations sent after the washout. */
export function experimentResult(store: DemoStore, e: Row): Row {
  const now = Date.now();
  const from = e.washout_until ? Date.parse(e.washout_until) : null;
  const arms: Row[] = [];
  for (const v of e.variants as Row[]) {
    const senders = (e.sender_ids as string[]).filter((sid) => e.assignment?.[sid] === v.key);
    let resolved = 0, accepted = 0, pending = 0, last: number | null = null;
    if (from != null) {
      for (const st of store.t('outreach_lead_sender_state')) {
        if (!senders.includes(st.sender_id) || !st.invite_sent_at) continue;
        const t = Date.parse(st.invite_sent_at);
        if (t <= from) continue;
        if (last == null || t > last) last = t;
        if (st.invite_accepted_at) { accepted++; resolved++; } else if (t < now - 14 * D) resolved++; else pending++;
      }
    }
    arms.push({ key: v.key, senders: senders.length, resolved, accepted, pending, rate: resolved > 0 ? r1((100 * accepted) / resolved) : null, last_invite_at: last != null ? iso(last) : null });
  }
  const minSenders = Math.min(...arms.map((a) => a.senders));
  const warnings: Row[] = [];
  if (minSenders < 2) warnings.push({ code: 'confounded', text: 'With fewer than 2 senders in an arm, the sender and the variant are the same thing: no number can separate them. Add senders.' });
  if (minSenders < 5) warnings.push({ code: 'cluster', text: 'Fewer than 5 senders per arm: differences between the people (their networks, seniority, existing connections) are likely larger than the effect of the variant, and the interval below understates the uncertainty.' });
  const [A, B] = arms;
  let comparison: Row | null = null;
  let verdict: string;
  let need: number | null = null;
  let pa = 0, pb = 0, diff = 0, lo = 0, hi = 0;
  if (A && B && A.resolved >= 20 && B.resolved >= 20 && minSenders >= 2) {
    pa = A.accepted / A.resolved; pb = B.accepted / B.resolved; diff = pb - pa;
    const se = Math.sqrt((pa * (1 - pa)) / A.resolved + (pb * (1 - pb)) / B.resolved);
    lo = diff - 1.96 * se; hi = diff + 1.96 * se;
    const pbar = (A.accepted + B.accepted) / (A.resolved + B.resolved);
    const z = pbar === 0 || pbar === 1 ? 0 : diff / Math.sqrt(pbar * (1 - pbar) * (1 / A.resolved + 1 / B.resolved));
    const p = 2 * (1 - phi(Math.abs(z)));
    need = Math.abs(diff) < 0.005 ? null : Math.ceil((2 * 7.84 * pbar * (1 - pbar)) / (diff * diff));
    verdict = lo > 0 ? 'b_better' : hi < 0 ? 'a_better' : 'not_conclusive';
    comparison = { a: A.key, b: B.key, rate_a: r1(100 * pa), rate_b: r1(100 * pb), difference_points: r1(100 * diff), ci_low: r1(100 * lo), ci_high: r1(100 * hi), p_value: Math.round(p * 1000) / 1000, required_per_variant: need };
  } else verdict = minSenders < 2 ? 'insufficient_senders' : 'insufficient_data';
  const allResolved = arms.every((a) => a.resolved >= (e.min_invites_per_variant ?? 120));
  const lastInvite = arms.reduce((m, a) => (a.last_invite_at ? Math.max(m, Date.parse(a.last_invite_at)) : m), 0);
  const ready = allResolved || (!!lastInvite && lastInvite < now - 14 * D && !!A && !!B && A.resolved >= 20 && B.resolved >= 20);
  const summary = verdict === 'insufficient_senders' ? 'Every arm needs at least 2 senders before a number means anything.'
    : verdict === 'insufficient_data' ? `Not enough resolved invitations yet (need 20 per variant to compare, ${e.min_invites_per_variant ?? 120} to conclude).`
      : `Variant ${B.key} accepted at ${r1(100 * pb)}% (${B.accepted}/${B.resolved}) against ${A.key}'s ${r1(100 * pa)}% (${A.accepted}/${A.resolved}). Difference ${diff >= 0 ? '+' : ''}${r1(100 * diff)} points, 95% CI ${r1(100 * lo)} to ${r1(100 * hi)}. `
        + (verdict === 'not_conclusive' ? `Not conclusive: the interval crosses zero.${need != null ? ` To detect a ${Math.round(100 * Math.abs(diff))}-point difference reliably you would need roughly ${need} resolved invitations per variant.` : ''}`
          : `${verdict === 'b_better' ? B.key : A.key} did better and the interval excludes zero.`);
  return { experiment_id: e.id, status: e.status, metric: e.metric ?? 'acceptance_rate', field_group: e.field_group, washout_until: e.washout_until ?? null, arms, comparison, verdict, ready, warnings, summary };
}

export function experimentPayload(e: Row, value: unknown): { payload: Row; assets: Row } {
  if (e.field_group === 'headline') return { payload: { headline: typeof value === 'string' ? value : String((value as Row)?.toString?.() ?? '') }, assets: {} };
  if (e.field_group === 'about') return { payload: { summary: typeof value === 'string' ? value : String(value ?? '') }, assets: {} };
  const v = (value ?? {}) as Row;
  return { payload: v.payload ?? {}, assets: v.assets ?? {} };
}

export const tokenHex = (store: DemoStore) => randomHex(store, 24);
