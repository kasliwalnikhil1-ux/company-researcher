'use client';

// Editor for one step: name, delay, threading, subject variants and selectable versions.

import { ArrowDown, ArrowUp, Check, Copy, Plus, Trash2, Eye, Code2 } from 'lucide-react';
import type { Step, Version } from '@/lib/sequence-studio/types';
import { stepSubjectRaw } from '@/lib/sequence-studio/simulate';
import { blocksText, countWords, renderBody } from '@/lib/sequence-studio/emailText';
import { missingIn, resolveText } from '@/lib/sequence-studio/variables';
import { move, uid, unescapeMd } from '@/lib/sequence-studio/util';
import type { Studio } from './store';
import { copyStep, blankStep, deleteStep, findStep } from './mut';
import { TokenTextarea } from './TokenTextarea';
import { Badge, Btn, Empty, Field, IconBtn, Input, SectionTitle, Seg, Select, Toggle, ToolDefault, cx } from './ui';


export function TextModeToggle({ studio }: { studio: Studio }) {
  return (
    <Seg
      size="sm"
      label="Text mode"
      value={studio.ui.textMode}
      onChange={(v) => studio.setUi({ textMode: v })}
      options={[
        { value: 'raw', label: <span className="inline-flex items-center gap-1"><Code2 className="h-3 w-3" />Template</span>, title: 'Edit the template with {{placeholders}}' },
        { value: 'personalized', label: <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" />Personalized</span>, title: 'Read the text with the sample prospect’s values (read-only)' },
      ]}
    />
  );
}

export default function MessageTab({ studio }: { studio: Studio }) {
  const { lib, ui, setUi, edit, focusStep } = studio;
  const seq = lib?.sequences.find((s) => s.id === ui.sequenceId);
  const index = seq ? seq.steps.findIndex((s) => s.id === ui.stepId) : -1;
  const step = index >= 0 ? seq!.steps[index] : undefined;
  // The version being edited (shared with the preview); resets to the step's selected version
  // when the step changes.
  const pick = ui.versionPick;
  const versionId = pick?.stepId === step?.id ? pick?.versionId : step?.selectedVersionId;
  const setVersionId = (id: string | undefined) => setUi({ versionPick: step && id ? { stepId: step.id, versionId: id } : undefined });

  if (!lib || !seq) return <Empty>Select a sequence.</Empty>;
  if (!step)
    return (
      <Empty>
        This sequence has no steps.{' '}
        <Btn
          size="sm"
          onClick={() => {
            const st = blankStep(0);
            edit((d) => void d.sequences.find((s) => s.id === seq.id)?.steps.push(st));
            setUi({ stepId: st.id });
          }}
        >
          Add the first step
        </Btn>
      </Empty>
    );

  const profile = lib.profiles.find((p) => p.id === lib.activeProfileId);
  const ctx = { profile, variables: lib.variables };
  const mode = ui.textMode;
  const subj = stepSubjectRaw(seq, index);
  const version = step.versions.find((v) => v.id === versionId) ?? step.versions.find((v) => v.id === step.selectedVersionId) ?? step.versions[0];

  const up = (fn: (st: Step) => void, key?: string) =>
    edit((d) => {
      const st = findStep(d, seq.id, step.id);
      if (st) fn(st);
    }, key);
  const upVersion = (fn: (v: Version) => void, key?: string) =>
    up((st) => {
      const v = st.versions.find((x) => x.id === version?.id);
      if (v) fn(v);
    }, key);

  const bodyBlocks = version ? renderBody(version.body, ctx, lib.settings.bodyFormat) : [];
  const bodyText = blocksText(bodyBlocks);
  const missing = version ? [...new Set([...missingIn(version.body, ctx), ...missingIn(subj.text, ctx)])] : [];
  const earlier = seq.steps.slice(0, index);

  return (
    // Anything focused here is "the edit": the preview shows this step and scrolls to it.
    <div className="space-y-1" onFocusCapture={() => focusStep(seq.id, step.id, 'body')}>
      <div className="flex items-center gap-2">
        <span className="flex-none whitespace-nowrap text-xs font-medium text-gray-500">
          Step {index + 1} of {seq.steps.length}
        </span>
        <TextModeToggle studio={studio} />
        <div className="ml-auto flex flex-none items-center">
          <IconBtn className="h-6 w-6" label="Move step earlier" disabled={index === 0} onClick={() => edit((d) => { const s = d.sequences.find((x) => x.id === seq.id)!; move(s.steps, index, index - 1); s.steps[0].threadMode = 'new'; })}>
            <ArrowUp className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn className="h-6 w-6" label="Move step later" disabled={index === seq.steps.length - 1} onClick={() => edit((d) => { const s = d.sequences.find((x) => x.id === seq.id)!; move(s.steps, index, index + 1); s.steps[0].threadMode = 'new'; })}>
            <ArrowDown className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn
            className="h-6 w-6"
            label="Duplicate step"
            onClick={() => {
              const c = copyStep(step);
              c.name = `${step.name} (copy)`;
              edit((d) => void d.sequences.find((x) => x.id === seq.id)!.steps.splice(index + 1, 0, c));
              setUi({ stepId: c.id });
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn
            className="h-6 w-6"
            label="Add step after this one"
            onClick={() => {
              const st = blankStep(index + 1);
              edit((d) => void d.sequences.find((x) => x.id === seq.id)!.steps.splice(index + 1, 0, st));
              setUi({ stepId: st.id });
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn
            className="h-6 w-6"
            label="Delete step"
            onClick={() => {
              if (!window.confirm(`Delete step "${step.name}"? You can undo this.`)) return;
              edit((d) => deleteStep(d, seq.id, step.id));
              setUi({ stepId: seq.steps[index - 1]?.id ?? seq.steps[index + 1]?.id });
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      </div>

      <Input aria-label="Step name" value={step.name} onChange={(e) => up((st) => void (st.name = e.target.value), `step-name-${step.id}`)} className="text-base font-semibold" />

      <div className="grid gap-3 pt-2 sm:grid-cols-2">
        <Field
          label={
            <>
              Delay {step.delayIsDefault && <ToolDefault />}
            </>
          }
          hint={index === 0 ? 'Days after the sequence starts.' : 'Days after the previous step.'}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={365}
              value={step.delayDays}
              onChange={(e) => up((st) => {
                st.delayDays = Math.max(0, Math.min(365, Number(e.target.value) || 0));
                st.delayIsDefault = false;
              }, `delay-${step.id}`)}
              className="w-20"
            />
            <span className="text-sm text-gray-600">days</span>
          </div>
        </Field>
        <Field
          label={
            <>
              Threading {step.threadIsDefault && <ToolDefault />}
            </>
          }
          hint={index === 0 ? 'The first step always starts a thread.' : step.threadMode === 'continue' ? 'Sent as a reply in an earlier step’s thread.' : 'Sent as a separate email with its own subject.'}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Seg
              size="sm"
              label="Threading"
              value={step.threadMode}
              onChange={(v) => index > 0 && up((st) => {
                st.threadMode = v;
                st.threadIsDefault = false;
              })}
              options={[
                { value: 'new', label: 'New thread' },
                { value: 'continue', label: 'Continue thread' },
              ]}
            />
            {step.threadMode === 'continue' && index > 0 && (
              <Select
                aria-label="Continue the thread of"
                value={step.continueFromStepId ?? ''}
                onChange={(e) => up((st) => {
                  st.continueFromStepId = e.target.value || undefined;
                  st.threadIsDefault = false;
                })}
                className="py-1 text-xs"
              >
                <option value="">of the previous step</option>
                {earlier.map((s, k) => (
                  <option key={s.id} value={s.id}>
                    of step {k + 1}: {s.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Field>
      </div>
      <div className="flex flex-wrap gap-4 pt-1 text-sm text-gray-700">
        <Toggle checked={step.includeSignature} onChange={(v) => up((st) => void (st.includeSignature = v))} label="Add signature" />
        {step.threadMode === 'continue' && (
          <span title="Quote the previous message under this one, as replies normally do. Gmail hides it behind •••.">
            <Toggle checked={step.quotePrevious} onChange={(v) => up((st) => void (st.quotePrevious = v))} label="Quote the previous message" />
          </span>
        )}
      </div>

      {/* Subjects */}
      <SectionTitle
        actions={
          <Btn
            size="sm"
            tone="ghost"
            onClick={() =>
              up((st) => {
                const s = { id: uid('sub'), text: '' };
                st.subjects.push(s);
                if (!st.selectedSubjectId) st.selectedSubjectId = s.id;
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> Add subject
          </Btn>
        }
      >
        Subject
      </SectionTitle>
      {subj.inherited && (
        <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          Sent as <b>{resolveText(subj.text, ctx)}</b> — inherited from step {subj.rootIndex + 1}’s thread. The variants below apply only if this step starts a new thread.
        </div>
      )}
      {!step.subjects.length && !subj.inherited && <Empty>No subject yet. Add one.</Empty>}
      <ul className={cx('space-y-1.5', subj.inherited && 'opacity-60')}>
        {step.subjects.map((s, k) => {
          const resolved = resolveText(s.text, ctx);
          const pairedWith = step.versions.filter((v) => v.subjectId === s.id).map((v) => v.name);
          return (
            <li key={s.id} className="group flex items-start gap-2" onFocusCapture={() => focusStep(seq.id, step.id, 'subject', subj.inherited ? undefined : s.id)}>
              <input
                type="radio"
                name={`subject-${step.id}`}
                className="mt-2.5"
                checked={step.selectedSubjectId === s.id}
                onChange={() => up((st) => void (st.selectedSubjectId = s.id))}
                aria-label={`Use subject ${k + 1}`}
              />
              <div className="min-w-0 flex-1">
                <TokenTextarea singleLine label={`Subject variant ${k + 1}`} value={s.text} ctx={ctx} mode={mode} onChange={(v) => up((st) => void (st.subjects.find((x) => x.id === s.id)!.text = v), `subject-${s.id}`)} />
                <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-gray-500">
                  <span className="tabular-nums">{resolved.length} characters</span>
                  {pairedWith.length > 0 && <span>· written with {pairedWith.join(', ')}</span>}
                  {/^\s*re:/i.test(s.text) && <span className="text-amber-700">· starts with “Re:” — threading still comes from the Threading setting, not the subject</span>}
                </div>
              </div>
              <div className="flex flex-none items-center pt-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <IconBtn label="Move subject up" disabled={k === 0} onClick={() => up((st) => move(st.subjects, k, k - 1))} className="h-6 w-6">
                  <ArrowUp className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn label="Move subject down" disabled={k === step.subjects.length - 1} onClick={() => up((st) => move(st.subjects, k, k + 1))} className="h-6 w-6">
                  <ArrowDown className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn label="Duplicate subject" onClick={() => up((st) => void st.subjects.splice(k + 1, 0, { id: uid('sub'), text: s.text }))} className="h-6 w-6">
                  <Copy className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn
                  label="Delete subject"
                  className="h-6 w-6"
                  onClick={() =>
                    up((st) => {
                      st.subjects = st.subjects.filter((x) => x.id !== s.id);
                      for (const v of st.versions) if (v.subjectId === s.id) v.subjectId = undefined;
                      if (st.selectedSubjectId === s.id) st.selectedSubjectId = st.subjects[0]?.id;
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Versions */}
      <SectionTitle
        actions={
          <Btn
            size="sm"
            tone="ghost"
            onClick={() => {
              const v: Version = { id: uid('ver'), name: `Version ${step.versions.length + 1}`, kind: 'template', body: '', previewText: '' };
              up((st) => {
                st.versions.push(v);
                st.selectedVersionId ??= v.id;
              });
              setVersionId(v.id);
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Add version
          </Btn>
        }
      >
        Message versions
      </SectionTitle>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Versions">
        {step.versions.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={v.id === version?.id}
            onClick={() => setVersionId(v.id)}
            className={cx('flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs', v.id === version?.id ? 'border-indigo-500 bg-indigo-50 font-medium text-indigo-900' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50')}
          >
            {v.id === step.selectedVersionId && <Check className="h-3 w-3 text-emerald-600" aria-label="Used in the sequence" />}
            {v.name || 'Untitled'}
          </button>
        ))}
      </div>
      {version && (
        <div className="mt-2 space-y-3 rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Version name" className="min-w-[160px] flex-1">
              <Input value={version.name} onChange={(e) => upVersion((v) => void (v.name = e.target.value), `ver-name-${version.id}`)} />
            </Field>
            {/* A threaded step inherits the thread subject, so pairing a subject means nothing there. */}
            {!subj.inherited && (
              <Field label="Written with subject">
                <Select value={version.subjectId ?? ''} onChange={(e) => upVersion((v) => void (v.subjectId = e.target.value || undefined))} className="max-w-[200px]">
                  <option value="">— none —</option>
                  {step.subjects.map((s, k) => (
                    <option key={s.id} value={s.id}>
                      {k + 1}. {unescapeMd(s.text) || '(empty)'}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {version.id === step.selectedVersionId ? (
              <Badge tone="green">Used when this step is sent</Badge>
            ) : (
              <Btn size="sm" onClick={() => up((st) => {
                st.selectedVersionId = version.id;
                if (version.subjectId) st.selectedSubjectId = version.subjectId;
              })}>
                Use this version
              </Btn>
            )}
            <div className="ml-auto flex items-center">
              <IconBtn label="Move version left" disabled={step.versions[0]?.id === version.id} onClick={() => up((st) => { const k = st.versions.findIndex((x) => x.id === version.id); move(st.versions, k, k - 1); })}>
                <ArrowUp className="h-3.5 w-3.5 -rotate-90" />
              </IconBtn>
              <IconBtn label="Move version right" disabled={step.versions[step.versions.length - 1]?.id === version.id} onClick={() => up((st) => { const k = st.versions.findIndex((x) => x.id === version.id); move(st.versions, k, k + 1); })}>
                <ArrowDown className="h-3.5 w-3.5 -rotate-90" />
              </IconBtn>
              <IconBtn
                label="Duplicate version"
                onClick={() => {
                  const c = { ...version, id: uid('ver'), name: `${version.name} (copy)` };
                  up((st) => void st.versions.splice(st.versions.findIndex((x) => x.id === version.id) + 1, 0, c));
                  setVersionId(c.id);
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </IconBtn>
              <IconBtn
                label="Delete version"
                disabled={step.versions.length < 2}
                onClick={() => {
                  if (!window.confirm(`Delete version "${version.name}"? You can undo this.`)) return;
                  up((st) => {
                    st.versions = st.versions.filter((x) => x.id !== version.id);
                    if (st.selectedVersionId === version.id) st.selectedVersionId = st.versions[0]?.id;
                  });
                  setVersionId(undefined);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconBtn>
            </div>
          </div>
          <Field label="Body">
            <TokenTextarea label="Message body" value={version.body} ctx={ctx} mode={mode} minRows={2} onChange={(v) => upVersion((x) => void (x.body = v), `body-${version.id}`)} />
          </Field>
          <div className="text-xs tabular-nums text-gray-500">
            {bodyText.length} characters · {countWords(bodyText)} words
          </div>
          {missing.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">
              Missing with “{profile?.label}”: {missing.map((m) => `{{${m}}}`).join(', ')}. Add a sample value or fallback in Variables — the preview shows the raw placeholder.
            </div>
          )}
        </div>
      )}

      {seq.blocks.length > 0 && (
        <>
          <SectionTitle>Supporting content for this sequence</SectionTitle>
          <ul className="space-y-1">
            {seq.blocks.map((b) => (
              <li key={b.id}>
                <details className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm">
                  <summary className="cursor-pointer text-gray-700">
                    {b.title} <Badge tone={b.kind === 'example' ? 'sky' : b.kind === 'note' ? 'amber' : 'gray'}>{b.kind}</Badge>
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-gray-700">{b.body}</pre>
                  <button type="button" className="mt-1 text-xs text-indigo-700 hover:underline" onClick={() => setUi({ tab: 'sequence' })}>
                    Edit in the Sequence tab
                  </button>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
