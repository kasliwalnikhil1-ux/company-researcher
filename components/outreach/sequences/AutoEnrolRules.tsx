'use client';

// Auto-enrol rules for one sequence (plan item 18): list, create / edit, live match count, delete, activity log.
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { useLists, useStages, useTags } from '@/lib/outreach/queries';
import { Badge, Button, EmptyState, ErrorBox, Input, Modal, Select, Spinner, Table, Td, Th, timeAgo, Toggle, useToast } from '@/components/outreach/ui';
import { ConfirmModal } from './Modals';
import { sqk, useAutoEnrolLog, useAutoEnrolRules, useRuleMatchCount } from './hooks';
import { fmtInt, plural, type AutoEnrolFilter, type AutoEnrolRule } from './publishTypes';

const MATCH_CAP = 5000;
const SKIP_LABEL: Record<string, string> = { active: 'already enrolled', suppressed: 'do not contact', replied_recently: 'replied recently', other: 'other' };

interface FormState {
  id: string | null; name: string; listId: string; tagIds: string[]; stageId: string; title: string; company: string; location: string;
  source: string; minFollowers: string; postedWithin: string; dailyCap: string; active: boolean;
}

const emptyForm = (): FormState => ({ id: null, name: '', listId: '', tagIds: [], stageId: '', title: '', company: '', location: '', source: '', minFollowers: '', postedWithin: '', dailyCap: '50', active: true });

function formFromRule(r: AutoEnrolRule): FormState {
  const f = r.filter ?? {};
  return {
    id: r.id, name: r.name, listId: r.list_id ?? '', tagIds: Array.isArray(f.tag_ids) ? f.tag_ids : [], stageId: f.stage_id ?? '', title: f.title_contains ?? '', company: f.company_contains ?? '',
    location: f.location_contains ?? '', source: f.source ?? '', minFollowers: f.min_followers != null ? String(f.min_followers) : '', postedWithin: f.posted_within_days != null ? String(f.posted_within_days) : '',
    dailyCap: String(r.daily_cap), active: r.active,
  };
}

function filterFromForm(f: FormState, keep: AutoEnrolFilter | null): AutoEnrolFilter {
  const out: AutoEnrolFilter = {};
  if (keep?.client_id) out.client_id = keep.client_id; // not edited here, kept as it is
  if (f.tagIds.length) out.tag_ids = f.tagIds;
  if (f.stageId) out.stage_id = f.stageId;
  if (f.title.trim()) out.title_contains = f.title.trim();
  if (f.company.trim()) out.company_contains = f.company.trim();
  if (f.location.trim()) out.location_contains = f.location.trim();
  if (f.source.trim()) out.source = f.source.trim();
  const mf = Math.round(Number(f.minFollowers)); if (f.minFollowers.trim() && Number.isFinite(mf) && mf > 0) out.min_followers = mf;
  const pw = Math.round(Number(f.postedWithin)); if (f.postedWithin.trim() && Number.isFinite(pw) && pw > 0) out.posted_within_days = pw;
  return out;
}

function MatchCount({ ruleId }: { ruleId: string }) {
  const q = useRuleMatchCount(ruleId);
  if (q.isLoading) return <span className="text-xs text-gray-400">Counting…</span>;
  if (q.error) return <span className="text-xs text-red-600" title={parseError(q.error).message}>Count failed</span>;
  const n = q.data ?? 0;
  return <span className="text-xs text-gray-700 tabular-nums">Matches {fmtInt(n)}{n >= MATCH_CAP ? '+' : ''} {plural(n, 'lead')} now</span>;
}

export default function AutoEnrolRules({ sequenceId, workspaceId, canManage, sequenceActive }: { sequenceId: string; workspaceId: string; canManage: boolean; sequenceActive: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rulesQ = useAutoEnrolRules(sequenceId);
  const rules = rulesQ.data ?? [];
  const ruleIds = useMemo(() => rules.map((r) => r.id), [rules]);
  const logQ = useAutoEnrolLog(sequenceId, ruleIds);
  const lists = useLists(workspaceId), tags = useTags(workspaceId), stages = useStages(workspaceId);

  const [form, setForm] = useState<FormState | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [del, setDel] = useState<AutoEnrolRule | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const patch = (p: Partial<FormState>) => { setSavedId(null); setForm((f) => (f ? { ...f, ...p } : f)); };
  const invalidate = (ruleId?: string) => {
    qc.invalidateQueries({ queryKey: sqk.autoRules(sequenceId) });
    if (ruleId) qc.invalidateQueries({ queryKey: sqk.ruleMatch(ruleId) });
  };

  const payload = (f: FormState, original: AutoEnrolRule | null) => ({
    ...(f.id ? { id: f.id } : {}), sequence_id: sequenceId, name: f.name.trim() || 'Auto-enrol rule', list_id: f.listId || null,
    filter: filterFromForm(f, original?.filter ?? null), daily_cap: Math.min(1000, Math.max(1, Math.round(Number(f.dailyCap)) || 50)), active: f.active,
  });

  const save = async () => {
    if (!form) return;
    const original = form.id ? rules.find((r) => r.id === form.id) ?? null : null;
    const body = payload(form, original);
    if (!body.list_id && Object.keys(body.filter).length === 0) { setFormError('Choose a list or at least one filter.'); return; }
    setBusy(true); setFormError(null);
    try {
      const id = await rpc<string>('save_auto_enroll_rule', { p_rule: body });
      setForm({ ...form, id });
      setSavedId(id);
      invalidate(id);
      toast.show(form.id ? 'Rule saved' : 'Rule created');
    } catch (e) { setFormError(parseError(e).message); }
    finally { setBusy(false); }
  };

  const setActive = async (r: AutoEnrolRule, active: boolean) => {
    setRowBusy(r.id);
    try {
      await rpc('save_auto_enroll_rule', { p_rule: { id: r.id, sequence_id: sequenceId, name: r.name, list_id: r.list_id, filter: r.filter ?? {}, daily_cap: r.daily_cap, active } });
      invalidate();
      toast.show(active ? 'Rule switched on' : 'Rule switched off');
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setRowBusy(null); }
  };

  const remove = async () => {
    if (!del) return;
    setBusy(true);
    try { await rpc('delete_auto_enroll_rule', { p_id: del.id }); invalidate(); toast.show('Rule deleted'); setDel(null); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(false); }
  };

  const describe = (r: AutoEnrolRule): string => {
    const f = r.filter ?? {};
    const parts: string[] = [];
    if (r.list_id) parts.push(`joins list “${lists.data?.find((l) => l.id === r.list_id)?.name ?? 'list'}”`);
    if (f.tag_ids?.length) parts.push(`tagged ${f.tag_ids.map((t) => tags.data?.find((x) => x.id === t)?.name ?? 'tag').join(' or ')}`);
    if (f.stage_id) parts.push(`stage ${stages.data?.find((s) => s.id === f.stage_id)?.name ?? ''}`.trim());
    if (f.title_contains) parts.push(`title contains “${f.title_contains}”`);
    if (f.company_contains) parts.push(`company contains “${f.company_contains}”`);
    if (f.location_contains) parts.push(`location contains “${f.location_contains}”`);
    if (f.source) parts.push(`source ${f.source}`);
    if (f.min_followers) parts.push(`${fmtInt(f.min_followers)}+ followers`);
    if (f.posted_within_days) parts.push(`posted in the last ${f.posted_within_days} days`);
    return parts.length ? `When a lead ${parts.join(', ')}` : 'No conditions';
  };

  const ruleName = (id: string) => rules.find((r) => r.id === id)?.name ?? 'Rule';
  const skippedText = (s: Record<string, number> | null) => {
    const parts = Object.entries(s ?? {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${fmtInt(Number(n))} ${SKIP_LABEL[k] ?? k.replace(/_/g, ' ')}`);
    return parts.length ? parts.join(', ') : '—';
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-gray-600 max-w-xl">Rules enrol matching leads on their own, up to a daily cap. They use the same checks as the enrol preview: do-not-contact lists, recent replies and leads already contacted are skipped.</p>
        {canManage && <Button size="sm" onClick={() => { setForm(emptyForm()); setSavedId(null); setFormError(null); }}><Plus className="w-4 h-4" /> New rule</Button>}
      </div>
      {!sequenceActive && rules.length > 0 && <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">Rules only run while the sequence is active.</p>}

      {rulesQ.isLoading ? <Spinner /> : rulesQ.error ? <ErrorBox message={parseError(rulesQ.error).message} /> : rules.length === 0 ? (
        <EmptyState icon={<Zap className="w-6 h-6" />} title="No auto-enrol rules" description="Add a rule to keep this sequence topped up, for example every lead that joins a list from a repeating import." />
      ) : (
        <ul className="rounded-xl border border-gray-200 divide-y divide-gray-100 bg-white">
          {rules.map((r) => (
            <li key={r.id} className={`px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 ${rowBusy === r.id ? 'opacity-60' : ''}`}>
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-gray-900 truncate">{r.name}</span>
                  <Badge tone={r.active ? 'green' : 'gray'}>{r.active ? 'On' : 'Off'}</Badge>
                </div>
                <p className="text-xs text-gray-600 mt-0.5">{describe(r)}</p>
                <p className="text-xs text-gray-500 mt-0.5">Up to {fmtInt(r.daily_cap)} a day · {r.last_run_at ? `last ran ${timeAgo(r.last_run_at)}` : 'not run yet'}</p>
              </div>
              <MatchCount ruleId={r.id} />
              {canManage && (
                <div className="flex items-center gap-1">
                  <Toggle checked={r.active} onChange={(v) => setActive(r, v)} disabled={rowBusy === r.id} />
                  <Button variant="ghost" size="sm" onClick={() => { setForm(formFromRule(r)); setSavedId(null); setFormError(null); }} aria-label={`Edit ${r.name}`}><Pencil className="w-3.5 h-3.5" /></Button>
                  <Button variant="ghost" size="sm" className="text-red-600" onClick={() => setDel(r)} aria-label={`Delete ${r.name}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {rules.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Recent activity</h4>
          {logQ.isLoading ? <Spinner className="py-6" /> : logQ.error ? <ErrorBox message={parseError(logQ.error).message} /> : (logQ.data ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">No runs yet. Rules run every 10 minutes while the sequence is active.</p>
          ) : (
            <Table>
              <thead><tr><Th>Day</Th><Th>Rule</Th><Th className="text-right">Matched</Th><Th className="text-right">Enrolled</Th><Th>Skipped</Th></tr></thead>
              <tbody>
                {(logQ.data ?? []).map((l) => (
                  <tr key={l.id}>
                    <Td className="whitespace-nowrap" title={l.at}>{new Date(`${l.day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Td>
                    <Td className="text-gray-600">{ruleName(l.rule_id)}</Td>
                    <Td className="text-right tabular-nums">{fmtInt(l.matched)}</Td>
                    <Td className="text-right tabular-nums font-medium text-gray-900">{fmtInt(l.enrolled)}</Td>
                    <Td className="text-gray-600 text-xs">{skippedText(l.skipped)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}

      <Modal open={!!form} onClose={() => { if (!busy) setForm(null); }} title={form?.id ? 'Edit auto-enrol rule' : 'New auto-enrol rule'} size="lg" footer={
        <>
          {savedId && <span className="mr-auto"><MatchCount ruleId={savedId} /></span>}
          <Button variant="secondary" onClick={() => setForm(null)} disabled={busy}>{savedId ? 'Done' : 'Cancel'}</Button>
          <Button loading={busy} onClick={save} disabled={!!savedId}>{savedId ? 'Saved' : form?.id ? 'Save rule' : 'Create rule'}</Button>
        </>
      }>
        {form && (
          <div className="space-y-4">
            <Input label="Name" value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Founders from the weekly search" autoFocus />
            <Select label="When a lead joins this list" value={form.listId} onChange={(e) => patch({ listId: e.target.value })}>
              <option value="">Any list</option>
              {(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
            <div>
              <span className="block text-xs font-medium text-gray-600 mb-1">And matches these filters (all optional)</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Select label="Stage" value={form.stageId} onChange={(e) => patch({ stageId: e.target.value })}>
                  <option value="">Any stage</option>
                  {(stages.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
                <Input label="Source" value={form.source} onChange={(e) => patch({ source: e.target.value })} placeholder="csv, search_url, post_engagement…" />
                <Input label="Title contains" value={form.title} onChange={(e) => patch({ title: e.target.value })} placeholder="founder" />
                <Input label="Company contains" value={form.company} onChange={(e) => patch({ company: e.target.value })} />
                <Input label="Location contains" value={form.location} onChange={(e) => patch({ location: e.target.value })} placeholder="Berlin" />
                <Input label="At least this many followers" type="number" min={0} value={form.minFollowers} onChange={(e) => patch({ minFollowers: e.target.value })} hint="Needs an enriched profile." />
                <Input label="Posted within (days)" type="number" min={1} value={form.postedWithin} onChange={(e) => patch({ postedWithin: e.target.value })} hint="Needs an enriched profile." />
              </div>
              {(tags.data?.length ?? 0) > 0 && (
                <div className="mt-3">
                  <span className="block text-xs font-medium text-gray-600 mb-1">Has any of these tags</span>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.data!.map((t) => {
                      const on = form.tagIds.includes(t.id);
                      return <button key={t.id} type="button" aria-pressed={on} onClick={() => patch({ tagIds: on ? form.tagIds.filter((x) => x !== t.id) : [...form.tagIds, t.id] })} className={`px-2.5 py-1 rounded-full text-xs border ${on ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}>{t.name}</button>;
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <Input label="Daily cap" type="number" min={1} max={1000} value={form.dailyCap} onChange={(e) => patch({ dailyCap: e.target.value })} hint="The most leads this rule enrols in a day (1 to 1,000)." />
              <div className="pb-6"><Toggle checked={form.active} onChange={(v) => patch({ active: v })} label="Rule is on" /></div>
            </div>
            <p className="text-xs text-gray-500">A lead is enrolled by a rule once per sequence, ever. Sender limits and schedules apply as usual.</p>
            {formError && <ErrorBox message={formError} />}
          </div>
        )}
      </Modal>

      <ConfirmModal open={!!del} title="Delete rule" confirmLabel="Delete" danger busy={busy} onClose={() => setDel(null)} onConfirm={remove}
        body={<p>“{del?.name}” stops enrolling leads. Leads it already enrolled stay in the sequence.</p>} />
      {toast.node}
    </div>
  );
}
