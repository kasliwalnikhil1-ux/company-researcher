/**
 * The core of the demo workspace: the workspace and its team, clients, senders, lists / tags / stages, 400 leads with
 * profiles, six sequences, and 60 days of history played through the demo engine (so every count is a real count).
 * Every row is fictional (seed/names.ts). Dates are relative to "now".
 */
import { autoLayout } from '../../../graphLayout';
import { findTemplate } from '../../../templates';
import { NODE_CATALOG } from '../../../nodes';
import type { Graph, GraphNode, NodeType } from '../../../types';
import { Engine } from '../sim/engine';
import { idFrom, type DemoStore, type Row } from '../store';
import { CLIENT, DEMO_USER_EMAIL, DEMO_WS_ID, LIST, MEMBER, SALT, SENDER, SEQ, STAGE, TAG, leadId } from './ids';
import { COMPANIES, FIRST_NAMES, LAST_NAMES, LOCATIONS, POST_TOPICS, SCHOOLS, SKILLS, TITLES, slug } from './names';

const D = 86_400_000;
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

export const LEAD_COUNT = 400;

// Working hours of the demo senders. A short weekend window keeps "Skip a day" (and a visitor arriving at the weekend)
// from landing on a day with no sending at all.
const WEEKDAYS: Row = { mon: [['08:00', '18:00']], tue: [['08:00', '18:00']], wed: [['08:00', '18:00']], thu: [['08:00', '18:00']], fri: [['08:00', '17:00']], sat: [['10:00', '14:00']], sun: [['10:00', '14:00']] };

// ---------------------------------------------------------------------------
export function seedWorkspace(s: DemoStore, now: number) {
  s.insert('outreach_workspaces', {
    id: DEMO_WS_ID, name: 'Northwind Growth', slug: 'northwind-growth', plan: 'scale', stripe_customer_id: 'cus_demo', stripe_subscription_id: 'sub_demo',
    stripe_status: 'active', past_due_since: null, trial_ends_at: null, created_by: MEMBER.maya, created_at: iso(now - 210 * D), deleted_at: null,
    settings: {
      timezone: 'America/New_York', recruiter_enabled: false, ai_auto_send: false, create_leads_from_inbound: true, cookie_mode_opt_in: true,
      track_replies: true, profile_owner_approval: false, default_booking_link: 'https://example.com/book/northwind',
    },
  });
  const members: Array<[string, string, string, string, string[]]> = [
    [MEMBER.maya, 'owner', 'Maya Chen', DEMO_USER_EMAIL, []],
    [MEMBER.sam, 'manager', 'Sam Okafor', 'sam.okafor@example.com', []],
    [MEMBER.priya, 'member', 'Priya Lindqvist', 'priya.lindqvist@example.com', []],
    [MEMBER.leo, 'member', 'Leo Moreau', 'leo.moreau@example.com', [CLIENT.orchard]],
  ];
  members.forEach(([user_id, role, display_name, email, client_ids], i) => s.insert('outreach_members', {
    workspace_id: DEMO_WS_ID, user_id, role, display_name, email, client_ids, can_reply: true, created_at: iso(now - (200 - i * 30) * D),
  }));
  s.insert('outreach_invitations', {
    workspace_id: DEMO_WS_ID, email: 'jordan.ashford@example.com', role: 'member', client_ids: [], token: 'demo-invite-token', expires_at: iso(now + 5 * D),
    accepted_at: null, invited_by: MEMBER.maya, created_at: iso(now - 2 * D),
  });
  const clients: Array<[string, string, string, string]> = [
    [CLIENT.lumen, 'Lumenfield Labs', 'lumenfield-labs', 'Europe/London'],
    [CLIENT.orchard, 'Orchard Lane Dental', 'orchard-lane-dental', 'America/Chicago'],
    [CLIENT.bluecairn, 'Bluecairn Logistics', 'bluecairn-logistics', 'America/New_York'],
  ];
  clients.forEach(([id, name, sl, timezone], i) => s.insert('outreach_clients', { id, workspace_id: DEMO_WS_ID, name, slug: sl, timezone, settings: {}, created_at: iso(now - (150 - i * 20) * D) }));
}

// ---------------------------------------------------------------------------
function sender(id: string, o: Partial<Row>, now: number): Row {
  return {
    id, workspace_id: DEMO_WS_ID, client_id: null, owner_user_id: MEMBER.maya, owner_email: DEMO_USER_EMAIL, provider: 'LINKEDIN', unipile_account_id: `demo-acc-${id.slice(-4)}`,
    previous_unipile_account_id: null, disconnected_at: null, billing_paused_at: null, auth_method: 'credentials', display_name: 'Demo Sender', label: null,
    public_identifier: null, provider_user_id: `demo-${id.slice(-6)}`, picture_url: null, is_premium: false, has_sales_nav: false, has_recruiter: false,
    connections_count: 1200, status: 'ok', status_reason: null, deleted_at: null, proxy_country: 'US', user_agent: null, timezone: 'America/New_York',
    schedule: WEEKDAYS, warmup_level: 4, warmup_locked_until: null, health_score: 92, health_breakdown: { acceptance: 95, pending: 90, rejects: 100, activity: 88 },
    manual_caps: {}, rejects_1h: 0, paused_until: null, invite_blocked_until: null, reconnect_attempts: 0, connected_at: iso(now - 120 * D), last_ok_at: iso(now - 10 * 60_000),
    last_disconnect_at: null, last_synced_at: iso(now - 15 * 60_000), extension_token_issued_at: null, running_dry_at: null, alert_emails: [], booking_link: 'https://example.com/book/northwind',
    signature: null, bcc_address: null, parent_sender_id: null, monthly_cost: 79, track_replies: null, enrich_empty_streak: 0, enrich_backoff_until: null,
    profile_qa_score: 78, profile_identity_unverified: false, profile_snapshot_at: iso(now - 3 * D), outreach_allowed_from: null, provider_warning: null,
    account_age_attested_at: null, account_age_attested_by: null, account_age_months: null, created_at: iso(now - 120 * D), updated_at: iso(now - D),
    ...o,
  };
}

export function seedSenders(s: DemoStore, now: number) {
  s.insert('outreach_senders', [
    sender(SENDER.li_maya, { display_name: 'Maya Chen', public_identifier: 'demo-maya-chen', is_premium: true, connections_count: 3412, health_score: 94 }, now),
    sender(SENDER.li_sam, { display_name: 'Sam Okafor', owner_user_id: MEMBER.sam, owner_email: 'sam.okafor@example.com', public_identifier: 'demo-sam-okafor', has_sales_nav: true, is_premium: true, monthly_cost: 129, connections_count: 5120, health_score: 89, label: 'Sam (Sales Navigator)' }, now),
    sender(SENDER.li_priya_warm, { display_name: 'Priya Lindqvist', owner_user_id: MEMBER.priya, owner_email: 'priya.lindqvist@example.com', public_identifier: 'demo-priya-lindqvist', warmup_level: 1, connections_count: 410, health_score: 81, connected_at: iso(now - 9 * D), created_at: iso(now - 9 * D), warmup_locked_until: iso(now + 4 * D) }, now),
    sender(SENDER.li_reconnect, { display_name: 'Leo Moreau', owner_user_id: MEMBER.leo, owner_email: 'leo.moreau@example.com', client_id: CLIENT.orchard, public_identifier: 'demo-leo-moreau', status: 'credentials', status_reason: 'LinkedIn asked to sign in again', health_score: 64, last_disconnect_at: iso(now - 7 * H), last_ok_at: iso(now - 8 * H), reconnect_attempts: 1 }, now),
    sender(SENDER.li_paused, { display_name: 'Nadia Haddad', owner_email: 'nadia.haddad@example.com', client_id: CLIENT.lumen, public_identifier: 'demo-nadia-haddad', status: 'paused', status_reason: 'Paused by Maya Chen', paused_until: null, health_score: 86, timezone: 'Europe/London' }, now),
    sender(SENDER.gmail, { provider: 'GMAIL', monthly_cost: 6, auth_method: 'oauth', display_name: 'Maya Chen', owner_email: 'maya@northwind.example.com', public_identifier: null, connections_count: null, parent_sender_id: SENDER.li_maya, signature: '<p>Maya Chen<br/>Northwind Growth</p>', health_score: 97 }, now),
    sender(SENDER.outlook, { provider: 'OUTLOOK', monthly_cost: 6, auth_method: 'oauth', display_name: 'Sam Okafor', owner_user_id: MEMBER.sam, owner_email: 'sam@northwind.example.com', public_identifier: null, connections_count: null, parent_sender_id: SENDER.li_sam, health_score: 95 }, now),
    sender(SENDER.whatsapp, { provider: 'WHATSAPP', monthly_cost: 25, auth_method: 'credentials', display_name: 'Northwind (WhatsApp)', public_identifier: '+15550100', connections_count: null, warmup_level: 3, account_age_months: 26, account_age_attested_at: iso(now - 40 * D), account_age_attested_by: MEMBER.maya, health_score: 90 }, now),
    sender(SENDER.instagram, { provider: 'INSTAGRAM', monthly_cost: 19, auth_method: 'credentials', display_name: 'northwind.growth', public_identifier: 'northwind.growth', connections_count: 2310, warmup_level: 3, health_score: 88 }, now),
  ]);
  const events: Array<[string, string, Row, number]> = [
    [SENDER.li_maya, 'status', { from: 'connecting', to: 'ok' }, 120],
    [SENDER.li_maya, 'warmup', { from: 3, to: 4 }, 40],
    [SENDER.li_sam, 'status', { from: 'connecting', to: 'ok' }, 110],
    [SENDER.li_priya_warm, 'status', { from: 'connecting', to: 'ok' }, 9],
    [SENDER.li_priya_warm, 'warmup', { from: 0, to: 1 }, 2],
    [SENDER.li_reconnect, 'status', { from: 'ok', to: 'credentials', reason: 'LinkedIn asked to sign in again' }, 0.3],
    [SENDER.li_paused, 'status', { from: 'ok', to: 'paused', by: 'Maya Chen' }, 6],
    [SENDER.whatsapp, 'status', { from: 'connecting', to: 'ok' }, 60],
    [SENDER.instagram, 'status', { from: 'connecting', to: 'ok' }, 70],
  ];
  events.forEach(([sender_id, kind, data, daysAgo], i) => s.insert('outreach_sender_events', { id: i + 1, sender_id, kind, data, at: iso(now - daysAgo * D) }, { noId: true }));
}

// ---------------------------------------------------------------------------
export function seedReference(s: DemoStore) {
  const li: Array<[string, number, number | null]> = [['invite', 80, 150], ['profile_view', 100, null], ['message', 100, null], ['inmail', 50, null], ['like', 100, null], ['comment', 100, null], ['endorse', 50, null], ['search_page', 50, null], ['withdraw', 20, null], ['email', 150, null], ['new_chat', 100, null], ['follow', 50, null], ['find_email', 100000, null], ['reply', 100000, null], ['call_api', 100000, null]];
  for (const [action_type, per_day, per_week] of li) s.insert('outreach_platform_ceilings', { provider: 'LINKEDIN', action_type, per_day, per_week }, { noId: true });
  const ig: Array<[string, number]> = [['profile_view', 60], ['follow', 30], ['unfollow', 15], ['new_chat', 25], ['message', 50], ['like', 40], ['comment', 15], ['post_fetch', 40]];
  for (const [action_type, per_day] of ig) s.insert('outreach_platform_ceilings', { provider: 'INSTAGRAM', action_type, per_day, per_week: null }, { noId: true });
  for (const [action_type, per_day] of [['message', 80], ['new_chat', 30], ['identifier_check', 200]] as Array<[string, number]>) s.insert('outreach_platform_ceilings', { provider: 'WHATSAPP', action_type, per_day, per_week: null }, { noId: true });
  const warm: Record<string, number[]> = {
    invite: [4, 9, 15, 25, 35, 45], message: [5, 10, 20, 35, 50, 60], profile_view: [10, 20, 30, 40, 50, 60], like: [5, 10, 15, 20, 30, 30], comment: [0, 3, 5, 8, 10, 10],
    inmail: [0, 5, 10, 20, 30, 40], search_page: [5, 10, 20, 40, 60, 80], endorse: [0, 3, 5, 8, 10, 10], withdraw: [2, 4, 6, 8, 10, 10], email: [20, 40, 60, 80, 100, 120],
    new_chat: [5, 10, 20, 35, 50, 60], follow: [5, 10, 15, 20, 25, 30],
  };
  for (const [action_type, levels] of Object.entries(warm)) levels.forEach((per_day, level) => s.insert('outreach_warmup_caps', { provider: 'LINKEDIN', level, action_type, per_day }, { noId: true }));
  const igWarm: Record<string, number[]> = { new_chat: [0, 3, 8, 15, 20, 25], follow: [5, 10, 15, 20, 25, 30], like: [8, 15, 25, 30, 35, 40], comment: [0, 3, 6, 10, 12, 15], profile_view: [10, 20, 30, 40, 50, 60], message: [0, 6, 16, 30, 40, 50], unfollow: [0, 3, 5, 8, 10, 15] };
  for (const [action_type, levels] of Object.entries(igWarm)) levels.forEach((per_day, level) => s.insert('outreach_warmup_caps', { provider: 'INSTAGRAM', level, action_type, per_day }, { noId: true }));
  const waWarm: Record<string, number[]> = { message: [10, 20, 35, 50, 80, 80], new_chat: [3, 6, 12, 20, 30, 30], identifier_check: [50, 100, 150, 200, 200, 200] };
  for (const [action_type, levels] of Object.entries(waWarm)) levels.forEach((per_day, level) => s.insert('outreach_warmup_caps', { provider: 'WHATSAPP', level, action_type, per_day }, { noId: true }));
}

// ---------------------------------------------------------------------------
export function seedTaxonomy(s: DemoStore, now: number) {
  const lists: Array<[string, string, string | null]> = [[LIST.founders, 'SaaS founders · North America', null], [LIST.agencies, 'Agency owners', null], [LIST.dental, 'Dental practice owners', CLIENT.orchard], [LIST.events, 'Webinar sign-ups', CLIENT.lumen]];
  lists.forEach(([id, name, client_id], i) => s.insert('outreach_lists', { id, workspace_id: DEMO_WS_ID, client_id, name, created_at: iso(now - (90 - i * 10) * D) }));
  const tags: Array<[string, string, string]> = [[TAG.hot, 'hot', '#ef4444'], [TAG.decision_maker, 'decision maker', '#6366f1'], [TAG.event_2026, 'event 2026', '#f59e0b'], [TAG.partner, 'partner', '#10b981'], [TAG.do_later, 'follow up later', '#64748b']];
  for (const [id, name, color] of tags) s.insert('outreach_tags', { id, workspace_id: DEMO_WS_ID, name, color });
  const stages: Array<[string, string, string, string, number | null]> = [
    [STAGE.new, 'New', 'new', '#94a3b8', null], [STAGE.contacted, 'Contacted', 'contacted', '#60a5fa', null], [STAGE.connected, 'Connected', 'connected', '#818cf8', null],
    [STAGE.replied, 'Replied', 'replied', '#a78bfa', null], [STAGE.interested, 'Interested', 'interested', '#f59e0b', 2500], [STAGE.meeting, 'Meeting booked', 'meeting', '#10b981', 4000],
    [STAGE.won, 'Won', 'won', '#059669', 12000], [STAGE.lost, 'Lost', 'lost', '#ef4444', null],
  ];
  stages.forEach(([id, name, kind, color, deal_value], position) => s.insert('outreach_stages', { id, workspace_id: DEMO_WS_ID, name, kind, color, position, deal_value }));
}

// ---------------------------------------------------------------------------
export function seedLeads(s: DemoStore, now: number) {
  const used = new Set<string>();
  for (let i = 0; i < LEAD_COUNT; i++) {
    let first = '', last = '';
    for (let tries = 0; tries < 20; tries++) {
      first = FIRST_NAMES[(i * 7 + tries * 13) % FIRST_NAMES.length];
      last = LAST_NAMES[(i * 11 + tries * 5 + Math.floor(i / FIRST_NAMES.length)) % LAST_NAMES.length];
      if (!used.has(`${first} ${last}`)) break;
    }
    used.add(`${first} ${last}`);
    const full = `${first} ${last}`;
    // segments: 0-159 SaaS founders, 160-279 agencies, 280-339 dental (client), 340-399 webinar sign-ups (client)
    const seg = i < 160 ? 'founders' : i < 280 ? 'agencies' : i < 340 ? 'dental' : 'events';
    const company = seg === 'dental' ? `${LAST_NAMES[i % LAST_NAMES.length]} Family Dental` : COMPANIES[(i * 3) % COMPANIES.length];
    const title = seg === 'dental' ? (i % 3 === 0 ? 'Practice Owner' : 'Practice Manager') : seg === 'agencies' ? (i % 2 ? 'Agency Owner' : 'Managing Partner') : TITLES[(i * 5) % TITLES.length];
    const ident = `demo-${slug(full)}-${(i + 11).toString(36)}`;
    const hasEmail = i % 5 !== 0;
    const email = hasEmail ? `${slug(first)}.${slug(last)}${i % 7 === 0 ? i : ''}@example.com`.replace(/-/g, '') : null;
    const client_id = seg === 'dental' ? CLIENT.orchard : seg === 'events' ? CLIENT.lumen : null;
    const list_id = seg === 'founders' ? LIST.founders : seg === 'agencies' ? LIST.agencies : seg === 'dental' ? LIST.dental : LIST.events;
    const created = now - (75 - (i % 70)) * D - (i % 9) * H;
    s.insert('outreach_leads', {
      id: leadId(i), workspace_id: DEMO_WS_ID, client_id, public_identifier: ident, provider_id: `demo-li-${i}`, profile_url: null,
      first_name: first, last_name: last, full_name: full, headline: `${title} at ${company}`, company, company_id: null, title,
      location: LOCATIONS[(i * 7) % LOCATIONS.length], picture_url: null, email_work: email, email_personal: null, is_open_profile: i % 9 === 0,
      custom: { industry: seg === 'dental' ? 'Healthcare' : seg === 'agencies' ? 'Marketing services' : ['Software', 'Fintech', 'Logistics', 'Health tech'][i % 4], company_size: ['11-50', '51-200', '201-500', '2-10'][i % 4], website: `${slug(company)}.example.com` },
      list_id, stage_id: STAGE.new, do_not_contact: i === 57 || i === 214, unsubscribed: false, source: i % 4 === 0 ? 'csv' : 'search_url', import_job_id: null,
      last_profile_fetch_at: iso(created + 2 * H), last_replied_at: null, last_replied_channel: null, phone: i % 6 === 0 ? `+1 555 01${String(i % 100).padStart(2, '0')}` : null,
      enrich_status: i % 8 === 0 ? 'none' : 'done', enriched_at: i % 8 === 0 ? null : iso(created + 3 * H), email_status: hasEmail ? (i % 11 === 0 ? 'unverified' : 'verified') : null,
      created_at: iso(created), updated_at: iso(created),
    });
    if (i % 8 !== 0) {
      const started = now - (8 + (i % 60)) * 30 * D;
      const posts = i % 3 === 0 ? [] : [0, 1, 2].map((k) => ({ id: `demo-post-${i}-${k}`, text: `Some thoughts on ${POST_TOPICS[(i + k) % POST_TOPICS.length]}. What has worked for your team?`, date: iso(now - (4 + k * 9 + (i % 12)) * D), reactions: 12 + ((i * 7 + k) % 140), comments: (i + k) % 23 }));
      s.insert('outreach_lead_profiles', {
        lead_id: leadId(i), workspace_id: DEMO_WS_ID, about: `${title} at ${company}. I care about building teams that grow without burning out. Previously at ${COMPANIES[(i * 7 + 3) % COMPANIES.length]}.`,
        current_title: title, current_company: company, current_started_on: iso(started).slice(0, 10),
        experience: [
          { company, title, start: iso(started).slice(0, 7), current: true, location: LOCATIONS[(i * 7) % LOCATIONS.length] },
          { company: COMPANIES[(i * 7 + 3) % COMPANIES.length], title: TITLES[(i + 4) % TITLES.length], start: iso(started - 900 * D).slice(0, 7), end: iso(started - 30 * D).slice(0, 7), current: false },
        ],
        education: [{ school: SCHOOLS[i % SCHOOLS.length], degree: i % 2 ? 'BSc' : 'MBA', field: i % 2 ? 'Computer Science' : 'Marketing', start: '2008', end: '2012' }],
        skills: [SKILLS[i % SKILLS.length], SKILLS[(i + 3) % SKILLS.length], SKILLS[(i + 7) % SKILLS.length]], languages: ['English'], profile_language: 'en',
        follower_count: 300 + ((i * 37) % 9000), connections_count: 250 + ((i * 53) % 4500),
        linkedin: { is_open_profile: i % 9 === 0, is_premium: i % 4 === 0, network_distance: 'DISTANCE_2', country: LOCATIONS[(i * 7) % LOCATIONS.length].split(', ').pop() },
        posts, posts_fetched_at: posts.length ? iso(now - 3 * D) : null, last_posted_at: posts[0]?.date ?? null, enriched_at: iso(created + 3 * H), enriched_by_sender: SENDER.li_maya,
        source: 'linkedin', empty_sections: posts.length ? [] : ['posts'], updated_at: iso(created + 3 * H),
      }, { noId: true });
    }
    // tags
    if (i % 6 === 0) s.insert('outreach_lead_tags', { lead_id: leadId(i), tag_id: TAG.decision_maker }, { silent: true });
    if (i % 13 === 0) s.insert('outreach_lead_tags', { lead_id: leadId(i), tag_id: TAG.hot }, { silent: true });
    if (seg === 'events') s.insert('outreach_lead_tags', { lead_id: leadId(i), tag_id: TAG.event_2026 }, { silent: true });
    if (i % 29 === 0) s.insert('outreach_lead_tags', { lead_id: leadId(i), tag_id: TAG.partner }, { silent: true });
    // identities on other channels
    if (email) s.insert('outreach_lead_identities', { workspace_id: DEMO_WS_ID, lead_id: leadId(i), provider: 'GMAIL', identifier: email, provider_id: null, verified: true, source: 'import', is_valid: null, last_checked_at: null, created_at: iso(created) });
    if (i % 6 === 0) s.insert('outreach_lead_identities', { workspace_id: DEMO_WS_ID, lead_id: leadId(i), provider: 'WHATSAPP', identifier: `+1555010${String(i % 100).padStart(2, '0')}`, provider_id: null, verified: false, source: 'import', is_valid: i % 12 === 0 ? true : null, last_checked_at: null, created_at: iso(created) });
    if (i % 10 === 3) s.insert('outreach_lead_identities', { workspace_id: DEMO_WS_ID, lead_id: leadId(i), provider: 'INSTAGRAM', identifier: `${slug(first)}.${slug(last)}.demo`, provider_id: null, verified: false, source: 'manual', is_valid: null, last_checked_at: null, created_at: iso(created) });
  }
}

// ---------------------------------------------------------------------------
type Spec = { id: string; type: NodeType; label?: string; config?: Row; next?: string | null; branches?: Record<string, string | null>; mode?: 'manual' };
function build(specs: Spec[]): Graph {
  const nodes: Record<string, GraphNode> = {};
  for (const sp of specs) {
    const meta = NODE_CATALOG[sp.type];
    const n: GraphNode = { id: sp.id, type: sp.type, label: sp.label ?? meta.label, config: { ...JSON.parse(JSON.stringify(meta.defaultConfig)), ...(sp.config ?? {}) }, position: { x: 0, y: 0 } };
    if (sp.mode) n.mode = sp.mode;
    if (meta.exits.length === 1) n.next = sp.next ?? null;
    else if (meta.exits.length > 1) n.branches = Object.fromEntries(meta.exits.map((e) => [e, sp.branches?.[e] ?? null]));
    nodes[sp.id] = n;
  }
  return autoLayout({ version: 1, start: 'start', nodes });
}

export const SAAS_MESSAGE = 'Hi {{first_name|there}}, thanks for connecting! {{ai.icebreaker|I enjoyed reading your recent posts}}. We help teams like {{company|yours}} book more first meetings without adding headcount. Worth a quick chat?';

export function sequenceGraphs(): Record<keyof typeof SEQ, Graph> {
  return {
    saas: build([
      { id: 'start', type: 'start', next: 'visit' },
      { id: 'visit', type: 'visit_profile', label: 'Visit profile', next: 'invite' },
      { id: 'invite', type: 'send_invite', label: 'Send invitation', config: { note: 'Hi {{first_name|there}}, I work with {{title|leaders}}s at fast-growing SaaS teams. Would be great to connect.' }, next: 'wait' },
      { id: 'wait', type: 'wait_connection', label: 'Wait for connection', config: { window_days: 10, subtasks: [{ type: 'like_latest_post' }] }, branches: { connected: 'delay_1', no_connect: 'withdraw' } },
      { id: 'delay_1', type: 'delay', label: 'Wait 1 day', config: { amount: 1, unit: 'days', jitter_pct: 20 }, next: 'message_1' },
      { id: 'message_1', type: 'send_message', label: 'First message', config: { text: SAAS_MESSAGE }, next: 'reply_wait' },
      { id: 'reply_wait', type: 'wait_for_reply', label: 'Wait for a reply', config: { window_hours: 96 }, branches: { replied: 'end_replied', no_reply: 'message_2' } },
      { id: 'message_2', type: 'send_message', label: 'Follow-up', config: { text: 'Hi {{first_name|there}}, just bumping this in case it got buried. Happy to share how {{sender.first_name}} and the team set this up for similar companies.' }, next: 'end_done' },
      { id: 'end_replied', type: 'end', label: 'Replied' },
      { id: 'end_done', type: 'end', label: 'Done' },
      { id: 'withdraw', type: 'withdraw_invite', label: 'Withdraw invitation', next: 'end_not_connected' },
      { id: 'end_not_connected', type: 'end', label: 'Not connected' },
    ]),
    agencies: build([
      { id: 'start', type: 'start', next: 'visit' },
      { id: 'visit', type: 'visit_profile', next: 'invite' },
      { id: 'invite', type: 'send_invite', config: { note: '' }, next: 'wait' },
      { id: 'wait', type: 'wait_connection', config: { window_days: 7, subtasks: [] }, branches: { connected: 'message_1', no_connect: 'email_1' } },
      { id: 'message_1', type: 'send_message', label: 'LinkedIn message', config: { text: '{Hi|Hey} {{first_name|there}}, thanks for connecting! How are you finding new clients for {{company|the agency}} these days?' }, next: 'reply_wait' },
      { id: 'reply_wait', type: 'wait_for_reply', config: { window_hours: 72 }, branches: { replied: 'end_replied', no_reply: 'email_1' } },
      { id: 'email_1', type: 'send_email', label: 'Email', config: { subject: 'Client pipeline for {{company|your agency}}', html: '<p>Hi {{first_name|there}},</p><p>I run growth at Northwind. We help agencies like {{company|yours}} keep a steady flow of first calls with LinkedIn and email outreach that sounds human.</p><p>Open to a 15-minute call next week?</p><p>{{sender.signature}}</p>' }, branches: { next: 'end_done', bounced: 'end_done', no_email: 'end_done' } },
      { id: 'end_replied', type: 'end', label: 'Replied' },
      { id: 'end_done', type: 'end', label: 'Done' },
    ]),
    dental: (() => { const g = findTemplate('connect_follow_up')!.build(); return autoLayout(g); })(),
    revive: autoLayout(findTemplate('nurture_connected')!.build()),
    webinar: autoLayout(findTemplate('connect')!.build()),
    draft: autoLayout(findTemplate('instagram_ladder')!.build()),
  };
}

export function seedSequences(s: DemoStore, now: number) {
  const graphs = sequenceGraphs();
  const defs: Array<{ key: keyof typeof SEQ; name: string; status: string; client: string | null; pool: string[]; created: number; brief?: string; settings?: Row }> = [
    { key: 'saas', name: 'SaaS founders · Q4 outreach', status: 'active', client: null, pool: [SENDER.li_maya, SENDER.li_sam], created: 58, brief: 'Founders and growth leads at 10–500 person SaaS companies in North America.' },
    { key: 'agencies', name: 'Agency owners · LinkedIn + email', status: 'active', client: null, pool: [SENDER.li_sam, SENDER.li_priya_warm, SENDER.gmail, SENDER.outlook], created: 45, brief: 'Owners of 5–50 person marketing agencies.' },
    { key: 'dental', name: 'Orchard Lane · practice owners', status: 'active', client: CLIENT.orchard, pool: [SENDER.li_maya], created: 40 },
    { key: 'revive', name: 'Re-engage past webinar guests', status: 'paused', client: CLIENT.lumen, pool: [SENDER.li_paused], created: 35 },
    { key: 'webinar', name: 'Q2 webinar follow-up', status: 'archived', client: CLIENT.lumen, pool: [SENDER.li_maya], created: 60 },
    { key: 'draft', name: 'Instagram creators (draft)', status: 'draft', client: null, pool: [SENDER.instagram], created: 3 },
  ];
  for (const d of defs) {
    const g = graphs[d.key];
    const pools: Row = {};
    for (const id of d.pool) { const p = s.get('outreach_senders', id)!.provider; (pools[p] ??= []).push(id); }
    s.insert('outreach_sequences', {
      id: SEQ[d.key], workspace_id: DEMO_WS_ID, client_id: d.client, name: d.name, status: d.status, head_version: d.status === 'draft' ? 0 : 2, graph: g,
      sender_pool: d.pool, sender_pools: pools, assignment: 'round_robin', use_sender_schedule: true,
      settings: { stop_on_reply: true, on_reply: 'exit', resume_after_ooo: false, withdraw_after_days: 21, ...(d.settings ?? {}) },
      throttled_reason: null, brief: d.brief ?? null, draft_graph: d.status === 'draft' ? g : null, draft_updated_at: d.status === 'draft' ? iso(now - D) : null,
      draft_updated_by: d.status === 'draft' ? MEMBER.maya : null, draft_base_version: null, stalled_at: null, stalled_reason: null,
      created_at: iso(now - d.created * D), updated_at: iso(now - Math.min(d.created, 2) * D), archived_at: d.status === 'archived' ? iso(now - 12 * D) : null,
      created_by: MEMBER.maya,
    });
    if (d.status !== 'draft') {
      s.insert('outreach_sequence_versions', { sequence_id: SEQ[d.key], version: 1, graph: g, created_by: MEMBER.maya, created_at: iso(now - d.created * D), note: 'First version', publish_mode: 'all' }, { noId: true });
      s.insert('outreach_sequence_versions', { sequence_id: SEQ[d.key], version: 2, graph: g, created_by: MEMBER.sam, created_at: iso(now - (d.created - 6) * D), note: 'Shorter invitation note', publish_mode: 'new_only' }, { noId: true });
    }
  }
}

// ---------------------------------------------------------------------------
/**
 * 60 days of history: leads are enrolled in batches over time and the demo engine runs every two simulated hours,
 * so actions, accepted invitations, conversations, replies and step counts are all real outcomes of the graphs.
 */
export function seedHistory(s: DemoStore, now: number) {
  const engine = new Engine(s);
  const start = now - 60 * D;
  const finalStatus = new Map(s.t('outreach_sequences').map((q) => [q.id, q.status]));
  // during the history every non-draft sequence runs; the paused / finished ones stop at their own end
  for (const q of s.t('outreach_sequences')) if (q.status !== 'draft') q.status = 'active';
  const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => leadId(from + k));
  const batches: Array<{ seq: string; leads: string[]; at: number }> = [];
  const spread = (seq: string, from: number, to: number, firstDay: number, lastDay: number, n: number) => {
    const all = ids(from, to);
    const per = Math.ceil(all.length / n);
    for (let k = 0; k < n; k++) batches.push({ seq, leads: all.slice(k * per, (k + 1) * per), at: now - (firstDay - ((firstDay - lastDay) * k) / Math.max(1, n - 1)) * D });
  };
  spread(SEQ.webinar, 340, 400, 59, 50, 3);
  // the running sequences keep taking new leads up to today, so the simulator has work from the first minute
  spread(SEQ.saas, 0, 150, 56, 0.05, 14);
  spread(SEQ.agencies, 160, 270, 44, 0.05, 11);
  spread(SEQ.dental, 280, 335, 39, 4, 5);
  spread(SEQ.revive, 345, 395, 33, 20, 2);
  batches.sort((a, b) => a.at - b.at);
  const stopAt: Record<string, number> = { [SEQ.webinar]: now - 12 * D, [SEQ.revive]: now - 6 * D };
  let b = 0;
  for (let t = start; t <= now; t += 2 * H) {
    while (b < batches.length && batches[b].at <= t) { engine.enroll(batches[b].seq, batches[b].leads, { now: t, includeReplied: true }); b++; }
    for (const [seq, at] of Object.entries(stopAt)) if (t >= at) { const q = s.get('outreach_sequences', seq); if (q) q.status = finalStatus.get(seq); }
    engine.ledger.rebuild();
    engine.run(t);
  }
  for (const q of s.t('outreach_sequences')) q.status = finalStatus.get(q.id);
  // a finished sequence has no one left in it
  for (const e of s.t('outreach_enrollments')) if (e.sequence_id === SEQ.webinar && ['active', 'waiting_connection', 'waiting_delay', 'waiting_task'].includes(e.status)) { e.status = 'completed'; e.completed_at = iso(now - 12 * D); }
  // a few leads were connected to Maya before the demo started
  for (let i = 150; i < 160; i++) {
    const st = engine.state(leadId(i), SENDER.li_maya);
    st.relation = 'first'; st.invite_accepted_at = iso(now - 200 * D);
  }
  void idFrom; void SALT;
}
