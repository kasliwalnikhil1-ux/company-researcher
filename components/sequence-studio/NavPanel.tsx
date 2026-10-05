'use client';

// Left panel: sequences (add / duplicate / reorder / delete) and the selected sequence's
// timeline of steps, with thread grouping.

import { ArrowDown, ArrowUp, ChevronLeft, Copy, CornerDownRight, Plus, Trash2, Mail } from 'lucide-react';
import { threadRootIndex, stepSubjectRaw } from '@/lib/sequence-studio/simulate';
import { resolveText } from '@/lib/sequence-studio/variables';
import { move } from '@/lib/sequence-studio/util';
import type { Studio } from './store';
import { blankSequence, copySequence, cumulativeDays, deleteSequence } from './mut';
import { Badge, IconBtn, cx } from './ui';

const THREAD_COLORS = ['#6366f1', '#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6'];

export default function NavPanel({ studio, onCollapse }: { studio: Studio; onCollapse: () => void }) {
  const { lib, ui, setUi, edit } = studio;
  if (!lib) return null;
  const seq = lib.sequences.find((s) => s.id === ui.sequenceId);
  const profile = lib.profiles.find((p) => p.id === lib.activeProfileId);
  const ctx = { profile, variables: lib.variables };

  const selectSeq = (id: string) => {
    const s = lib.sequences.find((x) => x.id === id);
    setUi({ sequenceId: id, stepId: s?.steps[0]?.id });
  };

  const days = seq ? cumulativeDays(seq) : [];
  const roots = seq ? seq.steps.map((_, i) => threadRootIndex(seq, i)) : [];
  const rootOrder = [...new Set(roots)];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-3 pb-1 pt-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Sequences</h2>
        <IconBtn
          label="Add sequence"
          onClick={() => {
            const s = blankSequence();
            edit((d) => void d.sequences.push(s));
            setUi({ sequenceId: s.id, stepId: s.steps[0].id, tab: 'sequence' });
          }}
        >
          <Plus className="h-4 w-4" />
        </IconBtn>
        <IconBtn label="Collapse sequences panel" className="ml-auto h-6 w-6" onClick={onCollapse}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </IconBtn>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        <ul className="space-y-0.5">
          {lib.sequences.map((s, i) => {
            const active = s.id === ui.sequenceId;
            return (
              <li key={s.id}>
                <div className={cx('group flex items-start gap-1 rounded-lg px-2 py-1.5', active ? 'bg-indigo-50 text-indigo-900 ring-1 ring-indigo-200' : 'hover:bg-gray-100')}>
                  <button type="button" onClick={() => selectSeq(s.id)} className="min-w-0 flex-1 text-left" aria-current={active || undefined}>
                    <span className="block text-sm font-medium leading-5">{s.name || 'Untitled sequence'}</span>
                    <span className={cx('block text-[11px]', active ? 'text-indigo-700/80' : 'text-gray-500')}>
                      {s.steps.length} step{s.steps.length === 1 ? '' : 's'} · {lib.conversations.filter((c) => c.sequenceId === s.id).length} reply branches
                    </span>
                  </button>
                  <div className={cx('hidden flex-none items-center group-hover:flex group-focus-within:flex')}>
                    <IconBtn label="Move sequence up" disabled={i === 0} onClick={() => edit((d) => move(d.sequences, i, i - 1))} className="h-6 w-6">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn label="Move sequence down" disabled={i === lib.sequences.length - 1} onClick={() => edit((d) => move(d.sequences, i, i + 1))} className="h-6 w-6">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn
                      label="Duplicate sequence"
                      className="h-6 w-6"
                      onClick={() => {
                        const c = copySequence(s);
                        edit((d) => void d.sequences.splice(i + 1, 0, c));
                        setUi({ sequenceId: c.id, stepId: c.steps[0]?.id });
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn
                      label="Delete sequence"
                      className="h-6 w-6"
                      onClick={() => {
                        if (!window.confirm(`Delete "${s.name}"? Its reply branches move to another sequence. You can undo this.`)) return;
                        edit((d) => deleteSequence(d, s.id));
                        const next = lib.sequences.find((x) => x.id !== s.id);
                        setUi({ sequenceId: next?.id, stepId: next?.steps[0]?.id });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconBtn>
                  </div>
                </div>
                {active && seq && (
                  <ol className="relative my-1 ml-3 border-l border-gray-200 pl-3" aria-label="Sequence timeline">
                    {seq.steps.map((st, k) => {
                      const sel = st.id === ui.stepId && ui.tab === 'message';
                      const color = THREAD_COLORS[rootOrder.indexOf(roots[k]) % THREAD_COLORS.length];
                      const subj = resolveText(stepSubjectRaw(seq, k).text, ctx);
                      return (
                        <li key={st.id} className="relative py-0.5">
                          <span className="absolute -left-[17px] top-2.5 h-2 w-2 rounded-full ring-2 ring-white" style={{ background: color }} title={roots[k] === k ? 'Starts a thread' : `In the thread of step ${roots[k] + 1}`} />
                          <button
                            type="button"
                            onClick={() => {
                              setUi({ tab: 'message' });
                              studio.focusStep(seq.id, st.id);
                            }}
                            className={cx('w-full rounded-md px-2 py-1 text-left', sel ? 'bg-white shadow-sm ring-1 ring-indigo-300' : 'hover:bg-gray-100')}
                          >
                            <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
                              <span className="tabular-nums">Day {days[k]}</span>
                              {st.delayIsDefault && <span title="Delay is a default added by the tool">·&nbsp;default</span>}
                              {st.threadMode === 'continue' ? (
                                <span className="inline-flex items-center gap-0.5" title={`Continues the thread of step ${roots[k] + 1}`}>
                                  <CornerDownRight className="h-3 w-3" /> same thread
                                </span>
                              ) : (
                                k > 0 && (
                                  <span className="inline-flex items-center gap-0.5" title="Starts a new thread">
                                    <Mail className="h-3 w-3" /> new thread
                                  </span>
                                )
                              )}
                            </span>
                            <span className="block text-[13px] font-medium leading-5 text-gray-900">
                              {k + 1}. {st.name || 'Untitled step'}
                            </span>
                            <span className="block truncate text-[11px] text-gray-500" title={subj}>
                              {subj || <i>no subject</i>}
                            </span>
                            {st.versions.length > 1 && <Badge tone="gray">{st.versions.length} versions</Badge>}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
