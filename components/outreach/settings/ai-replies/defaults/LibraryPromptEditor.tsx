'use client';

// Editor for one library prompt: name, guided sections (or raw text), stage table, settings and scenario cards.
// Cards are kept with the prompt and saved together (`p_scenarios`). Mount with a fresh `key` per open.
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, History, Pencil, Plus, Trash2 } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useLibraryPrompt, useSaveLibraryPrompt, useTemplate, type DraftPromptV2, type ScenarioDraft } from '@/lib/outreach/aiRepliesSequence';
import { Button, ErrorBox, Input, Modal, Spinner, Textarea, Toggle } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import GuidedPromptEditor from '../prompt/GuidedPromptEditor';
import VersionHistoryDrawer from '../prompt/VersionHistoryDrawer';
import { changedParts, normalize, validate } from '../prompt/promptModel';
import { ScenarioModal } from '@/components/outreach/sequences/ai/ScenariosSection';

export default function LibraryPromptEditor({ ws, id, canEdit, onClose, notify }: { ws: string; id: string | null; canEdit: boolean; onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void }) {
  const q = useLibraryPrompt(id);
  const tpl = useTemplate(id ? null : ws);
  const loading = id ? q.isLoading : tpl.isLoading;
  const error = id ? q.error : tpl.error;
  const source = id ? q.data : tpl.data;
  return (
    <Modal open onClose={onClose} title={id ? (q.data?.name ?? 'Library prompt') : 'New library prompt'} size="xl">
      {loading ? <Spinner /> : error || !source ? <ErrorBox message={error ? parseError(error).message : 'Not found'} /> : (
        <Body ws={ws} id={id} canEdit={canEdit} onClose={onClose} notify={notify}
          initialName={id ? (q.data?.name ?? '') : ''}
          initialPrompt={normalize({ ...source, editor_mode: id ? source.editor_mode : 'guided' })}
          initialCards={((source.scenarios ?? []) as ScenarioDraft[]).map((c) => ({ id: c.id ?? null, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled !== false }))}
          version={id ? (q.data?.version ?? null) : null} promptId={id ? (q.data?.id ?? null) : null} />
      )}
    </Modal>
  );
}

function Body({ ws, id, canEdit, onClose, notify, initialName, initialPrompt, initialCards, version, promptId }: {
  ws: string; id: string | null; canEdit: boolean; onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void;
  initialName: string; initialPrompt: DraftPromptV2; initialCards: ScenarioDraft[]; version: number | null; promptId: string | null;
}) {
  const save = useSaveLibraryPrompt(ws);
  const [name, setName] = useState(initialName);
  const [prompt, setPrompt] = useState<DraftPromptV2>(initialPrompt);
  const [cards, setCards] = useState<ScenarioDraft[]>(initialCards);
  const [cardsDirty, setCardsDirty] = useState(false);
  const [editing, setEditing] = useState<{ idx: number | null; card: ScenarioDraft } | null>(null);
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const parts = useMemo(() => changedParts(initialPrompt, prompt), [initialPrompt, prompt]);
  const errors = useMemo(() => validate(prompt), [prompt]);
  const dirty = !id || parts.length > 0 || cardsDirty || name.trim() !== initialName;
  const lockedKeys = useMemo(() => new Set(id ? initialPrompt.settings.stages.map((s) => s.key) : []), [id, initialPrompt]);
  const readOnly = !canEdit;

  const setCardsD = (next: ScenarioDraft[]) => { setCards(next); setCardsDirty(true); };
  const move = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= cards.length) return; const n = [...cards]; [n[i], n[j]] = [n[j], n[i]]; setCardsD(n); };

  async function doSave() {
    setShowErrors(true);
    if (errors.length || !name.trim()) return;
    setSaveError(null);
    try {
      const r = await save.mutateAsync({ id, name: name.trim(), editor_mode: prompt.editor_mode, body: prompt.body, sections: prompt.editor_mode === 'guided' ? prompt.sections : null, settings: prompt.settings, note: note.trim() || null, scenarios: cards });
      notify(`Saved "${r.name ?? name.trim()}" as version ${r.version}.`);
      onClose();
    } catch (e) { setSaveError(parseError(e).message); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[16rem]"><Input label="Name" value={name} maxLength={80} readOnly={readOnly} onChange={(e) => setName(e.target.value)} placeholder="e.g. Agency default, Fintech CFOs" /></div>
        {version != null && <span className="text-xs text-gray-500 pb-2">Version {version}</span>}
        {promptId && <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}><History className="w-3.5 h-3.5" />History</Button>}
      </div>
      {showErrors && (errors.length > 0 || !name.trim()) && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <ul className="list-disc pl-5 space-y-0.5">{!name.trim() && <li>Give the prompt a name.</li>}{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      <GuidedPromptEditor value={prompt} onChange={setPrompt} readOnly={readOnly} lockedKeys={lockedKeys} showSituations={!!(prompt.sections?.situations ?? '').trim() && cards.length === 0} />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-gray-900">Scenarios</h4>
            <p className="text-xs text-gray-500">Copied to every sequence that starts from this prompt.</p>
          </div>
          {canEdit && <Button size="sm" variant="secondary" onClick={() => setEditing({ idx: null, card: { title: '', when_text: '', do_text: '', enabled: true } })}><Plus className="w-3.5 h-3.5" />Add</Button>}
        </div>
        {cards.length === 0 ? <p className="text-sm text-gray-500">No scenario cards.</p> : (
          <ol className="space-y-2">
            {cards.map((c, i) => (
              <li key={i} className={`rounded-lg border border-gray-200 p-3 flex items-start gap-3 ${c.enabled ? 'bg-white' : 'bg-gray-50 opacity-70'}`}>
                <div className="pt-0.5"><Toggle checked={c.enabled} disabled={readOnly} onChange={(v) => setCardsD(cards.map((x, k) => (k === i ? { ...x, enabled: v } : x)))} label={c.enabled ? 'On' : 'Off'} /></div>
                <div className="min-w-0 flex-1 text-sm">
                  <div className="font-medium text-gray-900">{c.title}</div>
                  <div className="text-gray-600"><span className="text-xs uppercase tracking-wide text-gray-400 mr-1">When</span>{c.when_text}</div>
                  <div className="text-gray-600 whitespace-pre-wrap"><span className="text-xs uppercase tracking-wide text-gray-400 mr-1">Do</span>{c.do_text}</div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === cards.length - 1} aria-label="Move down" className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
                    <button type="button" onClick={() => setEditing({ idx: i, card: c })} aria-label="Edit" className="p-1.5 rounded text-gray-500 hover:bg-gray-100"><Pencil className="w-4 h-4" /></button>
                    <button type="button" onClick={() => setCardsD(cards.filter((_, k) => k !== i))} aria-label="Delete" className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {canEdit && (
        <div className="space-y-3 border-t border-gray-100 pt-4">
          <Textarea label="Note (optional)" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why, for the version history" className="min-h-0" />
          {saveError && <ErrorBox message={saveError} />}
          {id && dirty && <Note>Every save is a new version. Sequences that copied this prompt are not changed.</Note>}
          <div className="flex items-center gap-2">
            <Button onClick={doSave} loading={save.isPending} disabled={!dirty}>{id ? 'Save' : 'Create prompt'}</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}

      {editing && (
        <ScenarioModal key={editing.idx ?? 'new'} initial={editing.card} loading={false} onClose={() => setEditing(null)}
          onSave={(d) => { setCardsD(editing.idx === null ? [...cards, d] : cards.map((x, k) => (k === editing.idx ? d : x))); setEditing(null); }} />
      )}
      {promptId && (
        <VersionHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} masterPromptId={promptId} editor={prompt} canEdit={canEdit}
          stageName={() => undefined} onRestore={(v) => { setPrompt(normalize(v)); if (v.scenarios?.length) setCardsD(v.scenarios.map((c) => ({ id: null, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled }))); setHistoryOpen(false); }} />
      )}
    </div>
  );
}
