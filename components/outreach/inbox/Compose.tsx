'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, Send, X, Lock, CalendarCheck, Smile } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk, useMessages } from '@/lib/outreach/queries';
import type { Chat, Message, Sender } from '@/lib/outreach/types';
import { Button } from '@/components/outreach/ui';
import { fmtBytes } from './hooks';
import { isMailProvider, messageMaxLength } from '@/lib/outreach/channels';
import { aiqk } from '@/lib/outreach/aiReplies';
import AiComposerPanel, { AiComposerActions, AiDraftMeta, AssistWarnings, useDraftWithAi, type AssistUndo } from './ai/AiComposerPanel';
import { useComposerAi } from './ai/useAiInbox';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

export interface ComposeProps {
  chat: Chat;
  sender: Sender | null;
  workspaceId: string;
  disabledReason: string | null;
  onError: (msg: string) => void;
  onSent?: () => void;
  /** WhatsApp reply: the message this one quotes, shown above the box until sent or cancelled. */
  replyTo?: Message | null;
  replyToName?: string;
  onCancelReply?: () => void;
}

const EMOJIS = ['😀', '😂', '😊', '😍', '🙂', '😉', '😎', '🤔', '😅', '🙏', '👍', '👏', '🙌', '💪', '🤝', '👋', '❤️', '🔥', '🎉', '✅', '💯', '⭐', '📌', '📅', '📞', '💼', '🚀', '😢', '😮', '👀'];

/** Local preview URL of an image picked for sending. */
function useObjectUrl(file: File): string | null {
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const preview = useObjectUrl(file);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs pl-1 pr-2 py-1 rounded-md bg-gray-100 text-gray-700">
      {preview ? <img src={preview} alt="" className="w-10 h-10 rounded object-cover" /> : <Paperclip className="w-3 h-3 ml-1" />}
      <span className="truncate max-w-[160px]">{file.name}</span>
      <span className="text-gray-400">{fmtBytes(file.size)}</span>
      <button type="button" onClick={onRemove} className="text-gray-400 hover:text-red-600" aria-label={`Remove ${file.name}`}><X className="w-3 h-3" /></button>
    </span>
  );
}

function safeName(name: string) { return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file'; }

/** The prospect's language from the latest classified received message ("hi", "fr"); null when unknown. */
function prospectLanguageOf(list: Message[] | undefined): string | null {
  for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
    const m = list![i];
    if (m.direction !== 'in') continue;
    const lang = (m.classification as { language?: string } | null)?.language;
    if (lang && /^[a-z]{2,3}$/i.test(lang)) return lang.toLowerCase();
  }
  return null;
}

function defaultSubject(chat: Chat): string {
  if (!chat.subject) return '';
  return /^re:/i.test(chat.subject.trim()) ? chat.subject : `Re: ${chat.subject}`;
}

/** Item 24. The line outreach-send-reply uses when `booking: true` arrives without text. It appends the tracked link itself. */
const BOOKING_DEFAULT_TEXT = 'Here is my calendar, pick any time that suits you:';
function bookingTitle(typed: string): string {
  return typed ? 'Sends your text with the booking link added below it' : `Sends: “${BOOKING_DEFAULT_TEXT}” followed by the booking link`;
}

export default function Compose({ chat, sender, workspaceId, disabledReason, onError, onSent, replyTo, replyToName, onCancelReply }: ComposeProps) {
  const qc = useQueryClient();
  const isEmail = isMailProvider(chat.provider);
  // Instagram direct messages stop at 1000 characters, WhatsApp at 4096; LinkedIn and email are not limited here.
  const maxLength = messageMaxLength(chat.provider);
  const [text, setText] = useState('');
  // AI replies: pre-fills the AI draft and remembers which run the text came from (sent as `ai_run_id`).
  const ai = useComposerAi(chat.id, text, setText);
  // Draft with AI (draft_now) for this chat, plus the Improve / Translate undo state.
  const draft = useDraftWithAi(ai, chat.id, onError);
  const [undo, setUndo] = useState<AssistUndo | null>(null);
  // the prospect's language (for the Translate menu): the latest received message's classification, from the thread already loaded
  const messagesQ = useMessages(chat.id);
  const prospectLanguage = prospectLanguageOf(messagesQ.data);
  // AI replies are LinkedIn only: the AI buttons stay hidden on other channels
  const aiChannel = chat.provider === 'LINKEDIN';
  const [subject, setSubject] = useState(() => defaultSubject(chat));
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [sendingBooking, setSendingBooking] = useState(false);
  const bookingLink = ((sender as (Sender & { booking_link?: string | null }) | null)?.booking_link ?? '').trim() || null;
  const interested = chat.intent === 'interested';
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const wa = chat.provider === 'WHATSAPP';
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (replyTo) textRef.current?.focus(); }, [replyTo]);
  useEffect(() => {
    if (!emojiOpen) return;
    const close = (e: MouseEvent) => { if (!emojiRef.current?.contains(e.target as Node)) setEmojiOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [emojiOpen]);
  const insertEmoji = (e: string) => {
    const el = textRef.current;
    const start = el?.selectionStart ?? text.length, end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + e + text.slice(end);
    if (maxLength && next.length > maxLength) return;
    setText(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + e.length, start + e.length); });
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > MAX_ATTACHMENT_BYTES) { onError(`${f.name} is larger than 20 MB.`); continue; }
      if (next.length >= MAX_ATTACHMENTS) { onError(`Up to ${MAX_ATTACHMENTS} attachments per message.`); break; }
      next.push(f);
    }
    setFiles(next);
    if (fileRef.current) fileRef.current.value = '';
  };

  const send = async (booking = false) => {
    if (sending || sendingBooking || disabledReason) return;
    if (booking && !bookingLink) return;
    // Booking: outreach-send-reply appends the sender's booking link (with the lead id for the booking webhook) to the text,
    // or to a short default line when the composer is empty. The link is therefore never typed into `text` here.
    const typed = text.trim();
    if (!booking && !typed && !files.length) return;
    const body = booking ? [typed || BOOKING_DEFAULT_TEXT, '', bookingLink].join('\n') : typed;   // what the optimistic bubble shows
    // the AI already sent its own version of what is in the box: a second message needs an explicit yes
    if (ai.aiSent && !window.confirm('The AI already sent its version of this reply. Send yours as well?')) return;
    ai.clearAiSent();
    const aiRunId = ai.runIdForSend();   // only when the text started as that run's draft (edited or not)
    if (booking) setSendingBooking(true); else setSending(true);
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId, workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: null, direction: 'out', text: body, html: null,
      attachments: files.map((f, i) => ({ id: `${tempId}-${i}`, name: f.name, type: f.type, size: f.size })),
      sent_at: new Date().toISOString(), is_invite_note: false, intent: null, intent_confidence: null, summary: null, classified_at: null,
      opens: 0, clicks: 0, edited_at: null, deleted_at: null, action_id: null, created_at: new Date().toISOString(),
      quoted: replyTo ? { unipile_message_id: replyTo.unipile_message_id, text: replyTo.text, sender_name: replyToName ?? null } : null,
    } as Message;
    const key = qk.messages(chat.id);
    qc.setQueryData<Message[]>(key, (old) => [...(old ?? []), optimistic]);
    try {
      const paths: string[] = [];
      for (const f of files) {
        const path = `${workspaceId}/${chat.id}/${Date.now()}-${safeName(f.name)}`;
        const { error } = await supabase.storage.from('outreach-attachments').upload(path, f, { contentType: f.type || undefined, upsert: false });
        if (error) throw new Error(`Upload failed for ${f.name}: ${error.message}`);
        paths.push(path);
      }
      const payload: Record<string, unknown> = { chat_id: chat.id, text: booking ? typed : body };
      if (paths.length) payload.attachments = paths;
      if (isEmail && subject.trim()) payload.subject = subject.trim();
      if (booking) payload.booking = true;
      if (replyTo) payload.quote_message_id = replyTo.id;
      if (aiRunId) payload.ai_run_id = aiRunId;
      await callFn('send-reply', payload);
      setText('');
      ai.dropTag();
      setUndo(null);
      setFiles([]);
      onCancelReply?.();
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['outreach', workspaceId, 'chats'] });
      if (aiRunId) qc.invalidateQueries({ queryKey: aiqk.chatState(chat.id) });
      onSent?.();
      textRef.current?.focus();
    } catch (e) {
      qc.setQueryData<Message[]>(key, (old) => (old ?? []).filter((m) => m.id !== tempId));
      onError(parseError(e).message);
    } finally {
      setSending(false);
      setSendingBooking(false);
    }
  };

  if (disabledReason) {
    return (
      <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 space-y-2">
        <AiComposerPanel ai={ai} chat={chat} canCompose={false} onError={onError} />
        <div className="text-sm text-gray-600 flex items-start gap-2">
          <Lock className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" />
          <span>{disabledReason}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 bg-white p-3 space-y-2">
      <AiComposerPanel ai={ai} chat={chat} canCompose onError={onError} onRegenerate={aiChannel ? () => { void draft.request({ regenerate: true }); } : undefined} regenerating={draft.busy} />
      {bookingLink && interested && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <CalendarCheck className="w-4 h-4 text-green-700 flex-shrink-0" />
          <div className="min-w-0 flex-1 text-xs text-green-900">
            <span className="font-medium">This lead is interested.</span> Send {sender?.display_name ? `${sender.display_name}'s` : 'the'} booking link in one click{text.trim() ? ', together with the text below' : ''}.
          </div>
          <Button type="button" size="sm" className="bg-green-600 hover:bg-green-700" loading={sendingBooking} disabled={sending} onClick={() => send(true)} title={bookingTitle(text.trim())}><CalendarCheck className="w-4 h-4" /> Send booking link</Button>
        </div>
      )}
      {isEmail && (
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Email subject" className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      )}
      {replyTo && (
        <div className="flex items-start gap-2 rounded-md bg-gray-50 border-l-4 border-emerald-500 px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-emerald-700 truncate">Replying to {replyToName ?? 'message'}</div>
            <div className="text-xs text-gray-600 line-clamp-2 whitespace-pre-wrap">{replyTo.text?.trim() || (replyTo.attachments?.length ? '📎 Attachment' : 'Message')}</div>
          </div>
          <button type="button" onClick={onCancelReply} className="p-0.5 text-gray-400 hover:text-gray-700" aria-label="Cancel reply"><X className="w-4 h-4" /></button>
        </div>
      )}
      <AiDraftMeta ai={ai} draft={draft} chat={chat} text={text} onError={onError} canCompose={aiChannel} />
      <textarea
        ref={textRef}
        value={text}
        onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) { ai.dropTag(); setUndo(null); } }}
        onKeyDown={(e) => {
          // WhatsApp: Enter sends, Shift+Enter adds a line (like the app). Everywhere: Ctrl/Cmd+Enter sends; Escape drops the reply.
          if (e.key === 'Escape' && replyTo) { onCancelReply?.(); return; }
          if (((e.metaKey || e.ctrlKey) && e.key === 'Enter') || (wa && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) { e.preventDefault(); send(false); }
        }}
        onPaste={(e) => { const pasted = Array.from(e.clipboardData?.files ?? []); if (pasted.length) { e.preventDefault(); const dt = new DataTransfer(); pasted.forEach((f) => dt.items.add(f)); addFiles(dt.files); } }}
        placeholder={wa ? `Type a message as ${sender?.display_name ?? 'sender'} (Enter to send, Shift+Enter for a new line)` : `Reply as ${sender?.display_name ?? 'sender'}… (${typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter to send)`}
        aria-label="Reply"
        maxLength={maxLength}
        rows={3}
        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 resize-y min-h-[72px] max-h-64 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f, i) => <FileChip key={`${f.name}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />)}
        </div>
      )}
      {aiChannel && (
        <div className="flex flex-wrap items-center gap-1.5">
          <AiComposerActions ai={ai} draft={draft} chatId={chat.id} text={text} setText={setText} prospectLanguage={prospectLanguage} disabled={sending || sendingBooking} onError={onError} undo={undo} setUndo={setUndo} />
        </div>
      )}
      {aiChannel && <AssistWarnings undo={undo} />}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} aria-label="Attach files" />
          {!isEmail && (
            <div className="relative" ref={emojiRef}>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEmojiOpen((v) => !v)} title="Emoji" aria-label="Emoji"><Smile className="w-4 h-4" /></Button>
              {emojiOpen && (
                <div className="absolute bottom-full mb-1 left-0 z-20 w-64 grid grid-cols-8 gap-0.5 rounded-lg bg-white border border-gray-200 shadow-lg p-1.5" role="menu">
                  {EMOJIS.map((e) => <button key={e} type="button" role="menuitem" onClick={() => insertEmoji(e)} className="text-lg leading-none p-1 rounded hover:bg-gray-100" aria-label={e}>{e}</button>)}
                </div>
              )}
            </div>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()} title="Attach files"><Paperclip className="w-4 h-4" /> Attach</Button>
          <span className="text-[11px] text-gray-400 hidden sm:inline">Replies don't count against outbound caps.</span>
          {maxLength && <span className={`text-[11px] tabular-nums ${text.length >= maxLength ? 'text-red-600 font-medium' : 'text-gray-400'}`}>{text.length}/{maxLength}</span>}
        </div>
        <div className="flex items-center gap-2">
          {bookingLink && !interested && (
            <Button type="button" variant="secondary" size="sm" loading={sendingBooking} disabled={sending} onClick={() => send(true)} title={bookingTitle(text.trim())}><CalendarCheck className="w-4 h-4" /> Send booking link</Button>
          )}
          <Button type="button" size="sm" loading={sending} disabled={(!text.trim() && !files.length) || sendingBooking} onClick={() => send(false)} title="Send reply"><Send className="w-4 h-4" /> Send</Button>
        </div>
      </div>
    </div>
  );
}
