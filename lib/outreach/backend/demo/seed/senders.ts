/** Demo seed: Profile Studio data, tracking domains, channel reference rows, a few more sender events. */
import type { DemoStore, Row } from '../store';
import { MEMBER, SENDER } from './ids';
import { addEvent, CHANNEL_CAPS, CHANNEL_TOTALS } from '../senders/util';
import { applyChange, computeQa, experimentResult, latestSnapshot, newChange, recordSnapshot, scheduleChange, T } from '../senders/profile';

const D = 86_400_000;
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Reference rows other screens read (025 / 022) when the core seed has not written them. */
function seedReferenceRows(s: DemoStore) {
  if (!s.t('outreach_channel_capabilities').length) s.insert('outreach_channel_capabilities', CHANNEL_CAPS.map((c) => structuredClone(c)), { noId: true, silent: true });
  if (!s.t('outreach_channel_totals').length) {
    for (const [provider, levels] of Object.entries(CHANNEL_TOTALS)) levels.forEach((per_day, level) => s.insert('outreach_channel_totals', { provider, level, per_day }, { noId: true, silent: true }));
  }
  // a profile edit is one action from the daily ledger; level 0 cannot edit (022)
  if (!s.t('outreach_platform_ceilings').some((c) => c.provider === 'LINKEDIN' && c.action_type === 'profile_edit')) s.insert('outreach_platform_ceilings', { provider: 'LINKEDIN', action_type: 'profile_edit', per_day: 1, per_week: 4 }, { noId: true, silent: true });
  if (!s.t('outreach_warmup_caps').some((w) => w.provider === 'LINKEDIN' && w.action_type === 'profile_edit')) [0, 1, 1, 1, 1, 1].forEach((per_day, level) => s.insert('outreach_warmup_caps', { provider: 'LINKEDIN', level, action_type: 'profile_edit', per_day }, { noId: true, silent: true }));
}

function doc(o: Row): Row {
  return {
    headline: null, summary: null, location: null, picture_url: null, cover_url: null, first_name: null, last_name: null, public_identifier: null, connections_count: null, follower_count: null,
    experience: [], education: [], skills: [], languages: ['English'], certifications: [], projects: [], websites: [],
    fetched_sections: ['headline', 'about', 'experience', 'education', 'skills'], fetched_at: null, ...o,
  };
}

const ABOUT_A = 'I run growth at Northwind Growth, where we help B2B software teams book more first meetings without adding headcount.\n\n'
  + 'Last year our programmes booked over 900 first calls for 40 clients, from seed-stage founders to 300-person sales teams. Every campaign is written by a person and reviewed weekly.\n\n'
  + 'If your pipeline depends on a few referrals, send me a message. I am happy to share what worked for teams like yours.';
const ABOUT_B = 'I started my career cold-calling from a spreadsheet, and I still remember how few of those calls felt useful to the person on the other end.\n\n'
  + 'At Northwind Growth I build outbound that people are glad to receive: short, specific notes to the right person at the right moment.\n\n'
  + 'If you want outreach your prospects actually answer, I would like to hear what you are working on.';

function apply(s: DemoStore, senderId: string, payload: Row, o: { at: number; source?: string; template_id?: string | null; experiment_id?: string | null; note?: string | null; by?: string }) {
  const sender = s.get('outreach_senders', senderId)!;
  const ch = newChange(s, sender, { payload, source: o.source ?? 'manual', template_id: o.template_id ?? null, experiment_id: o.experiment_id ?? null, note: o.note ?? null, created_at: iso(o.at - 26 * H), requested_by_email: o.by });
  s.update(T.changes, ch.id, { status: 'approved', mode: 'direct', submitted_at: iso(o.at - 25 * H), approved_by_email: o.by ?? ch.requested_by_email, scheduled_for: iso(o.at), updated_at: iso(o.at - 25 * H) });
  applyChange(s, s.get(T.changes, ch.id)!, o.at);
  return ch.id;
}

export function seedSenders(s: DemoStore, now: number): void {
  seedReferenceRows(s);

  // ---------------------------------------------------------------- tracking domain (workspace default, verified)
  const ws = s.get('outreach_senders', SENDER.li_maya)?.workspace_id;
  s.insert('outreach_tracking_domains', {
    workspace_id: ws, sender_id: null, hostname: 'track.northwind.example.com', status: 'active', cname_target: 'track.links.example.com',
    checked_at: iso(now - 2 * H), approved_at: iso(now - 18 * D), note: null, created_by: MEMBER.maya, created_at: iso(now - 25 * D),
  }, { silent: true });

  // ---------------------------------------------------------------- Profile Studio
  const maya = s.get('outreach_senders', SENDER.li_maya)!;
  const sam = s.get('outreach_senders', SENDER.li_sam)!;
  const mayaEmail = maya.owner_email;
  const samEmail = sam.owner_email;

  const mayaExp = [
    { id: 'demo-pos-maya-1', title: 'Head of Growth', company: 'Northwind Growth', company_id: null, start: '2022-04', end: null, current: true, location: 'New York, United States', description: 'Lead a team of six running LinkedIn and email programmes for B2B software companies. Own pipeline reporting and the playbook every client campaign starts from.', skills: ['Demand generation', 'Team leadership'] },
    { id: 'demo-pos-maya-2', title: 'Senior Growth Manager', company: 'Brightloop Analytics', company_id: null, start: '2018-09', end: '2022-03', current: false, location: 'Boston, Massachusetts', description: 'Built the outbound function from zero to 30% of new pipeline.', skills: ['B2B sales'] },
  ];
  const mayaEdu = [{ id: 'demo-edu-maya-1', school: 'Northgate Business School', degree: 'MBA', field: 'Marketing', start: '2016', end: '2018', description: null }];
  const mayaSkills = ['Go-to-market strategy', 'Demand generation', 'B2B sales', 'Team leadership'].map((name, i) => ({ name, endorsements: 40 - i * 7 }));
  recordSnapshot(s, maya, 'baseline', doc({
    picture_url: maya.picture_url,
    headline: 'Head of Growth at Northwind Growth', summary: 'Growth lead at Northwind Growth. Outbound, partnerships and pipeline.', location: 'New York, United States',
    first_name: 'Maya', last_name: 'Chen', public_identifier: maya.public_identifier, connections_count: (maya.connections_count ?? 3400) - 90, follower_count: 3810,
    experience: mayaExp, education: mayaEdu, skills: mayaSkills, cover_url: null,
  }), { at: iso(now - 50 * D) });

  const samExp = [
    { id: 'demo-pos-sam-1', title: 'Sales Director', company: 'Northwind Growth', company_id: null, start: '2021-01', end: null, current: true, location: 'Chicago, Illinois', description: null, skills: ['Negotiation'] },
    { id: 'demo-pos-sam-2', title: 'Account Executive', company: 'Glasshouse CRM', company_id: null, start: '2017-06', end: '2020-12', current: false, location: 'Chicago, Illinois', description: 'Closed mid-market deals across North America.', skills: [] },
  ];
  // Maya: a sharper headline (manual), 45 days ago
  apply(s, maya.id, { headline: 'Head of Growth at Northwind Growth | I help B2B software teams book more first meetings with outbound that sounds human' }, { at: now - 45 * D, by: mayaEmail, note: 'Say who we help, not just the title' });
  recordSnapshot(s, sam, 'baseline', doc({
    picture_url: sam.picture_url,
    headline: 'Sales Director at Northwind Growth', summary: null, location: 'Chicago, Illinois', first_name: 'Sam', last_name: 'Okafor', public_identifier: sam.public_identifier,
    connections_count: (sam.connections_count ?? 5100) - 120, follower_count: 5480, experience: samExp,
    education: [{ id: 'demo-edu-sam-1', school: 'Hillcrest University', degree: 'BSc', field: 'Business Administration', start: '2012', end: '2016', description: null }],
    skills: ['Negotiation', 'Pipeline management', 'B2B sales'].map((name, i) => ({ name, endorsements: 25 - i * 6 })),
  }), { at: iso(now - 40 * D) });

  // A finished experiment on the About section: proof-first (A) against story-first (B)
  const expSenders = [SENDER.li_maya, SENDER.li_paused, SENDER.li_sam, SENDER.li_reconnect];
  const assignment: Row = { [SENDER.li_maya]: 'A', [SENDER.li_paused]: 'A', [SENDER.li_sam]: 'B', [SENDER.li_reconnect]: 'B' };
  const exp = s.insert(T.experiments, {
    workspace_id: ws, name: 'About: proof first or story first', field_group: 'about', variants: [{ key: 'A', value: ABOUT_A }, { key: 'B', value: ABOUT_B }],
    sender_ids: expSenders, assignment, metric: 'acceptance_rate', washout_days: 3, min_invites_per_variant: 120, status: 'washout', started_at: iso(now - 36 * D),
    washout_until: null, concluded_at: null, result: null, notes: [], created_by: MEMBER.maya, created_at: iso(now - 37 * D),
  }, { silent: true })[0];
  expSenders.forEach((sid, i) => apply(s, sid, { summary: assignment[sid] === 'A' ? ABOUT_A : ABOUT_B }, { at: now - 35 * D + i * 5 * H, source: 'experiment', experiment_id: exp.id, by: mayaEmail, note: `Experiment "${exp.name}", variant ${assignment[sid]}` }));
  s.update(T.experiments, exp.id, { status: 'running', washout_until: iso(now - 35 * D + 15 * H + 3 * D) }, { silent: true });
  s.update(T.experiments, exp.id, (e) => ({ status: 'concluded', concluded_at: iso(now - 9 * D), result: { ...experimentResult(s, e), status: 'concluded' } }), { silent: true });

  // Sam: headline rewrite, 28 days ago
  apply(s, sam.id, { headline: 'Sales Director at Northwind Growth | Outbound programmes for agencies and SaaS teams across North America' }, { at: now - 28 * D, by: samEmail });

  // One template, applied to Maya 12 days ago (headline + skills)
  const tpl = s.insert(T.templates, {
    workspace_id: ws, client_id: null, name: 'Northwind team profile', field_groups: ['headline', 'skills'],
    body: { headline: '{{title|Growth}} at Northwind Growth | Helping {{custom.audience|B2B software teams}} book more first meetings', skills: ['Go-to-market strategy', 'Demand generation', 'B2B sales', 'Pipeline management', 'Revenue operations', 'Team leadership'] },
    variables: {}, created_by: MEMBER.maya, updated_by: MEMBER.maya, created_at: iso(now - 20 * D), updated_at: iso(now - 14 * D),
  }, { silent: true })[0];
  apply(s, maya.id, { headline: 'Head of Growth at Northwind Growth | Helping B2B software teams book more first meetings', skills: tpl.body.skills }, { at: now - 12 * D, source: 'template', template_id: tpl.id, by: mayaEmail });

  // Latest reads (the weekly drift check), 3 days ago
  for (const snd of [maya, sam]) {
    const last = latestSnapshot(s, snd.id)!;
    recordSnapshot(s, snd, 'drift_check', { ...last.data, connections_count: snd.connections_count }, { at: iso(now - 3 * D) });
    computeQa(s, s.get('outreach_senders', snd.id)!, iso(now - 3 * D));
  }

  // Pending: Maya's booking link, scheduled in her next working hours; Sam's AI-written headline waiting as a draft
  const link = newChange(s, s.get('outreach_senders', maya.id)!, { payload: { custom_link: { type: 'WEBSITE', url: 'https://example.com/book/northwind', display_on: 'PROFILE_ONLY' } }, source: 'manual', note: 'Booking page on the profile', created_at: iso(now - 5 * H), requested_by_email: mayaEmail });
  s.update(T.changes, link.id, { status: 'approved', mode: 'direct', submitted_at: iso(now - 5 * H), approved_by_email: mayaEmail });
  scheduleChange(s, s.get(T.changes, link.id)!);
  newChange(s, s.get('outreach_senders', sam.id)!, { payload: { headline: 'I help agencies and SaaS teams fill their calendars with first calls | Sales Director, Northwind Growth' }, source: 'ai_draft', note: 'AI draft. Brief: shorter, lead with the outcome', created_at: iso(now - 20 * H), requested_by_email: samEmail });

  // Authority: Maya granted herself direct edits; Sam accepted a permission link for his headline
  for (const g of ['headline', 'about']) s.insert(T.authority, { workspace_id: ws, sender_id: maya.id, field_group: g, mode: 'direct', granted_by_email: mayaEmail, granted_via: 'owner_is_operator', evidence: { user_id: MEMBER.maya }, granted_at: iso(now - 50 * D), expires_at: null, revoked_at: null, revoked_reason: null, revoked_by: null }, { silent: true });
  const lk = s.insert(T.links, { workspace_id: ws, sender_id: sam.id, token_hash: 'demo-link-sam-0001', field_groups: ['headline'], mode: 'direct', owner_email: samEmail, expires_at: iso(now - 33 * D), grant_days: null, accepted_at: iso(now - 39 * D), declined_at: null, evidence: { demo: true }, created_by: MEMBER.maya, created_at: iso(now - 40 * D) }, { silent: true })[0];
  s.insert(T.authority, { workspace_id: ws, sender_id: sam.id, field_group: 'headline', mode: 'direct', granted_by_email: samEmail, granted_via: 'signed_link', evidence: { link_id: lk.id }, granted_at: iso(now - 39 * D), expires_at: null, revoked_at: null, revoked_reason: null, revoked_by: null }, { silent: true });

  // ---------------------------------------------------------------- more sender history (Events tab, insights)
  const extra: Array<[string, string, Row, number]> = [
    [SENDER.li_maya, 'schedule', { timezone: 'America/New_York', schedule: maya.schedule }, 100],
    [SENDER.li_maya, 'caps', { invite: 30 }, 75],
    [SENDER.li_maya, 'caps', {}, 41],
    [SENDER.li_maya, 'health', { from: 91, to: 94, breakdown: maya.health_breakdown }, 8],
    [SENDER.li_sam, 'proxy', { from: 'CA', to: 'US' }, 95],
    [SENDER.li_sam, 'health', { from: 93, to: 89, breakdown: sam.health_breakdown }, 5],
    [SENDER.li_priya_warm, 'schedule', { timezone: 'America/New_York', schedule: maya.schedule }, 8],
    [SENDER.li_reconnect, 'health', { from: 78, to: 64, breakdown: { acceptance: 70, pending: 60, rejects: 90, activity: 40 } }, 1],
    [SENDER.whatsapp, 'quiet_period', { hours: 24, from_status: 'connecting' }, 60],
    [SENDER.instagram, 'warmup', { from: 2, to: 3 }, 21],
  ];
  for (const [sid, kind, data, days] of extra) addEvent(s, sid, kind, data, iso(now - days * D));
}
