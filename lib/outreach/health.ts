/**
 * The Health page's types and helpers (health-page-PRD.md §3). The data comes from the outreach_health_* RPCs; the
 * guides are in ./health-guides.ts. Everything here is pure: link filling, the Claude prompt, the glossary.
 */
import { GUIDES, type Guide, type GuideLink } from './health-guides';

export type HealthStatus = 'ok' | 'watch' | 'act' | 'unknown';
export type HealthArea = 'database' | 'jobs' | 'functions' | 'flow' | 'services' | 'ai' | 'app' | 'system';

export interface SparkPoint { t: string; v: number | null; s: HealthStatus }

export interface HealthCheck {
  key: string; area: HealthArea; name: string; question: string; unit: string | null;
  watch_at: number | null; act_at: number | null; immediate: boolean; urgent: boolean; guide: string; source: string;
  every_minutes: number; enabled: boolean; snoozed_until: string | null; snooze_reason: string | null;
  status: HealthStatus; since: string | null; value: number | null; summary: string; error: string | null;
  pending: string | null; last_run_at: string | null; alerted_at: string | null;
  evidence: Record<string, unknown> | null; spark: SparkPoint[];
  recent?: Array<{ at: string; value: number | null; status: HealthStatus }>;
}

export interface HealthSettings {
  supabase_plan: 'free' | 'pro'; compute_size: string; email_to: string[]; email_hour: number; time_zone: string;
  urgent_email: boolean; ai_monthly_budget_usd: number | null; ai_price_in_per_m: number; ai_price_out_per_m: number;
  has_paying_customers: boolean; last_daily_email_on: string | null; updated_at: string;
}

export interface UpgradeReasons { fix_first: string | null; heavy_days_of_7: number; metrics_days: Record<string, unknown> | null; plan: string; compute_size: string; has_paying_customers: boolean; free_limit_past_70: boolean; usage_over: Array<Record<string, unknown>> }
export interface UpgradeAnswer { answer: 'no' | 'fix_first' | 'upgrade_compute' | 'move_to_pro' | 'higher_bill'; text: string; reasons: UpgradeReasons | null; at: string }

export interface HealthOverview {
  last_run_at: string | null; stale: boolean; run: { ran: number; errors: string[] } | null;
  verdict: HealthStatus; counts: { act: number; watch: number; ok: number; unknown: number; snoozed: number; off: number; total: number };
  checks: HealthCheck[]; upgrade: UpgradeAnswer | null; daily: { figures: unknown; for: string } | null;
  collect: { at: string; value: Record<string, string> } | null; settings: HealthSettings;
}

export interface UsageRow {
  key: string; grp: string; label: string; limit: number | null; unit: string | null; plan: string; note: string | null;
  used: number | null; pct: number | null; reached_on: string | null; month_estimate: number | null;
  measured_by: string; manual: boolean; used_manual_at: string | null; source_url: string | null; checked_on: string | null;
}
export interface HealthUsage {
  plan: string; compute_size: string; rows: UsageRow[];
  compute: Array<{ key: string; label: string; connections: number; note: string }>;
  connections: { max: number; in_use: number };
  customers: Array<{ workspace_id: string; workspace: string; plan: string; flags: string[]; ai_stopped: boolean }>;
  upgrade: UpgradeAnswer | null; manual_age_days: number | null; recheck_due: boolean | null;
}

export interface StuckSignal { code: string; since: string; route: string; detail: Record<string, unknown> }
export interface StuckUser { workspace_id: string; name: string; signal_count: number; signals: StuckSignal[]; since: string; route: string }
export interface StuckRoute { route: string; signals: number; workspaces: number; codes: Record<string, number> }
export interface HealthStuck { who: StuckUser[]; where: StuckRoute[] }

export const AREA_LABELS: Record<HealthArea, string> = {
  database: 'Database', jobs: 'Scheduled jobs', functions: 'Functions', flow: 'Messages in and out', services: 'Outside services', ai: 'AI', app: 'App', system: 'The checks themselves',
};
export const AREA_ORDER: HealthArea[] = ['database', 'jobs', 'functions', 'flow', 'services', 'ai', 'app', 'system'];

export const STATUS_LABELS: Record<HealthStatus, string> = { ok: 'Fine', watch: 'Watch', act: 'Act now', unknown: "Couldn't check" };
export const STATUS_DOT: Record<HealthStatus, string> = { ok: 'bg-emerald-500', watch: 'bg-amber-500', act: 'bg-red-500', unknown: 'bg-gray-300' };
export const STATUS_TEXT: Record<HealthStatus, string> = { ok: 'text-emerald-700', watch: 'text-amber-700', act: 'text-red-700', unknown: 'text-gray-500' };
export const STATUS_RANK: Record<HealthStatus, number> = { act: 3, watch: 2, unknown: 1, ok: 0 };

/** The eight words with a one-line meaning (§3.3). */
export const GLOSSARY: Record<string, string> = {
  connection: 'One open line between the app (or a function) and the database. Each takes memory; there is a fixed number.',
  index: 'A lookup table the database keeps so a query can find rows without reading the whole table.',
  'scheduled job': 'Work the database starts on a timer (cron), like "every 10 seconds, send due messages".',
  webhook: 'A call an outside service makes to us when something happens, such as a reply arriving.',
  queue: 'A list of work waiting to be done, taken in order by a job.',
  'compute size': 'How much CPU and memory the database server has. Bigger sizes cost more and handle more.',
  egress: 'Data sent out of Supabase to browsers and other services, billed by the gigabyte.',
  'row-level security': 'Database rules that decide which rows each signed-in person may see.',
};

/** The Supabase project ref, from the public URL (the build fills `{ref}` in links; `{org}` opens the picker). */
export function projectRef(): string {
  const u = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(u);
  return m ? m[1] : '';
}
export function fillLink(url: string, org?: string | null): string {
  return url.replace('{ref}', projectRef() || '_').replace('{org}', org || '_');
}
export function guideLinks(guide: Guide): GuideLink[] {
  return guide.links.map((l) => ({ ...l, url: l.kind === 'supabase' ? fillLink(l.url) : l.url }));
}
export function guideOf(check: HealthCheck): Guide | null { return GUIDES[check.guide] ?? null; }

/** A value with its unit, the way the card shows it. */
export function fmtValue(v: number | null | undefined, unit: string | null): string {
  if (v == null) return '—';
  const n = Number.isInteger(v) ? v.toLocaleString('en-US') : String(Math.round(v * 10) / 10);
  switch (unit) {
    case '%': return `${n}%`;
    case 'ms': return `${n} ms`;
    case 'seconds': return `${n} s`;
    case 'minutes': return `${n} min`;
    case 'hours': return `${n} h`;
    case 'bytes': return fmtBytes(v);
    default: return n;
  }
}
export function fmtBytes(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}
export function fmtUsage(v: number | null | undefined, unit: string | null): string {
  if (v == null) return '—';
  if (unit === 'bytes') return fmtBytes(v);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} M`;
  return fmtValue(v, unit);
}

/** "the number, then the limit it's compared with" (§3.3). */
export function limitText(c: HealthCheck): string {
  const parts: string[] = [];
  if (c.watch_at != null) parts.push(`watch at ${fmtValue(c.watch_at, c.unit)}`);
  if (c.act_at != null) parts.push(`act at ${fmtValue(c.act_at, c.unit)}`);
  return parts.join(', ');
}

/** The "what to do" line: the guide's first matching row when the summary names nothing, else a plain instruction. */
export function whatToDo(c: HealthCheck): string {
  if (c.status === 'ok') return 'Nothing.';
  if (c.status === 'unknown') return c.error ? `Fix the check first: ${c.error}` : 'The source did not answer. Open it by hand with the link under Look closer.';
  const g = guideOf(c);
  const first = g?.read?.[0];
  return first ? `${first.do}${first.next ? ` (guide ${first.next})` : ''}. Look closer for which rows.` : 'Look closer for the evidence and the steps.';
}

/** Compact evidence lines for a prompt or an email: the first rows of each list, ids and query text left out. */
export function evidenceLines(ev: Record<string, unknown> | null | undefined, max = 5): string[] {
  if (!ev) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(ev)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
      const rows = (v as Array<Record<string, unknown>>).slice(0, max).map((r) => Object.entries(r).filter(([kk]) => !/_id$/.test(kk) && kk !== 'samples').map(([kk, vv]) => `${kk} ${typeof vv === 'object' ? JSON.stringify(vv) : String(vv ?? '')}`).join(', '));
      out.push(`- ${k.replace(/_/g, ' ')}: ${rows.join(' · ')}${v.length > max ? ` · and ${v.length - max} more` : ''}`);
    } else if (Array.isArray(v) && v.length && typeof v[0] !== 'object') {
      out.push(`- ${k.replace(/_/g, ' ')}: ${(v as unknown[]).slice(0, max).join(', ')}`);
    } else if (v != null && typeof v !== 'object' && k !== 'live_query') {
      out.push(`- ${k.replace(/_/g, ' ')}: ${String(v)}`);
    }
  }
  return out;
}

const PRODUCT = 'GrowthxAI Outreach';

/** The prompt behind "Copy prompt for Claude" (§3.5). Fixed shape; the last paragraph is always there. */
export function claudePrompt(c: HealthCheck, tz = 'Asia/Kolkata'): string {
  const status = c.status === 'act' ? 'red' : c.status === 'watch' ? 'amber' : c.status === 'unknown' ? 'grey (could not run)' : 'green';
  const since = c.since ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(c.since)) : '—';
  const g = guideOf(c);
  const limit = c.act_at != null ? `Limit: ${fmtValue(c.act_at, c.unit)}.` : c.watch_at != null ? `Watch line: ${fmtValue(c.watch_at, c.unit)}.` : '';
  const ev = evidenceLines(c.evidence);
  const meaning = g?.read?.[0] ? `${g.read[0].means}.` : '';
  return [
    `Health check "${c.name}" (${c.key}) is ${status} on ${PRODUCT}.`,
    `Value: ${c.summary} ${limit}`.trim(),
    `${c.status === 'act' ? 'Red' : c.status === 'watch' ? 'Amber' : 'Status'} since: ${since}.`,
    c.error ? `Why it could not run: ${c.error}` : '',
    '',
    'Evidence:',
    ...(ev.length ? ev : ['- (none recorded)']),
    '',
    meaning ? `What the guide says this usually means: ${meaning}` : '',
    '',
    'Find the cause in the code and the data, explain it to me in plain words, and',
    'propose the smallest fix. Don\'t change sending limits or resend anything',
    'without asking me first.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

/** Prompt for a stuck-users signal: change the screen (§8.2). */
export function stuckPrompt(route: string, code: string, text: string, workspaces: number): string {
  return [
    `On ${PRODUCT}, ${workspaces} workspace${workspaces === 1 ? '' : 's'} showed the stuck signal ${code} on the screen ${route}: ${text}.`,
    '',
    'Look at that screen in the code and tell me, in plain words, what someone there would not understand or could not do,',
    'then propose the smallest change to the screen (copy, a hint, an empty state, or a clearer error) that would stop this.',
    'Do not change what the product does, only how it explains itself. Show me the diff before applying it.',
  ].join('\n');
}

/** A short, plain note offering help to a stuck customer (§8.2). No product internals, no signal codes. */
export function customerMessage(code: string, workspaceName: string): string {
  const what: Record<string, string> = {
    S1: 'I noticed you signed up but have not connected a LinkedIn account yet. That step can be confusing: the login happens in a separate window and sometimes asks for a verification code.',
    S2: 'I noticed connecting your LinkedIn account did not go through. That usually means a verification code was asked for, or the login was from a different country than usual.',
    S3: 'I noticed your sequence is set up but has not started. Before it can run it needs a connected sender and at least one lead in it.',
    S4: 'I noticed your sequence started but nothing has gone out yet. That is usually working hours, warm-up limits, or an empty lead list, and the app should explain which.',
    S5: 'I noticed you have been checking why messages are not going out. The explanation there may not have answered you.',
    S6: 'I noticed an error keeps coming up for you in the app.',
    S7: 'I noticed a form in the app keeps rejecting what you enter.',
    S8: 'I noticed an import did not bring in the leads you expected. That is usually the column mapping or the LinkedIn URL format.',
    S9: 'I noticed your LinkedIn account has been disconnected for a day. LinkedIn asks for a fresh login now and then; reconnecting takes a minute.',
    S10: 'I noticed something in the app did not respond when you clicked it.',
  };
  return `Hi,\n\n${what[code] ?? 'I noticed you may have hit a snag in the app.'}\n\nHappy to walk you through it on a quick call, or tell me what you were trying to do and I will sort it out for ${workspaceName}.\n\nThanks`;
}

export const SIGNAL_TEXT: Record<string, string> = {
  S1: 'Signed up over 24 hours ago, no sender connected', S2: 'Started connecting a sender twice or more and never finished', S3: 'Sequence created, not started after 48 hours',
  S4: 'Sequence started, nothing sent after 24 hours', S5: 'Opened "Why isn\'t it sending" three times or more in a day', S6: 'The same error three times or more in a day',
  S7: 'The same form rejected three times or more', S8: 'An import failed, or brought in no leads', S9: 'Sender disconnected over 24 hours, no reconnect attempt', S10: 'Clicked the same control four times or more within two seconds',
};
export const SIGNAL_MEANS: Record<string, string> = {
  S1: "They didn't understand or trust the LinkedIn login step", S2: 'The login failed for them: verification code, wrong country', S3: "They don't know what's missing before it can start",
  S4: "Working hours, warm-up or an empty lead list, and they don't know", S5: "The explanation there didn't answer them", S6: 'A bug, and they keep retrying',
  S7: "The form's message doesn't say what to fix", S8: 'Column mapping or the LinkedIn URL format', S9: 'They missed the email', S10: "It looks clickable and does nothing, or it's slow",
};
