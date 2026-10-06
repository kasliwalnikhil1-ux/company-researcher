/**
 * The demo's moving time. While activity is On and the tab is visible, every 4 s of real time is 2 simulated hours
 * (Fast: 8 hours); "Skip a day" is 24 hours at once. Time moves by shifting every stored timestamp back by the step,
 * so "now" stays the real now: past events recede, waits fall due, and the engine runs whatever became due.
 * The simulator stops when the tab is hidden, when activity is Paused, or when no sequence is running.
 */
import { sendDueHolds } from '../aihub/replies';
import type { DemoStore, Row } from '../store';
import { engineFor } from './engine';
import { runRule } from '../sequences/rules';

export type SimMode = 'on' | 'paused' | 'fast';

const TICK_MS = 4000;
const STEP_MS = 2 * 3_600_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
/** Counter tables rebuilt from other rows, and reference tables with no time in them. */
const SKIP_TABLES = new Set(['outreach_node_stats', 'outreach_sender_budgets', 'outreach_warmup_caps', 'outreach_platform_ceilings', 'outreach_channel_capabilities']);

function shiftValue(v: unknown, ms: number, depth: number): unknown {
  if (typeof v === 'string') return ISO.test(v) ? new Date(Date.parse(v) - ms).toISOString() : v;
  if (depth > 2 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = shiftValue(v[i], ms, depth + 1); return v; }
  for (const k of Object.keys(v as Row)) (v as Row)[k] = shiftValue((v as Row)[k], ms, depth + 1);
  return v;
}

/** Moves every timestamp of the demo `ms` into the past (silently: open screens refresh on their own schedule). */
export function shiftTime(store: DemoStore, ms: number) {
  for (const [name, rows] of Object.entries(store.state.tables)) {
    if (SKIP_TABLES.has(name)) continue;
    for (const r of rows) for (const k of Object.keys(r)) r[k] = shiftValue(r[k], ms, 0);
  }
  store.state.simOffsetMs += ms;
  store.touch();
}

export class Simulator {
  mode: SimMode = 'on';
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();

  constructor(private store: DemoStore) {
    const saved = store.state.meta.simMode as SimMode | undefined;
    if (saved === 'on' || saved === 'paused' || saved === 'fast') this.mode = saved;
  }

  /** Simulated days since the demo started. */
  get day(): number { return Math.floor(this.store.state.simOffsetMs / 86_400_000); }

  onTick(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  setMode(m: SimMode) { this.mode = m; this.store.setMeta('simMode', m); this.emit(); }

  hasRunning(): boolean {
    const active = new Set(this.store.t('outreach_sequences').filter((s) => s.status === 'active').map((s) => s.id));
    return this.store.t('outreach_enrollments').some((e) => active.has(e.sequence_id) && ['active', 'waiting_connection', 'waiting_delay'].includes(e.status))
      || this.store.t('_demo_sim_events').length > 0;
  }

  start() {
    if (this.timer || typeof window === 'undefined') return;
    this.timer = setInterval(() => {
      if (this.mode === 'paused' || document.visibilityState !== 'visible' || !this.hasRunning()) return;
      this.advance(this.mode === 'fast' ? 4 * STEP_MS : STEP_MS);
    }, TICK_MS);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Moves time forward by `ms` in 2-hour steps (so daily limits and working hours still pace the sending). */
  advance(ms: number) {
    const engine = engineFor(this.store);
    for (let left = ms; left > 0; left -= STEP_MS) {
      const step = Math.min(STEP_MS, left);
      shiftTime(this.store, step);
      engine.ledger.rebuild();
      this.dailyJobs();
      engine.run(Date.now());
      // Auto replies whose hold the clock moved past go out (they leave Sent · Scheduled)
      sendDueHolds(this.store);
    }
    // the step numbers are computed (sim/derived.ts): tell open sequence pages to refetch them
    for (const s of this.store.t('outreach_sequences')) this.store.emit({ table: 'outreach_node_stats', eventType: 'UPDATE', new: { sequence_id: s.id }, old: null });
    this.emit();
  }

  skipDay() { this.advance(24 * 3_600_000); }

  /** Once per simulated day, what the product's cron does every morning: run the active auto-enrol rules. */
  private dailyJobs() {
    const day = new Date(Date.now() + this.store.state.simOffsetMs).toISOString().slice(0, 10);
    if (this.store.state.meta.simDay === day) return;
    this.store.state.meta.simDay = day;
    for (const r of this.store.t('outreach_auto_enroll_rules')) {
      if (!r.active) continue;
      try { runRule(this.store, r, null, `sim:${day}`); } catch (e) { console.error('[demo] auto-enrol rule failed', e); }
    }
  }

  private emit() { for (const l of this.listeners) { try { l(); } catch (e) { console.error(e); } } }
}
