'use client';

// Knowledge → Q&A editor: one question, the approved answer and where it applies (everywhere, or only some sequences
// and websites). Saved through outreach_hub_qa_save.
import { useMemo, useState } from 'react';
import { useQaSave, type KnowledgeTargetKind, type QaPair } from '@/lib/outreach/aiHub';
import { Button, ErrorBox, Input, Modal, Spinner, Textarea } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { errText, plural } from '@/components/outreach/sequences/ai/shared';
import { TargetChecklist, allTargetKeys, fromTargetKey, targetKey, type KnowledgeTargets } from './shared';

const QUESTION_MAX = 500;
const ANSWER_MAX = 2000;
const TARGETS_MAX = 50;   // outreach_hub__qa_check_targets

export default function QaEditorModal({ ws, pair, targets, targetsLoading, onClose, onSaved }: {
  ws: string;
  /** null = a new pair. */
  pair: QaPair | null;
  targets: KnowledgeTargets; targetsLoading?: boolean; onClose: () => void; onSaved: (created: boolean) => void;
}) {
  const save = useQaSave(ws);
  const original = useMemo(() => (pair?.targets ?? []).map((t) => targetKey(t.kind, t.id)), [pair]);
  const [question, setQuestion] = useState(pair?.question ?? '');
  const [answer, setAnswer] = useState(pair?.answer ?? '');
  const [scope, setScope] = useState<'all' | 'only'>(original.length > 0 ? 'only' : 'all');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(original));
  // the scope is only sent when the user changed it: an untouched pair keeps its targets, also the ones no longer listed
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(() => new Set(allTargetKeys(targets)), [targets]);
  const selected = useMemo(() => [...picked].filter((k) => available.has(k)), [picked, available]);
  // places the pair was limited to that are archived or deleted by now: they cannot be ticked again
  const gone = targetsLoading ? 0 : original.filter((k) => !available.has(k)).length;
  const sameScope = scope === 'all' ? original.length === 0 : original.length > 0 && original.length === selected.length && original.every((k) => picked.has(k));
  const sendScope = !pair || (touched && !sameScope);

  const textOk = question.trim().length > 0 && question.length <= QUESTION_MAX && answer.trim().length > 0 && answer.length <= ANSWER_MAX;
  const scopeOk = !sendScope || scope === 'all' || (selected.length > 0 && selected.length <= TARGETS_MAX);
  const ownSequence = pair?.owner === 'sequence' ? pair.targets[0]?.name ?? 'a sequence' : null;

  const pick = (kind: KnowledgeTargetKind, id: string, on: boolean) => {
    setTouched(true);
    setPicked((s) => { const n = new Set(s); const key = targetKey(kind, id); if (on) n.add(key); else n.delete(key); return n; });
  };

  async function submit() {
    if (!textOk || !scopeOk) return;
    setError(null);
    try {
      await save.mutateAsync({
        id: pair?.id ?? null, question: question.trim(), answer: answer.trim(), enabled: pair?.enabled ?? true,
        targets: sendScope ? (scope === 'all' ? [] : selected.map(fromTargetKey)) : undefined,
      });
      onSaved(!pair);
    } catch (e) { setError(errText(e)); }
  }

  return (
    <Modal open onClose={onClose} title={pair ? 'Edit Q&A' : 'Add Q&A'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button onClick={submit} loading={save.isPending} disabled={!textOk || !scopeOk}>Save</Button></>}>
      <div className="space-y-4">
        {ownSequence && <Note tone="indigo">This pair is kept on the prompt of {ownSequence}. Changing where it applies moves it to the shared list.</Note>}
        <Input label="Question" value={question} maxLength={QUESTION_MAX} onChange={(e) => setQuestion(e.target.value)} placeholder="Do you offer revisions after delivery?" autoFocus />
        <Textarea label="Answer" rows={4} maxLength={ANSWER_MAX} value={answer} onChange={(e) => setAnswer(e.target.value)} counter={{ max: ANSWER_MAX, value: answer.length }}
          placeholder="What the AI should say when this comes up. Numbers and links here count as allowed facts." />

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-gray-600 mb-1">Available to</legend>
          <label className="flex items-start gap-2 text-sm text-gray-900 cursor-pointer">
            <input type="radio" name="qa-scope" className="mt-0.5 border-gray-300 text-indigo-600 focus:ring-indigo-500" checked={scope === 'all'} onChange={() => { setScope('all'); setTouched(true); }} />
            <span>All<span className="block text-xs text-gray-500">AI replies in every sequence and the Website agent on every website.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-900 cursor-pointer">
            <input type="radio" name="qa-scope" className="mt-0.5 border-gray-300 text-indigo-600 focus:ring-indigo-500" checked={scope === 'only'} onChange={() => { setScope('only'); setTouched(true); }} />
            <span>Only these<span className="block text-xs text-gray-500">Pick the sequences and websites that may use this answer.</span></span>
          </label>
          {scope === 'only' && (
            <div className="pt-1 space-y-2">
              {targetsLoading ? <Spinner className="py-4" /> : <TargetChecklist targets={targets} isChecked={(k) => picked.has(k)} disabled={save.isPending} onToggle={pick} />}
              {gone > 0 && <p className="text-xs text-gray-500">{gone} {plural(gone, 'place')} this pair was limited to {gone === 1 ? 'is' : 'are'} archived or deleted. {gone === 1 ? 'It is' : 'They are'} dropped when you change the selection.</p>}
              {sendScope && !targetsLoading && selected.length === 0 && <p className="text-xs text-amber-700">Pick at least one sequence or website, or choose All.</p>}
              {selected.length > TARGETS_MAX && <p className="text-xs text-amber-700">Up to {TARGETS_MAX} places. Choose All if it should apply everywhere.</p>}
            </div>
          )}
        </fieldset>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
