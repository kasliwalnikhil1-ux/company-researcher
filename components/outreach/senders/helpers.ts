import type { ActionType, Provider, Schedule, ScheduleWindow, SenderStatus } from '@/lib/outreach/types';

export const WEEKDAYS: Array<{ key: keyof Schedule; label: string; short: string }> = [
  { key: 'mon', label: 'Monday', short: 'Mon' },
  { key: 'tue', label: 'Tuesday', short: 'Tue' },
  { key: 'wed', label: 'Wednesday', short: 'Wed' },
  { key: 'thu', label: 'Thursday', short: 'Thu' },
  { key: 'fri', label: 'Friday', short: 'Fri' },
  { key: 'sat', label: 'Saturday', short: 'Sat' },
  { key: 'sun', label: 'Sunday', short: 'Sun' },
];

export const DEFAULT_SCHEDULE: Schedule = {
  mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [], sun: [],
};

/** Action types that have a daily budget a human cares about (ordered for display). */
export const BUDGET_ACTION_TYPES: ActionType[] = ['invite', 'message', 'profile_view', 'inmail', 'like', 'comment', 'endorse', 'follow', 'search_page', 'post_fetch', 'withdraw', 'email'];

export const ACTION_LABELS: Record<ActionType, string> = {
  profile_view: 'Profile views', invite: 'Invitations', withdraw: 'Withdrawals', message: 'Messages', inmail: 'InMails', like: 'Likes', comment: 'Comments',
  endorse: 'Endorsements', search_page: 'Search pages', email: 'Emails', reply: 'Replies', relations_poll: 'Relation polls', call_api: 'API calls',
  post_fetch: 'Post fetches', follow: 'Follows', find_email: 'Email lookups',
};

export const PROVIDER_LABELS: Record<Provider, string> = { LINKEDIN: 'LinkedIn', GMAIL: 'Gmail', OUTLOOK: 'Outlook', IMAP: 'IMAP' };

export const STATUS_OPTIONS: Array<{ value: SenderStatus; label: string }> = [
  { value: 'ok', label: 'Connected' }, { value: 'connecting', label: 'Connecting' }, { value: 'credentials', label: 'Re-login needed' },
  { value: 'error', label: 'Error' }, { value: 'paused', label: 'Paused' }, { value: 'disabled', label: 'Disabled' },
];

export function normalizeSchedule(s: Partial<Schedule> | null | undefined): Schedule {
  const out = { ...DEFAULT_SCHEDULE } as Schedule;
  for (const d of WEEKDAYS) {
    const v = s?.[d.key];
    out[d.key] = Array.isArray(v) ? (v.filter((w) => Array.isArray(w) && w.length === 2).map((w) => [String(w[0]), String(w[1])]) as ScheduleWindow[]) : [];
  }
  if (!s) return { ...DEFAULT_SCHEDULE };
  return out;
}

/** "Mon–Fri 09:00–18:00, Sat 10:00–12:00" */
export function scheduleSummary(s: Partial<Schedule> | null | undefined): string {
  const sch = normalizeSchedule(s);
  const fmt = (w: ScheduleWindow[]) => w.map(([a, b]) => `${a}–${b}`).join(' & ');
  const groups: Array<{ from: number; to: number; text: string }> = [];
  WEEKDAYS.forEach((d, i) => {
    const text = fmt(sch[d.key]);
    if (!text) return;
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.to === i - 1) last.to = i;
    else groups.push({ from: i, to: i, text });
  });
  if (!groups.length) return 'No active windows';
  return groups.map((g) => `${WEEKDAYS[g.from].short}${g.to > g.from ? `–${WEEKDAYS[g.to].short}` : ''} ${g.text}`).join(', ');
}

/** YYYY-MM-DD for "today" in the given IANA timezone. */
export function localDate(timeZone: string, d = new Date()): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}

export function localTime(timeZone: string, d = new Date()): string {
  try { return new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(d); }
  catch { return d.toLocaleTimeString(); }
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

const FALLBACK_TIMEZONES = [
  'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Zurich', 'Europe/Vienna',
  'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki', 'Europe/Warsaw', 'Europe/Prague', 'Europe/Athens', 'Europe/Istanbul', 'Europe/Kiev', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver',
  'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Sao_Paulo', 'America/Buenos_Aires',
  'Asia/Dubai', 'Asia/Riyadh', 'Asia/Tel_Aviv', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Manila',
  'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne',
  'Pacific/Auckland', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg',
];

export function timezoneOptions(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof fn === 'function') {
      const list = fn.call(Intl, 'timeZone');
      if (Array.isArray(list) && list.length > 20) return list.includes('UTC') ? list : ['UTC', ...list];
    }
  } catch { /* fall through */ }
  return FALLBACK_TIMEZONES;
}

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** ISO-3166 alpha-2 codes for the proxy country picker. */
export const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' }, { code: 'CA', name: 'Canada' }, { code: 'AU', name: 'Australia' }, { code: 'NZ', name: 'New Zealand' },
  { code: 'IE', name: 'Ireland' }, { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' }, { code: 'ES', name: 'Spain' }, { code: 'PT', name: 'Portugal' }, { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' }, { code: 'BE', name: 'Belgium' }, { code: 'LU', name: 'Luxembourg' }, { code: 'CH', name: 'Switzerland' }, { code: 'AT', name: 'Austria' },
  { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' }, { code: 'DK', name: 'Denmark' }, { code: 'FI', name: 'Finland' }, { code: 'IS', name: 'Iceland' },
  { code: 'PL', name: 'Poland' }, { code: 'CZ', name: 'Czechia' }, { code: 'SK', name: 'Slovakia' }, { code: 'HU', name: 'Hungary' }, { code: 'RO', name: 'Romania' }, { code: 'BG', name: 'Bulgaria' },
  { code: 'GR', name: 'Greece' }, { code: 'HR', name: 'Croatia' }, { code: 'SI', name: 'Slovenia' }, { code: 'RS', name: 'Serbia' }, { code: 'UA', name: 'Ukraine' }, { code: 'EE', name: 'Estonia' },
  { code: 'LV', name: 'Latvia' }, { code: 'LT', name: 'Lithuania' }, { code: 'TR', name: 'Türkiye' }, { code: 'IL', name: 'Israel' }, { code: 'AE', name: 'United Arab Emirates' },
  { code: 'SA', name: 'Saudi Arabia' }, { code: 'QA', name: 'Qatar' }, { code: 'EG', name: 'Egypt' }, { code: 'ZA', name: 'South Africa' }, { code: 'NG', name: 'Nigeria' }, { code: 'KE', name: 'Kenya' },
  { code: 'MA', name: 'Morocco' }, { code: 'IN', name: 'India' }, { code: 'PK', name: 'Pakistan' }, { code: 'BD', name: 'Bangladesh' }, { code: 'LK', name: 'Sri Lanka' }, { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' }, { code: 'ID', name: 'Indonesia' }, { code: 'TH', name: 'Thailand' }, { code: 'VN', name: 'Vietnam' }, { code: 'PH', name: 'Philippines' }, { code: 'HK', name: 'Hong Kong' },
  { code: 'TW', name: 'Taiwan' }, { code: 'JP', name: 'Japan' }, { code: 'KR', name: 'South Korea' }, { code: 'CN', name: 'China' }, { code: 'MX', name: 'Mexico' }, { code: 'BR', name: 'Brazil' },
  { code: 'AR', name: 'Argentina' }, { code: 'CL', name: 'Chile' }, { code: 'CO', name: 'Colombia' }, { code: 'PE', name: 'Peru' }, { code: 'UY', name: 'Uruguay' },
];

/** Best-effort mapping timezone region → likely country, used only for the schedule hint. */
export function timezoneCountryHint(tz: string): string | null {
  const map: Record<string, string> = {
    'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Lisbon': 'PT', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL',
    'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL',
    'Europe/Prague': 'CZ', 'Europe/Athens': 'GR', 'Europe/Istanbul': 'TR', 'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA', 'Europe/Bucharest': 'RO', 'Europe/Budapest': 'HU',
    'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'America/Mexico_City': 'MX', 'America/Bogota': 'CO', 'America/Lima': 'PE',
    'America/Santiago': 'CL', 'America/Sao_Paulo': 'BR', 'America/Buenos_Aires': 'AR', 'America/Argentina/Buenos_Aires': 'AR', 'America/Montevideo': 'UY',
    'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Qatar': 'QA', 'Asia/Tel_Aviv': 'IL', 'Asia/Jerusalem': 'IL', 'Asia/Karachi': 'PK', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dhaka': 'BD',
    'Asia/Colombo': 'LK', 'Asia/Bangkok': 'TH', 'Asia/Jakarta': 'ID', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Manila': 'PH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Hong_Kong': 'HK',
    'Asia/Shanghai': 'CN', 'Asia/Taipei': 'TW', 'Asia/Seoul': 'KR', 'Asia/Tokyo': 'JP', 'Pacific/Auckland': 'NZ', 'Africa/Cairo': 'EG', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
    'Africa/Johannesburg': 'ZA', 'Africa/Casablanca': 'MA',
  };
  if (map[tz]) return map[tz];
  if (tz.startsWith('America/') && !['America/Toronto', 'America/Vancouver'].includes(tz)) {
    const usZones = ['New_York', 'Chicago', 'Denver', 'Phoenix', 'Los_Angeles', 'Anchorage', 'Detroit', 'Boise', 'Indiana', 'Kentucky', 'North_Dakota', 'Juneau'];
    if (usZones.some((z) => tz.includes(z))) return 'US';
  }
  if (tz.startsWith('Australia/')) return 'AU';
  if (tz.startsWith('US/') || tz === 'Pacific/Honolulu') return 'US';
  if (tz.startsWith('Canada/')) return 'CA';
  return null;
}

export function healthTone(score: number): 'green' | 'lime' | 'amber' | 'red' {
  return score >= 85 ? 'green' : score >= 70 ? 'lime' : score >= 50 ? 'amber' : 'red';
}

export function healthTileClasses(score: number): string {
  const t = healthTone(score);
  return t === 'green' ? 'bg-green-50 border-green-200' : t === 'lime' ? 'bg-lime-50 border-lime-200' : t === 'amber' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';
}

export function healthTextClass(score: number): string {
  const t = healthTone(score);
  return t === 'green' ? 'text-green-700' : t === 'lime' ? 'text-lime-700' : t === 'amber' ? 'text-amber-700' : 'text-red-700';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back */ }
  try {
    const el = document.createElement('textarea');
    el.value = text; el.setAttribute('readonly', ''); el.style.position = 'fixed'; el.style.opacity = '0';
    document.body.appendChild(el); el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch { return false; }
}

export function isFuture(iso: string | null | undefined): boolean {
  return !!iso && new Date(iso).getTime() > Date.now();
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export const HEALTH_KEYS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'session_stability', label: 'Session stability', hint: 'Disconnects in the last 14 days' },
  { key: 'rejection_rate', label: 'Rejection rate', hint: 'Rejected actions vs. attempted' },
  { key: 'acceptance_rate', label: 'Acceptance rate', hint: 'Invitations accepted (needs ≥20 sent)' },
  { key: 'reply_rate', label: 'Reply rate', hint: 'Replies per message (needs ≥20 sent)' },
  { key: 'consistency', label: 'Consistency', hint: 'Even daily volume; penalised for bursts after idle days' },
  { key: 'verification', label: 'Verification', hint: 'LinkedIn checkpoints in the last 30 days' },
];
