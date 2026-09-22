'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useCompanyBrief } from '@/lib/crm/queries';
import { fmtMoney, STAGE_LABELS, type Capture, type Contact, type Deal } from '@/lib/crm/types';
import { Badge, Button, Card, CompanyLogo, EmptyState, ErrorBox, Flags, Spinner, StageBadge, fmtDate, daysAgo, logoDomain } from '@/components/crm/ui';
import { ActivityModal, CompanyModal, ContactModal, DealModal, MeetingModal, NextStepModal, StageSelect } from '@/components/crm/forms';
import { TranscriptModal, fmtDuration } from '@/components/crm/transcript';
import { RecordingModal, UploadRecordingButton } from '@/components/crm/recording';
import { ArrowRight, CalendarPlus, ClipboardCheck, ExternalLink, FileText, Headphones, Pencil, Plus, MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';

// Everything about one account: contacts, deals, full activity timeline, every past meeting capture.

export default function CompanyPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { timezone } = useCrm();
  const q = useCompanyBrief(id);
  const b = q.data;
  const [editCompany, setEditCompany] = useState(false);
  const [contactModal, setContactModal] = useState<{ open: boolean; contact?: Partial<Contact> | null }>({ open: false });
  const [dealModal, setDealModal] = useState(false);
  const [activityFor, setActivityFor] = useState<string | null | undefined>(undefined); // deal id or null (company level); undefined = closed
  const [meetingFor, setMeetingFor] = useState<Deal | null>(null);
  const [nextStepFor, setNextStepFor] = useState<Deal | null>(null);
  const [transcriptFor, setTranscriptFor] = useState<string | null>(null); // meeting id
  const [recordingFor, setRecordingFor] = useState<string | null>(null); // meeting id — audio without a transcript

  const timeline = useMemo(() => {
    if (!b) return [];
    const acts = b.activities.map((a) => ({ kind: 'activity' as const, at: a.at, a }));
    const meets = b.meetings.map((m) => ({ kind: 'meeting' as const, at: m.scheduled_at, m }));
    const hist = b.deals.flatMap((d) => d.stage_history.filter((h) => h.from).map((h) => ({ kind: 'stage' as const, at: h.at, h, d })));
    return [...acts, ...meets, ...hist].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
  }, [b]);

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} />;
  if (!b) return <EmptyState title="Company not found" />;
  const c = b.company;
  const contacts = b.contacts;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/crm/companies" className="text-xs text-gray-400 hover:text-gray-600">Companies /</Link>
            <CompanyLogo name={c.name} domain={logoDomain(c.domain ?? c.website, contacts.map((ct) => ct.email))} size="lg" />
            <h1 className="text-xl font-bold text-gray-900">{c.name}</h1>
            {c.website && <a href={c.website.startsWith('http') ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-indigo-600"><ExternalLink className="w-4 h-4" /></a>}
            <Button size="xs" variant="ghost" onClick={() => setEditCompany(true)}><Pencil className="w-3 h-3" /> Edit</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 mt-1">
            {c.domain && <span>{c.domain}</span>}{c.country && <span>· {c.country}</span>}{c.timezone && <span>· {c.timezone}</span>}
            <Badge tone="indigo">{c.icp_segment ?? 'unsegmented'}</Badge><Badge tone="gray">via {c.source_channel ?? '?'}</Badge>
          </div>
          {c.notes && <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap max-w-3xl bg-amber-50/60 border border-amber-100 rounded-md px-3 py-2">{c.notes}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setActivityFor(null)}><MessageSquarePlus className="w-3.5 h-3.5" /> Log activity</Button>
          <Button size="sm" onClick={() => setDealModal(true)}><Plus className="w-3.5 h-3.5" /> New deal</Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[2fr_3fr] gap-3">
        <div className="space-y-3">
          <Card title="Contacts" actions={<Button size="xs" variant="secondary" onClick={() => setContactModal({ open: true, contact: null })}><Plus className="w-3 h-3" /> Add</Button>} dense>
            <ul className="divide-y divide-gray-100">
              {contacts.length === 0 && <li className="px-3 py-3 text-sm text-gray-400">No contacts yet.</li>}
              {contacts.map((ct) => (
                <li key={ct.id} className="px-3 py-2 text-sm flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900">{ct.name} {ct.is_primary && <Badge tone="green">primary</Badge>}</div>
                    <div className="text-xs text-gray-500">{[ct.role, ct.email, ct.phone, ct.timezone].filter(Boolean).join(' · ')}{ct.linkedin_url && <> · <a className="text-indigo-600 hover:underline" href={ct.linkedin_url} target="_blank" rel="noreferrer">LinkedIn</a></>}</div>
                  </div>
                  <Button size="xs" variant="ghost" onClick={() => setContactModal({ open: true, contact: ct })}><Pencil className="w-3 h-3" /></Button>
                </li>
              ))}
            </ul>
          </Card>

          <Card title={`Deals (${b.deals.length})`} dense>
            <ul className="divide-y divide-gray-100">
              {b.deals.length === 0 && <li className="px-3 py-3 text-sm text-gray-400">No deals. Create one to start tracking.</li>}
              {b.deals.map((d) => (
                <li key={d.id} className={cn('px-3 py-2.5 text-sm', d.is_stale && 'bg-red-50/40')}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <StageSelect deal={{ id: d.id, company: c.name, stage: d.stage }} />
                    <span className="font-semibold text-gray-900 tabular-nums">{fmtMoney(d.value_monthly, d.currency)}<span className="text-gray-400 text-xs">/mo</span></span>
                    {d.videos_per_month && <span className="text-gray-500 text-xs">{d.videos_per_month} videos/mo</span>}
                    <span className="text-gray-500 text-xs">· {d.owner_name ?? 'no owner'} · {d.days_in_stage}d in stage</span>
                    <Flags stale={d.is_stale} stuck={d.is_stuck} slipping={d.is_slipping} />
                  </div>
                  {d.title && <div className="text-xs text-gray-500 mt-0.5">{d.title}</div>}
                  <div className="mt-1 flex items-center justify-between gap-2 flex-wrap">
                    <div className="text-gray-700">{d.is_active ? (d.next_step ? <>Next: {d.next_step} <span className="text-gray-400">({fmtDate(d.next_step_date)})</span></> : <span className="text-amber-700">No next step</span>) : d.stage === 'lost' ? <span className="text-red-700">Lost: {d.lost_reason ?? '—'}</span> : <span className="text-green-700">Won {fmtDate(d.closed_at)}</span>}</div>
                    {d.is_active && (
                      <div className="flex items-center gap-1">
                        <Button size="xs" variant="secondary" onClick={() => setNextStepFor(d)}>Next step</Button>
                        <Button size="xs" variant="secondary" onClick={() => setMeetingFor(d)}><CalendarPlus className="w-3 h-3" /> Meeting</Button>
                        <Button size="xs" variant="secondary" onClick={() => setActivityFor(d.id)}>Activity</Button>
                      </div>
                    )}
                  </div>
                  {d.stage_history.length > 1 && <div className="mt-1 text-[11px] text-gray-400 truncate" title={d.stage_history.map((h) => `${h.from ?? 'start'} → ${h.to} ${fmtDate(h.at)}${h.reason ? ` (${h.reason})` : ''}`).join('\n')}>{d.stage_history.map((h) => STAGE_LABELS[h.to]).join(' → ')}</div>}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Meetings & captures" dense>
            <ul className="divide-y divide-gray-100">
              {b.meetings.length === 0 && <li className="px-3 py-3 text-sm text-gray-400">No meetings yet.</li>}
              {b.meetings.map((m) => {
                const past = new Date(m.scheduled_at).getTime() < Date.now();
                return (
                  <li key={m.meeting_id} className="px-3 py-2 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900 tabular-nums">{fmtDate(m.scheduled_at, { time: true, tz: timezone })}</span>
                      <Badge tone={m.status === 'held' ? 'green' : m.status === 'no_show' ? 'red' : m.status === 'cancelled' ? 'gray' : 'blue'}>{m.status.replace('_', '-')}</Badge>
                      {m.contact && <span className="text-gray-600">with {m.contact}</span>}
                      {m.status === 'scheduled' && past && <Link href={`/crm/capture?meeting=${m.meeting_id}`}><Button size="xs"><ClipboardCheck className="w-3 h-3" /> Capture now</Button></Link>}
                      {m.status === 'scheduled' && !past && <Link href={`/crm/capture?meeting=${m.meeting_id}`} className="text-xs text-indigo-600 hover:underline">capture</Link>}
                      {m.transcript && <Button size="xs" variant="secondary" onClick={() => setTranscriptFor(m.meeting_id)} title={m.transcript.summary ?? 'Open the call transcript'}><FileText className="w-3 h-3" /> Transcript · {fmtDuration(m.transcript.duration_seconds)}{m.recording ? ' + audio' : ''}</Button>}
                      {m.recording && !m.transcript && <Button size="xs" variant="secondary" onClick={() => setRecordingFor(m.meeting_id)}><Headphones className="w-3 h-3" /> Recording{m.recording.duration_seconds ? ` · ${fmtDuration(m.recording.duration_seconds)}` : ''}</Button>}
                      {!m.recording && !m.transcript && m.status !== 'cancelled' && past && <UploadRecordingButton meetingId={m.meeting_id} />}
                    </div>
                    {m.notes && <div className="text-xs text-gray-500 mt-0.5">{m.notes}</div>}
                    {m.capture && <CaptureDetail capture={m.capture} />}
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>

        <Card title={`Timeline (${timeline.length})`} dense className="max-h-[calc(100vh-9rem)]">
          <ul className="divide-y divide-gray-100 overflow-auto max-h-full">
            {timeline.length === 0 && <li className="px-3 py-3 text-sm text-gray-400">Nothing yet — log the first touch.</li>}
            {timeline.map((t, i) => (
              <li key={i} className="px-3 py-1.5 text-sm flex gap-3">
                <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap w-28 pt-0.5" title={t.at}>{fmtDate(t.at, { time: true, tz: timezone })}</span>
                <div className="flex-1 min-w-0">
                  {t.kind === 'activity' && <><span className={cn('font-medium', t.a.direction === 'inbound' ? 'text-green-700' : 'text-gray-800')}>{t.a.direction === 'inbound' ? '← ' : '→ '}{t.a.type}</span>{t.a.channel && <span className="text-gray-400"> · {t.a.channel}</span>}{t.a.contact && <span className="text-gray-500"> · {t.a.contact}</span>}{t.a.outcome && <Badge tone={t.a.outcome === 'connected' || t.a.outcome === 'accepted' || t.a.outcome === 'replied' || t.a.outcome === 'booked' ? 'green' : 'gray'} className="ml-1">{t.a.outcome}</Badge>}{t.a.by && <span className="text-gray-400 text-xs"> · {t.a.by}</span>}{t.a.body && <div className="text-gray-600 whitespace-pre-wrap">{t.a.body}</div>}</>}
                  {t.kind === 'meeting' && <><span className="font-medium text-purple-700">Meeting</span> <Badge tone={t.m.status === 'held' ? 'green' : t.m.status === 'no_show' ? 'red' : 'blue'}>{t.m.status.replace('_', '-')}</Badge>{t.m.contact && <span className="text-gray-500"> · {t.m.contact}</span>}{t.m.capture?.pain_points?.length ? <div className="text-gray-600">“{t.m.capture.pain_points[0]}”{t.m.capture.pain_points.length > 1 ? ` +${t.m.capture.pain_points.length - 1}` : ''}</div> : null}</>}
                  {t.kind === 'stage' && <><span className="text-gray-500">Stage</span> <StageBadge stage={t.h.from!} /> → <StageBadge stage={t.h.to} />{t.h.reason && <span className="text-gray-500"> · {t.h.reason}</span>}{t.h.by && <span className="text-gray-400 text-xs"> · {t.h.by}</span>}</>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <CompanyModal company={c} open={editCompany} onClose={() => setEditCompany(false)} />
      <ContactModal companyId={c.id} contact={contactModal.contact} open={contactModal.open} onClose={() => setContactModal({ open: false })} />
      <DealModal companyId={c.id} open={dealModal} onClose={() => setDealModal(false)} />
      <ActivityModal companyId={c.id} contacts={contacts} dealId={activityFor ?? undefined} open={activityFor !== undefined} onClose={() => setActivityFor(undefined)} />
      {meetingFor && <MeetingModal dealId={meetingFor.id} contacts={contacts} defaultTz={c.timezone} open={!!meetingFor} onClose={() => setMeetingFor(null)} />}
      <TranscriptModal meetingId={transcriptFor} onClose={() => setTranscriptFor(null)} />
      <RecordingModal meetingId={recordingFor} title={c.name} onClose={() => setRecordingFor(null)} />
      <NextStepModal deal={nextStepFor ? { id: nextStepFor.id, company: c.name, next_step: nextStepFor.next_step, next_step_date: nextStepFor.next_step_date } : null} open={!!nextStepFor} onClose={() => setNextStepFor(null)} />
      <div className="text-[11px] text-gray-400">Last activity {daysAgo(b.deals.map((d) => d.last_activity_at).filter(Boolean).sort().pop() ?? null)}{b.delivery_project_ids.length ? ` · delivery projects: ${b.delivery_project_ids.join(', ')}` : ''}</div>
    </div>
  );
}

// A saved meeting capture, laid out for scanning: summary first, the numbers, the agreed next step, then the prospect's own words.
function CaptureDetail({ capture: cap }: { capture: Capture & { tags: string[] } }) {
  const [allPains, setAllPains] = useState(false);

  if (cap.outcome !== 'held') {
    return (
      <div className="mt-2 rounded-lg border border-red-100 bg-red-50/50 px-3 py-2.5 text-xs space-y-1.5">
        <div className="flex items-center gap-1.5 text-red-800 font-medium">No-show{cap.no_show_reason && <span className="font-normal text-gray-700">· {cap.no_show_reason}</span>}{cap.is_repeat_no_show && <Badge tone="red">repeat</Badge>}</div>
        {cap.follow_up_action && <NextRow label="Follow-up" text={cap.follow_up_action} date={cap.follow_up_date} />}
        {cap.raw_notes && <p className="text-gray-600 whitespace-pre-wrap leading-relaxed">{cap.raw_notes}</p>}
      </div>
    );
  }

  // "From recording (26 min): …" → label + body
  const summaryMatch = cap.raw_notes?.match(/^From recording(?: \(([^)]+)\))?:\s*/i);
  const summary = summaryMatch ? cap.raw_notes!.slice(summaryMatch[0].length) : cap.raw_notes;

  const com = cap.commercials_discussed ?? {};
  const currency = typeof com.currency === 'string' ? com.currency : null;
  const comNote = typeof com.notes === 'string' ? com.notes : null;
  const facts = Object.entries(com)
    .filter(([k, v]) => k !== 'currency' && k !== 'notes' && v != null && v !== '')
    .map(([k, v]) => ({
      label: k.replace(/_/g, ' '),
      value: /price|value|amount|budget|quote|fee/i.test(k) && !isNaN(Number(v)) ? fmtMoney(Number(v), currency) : String(v),
    }));

  const objections = cap.objections.flatMap((o) => o.split(/;\s+/)).filter(Boolean);
  const pains = allPains ? cap.pain_points : cap.pain_points.slice(0, 3);

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-white text-xs divide-y divide-gray-100">
      {summary && (
        <div className="px-3 py-2.5">
          <SectionLabel>Summary{summaryMatch?.[1] ? ` · from ${summaryMatch[1]} recording` : ''}</SectionLabel>
          <p className="text-[13px] text-gray-800 leading-relaxed whitespace-pre-wrap">{summary}</p>
        </div>
      )}

      {(cap.is_dead || cap.next_step) && (
        <div className="px-3 py-2.5">
          {cap.is_dead
            ? <div className="text-red-700"><span className="font-medium">Dead</span> · {cap.dead_reason}</div>
            : <NextRow label="Next step" text={cap.next_step!} date={cap.next_step_date} />}
        </div>
      )}

      {(facts.length > 0 || comNote) && (
        <div className="px-3 py-2.5">
          <SectionLabel>Commercials</SectionLabel>
          {facts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {facts.map((f) => (
                <div key={f.label} className="rounded-md bg-gray-50 border border-gray-100 px-2.5 py-1.5 min-w-[5.5rem]">
                  <div className="text-[10px] uppercase tracking-wide text-gray-400">{f.label}</div>
                  <div className="text-sm font-semibold text-gray-900 tabular-nums">{f.value}</div>
                </div>
              ))}
            </div>
          )}
          {comNote && <p className={cn('text-gray-600 leading-relaxed', facts.length > 0 && 'mt-2')}>{comNote}</p>}
        </div>
      )}

      {objections.length > 0 && (
        <div className="px-3 py-2.5">
          <SectionLabel>Objections</SectionLabel>
          <ul className="space-y-1">
            {objections.map((o, i) => (
              <li key={i} className="flex gap-2 text-gray-800"><span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />{o}</li>
            ))}
          </ul>
        </div>
      )}

      {cap.pain_points.length > 0 && (
        <div className="px-3 py-2.5">
          <SectionLabel>In their words</SectionLabel>
          <ul className="space-y-1.5">
            {pains.map((p, i) => (
              <li key={i} className="border-l-2 border-indigo-200 pl-2.5 text-gray-700 italic leading-relaxed">“{p}”</li>
            ))}
          </ul>
          {cap.pain_points.length > 3 && (
            <button type="button" onClick={() => setAllPains((v) => !v)} className="mt-1.5 text-indigo-600 hover:underline">
              {allPains ? 'Show fewer' : `Show all ${cap.pain_points.length} quotes`}
            </button>
          )}
        </div>
      )}

      {cap.tags.length > 0 && (
        <div className="px-3 py-2 flex flex-wrap gap-1">{cap.tags.map((t) => <Badge key={t} tone="gray">{t}</Badge>)}</div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">{children}</div>;
}

function NextRow({ label, text, date }: { label: string; text: string; date: string | null }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-indigo-50/70 border border-indigo-100 px-2.5 py-2">
      <ArrowRight className="w-3.5 h-3.5 mt-0.5 shrink-0 text-indigo-500" />
      <div className="flex-1 min-w-0 text-gray-800 leading-relaxed"><span className="font-medium text-indigo-900">{label}:</span> {text}</div>
      {date && <span className="shrink-0 rounded bg-white border border-indigo-100 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 tabular-nums">{fmtDate(date)}</span>}
    </div>
  );
}
