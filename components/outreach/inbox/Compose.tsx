'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, Send, X, Lock } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import type { Chat, Message, Sender } from '@/lib/outreach/types';
import { Button } from '@/components/outreach/ui';
import { fmtBytes } from './hooks';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

export interface ComposeProps {
  chat: Chat;
  sender: Sender | null;
  workspaceId: string;
  disabledReason: string | null;
  onError: (msg: string) => void;
  onSent?: () => void;
}

function safeName(name: string) { return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file'; }

function defaultSubject(chat: Chat): string {
  if (!chat.subject) return '';
  return /^re:/i.test(chat.subject.trim()) ? chat.subject : `Re: ${chat.subject}`;
}

export default function Compose({ chat, sender, workspaceId, disabledReason, onError, onSent }: ComposeProps) {
  const qc = useQueryClient();
  const isEmail = chat.provider !== 'LINKEDIN';
  const [text, setText] = useState('');
  const [subject, setSubject] = useState(() => defaultSubject(chat));
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

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

  const send = async () => {
    const body = text.trim();
    if (!body || sending || disabledReason) return;
    setSending(true);
    const tempId = `temp-${Date.now()}`;
    const optimistic: Message = {
      id: tempId, workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: null, direction: 'out', text: body, html: null,
      attachments: files.map((f, i) => ({ id: `${tempId}-${i}`, name: f.name, type: f.type, size: f.size })),
      sent_at: new Date().toISOString(), is_invite_note: false, intent: null, intent_confidence: null, summary: null, classified_at: null,
      opens: 0, clicks: 0, edited_at: null, deleted_at: null, action_id: null, created_at: new Date().toISOString(),
    };
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
      const payload: Record<string, unknown> = { chat_id: chat.id, text: body };
      if (paths.length) payload.attachments = paths;
      if (isEmail && subject.trim()) payload.subject = subject.trim();
      await callFn('send-reply', payload);
      setText('');
      setFiles([]);
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['outreach', workspaceId, 'chats'] });
      onSent?.();
      textRef.current?.focus();
    } catch (e) {
      qc.setQueryData<Message[]>(key, (old) => (old ?? []).filter((m) => m.id !== tempId));
      onError(parseError(e).message);
    } finally {
      setSending(false);
    }
  };

  if (disabledReason) {
    return (
      <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 flex items-start gap-2">
        <Lock className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" />
        <span>{disabledReason}</span>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 bg-white p-3 space-y-2">
      {isEmail && (
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Email subject" className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      )}
      <textarea
        ref={textRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}
        placeholder={`Reply as ${sender?.display_name ?? 'sender'}… (${typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter to send)`}
        aria-label="Reply"
        rows={3}
        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 resize-y min-h-[72px] max-h-64 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-100 text-gray-700">
              <Paperclip className="w-3 h-3" />
              <span className="truncate max-w-[160px]">{f.name}</span>
              <span className="text-gray-400">{fmtBytes(f.size)}</span>
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600" aria-label={`Remove ${f.name}`}><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} aria-label="Attach files" />
          <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()} title="Attach files"><Paperclip className="w-4 h-4" /> Attach</Button>
          <span className="text-[11px] text-gray-400 hidden sm:inline">Replies don't count against outbound caps.</span>
        </div>
        <Button type="button" size="sm" loading={sending} disabled={!text.trim()} onClick={send} title="Send reply"><Send className="w-4 h-4" /> Send</Button>
      </div>
    </div>
  );
}
