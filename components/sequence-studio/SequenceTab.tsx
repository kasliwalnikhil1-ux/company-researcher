'use client';

// Sequence-level editing: name, description, ordered steps with delays/threading, and the
// sequence's supporting content.

import { ArrowDown, ArrowUp, Copy, Download, Plus, Trash2 } from 'lucide-react';
import { stepSubjectRaw, threadRootIndex } from '@/lib/sequence-studio/simulate';
import { resolveText } from '@/lib/sequence-studio/variables';
import { move } from '@/lib/sequence-studio/util';
import type { Studio } from './store';
import { blankStep, copyStep, cumulativeDays, deleteStep, findSeq } from './mut';
import BlockList from './BlockList';
import { TokenTextarea } from './TokenTextarea';
import { TextModeToggle } from './MessageTab';
import { Btn, Empty, Field, IconBtn, Input, SectionTitle, Select, ToolDefault } from './ui';

export default function SequenceTab({ studio, onExportSequence }: { studio: Studio; onExportSequence: (id: string) => void }) {
  const { lib, ui, setUi, edit, focusStep } = studio;
  const seq = lib?.sequences.find((s) => s.id === ui.sequenceId);
  if (!lib || !seq) return <Empty>Select or add a sequence.</Empty>;
  const ctx = { profile: lib.profiles.find((p) => p.id === lib.activeProfileId), variables: lib.variables };
  const days = cumulativeDays(seq);
  const upSeq = (fn: (s: NonNullable<ReturnType<typeof findSeq>>) => void, key?: string) =>
    edit((d) => {
      const s = findSeq(d, seq.id);
      if (s) fn(s);
    }, key);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Field label="Sequence name" className="min-w-[200px] flex-1">
          <Input value={seq.name} onChange={(e) => upSeq((s) => void (s.name = e.target.value), `seq-name-${seq.id}`)} className="font-semibold" />
        </Field>
        <div className="flex items-center gap-2 self-end">
          <TextModeToggle studio={studio} />
          <Btn size="sm" onClick={() => onExportSequence(seq.id)}>
            <Download className="h-3.5 w-3.5" /> Export this sequence
          </Btn>
        </div>
      </div>
      <Field label="Description" className="mt-3">
        <TokenTextarea label="Sequence description" value={seq.description} ctx={ctx} mode={ui.textMode} minRows={2} placeholder="What this sequence is for, when to use it…" onChange={(v) => upSeq((s) => void (s.description = v), `seq-desc-${seq.id}`)} />
      </Field>

      <SectionTitle
        actions={
          <Btn
            size="sm"
            tone="ghost"
            onClick={() => {
              const st = blankStep(seq.steps.length);
              upSeq((s) => void s.steps.push(st));
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Add step
          </Btn>
        }
      >
        Steps
      </SectionTitle>
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-2 py-1.5 font-medium">#</th>
              <th className="px-2 py-1.5 font-medium">Step</th>
              <th className="px-2 py-1.5 font-medium">Delay</th>
              <th className="px-2 py-1.5 font-medium">Thread</th>
              <th className="px-2 py-1.5 font-medium">Sent with subject</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {seq.steps.map((st, i) => (
              <tr key={st.id} className="border-t border-gray-100 align-top" onFocusCapture={() => focusStep(seq.id, st.id)}>
                <td className="px-2 py-1.5 text-xs tabular-nums text-gray-500">{i + 1}</td>
                <td className="px-2 py-1.5">
                  <button type="button" className="text-left font-medium text-gray-900 hover:underline" onClick={() => setUi({ stepId: st.id, tab: 'message' })}>
                    {st.name || 'Untitled'}
                  </button>
                  <div className="text-[11px] text-gray-500">{st.versions.length} version{st.versions.length === 1 ? '' : 's'} · day {days[i]}</div>
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      aria-label={`Delay for step ${i + 1}`}
                      value={st.delayDays}
                      onChange={(e) => upSeq((s) => {
                        s.steps[i].delayDays = Math.max(0, Number(e.target.value) || 0);
                        s.steps[i].delayIsDefault = false;
                      }, `delay-${st.id}`)}
                      className="w-16 py-1"
                    />
                    <span className="text-xs text-gray-500">d</span>
                  </div>
                  {st.delayIsDefault && <ToolDefault what="tool default" />}
                </td>
                <td className="px-2 py-1.5">
                  <Select
                    aria-label={`Threading for step ${i + 1}`}
                    disabled={i === 0}
                    value={st.threadMode === 'new' ? 'new' : st.continueFromStepId ?? 'prev'}
                    onChange={(e) =>
                      upSeq((s) => {
                        const v = e.target.value;
                        s.steps[i].threadMode = v === 'new' ? 'new' : 'continue';
                        s.steps[i].continueFromStepId = v === 'new' || v === 'prev' ? undefined : v;
                        s.steps[i].threadIsDefault = false;
                      })
                    }
                    className="max-w-[180px] py-1 text-xs"
                  >
                    <option value="new">New thread</option>
                    {i > 0 && <option value="prev">Continue previous</option>}
                    {seq.steps.slice(0, i).map((s, k) => (
                      <option key={s.id} value={s.id}>
                        Continue step {k + 1}
                      </option>
                    ))}
                  </Select>
                  {st.threadIsDefault && <div><ToolDefault what="tool default" /></div>}
                  {st.threadMode === 'continue' && <div className="text-[11px] text-gray-500">thread of step {threadRootIndex(seq, i) + 1}</div>}
                </td>
                <td className="max-w-[220px] px-2 py-1.5 text-xs text-gray-700">{resolveText(stepSubjectRaw(seq, i).text, ctx) || <i className="text-gray-400">none</i>}</td>
                <td className="whitespace-nowrap px-1 py-1.5">
                  <IconBtn label="Move up" disabled={i === 0} onClick={() => upSeq((s) => { move(s.steps, i, i - 1); s.steps[0].threadMode = 'new'; })}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn label="Move down" disabled={i === seq.steps.length - 1} onClick={() => upSeq((s) => { move(s.steps, i, i + 1); s.steps[0].threadMode = 'new'; })}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn label="Duplicate" onClick={() => upSeq((s) => void s.steps.splice(i + 1, 0, { ...copyStep(st), name: `${st.name} (copy)` }))}>
                    <Copy className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn
                    label="Delete"
                    onClick={() => {
                      if (window.confirm(`Delete step "${st.name}"? You can undo this.`)) edit((d) => deleteStep(d, seq.id, st.id));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconBtn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-gray-500">Delays marked “tool default” are suggestions added by the tool; the source file gives no timings.</p>

      <SectionTitle>Supporting content (examples, guidance — never sent)</SectionTitle>
      <BlockList
        blocks={seq.blocks}
        ctx={ctx}
        mode={ui.textMode}
        emptyText="No supporting content for this sequence."
        onEdit={(fn, key) => upSeq((s) => fn(s.blocks), key)}
      />
    </div>
  );
}
