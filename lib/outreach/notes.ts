'use client';

// Private notes (private-notes-PRD.md): data layer for the inbox — types, query keys, hooks, mention tokens, drafts.
// Every read/write goes through the outreach_note* / outreach_notes* / outreach_mentions* / outreach_notifications* RPCs
// (migration 046). Notes never touch outreach_messages.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/outreach/backend';
import { callFn, parseError, rpc } from './api';
import type { Member, Provider } from './types';
import { kv } from '@/lib/outreach/storage';

// ---------------------------------------------------------------------------------------------------- types
export type NoteVisibility = 'team' | 'team_and_client';
export type NoteAuthorType = 'user' | 'ai' | 'system' | 'agent';

export interface NoteAttachment { path: string; name: string; size?: number | null; mime?: string | null; width?: number | null; height?: number | null }
export interface NoteMention { user_id: string; name: string; read_at: string | null; access: boolean }
export interface ChatNote {
  id: string;
  chat_id: string;
  lead_id: string | null;
  client_id: string | null;
  workspace_id: string;
  author: { id: string | null; type: NoteAuthorType; name: string; former: boolean };
  /** null once deleted (placeholder rendering) */
  body: string | null;
  visibility: NoteVisibility;
  mentions: NoteMention[];
  attachments: NoteAttachment[];
  exclude_from_ai: boolean;
  edited_at: string | null;
  revisions: number;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  /** only on the create / update result */
  dropped_mentions?: Array<{ user_id: string; name: string; reason: 'no_access' | 'self' | 'cap' | 'not_member' }>;
  /** lead timeline rows carry their chat */
  chat?: { id: string; provider: Provider; attendee_name: string | null; sender_name: string | null };
}
export interface NoteRevision { revision: number; body: string; edited_at: string; edited_by: string }
export interface MentionRow {
  chat_id: string; note_id: string; created_at: string; read_at: string | null; unread_count: number; author: string; snippet: string;
  chat: { id: string; provider: Provider; attendee_name: string | null; picture_url: string | null; subject: string | null; lead_name: string | null; company: string | null; lead_picture_url: string | null; last_message_at: string | null; sender_name: string | null };
}
export interface NotificationRow {
  id: string; kind: string; chat_id: string | null; note_id: string | null; message_id?: string | null; title: string; body: string | null;
  /** reply alerts: messages merged into this row (076) */
  count?: number; data?: Record<string, unknown> | null; read_at: string | null; created_at: string; updated_at?: string; access: boolean;
}
export interface NotesBadge { unread_mentions: number; unread_notifications: number }
export interface NoteSearchHit { note_id: string; chat_id: string; created_at: string; author: string; snippet: string; chat: { id: string; provider: Provider; attendee_name: string | null; picture_url: string | null; lead_name: string | null; company: string | null } }
export type NotificationKind = 'note_mention' | 'ai_handoff' | 'assigned';
export interface NotificationPref { push: boolean; email: boolean; email_delay_min: 10 | 30 | 60 }
export type NotificationPrefs = Partial<Record<NotificationKind, NotificationPref>>;

export const NOTE_MAX_CHARS = 10_000;
export const NOTE_MAX_ATTACHMENTS = 10;
export const NOTE_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const NOTE_MAX_MENTIONS = 20;

// ---------------------------------------------------------------------------------------------------- query keys
export const nk = {
  chatNotes: (chatId: string) => ['outreach', 'chat', chatId, 'notes'] as const,
  leadNotes: (leadId: string) => ['outreach', 'lead', leadId, 'team-notes'] as const,
  badge: (ws: string) => ['outreach', ws, 'notes', 'badge'] as const,
  mentions: (ws: string, unreadOnly: boolean) => ['outreach', ws, 'notes', 'mentions', unreadOnly] as const,
  notifications: (ws: string) => ['outreach', ws, 'notes', 'notifications'] as const,
  prefs: (ws: string) => ['outreach', ws, 'notes', 'prefs'] as const,
  search: (ws: string, q: string) => ['outreach', ws, 'notes', 'search', q] as const,
  revisions: (noteId: string) => ['outreach', 'note', noteId, 'revisions'] as const,
};

// ---------------------------------------------------------------------------------------------------- mention tokens
/** Stored form of a mention: `@[Naman Shah](user:<uuid>)`. */
export const MENTION_TOKEN_RE = /@\[([^\]]{1,80})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

export function mentionToken(name: string, userId: string): string {
  return `@[${name.replace(/[\[\]]/g, '')}](user:${userId})`;
}

/** Tokens → "@Name" for previews, search and the composer's display text. */
export function notePlain(body: string | null | undefined): string {
  return (body ?? '').replace(MENTION_TOKEN_RE, '@$1');
}

/** Tokens found in a body, in order, deduplicated by user. */
export function mentionsIn(body: string): Array<{ name: string; user_id: string }> {
  const out: Array<{ name: string; user_id: string }> = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_TOKEN_RE)) { if (!seen.has(m[2])) { seen.add(m[2]); out.push({ name: m[1], user_id: m[2] }); } }
  return out;
}

/**
 * Composer text keeps "@Name" for readability; on submit each picked name becomes a token. Longest names first so
 * "@Naman Shah" wins over "@Naman". Names typed by hand that were never picked stay plain text (the server would drop
 * the mention anyway, and the author is told).
 */
export function encodeMentions(text: string, picked: Array<{ name: string; user_id: string }>): string {
  let out = text;
  const byLen = [...picked].sort((a, b) => b.name.length - a.name.length);
  for (const p of byLen) {
    const esc = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\w@])@${esc}(?![\\w])`, 'g'), (_m, pre: string) => `${pre}${mentionToken(p.name, p.user_id)}`);
  }
  return out;
}

/** Stored body → composer text + the picked list (for Edit). */
export function decodeMentions(body: string): { text: string; picked: Array<{ name: string; user_id: string }> } {
  return { text: notePlain(body), picked: mentionsIn(body) };
}

export function memberDisplayName(m: Member): string {
  return m.display_name || m.email || `${m.user_id.slice(0, 8)}…`;
}

/** Members who can read a note on this chat: role + client scope; client viewers only when the note is shared with the client. */
export function membersWhoCanRead(members: Member[] | undefined, chatClientId: string | null, visibility: NoteVisibility): Member[] {
  return (members ?? []).filter((m) => {
    if (m.role === 'client_viewer' && visibility !== 'team_and_client') return false;
    if (m.role === 'owner' || m.role === 'manager') return true;
    if (!chatClientId) return true;
    return m.client_ids.includes(chatClientId);
  });
}

// ---------------------------------------------------------------------------------------------------- drafts (per chat, per mode, survive reload)
const draftKey = (chatId: string, mode: 'reply' | 'note') => `outreach.inbox.draft:${chatId}:${mode}`;
export function readDraft(chatId: string, mode: 'reply' | 'note'): string {
  try { return kv.getItem(draftKey(chatId, mode)) ?? ''; } catch { return ''; }
}
export function writeDraft(chatId: string, mode: 'reply' | 'note', text: string): void {
  try { if (text.trim()) kv.setItem(draftKey(chatId, mode), text); else kv.removeItem(draftKey(chatId, mode)); } catch { /* storage blocked */ }
}
/** Text state that restores from localStorage and saves (debounced) on change. */
export function useDraftText(chatId: string, mode: 'reply' | 'note'): [string, (v: string) => void] {
  const [text, setText] = useState(() => (typeof window === 'undefined' ? '' : readDraft(chatId, mode)));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const set = useCallback((v: string) => {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => writeDraft(chatId, mode, v), 300);
  }, [chatId, mode]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [text, set];
}

const NOTE_MODE_KEY = 'outreach.inbox.composerMode';
export function readComposerMode(): 'reply' | 'note' {
  try { return kv.getItem(NOTE_MODE_KEY) === 'note' ? 'note' : 'reply'; } catch { return 'reply'; }
}
export function writeComposerMode(mode: 'reply' | 'note'): void {
  try { kv.setItem(NOTE_MODE_KEY, mode); } catch { /* ignore */ }
}
const SHOW_NOTES_KEY = 'outreach.inbox.showNotes';
export function readShowNotes(): boolean {
  try { return kv.getItem(SHOW_NOTES_KEY) !== '0'; } catch { return true; }
}
export function writeShowNotes(v: boolean): void {
  try { kv.setItem(SHOW_NOTES_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

/** Alt+P / ⌥P switches Reply ↔ Private note. Matched on the physical key so it works where ⌥P types a symbol. */
export function isNoteModeShortcut(e: KeyboardEvent | { code: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.code === 'KeyP' && e.altKey && !e.metaKey && !e.ctrlKey;
}

// ---------------------------------------------------------------------------------------------------- reads
export function useChatNotes(chatId: string | null | undefined) {
  return useQuery({ queryKey: nk.chatNotes(chatId ?? ''), enabled: !!chatId, queryFn: () => rpc<ChatNote[]>('notes_list', { p_chat: chatId }) });
}
export function useLeadTeamNotes(leadId: string | null | undefined, limit = 50) {
  return useQuery({ queryKey: nk.leadNotes(leadId ?? ''), enabled: !!leadId, queryFn: () => rpc<ChatNote[]>('notes_for_lead', { p_lead: leadId, p_limit: limit }) });
}
export function useNotesBadge(ws: string | null | undefined) {
  return useQuery({ queryKey: nk.badge(ws ?? ''), enabled: !!ws, refetchInterval: 60_000, queryFn: () => rpc<NotesBadge>('notes_badge', { p_ws: ws }) });
}
export function useMentions(ws: string | null | undefined, unreadOnly = false, enabled = true) {
  return useQuery({ queryKey: nk.mentions(ws ?? '', unreadOnly), enabled: !!ws && enabled, queryFn: () => rpc<MentionRow[]>('mentions_list', { p_ws: ws, p_unread_only: unreadOnly, p_limit: 200 }) });
}
export function useNotifications(ws: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: nk.notifications(ws ?? ''), enabled: !!ws && enabled, queryFn: () => rpc<NotificationRow[]>('notifications_list', { p_ws: ws, p_limit: 40 }) });
}
export function useNotificationPrefs(ws: string | null | undefined) {
  return useQuery({ queryKey: nk.prefs(ws ?? ''), enabled: !!ws, queryFn: () => rpc<NotificationPrefs>('notification_prefs_get', { p_ws: ws }) });
}
export function useNoteSearch(ws: string | null | undefined, q: string) {
  const query = q.trim();
  return useQuery({ queryKey: nk.search(ws ?? '', query), enabled: !!ws && query.length >= 2, placeholderData: (prev) => prev, queryFn: () => rpc<NoteSearchHit[]>('notes_search', { p_ws: ws, p_q: query, p_limit: 20 }) });
}
export function useNoteRevisions(noteId: string | null | undefined) {
  return useQuery({ queryKey: nk.revisions(noteId ?? ''), enabled: !!noteId, queryFn: () => rpc<NoteRevision[]>('note_revisions', { p_note: noteId }) });
}

// ---------------------------------------------------------------------------------------------------- writes
function useInvalidateNotes() {
  const qc = useQueryClient();
  return useCallback((ws: string, chatId?: string | null, leadId?: string | null) => {
    if (chatId) qc.invalidateQueries({ queryKey: nk.chatNotes(chatId) });
    if (leadId) qc.invalidateQueries({ queryKey: nk.leadNotes(leadId) });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'notes'] });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'chats'] });
    if (chatId) qc.invalidateQueries({ queryKey: ['outreach', 'chat', chatId] });
  }, [qc]);
}

export function useCreateNote(ws: string) {
  const inv = useInvalidateNotes();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { chatId: string; body: string; visibility: NoteVisibility; attachments?: NoteAttachment[] }) =>
      rpc<ChatNote>('note_create', { p_chat: a.chatId, p_body: a.body, p_visibility: a.visibility, p_attachments: a.attachments ?? [], p_author_type: 'user' }),
    onSuccess: (n, a) => {
      qc.setQueryData<ChatNote[]>(nk.chatNotes(a.chatId), (old) => (old ? [...old.filter((x) => x.id !== n.id), n] : old));
      inv(ws, a.chatId, n.lead_id);
    },
  });
}
export function useUpdateNote(ws: string) {
  const inv = useInvalidateNotes();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { noteId: string; chatId: string; body?: string; visibility?: NoteVisibility }) =>
      rpc<ChatNote>('note_update', { p_note: a.noteId, p_body: a.body ?? null, p_visibility: a.visibility ?? null }),
    onSuccess: (n, a) => {
      qc.setQueryData<ChatNote[]>(nk.chatNotes(a.chatId), (old) => old?.map((x) => (x.id === n.id ? n : x)));
      inv(ws, a.chatId, n.lead_id);
    },
  });
}
export function useDeleteNote(ws: string) {
  const inv = useInvalidateNotes();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { noteId: string; chatId: string }) => rpc<ChatNote>('note_delete', { p_note: a.noteId }),
    onSuccess: (n, a) => {
      qc.setQueryData<ChatNote[]>(nk.chatNotes(a.chatId), (old) => old?.map((x) => (x.id === n.id ? n : x)));
      inv(ws, a.chatId, n.lead_id);
    },
  });
}
export function useMarkNoteRead(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { noteId: string; chatId?: string }) => rpc('note_mark_read', { p_note: a.noteId }),
    onSuccess: (_r, a) => {
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'notes'] });
      if (a.chatId) qc.invalidateQueries({ queryKey: nk.chatNotes(a.chatId) });
    },
  });
}
export function useMarkAllMentionsRead(ws: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => rpc('mentions_mark_all_read', { p_ws: ws }), onSuccess: () => qc.invalidateQueries({ queryKey: ['outreach', ws, 'notes'] }) });
}
export function useMarkNotificationsRead(ws: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (ids: string[]) => rpc('notifications_mark_read', { p_ids: ids }), onSuccess: () => qc.invalidateQueries({ queryKey: ['outreach', ws, 'notes'] }) });
}
export function useSetNotificationPref(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { kind: NotificationKind; email: boolean; email_delay_min: 10 | 30 | 60; push?: boolean }) =>
      rpc<NotificationPrefs>('notification_prefs_set', { p_ws: ws, p_kind: a.kind, p_email: a.email, p_email_delay_min: a.email_delay_min, p_push: a.push ?? true }),
    onSuccess: (p) => qc.setQueryData(nk.prefs(ws), p),
  });
}

// ---------------------------------------------------------------------------------------------------- attachments (F43)
/** Upload one file for a note through a signed URL (the bucket has no direct insert policy). Returns the attachment record. */
export async function uploadNoteFile(chatId: string, file: File): Promise<NoteAttachment> {
  if (file.size > NOTE_MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 25 MB.`);
  const r = await callFn<{ path: string; token: string; name: string }>('note-attachment', { action: 'upload_url', chat_id: chatId, name: file.name, size: file.size, mime: file.type || undefined });
  const { error } = await db.storage.from('outreach-chat-notes').uploadToSignedUrl(r.path, r.token, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error(`Upload failed for ${file.name}: ${error.message}`);
  let width: number | undefined, height: number | undefined;
  if (file.type.startsWith('image/')) {
    try { const dims = await imageDims(file); width = dims.width; height = dims.height; } catch { /* not needed */ }
  }
  return { path: r.path, name: r.name, size: file.size, mime: file.type || null, width, height };
}
function imageDims(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { reject(new Error('not an image')); URL.revokeObjectURL(url); };
    img.src = url;
  });
}
/** 10-minute signed URL of a note attachment; the function checks the note is readable by the caller. */
export async function noteFileUrl(noteId: string, path: string): Promise<string> {
  const r = await callFn<{ url: string }>('note-attachment', { action: 'read_url', note_id: noteId, path });
  return r.url;
}
/** Signed URL of one note attachment. `auto` fetches on mount (image thumbnails); otherwise `load()` fetches on demand. */
export function useNoteFileUrl(noteId: string, path: string, auto = false) {
  const q = useQuery({
    queryKey: ['outreach', 'note', noteId, 'file', path] as const, enabled: auto, staleTime: 9 * 60 * 1000, retry: 0,
    queryFn: () => noteFileUrl(noteId, path),
  });
  const load = useCallback(async () => { if (!q.isFetching) await q.refetch(); }, [q]);
  return { url: q.data ?? null, loading: q.isFetching, error: q.error ? parseError(q.error).message : null, load };
}

// ---------------------------------------------------------------------------------------------------- notifications realtime (bell + alerts)
export interface IncomingNotification {
  id: string; kind: string; chat_id: string | null; note_id: string | null; message_id?: string | null; title: string; body: string | null;
  workspace_id?: string; data?: Record<string, unknown> | null;
}

/**
 * Streams the signed-in user's notification rows (RLS: user_id = auth.uid()), inserts AND updates (reply alerts merge
 * into one row per conversation and are read on every device at once). Each event refreshes the bell and is handed to
 * `onEvent` — the alert engine (lib/outreach/alerts/engine.ts) decides about toast, sound and desktop notification.
 * Mounted once in the outreach Shell; rows of every workspace arrive (alerts name the workspace).
 */
export function useNotificationsRealtime<R extends { workspace_id?: string }>(ws: string | null | undefined, userId: string | null | undefined, onEvent: (row: R, event: 'INSERT' | 'UPDATE') => void) {
  const qc = useQueryClient();
  const cb = useRef(onEvent);
  useEffect(() => { cb.current = onEvent; }, [onEvent]);
  useEffect(() => {
    if (!ws || !userId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = (event: 'INSERT' | 'UPDATE') => (p: any) => {
      const row = p?.new as R | undefined;
      if (!row) return;
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'notes'] });
      cb.current(row, event);
    };
    const ch = db.channel(`outreach-notifications:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'outreach_notifications', filter: `user_id=eq.${userId}` }, handle('INSERT'))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'outreach_notifications', filter: `user_id=eq.${userId}` }, handle('UPDATE'))
      .subscribe();
    return () => { db.removeChannel(ch); };
  }, [ws, userId, qc]);
}

/** Link that opens a conversation on a note (scrolls to it and flashes it). */
export function noteLink(chatId: string, noteId?: string | null): string {
  return noteId ? `/outreach/inbox/${chatId}?note=${noteId}` : `/outreach/inbox/${chatId}`;
}

/** Where a notification opens: a note (mentions, AI handoff notes), else the message (?m= flashes it), else the conversation. */
export function notificationLink(n: { chat_id: string | null; note_id: string | null; message_id?: string | null }): string {
  if (!n.chat_id) return '/outreach/inbox';
  if (n.note_id) return noteLink(n.chat_id, n.note_id);
  return n.message_id ? `/outreach/inbox/${n.chat_id}?m=${n.message_id}` : `/outreach/inbox/${n.chat_id}`;
}

/** The people picker's groups: Team first, then Client viewers (only when the note is shared with the client). */
export function groupMembersForPicker(members: Member[], currentUserId: string | null): Array<{ label: 'Team' | 'Client'; items: Member[] }> {
  const team = members.filter((m) => m.role !== 'client_viewer' && m.user_id !== currentUserId);
  const client = members.filter((m) => m.role === 'client_viewer' && m.user_id !== currentUserId);
  const out: Array<{ label: 'Team' | 'Client'; items: Member[] }> = [];
  if (team.length) out.push({ label: 'Team', items: team });
  if (client.length) out.push({ label: 'Client', items: client });
  return out;
}

/** Memoised member lookup by user id. */
export function useMemberIndex(members: Member[] | undefined) {
  return useMemo(() => new Map((members ?? []).map((m) => [m.user_id, m])), [members]);
}
