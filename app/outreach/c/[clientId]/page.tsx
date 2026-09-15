'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, Inbox, Send } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { qk, useChats, useMessages } from '@/lib/outreach/queries';
import { Avatar, Badge, Button, Card, EmptyState, ErrorBox, IntentBadge, Spinner, Stat, Textarea, fmtDate, timeAgo, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { Client } from '@/lib/outreach/types';

type ClientStats = { leads: number; senders: number; invites_30d: number; accepted_30d: number; messages_30d: number; replies_30d: number; interested_30d: number; enrollments_live: number };

export default function ClientViewerPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params?.clientId;
  const { workspace, canReply } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const client = useQuery({ queryKey: ['outreach', 'client', clientId ?? ''], enabled: !!clientId, queryFn: async () => { const { data, error } = await supabase.from('outreach_clients').select('*').eq('id', clientId!).maybeSingle(); if (error) throw parseError(error); return data as Client | null; } });
  const stats = useQuery({ queryKey: ['outreach', 'client', clientId ?? '', 'stats'], enabled: !!clientId, refetchInterval: 60000, queryFn: () => rpc<ClientStats>('client_stats', { p_client: clientId }) });
  const chats = useChats(ws, { client_id: clientId });
  const chat = useMemo(() => (chats.data ?? []).find((c) => c.id === selected) ?? null, [chats.data, selected]);
  const messages = useMessages(selected);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [messages.data?.length, selected]);

  async function markRead() {
    if (!chat || !chat.unread) return;
    await supabase.from('outreach_chats').update({ unread: false, unread_count: 0 }).eq('id', chat.id);
    qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'chats'] });
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!chat || !text.trim()) return;
    setSending(true);
    try {
      await callFn('send-reply', { chat_id: chat.id, text: text.trim() });
      setText('');
      qc.invalidateQueries({ queryKey: qk.messages(chat.id) }); qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'chats'] });
      toast.show('Reply sent.');
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setSending(false); }
  }

  if (!clientId) return <ErrorBox message="Missing client." />;
  if (client.isLoading) return <Spinner />;
  if (client.isError) return <ErrorBox message={(client.error as Error).message} />;
  if (!client.data || client.data.workspace_id !== ws) return <ErrorBox message="This client is not available in the current workspace." />;
  const c = client.data; const s = stats.data;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3">
          <Link href="/outreach" className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100" aria-label="Back"><ArrowLeft className="w-4 h-4" /></Link>
          <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center"><Building2 className="w-5 h-5" /></div>
          <div><h1 className="text-xl font-bold text-gray-900">{c.name}</h1><div className="text-xs text-gray-500">Client overview · read-only{c.timezone ? ` · ${c.timezone}` : ''}</div></div>
        </div>
        <Badge tone="indigo">Client view</Badge>
      </div>

      {stats.isError ? <ErrorBox message={(stats.error as Error).message} className="mb-6" /> : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Stat label="Leads" value={s ? s.leads.toLocaleString() : '…'} />
          <Stat label="Live enrollments" value={s ? s.enrollments_live : '…'} hint={`${s?.senders ?? '…'} sender${s?.senders === 1 ? '' : 's'}`} />
          <Stat label="Invites (30d)" value={s ? s.invites_30d : '…'} hint={s ? `${s.accepted_30d} accepted` : undefined} />
          <Stat label="Replies (30d)" value={s ? s.replies_30d : '…'} hint={s ? `${s.messages_30d} messages · ${s.interested_30d} interested` : undefined} />
        </div>
      )}

      <Card className="overflow-hidden" title={<span className="flex items-center gap-2"><Inbox className="w-4 h-4" /> Conversations</span>} actions={<span className="text-xs text-gray-400">{chats.data?.length ?? 0} threads</span>}>
        <div className="-m-5 grid grid-cols-1 md:grid-cols-[320px_1fr] min-h-[520px]">
          <div className={cn('border-r border-gray-100 overflow-y-auto max-h-[70vh]', selected && 'hidden md:block')}>
            {chats.isLoading ? <Spinner /> : chats.isError ? <div className="p-4"><ErrorBox message={(chats.error as Error).message} /></div> : !chats.data?.length ? <EmptyState title="No conversations yet" description="Replies to this client's senders appear here." /> : (
              <ul className="divide-y divide-gray-100">
                {chats.data.map((ch) => (
                  <li key={ch.id}>
                    <button type="button" onClick={() => { setSelected(ch.id); }} className={cn('w-full text-left px-4 py-3 hover:bg-gray-50 flex gap-3', selected === ch.id && 'bg-indigo-50')}>
                      <Avatar src={ch.attendee_picture_url ?? ch.outreach_leads?.picture_url} name={ch.attendee_name ?? ch.outreach_leads?.full_name} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2"><span className={cn('text-sm truncate', ch.unread ? 'font-semibold text-gray-900' : 'text-gray-800')}>{ch.attendee_name ?? ch.outreach_leads?.full_name ?? 'Unknown'}</span><span className="text-[11px] text-gray-400 whitespace-nowrap">{timeAgo(ch.last_message_at)}</span></div>
                        <div className="text-xs text-gray-500 truncate">{ch.last_direction === 'out' ? 'You: ' : ''}{ch.last_message_preview ?? ch.subject ?? ''}</div>
                        <div className="flex items-center gap-1.5 mt-1"><IntentBadge intent={ch.intent} />{ch.unread && <span className="w-2 h-2 rounded-full bg-indigo-600" aria-label="unread" />}</div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={cn('flex flex-col max-h-[70vh]', !selected && 'hidden md:flex')}>
            {!chat ? <EmptyState title="Select a conversation" description="Pick a thread on the left to read it." /> : (
              <>
                <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
                  <button type="button" className="md:hidden p-1 rounded text-gray-500 hover:bg-gray-100" onClick={() => setSelected(null)} aria-label="Back to list"><ArrowLeft className="w-4 h-4" /></button>
                  <Avatar src={chat.attendee_picture_url ?? chat.outreach_leads?.picture_url} name={chat.attendee_name ?? chat.outreach_leads?.full_name} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900 truncate">{chat.attendee_name ?? chat.outreach_leads?.full_name ?? 'Unknown'}</div>
                    <div className="text-xs text-gray-500 truncate">{chat.outreach_leads?.headline ?? chat.outreach_leads?.company ?? chat.subject ?? ''} · via {chat.outreach_senders?.display_name ?? 'sender'}</div>
                  </div>
                  <IntentBadge intent={chat.intent} />
                </div>
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/60" onMouseEnter={markRead}>
                  {messages.isLoading ? <Spinner /> : messages.isError ? <ErrorBox message={(messages.error as Error).message} /> : !messages.data?.length ? <div className="text-sm text-gray-400 text-center py-8">No messages.</div> : messages.data.map((m) => (
                    <div key={m.id} className={cn('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                      <div className={cn('max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words', m.direction === 'out' ? 'bg-indigo-600 text-white rounded-br-sm' : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm', m.deleted_at && 'opacity-50 italic')}>
                        {m.is_invite_note && <div className={cn('text-[10px] uppercase tracking-wide mb-1', m.direction === 'out' ? 'text-indigo-200' : 'text-gray-400')}>Invitation note</div>}
                        {m.deleted_at ? 'Message deleted' : m.text ?? (m.attachments?.length ? `${m.attachments.length} attachment(s)` : '')}
                        <div className={cn('text-[10px] mt-1', m.direction === 'out' ? 'text-indigo-200' : 'text-gray-400')}>{fmtDate(m.sent_at)}{m.edited_at ? ' · edited' : ''}</div>
                      </div>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
                {canReply ? (
                  <form onSubmit={send} className="border-t border-gray-100 p-3 flex flex-col gap-2">
                    <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply…" disabled={sending} className="min-h-[70px]" aria-label="Reply" hint="Sent from the sender that owns this thread. If that sender is disconnected the reply is refused." />
                    <div className="flex justify-end"><Button type="submit" size="sm" loading={sending} disabled={!text.trim()}><Send className="w-3.5 h-3.5" /> Send reply</Button></div>
                  </form>
                ) : <div className="border-t border-gray-100 px-4 py-3 text-xs text-gray-400">Read-only: your account cannot reply in this workspace.</div>}
              </>
            )}
          </div>
        </div>
      </Card>
      {toast.node}
    </div>
  );
}
