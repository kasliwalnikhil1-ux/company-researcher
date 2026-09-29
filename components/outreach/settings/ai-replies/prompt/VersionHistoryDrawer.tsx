'use client';

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { usePromptVersions } from '@/lib/outreach/aiReplies';
import type { DraftPrompt, PromptVersion } from '@/lib/outreach/aiReplies';
import { Badge, Button, EmptyState, ErrorBox, Select, Spinner, fmtDate } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { lineDiff, withContext } from './lineDiff';
import { normalize, promptToText } from './promptModel';

function DiffView({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => withContext(lineDiff(before, after)), [before, after]);
  const changes = rows.filter((r) => r && r.kind !== 'same').length;
  if (!changes) return <p className="text-sm text-gray-500 py-4">No differences.</p>;
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden text-xs font-mono" aria-label="Differences">
      {rows.map((r, i) => r === null ? (
        <div key={i} className="px-3 py-0.5 bg-gray-50 text-gray-400 select-none">⋯</div>
      ) : (
        <div key={i} className={cn('px-3 py-0.5 whitespace-pre-wrap break-words', r.kind === 'add' && 'bg-green-50 text-green-900', r.kind === 'del' && 'bg-red-50 text-red-900 line-through decoration-red-300', r.kind === 'same' && 'text-gray-600')}>
          <span className="inline-block w-4 select-none text-gray-400" aria-hidden="true">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
          <span className="sr-only">{r.kind === 'add' ? 'Added: ' : r.kind === 'del' ? 'Removed: ' : ''}</span>
          {r.text || ' '}
        </div>
      ))}
    </div>
  );
}

export default function VersionHistoryDrawer({ open, onClose, masterPromptId, editor, canEdit, stageName, onRestore }: {
  open: boolean;
  onClose: () => void;
  masterPromptId: string;
  /** What is in the editor now (saved or not). */
  editor: DraftPrompt;
  canEdit: boolean;
  stageName: (id: string) => string | undefined;
  onRestore: (v: PromptVersion) => void;
}) {
  const versions = usePromptVersions(open ? masterPromptId : null);
  const list = useMemo(() => [...(versions.data ?? [])].sort((a, b) => b.version - a.version), [versions.data]);
  const [picked, setPicked] = useState<number | null>(null);
  const [against, setAgainst] = useState<string>('editor');
  const selected = list.find((v) => v.version === picked) ?? list[0] ?? null;
  const other = against === 'editor' ? null : list.find((v) => String(v.version) === against) ?? null;

  if (!open) return null;
  const text = (p: DraftPrompt) => promptToText(normalize(p), stageName);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="Version history" className="absolute right-0 top-0 h-full w-full max-w-3xl bg-white shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div><h2 className="text-base font-semibold text-gray-900">Version history</h2><p className="text-xs text-gray-500">Every save is kept. Compare any version and load it back into the editor.</p></div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500"><X className="w-4 h-4" /></button>
        </div>
        {versions.isLoading ? <Spinner /> : versions.isError ? <div className="p-5"><ErrorBox message={(versions.error as Error).message} /></div> : !list.length ? (
          <EmptyState title="No versions yet" description="Versions appear here after the first save." />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col md:flex-row">
            <ul className="md:w-64 flex-shrink-0 border-b md:border-b-0 md:border-r border-gray-100 overflow-y-auto max-h-56 md:max-h-none" aria-label="Versions">
              {list.map((v) => (
                <li key={v.version}>
                  <button type="button" onClick={() => setPicked(v.version)} aria-current={selected?.version === v.version}
                    className={cn('w-full text-left px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50', selected?.version === v.version && 'bg-indigo-50/60')}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">Version {v.version}</span>
                      <Badge tone={v.change_kind === 'substantive' ? 'amber' : 'gray'}>{v.change_kind === 'substantive' ? 'Substantive' : 'Style'}</Badge>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{v.created_by_name ?? 'Someone'} · {fmtDate(v.created_at)}</div>
                    {v.note && <div className="text-xs text-gray-600 mt-0.5 line-clamp-2">{v.note}</div>}
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="text-sm text-gray-700 pb-2">Version {selected.version} compared with</div>
                  <Select aria-label="Compare with" value={against} onChange={(e) => setAgainst(e.target.value)} className="w-56">
                    <option value="editor">What&apos;s in the editor now</option>
                    {list.filter((v) => v.version !== selected.version).map((v) => <option key={v.version} value={String(v.version)}>Version {v.version}</option>)}
                  </Select>
                  {canEdit && <Button size="sm" variant="secondary" className="mb-0.5 ml-auto" onClick={() => onRestore(selected)}>Restore into editor</Button>}
                </div>
                <p className="text-xs text-gray-500"><span className="text-red-700">Red</span> is only in version {selected.version}; <span className="text-green-700">green</span> is only in {other ? `version ${other.version}` : 'the editor'}.</p>
                <DiffView before={text(selected)} after={other ? text(other) : text(editor)} />
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
