'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, Send, X, Lock, CalendarCheck, Smile, MessageSquare, ShoppingBag, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { db } from '@/lib/outreach/backend';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { qk, useMessages } from '@/lib/outreach/queries';
import { useAgentTyping, useCannedResponses } from '@/lib/outreach/webchat';
import type { Chat, Member, Message, Sender } from '@/lib/outreach/types';
import { Button } from '@/components/outreach/ui';
import { useDraftText, type NoteAttachment, type NoteVisibility } from '@/lib/outreach/notes';
import NoteComposer from './notes/NoteComposer';
import { fmtBytes } from './hooks';
import { isMailProvider, messageMaxLength } from '@/lib/outreach/channels';
import { aiqk } from '@/lib/outreach/aiReplies';
import AiComposerPanel, { AiComposerActions, AiDraftNotes, AiDraftSummary, AssistWarnings, useDraftWithAi, type AssistUndo } from './ai/AiComposerPanel';
import { useComposerAi } from './ai/useAiInbox';
import { useComposerSuggestion, WebchatSuggestionBar } from './webchat/WebchatSuggestion';
import ProductPicker from './webchat/ProductPicker';
import { sendProducts } from '@/lib/outreach/catalogue';
import { hk } from '@/lib/outreach/aiHub';
import AddressField, { isEmailAddress } from './channels/AddressField';
import { senderEmail } from './channels/look';

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
  /** Email "Reply" / "Reply all" from the thread: opens the reply with these Cc addresses (`n` changes on every click). */
  mailReply?: { cc: string[]; n: number } | null;
  /** Private notes (private-notes-PRD §4): the second composer mode. Reply and note keep separate drafts. */
  mode: 'reply' | 'note';
  onModeChange: (mode: 'reply' | 'note') => void;
  members: Member[] | undefined;
  currentUserId: string | null;
  isClientViewer: boolean;
  onAddNote: (body: string, visibility: NoteVisibility, attachments: NoteAttachment[]) => Promise<void>;
  /** a squeezed thread column: toolbar buttons drop their labels and the hints move into titles */
  compact?: boolean;
  /** a wide thread column: the secondary AI buttons (Improve, Translate) show their labels too */
  wide?: boolean;
}

/** The reply box starts at a few lines and grows with the text up to its CSS max-height (then it scrolls). */
function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, mounted: unknown) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [ref, value, mounted]);   // `mounted`: the box only exists in Reply mode, so measure again when it comes back
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

export default function Compose({ chat, sender, workspaceId, disabledReason, onError, onSent, replyTo, replyToName, onCancelReply, mailReply, mode, onModeChange, members, currentUserId, isClientViewer, onAddNote, compact = false, wide = false }: ComposeProps) {
  const qc = useQueryClient();
  const isEmail = isMailProvider(chat.provider);
  // Instagram direct messages stop at 1000 characters, WhatsApp at 4096; LinkedIn and email are not limited here.
  const maxLength = messageMaxLength(chat.provider);
  // the reply draft is remembered per chat (and restored on reload), separately from the note draft
  const [text, setTextRaw] = useDraftText(chat.id, 'reply');
  // web chat: the visitor sees "… is typing" (throttled; PRD §5.4)
  const agentTyping = useAgentTyping(chat.id, chat.provider === 'WEBCHAT');
  const setText = (v: string) => { setTextRaw(v); agentTyping(v); };
  // AI replies: pre-fills the AI draft and remembers which run the text came from (sent as `ai_run_id`).
  const ai = useComposerAi(chat.id, text, setText);
  // Draft with AI (draft_now) for this chat, plus the Improve / Translate undo state.
  const draft = useDraftWithAi(ai, chat.id, onError);
  // Website agent on Review: its suggested answer pre-fills the box; sending it (edited or not) marks it used.
  const sug = useComposerSuggestion(chat, text, setText);
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
  const [pickProducts, setPickProducts] = useState(false);   // web chat: the Product button's picker
  const bookingLink = ((sender as (Sender & { booking_link?: string | null }) | null)?.booking_link ?? '').trim() || null;
  const interested = chat.intent === 'interested';
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(textRef, text, `${mode}:${!!disabledReason}`);
  const wa = chat.provider === 'WHATSAPP';
  const ig = chat.provider === 'INSTAGRAM';
  // email: Cc / Bcc on the reply (the To is always the contact of the thread)
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const mailReplyN = mailReply?.n ?? null;
  const [appliedReply, setAppliedReply] = useState<number | null>(null);
  if (mailReply && mailReplyN !== appliedReply) {
    setAppliedReply(mailReplyN);
    setCc(mailReply.cc);
    setShowCc(mailReply.cc.length > 0);
  }
  useEffect(() => { if (mailReplyN != null) requestAnimationFrame(() => textRef.current?.focus()); }, [mailReplyN]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiRef = useRef<HTMLDivElement>(null);
  // web chat: canned responses, inserted as their text ({{contact.name}} and friends are filled in when it is sent)
  const canned = useCannedResponses(chat.provider === 'WEBCHAT' ? workspaceId : null);
  const [cannedOpen, setCannedOpen] = useState(false);
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
  const insertCanned = (content: string) => {
    setCannedOpen(false);
    // an empty box takes the response as it is; otherwise it goes in at the cursor on a line of its own
    insertEmoji(text.trim() ? `${/\s$/.test(text.slice(0, textRef.current?.selectionStart ?? text.length)) ? '' : '\n'}${content}` : content);
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
    const badAddress = isEmail ? [...cc, ...bcc].find((e) => !isEmailAddress(e)) : undefined;
    if (badAddress) { onError(`"${badAddress}" is not an email address. Fix or remove it before sending.`); return; }
    const body = booking ? [typed || BOOKING_DEFAULT_TEXT, '', bookingLink].join('\n') : typed;   // what the optimistic bubble shows
    // the AI already sent its own version of what is in the box: a second message needs an explicit yes
    if (ai.aiSent && !window.confirm('The AI already sent its version of this reply. Send yours as well?')) return;
    ai.clearAiSent();
    const aiRunId = ai.runIdForSend();   // only when the text started as that run's draft (edited or not)
    const suggestionId = chat.provider === 'WEBCHAT' && !files.length ? sug.idForSend() : null;
    if (booking) setSendingBooking(true); else setSending(true);
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId, workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: null, direction: 'out', text: body, html: null,
      attachments: files.map((f, i) => ({ id: `${tempId}-${i}`, name: f.name, type: f.type, size: f.size })),
      sent_at: new Date().toISOString(), is_invite_note: false, intent: null, intent_confidence: null, summary: null, classified_at: null,
      opens: 0, clicks: 0, edited_at: null, deleted_at: null, action_id: null, created_at: new Date().toISOString(),
      quoted: replyTo ? { unipile_message_id: replyTo.unipile_message_id, text: replyTo.text, sender_name: replyToName ?? null } : null,
      content_attributes: isEmail ? { email: {
        from: senderEmail(sender) ? { name: sender?.display_name ?? null, email: senderEmail(sender)! } : null,
        to: chat.attendee_provider_id ? [{ name: chat.attendee_name ?? null, email: chat.attendee_provider_id }] : [],
        cc: cc.map((email) => ({ name: null, email })), bcc: bcc.map((email) => ({ name: null, email })), reply_to: [], subject: subject.trim() || null,
      } } : {},
    } as Message;
    const key = qk.messages(chat.id);
    qc.setQueryData<Message[]>(key, (old) => [...(old ?? []), optimistic]);
    try {
      const paths: string[] = [];
      for (const f of files) {
        const path = `${workspaceId}/${chat.id}/${Date.now()}-${safeName(f.name)}`;
        const { error } = await db.storage.from('outreach-attachments').upload(path, f, { contentType: f.type || undefined, upsert: false });
        if (error) throw new Error(`Upload failed for ${f.name}: ${error.message}`);
        paths.push(path);
      }
      const payload: Record<string, unknown> = { chat_id: chat.id, text: booking ? typed : body };
      if (paths.length) payload.attachments = paths;
      if (isEmail && subject.trim()) payload.subject = subject.trim();
      if (isEmail && cc.length) payload.cc = cc;
      if (isEmail && bcc.length) payload.bcc = bcc;
      if (booking) payload.booking = true;
      if (replyTo) payload.quote_message_id = replyTo.id;
      if (aiRunId) payload.ai_run_id = aiRunId;
      if (chat.provider === 'WEBCHAT') {
        // web chat: no connector; the row + Realtime broadcast come from the RPC (web-chat-PRD.md §8). "/shortcut" expands there.
        // a Review suggestion that recommends products goes out with the cards the agent kept (built on the server from the suggestion's own snapshot)
        const cardIds = suggestionId ? sug.cardIdsForSend() : [];
        if (suggestionId && cardIds.length) await sendProducts({ chatId: chat.id, productIds: cardIds, text: body, suggestionId });
        else await rpc('webchat_agent_send', { p_chat: chat.id, p_text: body, p_content_type: paths.length ? 'attachment' : 'text', p_attrs: suggestionId ? { internal: { suggestion_id: suggestionId } } : {}, p_attachments: paths.map((path, i) => ({ id: path, storage: true, name: files[i]?.name ?? path.split('/').pop(), type: files[i]?.type ?? null, size: files[i]?.size ?? null })) });
      } else {
        await callFn('send-reply', payload);
      }
      setText('');
      ai.dropTag();
      sug.dropTag();
      if (chat.provider === 'WEBCHAT') { qc.invalidateQueries({ queryKey: hk.suggestion(chat.id) }); qc.invalidateQueries({ queryKey: hk.all(workspaceId) }); }
      setUndo(null);
      setFiles([]);
      setCc([]); setBcc([]); setShowCc(false); setShowBcc(false);
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

  // Reply / Private note tabs (Alt+P switches; the shortcut listener lives in Thread). A note is allowed whenever the
  // chat is readable — sender status, can_reply, AI state and pauses only gate the Reply mode.
  const noteMode = mode === 'note';
  const modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌥P' : 'Alt+P';
  const tabs = (right?: React.ReactNode) => (
    <div className="flex items-center gap-1 min-w-0" role="tablist" aria-label="Composer mode">
      {([['reply', 'Reply', MessageSquare], ['note', compact ? 'Note' : 'Private note', Lock]] as const).map(([m, label, Icon]) => (
        <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => onModeChange(m)} title={`${m === 'note' ? 'Private note' : 'Reply'} (${modKey} to switch)`}
          className={cn('flex-shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-md border transition-colors',
            mode === m ? (m === 'note' ? 'bg-amber-100 border-amber-300 text-amber-950 font-medium' : 'bg-indigo-50 border-indigo-200 text-indigo-800 font-medium') : 'bg-transparent border-transparent text-gray-500 hover:bg-gray-100')}>
          <Icon className="w-3.5 h-3.5" /> {label}
        </button>
      ))}
      {right ?? (!compact && <span className="ml-auto text-[10px] text-gray-400 hidden sm:inline" title="Switch between Reply and Private note">{modKey} to switch</span>)}
    </div>
  );
  const noteBody = noteMode ? (
    <NoteComposer chat={chat} workspaceId={workspaceId} members={members} currentUserId={currentUserId} isClientViewer={isClientViewer} canImprove={aiChannel && !disabledReason} onSubmit={onAddNote} onError={onError} autoFocus />
  ) : null;

  if (disabledReason) {
    return (
      <div className={cn('flex-shrink-0 border-t border-gray-200 px-3 py-2 space-y-1.5', noteMode ? 'bg-amber-50/60' : 'bg-gray-50')}>
        {tabs()}
        {noteBody ?? (
          <>
            <AiComposerPanel ai={ai} chat={chat} canCompose={false} onError={onError} />
            <div className="text-sm text-gray-600 flex items-start gap-2">
              <Lock className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" />
              <span>{disabledReason}</span>
            </div>
          </>
        )}
      </div>
    );
  }

  if (noteMode) {
    return (
      <div className="flex-shrink-0 border-t border-gray-200 bg-amber-50/60 px-3 py-2 space-y-1.5">
        {tabs()}
        {noteBody}
      </div>
    );
  }

  const typedNow = text.trim();
  return (
    <div className="flex-shrink-0 border-t border-gray-200 bg-white px-3 pt-1.5 pb-2 space-y-1.5">
      {tabs(<AiDraftSummary ai={ai} draft={draft} chat={chat} text={text} onError={onError} compact={compact} stopInline={wide} />)}
      <AiComposerPanel ai={ai} chat={chat} canCompose onError={onError} onRegenerate={aiChannel ? () => { void draft.request({ regenerate: true }); } : undefined} regenerating={draft.busy} />
      <WebchatSuggestionBar sug={sug} text={text} />
      {/* One box: mail header · quote · AI notes · the text · files · one toolbar row */}
      <div className={cn('border border-gray-200 bg-white transition-shadow', ig ? 'rounded-[22px] focus-within:border-[#3797f0]/60 focus-within:ring-2 focus-within:ring-[#3797f0]/20' : 'rounded-xl focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-500/15')}>
        {isEmail && (
          // a mail client's header: To (the contact), optional Cc / Bcc, Subject
          <div className="border-b border-gray-100">
            <div className="flex items-center gap-2 px-3 py-1 border-b border-gray-100 text-sm min-w-0">
              <span className="w-8 text-gray-500 flex-shrink-0">To</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs text-gray-800 min-w-0 truncate" title={chat.attendee_provider_id ?? undefined}>
                {chat.attendee_name && chat.attendee_name !== chat.attendee_provider_id ? <><span className="font-medium truncate">{chat.attendee_name}</span><span className="text-gray-500 truncate">&lt;{chat.attendee_provider_id}&gt;</span></> : <span className="truncate">{chat.attendee_provider_id ?? 'No address'}</span>}
              </span>
              <span className="ml-auto flex items-center gap-2 text-xs flex-shrink-0">
                {!showCc && <button type="button" onClick={() => setShowCc(true)} className="text-gray-500 hover:text-gray-900 hover:underline">Cc</button>}
                {!showBcc && <button type="button" onClick={() => setShowBcc(true)} className="text-gray-500 hover:text-gray-900 hover:underline">Bcc</button>}
              </span>
            </div>
            {showCc && <AddressField label="Cc" value={cc} onChange={setCc} autoFocus={!mailReply?.cc.length} onRemoveField={() => { setCc([]); setShowCc(false); }} />}
            {showBcc && <AddressField label="Bcc" value={bcc} onChange={setBcc} autoFocus onRemoveField={() => { setBcc([]); setShowBcc(false); }} />}
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Email subject" className="w-full text-sm px-3 py-1 bg-transparent focus:outline-none" />
          </div>
        )}
        {replyTo && (
          <div className="mx-2 mt-2 flex items-start gap-2 rounded-md bg-gray-50 border-l-4 border-emerald-500 px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-emerald-700 truncate">Replying to {replyToName ?? 'message'}</div>
              <div className="text-xs text-gray-600 line-clamp-2 whitespace-pre-wrap">{replyTo.text?.trim() || (replyTo.attachments?.length ? '📎 Attachment' : 'Message')}</div>
            </div>
            <button type="button" onClick={onCancelReply} className="p-0.5 text-gray-400 hover:text-gray-700" aria-label="Cancel reply"><X className="w-4 h-4" /></button>
          </div>
        )}
        <AiDraftNotes ai={ai} draft={draft} chat={chat} text={text} stopInline={wide} />
        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) { ai.dropTag(); setUndo(null); } }}
          onKeyDown={(e) => {
            // WhatsApp / Instagram: Enter sends, Shift+Enter adds a line (like the apps). Everywhere: Ctrl/Cmd+Enter sends; Escape drops the reply.
            if (e.key === 'Escape' && replyTo) { onCancelReply?.(); return; }
            if (((e.metaKey || e.ctrlKey) && e.key === 'Enter') || ((wa || ig) && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) { e.preventDefault(); send(false); }
          }}
          onPaste={(e) => { const pasted = Array.from(e.clipboardData?.files ?? []); if (pasted.length) { e.preventDefault(); const dt = new DataTransfer(); pasted.forEach((f) => dt.items.add(f)); addFiles(dt.files); } }}
          placeholder={compact
            ? `${isEmail ? 'Write your reply' : 'Message'} as ${sender?.display_name ?? 'sender'}…`
            : wa ? `Type a message as ${sender?.display_name ?? 'sender'} (Enter to send, Shift+Enter for a new line)`
              : ig ? `Message… as ${sender?.display_name ?? 'sender'} (Enter to send)`
                : `${isEmail ? 'Write your reply' : chat.provider === 'LINKEDIN' ? 'Write a message' : 'Reply'} as ${sender?.display_name ?? 'sender'}… (${typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter to send)`}
          aria-label="Reply"
          maxLength={maxLength}
          rows={isEmail ? 3 : 2}
          // Grows with the text while you write; while you read (box not focused) a long draft folds to a few lines so the
          // conversation keeps the height. The fold waits a moment so a click on a button above it still lands.
          className={cn('block w-full text-base md:text-sm py-2 bg-transparent border-0 resize-none overflow-y-auto focus:outline-none focus:ring-0',
            'transition-[max-height] duration-150 delay-200 focus:delay-[0ms] max-h-[5.5rem] focus:max-h-[min(16rem,35vh)]',
            ig ? 'px-4' : 'px-3', isEmail ? 'min-h-[76px]' : 'min-h-[52px]')}
        />
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pb-1.5">
            {files.map((f, i) => <FileChip key={`${f.name}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />)}
          </div>
        )}
        {aiChannel && <AssistWarnings undo={undo} />}
        <div className="flex flex-wrap items-center justify-between gap-1 px-1.5 pb-1.5">
          <div className="flex items-center gap-0.5">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} aria-label="Attach files" />
            {!isEmail && (
              <div className="relative" ref={emojiRef}>
                <Button type="button" variant="ghost" size="sm" className="px-2" onClick={() => setEmojiOpen((v) => !v)} title="Emoji" aria-label="Emoji"><Smile className="w-4 h-4" /></Button>
                {emojiOpen && (
                  <div className="absolute bottom-full mb-1 left-0 z-20 w-64 grid grid-cols-8 gap-0.5 rounded-lg bg-white border border-gray-200 shadow-lg p-1.5" role="menu">
                    {EMOJIS.map((e) => <button key={e} type="button" role="menuitem" onClick={() => insertEmoji(e)} className="text-lg leading-none p-1 rounded hover:bg-gray-100" aria-label={e}>{e}</button>)}
                  </div>
                )}
              </div>
            )}
            <Button type="button" variant="ghost" size="sm" className="px-2" onClick={() => fileRef.current?.click()} title="Attach files" aria-label="Attach files"><Paperclip className="w-4 h-4" /></Button>
            {chat.provider === 'WEBCHAT' && (
              <div className="relative">
                <Button type="button" variant="ghost" size="sm" className="px-2" onClick={() => setCannedOpen((o) => !o)} title="Canned responses (or type /shortcut)" aria-label="Canned responses" aria-haspopup="menu" aria-expanded={cannedOpen}><Zap className="w-4 h-4" /></Button>
                {cannedOpen && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setCannedOpen(false)} />
                    <div className="absolute bottom-full mb-1 left-0 z-30 w-72 max-w-[calc(100vw-2rem)] max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg py-1 text-xs" role="menu">
                      <div className="px-3 pt-1 pb-1 text-[11px] text-gray-500">Canned responses</div>
                      {canned.isLoading && <p className="px-3 py-1.5 text-gray-500">Loading…</p>}
                      {!canned.isLoading && (canned.data ?? []).length === 0 && <p className="px-3 py-1.5 text-gray-500">None yet. Add them in Website Agents → your website → Canned responses.</p>}
                      {(canned.data ?? []).map((c) => (
                        <button key={c.id} type="button" role="menuitem" className="block w-full text-left px-3 py-1.5 hover:bg-gray-50" onClick={() => insertCanned(c.content)}>
                          <span className="font-mono text-indigo-700">/{c.short_code}</span> <span className="text-gray-600 line-clamp-2">{c.content}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {chat.provider === 'WEBCHAT' && <Button type="button" variant="ghost" size="sm" className="px-2" onClick={() => setPickProducts(true)} disabled={sending} title="Send products from the website's catalogue as cards" aria-label="Send products"><ShoppingBag className="w-4 h-4" />{!compact && ' Product'}</Button>}
            {aiChannel && (
              <>
                <span className="w-px h-5 bg-gray-200 mx-1 flex-shrink-0" aria-hidden />
                <AiComposerActions ai={ai} draft={draft} chatId={chat.id} text={text} setText={setText} prospectLanguage={prospectLanguage} disabled={sending || sendingBooking} onError={onError} undo={undo} setUndo={setUndo} compact={compact} wide={wide} />
              </>
            )}
            {maxLength && <span className={`ml-1 text-[11px] tabular-nums ${text.length >= maxLength ? 'text-red-600 font-medium' : 'text-gray-400'}`}>{text.length}/{maxLength}</span>}
          </div>
          <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
            {bookingLink && (
              // an interested lead: the booking link is the obvious next step, so the button turns green
              <Button type="button" size="sm" variant={interested ? 'primary' : 'ghost'} className={cn(compact && 'px-2', interested && 'bg-green-600 hover:bg-green-700')} loading={sendingBooking} disabled={sending} onClick={() => send(true)}
                title={`${interested ? 'This lead is interested. ' : ''}Send ${sender?.display_name ? `${sender.display_name}'s` : 'the'} booking link. ${bookingTitle(typedNow)}`} aria-label="Send booking link">
                <CalendarCheck className="w-4 h-4" />{!compact && (interested ? 'Send booking link' : 'Booking link')}
              </Button>
            )}
            <Button type="button" size="sm" loading={sending} disabled={(!typedNow && !files.length) || sendingBooking} onClick={() => send(false)} title="Send reply (replies don't count against outbound caps)"><Send className="w-4 h-4" /> Send</Button>
          </div>
        </div>
      </div>
      {pickProducts && (
        <ProductPicker ws={workspaceId} chatId={chat.id} inboxId={chat.webchat_inbox_id ?? null} text={sug.inBox ? '' : text} onClose={() => setPickProducts(false)}
          onSent={(usedText) => {
            setPickProducts(false);
            if (usedText) setText('');
            qc.invalidateQueries({ queryKey: qk.messages(chat.id) });
            qc.invalidateQueries({ queryKey: ['outreach', workspaceId, 'chats'] });
            qc.invalidateQueries({ queryKey: hk.suggestion(chat.id) });
            onSent?.();
          }} />
      )}
    </div>
  );
}
