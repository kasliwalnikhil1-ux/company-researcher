'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select, Toggle } from '@/components/outreach/ui';
import type { ConditionRule, NodeDelay } from '@/lib/outreach/types';
import ConditionEditor from './ConditionEditor';
import TemplateField from './TemplateField';
import { useBuilder } from './context';
import { nodeTitle, senderName } from './helpers';
import { Note } from './FormsShared';
import type { FormProps } from './FormsOutreach';

export function DelayEditor({ value, onChange, label }: { value: Partial<NodeDelay>; onChange: (d: NodeDelay) => void; label?: string }) {
  const amount = value.amount ?? 1, unit = value.unit ?? 'days', jitter = value.jitter_pct ?? 0;
  const emit = (patch: Partial<NodeDelay>) => onChange({ amount, unit, jitter_pct: jitter, ...patch });
  return (
    <div>
      {label && <div className="text-xs font-medium text-gray-600 mb-1">{label}</div>}
      <div className="grid grid-cols-3 gap-2">
        <Input type="number" min={0} aria-label="Amount" value={amount} onChange={(e) => emit({ amount: Math.max(0, Number(e.target.value) || 0) })} />
        <Select aria-label="Unit" value={unit} onChange={(e) => emit({ unit: e.target.value as NodeDelay['unit'] })}>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </Select>
        <label className="block">
          <span className="sr-only">Jitter percent</span>
          <div className="relative">
            <input type="number" min={0} max={100} value={jitter} onChange={(e) => emit({ jitter_pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} className="w-full pl-3 pr-8 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <span className="absolute right-2.5 top-2 text-xs text-gray-400">±%</span>
          </div>
        </label>
      </div>
    </div>
  );
}

export function DelayForm({ cfg, patch }: FormProps) {
  return (
    <div className="space-y-3">
      <DelayEditor value={cfg as Partial<NodeDelay>} onChange={(d) => patch({ amount: d.amount, unit: d.unit, jitter_pct: d.jitter_pct ?? 0 })} label="Wait for" />
      <Note>Jitter randomises the wait so sends do not cluster. The next executable step is then planned inside the sender schedule.</Note>
    </div>
  );
}

export function ConditionForm({ cfg, patch }: FormProps) {
  const rules: ConditionRule[] = Array.isArray(cfg.rules) ? cfg.rules : [];
  return (
    <div className="space-y-3">
      <ConditionEditor rules={rules} match={cfg.match === 'any' ? 'any' : 'all'} onChange={(r, m) => patch({ rules: r, match: m })} />
      <Note>Checked the moment the lead reaches this step, against the lead, the stored profile data, the connection with the current sender and the sender itself.</Note>
      <Note>Profile data rules are false for a lead whose profile has not been read yet. Put a Refresh profile step first, or tick “Wait for profile enrichment” when you enrol.</Note>
    </div>
  );
}

export function RotateSenderForm({ node, cfg, set }: FormProps) {
  const { graph } = useBuilder();
  const candidates = Object.values(graph.nodes).filter((n) => n.id !== node.id && n.type !== 'end' && n.type !== 'send_to_sequence');
  return (
    <div className="space-y-3">
      <Select label="Restart from" value={cfg.restart_from ?? ''} onChange={(e) => set('restart_from', e.target.value)}>
        <option value="">Select a step…</option>
        {candidates.map((n) => <option key={n.id} value={n.id}>{nodeTitle(n)} ({n.id})</option>)}
      </Select>
      <Input type="number" min={0} max={10} label="Max rotations per lead" value={cfg.max_rotations ?? 2} onChange={(e) => set('max_rotations', Math.max(0, Number(e.target.value) || 0))} />
      <Note>Ends this run for the lead and starts them again from the chosen step with the next sender in the pool. Useful after “no connect”.</Note>
    </div>
  );
}

export function ChangeSenderForm({ cfg, set }: FormProps) {
  const { poolSenders, senders } = useBuilder();
  const list = poolSenders.length ? poolSenders : senders;
  return (
    <div className="space-y-3">
      <Select label="Continue with" value={cfg.sender_id ?? 'next_in_pool'} onChange={(e) => set('sender_id', e.target.value)}>
        <option value="next_in_pool">Next sender in pool</option>
        {list.map((s) => <option key={s.id} value={s.id}>{senderName(s)}{s.status !== 'ok' ? ` (${s.status})` : ''}</option>)}
      </Select>
      {poolSenders.length === 0 && <Note>The pool is empty; add senders in the top bar to pick a specific one.</Note>}
    </div>
  );
}

export function TagForm({ cfg, set, verb }: FormProps & { verb: 'add' | 'remove' }) {
  const { tags, createTag } = useBuilder();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try { const t = await createTag(name.trim()); set('tag_id', t.id); setCreating(false); setName(''); }
    catch (e: any) { setErr(e?.message ?? 'Could not create tag'); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <Select label={`Tag to ${verb}`} value={cfg.tag_id ?? ''} onChange={(e) => set('tag_id', e.target.value)}>
        <option value="">Select a tag…</option>
        {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
      {creating ? (
        <div className="flex items-center gap-1.5">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag name" aria-label="New tag name" onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <Button type="button" size="sm" loading={busy} onClick={create}>Create</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      ) : (
        <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(true)}><Plus className="w-3.5 h-3.5" /> New tag</Button>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

export function ChangeListForm({ cfg, set }: FormProps) {
  const { lists } = useBuilder();
  return (
    <Select label="Move lead to list" value={cfg.list_id ?? ''} onChange={(e) => set('list_id', e.target.value)}>
      <option value="">Select a list…</option>
      {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </Select>
  );
}

export function ChangeStageForm({ cfg, set }: FormProps) {
  const { stages } = useBuilder();
  return (
    <Select label="Set pipeline stage" value={cfg.stage_id ?? ''} onChange={(e) => set('stage_id', e.target.value)}>
      <option value="">Select a stage…</option>
      {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </Select>
  );
}

export function CallWebhookForm({ cfg, set }: FormProps) {
  const { webhooks } = useBuilder();
  return (
    <div className="space-y-3">
      <Select label="Outbound webhook" value={cfg.webhook_id ?? ''} onChange={(e) => set('webhook_id', e.target.value)}>
        <option value="">Select a webhook…</option>
        {webhooks.map((w) => <option key={w.id} value={w.id}>{w.url}{!w.active ? ' (inactive)' : ''}</option>)}
      </Select>
      {webhooks.length === 0 && <Note>No outbound webhooks configured. The workspace owner can add them under Settings → Webhooks.</Note>}
      <Note>Sends the lead, the sender and where the lead is in the sequence to your webhook. The request is signed so your system can trust it.</Note>
    </div>
  );
}

type KV = { key: string; value: string };
function toRows(obj: unknown): KV[] { return obj && typeof obj === 'object' ? Object.entries(obj as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? '') })) : []; }
function toObject(rows: KV[]): Record<string, string> { const o: Record<string, string> = {}; for (const r of rows) if (r.key.trim()) o[r.key.trim()] = r.value; return o; }

function KeyValueRows({ label, rows, onChange, placeholderKey, placeholderValue }: { label: string; rows: KV[]; onChange: (rows: KV[]) => void; placeholderKey: string; placeholderValue: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-600 mb-1">{label}</div>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input value={r.key} onChange={(e) => onChange(rows.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)))} placeholder={placeholderKey} aria-label={`${label} key`} className="w-2/5 min-w-0 px-2 py-1 text-xs rounded border border-gray-300 font-mono" />
            <input value={r.value} onChange={(e) => onChange(rows.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)))} placeholder={placeholderValue} aria-label={`${label} value`} className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-gray-300 font-mono" />
            <button type="button" onClick={() => onChange(rows.filter((_, idx) => idx !== i))} className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" aria-label="Remove row"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
      <Button type="button" variant="ghost" size="sm" className="mt-1" onClick={() => onChange([...rows, { key: '', value: '' }])}><Plus className="w-3.5 h-3.5" /> Add {label.toLowerCase().replace(/s$/, '')}</Button>
    </div>
  );
}

export function CallApiForm({ cfg, set }: FormProps) {
  const [headers, setHeaders] = useState<KV[]>(() => toRows(cfg.headers));
  const [query, setQuery] = useState<KV[]>(() => toRows(cfg.query));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[110px_1fr] gap-2 items-end">
        <Select label="Method" value={cfg.method ?? 'POST'} onChange={(e) => set('method', e.target.value)}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
        <TemplateField label="URL" value={cfg.url ?? ''} onChange={(v) => set('url', v)} multiline={false} placeholder="https://api.example.com/leads/{{custom.crm_id}}" />
      </div>
      <KeyValueRows label="Headers" rows={headers} onChange={(r) => { setHeaders(r); set('headers', toObject(r)); }} placeholderKey="Authorization" placeholderValue="Bearer …" />
      <KeyValueRows label="Query parameters" rows={query} onChange={(r) => { setQuery(r); set('query', toObject(r)); }} placeholderKey="source" placeholderValue="{{sender.full_name}}" />
      <TemplateField label="Body" value={cfg.body ?? ''} onChange={(v) => set('body', v)} rows={6} placeholder={'{"email": "{{email_work}}", "name": "{{full_name}}"}'} hint="Variables are substituted before sending. JSON bodies are sent as application/json." />
      <Toggle checked={cfg.remove_empty !== false} onChange={(v) => set('remove_empty', v)} label="Remove empty values from the body" />
      <Note>Non-2xx responses or network errors take the <span className="font-medium">error</span> branch.</Note>
    </div>
  );
}

export function SendToSequenceForm({ cfg, set }: FormProps) {
  const { sequences, sequenceId } = useBuilder();
  const options = sequences.filter((s) => s.id !== sequenceId && s.status !== 'archived');
  return (
    <div className="space-y-3">
      <Select label="Target sequence" value={cfg.sequence_id ?? ''} onChange={(e) => set('sequence_id', e.target.value)}>
        <option value="">Select a sequence…</option>
        {options.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status !== 'active' ? ` (${s.status})` : ''}</option>)}
      </Select>
      {options.length === 0 && <Note>No other sequences yet.</Note>}
      <Note>Ends this sequence for the lead and moves them into the chosen one, which uses its own senders. Only active sequences send.</Note>
    </div>
  );
}
