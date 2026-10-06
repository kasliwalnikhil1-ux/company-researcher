'use client';

// The sequence's prompt: guided sections (or one raw text), stage table, settings, save / history / copy / reset.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, History, RotateCcw } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import type { Sequence } from '@/lib/outreach/types';
import { scenariosFromText, useCopyPrompt, useLibraryPrompts, useSaveSequencePrompt, useScenarioSave, type DraftPromptV2, type ScenarioDraft, type SequenceAiSettings } from '@/lib/outreach/aiRepliesSequence';
import { Button, ErrorBox, Modal, Select, Textarea, timeAgo } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import GuidedPromptEditor from '@/components/outreach/settings/ai-replies/prompt/GuidedPromptEditor';
import PromptSettingsForm from '@/components/outreach/settings/ai-replies/prompt/PromptSettingsForm';
import StageTable from '@/components/outreach/settings/ai-replies/prompt/StageTable';
import VersionHistoryDrawer from '@/components/outreach/settings/ai-replies/prompt/VersionHistoryDrawer';
import { changedParts, normalize, suggestKind, validate } from '@/components/outreach/settings/ai-replies/prompt/promptModel';
import { Section, errText } from './shared';

export default function PromptCard({ sequenceId, ws, s, canEdit, sequences, notify, onDraftChange, onReload, settingsHost }: {
  sequenceId: string;
  ws: string;
  s: SequenceAiSettings;
  canEdit: boolean;
  sequences: Sequence[];
  notify: (m: string, t?: 'success' | 'error') => void;
  /** The unsaved edits (null when the editor matches the saved prompt), for "Test a conversation". */
  onDraftChange: (d: DraftPromptV2 | null) => void;
  onReload: () => void;
  /** Where the prompt's Settings block goes (the Settings sub-tab). The edits stay part of this prompt's draft. */
  settingsHost?: HTMLElement | null;
}) {
  const p = s.prompt;
  const save = useSaveSequencePrompt(sequenceId);
  const base = useMemo(() => normalize(p), [p]);
  const [edited, setEdited] = useState<DraftPromptV2 | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [note, setNote] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);

  const current = edited ?? base;
  const parts = useMemo(() => (edited ? changedParts(base, edited) : []), [base, edited]);
  const dirty = parts.length > 0;
  const kind = suggestKind(parts);
  const errors = useMemo(() => validate(current), [current]);
  const lockedKeys = useMemo(() => new Set(base.settings.stages.map((st) => st.key)), [base]);
  const readOnly = !canEdit;

  useEffect(() => { onDraftChange(dirty ? current : null); }, [dirty, current, onDraftChange]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const update = (next: DraftPromptV2) => setEdited(next);
  const settingsDirty = parts.includes('Settings');
  const stagesDirty = parts.includes('Stages');
  const stageErrors = errors.filter((e) => e.startsWith('Stage') || e.startsWith('Keep between'));
  const discard = () => { setEdited(null); setShowErrors(false); };

  function openSave() {
    setShowErrors(true);
    if (errors.length) return;
    setSaveError(null); setConflict(false); setNote(''); setSaveOpen(true);
  }

  async function confirmSave() {
    setSaveError(null);
    try {
      const r = await save.mutateAsync({ editor_mode: current.editor_mode, body: current.body, sections: current.editor_mode === 'guided' ? current.sections : null, settings: current.settings, change_kind: kind, note: note.trim() || null, base_version: p.version });
      setEdited(null); setShowErrors(false); setSaveOpen(false);
      const warns = r.warnings ?? r.prompt?.warnings ?? [];
      for (const w of warns) notify(w, 'error');
      notify(`Saved as version ${r.prompt?.version ?? ''}. Applies to the next reply in ${s.open_conversations} open ${s.open_conversations === 1 ? 'conversation' : 'conversations'}.`);
    } catch (e) {
      const err = parseError(e);
      if (err.code === 'E_CONFLICT') setConflict(true); else setSaveError(errText(err));
    }
  }

  const showSituations = current.editor_mode === 'guided' && p.situations_text_convertible && !!(current.sections?.situations ?? '').trim();

  const saveActions = (show: boolean) => (
    <>
      {show && <span className="text-xs font-medium text-amber-700">Unsaved changes</span>}
      {canEdit && dirty && <Button variant="ghost" size="sm" onClick={discard}>Discard</Button>}
      {canEdit && <Button size="sm" onClick={openSave} disabled={!dirty} loading={save.isPending}>Save</Button>}
    </>
  );

  return (
    <>
    <Section title="Instructions" help="Who the AI is, how a conversation goes, when it hands over and stops, the facts it may use and its style. Fully editable."
      actions={(
        <>
          <span className="text-xs text-gray-500 hidden sm:inline">
            Version {p.version}{p.updated_by_name ? ` · ${p.updated_by_name}` : ''}{p.updated_at ? ` ${timeAgo(p.updated_at)}` : ''}
            {dirty && <span className="ml-2 font-medium text-amber-700">Unsaved changes</span>}
          </span>
          <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}><History className="w-3.5 h-3.5" />History</Button>
          {canEdit && dirty && <Button variant="ghost" size="sm" onClick={discard}>Discard</Button>}
          {canEdit && <Button size="sm" onClick={openSave} disabled={!dirty} loading={save.isPending}>Save</Button>}
        </>
      )}>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setCopyOpen(true)}><Copy className="w-3.5 h-3.5" />Copy from sequence or library<ChevronDown className="w-3.5 h-3.5" /></Button>
          <Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}><RotateCcw className="w-3.5 h-3.5" />Reset to template</Button>
          {p.copied_from_prompt_id && <span className="text-xs text-gray-500">Copied from another prompt (v{p.copied_from_version ?? '?'}). Edits here never change the original.</span>}
        </div>
      )}
      {showErrors && errors.length > 0 && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <div className="font-medium mb-1">Fix these before saving:</div>
          <ul className="list-disc pl-5 space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      <GuidedPromptEditor value={current} onChange={update} readOnly={readOnly} lockedKeys={lockedKeys} showSituations={showSituations} hideSettings={!!settingsHost} hideStages
        situationsSlot={canEdit && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConvertOpen(true)}>Convert to cards</Button>
            <span className="text-xs text-gray-500">Turns each &ldquo;- When → Do&rdquo; line into a Scenario card below. The text stays until you clear it.</span>
          </div>
        )} />

      {settingsHost && createPortal(
        <Section title="How the AI replies" help="How long replies are, what the AI does when asked if it is a bot, and when it moves on. Saved with the instructions as a new version."
          actions={saveActions(settingsDirty)}>
          {showErrors && errors.length > 0 && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <div className="font-medium mb-1">Fix these before saving:</div>
              <ul className="list-disc pl-5 space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )}
          <PromptSettingsForm value={current.settings} disabled={readOnly} onChange={(patch) => update({ ...current, settings: { ...current.settings, ...patch } })} />
        </Section>,
        settingsHost,
      )}

      {/* on document.body: Save is pressed from the Settings sub-tab too, while this panel is hidden */}
      {saveOpen && typeof document !== 'undefined' && createPortal(
        <Modal open onClose={() => (save.isPending ? undefined : setSaveOpen(false))} title="Save prompt" size="md"
          footer={conflict ? (
            <><Button variant="secondary" onClick={() => setSaveOpen(false)}>Keep editing</Button><Button onClick={() => { setSaveOpen(false); setEdited(null); onReload(); }}>Load their version</Button></>
          ) : (
            <><Button variant="secondary" onClick={() => setSaveOpen(false)} disabled={save.isPending}>Cancel</Button><Button loading={save.isPending} onClick={confirmSave}>Save</Button></>
          )}>
          <div className="space-y-3">
            {conflict ? (
              <Note tone="amber">Someone else saved this prompt while you were editing. Load their version to see it (your edits here are lost), or keep editing and copy what you need first.</Note>
            ) : (
              <>
                <p className="text-sm text-gray-700">
                  {kind === 'style'
                    ? 'Only the Style section changed, so this is a style-only version. AI replies already scheduled go out as they are.'
                    : 'This is a substantive change: replies scheduled on the old version are drafted again, and the first 10 Auto replies wait 30 min so you can check them.'}
                </p>
                {parts.length > 0 && <p className="text-xs text-gray-500">Changed: {parts.join(', ')}.</p>}
                <Textarea label="Note (optional)" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why, for the version history" className="min-h-0" />
                {saveError && <ErrorBox message={saveError} />}
              </>
            )}
          </div>
        </Modal>,
        document.body,
      )}

      {p.id && (
        <VersionHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} masterPromptId={p.id} editor={current} canEdit={canEdit}
          stageName={() => undefined} onRestore={(v) => { update(normalize(v)); setHistoryOpen(false); }} />
      )}
      {copyOpen && <CopyPromptModal sequenceId={sequenceId} ws={ws} sequences={sequences.filter((q) => q.id !== sequenceId && q.status !== 'archived')} onClose={() => setCopyOpen(false)} onDone={(from) => { setCopyOpen(false); setEdited(null); notify(`Prompt, scenarios, knowledge and Q&A copied from ${from}.`); }} />}
      <Modal open={resetOpen} onClose={() => setResetOpen(false)} title="Reset to the template?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setResetOpen(false)}>Cancel</Button><Button onClick={() => { update(normalize({ ...p.template, editor_mode: 'guided' })); setResetOpen(false); }}>Reset</Button></>}>
        <p className="text-sm text-gray-700">The sections, stages and settings in the editor are replaced with the starting template. Nothing is saved until you press Save. Your scenario cards, knowledge and Q&amp;A are not touched.</p>
      </Modal>
      {convertOpen && <ConvertToCardsModal sequenceId={sequenceId} text={current.sections?.situations ?? ''} onClose={() => setConvertOpen(false)} onDone={(n) => { setConvertOpen(false); notify(`${n} scenario ${n === 1 ? 'card' : 'cards'} created.`); }} />}
    </Section>

    {current.editor_mode === 'guided' && (
      <Section title="Conversation stages" help="The AI moves through these in order. Click a stage to edit what it does there. Saved with the instructions."
        actions={saveActions(stagesDirty)}>
        {showErrors && stageErrors.length > 0 && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <ul className="list-disc pl-5 space-y-0.5">{stageErrors.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}
        <StageTable stages={current.settings.stages} lockedKeys={lockedKeys} disabled={readOnly} onChange={(stages) => update({ ...current, settings: { ...current.settings, stages } })} />
      </Section>
    )}
    </>
  );
}

function CopyPromptModal({ sequenceId, ws, sequences, onClose, onDone }: { sequenceId: string; ws: string; sequences: Sequence[]; onClose: () => void; onDone: (from: string) => void }) {
  const lib = useLibraryPrompts(ws);
  const copy = useCopyPrompt(sequenceId);
  const [source, setSource] = useState<'sequence' | 'library'>('sequence');
  const [seq, setSeq] = useState('');
  const [libId, setLibId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ok = source === 'sequence' ? !!seq : !!libId;
  async function go() {
    setError(null);
    try {
      await copy.mutateAsync(source === 'sequence' ? { fromSequence: seq } : { fromLibrary: libId });
      const name = source === 'sequence' ? sequences.find((q) => q.id === seq)?.name ?? 'the sequence' : (lib.data ?? []).find((l) => l.id === libId)?.name ?? 'the library prompt';
      onDone(name);
    } catch (e) { setError(errText(e)); }
  }
  return (
    <Modal open onClose={onClose} title="Copy a prompt into this sequence" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={copy.isPending}>Cancel</Button><Button onClick={go} loading={copy.isPending} disabled={!ok}>Copy</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-700">The prompt, its scenario cards, knowledge links and Q&amp;A are copied as an independent copy. This sequence&rsquo;s current prompt is replaced (the old version stays in History).</p>
        <div role="radiogroup" aria-label="Copy from" className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {(['sequence', 'library'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={source === k} onClick={() => setSource(k)} className={`px-3 py-1 text-sm rounded-md ${source === k ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
              {k === 'sequence' ? 'Another sequence' : 'Library'}
            </button>
          ))}
        </div>
        {source === 'sequence' ? (
          <Select label="Sequence" value={seq} onChange={(e) => setSeq(e.target.value)}>
            <option value="">Pick a sequence</option>
            {sequences.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
          </Select>
        ) : (
          <Select label="Library prompt" value={libId} onChange={(e) => setLibId(e.target.value)}>
            <option value="">Pick a prompt</option>
            {(lib.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}{l.is_default ? ' (workspace default)' : ''} · v{l.version}</option>)}
          </Select>
        )}
        {source === 'library' && lib.data && lib.data.length === 0 && <Note>No library prompts yet. Add them in AI → Setup → General.</Note>}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

function ConvertToCardsModal({ sequenceId, text, onClose, onDone }: { sequenceId: string; text: string; onClose: () => void; onDone: (n: number) => void }) {
  const saveCard = useScenarioSave(sequenceId);
  const [cards, setCards] = useState<ScenarioDraft[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    scenariosFromText(text).then((c) => { setCards(c); setPicked(new Set(c.map((_, i) => i))); }).catch((e) => setError(errText(e)));
  }, [text]);
  async function go() {
    if (!cards) return;
    setBusy(true); setError(null);
    let n = 0;
    try {
      for (const [i, c] of cards.entries()) {
        if (!picked.has(i)) continue;
        await saveCard.mutateAsync({ title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled !== false });
        n++;
      }
      onDone(n);
    } catch (e) { setError(errText(e)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Convert Situations to cards" size="lg"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={go} loading={busy} disabled={!cards || picked.size === 0}>Create {picked.size} {picked.size === 1 ? 'card' : 'cards'}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-700">Each &ldquo;- When → Do&rdquo; line becomes a card. Untick any you do not want. Lines without an arrow are skipped.</p>
        {error && <ErrorBox message={error} />}
        {!cards && !error && <p className="text-sm text-gray-500">Reading the text…</p>}
        {cards && cards.length === 0 && <Note tone="amber">No &ldquo;When → Do&rdquo; lines found. Write the cards by hand with &ldquo;Add&rdquo; under Scenarios.</Note>}
        {cards && cards.length > 0 && (
          <ul className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
            {cards.map((c, i) => (
              <li key={i} className="flex items-start gap-2 rounded-lg border border-gray-200 p-2.5">
                <input type="checkbox" className="rounded border-gray-300 mt-1" checked={picked.has(i)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} aria-label={`Include ${c.title}`} />
                <div className="min-w-0 text-sm">
                  <div className="font-medium text-gray-900">{c.title}</div>
                  <div className="text-gray-600"><span className="text-gray-400">When</span> {c.when_text}</div>
                  <div className="text-gray-600"><span className="text-gray-400">Do</span> {c.do_text}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
