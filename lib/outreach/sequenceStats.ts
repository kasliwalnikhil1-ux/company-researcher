// Sequence stats (sequence-stats-PRD.md): the shapes returned by outreach_report_sequences / outreach_report_sequence
// (migrations/outreach/089_sequence_stats.sql), the cohort period model, and the exact tooltip wording of §6.3.
// Nothing here computes a metric: counts and rates come from the database. The only arithmetic is presentational
// (rounding a rate for a sentence, deciding whether a base is small).
// Type-only import: lib/outreach/reports.ts pulls the Supabase client in, and this module must stay runnable in a
// plain node test (`npx tsx lib/outreach/sequenceStats.test.ts`), so the few date / number helpers live here.
import type { DateRange, Rate } from './reports';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDay(v: string | null | undefined): v is string { return !!v && ISO_DAY.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`)); }
function todayInTz(tz: string | null | undefined): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
function addDays(day: string, n: number): string { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export function fmtInt(n: number | null | undefined): string { return typeof n === 'number' && Number.isFinite(n) ? INT.format(n) : '—'; }
function fmtDay(day: string): string { const [, m, d] = day.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; }

export type StatsChannel = 'linkedin' | 'instagram' | 'whatsapp' | 'email';
export const STATS_CHANNELS: StatsChannel[] = ['linkedin', 'instagram', 'whatsapp', 'email'];
export const STATS_CHANNEL_LABEL: Record<StatsChannel, string> = { linkedin: 'LinkedIn', instagram: 'Instagram', whatsapp: 'WhatsApp', email: 'Email' };
/** The short glyph next to a sequence name: in · ig · wa · ✉ */
export const STATS_CHANNEL_GLYPH: Record<StatsChannel, string> = { linkedin: 'in', instagram: 'ig', whatsapp: 'wa', email: '✉' };

export interface ChannelUse { channel: StatsChannel; invite_step: boolean; from_earlier_version: boolean }
export interface AcceptedSplit { invited: number; accepted: number; pending: number; accepted_rate: Rate }
export interface StatsProgress { enrolled: number; live: number; done: number; pct_done: Rate }
export interface StatsOps { queued: number; actions_sent: number; failed: number; failed_leads: number }

/** The results block: people counted once (§3.1). Shared by the list row, the sequence page header and the API. */
export interface SequenceStatsBlock {
  contacted: number;
  invited: number;
  accepted: number;
  accepted_rate: Rate;
  pending: number;
  accepted_early: boolean;
  accepted_split: Partial<Record<StatsChannel, AcceptedSplit>>;
  replied: number;
  replied_rate: Rate;
  auto_replied: number;
  positive: number;
  positive_rate: Rate;
  meetings: number;
  replied_by_channel: Partial<Record<StatsChannel, number>>;
  /** People in the cohort: contacted, plus WhatsApp numbers that failed the check before any message. */
  cohort: number;
  progress: StatsProgress;
  ops: StatsOps;
  channels: ChannelUse[];
  na: { accepted?: string; seen?: string };
  cached_at: string | null;
  definitions_version: number;
}

export interface SequenceStatsRow extends SequenceStatsBlock {
  sequence_id: string;
  name: string;
  status: string;
  client_id: string | null;
  head_version: number;
  steps: number;
  stalled: boolean;
  stalled_reason: string | null;
  throttled_reason: string | null;
  has_ab_test: boolean;
  updated_at: string;
}

export interface ChannelStages {
  contacted?: number; invited?: number; accepted?: number; accepted_rate?: Rate; messaged?: number; seen?: number;
  replied?: number; replied_rate?: Rate; replied_of_accepted?: number; replied_of_accepted_rate?: Rate; bounced?: number;
}
export interface ChannelBlock extends ChannelUse { stages: ChannelStages }

// ---------------------------------------------------------------------------
// Periods (§3.5): All time, or a cohort of leads first contacted in a window
// ---------------------------------------------------------------------------
export type StatsPresetKey = 'all' | '7d' | '14d' | '30d' | '90d';
export type StatsPeriod = { kind: StatsPresetKey } | { kind: 'custom'; from: string; to: string };
export const STATS_PRESETS: Array<{ key: StatsPresetKey; label: string }> = [
  { key: 'all', label: 'All time' }, { key: '7d', label: '7d' }, { key: '14d', label: '14d' }, { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
];
const PRESET_DAYS: Record<Exclude<StatsPresetKey, 'all'>, number> = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 };

/** The dates a period asks the database for; null = all time (the cached path). */
export function periodRange(p: StatsPeriod, tz: string | null | undefined): DateRange | null {
  if (p.kind === 'all') return null;
  if (p.kind === 'custom') return { from: p.from, to: p.to };
  const today = todayInTz(tz);
  return { from: addDays(today, -(PRESET_DAYS[p.kind] - 1)), to: today };
}

/** Serialise / restore a period (per-workspace filter memory). */
export function periodToString(p: StatsPeriod): string { return p.kind === 'custom' ? `custom:${p.from}:${p.to}` : p.kind; }
export function periodFromString(v: unknown): StatsPeriod {
  if (typeof v !== 'string') return { kind: 'all' };
  if (v.startsWith('custom:')) { const [, from, to] = v.split(':'); if (isIsoDay(from) && isIsoDay(to) && from <= to) return { kind: 'custom', from, to }; return { kind: 'all' }; }
  return STATS_PRESETS.some((x) => x.key === v) ? { kind: v as StatsPresetKey } : { kind: 'all' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "1–26 Oct", "28 Sep – 26 Oct", "28 Dec 2025 – 3 Jan 2026" */
export function fmtCohortRange(r: DateRange): string {
  if (!isIsoDay(r.from) || !isIsoDay(r.to)) return '';
  const [fy, fm, fd] = r.from.split('-').map(Number);
  const [ty, tm, td] = r.to.split('-').map(Number);
  if (fy !== ty) return `${fd} ${MONTHS[fm - 1]} ${fy} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fm !== tm) return `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]}`;
  if (fd === td) return `${fd} ${MONTHS[fm - 1]}`;
  return `${fd}–${td} ${MONTHS[fm - 1]}`;
}

/** The line under the period selector (§3.5). */
export function cohortText(range: DateRange | null): string {
  if (!range) return 'Everyone this sequence ever contacted, and what they did after.';
  return `Leads first contacted ${fmtCohortRange(range)}, and what they did after.`;
}

// ---------------------------------------------------------------------------
// Rates and small bases
// ---------------------------------------------------------------------------
export const SMALL_BASE = 20;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** "34.5%" or "n/a" (a rate is null when there is nothing to divide by; never "0%" for an empty base). */
export function fmtPct(rate: Rate | undefined): string { return finite(rate) ? `${rate.toFixed(1)}%` : 'n/a'; }
/** The whole-number percent used inside sentences: "(34%)". */
export function pctWord(rate: Rate | undefined): string { return finite(rate) ? `${Math.round(rate)}%` : 'n/a'; }
export function isSmallBase(denominator: number | null | undefined): boolean { return !finite(denominator) || denominator < SMALL_BASE; }
export const SMALL_BASE_TIP = 'Based on fewer than 20 people.';

/** Sort key for a rate column: rates with a base under 20 sort last, whatever the direction. */
export function rateSortValue(rate: Rate | undefined, denominator: number | null | undefined, dir: 'asc' | 'desc'): number {
  if (!finite(rate) || isSmallBase(denominator)) return dir === 'desc' ? -1 : Number.MAX_SAFE_INTEGER;
  return rate;
}

// ---------------------------------------------------------------------------
// Tooltips (§6.3, exact text)
// ---------------------------------------------------------------------------
const people = (n: number) => `${fmtInt(n)} ${n === 1 ? 'person' : 'people'}`;

export function contactedTip(r: SequenceStatsBlock): string {
  const enrolled = r.progress?.enrolled ?? 0;
  const share = enrolled > 0 ? `${Math.round((100 * r.contacted) / enrolled)}%` : 'n/a';
  return `${people(r.contacted)} got at least one invite, follow or message from this sequence. That's ${share} of the ${fmtInt(enrolled)} enrolled. Visits and likes don't count.`;
}

export function acceptedTip(r: SequenceStatsBlock): string {
  if (r.na?.accepted) return r.na.accepted;
  const split = Object.entries(r.accepted_split ?? {}) as Array<[StatsChannel, AcceptedSplit]>;
  const splitText = split.length > 1 ? ` ${split.map(([ch, s]) => `${STATS_CHANNEL_LABEL[ch]} ${fmtInt(s.accepted)} of ${fmtInt(s.invited)}`).join(' · ')}.` : '';
  const what = split.length === 1 && split[0][0] === 'instagram' ? 'follows followed back' : split.length > 1 ? 'connection requests and follows accepted' : 'connection requests accepted';
  const base = `${fmtInt(r.accepted)} of ${fmtInt(r.invited)} ${what} (${pctWord(r.accepted_rate)}). ${fmtInt(r.pending)} still pending.${splitText}`;
  return r.accepted_early ? `${base} Most requests are still pending, so this rate will change.` : base;
}

export function repliedTip(r: SequenceStatsBlock): string {
  const auto = r.auto_replied > 0 ? ` Not counted: ${fmtInt(r.auto_replied)} out-of-office and auto-replies.` : '';
  return `${fmtInt(r.replied)} of ${fmtInt(r.contacted)} people contacted replied (${pctWord(r.replied_rate)}).${auto}`;
}

export function positiveTip(r: SequenceStatsBlock): string {
  const meetings = r.meetings > 0 ? ` ${fmtInt(r.meetings)} ${r.meetings === 1 ? 'meeting' : 'meetings'} booked.` : '';
  return `${fmtInt(r.positive)} of ${fmtInt(r.replied)} replies were interested or asked a question.${meetings}`;
}

export function progressTip(r: SequenceStatsBlock): string {
  return `${fmtInt(r.progress?.live ?? 0)} live · ${fmtInt(r.progress?.done ?? 0)} done · ${fmtInt(r.ops?.queued ?? 0)} actions queued · ${fmtInt(r.ops?.actions_sent ?? 0)} actions sent`;
}

export const SEEN_TIP = 'At least this many. People can turn read receipts off.';
export function seenSinceText(seenSince: string | null | undefined): string | null {
  return seenSince ? `Seen counted from ${fmtDay(seenSince)}.` : null;
}

/** "Replied on another channel: 1 (WhatsApp)" or null when nothing to say. */
export function repliedOtherChannelText(other: Record<string, number> | null | undefined): string | null {
  const parts = Object.entries(other ?? {}).filter(([, n]) => Number(n) > 0);
  if (!parts.length) return null;
  const total = parts.reduce((s, [, n]) => s + Number(n), 0);
  return `Replied on another channel: ${fmtInt(total)} (${parts.map(([ch, n]) => (parts.length > 1 ? `${STATS_CHANNEL_LABEL[ch as StatsChannel] ?? ch} ${fmtInt(Number(n))}` : STATS_CHANNEL_LABEL[ch as StatsChannel] ?? ch)).join(', ')})`;
}

/** The one-sentence summary the connector and the API quote (PRD §8). */
export function statsSummary(r: SequenceStatsBlock): string {
  const accepted = r.na?.accepted ? 'accepted n/a' : `${fmtInt(r.accepted)} accepted of ${fmtInt(r.invited)} invited (${pctWord(r.accepted_rate)}, ${fmtInt(r.pending)} pending)`;
  return `${fmtInt(r.contacted)} contacted, ${accepted}, ${fmtInt(r.replied)} replied (${pctWord(r.replied_rate)}), ${fmtInt(r.positive)} positive`;
}

// ---------------------------------------------------------------------------
// Channel blocks (§3.2 / §7.2): the stages each channel shows, in order
// ---------------------------------------------------------------------------
export interface StageView { key: keyof ChannelStages; label: string; value: number; rate?: Rate; atLeast?: boolean; aside?: boolean }

export function channelStages(b: ChannelBlock): StageView[] {
  const s = b.stages ?? {};
  const n = (k: keyof ChannelStages) => Number(s[k] ?? 0);
  switch (b.channel) {
    case 'linkedin':
      return [
        { key: 'contacted', label: 'Contacted', value: n('contacted') },
        { key: 'invited', label: 'Invited', value: n('invited') },
        { key: 'accepted', label: 'Accepted', value: n('accepted'), rate: s.accepted_rate ?? null },
        { key: 'messaged', label: 'Messaged', value: n('messaged') },
        { key: 'seen', label: 'Seen', value: n('seen'), atLeast: true },
        { key: 'replied', label: 'Replied', value: n('replied'), rate: s.replied_rate ?? null },
      ];
    case 'instagram':
      return [
        { key: 'contacted', label: 'Contacted', value: n('contacted') },
        { key: 'invited', label: 'Followed', value: n('invited') },
        { key: 'accepted', label: 'Followed back', value: n('accepted'), rate: s.accepted_rate ?? null },
        { key: 'messaged', label: "DM'd", value: n('messaged') },
        { key: 'seen', label: 'Seen', value: n('seen'), atLeast: true },
        { key: 'replied', label: 'Replied', value: n('replied'), rate: s.replied_rate ?? null },
      ];
    case 'whatsapp':
      return [
        { key: 'contacted', label: 'Contacted', value: n('contacted') },
        { key: 'seen', label: 'Seen', value: n('seen'), atLeast: true },
        { key: 'replied', label: 'Replied', value: n('replied'), rate: s.replied_rate ?? null },
        { key: 'bounced', label: 'Not on WhatsApp', value: n('bounced'), aside: true },
      ];
    default:
      return [
        { key: 'contacted', label: 'Contacted', value: n('contacted') },
        { key: 'replied', label: 'Replied', value: n('replied'), rate: s.replied_rate ?? null },
        { key: 'bounced', label: 'Bounced', value: n('bounced'), aside: true },
      ];
  }
}

/** "Of people who accepted, 23% replied" (LinkedIn block only). */
export function repliedOfAcceptedText(b: ChannelBlock): string | null {
  if (b.channel !== 'linkedin' || !finite(b.stages?.replied_of_accepted_rate)) return null;
  return `Of people who accepted, ${pctWord(b.stages.replied_of_accepted_rate)} replied`;
}
