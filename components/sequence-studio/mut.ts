// Helpers that edit a draft library inside `studio.edit(draft => …)`.

import type { Block, Conversation, Library, Reply, Sequence, Step, Turn, Version } from '@/lib/sequence-studio/types';
import { defaultDelay } from '@/lib/sequence-studio/importSource';
import { clone, uid } from '@/lib/sequence-studio/util';

export const findSeq = (d: Library, id?: string) => d.sequences.find((s) => s.id === id);
export const findStep = (d: Library, seqId?: string, stepId?: string) => findSeq(d, seqId)?.steps.find((s) => s.id === stepId);

export function blankStep(index: number): Step {
  const subject = { id: uid('sub'), text: '' };
  const version: Version = { id: uid('ver'), name: 'Main version', kind: 'template', body: '', previewText: '' };
  return {
    id: uid('step'),
    name: index === 0 ? 'First email' : `Follow-up ${index}`,
    delayDays: defaultDelay(index),
    delayIsDefault: true,
    threadMode: index === 0 ? 'new' : 'continue',
    threadIsDefault: index > 0,
    subjects: index === 0 ? [subject] : [],
    selectedSubjectId: index === 0 ? subject.id : undefined,
    versions: [version],
    selectedVersionId: version.id,
    includeSignature: true,
    quotePrevious: true,
  };
}

export function blankSequence(): Sequence {
  return { id: uid('seq'), name: 'New sequence', description: '', steps: [blankStep(0)], blocks: [] };
}

/** Deep copy with fresh ids, keeping internal references (selected subject/version, threads). */
export function copyStep(st: Step): Step {
  const c = clone(st);
  const map = new Map<string, string>();
  c.id = uid('step');
  for (const s of c.subjects) map.set(s.id, (s.id = uid('sub')));
  for (const v of c.versions) {
    map.set(v.id, (v.id = uid('ver')));
  }
  for (const v of c.versions) if (v.subjectId) v.subjectId = map.get(v.subjectId);
  c.selectedSubjectId = c.selectedSubjectId ? map.get(c.selectedSubjectId) : undefined;
  c.selectedVersionId = c.selectedVersionId ? map.get(c.selectedVersionId) : undefined;
  return c;
}

export function copySequence(seq: Sequence): Sequence {
  const c = clone(seq);
  c.id = uid('seq');
  c.name = `${seq.name} (copy)`;
  const stepMap = new Map<string, string>();
  c.steps = seq.steps.map((st) => {
    const n = copyStep(st);
    stepMap.set(st.id, n.id);
    return n;
  });
  for (const st of c.steps) if (st.continueFromStepId) st.continueFromStepId = stepMap.get(st.continueFromStepId);
  c.blocks = c.blocks.map((b) => ({ ...b, id: uid('blk') }));
  return c;
}

export function blankBlock(kind: Block['kind'] = 'guidance'): Block {
  return { id: uid('blk'), title: 'New section', kind, body: '' };
}

export function blankReply(categoryId?: string): Reply {
  return { id: uid('rep'), title: 'New reply', categoryId, categoryIsSuggested: false, group: 'Custom', body: '', internalNote: '' };
}

export function blankTurn(role: Turn['role'], replyId?: string): Turn {
  return { id: uid('turn'), role, text: '', replyId, custom: !replyId && role === 'us', sample: false };
}

export function newConversation(d: Library, seqId: string, stepId: string, reply?: Reply): Conversation {
  return {
    id: uid('conv'),
    name: reply ? reply.title.replace(/\\(.)/g, '$1') : 'New branch',
    sequenceId: seqId,
    afterStepId: stepId,
    connectionIsSuggested: false,
    turns: [
      { id: uid('turn'), role: 'prospect', text: '', custom: false, sample: false },
      reply ? { id: uid('turn'), role: 'us', text: '', replyId: reply.id, custom: false, sample: false } : blankTurn('us'),
    ],
  };
}

/** Remove a step and fix everything that pointed at it. */
export function deleteStep(d: Library, seqId: string, stepId: string) {
  const seq = findSeq(d, seqId);
  if (!seq) return;
  const i = seq.steps.findIndex((s) => s.id === stepId);
  if (i < 0) return;
  seq.steps.splice(i, 1);
  for (const st of seq.steps) if (st.continueFromStepId === stepId) st.continueFromStepId = undefined;
  if (seq.steps[0]) seq.steps[0].threadMode = 'new';
  const fallback = seq.steps[Math.max(0, i - 1)]?.id;
  for (const c of d.conversations) if (c.sequenceId === seqId && c.afterStepId === stepId) c.afterStepId = fallback ?? '';
}

export function deleteSequence(d: Library, seqId: string) {
  d.sequences = d.sequences.filter((s) => s.id !== seqId);
  const next = d.sequences[0];
  for (const c of d.conversations)
    if (c.sequenceId === seqId) {
      c.sequenceId = next?.id ?? '';
      c.afterStepId = next?.steps[0]?.id ?? '';
    }
}

export function cumulativeDays(seq: Sequence): number[] {
  let t = 0;
  return seq.steps.map((s) => (t += Math.max(0, s.delayDays || 0)));
}
