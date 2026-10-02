/**
 * Daily limits and working hours, the way the engine applies them: the cap of an action type is the sender's manual
 * cap, else the warm-up level's cap, never above the platform ceiling. Usage is counted from `outreach_actions`, so the
 * budgets the Senders page shows and the pace of the simulator always agree.
 */
import type { DemoStore, Row } from '../store';

export const METERED = new Set(['invite', 'message', 'inmail', 'profile_view', 'like', 'comment', 'endorse', 'withdraw', 'email', 'follow', 'unfollow', 'new_chat', 'find_email', 'identifier_check', 'story_react']);

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function capFor(store: DemoStore, sender: Row, type: string): number {
  const provider = sender.provider === 'GMAIL' || sender.provider === 'OUTLOOK' || sender.provider === 'IMAP' ? 'LINKEDIN' : sender.provider;
  const manual = sender.manual_caps?.[type];
  const warm = store.t('outreach_warmup_caps').find((w) => w.provider === provider && w.level === (sender.warmup_level ?? 3) && w.action_type === type)?.per_day;
  const ceiling = store.t('outreach_platform_ceilings').find((c) => c.provider === provider && c.action_type === type)?.per_day;
  let cap = typeof manual === 'number' ? manual : typeof warm === 'number' ? warm : type === 'email' ? 80 : 30;
  if (typeof ceiling === 'number') cap = Math.min(cap, ceiling);
  return cap;
}

/** Local date (YYYY-MM-DD) and weekday/minutes in a timezone. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const memo = new Map<string, { day: string; wd: (typeof DAY_KEYS)[number]; minutes: number }>();
export function localParts(ms: number, tz: string): { day: string; wd: (typeof DAY_KEYS)[number]; minutes: number } {
  const key = `${tz}|${Math.floor(ms / 60_000)}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const r = computeParts(ms, tz);
  if (memo.size > 50_000) memo.clear();
  memo.set(key, r);
  return r;
}
function computeParts(ms: number, tz: string): { day: string; wd: (typeof DAY_KEYS)[number]; minutes: number } {
  try {
    let f = formatters.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }); formatters.set(tz, f); }
    const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const wd = String(parts.weekday).slice(0, 3).toLowerCase() as (typeof DAY_KEYS)[number];
    return { day: `${parts.year}-${parts.month}-${parts.day}`, wd, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  } catch {
    const d = new Date(ms);
    return { day: d.toISOString().slice(0, 10), wd: DAY_KEYS[d.getUTCDay()], minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}

/**
 * The demo's wall clock: real now plus the simulated offset. Time moves by shifting stored timestamps back, so the real
 * clock never reaches a sender's working hours by itself; working hours are judged on this clock instead.
 */
export function simWallClock(store: DemoStore, ms: number): number {
  return ms + (store.state.simOffsetMs ?? 0);
}

export function inSchedule(sender: Row, ms: number): boolean {
  const sched = sender.schedule as Record<string, [string, string][]> | undefined;
  if (!sched) return true;
  const { wd, minutes } = localParts(ms, sender.timezone ?? 'UTC');
  const windows = sched[wd] ?? [];
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
  return windows.some(([a, b]) => minutes >= toMin(a) && minutes < toMin(b));
}

/** Per-day usage counter, rebuilt from the actions table (cheap) after a time shift. */
export class Ledger {
  private used = new Map<string, number>();
  constructor(private store: DemoStore) { this.rebuild(); }
  private key(senderId: string, day: string, type: string) { return `${senderId}|${day}|${type}`; }
  rebuild() {
    this.used.clear();
    const tz = new Map(this.store.t('outreach_senders').map((s) => [s.id, s.timezone ?? 'UTC']));
    for (const a of this.store.t('outreach_actions')) {
      if (a.status !== 'sent' || !a.executed_at || !METERED.has(a.action_type)) continue;
      const day = localParts(Date.parse(a.executed_at), tz.get(a.sender_id) ?? 'UTC').day;
      const k = this.key(a.sender_id, day, a.action_type);
      this.used.set(k, (this.used.get(k) ?? 0) + 1);
    }
  }
  usedOn(sender: Row, ms: number, type: string): number {
    return this.used.get(this.key(sender.id, localParts(ms, sender.timezone ?? 'UTC').day, type)) ?? 0;
  }
  add(sender: Row, ms: number, type: string) {
    const k = this.key(sender.id, localParts(ms, sender.timezone ?? 'UTC').day, type);
    this.used.set(k, (this.used.get(k) ?? 0) + 1);
  }
  /** Room left today for this action type (Infinity for unmetered types). */
  room(sender: Row, ms: number, type: string): number {
    if (!METERED.has(type)) return Infinity;
    return capFor(this.store, sender, type) - this.usedOn(sender, ms, type);
  }
  /** All (day, type) usage of a sender, for the budgets table. */
  entries(senderId: string): Array<{ day: string; type: string; used: number }> {
    const out: Array<{ day: string; type: string; used: number }> = [];
    for (const [k, v] of this.used) { const [s, day, type] = k.split('|'); if (s === senderId) out.push({ day, type, used: v }); }
    return out;
  }
}
