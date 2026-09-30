'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock, Pencil, Plus, Trash2, Check, X, Sparkles, CornerDownRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { aiqk, LEAD_NOTE_KEYS, LEAD_NOTE_LABEL, useLeadNotes, useUpdateLeadNotes, type LeadNoteItem, type LeadNoteKey } from '@/lib/outreach/aiReplies';
import { Button, Select } from '@/components/outreach/ui';

export interface LeadNotesPanelProps {
  leadId: string;
  /** The open chat: notes with a source message in it scroll to that message on click. */
  chatId?: string | null;
  /** Message ids loaded in the open thread (a source link only scrolls when its message is on screen). */
  loadedMessageIds?: Set<string> | null;
  canWrite: boolean;
  /** The person's first name for "from Priya's message, 12 Sep". */
  personName?: string | null;
  onError: (msg: string) => void;
  onNotice?: (msg: string) => void;
  /** Scroll the thread to a message (Thread's jumpTo); falls back to scrollIntoView on `#msg-<id>`. */
  onJumpTo?: (messageId: string) => void;
  className?: string;
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim().split(/\s+/)[0];
  return n || 'their';
}

type EditableItem = Pick<LeadNoteItem, 'key' | 'text'> & { id?: string | null };

/**
 * Lead notes (AI replies v2 §9.4): key facts the AI picked up from the prospect's messages, grouped by kind, with the
 * summary on top. Members with reply permission can edit, delete and add items; an edited item is locked (the AI may
 * add new items but never changes it). Every AI item links to the message it came from. The list refreshes live
 * (realtime on outreach_lead_ai_notes) and when the chat changes.
 */
export default function LeadNotesPanel({ leadId, chatId, loadedMessageIds, canWrite, personName, onError, onNotice, onJumpTo, className }: LeadNotesPanelProps) {
  const qc = useQueryClient();
  const q = useLeadNotes(leadId);
  const update = useUpdateLeadNotes();
  const [editing, setEditing] = useState<string | null>(null);   // item id
  const [editText, setEditText] = useState('');
  const [editKey, setEditKey] = useState<LeadNoteKey>('other');
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [newKey, setNewKey] = useState<LeadNoteKey>('other');

  // refetch on chat change (the realtime channel also invalidates on every write); mount with key={leadId} so edit state resets per lead
  useEffect(() => { if (leadId) qc.invalidateQueries({ queryKey: aiqk.leadNotes(leadId) }); }, [chatId, leadId, qc]);

  const items = useMemo(() => (q.data?.items ?? []).filter((it) => it && typeof it.text === 'string'), [q.data]);
  const groups = useMemo(() => {
    const by = new Map<LeadNoteKey, LeadNoteItem[]>();
    for (const it of items) {
      const k: LeadNoteKey = LEAD_NOTE_KEYS.includes(it.key) ? it.key : 'other';
      by.set(k, [...(by.get(k) ?? []), it]);
    }
    return LEAD_NOTE_KEYS.filter((k) => by.has(k)).map((k) => ({ key: k, items: by.get(k)! }));
  }, [items]);

  const fail = (e: unknown) => onError(parseError(e).message);
  const save = (next: EditableItem[], notice?: string) => update.mutate({ leadId, items: next.map((it) => ({ id: it.id ?? undefined, key: it.key, text: it.text })) }, {
    onSuccess: () => { setEditing(null); setAdding(false); setNewText(''); if (notice) onNotice?.(notice); },
    onError: fail,
  });
  const asEditable = (list: LeadNoteItem[]): EditableItem[] => list.map((it) => ({ id: it.id, key: it.key, text: it.text }));

  const startEdit = (it: LeadNoteItem) => { setEditing(it.id); setEditText(it.text); setEditKey(LEAD_NOTE_KEYS.includes(it.key) ? it.key : 'other'); setAdding(false); };
  const commitEdit = (it: LeadNoteItem) => {
    const text = editText.trim();
    if (!text) { setEditing(null); return; }
    if (text === it.text && editKey === it.key) { setEditing(null); return; }
    save(asEditable(items).map((x) => (x.id === it.id ? { ...x, key: editKey, text } : x)), 'Note updated. The AI will not change it.');
  };
  const remove = (it: LeadNoteItem) => {
    if (!window.confirm('Delete this note?')) return;
    save(asEditable(items).filter((x) => x.id !== it.id), 'Note deleted');
  };
  const commitAdd = () => {
    const text = newText.trim();
    if (!text) { setAdding(false); return; }
    save([...asEditable(items), { key: newKey, text }], 'Note added');
  };
  const jump = (id: string) => {
    if (onJumpTo) onJumpTo(id);
    else document.getElementById(`msg-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const who = firstName(personName);

  return (
    <div className={cn('space-y-3', className)}>
      {q.isLoading && <div className="flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading notes…</div>}
      {q.error && <div className="text-xs text-red-600">{parseError(q.error).message}</div>}
      {q.data && (
        <>
          {q.data.summary
            ? <div className="flex items-start gap-1.5 text-xs text-gray-700 rounded-md bg-fuchsia-50/60 border border-fuchsia-100 px-2.5 py-2"><Sparkles className="w-3.5 h-3.5 mt-0.5 text-fuchsia-500 flex-shrink-0" /><span className="whitespace-pre-wrap">{q.data.summary}</span></div>
            : items.length === 0 && !adding && <p className="text-xs text-gray-500">Nothing noted yet. The AI adds budget, timeline, objections and the like from what they write; you can add a note yourself.</p>}
          {groups.map((g) => (
            <div key={g.key}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">{LEAD_NOTE_LABEL[g.key]}</div>
              <ul className="space-y-1.5">
                {g.items.map((it) => {
                  const isEditing = editing === it.id;
                  const date = shortDate(it.updated_at);
                  const src = it.source_message_id;
                  const canJump = !!src && (!loadedMessageIds || loadedMessageIds.has(src));
                  return (
                    <li key={it.id} className="group rounded-md border border-gray-100 bg-white px-2.5 py-1.5">
                      {isEditing ? (
                        <div className="space-y-1.5">
                          <Select value={editKey} onChange={(e) => setEditKey(e.target.value as LeadNoteKey)} aria-label="Note kind" className="text-xs py-1">
                            {LEAD_NOTE_KEYS.map((k) => <option key={k} value={k}>{LEAD_NOTE_LABEL[k]}</option>)}
                          </Select>
                          <textarea autoFocus value={editText} onChange={(e) => setEditText(e.target.value.slice(0, 300))} rows={2} aria-label="Note" className="w-full text-xs rounded-md border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitEdit(it); if (e.key === 'Escape') setEditing(null); }} />
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}><X className="w-3.5 h-3.5" /> Cancel</Button>
                            <Button size="sm" variant="secondary" loading={update.isPending} onClick={() => commitEdit(it)}><Check className="w-3.5 h-3.5" /> Save</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start gap-1.5">
                            <span className="text-xs text-gray-800 whitespace-pre-wrap break-words flex-1 min-w-0">{it.text}</span>
                            {it.locked && <Lock className="w-3 h-3 mt-0.5 text-gray-400 flex-shrink-0" aria-label="Edited by a person: the AI will not change it" />}
                            {canWrite && (
                              <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 flex-shrink-0">
                                <button type="button" onClick={() => startEdit(it)} className="p-0.5 rounded text-gray-400 hover:text-gray-800" title="Edit" aria-label="Edit note"><Pencil className="w-3 h-3" /></button>
                                <button type="button" onClick={() => remove(it)} disabled={update.isPending} className="p-0.5 rounded text-gray-400 hover:text-red-600" title="Delete" aria-label="Delete note"><Trash2 className="w-3 h-3" /></button>
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-gray-400 mt-0.5">
                            {src ? (
                              <button type="button" onClick={() => jump(src)} disabled={!canJump} className={cn('inline-flex items-center gap-0.5', canJump ? 'hover:text-indigo-600 hover:underline' : 'cursor-default')} title={canJump ? 'Show the message this came from' : 'The source message is not in this conversation'}>
                                <CornerDownRight className="w-3 h-3" /> from {who === 'their' ? 'their' : `${who}'s`} message{date ? `, ${date}` : ''}
                              </button>
                            ) : (
                              <span>{it.locked ? 'added by a teammate' : 'noted by the AI'}{date ? `, ${date}` : ''}</span>
                            )}
                            {!!it.history?.length && <span title={it.history.map((h) => `${h.text}${h.at ? ` (${shortDate(h.at) ?? ''})` : ''}`).join('\n')}>· earlier: {it.history[it.history.length - 1]?.text}</span>}
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {adding ? (
            <div className="rounded-md border border-indigo-100 bg-indigo-50/40 px-2.5 py-2 space-y-1.5">
              <Select value={newKey} onChange={(e) => setNewKey(e.target.value as LeadNoteKey)} aria-label="Note kind" className="text-xs py-1">
                {LEAD_NOTE_KEYS.map((k) => <option key={k} value={k}>{LEAD_NOTE_LABEL[k]}</option>)}
              </Select>
              <textarea autoFocus value={newText} onChange={(e) => setNewText(e.target.value.slice(0, 300))} rows={2} placeholder="e.g. Budget around 2L for the first film" aria-label="New note" className="w-full text-xs rounded-md border border-gray-300 px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitAdd(); if (e.key === 'Escape') setAdding(false); }} />
              <div className="flex items-center justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewText(''); }}>Cancel</Button>
                <Button size="sm" loading={update.isPending} disabled={!newText.trim()} onClick={commitAdd}><Check className="w-3.5 h-3.5" /> Add</Button>
              </div>
            </div>
          ) : canWrite && (
            <button type="button" onClick={() => { setAdding(true); setEditing(null); }} disabled={items.length >= 20} className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1 disabled:opacity-50 disabled:no-underline" title={items.length >= 20 ? 'Up to 20 notes per lead' : undefined}>
              <Plus className="w-3 h-3" /> Add a note
            </button>
          )}
          {items.length > 0 && <p className="text-[11px] text-gray-400">Notes you edit are locked: the AI can add new ones but never changes them. Every draft uses these notes.</p>}
        </>
      )}
    </div>
  );
}
