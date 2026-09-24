'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useMeeting, useMeetings } from '@/lib/crm/queries';
import { fmtMoney, type Meeting } from '@/lib/crm/types';
import { addDaysISO, Badge, Button, Card, EmptyState, ErrorBox, fmtDate, Input, PageLoader, Select, StageBadge, Textarea, todayISO } from '@/components/crm/ui';
import { useWrite } from '@/components/crm/forms';
import { cn } from '@/lib/utils';
import { CheckCircle2, UserX } from 'lucide-react';

// The post-meeting form. Outcome first, then only the fields that outcome needs. Fillable in under a minute.
// Pain points are free text (one per line) that tokenise into tags on save.

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function MeetingPicker({ onPick }: { onPick: (id: string) => void }) {
  const { timezone } = useCrm();
  // Computed once per mount: these go into the query key, so a fresh Date.now() each render would make a new query every render and never leave isLoading.
  const [range] = useState(() => ({ from: new Date(Date.now() - 14 * 86400_000).toISOString(), to: new Date(Date.now() + 1 * 86400_000).toISOString() }));
  const q = useMeetings({ ...range, status: 'scheduled' });
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} />;
  const rows = (q.data ?? []).slice().sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  const past = rows.filter((m) => new Date(m.scheduled_at).getTime() < Date.now());
  const upcoming = rows.filter((m) => new Date(m.scheduled_at).getTime() >= Date.now());
  const Row = ({ m }: { m: Meeting }) => (
    <button onClick={() => onPick(m.id)} className="w-full text-left px-3 py-2 hover:bg-indigo-50 flex items-center gap-3 text-sm border-b border-gray-100">
      <span className="tabular-nums text-gray-500 w-32 whitespace-nowrap">{fmtDate(m.scheduled_at, { time: true, tz: timezone })}</span>
      <span className="font-medium text-gray-900">{m.company_name}</span>
      <span className="text-gray-500">{m.contact_name}{m.contact_role ? ` · ${m.contact_role}` : ''}</span>
      <span className="ml-auto flex items-center gap-2"><StageBadge stage={m.deal_stage} /><span className="text-gray-600 tabular-nums">{fmtMoney(m.value_monthly, m.currency)}</span></span>
    </button>
  );
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <Card title={`Waiting for capture (${past.length})`} dense>{past.length === 0 ? <EmptyState compact title="All past meetings are captured" /> : past.map((m) => <Row key={m.id} m={m} />)}</Card>
      <Card title={`Upcoming (${upcoming.length})`} dense>{upcoming.length === 0 ? <EmptyState compact title="Nothing scheduled in the next day" /> : upcoming.map((m) => <Row key={m.id} m={m} />)}</Card>
    </div>
  );
}

function CaptureForm({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const { timezone, currencies } = useCrm();
  const q = useMeeting(meetingId);
  const { write, busy, error, setError } = useWrite();
  const [outcome, setOutcome] = useState<'held' | 'no_show' | null>(null);
  const [f, setF] = useState({ pain: '', price: '', currency: 'USD', volume: '', commNotes: '', none: false, objections: '', next_step: '', next_step_date: addDaysISO(3), is_dead: false, dead_reason: '', no_show_reason: '', follow_up_action: '', follow_up_date: addDaysISO(1), raw_notes: '' });
  const [done, setDone] = useState<any>(null);
  const m = q.data?.meeting;
  useEffect(() => { if (m?.currency) setF((x) => ({ ...x, currency: m.currency })); }, [m?.currency]);

  const painLines = useMemo(() => lines(f.pain), [f.pain]);
  const tags = useMemo(() => Array.from(new Set(painLines.map((p) => slugify(p.slice(0, 60))).filter(Boolean))), [painLines]);

  const save = async () => {
    if (!outcome) return;
    const p: Record<string, unknown> = outcome === 'held'
      ? { pain_points: painLines, commercials_discussed: f.none ? { none: true } : { price: f.price ? Number(f.price) : undefined, currency: f.currency, volume: f.volume ? Number(f.volume) : undefined, notes: f.commNotes || undefined }, objections: lines(f.objections), next_step: f.is_dead ? undefined : f.next_step || undefined, next_step_date: f.is_dead ? undefined : f.next_step_date || undefined, is_dead: f.is_dead, dead_reason: f.is_dead ? f.dead_reason || undefined : undefined, raw_notes: f.raw_notes || undefined }
      : { no_show_reason: f.no_show_reason || undefined, follow_up_action: f.follow_up_action || undefined, follow_up_date: f.follow_up_date || undefined, raw_notes: f.raw_notes || undefined };
    if (outcome === 'held' && !f.none && !f.price && !f.volume && !f.commNotes) { setError('Commercials: enter what was quoted (price / volume) or tick “not discussed”.'); return; }
    const r = await write<any>('capture_meeting', { p_meeting_id: meetingId, p_outcome: outcome, p });
    if (r) setDone(r);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} />;
  if (!m) return <EmptyState title="Meeting not found" action={<Button size="sm" variant="secondary" onClick={() => router.push('/crm/capture')}>Pick another</Button>} />;

  if (done) {
    const d = done.deal ?? {};
    return (
      <Card>
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-8 h-8 text-green-600 flex-shrink-0" />
          <div className="space-y-1 text-sm">
            <div className="text-lg font-semibold text-gray-900">{m.company_name} captured as {outcome === 'held' ? 'held' : 'no-show'}</div>
            <div>Deal is now <StageBadge stage={d.stage} />{d.next_step ? <> · next: <span className="font-medium">{d.next_step}</span> by {fmtDate(d.next_step_date)}</> : d.stage === 'lost' ? <> · lost: {d.lost_reason}</> : null}</div>
            {done.capture?.is_repeat_no_show && <div className="text-red-700 font-medium">⚠ Repeat no-show for this contact — consider whether this lead is real.</div>}
            {done.tags?.length > 0 && <div className="flex flex-wrap gap-1 pt-1">{done.tags.map((t: any) => <Badge key={t.slug} tone="indigo">{t.label}</Badge>)}</div>}
            <div className="flex gap-2 pt-3">
              <Link href={`/crm/companies/${m.company_id}`}><Button size="sm" variant="secondary">Open {m.company_name}</Button></Link>
              <Link href="/crm/capture"><Button size="sm" variant="secondary">Capture another</Button></Link>
              <Link href="/crm"><Button size="sm">Back to standup</Button></Link>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  if (q.data?.capture) {
    return <Card><div className="text-sm">This meeting is already captured as <Badge tone={q.data.capture.outcome === 'held' ? 'green' : 'red'}>{q.data.capture.outcome}</Badge>. Edit it from the <Link className="text-indigo-600 underline" href={`/crm/companies/${m.company_id}`}>company page</Link>.</div></Card>;
  }

  return (
    <div className="max-w-3xl space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div className="text-lg font-semibold text-gray-900">{m.company_name}</div>
          <div className="text-gray-600">{m.contact_name}{m.contact_role ? ` · ${m.contact_role}` : ''}</div>
          <div className="text-gray-500 tabular-nums">{fmtDate(m.scheduled_at, { time: true, tz: timezone })} {timezone}{m.timezone && m.timezone !== timezone ? ` (${fmtDate(m.scheduled_at, { time: true, tz: m.timezone })} ${m.timezone})` : ''}</div>
          <StageBadge stage={m.deal_stage} /><span className="text-gray-600 tabular-nums">{fmtMoney(m.value_monthly, m.currency)}/mo</span>
          <button className="ml-auto text-xs text-gray-400 hover:text-gray-600" onClick={() => router.push('/crm/capture')}>change meeting</button>
        </div>
        {m.notes && <div className="text-xs text-gray-500 mt-1">Agenda: {m.notes}</div>}
      </Card>

      {/* 1. Outcome first */}
      <div className="grid grid-cols-2 gap-3">
        <button onClick={() => setOutcome('held')} className={cn('rounded-lg border-2 p-4 text-left transition-colors', outcome === 'held' ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-white hover:border-gray-300')}>
          <div className="flex items-center gap-2 text-base font-semibold text-gray-900"><CheckCircle2 className={cn('w-5 h-5', outcome === 'held' ? 'text-green-600' : 'text-gray-300')} /> Meeting held</div>
          <div className="text-xs text-gray-500 mt-1">Pain points · commercials · objections · next step or dead</div>
        </button>
        <button onClick={() => setOutcome('no_show')} className={cn('rounded-lg border-2 p-4 text-left transition-colors', outcome === 'no_show' ? 'border-red-500 bg-red-50' : 'border-gray-200 bg-white hover:border-gray-300')}>
          <div className="flex items-center gap-2 text-base font-semibold text-gray-900"><UserX className={cn('w-5 h-5', outcome === 'no_show' ? 'text-red-600' : 'text-gray-300')} /> No-show</div>
          <div className="text-xs text-gray-500 mt-1">Reason · follow-up action · date</div>
        </button>
      </div>

      {/* 2. Only the fields that outcome needs */}
      {outcome === 'held' && (
        <Card>
          <div className="space-y-3">
            <div>
              <Textarea autoFocus label="Pain points — in their words, one per line" value={f.pain} onChange={(e) => setF({ ...f, pain: e.target.value })} placeholder={"our current UGC creators are flaky — half the videos come late\nwe cannot test 30 hooks a month with one editor"} className="min-h-[96px]" />
              {tags.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{tags.map((t) => <Badge key={t} tone="indigo">{t.replace(/_/g, ' ')}</Badge>)}<span className="text-[11px] text-gray-400 self-center">tags on save</span></div>}
            </div>
            <div className="rounded-md border border-gray-200 p-3">
              <div className="flex items-center justify-between mb-2"><span className="text-xs font-medium text-gray-600">Commercials discussed</span><label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={f.none} onChange={(e) => setF({ ...f, none: e.target.checked })} /> not discussed</label></div>
              {!f.none && (
                <div className="grid grid-cols-4 gap-2">
                  <Input label="Price quoted" type="number" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
                  <Select label="Currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
                  <Input label="Volume (videos/mo)" type="number" value={f.volume} onChange={(e) => setF({ ...f, volume: e.target.value })} />
                  <Input label="Notes" value={f.commNotes} onChange={(e) => setF({ ...f, commNotes: e.target.value })} placeholder="per video, pilot…" />
                </div>
              )}
            </div>
            <Textarea label="Objections — one per line (optional)" value={f.objections} onChange={(e) => setF({ ...f, objections: e.target.value })} className="min-h-[56px]" />
            <div className="rounded-md border border-gray-200 p-3">
              <label className="flex items-center gap-1.5 text-sm text-gray-700 mb-2"><input type="checkbox" checked={f.is_dead} onChange={(e) => setF({ ...f, is_dead: e.target.checked })} /> The deal is dead</label>
              {f.is_dead ? <Input label="Why" value={f.dead_reason} onChange={(e) => setF({ ...f, dead_reason: e.target.value })} placeholder="Budget frozen till Q1; hired in-house editor" /> : (
                <div className="grid grid-cols-[1fr_160px] gap-2">
                  <Input label="Next step" value={f.next_step} onChange={(e) => setF({ ...f, next_step: e.target.value })} placeholder="Send proposal with Arabic samples" />
                  <Input label="By" type="date" value={f.next_step_date} onChange={(e) => setF({ ...f, next_step_date: e.target.value })} />
                </div>
              )}
            </div>
            <Textarea label="Raw notes (optional)" value={f.raw_notes} onChange={(e) => setF({ ...f, raw_notes: e.target.value })} className="min-h-[56px]" />
          </div>
        </Card>
      )}

      {outcome === 'no_show' && (
        <Card>
          <div className="space-y-3">
            <Input autoFocus label="What happened" value={f.no_show_reason} onChange={(e) => setF({ ...f, no_show_reason: e.target.value })} placeholder="Did not join; no reply to reminder 10 min before" />
            <div className="grid grid-cols-[1fr_160px] gap-2">
              <Input label="Follow-up action" value={f.follow_up_action} onChange={(e) => setF({ ...f, follow_up_action: e.target.value })} placeholder="Call to rebook; send 2 samples first" />
              <Input label="On" type="date" value={f.follow_up_date} onChange={(e) => setF({ ...f, follow_up_date: e.target.value })} />
            </div>
            <Textarea label="Raw notes (optional)" value={f.raw_notes} onChange={(e) => setF({ ...f, raw_notes: e.target.value })} className="min-h-[56px]" />
          </div>
        </Card>
      )}

      {error && <ErrorBox message={error} />}
      {outcome && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">⌘/Ctrl + Enter to save · the meeting only becomes {outcome === 'held' ? 'held' : 'a no-show'} when every required field is present</span>
          <Button onClick={save} loading={busy} size="md">Save capture</Button>
        </div>
      )}
    </div>
  );
}

function CaptureInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const meetingId = sp.get('meeting');
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-3"><h1 className="text-lg font-bold text-gray-900">Capture</h1><span className="text-xs text-gray-500">Right after the meeting, in their words, under a minute.</span></div>
      {meetingId ? <CaptureForm key={meetingId} meetingId={meetingId} /> : <MeetingPicker onPick={(id) => router.push(`/crm/capture?meeting=${id}`)} />}
    </div>
  );
}

export default function CapturePage() {
  return <Suspense fallback={<PageLoader />}><CaptureInner /></Suspense>;
}
