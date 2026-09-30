'use client';

// Settings → AI replies → Defaults: the per-sender daily AI send cap, the default library prompt and the library itself.
import { useState } from 'react';
import { BookOpen, Plus, Star, Trash2 } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useDeleteLibraryPrompt, useLibraryPrompts, useSetWorkspaceReplySettings, useWorkspaceReplySettings, type LibraryPromptRow } from '@/lib/outreach/aiRepliesSequence';
import { Badge, Button, Card, EmptyState, ErrorBox, Select, Spinner, Table, Td, Th, timeAgo } from '@/components/outreach/ui';
import { ConfirmModal, Note } from '@/components/outreach/settings/shared';
import LibraryPromptEditor from './LibraryPromptEditor';

export default function DefaultsPanel({ ws, canEdit, notify }: { ws: string; canEdit: boolean; notify: (m: string, t?: 'success' | 'error') => void }) {
  const settings = useWorkspaceReplySettings(ws);
  const setSettings = useSetWorkspaceReplySettings(ws);
  const lib = useLibraryPrompts(ws);
  const del = useDeleteLibraryPrompt(ws);
  const [cap, setCap] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; key: number } | null>(null);
  const [toDelete, setToDelete] = useState<LibraryPromptRow | null>(null);
  const w = settings.data;
  const [seenCap, setSeenCap] = useState<number | null>(null);
  if (w && w.max_ai_sends_per_sender_day !== seenCap) { setSeenCap(w.max_ai_sends_per_sender_day); setCap(String(w.max_ai_sends_per_sender_day)); }

  const capN = Math.round(Number(cap));
  const capOk = Number.isFinite(capN) && capN >= 1 && capN <= 40;
  const capDirty = !!w && capOk && capN !== w.max_ai_sends_per_sender_day;
  const fail = (e: unknown) => notify(parseError(e).message, 'error');
  const patch = (p: Parameters<typeof setSettings.mutate>[0], ok: string) => setSettings.mutate(p, { onSuccess: () => notify(ok), onError: fail });

  return (
    <div className="space-y-5">
      <Card title="Limits">
        {settings.isLoading ? <Spinner /> : settings.error ? <ErrorBox message={parseError(settings.error).message} /> : w && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 mb-1">AI sends per sender per day</span>
                <input type="number" inputMode="numeric" min={1} max={40} step={1} value={cap} disabled={!canEdit} onChange={(e) => setCap(e.target.value)} aria-label="AI sends per sender per day"
                  className={`w-28 px-3 py-2 text-sm rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 ${capOk ? 'border-gray-300' : 'border-red-400'}`} />
              </label>
              {canEdit && <Button size="sm" disabled={!capDirty} loading={setSettings.isPending} onClick={() => patch({ max_ai_sends_per_sender_day: capN }, 'Cap saved.')}>Save</Button>}
            </div>
            <p className="text-xs text-gray-500">Counts Auto sends across every sequence a sender is in. 1 to 40. Sender owners see this number when they approve.</p>
          </div>
        )}
      </Card>

      <Card title="Library prompts"
        actions={canEdit && <Button size="sm" onClick={() => setEditing({ id: null, key: Date.now() })}><Plus className="w-3.5 h-3.5" />New prompt</Button>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Starting points for sequences. A new sequence copies the default; any sequence can copy a library prompt from its AI replies tab. Copies are independent: editing a library prompt never changes a sequence.</p>
          {w && (
            <div className="flex flex-wrap items-end gap-3">
              <Select label="Default for new sequences" value={w.default_prompt_id ?? ''} disabled={!canEdit || setSettings.isPending} className="w-72"
                onChange={(e) => patch({ default_prompt_id: e.target.value || null }, e.target.value ? 'Default prompt set.' : 'New sequences start from the built-in template.')}>
                <option value="">Built-in template</option>
                {(lib.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
          )}
          {lib.isLoading ? <Spinner /> : lib.error ? <ErrorBox message={parseError(lib.error).message} /> : (lib.data ?? []).length === 0 ? (
            <EmptyState icon={<BookOpen className="w-6 h-6" />} title="No library prompts yet" description="Sequences start from the built-in template. Save a prompt here to reuse your own wording across sequences." />
          ) : (
            <Table>
              <thead><tr><Th>Name</Th><Th>Version</Th><Th>Used by</Th><Th>Updated</Th><Th className="text-right"> </Th></tr></thead>
              <tbody>
                {(lib.data ?? []).map((l) => (
                  <tr key={l.id}>
                    <Td><span className="font-medium text-gray-900">{l.name}</span>{l.is_default && <Badge tone="indigo" className="ml-2">Default</Badge>}{l.editor_mode === 'raw' && <Badge className="ml-2">Raw</Badge>}</Td>
                    <Td className="text-xs">v{l.version}</Td>
                    <Td className="text-xs">{l.used_by} {l.used_by === 1 ? 'sequence' : 'sequences'}</Td>
                    <Td className="text-xs text-gray-500">{timeAgo(l.updated_at)}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="secondary" onClick={() => setEditing({ id: l.id, key: Date.now() })}>{canEdit ? 'Edit' : 'View'}</Button>
                      {canEdit && !l.is_default && <Button size="sm" variant="ghost" className="ml-1" onClick={() => patch({ default_prompt_id: l.id }, `"${l.name}" is the default for new sequences.`)}><Star className="w-3.5 h-3.5" />Use as default</Button>}
                      {canEdit && <button type="button" aria-label={`Delete ${l.name}`} onClick={() => setToDelete(l)} className="ml-1 p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 align-middle"><Trash2 className="w-4 h-4" /></button>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {!canEdit && <Note>Only owners and managers can change the defaults and the library.</Note>}
        </div>
      </Card>

      {editing && <LibraryPromptEditor key={editing.key} ws={ws} id={editing.id} canEdit={canEdit} onClose={() => setEditing(null)} notify={notify} />}
      <ConfirmModal open={!!toDelete} onClose={() => setToDelete(null)} loading={del.isPending} title="Delete this library prompt?" confirmLabel="Delete"
        onConfirm={async () => { if (!toDelete) return; try { await del.mutateAsync(toDelete.id); setToDelete(null); notify('Deleted.'); } catch (e) { fail(e); setToDelete(null); } }}>
        <p>&ldquo;{toDelete?.name}&rdquo; is removed from the library. Sequences that copied it keep their own copy.</p>
      </ConfirmModal>
    </div>
  );
}
