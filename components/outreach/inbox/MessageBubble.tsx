'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Paperclip, Loader2, Pencil, Trash2, Sparkles, Eye, MousePointerClick, Clock, Download, GitBranch, CornerDownRight, User, Mic, CheckCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message, Provider } from '@/lib/outreach/types';
import type { ThreadAttributionRow } from '@/lib/outreach/intel';
import { Badge, Button, fmtDate } from '@/components/outreach/ui';
import { editWindowRemainingMs, fmtRemaining, fmtBytes, sanitizeHtml, triggerDownload, useAttachmentUrl, type MessageAttachment } from './hooks';
import { isMailProvider } from '@/lib/outreach/channels';

export function isVoiceNote(att: MessageAttachment): boolean {
  const mime = att.mimetype ?? att.type ?? '';
  return !!att.voice_note || mime.startsWith('audio/');
}

function fmtDuration(s: number | null | undefined): string | null {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60); const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Voice note (WhatsApp / Instagram): inline player fed by the attachment proxy, loaded on mount. */
function VoiceNote({ messageId, att, mine }: { messageId: string; att: MessageAttachment; mine: boolean }) {
  const { url, loading, error, load } = useAttachmentUrl(messageId, att.id);
  useEffect(() => { if (!url && !loading && !error) void load(); }, [url, loading, error, load]);
  const dur = fmtDuration(att.duration_s);
  return (
    <div className={cn('rounded-lg px-2 py-1.5 min-w-[220px] max-w-full', mine ? 'bg-white/15' : 'bg-gray-50 border border-gray-200')}>
      <div className={cn('flex items-center gap-1.5 text-[11px] mb-1', mine ? 'text-white/80' : 'text-gray-500')}><Mic className="w-3 h-3" /> Voice note{dur ? ` · ${dur}` : ''}</div>
      {url ? <audio controls preload="metadata" src={url} className="w-full h-8" aria-label="Voice note" />
        : error ? <div className="text-[11px] text-red-600">{error}</div>
          : <div className={cn('inline-flex items-center gap-1 text-[11px]', mine ? 'text-white/80' : 'text-gray-500')}><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>}
    </div>
  );
}

function AttachmentChip({ messageId, att, mine }: { messageId: string; att: MessageAttachment; mine: boolean }) {
  const { url, loading, error, load } = useAttachmentUrl(messageId, att.id);
  const name = att.name ?? att.id.split('/').pop() ?? 'attachment';
  const mime = att.type ?? att.mimetype ?? '';
  const isImage = mime.startsWith('image/');
  const onClick = async () => {
    const u = url ?? (await load());
    if (u) triggerDownload(u, name);
  };
  return (
    <div className="max-w-full">
      {isImage && url && <img src={url} alt={name} className="max-h-48 rounded-lg mb-1 border border-black/10" />}
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        title={error ?? `Download ${name}`}
        className={cn('inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border max-w-full', mine ? 'bg-white/15 border-white/30 text-white hover:bg-white/25' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50', error && 'border-red-300')}
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : url ? <Download className="w-3 h-3" /> : <Paperclip className="w-3 h-3" />}
        <span className="truncate max-w-[180px]">{name}</span>
        {att.size ? <span className={mine ? 'text-white/70' : 'text-gray-400'}>{fmtBytes(att.size)}</span> : null}
      </button>
      {error && <div className="text-[11px] text-red-600 mt-0.5">{error}</div>}
    </div>
  );
}

export interface MessageBubbleProps {
  m: Message;
  provider: Provider;
  now: number;
  /** Item 4: which sequence, step and sender produced this message (from outreach_thread_attribution). */
  attribution?: ThreadAttributionRow;
  canEdit: boolean;          // permission-level gate (canReply, sender ok, etc.)
  onEdit: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function stepHref(a: ThreadAttributionRow): string {
  return `/outreach/sequences/${a.sequence_id}${a.node_id ? `?node=${encodeURIComponent(a.node_id)}` : ''}`;
}

function stepName(a: ThreadAttributionRow): string {
  const n = a.step_number != null ? `Step ${a.step_number}` : 'Step';
  return a.step_label ? `${n}: ${a.step_label}` : n;
}

function Attribution({ a, mine }: { a: ThreadAttributionRow; mine: boolean }) {
  const cls = 'flex items-center gap-1 mt-1 text-[11px] text-gray-500 max-w-full flex-wrap';
  if (a.kind === 'automated') {
    return (
      <div className={cls}>
        <GitBranch className="w-3 h-3 text-indigo-400 flex-shrink-0" aria-hidden />
        {a.sequence_id
          ? <Link href={stepHref(a)} className="hover:text-indigo-600 hover:underline">{a.sequence_name ?? 'Sequence'} · {stepName(a)}</Link>
          : <span>Automated · {stepName(a)}</span>}
        {a.variant_label || a.variant_id ? <span className="px-1.5 py-px rounded bg-purple-50 text-purple-700">{a.variant_label ?? `Variant ${a.variant_id}`}</span> : null}
        {a.sender_name && <span>· via {a.sender_name}</span>}
      </div>
    );
  }
  if (a.kind === 'manual' && mine) {
    return <div className={cls}><User className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden /><span>{a.sent_by_name ? `Sent by ${a.sent_by_name}` : 'Sent by hand'}</span></div>;
  }
  if (a.kind === 'inbound' && a.sequence_id && (a.replying_to_message_id || a.node_id)) {
    return (
      <div className={cls}>
        <CornerDownRight className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden />
        <Link href={stepHref(a)} className="hover:text-indigo-600 hover:underline" title={[a.sequence_name, a.step_label].filter(Boolean).join(' · ') || undefined}>Replying to {a.step_number != null ? `Step ${a.step_number}` : (a.step_label ?? 'a sequence step')}</Link>
      </div>
    );
  }
  return null;
}

export default function MessageBubble({ m, provider, now, canEdit, onEdit, onDelete, attribution }: MessageBubbleProps) {
  const mine = m.direction === 'out';
  const deleted = !!m.deleted_at;
  const pending = m.id.startsWith('temp-');
  const remaining = mine && provider === 'LINKEDIN' && !deleted && !pending ? editWindowRemainingMs(m.sent_at, now) : -1;
  const editable = canEdit && remaining > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text ?? '');
  const [busy, setBusy] = useState<'edit' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isEmail = isMailProvider(provider);
  const safeHtml = useMemo(() => (isEmail && m.html && !m.text ? sanitizeHtml(m.html) : ''), [isEmail, m.html, m.text]);
  const voiceNotes = useMemo(() => (m.attachments ?? []).filter((a) => isVoiceNote(a as MessageAttachment)) as MessageAttachment[], [m.attachments]);
  const otherAttachments = useMemo(() => (m.attachments ?? []).filter((a) => !isVoiceNote(a as MessageAttachment)) as MessageAttachment[], [m.attachments]);
  const reactions = Array.isArray(m.reactions) ? m.reactions.filter((r) => r && typeof r.emoji === 'string' && r.emoji) : [];
  const transcriptPending = voiceNotes.length > 0 && m.transcript_status === 'pending';
  const transcriptFailed = voiceNotes.length > 0 && m.transcript_status === 'failed';

  const save = async () => {
    if (!draft.trim() || draft === m.text) { setEditing(false); return; }
    setBusy('edit');
    try { await onEdit(m.id, draft.trim()); setEditing(false); } finally { setBusy(null); }
  };
  const remove = async () => {
    setBusy('delete');
    try { await onDelete(m.id); setConfirmDelete(false); } finally { setBusy(null); }
  };

  return (
    <div className={cn('flex flex-col max-w-[85%] md:max-w-[70%]', mine ? 'ml-auto items-end' : 'mr-auto items-start')}>
      <div className={cn('rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words shadow-sm', mine ? 'bg-indigo-600 text-white rounded-br-md' : 'bg-white border border-gray-200 text-gray-900 rounded-bl-md', deleted && 'opacity-70', pending && 'opacity-60')}>
        {m.is_invite_note && <div className="mb-1"><Badge tone={mine ? 'indigo' : 'blue'} className={mine ? 'bg-white/20 text-white' : ''}>Invitation note</Badge></div>}
        {isEmail && m.html && !m.text ? (
          <div className="max-w-none [&_a]:underline [&_p]:my-1 [&_img]:max-w-full overflow-x-auto" dangerouslySetInnerHTML={{ __html: safeHtml }} />
        ) : editing ? (
          <div className="min-w-[240px]">
            <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, Math.max(2, draft.split('\n').length))} className="w-full text-sm text-gray-900 rounded-md border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-400" aria-label="Edit message" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />
            <div className="flex justify-end gap-1.5 mt-1">
              <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setDraft(m.text ?? ''); }}>Cancel</Button>
              <Button size="sm" variant="secondary" loading={busy === 'edit'} onClick={save}>Save</Button>
            </div>
          </div>
        ) : (
          <span className={cn(deleted && 'line-through')}>{m.text || (m.attachments?.length ? '' : <em className="opacity-70">(empty message)</em>)}</span>
        )}
        {voiceNotes.length > 0 && (
          <div className={cn('space-y-1.5', m.text ? 'mt-2' : '')}>
            {voiceNotes.map((a) => <VoiceNote key={a.id} messageId={m.id} att={a} mine={mine} />)}
            {m.transcript
              ? <div className={cn('text-xs italic border-l-2 pl-2', mine ? 'text-white/85 border-white/40' : 'text-gray-600 border-gray-300')}>{m.transcript}</div>
              : transcriptPending ? <div className={cn('text-[11px] inline-flex items-center gap-1', mine ? 'text-white/70' : 'text-gray-400')}><Loader2 className="w-3 h-3 animate-spin" /> Transcribing…</div>
                : transcriptFailed ? <div className={cn('text-[11px]', mine ? 'text-white/70' : 'text-gray-400')}>Could not transcribe this voice note.</div> : null}
          </div>
        )}
        {otherAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {otherAttachments.map((a) => <AttachmentChip key={a.id} messageId={m.id} att={a} mine={mine} />)}
          </div>
        )}
      </div>
      {reactions.length > 0 && (
        <div className={cn('flex flex-wrap gap-1 -mt-1.5 relative z-[1]', mine ? 'justify-end mr-2' : 'ml-2')} aria-label="Reactions">
          {reactions.map((r, i) => (
            <span key={`${r.emoji}-${i}`} className="inline-flex items-center rounded-full bg-white border border-gray-200 shadow-sm px-1.5 py-px text-xs" title={[r.by, r.at ? fmtDate(r.at) : null].filter(Boolean).join(' · ') || undefined}>{r.emoji}</span>
          ))}
        </div>
      )}
      {!mine && m.summary && (
        <div className="flex items-start gap-1 text-xs text-gray-500 mt-1 max-w-full">
          <Sparkles className="w-3 h-3 mt-0.5 text-fuchsia-500 flex-shrink-0" />
          <span className="italic">{m.summary}</span>
        </div>
      )}
      {attribution && !pending && <Attribution a={attribution} mine={mine} />}
      <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-400 flex-wrap">
        <span title={new Date(m.sent_at).toLocaleString()}>{pending ? 'Sending…' : fmtDate(m.sent_at)}</span>
        {m.edited_at && !deleted && <span>· edited</span>}
        {deleted && <span>· deleted</span>}
        {mine && m.read_at && !pending && <span className="inline-flex items-center gap-0.5 text-sky-600" title={`Seen ${fmtDate(m.read_at)}`}><CheckCheck className="w-3 h-3" /> Seen</span>}
        {isEmail && mine && (m.opens > 0 || m.clicks > 0) && (
          <>
            <span className="inline-flex items-center gap-0.5" title="Opens"><Eye className="w-3 h-3" />{m.opens}</span>
            <span className="inline-flex items-center gap-0.5" title="Link clicks"><MousePointerClick className="w-3 h-3" />{m.clicks}</span>
          </>
        )}
        {editable && !editing && (
          <>
            <span className="inline-flex items-center gap-0.5 text-amber-600" title="Edit/delete window"><Clock className="w-3 h-3" />{fmtRemaining(remaining)}</span>
            <button type="button" onClick={() => { setDraft(m.text ?? ''); setEditing(true); }} className="inline-flex items-center gap-0.5 hover:text-gray-700" title="Edit message"><Pencil className="w-3 h-3" />Edit</button>
            {confirmDelete ? (
              <span className="inline-flex items-center gap-1">
                <span className="text-red-600">Delete?</span>
                <button type="button" onClick={remove} disabled={busy === 'delete'} className="text-red-600 font-medium hover:underline">{busy === 'delete' ? 'Deleting…' : 'Yes'}</button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="hover:underline">No</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-0.5 hover:text-red-600" title="Delete message"><Trash2 className="w-3 h-3" />Delete</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
