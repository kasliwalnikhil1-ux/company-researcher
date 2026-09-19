'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { supabase } from '@/utils/supabase/client';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { qk, useChat, useChats, useClients, useMembers, useMessages, useSenders, type ChatFilters } from '@/lib/outreach/queries';
import type { Chat, Intent, Message } from '@/lib/outreach/types';
import { EmptyState, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import ChatList from './ChatList';
import Thread, { type ConvertKind } from './Thread';
import LeadPanel from './LeadPanel';
import { isTypingTarget, useDebounced, useMediaQuery } from './hooks';

const FILTERS_KEY = 'outreach-inbox-filters';

function loadFilters(): ChatFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) { const f = JSON.parse(raw); if (f && typeof f === 'object') return { ...f, search: undefined }; }
  } catch { /* ignore */ }
  return {};
}

export default function InboxView({ chatId, initialFilters }: { chatId: string | null; initialFilters?: Partial<ChatFilters> }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { workspace, canWrite, canReply, suspended } = useWorkspace();
  const ws = workspace?.id ?? null;
  const toast = useToast();
  const userId = user?.id ?? null;

  const [filters, setFilters] = useState<ChatFilters>({});
  const [search, setSearch] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [convert, setConvert] = useState<ConvertKind | null>(null);
  const debouncedSearch = useDebounced(search.trim(), 300);
  const isXl = useMediaQuery('(min-width: 1280px)');

  useEffect(() => {
    // URL params (e.g. from dashboard links) override the remembered filters.
    setFilters(initialFilters ? { ...loadFilters(), ...initialFilters } : loadFilters());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const patchFilters = useCallback((patch: Partial<ChatFilters>) => {
    setFilters((f) => {
      const next = { ...f, ...patch };
      try { localStorage.setItem(FILTERS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const effectiveFilters = useMemo<ChatFilters>(() => ({ ...filters, search: debouncedSearch || undefined }), [filters, debouncedSearch]);
  const chatsQ = useChats(ws, effectiveFilters);
  const sendersQ = useSenders(ws);
  const clientsQ = useClients(ws);
  const membersQ = useMembers(ws);
  const chatQ = useChat(chatId);
  const messagesQ = useMessages(chatId);

  const rows = chatsQ.data;
  const chat = chatQ.data ?? null;

  const select = useCallback((id: string) => { router.replace(`/outreach/inbox/${id}`); setPanelOpen(false); }, [router]);
  const back = useCallback(() => router.replace('/outreach/inbox'), [router]);

  // ---------------------------------------------------------------- chat mutations
  const updateChat = useCallback(async (id: string, patch: Partial<Chat>, silent = false) => {
    const listKey = ['outreach', ws ?? '', 'chats'] as const;
    qc.setQueryData(qk.chat(id), (old: any) => (old ? { ...old, ...patch } : old));
    qc.setQueriesData<any[]>({ queryKey: listKey }, (old) => old?.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const { error } = await supabase.from('outreach_chats').update(patch).eq('id', id);
    if (error) {
      qc.invalidateQueries({ queryKey: qk.chat(id) });
      qc.invalidateQueries({ queryKey: listKey });
      if (!silent) toast.show(parseError(error).message, 'error');
      throw parseError(error);
    }
    qc.invalidateQueries({ queryKey: qk.dashboard(ws ?? '') });
  }, [qc, ws, toast]);

  // Mark read when the chat opens (or when a new unread message arrives while it is open).
  useEffect(() => {
    if (!chat || !chat.unread || suspended) return;
    updateChat(chat.id, { unread: false, unread_count: 0 }, true).catch(() => { /* surfaced via query invalidation */ });
  }, [chat?.id, chat?.unread, suspended]); // eslint-disable-line react-hooks/exhaustive-deps

  const setIntent = useCallback(async (intent: Intent) => {
    if (!chat) return;
    try {
      // Server-side override: updates the chat and its latest inbound message, audited.
      await rpc('set_intent', { p_chat: chat.id, p_intent: intent });
      qc.setQueryData(qk.chat(chat.id), (prev: any) => (prev ? { ...prev, intent } : prev));
      qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'chats'] });
      qc.invalidateQueries({ queryKey: qk.messages(chat.id) });
      toast.show(`Intent set to ${intent.replace(/_/g, ' ')}`);
    } catch (e) {
      toast.show(parseError(e).message, 'error');
    }
  }, [chat, ws, qc, toast]);

  const assign = useCallback(async (assigned_to: string | null) => { if (chat) await updateChat(chat.id, { assigned_to }); }, [chat, updateChat]);
  const archive = useCallback(async (archived: boolean) => {
    if (!chat) return;
    await updateChat(chat.id, { archived });
    toast.show(archived ? 'Conversation archived' : 'Conversation restored');
    if (archived !== !!filters.archived) {
      // It just left the current list: move on to the next row for a smooth keyboard flow.
      const idx = rows?.findIndex((r) => r.id === chat.id) ?? -1;
      const next = rows?.[idx + 1] ?? rows?.[idx - 1];
      if (next) select(next.id); else back();
    }
  }, [chat, updateChat, toast, filters.archived, rows, select, back]);
  const markUnread = useCallback(async () => {
    if (!chat) return;
    await updateChat(chat.id, { unread: true, unread_count: Math.max(1, chat.unread_count) });
    toast.show('Marked as unread');
    const idx = rows?.findIndex((r) => r.id === chat.id) ?? -1;
    const next = rows?.[idx + 1];
    if (next) select(next.id); else back();
  }, [chat, updateChat, toast, rows, select, back]);

  const editMessage = useCallback(async (message_id: string, text: string) => {
    if (!chat) return;
    try {
      await callFn('edit-message', { message_id, action: 'edit', text });
      qc.setQueryData<Message[]>(qk.messages(chat.id), (old) => old?.map((m) => (m.id === message_id ? { ...m, text, edited_at: new Date().toISOString() } : m)));
      qc.invalidateQueries({ queryKey: qk.messages(chat.id) });
      toast.show('Message edited');
    } catch (e) { toast.show(parseError(e).message, 'error'); throw e; }
  }, [chat, qc, toast]);
  const deleteMessage = useCallback(async (message_id: string) => {
    if (!chat) return;
    try {
      await callFn('edit-message', { message_id, action: 'delete' });
      qc.setQueryData<Message[]>(qk.messages(chat.id), (old) => old?.map((m) => (m.id === message_id ? { ...m, deleted_at: new Date().toISOString() } : m)));
      qc.invalidateQueries({ queryKey: qk.messages(chat.id) });
      toast.show('Message deleted');
    } catch (e) { toast.show(parseError(e).message, 'error'); throw e; }
  }, [chat, qc, toast]);

  const onConvert = useCallback((kind: ConvertKind) => { setConvert(kind); setPanelOpen(true); }, []);
  const onActionHandled = useCallback(() => setConvert(null), []);

  // ---------------------------------------------------------------- keyboard: j/k/e/u
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (!rows?.length) return;
      const idx = chatId ? rows.findIndex((r) => r.id === chatId) : -1;
      if (e.key === 'j') { e.preventDefault(); const n = rows[Math.min(rows.length - 1, idx + 1)]; if (n && n.id !== chatId) select(n.id); }
      else if (e.key === 'k') { e.preventDefault(); const n = rows[Math.max(0, idx - 1)]; if (n && n.id !== chatId) select(n.id); }
      else if (e.key === 'e' && chat && canWrite) { e.preventDefault(); archive(!chat.archived); }
      else if (e.key === 'u' && chat && canWrite) { e.preventDefault(); markUnread(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, chatId, chat, canWrite, select, archive, markUnread]);

  if (!ws) return null;

  const showList = !chatId;
  return (
    <div className="-mx-4 md:-mx-6 -my-6 h-[calc(100dvh-6.5rem-1px)] md:h-[calc(100dvh-3rem-1px)] min-h-[520px] flex bg-white border-t border-gray-200 md:border md:rounded-none overflow-hidden">
      {/* Left: chat list */}
      <aside className={cn('w-full md:w-80 lg:w-96 flex-shrink-0 border-r border-gray-200 min-h-0', showList ? 'flex' : 'hidden md:flex', 'flex-col')}>
        <ChatList
          rows={rows} loading={chatsQ.isLoading} error={chatsQ.error ? parseError(chatsQ.error).message : null}
          filters={filters} onFilters={patchFilters} search={search} onSearch={setSearch}
          senders={sendersQ.data} clients={clientsQ.data} currentUserId={userId} selectedId={chatId} onSelect={select}
        />
      </aside>

      {/* Middle: thread */}
      <main className={cn('flex-1 min-w-0 min-h-0', showList ? 'hidden md:flex' : 'flex', 'flex-col')}>
        {!chatId && (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <EmptyState icon={<MessageSquare className="w-6 h-6" />} title="Select a conversation" description="Use j / k to move between conversations, e to archive, u to mark unread." />
          </div>
        )}
        {chatId && chatQ.isLoading && <Spinner className="flex-1" />}
        {chatId && chatQ.error && <div className="p-4"><ErrorBox message={parseError(chatQ.error).message} /></div>}
        {chat && (
          <Thread
            chat={chat}
            messages={messagesQ.data}
            messagesLoading={messagesQ.isLoading}
            messagesError={messagesQ.error ? parseError(messagesQ.error).message : null}
            members={membersQ.data}
            workspaceId={ws}
            canWrite={canWrite}
            canReply={canReply}
            suspended={suspended}
            onBack={back}
            onTogglePanel={() => setPanelOpen((o) => !o)}
            onSetIntent={setIntent}
            onAssign={assign}
            onArchive={archive}
            onMarkUnread={markUnread}
            onConvert={onConvert}
            onEditMessage={editMessage}
            onDeleteMessage={deleteMessage}
            onError={(m) => toast.show(m, 'error')}
          />
        )}
      </main>

      {/* Right: lead panel (inline on xl, slide-over below) */}
      {chat && (
        <>
          {isXl && (
            <aside className="flex w-80 flex-shrink-0 border-l border-gray-200 min-h-0 flex-col">
              <LeadPanel chat={chat} workspaceId={ws} canWrite={canWrite} members={membersQ.data} currentUserId={userId} requestedAction={convert} onActionHandled={onActionHandled} toast={toast.show} />
            </aside>
          )}
          {!isXl && panelOpen && (
            <div className="fixed inset-0 z-40 flex justify-end">
              <div className="absolute inset-0 bg-black/30" onClick={() => setPanelOpen(false)} />
              <div className="relative w-full max-w-sm h-full bg-white shadow-xl flex flex-col">
                <LeadPanel chat={chat} workspaceId={ws} canWrite={canWrite} members={membersQ.data} currentUserId={userId} requestedAction={convert} onActionHandled={onActionHandled} onClose={() => setPanelOpen(false)} toast={toast.show} />
              </div>
            </div>
          )}
        </>
      )}
      {toast.node}
    </div>
  );
}
