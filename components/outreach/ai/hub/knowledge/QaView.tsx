'use client';

// Knowledge → Q&A (AI hub §6): one list of question and answer pairs. A pair is either shared (everywhere unless it is
// limited to some sequences and websites) or kept on one sequence's prompt.
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HelpCircle, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { hk, qaScopeText, useQaDelete, useQaList, useQaSave, type QaPair } from '@/lib/outreach/aiHub';
import { Badge, Button, EmptyState, ErrorBox, Spinner } from '@/components/outreach/ui';
import { ConfirmModal, Switch } from '@/components/outreach/settings/shared';
import { errText, plural } from '@/components/outreach/sequences/ai/shared';
import { cn } from '@/lib/utils';
import type { Notify } from './shared';

// an answer longer than this (or with several lines) is clamped to two lines until it is opened
const isLong = (answer: string) => answer.length > 180 || answer.split('\n').length > 2;

export default function QaView({ ws, canEdit, onAdd, onEdit, notify }: { ws: string; canEdit: boolean; onAdd: () => void; onEdit: (p: QaPair) => void; notify: Notify }) {
  const qc = useQueryClient();
  const q = useQaList(ws);
  const save = useQaSave(ws);
  const del = useQaDelete(ws);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  // switches being saved: the value the user asked for, shown until the call answers
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [toDelete, setToDelete] = useState<QaPair | null>(null);

  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = q.data ?? [];
    return needle ? all.filter((p) => `${p.question}\n${p.answer}`.toLowerCase().includes(needle)) : all;
  }, [q.data, needle]);
  const total = q.data?.length ?? 0;

  const toggleOpen = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function setEnabled(p: QaPair, on: boolean) {
    setPending((m) => ({ ...m, [p.id]: on }));
    try {
      // targets are left out: the pair stays where it is (shared, or on its sequence's prompt)
      await save.mutateAsync({ id: p.id, question: p.question, answer: p.answer, enabled: on });
      qc.setQueryData<QaPair[]>(hk.qa(ws), (old) => old?.map((x) => (x.id === p.id ? { ...x, enabled: on } : x)));
    } catch (e) { notify(errText(e), 'error'); }
    finally { setPending((m) => { const n = { ...m }; delete n[p.id]; return n; }); }
  }

  async function remove() {
    if (!toDelete) return;
    try { await del.mutateAsync({ id: toDelete.id }); notify('Q&A deleted.'); }
    catch (e) { notify(errText(e), 'error'); }
    finally { setToDelete(null); }
  }

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={errText(q.error)} />;

  if (total === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl">
        <EmptyState icon={<HelpCircle className="w-6 h-6" />} title="No Q&A yet"
          description="A pair is a question and the answer you approved. AI replies and the Website agent use it when someone asks that question."
          action={canEdit ? <Button onClick={onAdd}><Plus className="w-4 h-4" aria-hidden="true" />Q&amp;A</Button> : undefined} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <label className="relative flex-1 min-w-[200px] max-w-sm">
          <span className="sr-only">Search questions and answers</span>
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search questions and answers…"
            className="w-full pl-8 pr-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </label>
        <span className="text-xs text-gray-500 tabular-nums" aria-live="polite">{needle ? `${rows.length} of ${total}` : `${total} ${plural(total, 'pair')}`}</span>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-8 text-center text-sm text-gray-500">No pair matches your search.</div>
      ) : (
        <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
          {rows.map((p) => {
            const on = pending[p.id] ?? p.enabled;
            const saving = p.id in pending;
            const long = isLong(p.answer ?? '');
            const expanded = open.has(p.id);
            return (
              <li key={p.id} className="px-4 py-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn('text-sm font-medium break-words', on ? 'text-gray-900' : 'text-gray-500')}>{p.question}</span>
                    {p.source === 'unanswered' && <Badge tone="blue">from an unanswered question</Badge>}
                    {!on && !canEdit && <Badge tone="gray">Off</Badge>}
                  </div>
                  <p id={`qa-answer-${p.id}`} className={cn('text-sm whitespace-pre-wrap break-words mt-0.5', on ? 'text-gray-700' : 'text-gray-500', long && !expanded && 'line-clamp-2')}>{p.answer}</p>
                  {long && (
                    <button type="button" aria-expanded={expanded} aria-controls={`qa-answer-${p.id}`} onClick={() => toggleOpen(p.id)}
                      className="text-xs text-indigo-600 hover:underline mt-0.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{expanded ? 'Show less' : 'Show all'}</button>
                  )}
                  <div className="text-xs text-gray-500 mt-1">
                    Used by: <span className="text-gray-700">{qaScopeText({ targets: p.targets ?? [] })}</span>
                    {p.owner === 'sequence' && <span> · kept on that sequence&rsquo;s prompt</span>}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Switch checked={on} disabled={saving} label={`Use this answer: ${p.question}`} onChange={(v) => setEnabled(p, v)} />
                    <button type="button" aria-label={`Edit: ${p.question}`} onClick={() => onEdit(p)} className="ml-1 p-1.5 rounded text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><Pencil className="w-4 h-4" aria-hidden="true" /></button>
                    <button type="button" aria-label={`Delete: ${p.question}`} onClick={() => setToDelete(p)} className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><Trash2 className="w-4 h-4" aria-hidden="true" /></button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!canEdit && <p className="text-xs text-gray-500 mt-2">Owners and managers add and change Q&amp;A.</p>}

      <ConfirmModal open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={remove} loading={del.isPending} title="Delete this Q&A?" confirmLabel="Delete">
        <p>&ldquo;{toDelete?.question}&rdquo; is removed. If it came from an unanswered question, that question opens again.</p>
        {toDelete?.owner === 'sequence' && <p>It is kept on the prompt of {toDelete.targets?.[0]?.name ?? 'a sequence'}, so a new version of that prompt is saved.</p>}
      </ConfirmModal>
    </div>
  );
}
