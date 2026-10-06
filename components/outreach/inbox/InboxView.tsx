'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useRouter, useSearchParams } from '@/lib/outreach/nav';
import { notePreview } from './notes/NoteBody';
import { useChatNotes, useCreateNote, useDeleteNote, useMarkNoteRead, useUpdateNote, type ChatNote, type NoteAttachment, type NoteVisibility } from '@/lib/outreach/notes';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSessionUser } from '@/lib/outreach/session';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { db } from '@/lib/outreach/backend';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { patchChatInLists, qk, useChat, useChats, useClients, useMembers, useMessages, useSenders, useSequences, type ChatFilters } from '@/lib/outreach/queries';
import { CHAT_IDS_FETCH_LIMIT, useChatsByIds, useSequenceChatIds } from '@/lib/outreach/intel';
import type { Chat, Intent, Message } from '@/lib/outreach/types';
import { EmptyState, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import ChatList from './ChatList';
import Thread, { type ConvertKind } from './Thread';
import LeadPanel from './LeadPanel';
import VisitorPanel from './webchat/VisitorPanel';
import ColumnResizer, { usePaneWidth } from './ColumnResizer';
import { isTypingTarget, useDebounced, useMediaQuery, useNoZoom } from './hooks';
import { usePersistedFilters } from '@/lib/outreach/persistedFilters';
import { useStageOptions } from './ai/useAiInbox';
import { useChatAiState } from '@/lib/outreach/aiReplies';
import { SENT_FILTER_DEFAULTS, sanitizeSentFilters, useInboxCounts, useSentList, useSentSearch, writeInboxViewState, type InboxView as InboxListView, type SentFilters, type SentItem, type SentSegment } from '@/lib/outreach/inboxSent';
import InboxViewSwitch from './InboxViewSwitch';
import SentList from './sent/SentList';
import SentDetail from './sent/SentDetail';
import AlertPromptBanner from '../alerts/AlertPromptBanner';


/** `?chats=<ids>&label=<text>`: the reports page opens the inbox on exactly these threads. */
export interface InboxRestrict { ids: string[]; label: string }
type InboxFilters = ChatFilters & { sequence_id?: string | null };

// Filters are remembered per workspace in this browser; the search is never stored (it is not a key of the defaults).
const LIST_MIN = 260, LIST_MAX = 640, PANEL_MIN = 280, PANEL_MAX = 560, THREAD_MIN = 360;

const INBOX_FILTER_DEFAULTS: InboxFilters = { sender_id: null, client_id: null, intent: null, unread: null, assigned_to: null, provider: null, archived: false, sequence_id: null, ai: null, stage: null, chip: 'all' };
const SEGMENTS: SentSegment[] = ['sent', 'scheduled', 'failed'];

/**
 * The inbox: list | thread | lead panel. The list column has two views (inbox-replies-sent-PRD.md): Replies
 * (conversations where the other person has written, the default) and Sent (one row per send: Sent · Scheduled · Failed).
 * `listView` comes from the route: /outreach/inbox/sent, or `?view=sent` beside an open conversation.
 */
export default function InboxView({ chatId, initialFilters, restrict, listView = 'replies', segment: segmentProp, sentItemId }: {
  chatId: string | null; initialFilters?: Partial<InboxFilters>; restrict?: InboxRestrict | null;
  listView?: InboxListView; segment?: SentSegment | null; sentItemId?: string | null;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useSessionUser();
  const { workspace, canWrite, canReply, suspended, isManager, isClientViewer } = useWorkspace();
  const ws = workspace?.id ?? null;
  const tz = ((workspace?.settings as Record<string, unknown> | undefined)?.timezone as string | undefined) ?? null;
  const toast = useToast();
  const userId = user?.id ?? null;
  // Private notes: `?note=<id>` deep link (scroll + flash), `?view=mentions` opens the Mentions view of the list.
  const params = useSearchParams();
  const noteParam = params.get('note');
  const messageParam = params.get('m');
  const segment: SentSegment = segmentProp && SEGMENTS.includes(segmentProp) ? segmentProp : 'sent';
  const sentView = listView === 'sent';
  const [mentionsView, setMentionsView] = useState(params.get('view') === 'mentions');
  const notesQ = useChatNotes(chatId);
  const createNote = useCreateNote(ws ?? '');
  const updateNote = useUpdateNote(ws ?? '');
  const deleteNote = useDeleteNote(ws ?? '');
  const markNoteRead = useMarkNoteRead(ws ?? '');
  const [taskPrefill, setTaskPrefill] = useState<{ title: string; body: string; assigned_to: string | null } | null>(null);

  // URL params (e.g. from dashboard links) override the remembered filters.
  const { filters, patch: patchFilters, ready: filtersReady } = usePersistedFilters<InboxFilters>('inbox', ws, INBOX_FILTER_DEFAULTS, { overrides: initialFilters ?? null });
  const [search, setSearch] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [convert, setConvert] = useState<ConvertKind | null>(null);
  const debouncedSearch = useDebounced(search.trim(), 300);
  // the lead panel docks only where the thread still keeps a comfortable width beside it; below that it slides over
  const isXl = useMediaQuery('(min-width: 1440px)');
  // phones: typing or tapping in the inbox never zooms the page
  useNoZoom();
  // Draggable column widths (remembered in this browser); the thread keeps at least THREAD_MIN px.
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [listW, setListW] = usePaneWidth('list', LIST_MIN, LIST_MAX);
  const [panelW, setPanelW] = usePaneWidth('panel', PANEL_MIN, PANEL_MAX);
  const spaceFor = (other: RefObject<HTMLElement | null>, cap: number) => () =>
    Math.min(cap, (rootRef.current?.clientWidth ?? 0) - (other.current?.offsetWidth ?? 0) - THREAD_MIN);


  // Replies: only conversations where they wrote; a reports drill-down (?chats=) shows exactly the threads it names
  const effectiveFilters = useMemo<ChatFilters>(() => { const { sequence_id: _seq, ...rest } = filters; return { ...rest, view: restrict ? 'all' : 'replies', chip: rest.chip ?? 'all', search: debouncedSearch || undefined }; }, [filters, debouncedSearch, restrict]);

  // ---------------------------------------------------------------- Sent (075)
  const { filters: sentFilters, patch: patchSentFilters, ready: sentReady } = usePersistedFilters<SentFilters>('inbox-sent', ws, SENT_FILTER_DEFAULTS, { sanitize: sanitizeSentFilters });
  const [sentSearch, setSentSearch] = useState('');
  const debouncedSentSearch = useDebounced(sentSearch.trim(), 300);
  const countsQ = useInboxCounts(ws, { assigned_to: filters.assigned_to, sender_id: filters.sender_id, client_id: filters.client_id, provider: filters.provider });
  const showSent = countsQ.data?.show_sent !== false;
  const sentQ = useSentList(sentReady && showSent ? ws : null, segment, sentFilters, debouncedSentSearch, { enabled: sentView });
  const sentMatchesQ = useSentSearch(showSent ? ws : null, debouncedSearch, !sentView && !mentionsView);
  const sentRows = sentQ.data;
  const sentItem = useMemo(() => (sentItemId ? sentRows?.find((r) => r.id === sentItemId) ?? null : null), [sentItemId, sentRows]);
  const segQs = segment !== 'sent' ? `segment=${segment}` : '';
  const switchView = useCallback((v: InboxListView) => {
    writeInboxViewState(ws, { view: v });
    router.replace(v === 'sent' ? `/outreach/inbox/sent${segQs ? `?${segQs}` : ''}` : '/outreach/inbox');
  }, [ws, router, segQs]);
  const setSegment = useCallback((s: SentSegment) => {
    writeInboxViewState(ws, { view: 'sent', segment: s });
    router.replace(`/outreach/inbox/sent${s !== 'sent' ? `?segment=${s}` : ''}`);
  }, [ws, router]);
  // a Sent row opens the conversation at that message; a send without one (planned, failed, a request with no
  // conversation yet) opens its detail pane
  const openSentChat = useCallback((it: SentItem) => {
    if (!it.chat_id) { router.replace(`/outreach/inbox/sent?${segQs ? `${segQs}&` : ''}item=${it.id}`); return; }
    router.replace(`/outreach/inbox/${it.chat_id}?view=sent${segQs ? `&${segQs}` : ''}${it.message_id ? `&m=${it.message_id}` : ''}`);
    setPanelOpen(false);
  }, [router, segQs]);
  const selectSent = useCallback((it: SentItem) => {
    if (it.chat_id && it.message_id && it.src === 'message') openSentChat(it);
    else router.replace(`/outreach/inbox/sent?${segQs ? `${segQs}&` : ''}item=${it.id}`);
  }, [openSentChat, router, segQs]);
  const openSentLead = useCallback((it: SentItem) => { if (it.lead?.id) router.push(`/outreach/leads/${it.lead.id}`); }, [router]);
  // Replies search → "Show all" in the Sent group: Sent with the same search
  const showAllSent = useCallback(() => { setSentSearch(search.trim()); switchView('sent'); }, [search, switchView]);
  const openFromSearch = useCallback((it: SentItem) => {
    writeInboxViewState(ws, { view: 'sent', segment: 'sent' });
    if (it.chat_id) router.replace(`/outreach/inbox/${it.chat_id}?view=sent${it.message_id ? `&m=${it.message_id}` : ''}`);
    else router.replace(`/outreach/inbox/sent?item=${it.id}`);
  }, [ws, router]);
  // client viewers without "Show Sent to clients" never stay on Sent
  useEffect(() => { if (sentView && countsQ.data && !countsQ.data.show_sent) router.replace('/outreach/inbox'); }, [sentView, countsQ.data, router]);
  useEffect(() => { if (sentView) writeInboxViewState(ws, { view: 'sent', segment }); }, [sentView, ws, segment]);

  // Restrictions by thread id: the reports drill-down (?chats=) and the sequence filter (outreach_sequence_chat_ids).
  const sequenceId = filters.sequence_id ?? null;
  const seqIdsQ = useSequenceChatIds(sequenceId);
  const restrictKey = restrict ? restrict.ids.join(',') : '';
  const restrictIds = useMemo<string[] | null>(() => {
    const fromUrl = restrict ? restrict.ids : null;
    const fromSeq = sequenceId ? (seqIdsQ.data ? Array.from(seqIdsQ.data) : []) : null;
    if (fromUrl && fromSeq) { const s = new Set(fromSeq); return fromUrl.filter((id) => s.has(id)); }
    return fromUrl ?? fromSeq;
  }, [restrictKey, sequenceId, seqIdsQ.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const waitingForSeq = !!sequenceId && seqIdsQ.isLoading;
  const fetchByIds = !!restrictIds && !waitingForSeq && restrictIds.length <= CHAT_IDS_FETCH_LIMIT;
  const listQ = useChats(fetchByIds || waitingForSeq || !filtersReady ? null : ws, effectiveFilters);
  const byIdsQ = useChatsByIds(fetchByIds && filtersReady ? ws : null, fetchByIds ? restrictIds : null, effectiveFilters);
  const chatsQ = fetchByIds ? byIdsQ : listQ;
  const sendersQ = useSenders(ws);
  const sequencesQ = useSequences(ws);
  // A remembered sequence filter that no longer exists (deleted, other workspace) is dropped instead of erroring.
  useEffect(() => {
    if (sequenceId && sequencesQ.data && !sequencesQ.data.some((s) => s.id === sequenceId)) patchFilters({ sequence_id: null });
  }, [sequenceId, sequencesQ.data, patchFilters]);
  const clientsQ = useClients(ws);
  const membersQ = useMembers(ws);
  const chatQ = useChat(chatId);
  const messagesQ = useMessages(chatId);
  // AI replies v2: stages are per sequence prompt; the Stage filter lists the open chat's stages (defaults otherwise)
  const chatAiQ = useChatAiState(chatId);
  const stageOptions = useStageOptions(ws, chatAiQ.data?.stages);

  const rows = useMemo(() => {
    if (waitingForSeq) return undefined;
    if (fetchByIds || !restrictIds) return chatsQ.data;
    const allowed = new Set(restrictIds);
    return chatsQ.data?.filter((c) => allowed.has(c.id));
  }, [waitingForSeq, fetchByIds, restrictIds, chatsQ.data]);
  const listError = seqIdsQ.error ?? chatsQ.error;
  const listNote = restrictIds && !fetchByIds && !waitingForSeq ? `This filter matches ${restrictIds.length.toLocaleString()} conversations. Matching ones appear as the list loads.` : null;
  // More rows load as the list is scrolled (the by-ids list is fetched whole, so it has no further pages).
  const hasMore = !fetchByIds && !waitingForSeq && !!listQ.hasNextPage;
  const loadingMore = !fetchByIds && listQ.isFetchingNextPage;
  const loadMore = useCallback(() => { if (!fetchByIds && listQ.hasNextPage && !listQ.isFetchingNextPage) listQ.fetchNextPage(); }, [fetchByIds, listQ.hasNextPage, listQ.isFetchingNextPage, listQ.fetchNextPage]); // eslint-disable-line react-hooks/exhaustive-deps
  const chat = chatQ.data ?? null;

  // Keep the drill-down in the URL while moving between threads.
  const restrictQs = useMemo(() => (restrict ? `?chats=${encodeURIComponent(restrict.ids.join(','))}&label=${encodeURIComponent(restrict.label)}` : ''), [restrictKey, restrict?.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const mentionsQs = mentionsView ? (restrictQs ? '&view=mentions' : '?view=mentions') : '';
  const select = useCallback((id: string) => { router.replace(`/outreach/inbox/${id}${restrictQs}${mentionsQs}`); setPanelOpen(false); }, [router, restrictQs, mentionsQs]);
  const sentBackUrl = `/outreach/inbox/sent${segQs ? `?${segQs}` : ''}`;
  const selectMention = useCallback((id: string, noteId: string) => { router.replace(`/outreach/inbox/${id}?note=${noteId}&view=mentions`); setPanelOpen(false); }, [router]);
  const back = useCallback(() => router.replace(sentView ? sentBackUrl : `/outreach/inbox${restrictQs}${mentionsQs}`), [router, restrictQs, mentionsQs, sentView, sentBackUrl]);
  const clearRestrict = useCallback(() => router.replace(chatId ? `/outreach/inbox/${chatId}` : '/outreach/inbox'), [router, chatId]);

  // ---------------------------------------------------------------- chat mutations
  const updateChat = useCallback(async (id: string, patch: Partial<Chat>, silent = false) => {
    const listKey = ['outreach', ws ?? '', 'chats'] as const;
    qc.setQueryData(qk.chat(id), (old: any) => (old ? { ...old, ...patch } : old));
    patchChatInLists(qc, ws ?? '', id, patch);
    const { error } = await db.from('outreach_chats').update(patch).eq('id', id);
    if (error) {
      qc.invalidateQueries({ queryKey: qk.chat(id) });
      qc.invalidateQueries({ queryKey: listKey });
      if (!silent) toast.show(parseError(error).message, 'error');
      throw parseError(error);
    }
    qc.invalidateQueries({ queryKey: qk.dashboard(ws ?? '') });
  }, [qc, ws, toast]);

  // Reply alerts: opening a conversation reads your alerts on it, on every device (the bell, the desktop notification).
  useEffect(() => {
    if (!chatId) return;
    rpc('alerts_mark_chat_read', { p_chat: chatId }).catch(() => { /* alerts are best effort */ });
  }, [chatId]);

  // Mark read when the chat opens (or when a new unread message arrives while it is open).
  useEffect(() => {
    if (!chat || !chat.unread || suspended) return;
    updateChat(chat.id, { unread: false, unread_count: 0 }, true).catch(() => { /* surfaced via query invalidation */ });
    // WhatsApp: the phone shows the chat as read too, and the contact gets the blue ticks (as when it is opened in the app)
    if (chat.provider === 'WHATSAPP') callFn('edit-message', { chat_id: chat.id, action: 'read' }).catch(() => { /* best effort: the inbox state is already updated */ });
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
    if (archived !== !!filters.archived && !sentView) {
      // It just left the current list: move on to the next row for a smooth keyboard flow.
      const idx = rows?.findIndex((r) => r.id === chat.id) ?? -1;
      const next = rows?.[idx + 1] ?? rows?.[idx - 1];
      if (next) select(next.id); else back();
    }
  }, [chat, updateChat, toast, filters.archived, rows, select, back, sentView]);
  const markUnread = useCallback(async () => {
    if (!chat) return;
    await updateChat(chat.id, { unread: true, unread_count: Math.max(1, chat.unread_count) });
    if (chat.provider === 'WHATSAPP') callFn('edit-message', { chat_id: chat.id, action: 'unread' }).catch(() => { /* best effort */ });
    toast.show('Marked as unread');
    if (sentView) return;
    const idx = rows?.findIndex((r) => r.id === chat.id) ?? -1;
    const next = rows?.[idx + 1];
    if (next) select(next.id); else back();
  }, [chat, updateChat, toast, rows, select, back, sentView]);

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
  const onActionHandled = useCallback(() => { setConvert(null); setTaskPrefill(null); }, []);

  // ---------------------------------------------------------------- private notes
  const addNote = useCallback(async (body: string, visibility: NoteVisibility, attachments: NoteAttachment[]) => {
    if (!chat) return;
    const n = await createNote.mutateAsync({ chatId: chat.id, body, visibility, attachments });
    const dropped = n.dropped_mentions?.filter((d) => d.reason !== 'self') ?? [];
    if (dropped.length) toast.show(`${dropped.map((d) => d.name).join(', ')} ${dropped.length === 1 ? "can't" : "can't"} see this conversation — ${dropped.length === 1 ? 'they were' : 'they were'} not notified.`, 'error');
    else if (n.mentions.length) toast.show(`Note added · ${n.mentions.map((m) => m.name).join(', ')} notified`);
    else toast.show('Note added');
  }, [chat, createNote, toast]);
  const updateNoteFn = useCallback(async (noteId: string, patch: { body?: string; visibility?: NoteVisibility }) => {
    if (!chat) return;
    const n = await updateNote.mutateAsync({ noteId, chatId: chat.id, ...patch });
    const dropped = n.dropped_mentions?.filter((d) => d.reason !== 'self') ?? [];
    if (dropped.length) toast.show(`${dropped.map((d) => d.name).join(', ')} can't see this conversation — not notified.`, 'error');
    else toast.show(patch.visibility && !patch.body ? (patch.visibility === 'team' ? 'Note hidden from the client' : 'Note visible to the client') : 'Note updated');
  }, [chat, updateNote, toast]);
  const deleteNoteFn = useCallback(async (noteId: string) => {
    if (!chat) return;
    await deleteNote.mutateAsync({ noteId, chatId: chat.id });
    toast.show('Note deleted');
  }, [chat, deleteNote, toast]);
  const makeTaskFromNote = useCallback((n: ChatNote) => {
    // PRD §5: the task form opens pre-filled with the note text, linked to the conversation, assigned to the first person mentioned
    const text = notePreview(n.body, 2000);
    setTaskPrefill({ title: text.slice(0, 120) || 'Follow up', body: text, assigned_to: n.mentions.find((m) => m.access)?.user_id ?? null });
    setConvert('task'); setPanelOpen(true);
  }, []);
  const noteSeen = useCallback((noteId: string) => { markNoteRead.mutate({ noteId, chatId: chat?.id }); }, [markNoteRead, chat?.id]);

  // ---------------------------------------------------------------- keyboard: j/k/e/u
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (sentView || !rows?.length) return;
      const idx = chatId ? rows.findIndex((r) => r.id === chatId) : -1;
      if (e.key === 'j') { e.preventDefault(); const n = rows[Math.min(rows.length - 1, idx + 1)]; if (n && n.id !== chatId) select(n.id); }
      else if (e.key === 'k') { e.preventDefault(); const n = rows[Math.max(0, idx - 1)]; if (n && n.id !== chatId) select(n.id); }
      else if (e.key === 'e' && chat && canWrite) { e.preventDefault(); archive(!chat.archived); }
      else if (e.key === 'u' && chat && canWrite) { e.preventDefault(); markUnread(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, chatId, chat, canWrite, select, archive, markUnread, sentView]);

  if (!ws) return null;

  const showList = !chatId && !(sentView && sentItemId);
  return (
    <div className="-mx-4 md:-mx-6 -my-6 h-[calc(100dvh_-_3.5rem_-_var(--demo-bar,0px))] md:h-[calc(100dvh_-_var(--demo-bar,0px))] min-h-[520px] flex flex-col bg-white border-t border-gray-200 md:border md:rounded-none overflow-hidden">
      {/* Reply alerts: the app's own prompt, before the browser's (reply-notifications-PRD.md §5.1) */}
      {ws && <AlertPromptBanner ws={ws} userId={userId} className="mb-0 rounded-none border-x-0 border-t-0" />}
      <div ref={rootRef} className="flex flex-1 min-h-0">
      {/* Left: chat list */}
      <aside
        ref={listRef}
        style={listW ? ({ '--inbox-list-w': `${listW}px` } as CSSProperties) : undefined}
        className={cn('w-full flex-shrink-0 border-r border-gray-200 min-h-0', listW ? 'md:w-[var(--inbox-list-w)] md:max-w-[50%]' : 'md:w-72 lg:w-80 2xl:w-96', showList ? 'flex' : 'hidden md:flex', 'flex-col')}
      >
        <InboxViewSwitch view={sentView ? 'sent' : 'replies'} onChange={switchView} unread={countsQ.data?.replies_unread ?? 0} failed={countsQ.data?.failed ?? 0} showSent={showSent} />
        {sentView ? (
          <SentList
            ws={ws} segment={segment} onSegment={setSegment} counts={countsQ.data ?? null}
            rows={sentRows} loading={!sentReady || sentQ.isLoading} error={sentQ.error ? parseError(sentQ.error).message : null}
            hasMore={!!sentQ.hasNextPage} loadingMore={sentQ.isFetchingNextPage} onLoadMore={() => { if (sentQ.hasNextPage && !sentQ.isFetchingNextPage) sentQ.fetchNextPage(); }}
            filters={sentFilters} onFilters={patchSentFilters} search={sentSearch} onSearch={setSentSearch}
            senders={sendersQ.data} clients={clientsQ.data} sequences={sequencesQ.data}
            selectedId={sentItemId ?? (messageParam ? sentRows?.find((r) => r.message_id === messageParam)?.id ?? null : null)}
            onSelect={selectSent} onOpenChat={openSentChat} onOpenLead={openSentLead}
            canWrite={canWrite && !isClientViewer} isManager={isManager} tz={tz} toast={toast.show}
          />
        ) : (
        <ChatList
          rows={rows} loading={!filtersReady || chatsQ.isLoading || waitingForSeq} error={listError ? parseError(listError).message : null}
          sequences={sequencesQ.data} sequenceId={sequenceId} onSequence={(id) => patchFilters({ sequence_id: id })}
          restrictLabel={restrict?.label ?? null} restrictCount={restrict?.ids.length ?? 0} onClearRestrict={clearRestrict} note={listNote}
          filters={filters} onFilters={patchFilters} search={search} onSearch={setSearch}
          senders={sendersQ.data} clients={clientsQ.data} currentUserId={userId} selectedId={chatId} onSelect={select} stages={stageOptions}
          hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore}
          ws={ws} mentionsView={mentionsView} onMentionsView={(v) => { setMentionsView(v); router.replace(chatId ? `/outreach/inbox/${chatId}${v ? '?view=mentions' : ''}` : `/outreach/inbox${v ? '?view=mentions' : ''}`); }} onSelectMention={selectMention}
          needsReply={countsQ.data?.needs_reply} sentMatches={showSent ? sentMatchesQ.data?.items : undefined} onOpenSent={openFromSearch} onShowAllSent={showSent ? showAllSent : undefined}
        />
        )}
      </aside>
      <ColumnResizer className="hidden md:block" paneRef={listRef} edge="right" min={LIST_MIN} max={spaceFor(panelRef, LIST_MAX)} onResize={setListW} />

      {/* Middle: thread */}
      <main className={cn('flex-1 min-w-0 min-h-0', showList ? 'hidden md:flex' : 'flex', 'flex-col')}>
        {!chatId && sentView && sentItem && (
          <SentDetail ws={ws} item={sentItem} onBack={() => router.replace(sentBackUrl)} onOpenChat={openSentChat} onOpenLead={openSentLead}
            canWrite={canWrite && !isClientViewer} isManager={isManager} tz={tz} toast={toast.show} />
        )}
        {!chatId && sentView && sentItemId && !sentItem && (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            {sentQ.isLoading ? <Spinner /> : <EmptyState icon={<Send className="w-6 h-6" />} title="This send is not in the list" description="It may have gone out, been cancelled, or fall outside the filters and period you picked." />}
          </div>
        )}
        {!chatId && !(sentView && sentItemId) && (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            {sentView
              ? <EmptyState icon={<Send className="w-6 h-6" />} title="Select a send" description="A sent message opens in its conversation; planned and failed sends open here with what you can do about them." />
              : <EmptyState icon={<MessageSquare className="w-6 h-6" />} title="Select a conversation" description="Use j / k to move between conversations, e to archive, u to mark unread." />}
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
            onNotice={(m) => toast.show(m)}
            notes={notesQ.data} currentUserId={userId} isManager={isManager} isClientViewer={isClientViewer} highlightNoteId={noteParam} highlightMessageId={messageParam}
            onAddNote={addNote} onUpdateNote={updateNoteFn} onDeleteNote={deleteNoteFn} onMakeTaskFromNote={makeTaskFromNote} onNoteSeen={noteSeen}
          />
        )}
      </main>

      {/* Right: lead panel (inline on xl, slide-over below) */}
      {chat && (
        <>
          {isXl && (
            <>
            <ColumnResizer paneRef={panelRef} edge="left" min={PANEL_MIN} max={spaceFor(listRef, PANEL_MAX)} onResize={setPanelW} />
            <aside ref={panelRef} style={panelW ? { width: panelW, maxWidth: '40%' } : undefined} className="flex w-80 flex-shrink-0 border-l border-gray-200 min-h-0 flex-col">
              {chat.provider === 'WEBCHAT'
                ? <VisitorPanel chat={chat} workspaceId={ws} canWrite={canWrite} isManager={isManager} members={membersQ.data} toast={toast.show} />
                : <LeadPanel chat={chat} workspaceId={ws} canWrite={canWrite} members={membersQ.data} currentUserId={userId} requestedAction={convert} taskPrefill={taskPrefill} onActionHandled={onActionHandled} toast={toast.show} />}
            </aside>
            </>
          )}
          {!isXl && panelOpen && (
            <div className="fixed inset-0 z-40 flex justify-end">
              <div className="absolute inset-0 bg-black/30" onClick={() => setPanelOpen(false)} />
              <div className="relative w-full max-w-sm h-full bg-white shadow-xl flex flex-col">
                {chat.provider === 'WEBCHAT'
                  ? <VisitorPanel chat={chat} workspaceId={ws} canWrite={canWrite} isManager={isManager} members={membersQ.data} onClose={() => setPanelOpen(false)} toast={toast.show} />
                  : <LeadPanel chat={chat} workspaceId={ws} canWrite={canWrite} members={membersQ.data} currentUserId={userId} requestedAction={convert} taskPrefill={taskPrefill} onActionHandled={onActionHandled} onClose={() => setPanelOpen(false)} toast={toast.show} />}
              </div>
            </div>
          )}
        </>
      )}
      </div>
      {toast.node}
    </div>
  );
}
