// AI replies (AI → Setup → AI replies / General, the sequence AI tab): small formatting helpers shared by the panels (no React).
import { COUNTRIES } from '@/components/outreach/senders/helpers';
import { ESCALATION_LABEL, GATE_LABEL, CANCEL_REASONS, type RunSummary } from '@/lib/outreach/aiReplies';

/** EU member states + Iceland, Liechtenstein and Norway: the default autopilot block while no disclosure is set. */
export const EU_EEA = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'];

/** Every ISO 3166-1 alpha-2 country (plus XK, Kosovo); each has a round flag at /flags/<code>.svg. */
const ISO_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');

function intlName(code: string): string | undefined {
  try { return new Intl.DisplayNames('en', { type: 'region' }).of(code); } catch { return undefined; }
}

export const COUNTRY_LIST: Array<{ code: string; name: string }> = ISO_CODES
  .map((code) => ({ code, name: COUNTRIES.find((c) => c.code === code)?.name ?? intlName(code) ?? code }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The round flag image for a two-letter country code. */
export const flagSrc = (code: string) => `/flags/${code.toLowerCase()}.svg`;

export function countryName(code: string): string {
  const c = COUNTRY_LIST.find((x) => x.code === code.toUpperCase());
  if (c) return c.name;
  try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(code.toUpperCase()) ?? code; } catch { return code; }
}

/** True when the list is exactly the EU/EEA default (order ignored). */
export function isEuEea(list: string[] | null | undefined): boolean {
  if (!list || list.length !== EU_EEA.length) return false;
  const s = new Set(list.map((c) => c.toUpperCase()));
  return EU_EEA.every((c) => s.has(c));
}

export function countriesText(list: string[] | null | undefined): string {
  if (list == null) return '—';
  if (list.length === 0) return 'None';
  if (isEuEea(list)) return 'EU/EEA';
  return list.length > 4 ? `${list.slice(0, 4).join(', ')} +${list.length - 4}` : list.join(', ');
}

/** Seconds → minutes, one decimal at most ("4", "7.5"). */
export function secToMin(s: number | null | undefined): string {
  if (s == null) return '';
  return String(Math.round((s / 60) * 10) / 10);
}

/** Seconds → "45 s", "12 min", "1 h 5 min". */
export function fmtSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.round(h / 24)} d`;
}

/** A share given as 0–1 (or already a percentage above 1) → "82%". */
export function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const p = v <= 1 ? v * 100 : v;
  return `${Math.round(p * 10) / 10}%`;
}

/** Seconds between two ISO timestamps, or null. */
export function secondsBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  return Number.isFinite(d) && d >= 0 ? d : null;
}

export function inboundToDraft(r: Pick<RunSummary, 'timings'>): number | null { return secondsBetween(r.timings?.inbound_at, r.timings?.drafted_at); }
export function inboundToSent(r: Pick<RunSummary, 'timings'>): number | null { return secondsBetween(r.timings?.inbound_at, r.timings?.sent_at); }

/** Escalation reasons and gate failures, in plain words. */
export function reasonLabel(key: string): string {
  return ESCALATION_LABEL[key] ?? GATE_LABEL[key] ?? key.replace(/_/g, ' ');
}
export function runReasons(r: Pick<RunSummary, 'escalation_reasons' | 'gate_failures'>): string[] {
  return [...(r.escalation_reasons ?? []), ...(r.gate_failures ?? [])];
}

export function cancelReasonLabel(key: string): string {
  if (key === 'dismissed') return 'Dismissed';
  if (key === 'human_takeover') return 'A person replied';
  return CANCEL_REASONS.find((c) => c.key === key)?.label ?? key.replace(/_/g, ' ');
}

/** Stage key → label ("next_step" → "Next step") when no label is known. */
export function stageLabel(key: string | null | undefined, labels?: Record<string, string>): string {
  if (!key) return '—';
  if (labels?.[key]) return labels[key];
  if (key === 'closing') return 'Closing';
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Local calendar date `days` ago as YYYY-MM-DD. */
export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localIsoDate(d);
}
export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "2026-09" (or a full date) → the first day of the next month, e.g. "1 October". */
export function nextMonthStart(month: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})/.exec(month ?? '');
  const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date();
  const next = new Date(base.getFullYear(), base.getMonth() + 1, 1);
  return next.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/** True when the ISO timestamp is in the past. */
export function isPast(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t < Date.now();
}

/** Whole days from a YYYY-MM-DD date to today, at least 1. */
export function daysSince(isoDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return 30;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Math.max(1, Math.ceil((Date.now() - start) / 86_400_000));
}
