'use client';

// A private note in the conversation timeline (private-notes-PRD.md §5): amber card, 🔒 label, author, time, Visible to
// client tag, mention chips, attachments, Seen by, edit / delete / make task / copy link / visibility menu, deleted
// placeholder, revision history for the author and managers. System / AI notes get a grey tint.
import { modeHref } from '@/lib/outreach/mode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, MoreHorizontal, Pencil, Trash2, CheckSquare, Link2, Eye, EyeOff, History, Paperclip, Download, Bot, Cog, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Chat, Member } from '@/lib/outreach/types';
import { Avatar, Modal, fmtDate } from '@/components/outreach/ui';
import { fmtBytes } from '../hooks';
import { decodeMentions, noteLink, useNoteFileUrl, useNoteRevisions, type ChatNote, type NoteAttachment, type NoteVisibility } from '@/lib/outreach/notes';
import NoteBody from './NoteBody';
import NoteComposer from './NoteComposer';

export interface NoteBubbleProps {
  note: ChatNote;
  chat: Chat;
  workspaceId: string;
  members: Member[] | undefined;
  currentUserId: string | null;
  isManager: boolean;
  isClientViewer: boolean;
  canImprove: boolean;
  highlight: boolean;
  onUpdate: (noteId: string, patch: { body?: string; visibility?: NoteVisibility }) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
  onMakeTask: (note: ChatNote) => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}

function clockTime(iso: string): string { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }

function AttachmentChip({ noteId, att }: { noteId: string; att: NoteAttachment }) {
  const isImage = !!att.mime && att.mime.startsWith('image/');
  const { url, loading, error, load } = useNoteFileUrl(noteId, att.path, isImage);
  if (isImage) {
    return (
      <a href={url ?? undefined} target="_blank" rel="noopener noreferrer" onClick={(e) => { if (!url) { e.preventDefault(); void load(); } }}
        className="block rounded-md overflow-hidden border border-amber-200 bg-white/60 max-w-[240px]" title={att.name}>
        {url ? <img src={url} alt={att.name} className="max-h-48 w-auto object-contain" style={att.width && att.height ? { aspectRatio: `${att.width}/${att.height}` } : undefined} />
          : <div className="h-24 w-40 flex items-center justify-center text-xs text-amber-900/60">{error ? 'Could not load' : <Loader2 className="w-4 h-4 animate-spin" />}</div>}
      </a>
    );
  }
  return (
    <button type="button" onClick={async () => { const u = url ?? (await (async () => { await load(); return null; })()); if (u) window.open(u, '_blank', 'noopener'); }}
      className="inline-flex items-center gap-1.5 text-xs pl-1.5 pr-2 py-1 rounded-md bg-white/80 border border-amber-200 text-gray-700 hover:bg-white" title={att.name}>
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : url ? <Download className="w-3 h-3 text-amber-700" /> : <Paperclip className="w-3 h-3 text-amber-700" />}
      <span className="truncate max-w-[180px]">{att.name}</span>
      {att.size ? <span className="text-gray-400">{fmtBytes(att.size)}</span> : null}
      {url && <a href={url} target="_blank" rel="noopener noreferrer" className="sr-only">Open {att.name}</a>}
    </button>
  );
}

function RevisionsModal({ note, open, onClose }: { note: ChatNote; open: boolean; onClose: () => void }) {
  const q = useNoteRevisions(open ? note.id : null);
  return (
    <Modal open={open} onClose={onClose} title="Edit history" size="md">
      {q.isLoading && <div className="text-sm text-gray-500">Loading…</div>}
      {q.error && <div className="text-sm text-red-600">Could not load the history.</div>}
      <ol className="space-y-3">
        {q.data?.map((r) => (
          <li key={r.revision} className="rounded-md border border-gray-200 p-3">
            <div className="text-[11px] text-gray-500 mb-1">Version {r.revision} · {r.edited_by} replaced this on {fmtDate(r.edited_at)}</div>
            <NoteBody text={r.body} />
          </li>
        ))}
        {q.data && (
          <li className="rounded-md border border-amber-200 bg-amber-50 p-3">
            <div className="text-[11px] text-amber-900 mb-1">Current{note.edited_at ? ` · edited ${fmtDate(note.edited_at)}` : ''}</div>
            {note.body && <NoteBody text={note.body} />}
          </li>
        )}
      </ol>
    </Modal>
  );
}

export default function NoteBubble(p: NoteBubbleProps) {
  const { note, chat } = p;
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const system = note.author.type === 'ai' || note.author.type === 'system';
  const isAuthor = !!p.currentUserId && note.author.id === p.currentUserId && (note.author.type === 'user' || note.author.type === 'agent');
  const canEdit = isAuthor && !note.deleted_at;
  const canDelete = (isAuthor || p.isManager) && !note.deleted_at;
  const canChangeVisibility = (isAuthor || p.isManager) && !note.deleted_at && !(p.isClientViewer && note.visibility === 'team_and_client');
  const canSeeHistory = (isAuthor || p.isManager) && note.revisions > 0 && !note.deleted_at;
  const noAccess = useMemo(() => new Set(note.mentions.filter((m) => !m.access).map((m) => m.user_id)), [note.mentions]);
  const seen = note.mentions.filter((m) => m.read_at);
  const unseen = note.mentions.filter((m) => !m.read_at && m.access);
  // The menu is portalled with fixed positioning so the timeline's scroll container can't clip it; it opens upward
  // when the note sits near the bottom of the viewport, and closes on scroll / resize instead of drifting.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
  const openMenu = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const right = window.innerWidth - r.right;
    setMenuPos(window.innerHeight - r.bottom < 260 && r.top > window.innerHeight - r.bottom ? { right, bottom: window.innerHeight - r.top + 4 } : { right, top: r.bottom + 4 });
    setMenu(true);
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('keydown', close); window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);

  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); try { await fn(); } catch (e) { p.onError((e as Error)?.message ?? 'Something went wrong'); } finally { setBusy(null); } };
  const copyLink = async () => {
    const url = `${window.location.origin}${modeHref(noteLink(chat.id, note.id))}`;
    try { await navigator.clipboard.writeText(url); p.onNotice('Link copied'); } catch { p.onError('Could not copy the link'); }
  };

  if (note.deleted_at) {
    return (
      <div id={`note-${note.id}`} className={cn('ml-auto max-w-[85%] md:max-w-[75%] rounded-xl border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-500 italic', p.highlight && 'ring-2 ring-amber-400')}>
        <Lock className="inline w-3 h-3 mr-1 -mt-0.5" /> Note deleted by {note.deleted_by ?? 'a teammate'} · {clockTime(note.deleted_at)}
      </div>
    );
  }

  if (editing && note.body) {
    const init = decodeMentions(note.body);
    return (
      <div id={`note-${note.id}`} className="ml-auto w-full max-w-[85%] md:max-w-[75%]">
        <NoteComposer
          chat={chat} workspaceId={p.workspaceId} members={p.members} currentUserId={p.currentUserId} isClientViewer={p.isClientViewer} canImprove={p.canImprove}
          initial={{ text: init.text, picked: init.picked, visibility: note.visibility, attachments: note.attachments }}
          submitLabel="Save" autoFocus onCancel={() => setEditing(false)} onError={p.onError}
          onSubmit={async (body, visibility) => { await p.onUpdate(note.id, { body, visibility: visibility !== note.visibility ? visibility : undefined }); setEditing(false); }}
        />
      </div>
    );
  }

  return (
    <div id={`note-${note.id}`} className={cn('group ml-auto w-full max-w-[85%] md:max-w-[75%] rounded-xl border px-3.5 py-2.5 transition-shadow',
      system ? 'border-gray-200 bg-gray-100/80' : 'border-amber-200 bg-[var(--note-bg)]', p.highlight && 'ring-2 ring-amber-400 shadow-md')}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('inline-flex items-center gap-1 text-[11px] font-semibold', system ? 'text-gray-600' : 'text-amber-900')}>
          <Lock className="w-3 h-3" /> Private note
        </span>
        <span className="text-[11px] text-gray-400">·</span>
        {system ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-gray-600">{note.author.type === 'ai' ? <Bot className="w-3 h-3" /> : <Cog className="w-3 h-3" />}{note.author.name}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-gray-700 min-w-0"><Avatar name={note.author.name} size={4} /><span className={cn('truncate', note.author.former && 'italic text-gray-500')}>{note.author.name}</span></span>
        )}
        <span className="text-[11px] text-gray-400">·</span>
        <time className="text-[11px] text-gray-500" dateTime={note.created_at} title={fmtDate(note.created_at)}>{clockTime(note.created_at)}</time>
        {note.visibility === 'team_and_client' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/80 border border-amber-200 text-amber-900" title="Client viewers of this client can read this note">Visible to client</span>}
        {note.exclude_from_ai && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/80 border border-amber-200 text-amber-900" title="Starts with #no-ai: the AI reply engine does not read it">Hidden from AI</span>}
        <span className="flex-1" />
        {(canEdit || canDelete || canChangeVisibility || canSeeHistory || !system) && (
          <div className="relative">
            <button ref={triggerRef} type="button" onClick={() => (menu ? setMenu(false) : openMenu())} className={cn('p-1 rounded text-gray-500 hover:bg-amber-100 hover:text-gray-800', menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100')} aria-label="Note actions" aria-haspopup="menu" aria-expanded={menu}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MoreHorizontal className="w-4 h-4" />}
            </button>
            {menu && menuPos && typeof document !== 'undefined' && createPortal(
              <>
                <div className="fixed inset-0 z-[60]" onClick={() => setMenu(false)} />
                <div role="menu" style={{ position: 'fixed', ...menuPos }} className="z-[70] min-w-[190px] bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm">
                  {canEdit && <button type="button" role="menuitem" onClick={() => { setMenu(false); setEditing(true); }} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-gray-700"><Pencil className="w-4 h-4 text-gray-400" /> Edit</button>}
                  {chat.lead_id && <button type="button" role="menuitem" onClick={() => { setMenu(false); p.onMakeTask(note); }} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-gray-700"><CheckSquare className="w-4 h-4 text-gray-400" /> Make task</button>}
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); void copyLink(); }} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-gray-700"><Link2 className="w-4 h-4 text-gray-400" /> Copy link</button>
                  {canChangeVisibility && (
                    <button type="button" role="menuitem" onClick={() => { setMenu(false); void run('vis', () => p.onUpdate(note.id, { visibility: note.visibility === 'team' ? 'team_and_client' : 'team' })); }} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-gray-700">
                      {note.visibility === 'team' ? <Eye className="w-4 h-4 text-gray-400" /> : <EyeOff className="w-4 h-4 text-gray-400" />} {note.visibility === 'team' ? 'Make visible to client' : 'Hide from client'}
                    </button>
                  )}
                  {canSeeHistory && <button type="button" role="menuitem" onClick={() => { setMenu(false); setHistory(true); }} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-gray-700"><History className="w-4 h-4 text-gray-400" /> Edit history ({note.revisions})</button>}
                  {canDelete && <button type="button" role="menuitem" onClick={() => { setMenu(false); if (window.confirm('Delete this note? Teammates will see that it was deleted.')) void run('del', () => p.onDelete(note.id)); }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 flex items-center gap-2 text-red-700"><Trash2 className="w-4 h-4" /> Delete</button>}
                </div>
              </>,
              document.body,
            )}
          </div>
        )}
      </div>

      {note.body && <NoteBody text={note.body} currentUserId={p.currentUserId} noAccess={noAccess} className="mt-1.5" />}

      {note.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {note.attachments.map((a) => <AttachmentChip key={a.path} noteId={note.id} att={a} />)}
        </div>
      )}

      {(note.mentions.length > 0 || note.edited_at) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
          {note.mentions.length > 0 && (
            <span title={[...seen.map((m) => `${m.name} · ${fmtDate(m.read_at)}`), ...unseen.map((m) => `${m.name} · not seen yet`)].join('\n')}>
              {seen.length > 0 ? `Seen by ${seen.map((m) => m.name).join(', ')}${seen.length === 1 && seen[0].read_at ? ` · ${clockTime(seen[0].read_at)}` : ''}` : 'Not seen yet'}
              {seen.length > 0 && unseen.length > 0 ? ` · ${unseen.map((m) => m.name).join(', ')} not yet` : ''}
            </span>
          )}
          {note.edited_at && <span className={cn(canSeeHistory && 'cursor-pointer underline decoration-dotted')} onClick={() => { if (canSeeHistory) setHistory(true); }} title={canSeeHistory ? 'Show the edit history' : `Edited ${fmtDate(note.edited_at)}`}>edited</span>}
        </div>
      )}
      {history && <RevisionsModal note={note} open={history} onClose={() => setHistory(false)} />}
    </div>
  );
}
