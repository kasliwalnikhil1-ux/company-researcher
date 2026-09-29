// Reply-policy form: row ⇄ form conversion, validation (mirrors the table CHECKs) and the patch sent to reply_policy_set.
import type { PolicyFields, PolicyList, PolicyRow, PolicyScope, ReplyMode } from '@/lib/outreach/aiReplies';
import { secToMin } from '../format';

export const POLICY_KEYS: Array<keyof PolicyFields> = [
  'mode', 'delay_min_s', 'delay_max_s', 'debounce_quiet_s', 'debounce_max_s', 'max_ai_sends_per_sender_day',
  'stale_after_h', 'human_takeover_pause_h', 'disclosure', 'blocked_countries',
];

export const EMPTY_FIELDS: PolicyFields = {
  mode: null, delay_min_s: null, delay_max_s: null, debounce_quiet_s: null, debounce_max_s: null,
  max_ai_sends_per_sender_day: null, stale_after_h: null, human_takeover_pause_h: null, disclosure: null, blocked_countries: null,
};

/** Numbers are kept as strings so an empty box means "inherit". Hold window in minutes, debounce in seconds. */
export interface PolicyForm {
  mode: ReplyMode | '';
  delay_min: string; delay_max: string;
  debounce_quiet: string; debounce_max: string;
  sends: string; stale: string; takeover: string;
  disclosure: string;
  countries: string[] | null;
}
export type FormErrors = Partial<Record<keyof PolicyForm, string>>;

const str = (v: number | null | undefined) => (v == null ? '' : String(v));

export function formFromFields(f: PolicyFields): PolicyForm {
  return {
    mode: f.mode ?? '',
    delay_min: secToMin(f.delay_min_s), delay_max: secToMin(f.delay_max_s),
    debounce_quiet: str(f.debounce_quiet_s), debounce_max: str(f.debounce_max_s),
    sends: str(f.max_ai_sends_per_sender_day), stale: str(f.stale_after_h), takeover: str(f.human_takeover_pause_h),
    disclosure: f.disclosure ?? '',
    countries: f.blocked_countries ? [...f.blocked_countries] : null,
  };
}

const num = (s: string): number | null => (s.trim() === '' ? null : Number(s));

/** `base`: the saved values. A minute field the user did not touch keeps its exact seconds (secToMin rounds to 0.1 min). */
export function fieldsFromForm(f: PolicyForm, base?: PolicyFields): PolicyFields {
  const minutes = (s: string, orig?: number | null) => {
    if (orig != null && s === secToMin(orig)) return orig;
    const n = num(s); return n == null || !Number.isFinite(n) ? null : Math.round(n * 60);
  };
  const int = (s: string) => { const n = num(s); return n == null || !Number.isFinite(n) ? null : Math.round(n); };
  const disclosure = f.disclosure.trim();
  return {
    mode: f.mode === '' ? null : f.mode,
    delay_min_s: minutes(f.delay_min, base?.delay_min_s), delay_max_s: minutes(f.delay_max, base?.delay_max_s),
    debounce_quiet_s: int(f.debounce_quiet), debounce_max_s: int(f.debounce_max),
    max_ai_sends_per_sender_day: int(f.sends), stale_after_h: int(f.stale), human_takeover_pause_h: int(f.takeover),
    disclosure: disclosure === '' ? null : disclosure,
    blocked_countries: f.countries ? [...new Set(f.countries.map((c) => c.trim().toUpperCase()).filter(Boolean))] : null,
  };
}

export function rowFields(row: PolicyRow | null | undefined): PolicyFields {
  if (!row) return { ...EMPTY_FIELDS };
  const out = { ...EMPTY_FIELDS } as Record<string, unknown>;
  for (const k of POLICY_KEYS) out[k] = (row as unknown as Record<string, unknown>)[k] ?? null;
  return out as unknown as PolicyFields;
}

/** What a scope falls back to when a field is empty: the workspace row, then the platform defaults. */
export function inheritedFields(scope: PolicyScope, list: PolicyList | undefined): { fields: PolicyFields; from: string } {
  const d = (list?.defaults ?? EMPTY_FIELDS) as PolicyFields;
  if (scope === 'workspace') return { fields: { ...d }, from: 'default' };
  const ws = rowFields(list?.rows.find((r) => r.scope === 'workspace'));
  const out = {} as Record<string, unknown>;
  for (const k of POLICY_KEYS) out[k] = ws[k] ?? d[k];
  return { fields: out as unknown as PolicyFields, from: 'workspace' };
}

function range(v: string, lo: number, hi: number, unit: string, integer = true): string | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return 'Enter a number.';
  if (integer && !Number.isInteger(n)) return 'Use a whole number.';
  if (n < lo || n > hi) return `Between ${lo} and ${hi} ${unit}.`;
  return undefined;
}

export function validate(f: PolicyForm, inherited: PolicyFields): FormErrors {
  const e: FormErrors = {};
  e.delay_min = range(f.delay_min, 1, 60, 'minutes', false);
  e.delay_max = range(f.delay_max, 1, 60, 'minutes', false);
  e.debounce_quiet = range(f.debounce_quiet, 30, 600, 'seconds');
  e.debounce_max = range(f.debounce_max, 60, 1800, 'seconds');
  e.sends = range(f.sends, 1, 40, 'a day');
  e.stale = range(f.stale, 1, 72, 'hours');
  e.takeover = range(f.takeover, 1, 720, 'hours');
  if (f.disclosure.trim().length > 200) e.disclosure = 'At most 200 characters.';
  if (f.countries?.some((c) => !/^[A-Za-z]{2}$/.test(c.trim()))) e.countries = 'Use two-letter country codes.';

  const v = fieldsFromForm(f);
  if (!e.delay_min && !e.delay_max) {
    const lo = v.delay_min_s ?? inherited.delay_min_s; const hi = v.delay_max_s ?? inherited.delay_max_s;
    if (lo != null && hi != null && hi <= lo) e.delay_max = `Must be longer than the shortest wait (${secToMin(lo)} min).`;
  }
  if (!e.debounce_quiet && !e.debounce_max) {
    const q = v.debounce_quiet_s ?? inherited.debounce_quiet_s; const m = v.debounce_max_s ?? inherited.debounce_max_s;
    if (q != null && m != null && m < q) e.debounce_max = `Must be at least the quiet time (${q} s).`;
  }
  for (const k of Object.keys(e) as Array<keyof PolicyForm>) if (!e[k]) delete e[k];
  return e;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Only the fields that changed. A `null` value means "inherit". */
export function diffPatch(saved: PolicyFields, next: PolicyFields): Partial<PolicyFields> {
  const patch: Record<string, unknown> = {};
  for (const k of POLICY_KEYS) if (!same(saved[k], next[k])) patch[k] = next[k];
  return patch as Partial<PolicyFields>;
}
