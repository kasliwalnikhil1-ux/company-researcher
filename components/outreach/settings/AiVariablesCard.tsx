'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Modal, Spinner, Textarea, useToast } from '@/components/outreach/ui';
import { ConfirmModal, CopyButton, Note, SettingRow, Switch } from './shared';
import { sk, useAiVariables } from './hooks';
import type { AiVariable } from './types';

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const PROMPT_MAX = 2000;
interface Draft { id: string | null; key: string; name: string; prompt: string; fallback: string; needs_posts: boolean; max_chars: string }
const EMPTY: Draft = { id: null, key: '', name: '', prompt: '', fallback: '', needs_posts: false, max_chars: '220' };
const token = (key: string, fallback: string) => `{{ai.${key}${fallback ? `|${fallback}` : ''}}}`;
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'v$1').slice(0, 40);

function problems(d: Draft, others: AiVariable[]) {
  const max = Number(d.max_chars);
  return {
    name: !d.name.trim() ? 'Give it a name' : undefined,
    key: !KEY_RE.test(d.key) ? 'Start with a letter. Use 2 to 40 lowercase letters, digits or underscores.' : others.some((o) => o.key === d.key && o.id !== d.id) ? 'Another variable already uses this key' : undefined,
    prompt: d.prompt.trim().length < 20 ? 'Describe what to write in a sentence or two' : d.prompt.length > PROMPT_MAX ? `Keep the prompt under ${PROMPT_MAX.toLocaleString()} characters` : undefined,
    fallback: d.fallback.includes('}}') || d.fallback.includes('|') ? 'The fallback cannot contain | or }}' : d.fallback.length > 300 ? 'Keep the fallback under 300 characters' : undefined,
    max_chars: !Number.isInteger(max) || max < 20 || max > 1000 ? 'Between 20 and 1000' : undefined,
  };
}

export default function AiVariablesCard() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const vars = useAiVariables(ws);
  const canEdit = isManager && canWrite;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [keyTouched, setKeyTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<AiVariable | null>(null);

  const errs = draft ? problems(draft, vars.data ?? []) : null;
  const hasErrors = !!errs && Object.values(errs).some(Boolean);
  const show = (k: keyof NonNullable<typeof errs>) => (submitted ? errs?.[k] : undefined);

  function open(v?: AiVariable) {
    setDraft(v ? { id: v.id, key: v.key, name: v.name, prompt: v.prompt, fallback: v.fallback ?? '', needs_posts: v.needs_posts, max_chars: String(v.max_chars) } : { ...EMPTY });
    setKeyTouched(!!v); setSubmitted(false); setFormError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!ws || !draft || hasErrors) return;
    setBusy(true); setFormError(null);
    const row = { name: draft.name.trim(), prompt: draft.prompt.trim(), fallback: draft.fallback.trim(), needs_posts: draft.needs_posts, max_chars: Number(draft.max_chars) };
    try {
      if (draft.id) {
        // the key is fixed after creation: sequences already refer to it
        const { data, error } = await supabase.from('outreach_ai_variables').update({ ...row, updated_at: new Date().toISOString() }).eq('id', draft.id).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('E_FORBIDDEN: only owners and managers can edit AI variables');
      } else {
        const { data: u } = await supabase.auth.getUser();
        const { error } = await supabase.from('outreach_ai_variables').insert({ ...row, key: draft.key, workspace_id: ws, created_by: u.user?.id ?? null });
        if (error) throw error;
      }
      await qc.invalidateQueries({ queryKey: sk.aiVariables(ws) });
      toast.show(draft.id ? 'Variable saved. Lines that are already approved stay as they are.' : 'Variable created. Generate lines for your leads next.');
      setDraft(null);
    } catch (er) {
      const pe = parseError(er);
      setFormError(/duplicate key|unique/i.test(pe.message) ? 'Another variable already uses this key.' : pe.message);
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!toDelete || !ws) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.from('outreach_ai_variables').delete().eq('id', toDelete.id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('E_FORBIDDEN: only owners and managers can delete AI variables');
      await qc.invalidateQueries({ queryKey: sk.aiVariables(ws) });
      toast.show('Variable deleted.'); setToDelete(null);
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Wand2 className="w-4 h-4" /> AI variables</span>}
      actions={<>{<Link href="/outreach/ai-review" className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline">Generate and review lines <ArrowRight className="w-3.5 h-3.5" /></Link>}{canEdit && <Button size="sm" onClick={() => open()}><Plus className="w-3.5 h-3.5" /> New variable</Button>}</>}>
      <Note tone="indigo" className="mb-4"><strong>The rule:</strong> lines are generated ahead of time, a person reviews them, and only approved lines are sent. A lead without an approved line gets the fallback text, never an unreviewed one.</Note>
      {vars.isLoading ? <Spinner /> : vars.isError ? <ErrorBox message={parseError(vars.error).message} /> : !vars.data?.length ? (
        <EmptyState icon={<Wand2 className="w-6 h-6" />} title="No AI variables yet" description="An AI variable is one personal line per lead, such as an opener about their current role. Write the instruction once, generate the lines, review them, then use the variable in any message." action={canEdit ? <Button onClick={() => open()}><Plus className="w-4 h-4" /> New variable</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-gray-100">
          {vars.data.map((v) => (
            <li key={v.id} className="py-3 flex flex-col sm:flex-row sm:items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-gray-900">{v.name}</span>{v.needs_posts && <Badge tone="purple">uses recent posts</Badge>}<Badge>max {v.max_chars} characters</Badge></div>
                <div className="flex items-center gap-2 mt-1.5"><code className="text-xs bg-gray-50 border border-gray-200 rounded px-1.5 py-1 text-gray-800 truncate">{token(v.key, v.fallback)}</code><CopyButton value={token(v.key, v.fallback)} label={`Copy the variable ${v.key}`} className="w-7 h-7" /></div>
                <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">{v.prompt}</p>
              </div>
              {canEdit && <div className="flex items-center gap-1 flex-shrink-0"><Button size="sm" variant="ghost" onClick={() => open(v)} aria-label={`Edit ${v.name}`}><Pencil className="w-4 h-4" /></Button><Button size="sm" variant="ghost" onClick={() => setToDelete(v)} aria-label={`Delete ${v.name}`}><Trash2 className="w-4 h-4 text-red-500" /></Button></div>}
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!draft} onClose={() => !busy && setDraft(null)} size="lg" title={draft?.id ? 'Edit AI variable' : 'New AI variable'}
        footer={<><Button variant="secondary" onClick={() => setDraft(null)} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy}>{draft?.id ? 'Save' : 'Create variable'}</Button></>}>
        {draft && (
          <form onSubmit={save} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Name" value={draft.name} placeholder="Opening line" error={show('name')} autoFocus
                onChange={(e) => setDraft({ ...draft, name: e.target.value, key: draft.id || keyTouched ? draft.key : slug(e.target.value) })} />
              <Input label="Key" value={draft.key} placeholder="opening_line" disabled={!!draft.id} error={show('key')} spellCheck={false}
                hint={draft.id ? 'The key cannot change: sequences already use it.' : 'Used in messages. It cannot be changed later.'}
                onChange={(e) => { setKeyTouched(true); setDraft({ ...draft, key: e.target.value.toLowerCase() }); }} />
            </div>
            <div>
              <Textarea label="What should the AI write?" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} counter={{ value: draft.prompt.length, max: PROMPT_MAX }} className="min-h-[120px]"
                placeholder="One friendly sentence that refers to their current role and company. No flattery, no questions, no exclamation marks." hint="The AI only sees facts from the lead's profile. If the profile has nothing useful it leaves the line blank and the fallback is used." />
              {show('prompt') && <span className="block text-xs text-red-600 mt-1">{show('prompt')}</span>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px] gap-3">
              <Input label="Fallback text" value={draft.fallback} onChange={(e) => setDraft({ ...draft, fallback: e.target.value })} placeholder="I came across your profile and wanted to reach out." error={show('fallback')} hint="Sent when a lead has no approved line. Leave empty to send nothing in its place." />
              <Input label="Max characters" inputMode="numeric" value={draft.max_chars} onChange={(e) => setDraft({ ...draft, max_chars: e.target.value.replace(/[^0-9]/g, '') })} error={show('max_chars')} />
            </div>
            <div className="border border-gray-200 rounded-lg px-3">
              <SettingRow title="Needs recent posts" control={<Switch label="Needs recent posts" checked={draft.needs_posts} onChange={(v) => setDraft({ ...draft, needs_posts: v })} />}
                description="Turn this on when the line should mention something the lead posted. Fetching posts has its own small daily budget per sender, separate from profile views, so lines for a large list arrive over a few days." />
            </div>
            <div><div className="text-xs font-medium text-gray-600 mb-1">Use it in a message as</div>
              <div className="flex items-center gap-2"><code className="flex-1 min-w-0 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-800 truncate">{token(draft.key || 'key', draft.fallback.trim())}</code><CopyButton value={token(draft.key || 'key', draft.fallback.trim())} label="Copy the variable" /></div></div>
            {formError && <ErrorBox message={formError} />}
            <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
          </form>
        )}
      </Modal>

      <ConfirmModal open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={remove} loading={busy} title="Delete this AI variable?" confirmLabel="Delete variable">
        <p><strong>{toDelete?.name}</strong> and every line written for it, approved ones included, are deleted.</p>
        <p>Messages that still contain <code className="text-xs">{toDelete ? `{{ai.${toDelete.key}}}` : ''}</code> will send their fallback text. Check your sequences first.</p>
      </ConfirmModal>
      {toast.node}
    </Card>
  );
}
