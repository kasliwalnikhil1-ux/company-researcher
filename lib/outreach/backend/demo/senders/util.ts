/**
 * Senders area helpers: the sender row defaults, status transitions (what the SQL trigger outreach_trg_sender_status and
 * the quiet-period trigger do), caps the way outreach_effective_cap computes them, Instagram's hourly / daily scopes and
 * the next working-hours slot. Pure store code: no network.
 */
import { demoError, type Ctx } from '../ctx';
import type { DemoStore, Row } from '../store';
import { inSchedule, localParts, METERED, simWallClock } from '../sim/caps';
import { engineFor, LIVE } from '../sim/engine';
import { rebuildBudgets } from '../sim/derived';

export const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);
export const isMail = (p: string | null | undefined) => !!p && MAIL.has(p);
/** Mail providers read the LinkedIn ceilings and warm-up rows (025). */
export const ceilingProvider = (p: string) => (MAIL.has(p) ? 'LINKEDIN' : p);
export const PROVIDER_LABEL: Record<string, string> = { LINKEDIN: 'LinkedIn', INSTAGRAM: 'Instagram', WHATSAPP: 'WhatsApp', GMAIL: 'Gmail', OUTLOOK: 'Outlook', IMAP: 'Email', WEBCHAT: 'Website' };
export const MIN = 60_000;
export const H = 3_600_000;
export const D = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString();

/** outreach_channel_capabilities as seeded by 025 (the table rows are written by seed/senders.ts when missing). */
const ALL_BASES = ['inbound', 'form_optin', 'existing_customer', 'linkedin_reply', 'explicit_share', 'imported_attested'];
const IG_TYPES = ['follow', 'unfollow', 'new_chat', 'message', 'like', 'comment', 'profile_view', 'followers_poll', 'post_fetch'];
const MAIL_SUPPORTS = { invite: false, inmail: false, follow: false, post_react: false, post_comment: false, profile_view: false, voice_note: false, attachment: true, embed_video: false, search_people: 'none' };
const MAIL_LEDGER = { hourly: null, daily_scope: null, min_gap_seconds: [30, 120], post_connect_quiet_hours: 0 };
const consent = (required: boolean) => ({ required_for_first_contact: required, accepted_bases: ALL_BASES });
export const CHANNEL_CAPS: Row[] = [
  { provider: 'LINKEDIN', identifier_kind: 'slug', has_connection_graph: true, connection_is_permission: true, acceptance_webhook: true, can_validate_identifier: false,
    supports: { invite: true, inmail: true, follow: true, post_react: true, post_comment: true, profile_view: true, voice_note: true, attachment: true, embed_video: true, search_people: 'full' },
    ledger: { hourly: null, daily_scope: null, min_gap_seconds: [90, 400], post_connect_quiet_hours: 0 }, consent: consent(false) },
  { provider: 'INSTAGRAM', identifier_kind: 'handle', has_connection_graph: false, connection_is_permission: false, acceptance_webhook: false, can_validate_identifier: false,
    supports: { invite: false, inmail: false, follow: true, post_react: true, post_comment: true, profile_view: true, voice_note: true, attachment: true, embed_video: false, search_people: 'partial' },
    ledger: { hourly: { scope: 'all_metered', cap: 10, types: IG_TYPES }, daily_scope: { scope: 'all_metered', types: IG_TYPES }, min_gap_seconds: [60, 240], post_connect_quiet_hours: 0 }, consent: consent(false) },
  { provider: 'WHATSAPP', identifier_kind: 'phone_e164', has_connection_graph: false, connection_is_permission: false, acceptance_webhook: false, can_validate_identifier: true,
    supports: { invite: false, inmail: false, follow: false, post_react: false, post_comment: false, profile_view: true, voice_note: true, attachment: true, embed_video: true, search_people: 'none' },
    ledger: { hourly: null, daily_scope: null, min_gap_seconds: [10, 20], post_connect_quiet_hours: 24 }, consent: consent(true) },
  ...['GMAIL', 'OUTLOOK', 'IMAP'].map((provider) => ({ provider, identifier_kind: 'email', has_connection_graph: false, connection_is_permission: false, acceptance_webhook: false, can_validate_identifier: false, supports: MAIL_SUPPORTS, ledger: MAIL_LEDGER, consent: consent(false) })),
];
/** outreach_channel_totals: Instagram's all-actions daily cap per warm-up level. */
export const CHANNEL_TOTALS: Record<string, number[]> = { INSTAGRAM: [15, 30, 50, 70, 85, 100] };

export function channelCaps(store: DemoStore, provider: string): Row | undefined {
  return store.t('outreach_channel_capabilities').find((c) => c.provider === provider) ?? CHANNEL_CAPS.find((c) => c.provider === provider);
}
export function channelTotal(store: DemoStore, provider: string, level: number): number | null {
  const row = store.t('outreach_channel_totals').find((c) => c.provider === provider && c.level === level);
  if (row) return row.per_day;
  const v = CHANNEL_TOTALS[provider]?.[level];
  return typeof v === 'number' ? v : null;
}

// ---------------------------------------------------------------------------
export function senderOr404(ctx: Ctx, id: unknown): Row {
  const s = typeof id === 'string' ? ctx.store.get('outreach_senders', id) : undefined;
  if (!s || s.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Sender not found');
  return s;
}

/** outreach_sender_events rows have a bigint id. */
export function addEvent(store: DemoStore, senderId: string, kind: string, data: Row | null, at?: string): Row {
  let max = 0;
  for (const e of store.t('outreach_sender_events')) if (typeof e.id === 'number' && e.id > max) max = e.id;
  return store.insert('outreach_sender_events', { id: max + 1, sender_id: senderId, kind, data, at: at ?? store.nowIso() }, { noId: true })[0];
}

/**
 * A status change with the side effects of the SQL triggers: a status event, reserved actions back to queued, the
 * reconnect bookkeeping, the WhatsApp quiet period, and for `disabled` every live enrollment exits and queued actions stop.
 */
export function setStatus(store: DemoStore, s: Row, status: string, reason: string | null, extra: Row = {}): Row {
  const from = s.status;
  const nowMs = Date.now();
  const patch: Row = { status, status_reason: reason, ...extra };
  if (from !== status) {
    addEvent(store, s.id, 'status', { from, to: status, reason });
    if (status !== 'ok') store.update('outreach_actions', (a) => a.sender_id === s.id && a.status === 'reserved', { status: 'queued', reserved_at: null }, { silent: true });
    if (status === 'ok') {
      patch.last_ok_at = iso(nowMs); patch.reconnect_attempts = 0;
      if (from === 'connecting') patch.connected_at = s.connected_at ?? iso(nowMs);
      if (['connecting', 'credentials', 'error'].includes(from)) {
        const hrs = Number(channelCaps(store, s.provider)?.ledger?.post_connect_quiet_hours ?? 0);
        if (hrs > 0) {
          patch.outreach_allowed_from = iso(nowMs + hrs * H);
          addEvent(store, s.id, 'quiet_period', { until: patch.outreach_allowed_from, hours: hrs, from_status: from });
        } else patch.outreach_allowed_from = null;
      }
    } else if (status === 'credentials' || status === 'error') {
      patch.last_disconnect_at = iso(nowMs);
    } else if (status === 'disabled') {
      const engine = engineFor(store);
      for (const e of store.t('outreach_enrollments').filter((x) => x.sender_id === s.id && LIVE.includes(x.status))) engine.exit(e, 'exited_sender_disabled', 'sender_disabled', nowMs);
      store.update('outreach_actions', (a) => a.sender_id === s.id && (a.status === 'queued' || a.status === 'reserved'), { status: 'cancelled', decision: 'sender_disabled' });
      engine.resetIndexes();
    }
  }
  return store.update('outreach_senders', s.id, patch)[0] ?? s;
}

/** Deleted senders leave every sequence pool (032 outreach_sender_left_pools). */
export function dropFromPools(store: DemoStore, senderId: string): number {
  const rows = store.update('outreach_sequences', (q) => Array.isArray(q.sender_pool) && q.sender_pool.includes(senderId), (q) => {
    const pool = (q.sender_pool as string[]).filter((x) => x !== senderId);
    const pools: Row = {};
    for (const id of pool) { const p = store.get('outreach_senders', id)?.provider; if (p) (pools[p] ??= []).push(id); }
    return { sender_pool: pool, sender_pools: pools, updated_at: store.nowIso() };
  });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------
/** outreach_effective_cap: least(ceiling, warm-up level cap, manual cap), × 0.6 below health 70, 0 below 50. */
export function effectiveCap(store: DemoStore, s: Row, type: string): number {
  const cp = ceilingProvider(s.provider);
  const ceil = store.t('outreach_platform_ceilings').find((c) => c.provider === cp && c.action_type === type)?.per_day;
  if (typeof ceil !== 'number') return 0;
  if (['reply', 'call_api', 'relations_poll', 'find_email'].includes(type)) return ceil;
  const warm = store.t('outreach_warmup_caps').find((w) => w.provider === cp && w.level === (s.warmup_level ?? 0) && w.action_type === type)?.per_day;
  let base = Math.min(ceil, typeof warm === 'number' ? warm : ceil);
  const man = s.manual_caps?.[type];
  if (typeof man === 'number') base = Math.min(base, Math.max(man, 0));
  const health = Number(s.health_score ?? 100);
  const mult = health < 50 ? 0 : health < 70 ? 0.6 : 1;
  return Math.floor(base * mult);
}

/** outreach_effective_total_cap: Instagram's daily all-actions cap, or null where the channel has none. */
export function effectiveTotalCap(store: DemoStore, s: Row): number | null {
  const caps = channelCaps(store, s.provider);
  const scope = caps?.ledger?.daily_scope;
  if (!scope || typeof scope !== 'object') return null;
  let tot = channelTotal(store, s.provider, s.warmup_level ?? 0);
  if (tot == null) return null;
  const man = s.manual_caps?.[scope.scope];
  if (typeof man === 'number') tot = Math.min(tot, Math.max(man, 0));
  const health = Number(s.health_score ?? 100);
  return Math.floor(tot * (health < 50 ? 0 : health < 70 ? 0.6 : 1));
}

/** Today's budget rows of a sender (computed from the actions, sim/derived.ts). */
export function todayBudgets(store: DemoStore, s: Row): Row[] {
  rebuildBudgets(store);
  const today = localParts(Date.now(), s.timezone ?? 'UTC').day;
  return store.t('outreach_sender_budgets').filter((b) => b.sender_id === s.id && b.day === today);
}

const metered = (a: Row) => (a.status === 'sent' || a.status === 'reserved') && !!a.executed_at && METERED.has(a.action_type);

/** Instagram's scoped windows: {day, hour} like outreach_sender_scopes_today. */
export function scopesToday(store: DemoStore, s: Row): { day: Row | null; hour: Row | null } {
  const caps = channelCaps(store, s.provider);
  const nowMs = Date.now();
  let day: Row | null = null;
  let hour: Row | null = null;
  const ledger = caps?.ledger ?? {};
  const mine = store.t('outreach_actions').filter((a) => a.sender_id === s.id && metered(a));
  if (ledger.daily_scope && typeof ledger.daily_scope === 'object') {
    const types = new Set<string>(ledger.daily_scope.types ?? []);
    const today = localParts(nowMs, s.timezone ?? 'UTC').day;
    const used = mine.filter((a) => types.has(a.action_type) && localParts(Date.parse(a.executed_at), s.timezone ?? 'UTC').day === today).length;
    const cap = effectiveTotalCap(store, s) ?? 0;
    day = { scope: ledger.daily_scope.scope, day_start: dayStartIso(nowMs, s.timezone ?? 'UTC'), cap, used, reserved: 0, remaining: Math.max(cap - used, 0) };
  }
  if (ledger.hourly && typeof ledger.hourly === 'object') {
    const types = new Set<string>(ledger.hourly.types ?? []);
    const hs = Math.floor(nowMs / H) * H;
    const used = mine.filter((a) => types.has(a.action_type) && Date.parse(a.executed_at) >= hs).length;
    const cap = Number(s.health_score ?? 100) < 50 ? 0 : Number(ledger.hourly.cap ?? 0);
    hour = { scope: ledger.hourly.scope, hour_start: iso(hs), cap, used, reserved: 0, remaining: Math.max(cap - used, 0) };
  }
  return { day, hour };
}

/** The instant the sender's local day began. */
export function dayStartIso(ms: number, tz: string): string {
  const { minutes } = localParts(ms, tz);
  return iso(Math.floor((ms - minutes * MIN) / MIN) * MIN);
}

/** Working hours are judged on the demo's simulated wall clock (real now + the simulator's offset), like the engine. */
export const inHours = (store: DemoStore, s: Row, ms: number) => inSchedule(s, simWallClock(store, ms));

/** Next moment (≥ from, real-clock ms) inside the sender's working hours, scanning 5-minute steps; null when none in `days`. */
export function nextInSchedule(store: DemoStore, s: Row, fromMs: number, days = 8): number | null {
  const step = 5 * MIN;
  const start = Math.ceil(fromMs / step) * step;
  for (let t = start; t < fromMs + days * D; t += step) if (inHours(store, s, t)) return t;
  return null;
}

/** 'Mon DD HH24:MI' / 'Dy HH24:MI' style times in a timezone (the SQL to_char formats). */
export function fmtTime(ms: number, tz: string, style: 'date_time' | 'weekday_time' | 'date' = 'date_time'): string {
  try {
    const o: Intl.DateTimeFormatOptions = style === 'weekday_time' ? { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : style === 'date' ? { month: 'short', day: '2-digit' } : { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    return new Intl.DateTimeFormat('en-US', { ...o, timeZone: tz || 'UTC' }).format(new Date(ms)).replace(',', '');
  } catch { return iso(ms).slice(0, 16).replace('T', ' '); }
}


/** Hex string of n random bytes (seeded). */
export function randomHex(store: DemoStore, bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i++) out += store.int(0, 255).toString(16).padStart(2, '0');
  return out;
}
