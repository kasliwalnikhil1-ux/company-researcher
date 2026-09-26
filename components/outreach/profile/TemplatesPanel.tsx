'use client';

// Templates with {{variables}} and bulk apply to a cohort (PRD §8.2): one change per sender, each validated, with the
// exclusions shown before anything is committed. Also links a template to a sequence (campaign-matched profiles, §8.3).
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Users } from 'lucide-react';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { useClients, useSenders, useSequences } from '@/lib/outreach/queries';
import { Avatar, Badge, Button, Card, EmptyState, Input, Modal, Select, Spinner, Textarea, fmtDate } from '@/components/outreach/ui';
import { GROUP_LABELS, LIMITS, causeText, fieldGroupsOf, pqk, useProfileTemplates, type BulkPreview, type ProfilePayload, type ProfileTemplate } from '@/lib/outreach/profile';
import { cn } from '@/lib/utils';

type Notify = (message: string, type?: 'success' | 'error') => void;
const VARS = ['{{first_name}}', '{{last_name}}', '{{full_name}}', '{{company}}', '{{title}}', '{{client}}', '{{location}}', '{{custom.region}}', '{{offer|fallback}}'];

interface Form { id: string | null; name: string; client_id: string; headline: string; summary: string; experience_description: string; custom_link_type: string; custom_link_url: string; variables: string }
const EMPTY: Form = { id: null, name: '', client_id: '', headline: '', summary: '', experience_description: '', custom_link_type: '', custom_link_url: '', variables: '' };

function toForm(t: ProfileTemplate): Form {
  return { id: t.id, name: t.name, client_id: t.client_id ?? '', headline: t.body.headline ?? '', summary: t.body.summary ?? '', experience_description: t.body.experience?.description ?? '', custom_link_type: t.body.custom_link?.type ?? '', custom_link_url: t.body.custom_link?.url ?? '', variables: Object.entries(t.variables ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') };
}
function toBody(f: Form): ProfilePayload {
  const b: ProfilePayload = {};
  if (f.headline.trim()) b.headline = f.headline.trim();
  if (f.summary.trim()) b.summary = f.summary.trim();
  if (f.experience_description.trim()) b.experience = { id: '{{current_experience_id}}', description: f.experience_description.trim() };
  if (f.custom_link_type && f.custom_link_url.trim()) b.custom_link = { type: f.custom_link_type as ProfilePayload['custom_link'] extends infer T ? T extends { type: infer U } ? U : never : never, url: f.custom_link_url.trim() };
  return b;
}
function parseVars(s: string): Record<string, string> { const o: Record<string, string> = {}; for (const line of s.split('\n')) { const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/.exec(line); if (m) o[m[1]] = m[2].trim(); } return o; }

export default function TemplatesPanel({ ws, isManager, canWrite, notify }: { ws: string; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const templates = useProfileTemplates(ws);
  const clients = useClients(ws);
  const senders = useSenders(ws);
  const sequences = useSequences(ws);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [apply, setApply] = useState<{ template: ProfileTemplate; senderIds: string[]; custom: string; preview: BulkPreview | null } | null>(null);
  const [linkSeq, setLinkSeq] = useState<{ template: ProfileTemplate; sequence: string } | null>(null);
  const canEdit = isManager && canWrite;
  const linkedIn = useMemo(() => (senders.data ?? []).filter((s) => s.provider === 'LINKEDIN' && s.status !== 'disabled'), [senders.data]);
  const invalidate = () => qc.invalidateQueries({ queryKey: pqk.templates(ws) });

  async function save() {
    if (!form) return;
    setBusy('save');
    try {
      const body = toBody(form);
      if (body.experience) { notify('Experience descriptions in templates need the position id per sender; use the sender\'s Profile tab for that field.', 'error'); setBusy(null); return; }
      if (!Object.keys(body).length) { notify('Fill in at least one field.', 'error'); setBusy(null); return; }
      await rpc('profile_template_save', { p_ws: ws, p_id: form.id, p_name: form.name, p_client: form.client_id || null, p_body: body, p_variables: parseVars(form.variables) });
      notify('Template saved.'); setForm(null); invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(null); }
  }
  async function remove(t: ProfileTemplate) {
    if (!confirm(`Delete the template “${t.name}”?`)) return;
    try { await rpc('profile_template_delete', { p_id: t.id }); notify('Template deleted.'); invalidate(); } catch (e) { notify(parseError(e).message, 'error'); }
  }
  async function preview() {
    if (!apply) return;
    setBusy('preview');
    try { const r = await rpc<BulkPreview>('profile_bulk_preview', { p_template: apply.template.id, p_sender_ids: apply.senderIds, p_vars: apply.custom.trim() ? { custom: parseVars(apply.custom) } : {} }); setApply({ ...apply, preview: r }); }
    catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(null); }
  }
  async function commit() {
    if (!apply?.preview) return;
    setBusy('commit');
    try {
      const r = await callFn<{ queued: number; awaiting_owner: number; failed: number; approvals: Array<{ email_sent: boolean; link?: string }> }>('profile', { action: 'bulk_commit', run_id: apply.preview.run_id });
      const unsent = r.approvals.filter((a) => !a.email_sent).length;
      notify(`${r.queued} scheduled, ${r.awaiting_owner} sent to owners${unsent ? ` (${unsent} could not be emailed; see Pending)` : ''}${r.failed ? `, ${r.failed} failed` : ''}.`, r.failed ? 'error' : 'success');
      setApply(null); qc.invalidateQueries({ queryKey: ['outreach', ws, 'profile-changes'] });
    } catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(null); }
  }
  async function link() {
    if (!linkSeq) return;
    setBusy('link');
    try { await rpc('profile_link_sequence', { p_sequence: linkSeq.sequence, p_template: linkSeq.template.id }); notify('Linked. The sequence now shows which pool senders match this template.'); setLinkSeq(null); qc.invalidateQueries({ queryKey: ['outreach', ws, 'sequences'] }); }
    catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(null); }
  }

  const linkedSequences = (t: ProfileTemplate) => (sequences.data ?? []).filter((s) => s.settings?.profile_template_id === t.id);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600 max-w-2xl">A template holds profile text with variables, so twelve senders can carry one offer without twelve rounds of edits. Applying it makes one change per sender, each checked for permission and limits, spread out at one sender per hour.</p>
        {canEdit && <Button onClick={() => setForm(EMPTY)}><Plus className="w-4 h-4" /> New template</Button>}
      </div>
      {templates.isLoading ? <Spinner /> : (templates.data ?? []).length === 0 ? <EmptyState title="No templates yet" description="Create one to keep a cohort's headlines and About sections aligned with an offer." action={canEdit ? <Button onClick={() => setForm(EMPTY)}>New template</Button> : undefined} /> : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(templates.data ?? []).map((t) => (
            <Card key={t.id} title={<span className="flex items-center gap-2">{t.name}{t.client_id && <Badge tone="blue">{clients.data?.find((c) => c.id === t.client_id)?.name ?? 'client'}</Badge>}</span>} actions={canEdit ? <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => setForm(toForm(t))}>Edit</Button><Button size="sm" variant="ghost" onClick={() => remove(t)}><Trash2 className="w-3.5 h-3.5" /></Button></div> : undefined}>
              <div className="text-xs text-gray-500 mb-2">{t.field_groups.map((g) => GROUP_LABELS[g]).join(', ')} · updated {fmtDate(t.updated_at, false)}</div>
              {t.body.headline && <div className="text-sm text-gray-900 mb-1"><span className="text-xs text-gray-500">Headline · </span>{t.body.headline}</div>}
              {t.body.summary && <div className="text-sm text-gray-700 whitespace-pre-line line-clamp-4"><span className="text-xs text-gray-500">About · </span>{t.body.summary}</div>}
              {t.body.custom_link && <div className="text-xs text-gray-600 mt-1">Link · {t.body.custom_link.url}</div>}
              {linkedSequences(t).length > 0 && <div className="text-[11px] text-indigo-700 mt-2">Linked to {linkedSequences(t).map((s) => s.name).join(', ')}</div>}
              {canEdit && <div className="flex gap-2 mt-3"><Button size="sm" onClick={() => setApply({ template: t, senderIds: [], custom: '', preview: null })}><Users className="w-3.5 h-3.5" /> Apply to senders</Button><Button size="sm" variant="secondary" onClick={() => setLinkSeq({ template: t, sequence: '' })}>Link to a sequence</Button></div>}
            </Card>
          ))}
        </div>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit template' : 'New template'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button loading={busy === 'save'} onClick={save} disabled={!form?.name.trim()}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Q4 fintech offer" />
              <Select label="Client (optional)" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}><option value="">Whole workspace</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            </div>
            <Textarea label="Headline" value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} counter={{ max: LIMITS.headline, value: form.headline.length }} className="min-h-[56px]" placeholder="{{first_name}} | Helping {{custom.segment|B2B teams}} with {{offer}}" />
            <Textarea label="About" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} counter={{ max: LIMITS.summary, value: form.summary.length }} className="min-h-[140px]" />
            <div className="grid grid-cols-3 gap-3">
              <Select label="Custom link type" value={form.custom_link_type} onChange={(e) => setForm({ ...form, custom_link_type: e.target.value })}><option value="">none</option>{['WEBSITE', 'PORTFOLIO', 'BLOG', 'NEWSLETTER', 'STORE'].map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}</Select>
              <Input label="Custom link URL" value={form.custom_link_url} onChange={(e) => setForm({ ...form, custom_link_url: e.target.value })} className="col-span-2" placeholder="https://" />
            </div>
            <Textarea label="Variable defaults (one per line, name=value)" value={form.variables} onChange={(e) => setForm({ ...form, variables: e.target.value })} className="min-h-[60px]" placeholder={'offer=faster month-end closes'} hint={`Available: ${VARS.join(' ')}. Sender values (first name, company, title from the last snapshot) fill in automatically.`} />
            <div className="text-xs text-gray-500">Fields in the template: {fieldGroupsOf(toBody(form)).map((g) => GROUP_LABELS[g]).join(', ') || 'none yet'}. Photos and job entries are per sender and are not templated.</div>
          </div>
        )}
      </Modal>

      <Modal open={!!apply} onClose={() => setApply(null)} title={`Apply “${apply?.template.name}”`} size="xl"
        footer={<><Button variant="secondary" onClick={() => setApply(null)}>Close</Button>{apply?.preview ? <Button loading={busy === 'commit'} onClick={commit} disabled={!apply.preview.eligible}>Apply to {apply.preview.eligible} sender{apply.preview.eligible === 1 ? '' : 's'}</Button> : <Button loading={busy === 'preview'} onClick={preview} disabled={!apply?.senderIds.length}>Preview</Button>}</>}>
        {apply && !apply.preview && (
          <div className="space-y-3">
            <div className="text-sm text-gray-700">Pick the senders. Each one gets its own change, validated separately; you see the rendered text and the exclusions before anything is queued.</div>
            <div className="flex flex-wrap gap-2">
              <button className="text-xs text-indigo-700 underline" onClick={() => setApply({ ...apply, senderIds: linkedIn.map((s) => s.id) })}>all LinkedIn senders</button>
              <button className="text-xs text-gray-500 underline" onClick={() => setApply({ ...apply, senderIds: [] })}>none</button>
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto">
              {linkedIn.map((s) => { const on = apply.senderIds.includes(s.id); return <li key={s.id}><label className={cn('flex items-center gap-2 rounded-lg border p-2 cursor-pointer', on ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200')}><input type="checkbox" checked={on} onChange={() => setApply({ ...apply, senderIds: on ? apply.senderIds.filter((x) => x !== s.id) : [...apply.senderIds, s.id] })} /><Avatar src={s.picture_url} name={s.display_name} size={6} /><span className="text-sm text-gray-900 truncate">{s.display_name}</span><span className="ml-auto text-[11px] text-gray-500">L{s.warmup_level}</span></label></li>; })}
            </ul>
            <Textarea label="Custom variables for this run (name=value per line, used as {{custom.name}})" value={apply.custom} onChange={(e) => setApply({ ...apply, custom: e.target.value })} className="min-h-[50px]" placeholder="segment=fintech CFOs" />
          </div>
        )}
        {apply?.preview && (
          <div className="space-y-3">
            <div className="text-sm"><b>{apply.preview.eligible}</b> of {apply.preview.rows.length} senders can take this change{apply.preview.excluded ? `; ${apply.preview.excluded} excluded` : ''}. {apply.preview.pacing}</div>
            <ul className="divide-y divide-gray-100 max-h-[50vh] overflow-y-auto">
              {apply.preview.rows.map((r) => (
                <li key={r.sender_id} className="py-2.5">
                  <div className="flex items-center gap-2 text-sm"><Avatar src={r.picture_url} name={r.name} size={6} /><span className="font-medium text-gray-900">{r.name ?? 'Sender'}</span>{r.ok ? <Badge tone={r.mode === 'direct' ? 'green' : 'amber'}>{r.mode === 'direct' ? 'will be scheduled' : 'owner will be asked'}</Badge> : <Badge tone="red">excluded</Badge>}</div>
                  {r.ok && r.payload && <div className="text-xs text-gray-700 mt-1 space-y-0.5">{r.payload.headline && <div><span className="text-gray-500">Headline · </span>{r.payload.headline}</div>}{r.payload.summary && <div className="whitespace-pre-line line-clamp-3"><span className="text-gray-500">About · </span>{r.payload.summary}</div>}</div>}
                  {!r.ok && <ul className="text-xs text-red-700 mt-1">{r.causes.map((c, i) => <li key={i}>{causeText(c)}. {c.remedy}</li>)}</ul>}
                </li>
              ))}
            </ul>
            <button className="text-xs text-gray-500 underline" onClick={() => setApply({ ...apply, preview: null })}>back to the sender list</button>
          </div>
        )}
      </Modal>

      <Modal open={!!linkSeq} onClose={() => setLinkSeq(null)} title="Link this template to a sequence" size="sm"
        footer={<><Button variant="secondary" onClick={() => setLinkSeq(null)}>Cancel</Button><Button loading={busy === 'link'} onClick={link} disabled={!linkSeq?.sequence}>Link</Button></>}>
        {linkSeq && (
          <div className="space-y-3 text-sm">
            <p className="text-gray-700">The platform then shows which pool senders match the template, so an offer and the profiles behind it stay in step. It never applies changes on its own.</p>
            <Select label="Sequence" value={linkSeq.sequence} onChange={(e) => setLinkSeq({ ...linkSeq, sequence: e.target.value })}><option value="">Pick a sequence</option>{(sequences.data ?? []).filter((s) => s.status !== 'archived').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </div>
        )}
      </Modal>
    </div>
  );
}
