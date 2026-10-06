'use client';

// Private-note composer (private-notes-PRD.md §4): amber box, "@" picker, formatting toolbar, attachments, Visible to
// client, Cmd/Ctrl+Enter to add. Used for new notes (draft kept per chat, restored on reload) and for editing one.
// The box shows formatted text (bold, italic, lists, links, mention chips); the note itself is still the markdown
// NoteBody renders — lib/outreach/noteRichText.ts converts both ways.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { chipHtml, noteHtmlToMarkdown, noteMarkdownToHtml } from '@/lib/outreach/noteRichText';
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

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function isMac() { return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform); }

/** the "@query" being typed right before the caret, if any (only inside plain text, never across a chip) */
function mentionQueryAtCaret(el: HTMLElement): { query: string } | null {
  const sel = window.getSelection();
  const node = sel?.focusNode;
  if (!sel || !sel.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null;
  const m = MENTION_QUERY_RE.exec((node as Text).data.slice(0, sel.focusOffset).replace(/ /g, ' '));
  return m ? { query: m[1] } : null;
}

function caretToEnd(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function selectionIn(el: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return el.contains(r.commonAncestorContainer) ? r : null;
}

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
  const [picker, setPicker] = useState<{ query: string } | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; range: Range | null } | null>(null);
  const [blank, setBlank] = useState(!text);
  // which formats apply at the caret / selection, so the toolbar buttons show on/off like a word processor
  const [active, setActive] = useState({ bold: false, italic: false, list: false });
  const editorRef = useRef<HTMLDivElement>(null);
  const lastMd = useRef<string | null>(null);   // markdown the editor DOM currently shows
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

  // text set from outside the editor (draft restore, Improve, Undo, cleared after submit) re-renders it; typing doesn't
  useIsoLayoutEffect(() => {
    const el = editorRef.current;
    if (!el || text === lastMd.current) return;
    el.innerHTML = noteMarkdownToHtml(text, picked);
    lastMd.current = text;
    setBlank(!text);
  }, [text]);
  useEffect(() => {
    const el = editorRef.current;
    if (!p.autoFocus || !el) return;
    el.focus();
    caretToEnd(el);
  }, [p.autoFocus]);
  useEffect(() => () => { for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** editor DOM → markdown state (+ the mention picker for whatever "@…" sits before the caret) */
  const refreshActive = () => {
    const el = editorRef.current;
    if (!el || !selectionIn(el)) { setActive((a) => (a.bold || a.italic || a.list ? { bold: false, italic: false, list: false } : a)); return; }
    const next = { bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'), list: document.queryCommandState('insertUnorderedList') };
    setActive((a) => (a.bold === next.bold && a.italic === next.italic && a.list === next.list ? a : next));
  };
  useEffect(() => {
    document.addEventListener('selectionchange', refreshActive);
    return () => document.removeEventListener('selectionchange', refreshActive);
  });

  const sync = () => {
    const el = editorRef.current; if (!el) return;
    const md = noteHtmlToMarkdown(el);
    lastMd.current = md;
    setText(md);
    setBlank(!el.textContent && !el.querySelector('li, [data-mention-id]'));
    setPicker(mentionQueryAtCaret(el));
    refreshActive();
  };

  // ------------------------------------------------------------------ mentions
  const pickMember = (m: Member) => {
    if (!picker) return;
    if (picked.length >= NOTE_MAX_MENTIONS && !picked.some((x) => x.user_id === m.user_id)) { p.onError(`Up to ${NOTE_MAX_MENTIONS} mentions per note.`); setPicker(null); return; }
    const el = editorRef.current;
    const sel = window.getSelection();
    const name = memberDisplayName(m);
    setPicked((list) => (list.some((x) => x.user_id === m.user_id) ? list : [...list, { name, user_id: m.user_id }]));
    setPicker(null);
    const node = sel?.focusNode;
    if (!el || !sel || !node || !el.contains(node)) return;
    // replace the typed "@query" with a chip + a space, caret after it
    const off = sel.focusOffset;
    const typed = `@${picker.query}`;
    const r = document.createRange();
    if (node.nodeType === Node.TEXT_NODE && off >= typed.length && (node as Text).data.slice(off - typed.length, off) === typed) { r.setStart(node, off - typed.length); r.setEnd(node, off); }
    else { r.setStart(node, off); r.collapse(true); }
    r.deleteContents();
    const tpl = document.createElement('template');
    tpl.innerHTML = chipHtml(name, m.user_id);
    const space = document.createTextNode(' ');
    const frag = document.createDocumentFragment();
    frag.append(tpl.content.firstChild!, space);
    r.insertNode(frag);
    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    sync();
  };
  const openPickerAtCaret = () => {
    const el = editorRef.current; if (!el) return;
    el.focus();
    if (!selectionIn(el)) caretToEnd(el);
    const sel = window.getSelection();
    const node = sel?.focusNode;
    const before = node?.nodeType === Node.TEXT_NODE ? (node as Text).data.slice(0, sel!.focusOffset) : '';
    document.execCommand('insertText', false, before && !/\s$/.test(before) ? ' @' : '@');
    sync();
  };

  // ------------------------------------------------------------------ formatting (word-processor style, on the selection)
  const format = (cmd: 'bold' | 'italic' | 'insertUnorderedList') => {
    const el = editorRef.current; if (!el) return;
    el.focus();
    if (!selectionIn(el)) caretToEnd(el);
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(cmd);
    sync();
  };
  const openLink = () => {
    const el = editorRef.current; if (!el) return;
    const r = selectionIn(el);
    const a = (r?.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r?.startContainer.parentElement)?.closest('a');
    setLink({ url: a && el.contains(a) ? a.getAttribute('href') ?? '' : '', range: r ? r.cloneRange() : null });
  };
  const applyLink = () => {
    const el = editorRef.current; if (!el || !link) return;
    el.focus();
    const sel = window.getSelection();
    if (link.range) { sel?.removeAllRanges(); sel?.addRange(link.range); } else caretToEnd(el);
    let url = link.url.trim();
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!url) document.execCommand('unlink');
    else if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(url)) { p.onError('Enter a web address, like https://example.com'); return; }
    else if (!link.range || link.range.collapsed) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      document.execCommand('insertHTML', false, a.outerHTML);
    } else document.execCommand('createLink', false, url);
    setLink(null);
    sync();
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
  const over = text.length > NOTE_MAX_CHARS;
  const canSubmit = (text.trim().length > 0 || ready.length > 0) && !uploading && !submitting && !over;
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body = encodeMentions(text.trim(), picked);
      await p.onSubmit(body, visibility, ready);
      if (!editing) { setDraft(''); setPicked([]); setFiles([]); setUndo(null); }
      editorRef.current?.focus();
    } catch (e) {
      p.onError(parseError(e).message);
    } finally { setSubmitting(false); }
  };

  const mod = isMac() ? '⌘' : 'Ctrl';
  const tool = 'p-1 rounded hover:bg-amber-100';
  const toggle = (on: boolean) => cn('p-1 rounded', on ? 'bg-amber-200 text-amber-950 ring-1 ring-amber-400' : 'hover:bg-amber-100');
  const keepSelection = (e: { preventDefault(): void }) => e.preventDefault();   // toolbar clicks must not steal the editor's selection

  return (
    <div className={cn('rounded-lg border p-2.5 space-y-1.5', 'border-amber-200 bg-[var(--note-bg)]')} data-note-composer>
      <div className="relative">
        <div
          ref={editorRef}
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label="Private note"
          spellCheck
          onInput={sync}
          onFocus={() => document.execCommand('defaultParagraphSeparator', false, 'div')}
          onKeyDown={(e) => {
            if (picker && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;   // the picker owns these
            const k = e.key.toLowerCase();
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); return; }
            if (e.key === 'Escape' && editing) { e.preventDefault(); p.onCancel?.(); return; }
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k === 'b') { e.preventDefault(); format('bold'); }
            else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k === 'i') { e.preventDefault(); format('italic'); }
            else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k === 'k') { e.preventDefault(); openLink(); }
            else if ((e.metaKey || e.ctrlKey) && k === 'u') e.preventDefault();   // notes have no underline
            else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && over) e.preventDefault();
          }}
          onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && editorRef.current) setPicker(mentionQueryAtCaret(editorRef.current)); }}
          onBlur={() => setTimeout(() => setPicker(null), 120)}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = Array.from(e.clipboardData?.files ?? []);
            if (pasted.length) { addFiles(pasted); return; }
            // pasted text comes in plain (no foreign fonts or colours); format it with the toolbar
            const t = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
            if (t) document.execCommand('insertText', false, t.slice(0, Math.max(0, NOTE_MAX_CHARS - text.length)));
          }}
          onDrop={(e) => { const dropped = Array.from(e.dataTransfer?.files ?? []); if (dropped.length) { e.preventDefault(); addFiles(dropped); } }}
          className={cn(
            'w-full text-base md:text-sm px-3 py-2 rounded-lg border border-amber-200 bg-white/70 resize-y overflow-y-auto max-h-[min(18rem,35vh)] whitespace-pre-wrap break-words [overflow-wrap:anywhere] focus:outline-none focus:ring-2 focus:ring-amber-400',
            '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_a]:text-sky-800 [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:rounded [&_code]:px-1 [&_code]:bg-black/[0.06]',
            editing ? 'min-h-[96px]' : 'min-h-[60px]',
          )}
        />
        {blank && (
          <div className="pointer-events-none absolute left-3 top-2 right-3 text-base md:text-sm text-amber-900/40 truncate" aria-hidden>
            Write a note for your team… type @ to mention someone ({mod}+Enter to add)
          </div>
        )}
        {picker && <MentionPicker members={readers} currentUserId={p.currentUserId} query={picker.query} onPick={pickMember} onClose={() => setPicker(null)} className="left-2 bottom-full mb-1" />}
        {link && (
          <div className="absolute z-30 left-2 bottom-full mb-1 w-80 max-w-[calc(100%-1rem)] rounded-lg border border-amber-200 bg-white shadow-lg p-2 flex items-center gap-1.5">
            <Link2 className="w-4 h-4 text-amber-700 shrink-0" />
            <input
              autoFocus
              value={link.url}
              onChange={(e) => setLink({ ...link, url: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
                else if (e.key === 'Escape') { e.preventDefault(); setLink(null); editorRef.current?.focus(); }
              }}
              placeholder="Paste a link, like https://example.com"
              aria-label="Link address"
              className="flex-1 min-w-0 text-sm px-2 py-1 rounded border border-gray-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <Button type="button" size="sm" onClick={applyLink} className="bg-amber-600 hover:bg-amber-700 focus:ring-amber-500">{link.url.trim() ? 'Apply' : 'Remove'}</Button>
            <button type="button" onClick={() => setLink(null)} className="p-1 text-gray-400 hover:text-gray-700" aria-label="Close"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
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
          <button type="button" onClick={() => fileRef.current?.click()} className={tool} title="Attach files (up to 10, 25 MB each)" aria-label="Attach"><Paperclip className="w-4 h-4" /></button>
          <button type="button" onMouseDown={keepSelection} onClick={() => format('bold')} className={toggle(active.bold)} aria-pressed={active.bold} title={`Bold (${mod}+B)`} aria-label="Bold"><Bold className="w-4 h-4" /></button>
          <button type="button" onMouseDown={keepSelection} onClick={() => format('italic')} className={toggle(active.italic)} aria-pressed={active.italic} title={`Italic (${mod}+I)`} aria-label="Italic"><Italic className="w-4 h-4" /></button>
          <button type="button" onMouseDown={keepSelection} onClick={() => format('insertUnorderedList')} className={toggle(active.list)} aria-pressed={active.list} title="Bullet list" aria-label="Bullet list"><List className="w-4 h-4" /></button>
          <button type="button" onMouseDown={keepSelection} onClick={openLink} className={tool} title={`Link (${mod}+K)`} aria-label="Link"><Link2 className="w-4 h-4" /></button>
          <button type="button" onMouseDown={keepSelection} onClick={openPickerAtCaret} className={tool} title="Mention a teammate" aria-label="Mention"><AtSign className="w-4 h-4" /></button>
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
