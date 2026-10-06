/**
 * Demo handlers: reply alerts (reply-notifications-PRD.md §11 "Product tour demo": no permission prompt, no real
 * notifications; the settings page saves locally).
 * Owns: alert_pref_set, alert_settings_get, alert_settings_save, alerts_mark_chat_read, push_subscribe, push_subscriptions_list, push_unsubscribe
 */
import { demoError, type Ctx, type RpcArea, type RpcHandler } from '../ctx';
import { NOTIFICATIONS, PREFS } from '../inbox/shared';
import type { Row } from '../store';

const SETTINGS = 'outreach_notification_settings';
const KINDS = ['reply_new', 'webchat_message', 'note_mention', 'ai_handoff', 'assigned'] as const;
const SOUNDS = ['ping', 'chime', 'pop', 'knock'];
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function settingsRow(ctx: Ctx): Row | undefined {
  return ctx.store.t(SETTINGS).find((r) => r.user_id === ctx.userId && r.workspace_id === ctx.ws);
}

function windowOpen(q: Row | null | undefined, at: Date): boolean {
  if (!q) return true;
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: q.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at).map((p) => [p.type, p.value]));
  } catch { return true; }
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  const prev = dow === 1 ? 7 : dow - 1;
  const t = `${parts.hour}:${parts.minute}`;
  const days: number[] = Array.isArray(q.days) ? q.days : [1, 2, 3, 4, 5, 6, 7];
  if (q.start === q.end) return days.includes(dow);
  if (q.start < q.end) return days.includes(dow) && t >= q.start && t < q.end;
  return (days.includes(dow) && t >= q.start) || (days.includes(prev) && t < q.end);
}

function settingsGet(ctx: Ctx): Row {
  const s = settingsRow(ctx) ?? {};
  const kinds: Row = {};
  for (const k of KINDS) {
    const p = ctx.store.t(PREFS).find((x) => x.user_id === ctx.userId && x.workspace_id === ctx.ws && x.kind === k);
    kinds[k] = { desktop: p?.push ?? true, sound: p?.sound ?? k !== 'assigned' };
  }
  const now = new Date();
  const paused = !!s.paused_until && (s.paused_until === 'infinity' || Date.parse(s.paused_until) > now.getTime());
  return {
    scope: s.scope ?? 'mine_unassigned', include_ai_handled: s.include_ai_handled ?? false, sound_enabled: s.sound_enabled ?? false,
    sound_name: s.sound_name ?? 'ping', sound_volume: s.sound_volume ?? 70, show_preview: s.show_preview ?? true, alert_when_visible: s.alert_when_visible ?? false,
    quiet_hours: s.quiet_hours ?? null, paused_until: s.paused_until ?? null, enabled_at: s.enabled_at ?? null,
    prompt_dismissed_at: s.prompt_dismissed_at ?? null, prompt_dismiss_count: s.prompt_dismiss_count ?? 0,
    kinds, muted: paused || !windowOpen(s.quiet_hours, now), now: now.toISOString(),
  };
}

const save: RpcHandler = (a, ctx) => {
  const p = (a.p_patch ?? {}) as Row;
  if (typeof p !== 'object' || Array.isArray(p)) demoError('E_PAYLOAD_INVALID', 'patch');
  const s: Row = { ...(settingsRow(ctx) ?? { user_id: ctx.userId, workspace_id: ctx.ws, prompt_dismiss_count: 0 }) };
  if ('scope' in p) { if (!['mine', 'mine_unassigned', 'all'].includes(p.scope)) demoError('E_PAYLOAD_INVALID', 'scope'); s.scope = p.scope; }
  for (const k of ['include_ai_handled', 'sound_enabled', 'show_preview', 'alert_when_visible']) if (k in p) s[k] = !!p[k];
  if ('sound_name' in p) { if (!SOUNDS.includes(p.sound_name)) demoError('E_PAYLOAD_INVALID', 'sound_name'); s.sound_name = p.sound_name; }
  if ('sound_volume' in p) {
    const v = Number(p.sound_volume);
    if (!Number.isFinite(v) || v < 0 || v > 100) demoError('E_PAYLOAD_INVALID', 'sound_volume');
    s.sound_volume = Math.round(v);
  }
  if ('quiet_hours' in p) {
    const q = p.quiet_hours as Row | null;
    if (q == null) s.quiet_hours = null;
    else {
      if (!HHMM.test(String(q.start)) || !HHMM.test(String(q.end))) demoError('E_PAYLOAD_INVALID', 'quiet_hours start / end (HH:MM)');
      const days = Array.isArray(q.days) ? [...new Set(q.days.map(Number))].filter((d) => d >= 1 && d <= 7).sort() : [1, 2, 3, 4, 5, 6, 7];
      if (!days.length) demoError('E_PAYLOAD_INVALID', 'quiet_hours days');
      s.quiet_hours = { days, start: q.start, end: q.end, tz: String(q.tz || 'UTC') };
    }
  }
  if ('paused_until' in p) {
    const v = p.paused_until;
    if (v == null) s.paused_until = null;
    else if (v === 'infinity') s.paused_until = 'infinity';
    else {
      const t = Date.parse(String(v));
      if (!Number.isFinite(t)) demoError('E_PAYLOAD_INVALID', 'paused_until');
      if (t > Date.now() + 31 * 86_400_000) demoError('E_PAYLOAD_INVALID', 'pause for at most 31 days, or until turned back on');
      s.paused_until = t <= Date.now() ? null : new Date(t).toISOString();
    }
  }
  if (p.enabled === true) s.enabled_at = s.enabled_at ?? ctx.now();
  if (p.prompt === 'dismissed') { s.prompt_dismissed_at = ctx.now(); s.prompt_dismiss_count = Math.min(Number(s.prompt_dismiss_count ?? 0) + 1, 99); }
  else if (p.prompt === 'answered') { s.prompt_dismissed_at = s.prompt_dismissed_at ?? ctx.now(); s.prompt_dismiss_count = Math.max(Number(s.prompt_dismiss_count ?? 0), 2); }
  s.updated_at = ctx.now();
  ctx.store.upsert(SETTINGS, s, ['user_id', 'workspace_id']);
  return settingsGet(ctx);
};

export const alertsRpc = {
  alert_settings_get: (_a, ctx) => settingsGet(ctx),
  alert_settings_save: save,
  alert_pref_set: (a, ctx) => {
    if (!(KINDS as readonly string[]).includes(a.p_kind)) demoError('E_PAYLOAD_INVALID', 'kind');
    const cur = ctx.store.t(PREFS).find((x) => x.user_id === ctx.userId && x.workspace_id === ctx.ws && x.kind === a.p_kind);
    ctx.store.upsert(PREFS, {
      user_id: ctx.userId, workspace_id: ctx.ws, kind: a.p_kind,
      push: a.p_desktop ?? cur?.push ?? true, sound: a.p_sound ?? cur?.sound ?? null,
      email: cur?.email ?? true, email_delay_min: cur?.email_delay_min ?? 10, updated_at: ctx.now(),
    }, ['user_id', 'workspace_id', 'kind']);
    return settingsGet(ctx);
  },
  alerts_mark_chat_read: (a, ctx) => ctx.store.update(NOTIFICATIONS,
    (x) => x.user_id === ctx.userId && x.chat_id === a.p_chat && !x.read_at && ['reply_new', 'webchat_message', 'assigned'].includes(x.kind), { read_at: ctx.now() }).length,
  // the tour never subscribes a browser (no service worker, no permission prompt)
  push_subscribe: () => demoError('E_DEMO', 'Desktop notifications are switched off in the product tour.'),
  push_unsubscribe: () => 0,
  push_subscriptions_list: () => [],
} satisfies RpcArea;

export function registerAlerts(): void { /* no table hooks */ }
