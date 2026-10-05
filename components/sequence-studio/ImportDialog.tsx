'use client';

// Review an import before it is applied: what was recognised, what is ambiguous, and whether
// to replace the library or add to it.

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { ImportResult, Library } from '@/lib/sequence-studio/types';
import { Badge, Btn, Seg } from './ui';

function counts(lib: Library) {
  return [
    ['sequences', lib.sequences.length],
    ['steps', lib.sequences.reduce((n, s) => n + s.steps.length, 0)],
    ['versions', lib.sequences.reduce((n, s) => n + s.steps.reduce((m, st) => m + st.versions.length, 0), 0)],
    ['subject variants', lib.sequences.reduce((n, s) => n + s.steps.reduce((m, st) => m + st.subjects.length, 0), 0)],
    ['replies', lib.replies.length],
    ['reply branches', lib.conversations.length],
    ['guidance blocks', lib.blocks.length + lib.sequences.reduce((n, s) => n + s.blocks.length, 0)],
    ['variables', lib.variables.length],
  ] as const;
}

export default function ImportDialog({ fileName, result, onApply, onCancel }: { fileName: string; result: ImportResult; onApply: (mode: 'replace' | 'merge') => void; onCancel: () => void }) {
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');
  const [showInfo, setShowInfo] = useState(false);
  const lib = result.library;
  const flagged = useMemo(() => result.notes.filter((n) => n.level !== 'info'), [result]);
  const info = useMemo(() => result.notes.filter((n) => n.level === 'info'), [result]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal aria-labelledby="import-title">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-3">
          <h2 id="import-title" className="text-base font-semibold text-gray-900">
            Review import: {fileName}
          </h2>
          <Badge tone={result.format === 'studio' ? 'green' : 'violet'}>{result.format === 'studio' ? 'Sequence Studio file' : 'Free-form Markdown — mapped heuristically'}</Badge>
          <button type="button" onClick={onCancel} className="ml-auto rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Cancel import">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4 text-sm">
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Proposed structure</h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-700">
              {counts(lib).map(([k, v]) => (
                <span key={k}>
                  <b className="tabular-nums">{v}</b> {k}
                </span>
              ))}
            </div>
            <ul className="mt-2 space-y-1 text-xs text-gray-700">
              {lib.sequences.map((s) => (
                <li key={s.id}>
                  <b>{s.name}</b> — {s.steps.map((st) => `${st.name}${st.versions.length > 1 ? ` (${st.versions.length} versions)` : ''}`).join(' → ')}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Needs a look ({flagged.length})
            </h3>
            {!flagged.length ? (
              <p className="text-xs text-gray-500">Nothing ambiguous. Everything was mapped or kept.</p>
            ) : (
              <ul className="space-y-1">
                {flagged.map((n, i) => (
                  <li key={i} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                    <Badge tone={n.level === 'ambiguous' ? 'amber' : 'gray'}>{n.level === 'ambiguous' ? 'ambiguous' : 'kept as-is'}</Badge> <b>{n.section}</b>: {n.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <button type="button" className="text-xs font-medium text-indigo-700 hover:underline" onClick={() => setShowInfo((v) => !v)}>
              {showInfo ? 'Hide' : 'Show'} all {info.length} mapping decisions
            </button>
            {showInfo && (
              <ul className="mt-1 max-h-64 space-y-0.5 overflow-auto text-xs text-gray-600">
                {info.map((n, i) => (
                  <li key={i}>
                    <b>{n.section}</b>: {n.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-gray-500">No content is discarded: anything that could not be mapped becomes an editable guidance or “unmapped” block.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 px-5 py-3">
          <Seg
            label="Import mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'replace', label: 'Replace current library' },
              { value: 'merge', label: 'Add to current library' },
            ]}
          />
          <span className="text-xs text-gray-500">{mode === 'replace' ? 'Undo brings back your current library.' : 'Sequences, replies, branches and guidance are appended; matching categories and variables are reused.'}</span>
          <div className="ml-auto flex gap-2">
            <Btn onClick={onCancel}>Cancel</Btn>
            <Btn tone="primary" onClick={() => onApply(mode)}>
              Apply import
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
