'use client';

import { useEffect, useMemo, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { rpc, compact, parseError } from '@/lib/crm/api';
import { useCrmInvalidate } from '@/lib/crm/queries';
import { COMMIT_KEYS, stageRank, STAGE_LABELS, STAGES, type Contact, type DealStage, type Company } from '@/lib/crm/types';
import { Button, Input, Select, Textarea, Modal, Field, ErrorBox, addDaysISO, todayISO } from './ui';

export const TZ_OPTIONS = ['Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Singapore', 'Australia/Sydney'];
const OUTCOMES = ['', 'connected', 'no_answer', 'voicemail', 'accepted', 'replied', 'booked', 'left_message', 'bounced'];

/** Shared write helper: runs a crm_* RPC, invalidates CRM queries, surfaces the parsed error. */
export function useWrite() {
  const invalidate = useCrmInvalidate();
  const { refresh } = useCrm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = async <T,>(name: string, args: Record<string, unknown>, opts: { refreshContext?: boolean } = {}): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try {
      const r = await rpc<T>(name, args);
      await invalidate();
      if (opts.refreshContext) await refresh();
      return r;
    } catch (e) {
      setError(parseError(e).message);
      return undefined;
    } finally { setBusy(false); }
  };
  return { write, busy, error, setError };
}

const localNow = () => { const d = new Date(); d.setSeconds(0, 0); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const toISO = (local: string) => (local ? new Date(local).toISOString() : undefined);
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------- next step
export function NextStepModal({ deal, open, onClose }: { deal: { id: string; company: string; next_step?: string | null; next_step_date?: string | null } | null; open: boolean; onClose: () => void }) {
  const { write, busy, error } = useWrite();
  const [step, setStep] = useState(''); const [date, setDate] = useState('');
  useEffect(() => { if (open) { setStep(deal?.next_step ?? ''); setDate(deal?.next_step_date ?? addDaysISO(2)); } }, [open, deal]);
  if (!deal) return null;
  const save = async () => { const r = await write('update_deal', { p_deal_id: deal.id, p: { next_step: step || null, next_step_date: date || null }, p_reason: null }); if (r) onClose(); };
  return (
    <Modal open={open} onClose={onClose} title={`Next step — ${deal.company}`} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        <Input autoFocus label="Next step" value={step} onChange={(e) => setStep(e.target.value)} placeholder="Send proposal with Arabic samples" onKeyDown={(e) => e.key === 'Enter' && save()} />
        <Input label="By" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- stage change
export function StageModal({ deal, toStage, open, onClose }: { deal: { id: string; company: string; stage: DealStage } | null; toStage: DealStage | null; open: boolean; onClose: () => void }) {
  const { write, busy, error } = useWrite();
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  if (!deal || !toStage) return null;
  const backwards = toStage !== 'lost' && stageRank(toStage) < stageRank(deal.stage);
  const lost = toStage === 'lost';
  const save = async () => {
    const r = await write('update_deal', { p_deal_id: deal.id, p: compact({ stage: toStage, lost_reason: lost ? reason || undefined : undefined }), p_reason: reason || null });
    if (r) onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={`${deal.company}: ${STAGE_LABELS[deal.stage]} → ${STAGE_LABELS[toStage]}`} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} disabled={(backwards || lost) && !reason.trim()}>Move</Button></>}>
      <div className="space-y-3">
        {backwards && <p className="text-sm text-amber-700 bg-amber-50 rounded-md p-2">Moving backwards. A reason is required and is written to the stage history.</p>}
        {(backwards || lost) ? <Textarea autoFocus label={lost ? 'Lost reason' : 'Reason'} value={reason} onChange={(e) => setReason(e.target.value)} /> : <p className="text-sm text-gray-600">Stage history is written automatically.</p>}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

/** Stage picker that opens StageModal only when needed (backwards / lost); forward moves save immediately. */
export function StageSelect({ deal, size = 'sm' }: { deal: { id: string; company: string; stage: DealStage }; size?: 'sm' | 'md' }) {
  const { write, busy } = useWrite();
  const [pending, setPending] = useState<DealStage | null>(null);
  const change = async (to: DealStage) => {
    if (to === deal.stage) return;
    if (to === 'lost' || stageRank(to) < stageRank(deal.stage)) { setPending(to); return; }
    await write('update_deal', { p_deal_id: deal.id, p: { stage: to }, p_reason: null });
  };
  return (
    <>
      <select value={deal.stage} disabled={busy} onChange={(e) => change(e.target.value as DealStage)} className={`rounded-md border border-gray-300 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${size === 'sm' ? 'text-xs px-1.5 py-1' : 'text-sm px-2 py-1.5'}`}>
        {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
      </select>
      <StageModal deal={deal} toStage={pending} open={!!pending} onClose={() => setPending(null)} />
    </>
  );
}

// ---------------------------------------------------------------- activity
export function ActivityModal({ companyId, contacts, dealId, open, onClose }: { companyId: string; contacts: Pick<Contact, 'id' | 'name' | 'role'>[]; dealId?: string | null; open: boolean; onClose: () => void }) {
  const { lookups, activeMembers, me } = useCrm();
  const { write, busy, error } = useWrite();
  const types = lookups('activity_type'); const channels = lookups('source_channel');
  const [f, setF] = useState({ contact_id: '', activity_type: '', direction: 'outbound', outcome: '', occurred_at: localNow(), source_channel: '', body: '', owner: '' });
  useEffect(() => { if (open) setF({ contact_id: contacts[0]?.id ?? '', activity_type: types[0]?.id ?? '', direction: 'outbound', outcome: '', occurred_at: localNow(), source_channel: '', body: '', owner: me?.user_id ?? '' }); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const r = await write('log_activity', { p: compact({ contact_id: f.contact_id || undefined, company_id: companyId, deal_id: dealId ?? undefined, activity_type: f.activity_type, direction: f.direction, outcome: f.outcome || undefined, occurred_at: toISO(f.occurred_at), source_channel: f.source_channel || undefined, body: f.body || undefined, owner: f.owner || undefined }) });
    if (r) onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Log activity" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} disabled={!f.activity_type}>Log</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Type" value={f.activity_type} onChange={(e) => setF({ ...f, activity_type: e.target.value })}>{types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select>
        <Select label="Direction" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="outbound">Outbound (we reached out)</option><option value="inbound">Inbound (they replied)</option></Select>
        <Select label="Contact" value={f.contact_id} onChange={(e) => setF({ ...f, contact_id: e.target.value })}><option value="">— company level —</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.role ? ` · ${c.role}` : ''}</option>)}</Select>
        <Select label="Outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{OUTCOMES.map((o) => <option key={o} value={o}>{o || '—'}</option>)}</Select>
        <Input label="When" type="datetime-local" value={f.occurred_at} onChange={(e) => setF({ ...f, occurred_at: e.target.value })} />
        <Select label="Channel" value={f.source_channel} onChange={(e) => setF({ ...f, source_channel: e.target.value })}><option value="">— deal's channel —</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
        <Select label="By" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>{activeMembers.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</Select>
        <div className="col-span-2"><Textarea label="Notes" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="What was said / sent" /></div>
        {error && <div className="col-span-2"><ErrorBox message={error} /></div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- meeting
export function MeetingModal({ dealId, contacts, defaultTz, open, onClose }: { dealId: string; contacts: Pick<Contact, 'id' | 'name' | 'timezone'>[]; defaultTz?: string | null; open: boolean; onClose: () => void }) {
  const { timezone } = useCrm();
  const { write, busy, error } = useWrite();
  const [f, setF] = useState({ contact_id: '', scheduled_at: '', timezone: '', duration_min: '30', attendees: '', notes: '' });
  useEffect(() => { if (open) { const c = contacts[0]; setF({ contact_id: c?.id ?? '', scheduled_at: localNow(), timezone: c?.timezone ?? defaultTz ?? timezone, duration_min: '30', attendees: c?.name ?? '', notes: '' }); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const r = await write('schedule_meeting', { p: compact({ deal_id: dealId, contact_id: f.contact_id || undefined, scheduled_at: toISO(f.scheduled_at), timezone: f.timezone || undefined, duration_min: Number(f.duration_min) || 30, attendees: f.attendees.split(',').map((s) => s.trim()).filter(Boolean), notes: f.notes || undefined }) });
    if (r) onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Schedule meeting" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} disabled={!f.scheduled_at}>Book</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Input label="When (your local time)" type="datetime-local" value={f.scheduled_at} onChange={(e) => setF({ ...f, scheduled_at: e.target.value })} />
        <Field label="Prospect timezone"><input list="crm-tz" className="w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-300" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /><datalist id="crm-tz">{TZ_OPTIONS.map((t) => <option key={t} value={t} />)}</datalist></Field>
        <Select label="Contact" value={f.contact_id} onChange={(e) => setF({ ...f, contact_id: e.target.value })}><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Input label="Duration (min)" type="number" value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: e.target.value })} />
        <div className="col-span-2"><Input label="Attendees (comma separated)" value={f.attendees} onChange={(e) => setF({ ...f, attendees: e.target.value })} /></div>
        <div className="col-span-2"><Textarea label="Agenda / notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        {error && <div className="col-span-2"><ErrorBox message={error} /></div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- company
export function CompanyModal({ company, open, onClose, onSaved }: { company?: Partial<Company> | null; open: boolean; onClose: () => void; onSaved?: (c: Company) => void }) {
  const { lookups, timezone } = useCrm();
  const { write, busy, error } = useWrite();
  const segs = lookups('icp_segment'); const chans = lookups('source_channel');
  const [f, setF] = useState({ name: '', website: '', country: '', timezone: '', icp_segment: '', source_channel: '', notes: '' });
  useEffect(() => { if (open) setF({ name: company?.name ?? '', website: company?.website ?? '', country: company?.country ?? '', timezone: company?.timezone ?? timezone, icp_segment: company?.icp_segment_id ?? '', source_channel: company?.source_channel_id ?? '', notes: company?.notes ?? '' }); }, [open, company, timezone]);
  const save = async () => {
    const r = await write<Company>('upsert_company', { p: { id: company?.id ?? undefined, name: f.name, website: f.website || null, country: f.country || null, timezone: f.timezone || null, icp_segment: f.icp_segment || null, source_channel: f.source_channel || null, notes: f.notes || null } });
    if (r) { onSaved?.(r); onClose(); }
  };
  return (
    <Modal open={open} onClose={onClose} title={company?.id ? 'Edit company' : 'New company'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} disabled={!f.name.trim()}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Input autoFocus label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Website" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="https://…" />
        <Input label="Country" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} />
        <Field label="Timezone"><input list="crm-tz2" className="w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-300" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /><datalist id="crm-tz2">{TZ_OPTIONS.map((t) => <option key={t} value={t} />)}</datalist></Field>
        <Select label="ICP segment" value={f.icp_segment} onChange={(e) => setF({ ...f, icp_segment: e.target.value })}><option value="">—</option>{segs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
        <Select label="Source channel" value={f.source_channel} onChange={(e) => setF({ ...f, source_channel: e.target.value })}><option value="">—</option>{chans.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
        <div className="col-span-2"><Textarea label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Anything the team should know before a call" /></div>
        {error && <div className="col-span-2"><ErrorBox message={error} /></div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- contact
export function ContactModal({ companyId, contact, open, onClose }: { companyId: string; contact?: Partial<Contact> | null; open: boolean; onClose: () => void }) {
  const { write, busy, error } = useWrite();
  const [f, setF] = useState({ name: '', role: '', email: '', phone: '', linkedin_url: '', timezone: '', is_primary: false });
  useEffect(() => { if (open) setF({ name: contact?.name ?? '', role: contact?.role ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '', linkedin_url: contact?.linkedin_url ?? '', timezone: contact?.timezone ?? '', is_primary: contact?.is_primary ?? false }); }, [open, contact]);
  const save = async () => {
    const r = await write('upsert_contact', { p: { id: contact?.id ?? undefined, company_id: companyId, name: f.name, role: f.role || null, email: f.email || null, phone: f.phone || null, linkedin_url: f.linkedin_url || null, timezone: f.timezone || null, is_primary: f.is_primary } });
    if (r) onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={contact?.id ? 'Edit contact' : 'New contact'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} disabled={!f.name.trim()}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Input autoFocus label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
        <Input label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Input label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Input label="LinkedIn URL" value={f.linkedin_url} onChange={(e) => setF({ ...f, linkedin_url: e.target.value })} />
        <Field label="Timezone"><input list="crm-tz3" className="w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-300" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /><datalist id="crm-tz3">{TZ_OPTIONS.map((t) => <option key={t} value={t} />)}</datalist></Field>
        <label className="col-span-2 flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={f.is_primary} onChange={(e) => setF({ ...f, is_primary: e.target.checked })} /> Primary contact</label>
        {error && <div className="col-span-2"><ErrorBox message={error} /></div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- deal
export function DealModal({ companyId, open, onClose }: { companyId: string; open: boolean; onClose: () => void }) {
  const { lookups, activeMembers, me, currencies, data } = useCrm();
  const { write, busy, error } = useWrite();
  const chans = lookups('source_channel');
  const defCur = (data?.settings?.default_currency as string | undefined) ?? 'USD';
  const [f, setF] = useState({ title: '', owner: '', value_monthly: '', currency: defCur, videos_per_month: '', expected_close_date: '', next_step: '', next_step_date: addDaysISO(2), source_channel: '' });
  useEffect(() => { if (open) setF({ title: '', owner: me?.user_id ?? '', value_monthly: '', currency: defCur, videos_per_month: '', expected_close_date: '', next_step: '', next_step_date: addDaysISO(2), source_channel: '' }); }, [open, me, defCur]);
  const save = async () => {
    const r = await write('create_deal', { p: compact({ company_id: companyId, title: f.title || undefined, owner: f.owner || undefined, value_monthly: f.value_monthly ? Number(f.value_monthly) : undefined, currency: f.currency, videos_per_month: f.videos_per_month ? Number(f.videos_per_month) : undefined, expected_close_date: f.expected_close_date || undefined, next_step: f.next_step || undefined, next_step_date: f.next_step ? f.next_step_date || undefined : undefined, source_channel: f.source_channel || undefined }) });
    if (r) onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="New deal" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Create</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Title (optional)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Q4 UGC batch" />
        <Select label="Owner" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>{activeMembers.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</Select>
        <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
          <Input label="Monthly value" type="number" value={f.value_monthly} onChange={(e) => setF({ ...f, value_monthly: e.target.value })} />
          <Select label="Currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        </div>
        <Input label="Videos / month" type="number" value={f.videos_per_month} onChange={(e) => setF({ ...f, videos_per_month: e.target.value })} />
        <Input label="Expected close" type="date" value={f.expected_close_date} onChange={(e) => setF({ ...f, expected_close_date: e.target.value })} />
        <Select label="Source channel" value={f.source_channel} onChange={(e) => setF({ ...f, source_channel: e.target.value })}><option value="">— company's —</option>{chans.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
        <Input label="Next step" value={f.next_step} onChange={(e) => setF({ ...f, next_step: e.target.value })} />
        <Input label="By" type="date" value={f.next_step_date} onChange={(e) => setF({ ...f, next_step_date: e.target.value })} />
        {error && <div className="col-span-2"><ErrorBox message={error} /></div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- commitments
export function CommitmentForm({ date, onSaved }: { date?: string; onSaved?: () => void }) {
  const { activeMembers, me } = useCrm();
  const { write, busy, error } = useWrite();
  const [owner, setOwner] = useState(me?.user_id ?? '');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  useEffect(() => { if (!owner && me) setOwner(me.user_id); }, [me, owner]);
  const targets = useMemo(() => Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== '' && !isNaN(Number(v))).map(([k, v]) => [k, Number(v)])), [vals]);
  const save = async () => {
    const r = await write('log_commitment', { p_owner: owner, p_date: date ?? todayISO(), p_targets: targets, p_notes: notes || null });
    if (r) { setVals({}); setNotes(''); onSaved?.(); }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-end">
        <Select label="Who" value={owner} onChange={(e) => setOwner(e.target.value)} className="min-w-[140px]">{activeMembers.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</Select>
        {COMMIT_KEYS.map((k) => (
          <label key={k} className="block w-[84px]"><span className="block text-[10px] font-medium text-gray-500 mb-1 truncate" title={k}>{k.replace(/_/g, ' ')}</span><input type="number" min={0} className="w-full px-2 py-1.5 text-sm rounded-md border border-gray-300" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></label>
        ))}
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="min-w-[160px]" />
        <Button onClick={save} loading={busy} disabled={!owner || Object.keys(targets).length === 0}>Commit</Button>
      </div>
      {error && <ErrorBox message={error} />}
    </div>
  );
}

export { lines };
