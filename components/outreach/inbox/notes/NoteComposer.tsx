'use client';

// Private-note composer (private-notes-PRD.md §4): amber box, "@" picker, markdown toolbar, attachments, Visible to
// client, Cmd/Ctrl+Enter to add. Used for new notes (draft kept per chat, restored on reload) and for editing one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bold, Italic, List, Link2, Lock, Paperclip, X, Loader2, Sparkles, Undo2, AtSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Chat, Member } from '@/lib/outreach/types';
import { Button } from '@/components/outreach/ui';
import { fmtBytes } from '../hooks';
import { parseError } from '@/lib/outreach/api';
import { useComposeAssist } from '@/lib/outreach/aiReplies';
import {
  NOTE_MAX_ATTACHMENTS, NOTE_MAX_ATTACHMENT_BYTES, NOTE_MAX_CHARS, NOTE_MAX_MENTIONS, encodeMentions, membersWhoCanRead, memberDisplayName, uploadNoteFile, useDraftText,
  type NoteAttachment, type NoteVisibility,
} from '@/lib/outreach/notes';
import MentionPicker from './MentionPicker';

export interface NoteComposerProps {
  chat: Chat;
  workspaceId: string;
  members: Member[] | undefined;
  currentUserId: string | null;
  isClientViewer: boolean;
  /** "Improve my text" (AI compose assist) is offered on LinkedIn chats, like the reply composer */
  canImprove: boolean;
  onSubmit: (body: string, visibility: NoteVisibility, attachments: NoteAttachment[]) => Promise<void>;
  onError: (msg: string) => void;
  /** edit mode: pre-filled text + picked mentions, no draft persistence, Cancel button */
  initial?: { text: string; picked: Array<{ name: string; user_id: string }>; visibility: NoteVisibility; attachments: NoteAttachment[] };
  onCancel?: () => void;
  submitLabel?: string;
  autoFocus?: boolean;
}

interface PendingFile { key: string; file: File; att: NoteAttachment | null; uploading: boolean; error: string | null; preview: string | null }

const MENTION_QUERY_RE = /(?:^|[\s(])@([^\s@]{0,40})$/;

function isMac() { return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform); }

export default function NoteComposer(p: NoteComposerProps) {
  const { chat, members } = p;
  const editing = !!p.initial;
  const [draft, setDraft] = useDraftText(chat.id, 'note');
  const [localText, setLocalText] = useState(p.initial?.text ?? '');
  const text = editing ? localText : draft;
  const setText = editing ? setLocalText : setDraft;
  const [picked, setPicked] = useState<Array<{ name: string; user_id: string }>>(p.initial?.picked ?? []);
  const [visibility, setVisibility] = useState<NoteVisibility>(p.isClientViewer ? 'team_and_client' : (p.initial?.visibility ?? 'team'));
  const [files, setFiles] = useState<PendingFile[]>(() => (p.initial?.attachments ?? []).map((a) => ({ key: a.path, file: new File([], a.name), att: a, uploading: false, error: null, preview: null })));
  const [submitting, setSubmitting] = useState(false);
  const [picker, setPicker] = useState<{ query: string; start: number } | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const assist = useComposeAssist();

  const shared = visibility === 'team_and_client';
  // people the picker offers = whoever can read a note with the current visibility on this chat (never the author)
  const readers = useMemo(() => membersWhoCanRead(members, chat.client_id, visibility), [members, chat.client_id, visibility]);
  const hasClientViewers = useMemo(() => !!chat.client_id && (members ?? []).some((m) => m.role === 'client_viewer' && m.client_ids.includes(chat.client_id!)), [members, chat.client_id]);
  // a mention typed by hand for someone outside the readers: shown as a warning, never notified
  const outsiders = useMemo(() => {
    const names = new Set(readers.map((m) => memberDisplayName(m).toLowerCase()));
    return (members ?? []).filter((m) => m.user_id !== p.currentUserId && !names.has(memberDisplayName(m).toLowerCase()) && new RegExp(`(^|[^\\w])@${memberDisplayName(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(text)).map(memberDisplayName);
  }, [members, readers, text, p.currentUserId]);

  useEffect(() => { if (p.autoFocus) textRef.current?.focus(); }, [p.autoFocus]);
  useEffect(() => () => { for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ mentions
  const onChange = (v: string) => {
    if (v.length > NOTE_MAX_CHARS) v = v.slice(0, NOTE_MAX_CHARS);
    setText(v);
    const caret = textRef.current?.selectionStart ?? v.length;
    const m = MENTION_QUERY_RE.exec(v.slice(0, caret));
    if (m) setPicker({ query: m[1], start: caret - m[1].length - 1 }); else setPicker(null);
  };
  const pickMember = useCallback((m: Member) => {
    if (!picker) return;
    if (picked.length >= NOTE_MAX_MENTIONS && !picked.some((x) => x.user_id === m.user_id)) { p.onError(`Up to ${NOTE_MAX_MENTIONS} mentions per note.`); setPicker(null); return; }
    const name = memberDisplayName(m);
    const caret = textRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, picker.start)}@${name} ${text.slice(caret)}`;
    setText(next);
    setPicked((list) => (list.some((x) => x.user_id === m.user_id) ? list : [...list, { name, user_id: m.user_id }]));
    setPicker(null);
    const pos = picker.start + name.length + 2;
    requestAnimationFrame(() => { textRef.current?.focus(); textRef.current?.setSelectionRange(pos, pos); });
  }, [picker, picked, text, setText, p]);
  const openPickerAtCaret = () => {
    const el = textRef.current; if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const next = `${before}${needsSpace ? ' ' : ''}@${text.slice(caret)}`;
    setText(next);
    const start = caret + (needsSpace ? 1 : 0);
    setPicker({ query: '', start });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + 1, start + 1); });
  };

  // ------------------------------------------------------------------ formatting
  const wrap = (before: string, after = before, placeholder = 'text') => {
    const el = textRef.current; if (!el) return;
    const s = el.selectionStart ?? 0, e = el.selectionEnd ?? 0;
    const sel = text.slice(s, e) || placeholder;
    const next = `${text.slice(0, s)}${before}${sel}${after}${text.slice(e)}`;
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + before.length, s + before.length + sel.length); });
  };
  const prefixLines = (prefix: string) => {
    const el = textRef.current; if (!el) return;
    const s = el.selectionStart ?? 0, e = el.selectionEnd ?? 0;
    const lineStart = text.lastIndexOf('\n', s - 1) + 1;
    const block = text.slice(lineStart, e);
    const done = block.split('\n').map((l) => (l.startsWith(prefix) ? l : `${prefix}${l}`)).join('\n');
    const next = `${text.slice(0, lineStart)}${done}${text.slice(e)}`;
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(lineStart, lineStart + done.length); });
  };
  const insertLink = () => {
    const el = textRef.current; if (!el) return;
    const s = el.selectionStart ?? 0, e = el.selectionEnd ?? 0;
    const sel = text.slice(s, e);
    const isUrl = /^https?:\/\//i.test(sel);
    const next = `${text.slice(0, s)}[${isUrl ? 'link' : sel || 'link'}](${isUrl ? sel : 'https://'})${text.slice(e)}`;
    setText(next);
    const caret = isUrl ? s + 1 : s + (sel || 'link').length + 3;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, isUrl ? caret + 4 : caret + 8); });
  };

  // ------------------------------------------------------------------ attachments (uploaded at once; the note references them by path)
  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const room = NOTE_MAX_ATTACHMENTS - files.length;
    if (incoming.length > room) p.onError(`Up to ${NOTE_MAX_ATTACHMENTS} files per note.`);
    const accepted = incoming.slice(0, Math.max(0, room)).filter((f) => { if (f.size > NOTE_MAX_ATTACHMENT_BYTES) { p.onError(`${f.name} is larger than 25 MB.`); return false; } return true; });
    if (!accepted.length) return;
    const rows: PendingFile[] = accepted.map((f) => ({ key: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`, file: f, att: null, uploading: true, error: null, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null }));
    setFiles((cur) => [...cur, ...rows]);
    for (const r of rows) {
      uploadNoteFile(chat.id, r.file)
        .then((att) => setFiles((cur) => cur.map((x) => (x.key === r.key ? { ...x, att, uploading: false } : x))))
        .catch((e) => setFiles((cur) => cur.map((x) => (x.key === r.key ? { ...x, uploading: false, error: parseError(e).message } : x))));
    }
    if (fileRef.current) fileRef.current.value = '';
  };
  const removeFile = (key: string) => setFiles((cur) => { const f = cur.find((x) => x.key === key); if (f?.preview) URL.revokeObjectURL(f.preview); return cur.filter((x) => x.key !== key); });

  // ------------------------------------------------------------------ improve (AI compose assist; a note is never checked against the prospect)
  const improve = async () => {
    const t = text.trim(); if (!t || assist.isPending) return;
    try {
      const r = await assist.mutateAsync({ chatId: chat.id, kind: 'improve', text: t });
      if (r.text && r.text !== t) { setUndo(text); setText(r.text); }
    } catch (e) { p.onError(parseError(e).message); }
  };

  // ------------------------------------------------------------------ submit
  const uploading = files.some((f) => f.uploading);
  const ready = files.filter((f) => f.att).map((f) => f.att!) as NoteAttachment[];
  const canSubmit = (text.trim().length > 0 || ready.length > 0) && !uploading && !submitting;
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body = encodeMentions(text.trim(), picked);
      await p.onSubmit(body, visibility, ready);
      if (!editing) { setDraft(''); setPicked([]); setFiles([]); setUndo(null); }
      textRef.current?.focus();
    } catch (e) {
      p.onError(parseError(e).message);
    } finally { setSubmitting(false); }
  };

  const mod = isMac() ? '⌘' : 'Ctrl';
  const over = text.length >= NOTE_MAX_CHARS;

  return (
    <div className={cn('rounded-lg border p-2.5 space-y-1.5', 'border-amber-200 bg-[var(--note-bg)]')} data-note-composer>
      <div className="relative">
        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (picker && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;   // the picker owns these
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); return; }
            if (e.key === 'Escape' && editing) { e.preventDefault(); p.onCancel?.(); return; }
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); }
            else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('_'); }
          }}
          onBlur={() => setTimeout(() => setPicker(null), 120)}
          onPaste={(e) => { const pasted = Array.from(e.clipboardData?.files ?? []); if (pasted.length) { e.preventDefault(); addFiles(pasted); } }}
          placeholder={`Write a note for your team… type @ to mention someone (${mod}+Enter to add)`}
          aria-label="Private note"
          rows={editing ? 4 : 2}
          maxLength={NOTE_MAX_CHARS}
          className="w-full text-base md:text-sm px-3 py-2 rounded-lg border border-amber-200 bg-white/70 resize-y min-h-[60px] max-h-[min(18rem,35vh)] placeholder:text-amber-900/40 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        {picker && <MentionPicker members={readers} currentUserId={p.currentUserId} query={picker.query} onPick={pickMember} onClose={() => setPicker(null)} className="left-2 bottom-full mb-1" />}
      </div>

      {outsiders.length > 0 && (
        <p className="text-[11px] text-amber-900/80">{outsiders.join(', ')} can&apos;t see this conversation — they won&apos;t be notified.</p>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f.key} className={cn('inline-flex items-center gap-1.5 text-xs pl-1 pr-2 py-1 rounded-md bg-white/80 border', f.error ? 'border-red-300 text-red-700' : 'border-amber-200 text-gray-700')} title={f.error ?? f.file.name}>
              {f.preview ? <img src={f.preview} alt="" className="w-9 h-9 rounded object-cover" /> : <Paperclip className="w-3 h-3 ml-1" />}
              <span className="truncate max-w-[160px]">{f.file.name}</span>
              {f.uploading ? <Loader2 className="w-3 h-3 animate-spin text-amber-600" /> : f.file.size > 0 ? <span className="text-gray-400">{fmtBytes(f.file.size)}</span> : null}
              <button type="button" onClick={() => removeFile(f.key)} className="text-gray-400 hover:text-red-600" aria-label={`Remove ${f.file.name}`}><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 text-amber-900">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium pr-1"><Lock className="w-3.5 h-3.5" /> {shared ? 'Your team and the client see this' : 'Only your team sees this'}</span>
          {hasClientViewers && (
            <label className={cn('inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-amber-200 bg-white/70', p.isClientViewer ? 'opacity-70' : 'cursor-pointer')} title={p.isClientViewer ? 'Notes written by a client viewer are always shared with the client' : 'Client viewers of this client can read the note too'}>
              <input type="checkbox" className="accent-amber-600" checked={shared} disabled={p.isClientViewer} onChange={(e) => setVisibility(e.target.checked ? 'team_and_client' : 'team')} /> Visible to client
            </label>
          )}
          <span className="w-px h-4 bg-amber-200 mx-1" aria-hidden />
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} aria-label="Attach files to the note" />
          <button type="button" onClick={() => fileRef.current?.click()} className="p-1 rounded hover:bg-amber-100" title="Attach files (up to 10, 25 MB each)" aria-label="Attach"><Paperclip className="w-4 h-4" /></button>
          <button type="button" onClick={() => wrap('**')} className="p-1 rounded hover:bg-amber-100" title={`Bold (${mod}+B)`} aria-label="Bold"><Bold className="w-4 h-4" /></button>
          <button type="button" onClick={() => wrap('_')} className="p-1 rounded hover:bg-amber-100" title={`Italic (${mod}+I)`} aria-label="Italic"><Italic className="w-4 h-4" /></button>
          <button type="button" onClick={() => prefixLines('- ')} className="p-1 rounded hover:bg-amber-100" title="Bullet list" aria-label="Bullet list"><List className="w-4 h-4" /></button>
          <button type="button" onClick={insertLink} className="p-1 rounded hover:bg-amber-100" title="Link" aria-label="Link"><Link2 className="w-4 h-4" /></button>
          <button type="button" onClick={openPickerAtCaret} className="p-1 rounded hover:bg-amber-100" title="Mention a teammate" aria-label="Mention"><AtSign className="w-4 h-4" /></button>
          {p.canImprove && (
            <>
              <span className="w-px h-4 bg-amber-200 mx-1" aria-hidden />
              <button type="button" onClick={improve} disabled={!text.trim() || assist.isPending} className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded hover:bg-amber-100 disabled:opacity-50" title="Tidy the wording of this note (AI). Nothing is checked against the prospect.">
                {assist.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Improve my text
              </button>
              {undo !== null && <button type="button" onClick={() => { setText(undo); setUndo(null); }} className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded hover:bg-amber-100" title="Restore your wording"><Undo2 className="w-3.5 h-3.5" /> Undo</button>}
            </>
          )}
          <span className={cn('text-[11px] tabular-nums ml-1', over ? 'text-red-600 font-medium' : 'text-amber-900/50')}>{text.length.toLocaleString()}/{NOTE_MAX_CHARS.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2">
          {editing && <Button type="button" variant="ghost" size="sm" onClick={p.onCancel}>Cancel</Button>}
          <Button type="button" size="sm" loading={submitting} disabled={!canSubmit} onClick={submit} className="bg-amber-600 hover:bg-amber-700 focus:ring-amber-500" title={`${p.submitLabel ?? 'Add note'} (${mod}+Enter)`}>
            <Lock className="w-4 h-4" /> {p.submitLabel ?? 'Add note'}
          </Button>
        </div>
      </div>
    </div>
  );
}
