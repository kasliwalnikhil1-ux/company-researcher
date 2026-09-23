'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Mail, Sprout } from 'lucide-react';
import { Button, CompanyLogo, useToast } from './ui';
import { fmtMoney, READINESS_LABELS, STAGE_LABELS, type CompanyBrief } from '@/lib/crm/types';
import { cn } from '@/lib/utils';

// The two post-meeting emails, drafted in ChatGPT: the same-day recap and the nurture email a few
// days later. Both hand ChatGPT everything the CRM already knows about the call so the draft is
// specific; the seller edits it there and sends it from their own inbox.

type Meeting = CompanyBrief['meetings'][number];
type Kind = 'recap' | 'nurture';

const KIND_LABEL: Record<Kind, string> = { recap: 'Draft follow-up', nurture: 'Draft nurture email' };

// Both chats prefill their message box from the same ?q= parameter, but they need different
// messages: the client-comms skill on claude.ai already holds the brief, while ChatGPT has no
// such skill and gets it inline. The domain doubles as the menu icon — CompanyLogo already turns
// one into a brand mark, with a letter tile if it misses.
const TARGETS = [
  {
    key: 'chatgpt',
    name: 'ChatGPT',
    domain: 'chatgpt.com',
    href: (q: string) => `https://chatgpt.com/?q=${q}`,
    lead: (kind: Kind) => `${kind === 'recap' ? RECAP_BRIEF : NURTURE_BRIEF}\n\n--- THE MEETING ---`,
  },
  {
    key: 'claude',
    name: 'Claude',
    domain: 'claude.ai',
    href: (q: string) => `https://claude.ai/new?q=${q}`,
    lead: (kind: Kind) => `Use /client-comms skill\n${KIND_LABEL[kind]}`,
  },
] as const;

type Target = (typeof TARGETS)[number];

const MAX_PAINS = 8;
const MAX_ACTIVITIES = 10;

/** Day-month-year, so a prompt read weeks later still says which year. */
function longDate(v: string | null | undefined, tz?: string | null, time = false): string {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (isNaN(d.getTime())) return '—';
  const o: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  if (time) { o.hour = '2-digit'; o.minute = '2-digit'; o.hour12 = false; }
  if (tz) o.timeZone = tz;
  try { return d.toLocaleString('en-GB', o); } catch { return d.toLocaleString('en-GB', { ...o, timeZone: undefined }); }
}

const daysAgoCount = (from: string) => Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 86400000));

/** Everything the CRM holds about this call, as plain labelled lines ChatGPT can read. */
function meetingContext(b: CompanyBrief, m: Meeting, tz: string | null): string {
  const c = b.company;
  const contact = b.contacts.find((ct) => ct.name === m.contact) ?? b.contacts.find((ct) => ct.is_primary);
  const deal = b.deals.find((d) => d.id === m.deal_id);
  const cap = m.capture;
  const L: string[] = [];

  L.push(`Company: ${c.name}${c.domain ? ` (${c.domain})` : ''}${c.country ? ` · ${c.country}` : ''}${c.icp_segment ? ` · segment: ${c.icp_segment}` : ''}`);
  if (contact) L.push(`Who I met: ${contact.name}${contact.role ? ` — ${contact.role}` : ''}${contact.email ? ` (${contact.email})` : ''}`);
  else if (m.contact) L.push(`Who I met: ${m.contact}`);
  const others = m.attendees.filter((a) => a !== m.contact);
  if (others.length) L.push(`Also on the call: ${others.join(', ')}`);
  L.push(`Meeting: ${longDate(m.scheduled_at, tz, true)} · ${m.status.replace('_', '-')} · ${daysAgoCount(m.scheduled_at)} day(s) ago`);
  L.push(`Today: ${longDate(new Date().toISOString(), tz)}`);

  if (deal) {
    const bits = [`stage: ${STAGE_LABELS[deal.stage]}`, `value: ${fmtMoney(deal.value_monthly, deal.currency)}/month`];
    if (deal.videos_per_month) bits.push(`${deal.videos_per_month} videos/month`);
    if (deal.next_step) bits.push(`open next step: ${deal.next_step}${deal.next_step_date ? ` (due ${longDate(deal.next_step_date, tz)})` : ''}`);
    L.push(`Deal: ${bits.join(' · ')}`);
  }

  if (cap?.outcome === 'no_show') {
    L.push(`Outcome: no-show${cap.no_show_reason ? ` — ${cap.no_show_reason}` : ''}${cap.is_repeat_no_show ? ' (repeat no-show)' : ''}`);
    if (cap.follow_up_action) L.push(`Agreed follow-up: ${cap.follow_up_action}${cap.follow_up_date ? ` (${longDate(cap.follow_up_date, tz)})` : ''}`);
  }

  if (cap?.raw_notes) L.push(`\nWhat happened on the call:\n${cap.raw_notes.trim()}`);
  else if (m.notes) L.push(`\nMeeting notes:\n${m.notes.trim()}`);

  const com = cap?.commercials_discussed ?? {};
  const currency = typeof com.currency === 'string' ? com.currency : null;
  const money = Object.entries(com)
    .filter(([k, v]) => k !== 'currency' && v != null && v !== '')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${/price|value|amount|budget|quote|fee/i.test(k) && !isNaN(Number(v)) ? fmtMoney(Number(v), currency) : String(v)}`);
  if (money.length) L.push(`\nCommercials discussed:\n${money.map((x) => `- ${x}`).join('\n')}`);

  const objections = (cap?.objections ?? []).flatMap((o) => o.split(/;\s+/)).filter(Boolean);
  if (objections.length) L.push(`\nTheir objections:\n${objections.map((o) => `- ${o}`).join('\n')}`);

  if (cap?.pain_points.length) {
    L.push(`\nTheir own words (verbatim from the call):\n${cap.pain_points.slice(0, MAX_PAINS).map((p) => `- "${p}"`).join('\n')}`);
  }

  if (cap && !cap.is_dead && cap.next_step) L.push(`\nNext step agreed on the call: ${cap.next_step}${cap.next_step_date ? ` (by ${longDate(cap.next_step_date, tz)})` : ''}`);
  if (cap?.is_dead) L.push(`\nThis deal was marked dead on the call: ${cap.dead_reason ?? '—'}`);

  if (m.coaching) {
    const co = [
      m.coaching.purpose && `call purpose: ${m.coaching.purpose}`,
      m.coaching.readiness?.stage && `buying readiness: ${READINESS_LABELS[m.coaching.readiness.stage]}`,
      m.coaching.next_action && `recommended next action: ${m.coaching.next_action}`,
    ].filter(Boolean);
    if (co.length) L.push(`\nCall review:\n${co.map((x) => `- ${x}`).join('\n')}`);
  }

  const since = b.activities
    .filter((a) => new Date(a.at).getTime() > new Date(m.scheduled_at).getTime())
    .slice(0, MAX_ACTIVITIES)
    .map((a) => `- ${longDate(a.at, tz)} · ${a.direction === 'inbound' ? 'from them' : 'from us'} · ${a.type}${a.channel ? ` (${a.channel})` : ''}${a.outcome ? ` · ${a.outcome}` : ''}${a.body ? ` — ${a.body.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  L.push(since.length
    ? `\nWhat has happened since the meeting (most recent first):\n${since.join('\n')}`
    : `\nNothing has been logged since the meeting.`);

  return L.join('\n');
}

const RECAP_BRIEF = `Write the post-meeting recap email I send to this prospect — the same-day follow-up that confirms what we agreed.

How to write it:
- Assume it goes out within 24 hours of the call. Warm, short, specific.
- Briefly recap their goals, the key discussion points and anything that was decided.
- Name the materials I promised on the call (pricing, samples, proposal) and when they are coming.
- Confirm who is doing what, and by when.
- End with exactly one clear next step, using the date already agreed if there is one.
- Reuse their own phrasing where it helps. Do not invent facts, numbers, dates or promises that are not in the notes.
- Plain sentences, no marketing language, no emojis. 120-180 words.

Give me, in this order: two subject line options, the email body, then one line listing anything I still have to fill in myself. Mark those spots [like this] in the body rather than guessing.`;

const NURTURE_BRIEF = `Write a lead-nurturing email to send a few days after this meeting.

This is NOT a "just checking in" or "any update on the proposal?" chase — that would be a sales follow-up, and it is not what I want here. The email has to earn its place by being useful.

How to write it:
- Lead with something genuinely useful: a relevant case study, a sample, a recommendation, or a straight answer to a concern they raised.
- Personalise it around the actual concern or opportunity from this meeting, quoted below — not a generic pitch.
- Keep the whole email on ONE topic.
- Match the ask to where they are in buying: if they are early, teach; if price is the blocker, address the money; if they are advancing, make it easy to say yes.
- Do not repeat the pitch from the meeting. This has to add something new.
- 100-150 words, one soft ask at the end, no emojis.

Give me, in this order: a suggested send date with one line on why that timing, two subject line options, then the email body. If it needs an asset I may not have (a case study, a sample, a benchmark), say so plainly instead of inventing one, and mark anything I must fill in myself [like this].`;

function buildPrompt(kind: Kind, target: Target, b: CompanyBrief, m: Meeting, tz: string | null): string {
  return `${target.lead(kind)}\n\n${meetingContext(b, m, tz)}`;
}

const MENU_HEIGHT = TARGETS.length * 28 + 8; // items + the menu's own padding

/** An outline button that drops down to pick which chat writes the draft. */
function DraftMenu({ label, icon, title, onPick }: { label: string; icon: React.ReactNode; title: string; onPick: (target: Target) => void }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false); // the last meeting sits at the page bottom: flip rather than run off-screen
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const r = ref.current?.getBoundingClientRect();
      const below = r ? window.innerHeight - r.bottom : 0;
      // Downwards unless it would not fit there and there is more room above.
      setUp(!!r && below < MENU_HEIGHT + 8 && r.top > below);
    }
    setOpen((v) => !v);
  };

  return (
    <div ref={ref} className="relative">
      <Button size="xs" variant="secondary" title={title} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {icon} {label} <ChevronDown className={cn('w-3 h-3 opacity-60 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div role="menu" className={cn('absolute left-0 z-20 min-w-[10rem] rounded-md border border-gray-200 bg-white py-1 shadow-lg', up ? 'bottom-full mb-1' : 'top-full mt-1')}>
          {TARGETS.map((t) => (
            <button
              key={t.key}
              role="menuitem"
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
              onClick={() => { setOpen(false); onPick(t); }}
            >
              <CompanyLogo name={t.name} domain={t.domain} size="xs" />
              Open in {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The two draft buttons under a meeting's capture. */
export function DraftEmailButtons({ brief, meeting, timezone }: { brief: CompanyBrief; meeting: Meeting; timezone: string | null }) {
  const { show, node } = useToast();

  const draft = (kind: Kind, target: Target) => {
    const prompt = buildPrompt(kind, target, brief, meeting, timezone);
    // The clipboard write and the tab open must both start in this click tick: the write needs
    // document focus (lost once the tab opens) and the open needs the user gesture (lost after an
    // await). A long prompt can be dropped from the ?q= URL, and then the seller just pastes.
    const copied = navigator.clipboard?.writeText(prompt).then(() => true).catch(() => false) ?? Promise.resolve(false);
    window.open(target.href(encodeURIComponent(prompt)), '_blank', 'noopener,noreferrer');
    void copied.then((ok) => show(
      ok
        ? `${target.name} opened, prompt copied. If the message box is empty, paste it.`
        : `${target.name} opened, but the prompt could not be copied. If the message box is empty, reopen it from this tab.`,
      ok ? 'success' : 'error',
    ));
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <DraftMenu
        label={KIND_LABEL.recap}
        icon={<Mail className="w-3 h-3" />}
        title="Draft the same-day recap email: their goals, what was decided, who does what by when, one next step"
        onPick={(t) => draft('recap', t)}
      />
      <DraftMenu
        label={KIND_LABEL.nurture}
        icon={<Sprout className="w-3 h-3" />}
        title="Draft a nurture email for a few days later: something useful about a concern from this call, with a suggested send date"
        onPick={(t) => draft('nurture', t)}
      />
      {node}
    </div>
  );
}
