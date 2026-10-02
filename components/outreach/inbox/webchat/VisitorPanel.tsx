'use client';

// Contact panel for WEBCHAT threads (web-chat-PRD.md §8): who the visitor is, device + location, the page they are on,
// pages visited, custom attributes, previous conversations, the linked lead with its outreach context, link / convert /
// block actions, data export. Replaces LeadPanel for webchat conversations (the lead itself opens from the link).

import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Ban, Download, ExternalLink, Globe, Link2, MapPin, Monitor, ShieldCheck, UserPlus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpc } from '@/lib/outreach/api';
import type { Chat, Member } from '@/lib/outreach/types';
import { Badge, Button, ErrorBox, Input, Spinner, timeAgo } from '@/components/outreach/ui';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { useVisitorBlock, useVisitorLinkLead, useVisitorUpdate, useWebchatVisitor, type WebchatVisitor } from '@/lib/outreach/webchat';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-2 text-xs"><span className="w-20 flex-shrink-0 text-gray-500">{label}</span><span className="min-w-0 flex-1 text-gray-800 break-words">{children}</span></div>;
}

export default function VisitorPanel({ chat, canWrite, isManager, onClose, toast }: { chat: Chat; workspaceId?: string; canWrite: boolean; isManager: boolean; members?: Member[]; onClose?: () => void; toast: (m: string, kind?: 'error') => void }) {
  const q = useWebchatVisitor(chat.visitor_id);
  const link = useVisitorLinkLead();
  const upd = useVisitorUpdate();
  const block = useVisitorBlock();
  const [edit, setEdit] = useState<null | { name: string; email: string; phone: string; company: string }>(null);
  const v = q.data;

  const startEdit = (x: WebchatVisitor) => setEdit({ name: x.name ?? '', email: x.email ?? '', phone: x.phone ?? '', company: x.company ?? '' });
  const save = async () => { if (!v || !edit) return; try { await upd.mutateAsync({ visitor: v.id, patch: edit }); setEdit(null); toast('Visitor updated'); } catch (e) { toast((e as Error).message, 'error'); } };
  const exportData = async () => { if (!v) return; try { const d = await rpc<unknown>('webchat_visitor_export', { p_id: v.id }); const b = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `visitor-${v.id}.json`; a.click(); } catch (e) { toast((e as Error).message, 'error'); } };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Globe className="w-4 h-4 text-indigo-500" /> Visitor</h3>
        {onClose && <button type="button" onClick={onClose} className="p-1 rounded hover:bg-gray-100" aria-label="Close panel"><X className="w-4 h-4" /></button>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5 text-sm">
        {q.isLoading && <Spinner />}
        {q.error && <ErrorBox message={(q.error as Error).message} />}
        {v && (
          <>
            <section className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-gray-900">{v.name || 'Anonymous visitor'}</span>
                {v.identity_verified ? <Badge tone="green"><ShieldCheck className="w-3 h-3 mr-1 inline" />Verified</Badge> : v.identifier ? <Badge tone="amber">Identified</Badge> : <Badge tone="gray">Anonymous</Badge>}
                {v.email && !v.email_verified && <Badge tone="amber" className="text-[10px]">unverified email</Badge>}
                {v.email_invalid && <Badge tone="red">email bounced</Badge>}
                {v.blocked && <Badge tone="red">Blocked</Badge>}
              </div>
              {edit ? (
                <div className="space-y-2">
                  <Input label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                  <Input label="Email" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
                  <Input label="Phone" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
                  <Input label="Company" value={edit.company} onChange={(e) => setEdit({ ...edit, company: e.target.value })} />
                  <div className="flex gap-2"><Button size="sm" onClick={save} loading={upd.isPending}>Save</Button><Button size="sm" variant="secondary" onClick={() => setEdit(null)}>Cancel</Button></div>
                </div>
              ) : (
                <div className="space-y-1">
                  <Row label="Email">{v.email ?? <span className="text-gray-400">—</span>}</Row>
                  <Row label="Phone">{v.phone ?? <span className="text-gray-400">—</span>}</Row>
                  <Row label="Company">{v.company ?? <span className="text-gray-400">—</span>}</Row>
                  {v.identifier && <Row label="ID">{v.identifier}</Row>}
                  <Row label="Seen">first {timeAgo(v.first_seen_at)}{v.last_seen_at ? ` · last ${timeAgo(v.last_seen_at)}` : ''} · {v.conversation_count} conversation{v.conversation_count === 1 ? '' : 's'}</Row>
                  {canWrite && <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => startEdit(v)}>Edit details</button>}
                </div>
              )}
            </section>

            <section className="space-y-1">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1"><Monitor className="w-3 h-3" /> Device &amp; location</h4>
              <Row label="Browser">{[v.browser, v.os, v.device].filter(Boolean).join(' · ') || '—'}</Row>
              <Row label="Location"><MapPin className="inline w-3 h-3 mr-1 text-gray-400" />{[v.city, v.country].filter(Boolean).join(', ') || '—'}{v.timezone ? ` · ${localTime(v.timezone)} local` : ''}</Row>
              {v.locale && <Row label="Language">{v.locale}</Row>}
              {v.referrer && <Row label="Referrer"><a href={v.referrer} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline break-all">{shortUrl(v.referrer)}</a></Row>}
              {v.utm && Object.keys(v.utm).length > 0 && <Row label="UTM">{Object.entries(v.utm).map(([k, val]) => `${k.replace(/^utm_/, '')}=${val}`).join(' ')}</Row>}
            </section>

            <section className="space-y-1">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Pages</h4>
              {v.current_url && <div className="text-xs"><span className="text-emerald-700 font-medium">Now:</span> <a href={v.current_url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline break-all">{v.current_title || shortUrl(v.current_url)}</a></div>}
              <ul className="space-y-0.5 text-xs text-gray-700 max-h-40 overflow-y-auto">
                {v.pages.map((p, i) => <li key={i} className="flex gap-2"><span className="text-gray-400 flex-shrink-0 w-14">{timeAgo(p.at)}</span><a href={p.url} target="_blank" rel="noopener noreferrer" className="truncate hover:underline" title={p.url}>{p.title || shortUrl(p.url)}</a></li>)}
                {!v.pages.length && <li className="text-gray-400">No page views recorded</li>}
              </ul>
            </section>

            {Object.keys(v.custom_attributes ?? {}).length > 0 && (
              <section className="space-y-1">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Attributes</h4>
                {Object.entries(v.custom_attributes).map(([k, val]) => <Row key={k} label={k}>{typeof val === 'object' ? JSON.stringify(val) : String(val)}</Row>)}
              </section>
            )}
            {chat.custom_attributes && Object.keys(chat.custom_attributes).length > 0 && (
              <section className="space-y-1">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conversation attributes</h4>
                {Object.entries(chat.custom_attributes).map(([k, val]) => <Row key={k} label={k}>{typeof val === 'object' ? JSON.stringify(val) : String(val)}</Row>)}
              </section>
            )}

            <section className="space-y-2">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1"><Link2 className="w-3 h-3" /> Lead</h4>
              {v.lead ? (
                <div className="rounded-lg border border-gray-200 p-2.5 space-y-1.5">
                  <div className="flex items-center gap-2"><span className="font-medium text-gray-900">{v.lead.full_name || v.lead.email_work}</span><Link href={`/outreach/leads/${v.lead.id}`} className="text-gray-400 hover:text-indigo-600" title="Open lead"><ExternalLink className="w-3.5 h-3.5" /></Link></div>
                  {(v.lead.title || v.lead.company) && <div className="text-xs text-gray-600">{[v.lead.title, v.lead.company].filter(Boolean).join(' · ')}</div>}
                  {v.lead.last_replied_at && <div className="text-xs text-gray-600">Last reply {timeAgo(v.lead.last_replied_at)} via {v.lead.last_replied_channel}</div>}
                  {v.lead.enrollments.length > 0 && (
                    <ul className="text-xs space-y-0.5">{v.lead.enrollments.slice(0, 5).map((e) => <li key={e.id} className="flex items-center gap-1.5"><ProviderLogo provider={e.provider} className="w-3 h-3" /><span className="truncate">{e.sequence}</span><Badge tone={e.status === 'exited_replied' ? 'green' : e.status === 'active' ? 'indigo' : 'gray'} className="text-[10px]">{e.status.replace(/_/g, ' ')}</Badge></li>)}</ul>
                  )}
                  {v.lead.relations.length > 0 && (
                    <ul className="text-xs space-y-0.5 text-gray-600">{v.lead.relations.slice(0, 5).map((r, i) => <li key={i} className="flex items-center gap-1.5"><ProviderLogo provider={r.provider} className="w-3 h-3" />{r.sender}: {r.relation}{r.last_inbound_at ? ` · replied ${timeAgo(r.last_inbound_at)}` : ''}</li>)}</ul>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-xs text-gray-500">Not linked to a lead.</p>
                  {v.lead_candidates.map((c) => <button key={c.id} type="button" disabled={!canWrite || link.isPending} className="w-full text-left text-xs rounded-lg border border-gray-200 px-2.5 py-1.5 hover:border-indigo-400" onClick={() => link.mutate({ visitor: v.id, lead: c.id }, { onError: (e) => toast((e as Error).message, 'error') })}>Link to <b>{c.full_name || c.email_work}</b>{c.company ? ` (${c.company})` : ''} — same email</button>)}
                  {canWrite && (v.email || v.phone) && <Button size="sm" variant="secondary" loading={link.isPending} onClick={() => link.mutate({ visitor: v.id, lead: null }, { onSuccess: () => toast('Lead created'), onError: (e) => toast((e as Error).message, 'error') })}><UserPlus className="w-3.5 h-3.5 mr-1" />Convert to lead</Button>}
                </div>
              )}
            </section>

            {v.conversations.length > 1 && (
              <section className="space-y-1">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conversations</h4>
                <ul className="text-xs space-y-1">{v.conversations.map((c) => <li key={c.id}><Link href={`/outreach/inbox/${c.id}`} className={cn('block rounded-md border px-2 py-1 hover:border-indigo-400', c.id === chat.id ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200')}><span className="text-gray-500">{timeAgo(c.last_message_at || c.created_at)} · {c.status}{c.csat ? ` · CSAT ${c.csat.rating}` : ''}</span><br /><span className="text-gray-800 truncate block">{c.preview || '—'}</span></Link></li>)}</ul>
              </section>
            )}

            {v.events.length > 0 && (
              <section className="space-y-1">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Timeline</h4>
                <ul className="text-xs space-y-0.5 text-gray-700 max-h-40 overflow-y-auto">{v.events.map((e, i) => <li key={i}><span className="text-gray-400 w-14 inline-block">{timeAgo(e.at)}</span>{e.name.replace(/_/g, ' ')}{e.props && Object.keys(e.props).length ? <span className="text-gray-400"> · {JSON.stringify(e.props).slice(0, 60)}</span> : null}</li>)}</ul>
              </section>
            )}

            <section className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
              {canWrite && <Button size="sm" variant={v.blocked ? 'secondary' : 'danger'} loading={block.isPending} onClick={() => { if (!v.blocked && !window.confirm('Block this visitor? Their messages are dropped silently from now on.')) return; block.mutate({ inbox: v.inbox_id, visitor: v.id, block: !v.blocked }, { onError: (e) => toast((e as Error).message, 'error') }); }}><Ban className="w-3.5 h-3.5 mr-1" />{v.blocked ? 'Unblock' : 'Block visitor'}</Button>}
              {isManager && <Button size="sm" variant="secondary" onClick={exportData}><Download className="w-3.5 h-3.5 mr-1" />Export data</Button>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function shortUrl(u: string): string { try { const x = new URL(u); return (x.host + x.pathname).replace(/\/$/, ''); } catch { return u; } }
function localTime(tz: string): string { try { return new Date().toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }); } catch { return ''; } }
