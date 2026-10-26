/**
 * Demo side of migration 094 (leads-relationships-PRD.md): the per-lead summary the real database keeps in
 * outreach_lead_summary (status ladder, connections per account, channels), rebuilt from the store before a read, and the
 * reads / writes behind the totals line, the By account panel, the Relationships card, Add to prospects and hide / unhide.
 * The rules mirror outreach_lead_summary_refresh and outreach__leads_matching; blacklists are not modelled in the demo.
 */
import type { Ctx } from '../ctx';
import { demoError } from '../ctx';
import { audit } from './util';
import type { DemoStore, Row } from '../store';

type Channel = 'linkedin' | 'instagram' | 'whatsapp' | 'email';
const LADDER = ['not_contacted', 'invited', 'connected', 'messaged', 'replied', 'interested', 'meeting'] as const;
const REMOVED_STATUSES = new Set(['removed', 'erased', 'disconnected']);
const MIN = 60_000;

export const channelOfProvider = (p: unknown): Channel => (p === 'INSTAGRAM' ? 'instagram' : p === 'WHATSAPP' ? 'whatsapp' : p === 'LINKEDIN' || p == null ? 'linkedin' : 'email');
const ms = (v: unknown): number | null => (typeof v === 'string' && v ? Date.parse(v) : null);
const iso = (n: number | null | undefined): string | null => (n == null ? null : new Date(n).toISOString());
const isRemoved = (s: Row | undefined): boolean => !!s && (!!s.deleted_at || REMOVED_STATUSES.has(String(s.status)));
/** outreach__msg_kind: person | auto | bounce | ours | null (system events, call notices, CSAT). */
function msgKind(m: Row): 'person' | 'auto' | 'bounce' | 'ours' | null {
  if (m.event_type != null || ['event', 'csat'].includes(String(m.content_type ?? 'text')) || m.sender_type === 'system') return null;
  if (m.direction === 'out') return 'ours';
  if (m.is_bounce) return 'bounce';
  if (m.is_auto_reply) return 'auto';
  return 'person';
}

let rev = -1;
/** Rebuilds every summary row when the store changed (the real database recomputes one lead at a time from a queue). */
export function rebuildLeadSummary(store: DemoStore): void {
  if (rev === store.rev) return;
  rev = store.rev;
  const senders = new Map(store.t('outreach_senders').map((s) => [s.id, s]));
  const chatsById = new Map(store.t('outreach_chats').map((c) => [c.id, c]));
  const stageById = new Map(store.t('outreach_stages').map((s) => [s.id, s]));
  const byLead = <T extends Row>(rows: T[], key = 'lead_id') => { const m = new Map<string, T[]>(); for (const r of rows) { const k = r[key]; if (!k) continue; const l = m.get(k) ?? []; l.push(r); m.set(k, l); } return m; };
  const actions = byLead(store.t('outreach_actions').filter((a) => a.status === 'sent' && a.executed_at && !a.payload?.prefetch && !a.payload?.subtask));
  const lss = byLead(store.t('outreach_lead_sender_state'));
  const idents = byLead(store.t('outreach_lead_identities'));
  const milestones = byLead(store.t('outreach_lead_milestones'));
  const messages = new Map<string, Row[]>();
  for (const m of store.t('outreach_messages')) {
    const c = chatsById.get(m.chat_id);
    if (!c?.lead_id || c.provider === 'WEBCHAT' || m.deleted_at) continue;
    const l = messages.get(c.lead_id) ?? []; l.push(m); messages.set(c.lead_id, l);
  }
  const rows: Row[] = [];
  for (const l of store.t('outreach_leads')) {
    const states = lss.get(l.id) ?? [];
    const ids = idents.get(l.id) ?? [];
    const bounced: Channel[] = [];
    if (states.some((x) => x.email_bounced)) bounced.push('email');
    if (ids.some((i) => i.provider === 'WHATSAPP' && i.is_valid === false)) bounced.push('whatsapp');
    // touches of ours
    type Touch = { sender: string; ch: Channel; at: number; kind: 'invite' | 'message' };
    const touches: Touch[] = [];
    for (const a of actions.get(l.id) ?? []) {
      const s = senders.get(a.sender_id); if (!s) continue;
      const kind = ['invite', 'follow'].includes(a.action_type) ? 'invite' : ['message', 'new_chat', 'inmail', 'email', 'reply', 'ai_reply'].includes(a.action_type) ? 'message' : null;
      const at = ms(a.executed_at); if (!kind || at == null) continue;
      touches.push({ sender: a.sender_id, ch: channelOfProvider(s.provider), at, kind });
    }
    const inbound: { sender: string; ch: Channel; at: number; intent: string | null }[] = [];
    for (const m of messages.get(l.id) ?? []) {
      const c = chatsById.get(m.chat_id)!; const k = msgKind(m); const at = ms(m.sent_at); if (at == null) continue;
      if (k === 'ours' && !m.is_invite_note) touches.push({ sender: c.sender_id, ch: channelOfProvider(c.provider), at, kind: 'message' });
      if (k === 'person') inbound.push({ sender: c.sender_id, ch: channelOfProvider(c.provider), at, intent: m.intent ?? null });
    }
    for (const x of states) {
      const s = senders.get(x.sender_id); const at = ms(x.invite_sent_at);
      if (s && at != null && ['linkedin', 'instagram'].includes(channelOfProvider(s.provider))) touches.push({ sender: x.sender_id, ch: channelOfProvider(s.provider), at, kind: 'invite' });
    }
    touches.sort((a, b) => a.at - b.at); inbound.sort((a, b) => a.at - b.at);
    const firstTouch = touches[0]?.at ?? null;
    const invites = touches.filter((t) => t.kind === 'invite');
    const msgs = touches.filter((t) => t.kind === 'message' && !bounced.includes(t.ch));
    const replies = firstTouch == null ? [] : inbound.filter((i) => i.at > firstTouch);
    const interested = replies.filter((i) => i.intent === 'interested' || i.intent === 'question');
    const wroteFirst = inbound.find((i) => firstTouch == null || i.at < firstTouch)?.at ?? null;
    // connections
    const conn: string[] = []; const ours: string[] = []; const pend: string[] = []; const sources = new Set<string>();
    let connectedFirst: number | null = null; let connectedLast: number | null = null; let connectedCh: Channel | null = null; let lssLast: number | null = null;
    for (const x of states) {
      const s = senders.get(x.sender_id); if (!s) continue;
      const ch = channelOfProvider(s.provider); const up = ms(x.updated_at); if (up != null) lssLast = Math.max(lssLast ?? 0, up);
      if (!['linkedin', 'instagram'].includes(ch)) continue;
      const connectedAt = ms(x.connected_at) ?? ms(x.invite_accepted_at) ?? up ?? Date.now();
      const source: string = x.relation_source ?? (ms(x.invite_sent_at) != null && (ms(x.invite_sent_at) as number) <= connectedAt + MIN ? 'our_invite' : 'pre_existing');
      if (x.relation === 'first') { conn.push(x.sender_id); sources.add(source); if (source === 'our_invite') ours.push(x.sender_id); }
      if (x.relation === 'pending_out') pend.push(x.sender_id);
      if (x.relation === 'first' || x.connected_at) {
        connectedFirst = connectedFirst == null ? connectedAt : Math.min(connectedFirst, connectedAt);
        if (connectedLast == null || connectedAt >= connectedLast) { connectedLast = connectedAt; connectedCh = ch; }
      }
    }
    const identity: Channel[] = [];
    if (l.public_identifier || l.provider_id || ids.some((i) => i.provider === 'LINKEDIN')) identity.push('linkedin');
    if (l.email_work || l.email_personal || ids.some((i) => ['GMAIL', 'OUTLOOK', 'IMAP'].includes(i.provider))) identity.push('email');
    if (ids.some((i) => i.provider === 'INSTAGRAM')) identity.push('instagram');
    if (ids.some((i) => i.provider === 'WHATSAPP')) identity.push('whatsapp');
    let meetingAt = (milestones.get(l.id) ?? []).filter((m) => m.kind === 'meeting').map((m) => ms(m.at) ?? 0).sort()[0] ?? null;
    if (meetingAt == null && l.stage_id) { const st = stageById.get(l.stage_id); if (st && (st.is_meeting || st.kind === 'meeting')) meetingAt = ms(l.updated_at) ?? Date.now(); }
    const suppressed = !!l.do_not_contact || !!l.unsubscribed;
    let ladder = 0; let stCh: Channel | null = null; let stAt: number | null = null;
    if (invites.length || pend.length) { ladder = 1; stCh = invites.at(-1)?.ch ?? 'linkedin'; stAt = invites.at(-1)?.at ?? null; }
    if (connectedFirst != null) { ladder = 2; stCh = connectedCh; stAt = connectedLast; }
    if (msgs.length) { ladder = 3; stCh = msgs.at(-1)!.ch; stAt = msgs.at(-1)!.at; }
    if (replies.length) { ladder = 4; stCh = replies.at(-1)!.ch; stAt = replies.at(-1)!.at; }
    if (interested.length) { ladder = 5; stCh = interested.at(-1)!.ch; stAt = interested.at(-1)!.at; }
    if (meetingAt != null) { ladder = 6; stCh = replies.at(-1)?.ch ?? stCh; stAt = meetingAt; }
    let status: string = suppressed ? 'do_not_contact' : ladder === 0 && bounced.length ? 'bounced' : inbound.length && firstTouch == null ? 'wrote_to_us' : LADDER[ladder];
    if (status === 'wrote_to_us') stAt = inbound.at(-1)?.at ?? stAt;
    if (status === 'bounced') { stCh = bounced[0]; stAt = touches.at(-1)?.at ?? null; }
    const lastAct = Math.max(touches.at(-1)?.at ?? 0, inbound.at(-1)?.at ?? 0, lssLast ?? 0, meetingAt ?? 0, ms(l.created_at) ?? 0) || null;
    rows.push({
      id: l.id, lead_id: l.id, workspace_id: l.workspace_id, status, status_rank: ladder, status_channel: stCh, status_at: iso(stAt),
      connected_sender_ids: conn, connected_via_our_invite_ids: ours, pending_sender_ids: pend, connected_count: conn.length, pending_count: pend.length, connection_sources: [...sources],
      identity_channels: identity, used_channels: [...new Set(touches.map((t) => t.ch))], replied_channels: [...new Set(replies.map((r) => r.ch))], bounced_channels: bounced,
      contacted_sender_ids: [...new Set(touches.map((t) => t.sender))], replied_sender_ids: [...new Set(replies.map((r) => r.sender))],
      first_contacted_at: iso(firstTouch), connected_ever_at: iso(connectedFirst), replied_at: iso(replies[0]?.at ?? null), last_activity_at: iso(lastAct), wrote_first_at: iso(wroteFirst),
      updated_at: new Date().toISOString(),
    });
  }
  const table = store.t('outreach_lead_summary');
  table.splice(0, table.length, ...rows);
  // chats seeded before 094 carry no counterpart kind: they are people
  for (const c of store.t('outreach_chats')) if (c.counterpart_kind === undefined) c.counterpart_kind = 'person';
}

// ---------------------------------------------------------------------------
// outreach__leads_matching
// ---------------------------------------------------------------------------
function list(v: unknown): string[] | null { return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : null; }
const monthsAgo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10); };

export function matchingLeads(ctx: Ctx, f: Row): Row[] {
  const { store } = ctx;
  rebuildLeadSummary(store);
  const summary = new Map(store.t('outreach_lead_summary').map((s) => [s.lead_id, s]));
  const profiles = new Map(store.t('outreach_lead_profiles').map((p) => [p.lead_id, p]));
  const removed = f.include_removed ? new Set<string>() : new Set(store.t('outreach_senders').filter(isRemoved).map((s) => s.id));
  const tab = f.tab ?? 'prospects'; const hidden = !!f.hidden;
  const status = list(f.status), via = list(f.connected_via), pend = list(f.pending_with), origin = list(f.origin), kind = list(f.kind);
  const ch = (v: unknown): Channel | null => (v ? channelOfProvider(String(v).toUpperCase() === 'EMAIL' ? 'GMAIL' : String(v).toUpperCase()) : null);
  const reach = ch(f.channel), used = ch(f.channel_used), replied = ch(f.channel_replied);
  const search = typeof f.search === 'string' && f.search.trim() ? f.search.trim().toLowerCase() : null;
  const tagLeads = f.tag_id ? new Set(store.t('outreach_lead_tags').filter((t) => t.tag_id === f.tag_id).map((t) => t.lead_id)) : null;
  const live = (ids: string[] | undefined) => (ids ?? []).filter((id) => !removed.has(id));
  return store.t('outreach_leads').filter((l) => {
    if (l.workspace_id !== ctx.ws) return false;
    if ((!!l.hidden_at) !== hidden) return false;
    if (!hidden && tab === 'prospects' && !l.prospect_since) return false;
    if (!hidden && tab === 'inbox' && !(l.origin === 'inbound' && !l.prospect_since)) return false;
    if (search && ![l.full_name, l.company, l.headline, l.public_identifier, l.email_work].some((v) => typeof v === 'string' && v.toLowerCase().includes(search))) return false;
    if (f.client_id && l.client_id !== f.client_id) return false;
    if (f.list_id && l.list_id !== f.list_id) return false;
    if (f.stage_id && l.stage_id !== f.stage_id) return false;
    if (tagLeads && !tagLeads.has(l.id)) return false;
    if (f.dnc != null && !!l.do_not_contact !== !!f.dnc) return false;
    if (origin && !origin.includes(l.origin ?? 'import')) return false;
    if (kind && !kind.includes(l.kind ?? 'person')) return false;
    const s = summary.get(l.id);
    if (status && !status.includes(s?.status ?? 'not_contacted')) return false;
    if (via && !live(s?.connected_sender_ids).some((id) => via.includes(id))) return false;
    if (pend && !live(s?.pending_sender_ids).some((id) => pend.includes(id))) return false;
    if (f.not_connected && live(s?.connected_sender_ids).length) return false;
    if (f.connection_source && !(s?.connection_sources ?? []).includes(f.connection_source)) return false;
    if (reach && !(reach === 'linkedin' && (l.public_identifier || l.provider_id)) && !(s?.identity_channels ?? []).includes(reach)) return false;
    if (used && !(s?.used_channels ?? []).includes(used)) return false;
    if (replied && !(s?.replied_channels ?? []).includes(replied)) return false;
    if (f.enriched != null && (!!l.enriched_at) !== !!f.enriched) return false;
    if (f.replied != null && (!!(s?.replied_at ?? l.last_replied_at)) !== !!f.replied) return false;
    const p = profiles.get(l.id);
    if (f.posted_30d && !(p?.last_posted_at && Date.parse(p.last_posted_at) >= Date.now() - 30 * 86_400_000)) return false;
    if (f.min_followers != null && !(p?.follower_count >= Number(f.min_followers))) return false;
    if (f.time_in_role) {
      const d = p?.current_started_on as string | undefined; if (!d) return false;
      const ok = f.time_in_role === 'lt6' ? d > monthsAgo(6) : f.time_in_role === '6to12' ? d <= monthsAgo(6) && d > monthsAgo(12) : f.time_in_role === '1to3' ? d <= monthsAgo(12) && d > monthsAgo(36) : d <= monthsAgo(36);
      if (!ok) return false;
    }
    if (f.past_company && !String(p?.companies_text ?? '').includes(String(f.past_company).toLowerCase())) return false;
    if (f.skill && !String(p?.skills_text ?? '').includes(String(f.skill).toLowerCase())) return false;
    if (f.language && !String(p?.profile_language ?? '').toLowerCase().startsWith(String(f.language).toLowerCase())) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
function wsGuard(ctx: Ctx, ws: unknown) { if (ws !== ctx.ws) demoError('E_FORBIDDEN', 'not a member of this workspace'); }

export function leadsTotals(args: Row, ctx: Ctx): Row {
  wsGuard(ctx, args.p_ws);
  const f = { ...(args.p_f ?? {}), include_removed: !!args.p_include_removed };
  const summary = new Map(ctx.store.t('outreach_lead_summary').map((s) => [s.lead_id, s]));
  const removed = f.include_removed ? new Set<string>() : new Set(ctx.store.t('outreach_senders').filter(isRemoved).map((s) => s.id));
  const live = (ids: string[] | undefined) => (ids ?? []).filter((id) => !removed.has(id));
  const t = { people: 0, contacted: 0, invited_pending: 0, connected: 0, connected_via_our_invites: 0, replied: 0, interested: 0, meetings: 0, do_not_contact: 0, bounced: 0, wrote_to_us: 0, include_removed: f.include_removed };
  for (const l of matchingLeads(ctx, f)) {
    const s = summary.get(l.id); const rank = s?.status_rank ?? 0;
    t.people++;
    if (rank >= 1) t.contacted++;
    if (live(s?.pending_sender_ids).length) t.invited_pending++;
    if (live(s?.connected_sender_ids).length) t.connected++;
    if (live(s?.connected_via_our_invite_ids).length) t.connected_via_our_invites++;
    if (rank >= 4) t.replied++;
    if (rank >= 5) t.interested++;
    if (rank >= 6) t.meetings++;
    if (s?.status === 'do_not_contact') t.do_not_contact++;
    if (s?.status === 'bounced') t.bounced++;
    if (s?.status === 'wrote_to_us') t.wrote_to_us++;
  }
  return t;
}

const senderName = (s: Row) => s.display_name || s.public_identifier || s.owner_email || 'Account';

export function leadsByAccount(args: Row, ctx: Ctx): Row {
  wsGuard(ctx, args.p_ws);
  const includeRemoved = !!args.p_include_removed;
  const f = { ...(args.p_f ?? {}), include_removed: includeRemoved };
  const summary = new Map(ctx.store.t('outreach_lead_summary').map((s) => [s.lead_id, s]));
  const acc = new Map<string, { connected: Set<string>; ours: Set<string>; pending: Set<string>; contacted: Set<string>; replied: Set<string> }>();
  const get = (id: string) => { let a = acc.get(id); if (!a) { a = { connected: new Set(), ours: new Set(), pending: new Set(), contacted: new Set(), replied: new Set() }; acc.set(id, a); } return a; };
  for (const l of matchingLeads(ctx, f)) {
    const s = summary.get(l.id); if (!s) continue;
    for (const id of s.connected_sender_ids) get(id).connected.add(l.id);
    for (const id of s.connected_via_our_invite_ids) get(id).ours.add(l.id);
    for (const id of s.pending_sender_ids) get(id).pending.add(l.id);
    for (const id of s.contacted_sender_ids) get(id).contacted.add(l.id);
    for (const id of s.replied_sender_ids) get(id).replied.add(l.id);
  }
  const rows: Row[] = [];
  for (const [id, a] of acc) {
    const s = ctx.store.get('outreach_senders', id); if (!s) continue;
    const removed = isRemoved(s); if (removed && !includeRemoved) continue;
    const ch = channelOfProvider(s.provider); const conn = ch === 'linkedin' || ch === 'instagram';
    rows.push({ sender_id: id, name: senderName(s), picture_url: s.picture_url ?? null, provider: s.provider, channel: ch, removed,
      connected: conn ? a.connected.size : null, via_our_invite: conn ? a.ours.size : null, pending: conn ? a.pending.size : null, contacted: a.contacted.size, replied: a.replied.size });
  }
  rows.sort((x, y) => Number(x.removed) - Number(y.removed) || y.contacted - x.contacted || (y.connected ?? 0) - (x.connected ?? 0) || String(x.name).localeCompare(String(y.name)));
  return { rows, include_removed: includeRemoved, note: 'A lead connected to two accounts counts once in each row and once in the totals.' };
}

export function leadRelationships(args: Row, ctx: Ctx): Row[] {
  const l = ctx.store.get('outreach_leads', String(args.p_lead ?? ''));
  if (!l || l.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
  rebuildLeadSummary(ctx.store);
  const includeRemoved = !!args.p_include_removed;
  const chats = ctx.store.t('outreach_chats').filter((c) => c.lead_id === l.id && c.provider !== 'WEBCHAT');
  const consent = ctx.store.t('outreach_lead_consent').filter((c) => c.lead_id === l.id && !c.revoked_at);
  const idents = ctx.store.t('outreach_lead_identities').filter((i) => i.lead_id === l.id);
  const seen = new Set<string>();
  const out: Row[] = [];
  const push = (s: Row, x: Row | null) => {
    if (seen.has(s.id)) return; seen.add(s.id);
    const removed = isRemoved(s); if (removed && !includeRemoved) return;
    const ch = channelOfProvider(s.provider);
    const chatSince = chats.filter((c) => c.sender_id === s.id).map((c) => c.created_at).sort()[0] ?? null;
    const valid = idents.find((i) => i.provider === s.provider)?.is_valid ?? null;
    const connectedAt = x?.connected_at ?? x?.invite_accepted_at ?? null;
    const source = x?.relation === 'first' ? (x.relation_source ?? (x.invite_sent_at && Date.parse(x.invite_sent_at) <= Date.parse(connectedAt ?? x.updated_at ?? new Date().toISOString()) + MIN ? 'our_invite' : 'pre_existing')) : null;
    const state = ch === 'linkedin' || ch === 'instagram'
      ? (x?.relation === 'first' ? 'connected' : x?.relation === 'pending_out' ? 'pending' : x?.relation === 'pending_in' ? 'pending_in' : x?.relation === 'blocked' || x?.relation === 'invalid' ? x.relation : ch === 'instagram' && x?.follows_us ? 'follows_us' : x?.connected_at ? 'disconnected' : 'not_connected')
      : ch === 'whatsapp' ? (valid === false ? 'number_invalid' : chatSince || x?.last_outbound_at ? 'chat' : 'has_number')
      : (x?.email_bounced ? 'bounced' : x?.last_outbound_at ? 'emailed' : 'has_address');
    out.push({
      sender_id: s.id, name: senderName(s), picture_url: s.picture_url ?? null, provider: s.provider, channel: ch, removed, state,
      since: x?.relation === 'first' ? connectedAt : x?.relation === 'pending_out' ? x.invite_sent_at : chatSince, source,
      invite_sent_at: x?.invite_sent_at ?? null, invite_had_note: x?.invite_had_note ?? null, invite_withdrawn_at: x?.invite_withdrawn_at ?? null,
      connected_at: connectedAt, checked_at: x?.relation_checked_at ?? x?.updated_at ?? null, last_touch_at: x?.last_outbound_at ?? null, last_reply_at: x?.last_inbound_at ?? null,
      replied: x?.replied ?? false, consent: consent.find((c) => c.channel === s.provider)?.basis ?? null, we_follow: x?.we_follow ?? null, follows_us: x?.follows_us ?? null, chat_since: chatSince,
    });
  };
  for (const x of ctx.store.t('outreach_lead_sender_state').filter((r) => r.lead_id === l.id)) { const s = ctx.store.get('outreach_senders', x.sender_id); if (s) push(s, x); }
  for (const c of chats) { const s = ctx.store.get('outreach_senders', c.sender_id); if (s) push(s, null); }
  const order: Channel[] = ['linkedin', 'instagram', 'whatsapp', 'email'];
  out.sort((a, b) => Number(a.removed) - Number(b.removed) || order.indexOf(a.channel) - order.indexOf(b.channel) || String(a.name).localeCompare(String(b.name)));
  return out;
}

export function leadPromote(args: Row, ctx: Ctx): number {
  wsGuard(ctx, args.p_ws);
  const ids = new Set<string>(Array.isArray(args.p_lead_ids) ? args.p_lead_ids : []);
  if (ids.size > 10000) demoError('E_TOO_MANY', 'max 10000 per request');
  const now = ctx.now();
  const n = ctx.store.update('outreach_leads', (l) => l.workspace_id === ctx.ws && ids.has(l.id) && (!l.prospect_since || l.hidden_at), { prospect_since: now, hidden_at: null, hidden_reason: null, updated_at: now }).length;
  audit(ctx.store, ctx.ws, ctx.userId, 'leads.promote', 'lead', null, { count: n });
  return n;
}

export function leadHide(args: Row, ctx: Ctx): number {
  wsGuard(ctx, args.p_ws);
  const ids = new Set<string>(Array.isArray(args.p_lead_ids) ? args.p_lead_ids : []);
  if (ids.size > 10000) demoError('E_TOO_MANY', 'max 10000 per request');
  const hide = args.p_hide !== false; const now = ctx.now();
  const n = hide
    ? ctx.store.update('outreach_leads', (l) => l.workspace_id === ctx.ws && ids.has(l.id) && !l.hidden_at, { hidden_at: now, hidden_reason: 'manual', updated_at: now }).length
    : ctx.store.update('outreach_leads', (l) => l.workspace_id === ctx.ws && ids.has(l.id) && !!l.hidden_at, { hidden_at: null, hidden_reason: null, updated_at: now }).length;
  audit(ctx.store, ctx.ws, ctx.userId, hide ? 'leads.hide' : 'leads.unhide', 'lead', null, { count: n });
  return n;
}
