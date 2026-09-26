'use client';

// Profile experiments (PRD §9): sender-level randomisation, washout, and a readout that never declares a winner on a
// crossing interval. The statistics come from the database; this panel only shows them.
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Plus } from 'lucide-react';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { useSenders } from '@/lib/outreach/queries';
import { Avatar, Badge, Button, Card, EmptyState, Input, Modal, Select, Spinner, Textarea, fmtDate } from '@/components/outreach/ui';
import { GROUP_LABELS, pqk, useProfileExperiments, type Experiment, type ExperimentResult } from '@/lib/outreach/profile';
import { cn } from '@/lib/utils';

type Notify = (message: string, type?: 'success' | 'error') => void;
const STATUS: Record<Experiment['status'], { label: string; tone: 'gray' | 'amber' | 'blue' | 'green' | 'indigo' | 'red' }> = { draft: { label: 'Draft', tone: 'gray' }, washout: { label: 'Washout', tone: 'amber' }, running: { label: 'Running', tone: 'blue' }, ready: { label: 'Ready to read', tone: 'green' }, concluded: { label: 'Concluded', tone: 'indigo' }, abandoned: { label: 'Abandoned', tone: 'red' } };
const VERDICT: Record<ExperimentResult['verdict'], string> = { a_better: 'A did better', b_better: 'B did better', not_conclusive: 'Not conclusive', insufficient_data: 'Not enough data yet', insufficient_senders: 'Too few senders per arm' };

function Readout({ r }: { r: ExperimentResult }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        {r.arms.map((a) => <div key={a.key} className="rounded-lg border border-gray-200 p-2.5"><div className="text-xs text-gray-500">Variant {a.key} · {a.senders} sender{a.senders === 1 ? '' : 's'}</div><div className="text-lg font-semibold text-gray-900">{a.rate == null ? '—' : `${a.rate}%`}</div><div className="text-xs text-gray-600">{a.accepted} accepted of {a.resolved} resolved{a.pending ? ` · ${a.pending} still open` : ''}</div></div>)}
      </div>
      <div className={cn('rounded-lg p-3 text-sm', r.verdict === 'not_conclusive' || r.verdict === 'insufficient_data' || r.verdict === 'insufficient_senders' ? 'bg-gray-50 text-gray-800' : 'bg-green-50 text-green-900')}><b>{VERDICT[r.verdict]}.</b> {r.summary}</div>
      {r.comparison && <div className="text-xs text-gray-500">95% interval on the difference: {r.comparison.ci_low} to {r.comparison.ci_high} points · p = {r.comparison.p_value}</div>}
      {r.warnings.map((w) => <div key={w.code} className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">{w.text}</div>)}
    </div>
  );
}

export default function ExperimentsPanel({ ws, isManager, canWrite, notify }: { ws: string; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const exps = useProfileExperiments(ws);
  const senders = useSenders(ws);
  const [form, setForm] = useState<{ name: string; field_group: 'headline' | 'about'; a: string; b: string; senderIds: string[]; washout: string; min: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ e: Experiment; r: ExperimentResult } | null>(null);
  const canEdit = isManager && canWrite;
  const linkedIn = useMemo(() => (senders.data ?? []).filter((s) => s.provider === 'LINKEDIN' && s.status === 'ok'), [senders.data]);
  const invalidate = () => { qc.invalidateQueries({ queryKey: pqk.experiments(ws) }); qc.invalidateQueries({ queryKey: ['outreach', ws, 'profile-changes'] }); };

  async function create() {
    if (!form) return;
    setBusy('create');
    try {
      const id = await rpc<string>('profile_experiment_create', { p_ws: ws, p_name: form.name, p_field_group: form.field_group, p_variants: [{ key: 'A', value: form.a }, { key: 'B', value: form.b }], p_sender_ids: form.senderIds, p_washout_days: Number(form.washout) || 3, p_min_invites: Number(form.min) || 120 });
      const r = await callFn<{ queued: number; awaiting_owner: number; failed: number }>('profile', { action: 'experiment_start', experiment_id: id });
      notify(`Experiment started: ${r.queued} changes scheduled, ${r.awaiting_owner} waiting for owners${r.failed ? `, ${r.failed} failed` : ''}.`);
      setForm(null); invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(null); }
  }
  async function readout(e: Experiment) {
    try { setResult({ e, r: await rpc<ExperimentResult>('profile_experiment_result', { p_id: e.id }) }); } catch (err) { notify(parseError(err).message, 'error'); }
  }
  async function conclude(e: Experiment, applyWinner: boolean) {
    if (!confirm(applyWinner ? 'Conclude and apply the winning variant to the other arm? Those senders get an ordinary profile change (limits and permission apply).' : 'Conclude this experiment? The readout is stored as final.')) return;
    setBusy(e.id);
    try { await callFn('profile', { action: 'experiment_conclude', experiment_id: e.id, apply_winner: applyWinner }); notify('Experiment concluded.'); setResult(null); invalidate(); }
    catch (err) { notify(parseError(err).message, 'error'); } finally { setBusy(null); }
  }
  async function abandon(e: Experiment) {
    if (!confirm('Abandon this experiment? Pending changes are cancelled; applied ones stay as they are.')) return;
    try { await rpc('profile_experiment_abandon', { p_id: e.id, p_reason: 'abandoned in the app' }); notify('Experiment abandoned.'); invalidate(); } catch (err) { notify(parseError(err).message, 'error'); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-gray-600 max-w-2xl">Split a cohort of senders between two headlines or About sections and measure the acceptance-rate difference on invitations sent after a washout period. The sender is the unit, so at least 2 per arm, and the readout says plainly when it cannot conclude.</p>
        {canEdit && <Button onClick={() => setForm({ name: '', field_group: 'headline', a: '', b: '', senderIds: [], washout: '3', min: '120' })}><Plus className="w-4 h-4" /> New experiment</Button>}
      </div>
      {exps.isLoading ? <Spinner /> : (exps.data ?? []).length === 0 ? <EmptyState icon={<FlaskConical className="w-6 h-6" />} title="No experiments yet" description="Run two headlines on four or more senders and let the acceptance rate decide." /> : (
        <div className="space-y-3">
          {(exps.data ?? []).map((e) => (
            <Card key={e.id} title={<span className="flex items-center gap-2">{e.name}<Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge><span className="text-xs text-gray-500 font-normal">{GROUP_LABELS[e.field_group]}</span></span>}
              actions={<div className="flex gap-1.5">{['running', 'ready', 'concluded'].includes(e.status) && <Button size="sm" variant="secondary" onClick={() => readout(e)}>Readout</Button>}{canEdit && ['washout', 'running', 'ready'].includes(e.status) && <Button size="sm" variant="ghost" onClick={() => abandon(e)}>Abandon</Button>}</div>}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                {e.variants.map((v) => (
                  <div key={v.key} className="rounded-lg border border-gray-200 p-2.5">
                    <div className="text-xs text-gray-500 mb-1">Variant {v.key} · {(e.senders ?? []).filter((s) => s.variant === v.key).map((s) => s.name).join(', ') || 'not assigned yet'}</div>
                    <div className="text-gray-900 whitespace-pre-line line-clamp-4">{v.value}</div>
                  </div>
                ))}
              </div>
              <div className="text-xs text-gray-500 mt-2">
                {e.status === 'washout' && <>Profiles are changing ({(e.changes ?? []).filter((c) => ['applied', 'partially_applied'].includes(c.status)).length} of {(e.changes ?? []).length} landed). Invitations sent before {e.washout_until ? fmtDate(e.washout_until, false) : `${e.washout_days} days after the last change`} are left out of both arms.</>}
                {e.status === 'running' && <>Counting invitations sent after {fmtDate(e.washout_until, false)}. Ready once each arm has {e.min_invites_per_variant} resolved invitations.</>}
                {e.status === 'ready' && <>Enough data. Read the result and conclude.</>}
                {e.status === 'concluded' && e.result && <>{e.result.summary}</>}
                {e.status === 'abandoned' && <>{(e.result as { reason?: string } | null)?.reason ?? 'Abandoned.'}</>}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title="New profile experiment" size="lg"
        footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button loading={busy === 'create'} onClick={create} disabled={!form || !form.name.trim() || !form.a.trim() || !form.b.trim() || form.senderIds.length < 4}>Start ({form?.senderIds.length ?? 0} senders)</Button></>}>
        {form && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Headline: outcome vs role" />
              <Select label="Field" value={form.field_group} onChange={(e) => setForm({ ...form, field_group: e.target.value as 'headline' | 'about' })}><option value="headline">Headline</option><option value="about">About</option></Select>
            </div>
            <Textarea label="Variant A" value={form.a} onChange={(e) => setForm({ ...form, a: e.target.value })} className="min-h-[60px]" />
            <Textarea label="Variant B" value={form.b} onChange={(e) => setForm({ ...form, b: e.target.value })} className="min-h-[60px]" />
            <div>
              <div className="text-xs font-medium text-gray-600 mb-1">Senders (at least 4, assigned at random and balanced)</div>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto">
                {linkedIn.map((s) => { const on = form.senderIds.includes(s.id); return <li key={s.id}><label className={cn('flex items-center gap-2 rounded-lg border p-2 cursor-pointer', on ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200')}><input type="checkbox" checked={on} onChange={() => setForm({ ...form, senderIds: on ? form.senderIds.filter((x) => x !== s.id) : [...form.senderIds, s.id] })} /><Avatar src={s.picture_url} name={s.display_name} size={6} /><span className="text-sm text-gray-900 truncate">{s.display_name}</span></label></li>; })}
              </ul>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Washout (days)" type="number" min={0} max={30} value={form.washout} onChange={(e) => setForm({ ...form, washout: e.target.value })} hint="Invitations sent before the change are still being answered; they are left out." />
              <Input label="Resolved invitations per variant" type="number" min={20} value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} hint="Fewer than about 120 rarely separates two headlines." />
            </div>
            <div className="text-xs text-gray-500">Every sender must be able to take the change (permission, limits, warm-up) or nothing starts. Owners with proposal permission get an email; the experiment waits for their click. The field is locked for other edits until the experiment ends.</div>
          </div>
        )}
      </Modal>

      <Modal open={!!result} onClose={() => setResult(null)} title={result ? `Readout: ${result.e.name}` : ''} size="lg"
        footer={result && canEdit && ['running', 'ready'].includes(result.e.status) ? <><Button variant="secondary" onClick={() => setResult(null)}>Close</Button><Button variant="secondary" loading={busy === result.e.id} onClick={() => conclude(result.e, false)}>Conclude</Button><Button loading={busy === result.e.id} disabled={!['a_better', 'b_better'].includes(result.r.verdict)} onClick={() => conclude(result.e, true)} title={['a_better', 'b_better'].includes(result.r.verdict) ? undefined : 'No winner: the interval crosses zero'}>Conclude and apply the winner</Button></> : <Button variant="secondary" onClick={() => setResult(null)}>Close</Button>}>
        {result && <Readout r={result.r} />}
      </Modal>
    </div>
  );
}
