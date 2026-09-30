'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/utils/supabase/client';
import { rpc, parseError } from '@/lib/crm/api';
import { ACCOUNT_COLORS, RESPONSE_LABEL, calendarApi, fmtDay, hm, nowMinutesIn, shiftDay, todayIn, useCalendarInvalidate, type CalendarAccount, type CalendarEvent, type FreeSlot, type Notify } from '@/lib/crm/calendar';
import { Badge, Button, ErrorBox, Field, Input, Modal, Select, Spinner, Textarea } from '@/components/crm/ui';
import { TimezonePicker } from '@/components/crm/TimezonePicker';
import { convertWallClock, tzOffsetLabel, tzShort } from '@/lib/crm/timezones';
import { inviteDescription, inviteTitle, type InviteVars } from '@/lib/crm/invite';
import { useCrm } from '@/contexts/CrmContext';
import { cn } from '@/lib/utils';
import { Building2, Check, ExternalLink, Link2, MapPin, Pencil, RefreshCw, Star, Trash2, Unplug, Users, Video } from 'lucide-react';

// Google Calendar screen pieces. Every Google call goes through lib/crm/calendar.ts → crm-mcp; only the owning member's
// accounts are editable (mine: true), teammates' events are read-only. Times are minutes-of-day in the team timezone,
// computed on the server so every account lines up on one grid.

type Row = Record<string, any>;
export type ColorOf = (accountId: string) => (typeof ACCOUNT_COLORS)[number];

export function colorMap(accounts: CalendarAccount[]): ColorOf {
  const idx = new Map(accounts.map((a, i) => [a.id, i]));
  return (id) => ACCOUNT_COLORS[(idx.get(id) ?? 0) % ACCOUNT_COLORS.length];
}

// ---------------------------------------------------------------- accounts
export function AccountChips({ accounts, selected, onToggle, colorOf, onManage }: { accounts: CalendarAccount[]; selected: Set<string>; onToggle: (id: string) => void; colorOf: ColorOf; onManage: (a: CalendarAccount) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {accounts.map((a) => {
        const c = colorOf(a.id); const on = selected.has(a.id);
        return (
          <div key={a.id} className={cn('group flex items-center rounded-full border text-xs transition-colors', on ? `${c.bg} ${c.border} ${c.text}` : 'bg-white border-gray-200 text-gray-400')}>
            <button type="button" onClick={() => onToggle(a.id)} className="flex items-center gap-1.5 pl-2 pr-1.5 py-1" title={`${a.email}${a.mine ? '' : ` · ${a.member_name} (view only)`}${a.timezone ? ` · ${a.timezone}` : ''}`}>
              <span className={cn('w-2 h-2 rounded-full', on ? c.dot : 'bg-gray-300')} />
              <span className="font-medium">{a.label || a.email}</span>
              {a.label && <span className="opacity-70 hidden sm:inline">{a.email}</span>}
              {!a.mine && <span className="opacity-70">· {a.member_name}</span>}
              {a.mine && a.is_default && <Star className="w-3 h-3 fill-current opacity-70" aria-label="default" />}
              {a.auth_state !== 'ok' && <span className="text-red-600 font-medium">reconnect</span>}
              {!a.can_write && a.auth_state === 'ok' && <span className="text-amber-700">read-only</span>}
            </button>
            {a.mine && <button type="button" onClick={() => onManage(a)} className="pr-2 pl-0.5 py-1 opacity-50 hover:opacity-100" title="Manage this account" aria-label={`Manage ${a.email}`}><Pencil className="w-3 h-3" /></button>}
          </div>
        );
      })}
    </div>
  );
}

export function AccountModal({ account, open, onClose, onReconnect }: { account: CalendarAccount | null; open: boolean; onClose: () => void; onReconnect: (email: string) => void }) {
  const invalidate = useCalendarInvalidate();
  const [label, setLabel] = useState(''); const [aliases, setAliases] = useState(''); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (open && account) { setLabel(account.label ?? ''); setAliases(account.aliases.join(', ')); setError(null); setConfirmDelete(false); } }, [open, account]);
  if (!account) return null;
  const run = async (what: string, fn: () => Promise<unknown>, close = false) => { setBusy(what); setError(null); try { await fn(); await invalidate(); if (close) onClose(); } catch (e) { setError(parseError(e).message); } finally { setBusy(null); } };
  return (
    <Modal open={open} onClose={onClose} title={<span className="flex items-center gap-2">{account.email}{account.is_default && <Badge tone="indigo">default</Badge>}</span>} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={busy === 'save'} onClick={() => run('save', () => calendarApi.updateAccount(account.id, { label: label || null, aliases: aliases.split(',').map((s) => s.trim()).filter(Boolean) }), true)}>Save</Button></>}>
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Label" placeholder="work / personal" value={label} onChange={(e) => setLabel(e.target.value)} hint="Shown on the chip; your assistant understands it too (“book it from my personal calendar”)" />
          <Input label="Other names (comma separated)" placeholder="kaptured, gmail" value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          {!account.is_default && <Button size="sm" variant="secondary" loading={busy === 'default'} onClick={() => run('default', () => calendarApi.updateAccount(account.id, { is_default: true }))}><Star className="w-3.5 h-3.5" /> Make default</Button>}
          <Button size="sm" variant="secondary" loading={busy === 'refresh'} onClick={() => run('refresh', () => calendarApi.accounts(account.id))}><RefreshCw className="w-3.5 h-3.5" /> Refresh calendar list</Button>
          <Button size="sm" variant="secondary" onClick={() => onReconnect(account.email)}><Link2 className="w-3.5 h-3.5" /> Reconnect</Button>
          {!confirmDelete
            ? <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setConfirmDelete(true)}><Unplug className="w-3.5 h-3.5" /> Disconnect</Button>
            : <Button size="sm" variant="danger" loading={busy === 'delete'} onClick={() => run('delete', () => calendarApi.disconnect(account.id), true)}>Yes, disconnect {account.email}</Button>}
        </div>
        {account.auth_state !== 'ok' && <ErrorBox message={`Google no longer accepts this sign-in${account.auth_error ? ` (${account.auth_error})` : ''}. Reconnect it.`} />}
        {!account.can_write && account.auth_state === 'ok' && <ErrorBox message="Connected read-only: booking will fail. Reconnect and allow every calendar permission." />}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Calendars on this account</div>
          <ul className="space-y-0.5">
            {account.calendars.map((c) => <li key={c.id} className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: c.background_color || '#999' }} /><span className="text-gray-800">{c.summary}</span>{c.primary && <Badge tone="gray">primary</Badge>}<span className="text-[11px] text-gray-400 truncate">{c.id}</span></li>)}
            {account.calendars.length === 0 && <li className="text-gray-400">None listed — refresh.</li>}
          </ul>
        </div>
        <div className="text-xs text-gray-500">Connected {new Date(account.connected_at).toLocaleDateString()}{account.timezone ? ` · calendar timezone ${account.timezone}` : ''}. Disconnecting removes the sign-in from the CRM and revokes it at Google; events stay in Google Calendar.</div>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- CRM meetings without a Google event (shown on the grid as dashed blocks)
export interface CrmOnlyMeeting { meeting_id: string; company_id: string; company_name: string; contact_name: string | null; contact_email: string | null; scheduled_at: string; duration_min: number | null; status: string; day: string; start_min: number; end_min: number; owner_id: string | null }

// ---------------------------------------------------------------- week / day grid
const HOUR_PX = 48;
const MIN_HOUR = 7, MAX_HOUR = 22;

export function TimeGrid({ days, events, crmOnly, tz, colorOf, onEvent, onCrmOnly, onSlot, className }: { className?: string; days: string[]; events: CalendarEvent[]; crmOnly: CrmOnlyMeeting[]; tz: string; colorOf: ColorOf; onEvent: (e: CalendarEvent) => void; onCrmOnly: (m: CrmOnlyMeeting) => void; onSlot: (day: string, startMin: number) => void }) {
  const today = todayIn(tz);
  const [nowMin, setNowMin] = useState(() => nowMinutesIn(tz));
  useEffect(() => { const t = setInterval(() => setNowMin(nowMinutesIn(tz)), 60_000); return () => clearInterval(t); }, [tz]);
  const scroller = useRef<HTMLDivElement>(null);
  const timed = events.filter((e) => !e.all_day), allDay = events.filter((e) => e.all_day);
  // extend the visible hours when something falls outside 07–22
  const lo = Math.min(MIN_HOUR, ...timed.map((e) => Math.floor(e.start_min / 60)), ...crmOnly.map((m) => Math.floor(m.start_min / 60)));
  const hi = Math.max(MAX_HOUR, ...timed.map((e) => Math.ceil(e.end_min / 60)), ...crmOnly.map((m) => Math.ceil(m.end_min / 60)));
  const hours = Array.from({ length: hi - lo }, (_, i) => lo + i);
  const top = (min: number) => ((min - lo * 60) / 60) * HOUR_PX;
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = Math.max(0, top(Math.min(nowMin, 9 * 60)) - 40); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // side-by-side layout for overlapping events in a day
  const laid = useMemo(() => {
    const out = new Map<string, Array<{ e: CalendarEvent; col: number; cols: number }>>();
    for (const day of days) {
      const list = timed.filter((e) => e.day === day).sort((a, b) => a.start_min - b.start_min || b.end_min - a.end_min);
      const placed: Array<{ e: CalendarEvent; col: number; cols: number }> = [];
      let cluster: typeof placed = [], clusterEnd = -1;
      const flush = () => { const n = Math.max(1, ...cluster.map((x) => x.col + 1)); cluster.forEach((x) => { x.cols = n; }); placed.push(...cluster); cluster = []; };
      for (const e of list) {
        if (cluster.length && e.start_min >= clusterEnd) flush();
        const used = new Set(cluster.filter((x) => x.e.end_min > e.start_min).map((x) => x.col));
        let col = 0; while (used.has(col)) col++;
        cluster.push({ e, col, cols: 1 }); clusterEnd = Math.max(clusterEnd, e.end_min);
      }
      if (cluster.length) flush();
      out.set(day, placed);
    }
    return out;
  }, [days, timed]);

  const gridCols = `3.25rem repeat(${days.length}, minmax(0, 1fr))`;
  return (
    <div className={cn('border border-gray-200 rounded-lg bg-white overflow-hidden flex flex-col min-h-[320px]', className)}>
      <div className="grid border-b border-gray-200 bg-gray-50/80" style={{ gridTemplateColumns: gridCols }}>
        <div />
        {days.map((d) => (
          <div key={d} className={cn('px-2 py-1.5 text-center border-l border-gray-100', d === today && 'bg-indigo-50')}>
            <div className="text-[11px] uppercase tracking-wide text-gray-500">{fmtDay(d, { weekday: 'short' })}</div>
            <div className={cn('text-lg font-semibold leading-tight tabular-nums', d === today ? 'text-indigo-700' : 'text-gray-900')}>{fmtDay(d, { day: 'numeric' })}</div>
          </div>
        ))}
        {allDay.length > 0 && <>
          <div className="text-[10px] text-gray-400 px-1 pt-1 text-right">all day</div>
          {days.map((d) => (
            <div key={`ad-${d}`} className="border-l border-t border-gray-100 p-0.5 space-y-0.5 min-h-[1.25rem]">
              {allDay.filter((e) => e.day === d || (e.day < d && e.end > `${d}T`)).map((e) => { const c = colorOf(e.account_id); return <button key={e.id + d} type="button" onClick={() => onEvent(e)} className={cn('block w-full truncate text-left text-[11px] px-1.5 rounded border', c.bg, c.border, c.text, !e.mine && 'opacity-70')}>{e.title}</button>; })}
            </div>
          ))}
        </>}
      </div>
      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="grid relative" style={{ gridTemplateColumns: gridCols, height: hours.length * HOUR_PX }}>
          <div className="relative">
            {hours.map((h) => <div key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-gray-400 tabular-nums" style={{ top: (h - lo) * HOUR_PX }}>{h === lo ? '' : `${String(h).padStart(2, '0')}:00`}</div>)}
          </div>
          {days.map((d) => (
            <div key={d} className={cn('relative border-l border-gray-100', d === today && 'bg-indigo-50/30')}>
              {hours.map((h) => <div key={h} className="absolute inset-x-0 border-t border-gray-100" style={{ top: (h - lo) * HOUR_PX }} onClick={() => onSlot(d, h * 60)} role="presentation" />)}
              {hours.map((h) => <div key={`${h}-half`} className="absolute inset-x-0 border-t border-dashed border-gray-50" style={{ top: (h - lo) * HOUR_PX + HOUR_PX / 2 }} onClick={() => onSlot(d, h * 60 + 30)} role="presentation" />)}
              {d === today && nowMin >= lo * 60 && nowMin <= hi * 60 && <div className="absolute inset-x-0 z-20 pointer-events-none" style={{ top: top(nowMin) }}><div className="h-px bg-red-500" /><div className="w-2 h-2 rounded-full bg-red-500 -mt-1 -ml-1" /></div>}
              {crmOnly.filter((m) => m.day === d).map((m) => (
                <button key={m.meeting_id} type="button" onClick={() => onCrmOnly(m)} title={`${m.company_name}${m.contact_name ? ` · ${m.contact_name}` : ''} — CRM meeting with no Google Calendar event yet`}
                  className="absolute left-0.5 right-0.5 z-[5] rounded border border-dashed border-gray-400 bg-white/80 text-left px-1.5 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 overflow-hidden"
                  style={{ top: top(m.start_min), height: Math.max(18, top(m.end_min) - top(m.start_min) - 2) }}>
                  <span className="font-medium truncate block">{m.company_name}</span><span className="text-gray-500">CRM only · {hm(m.start_min)}</span>
                </button>
              ))}
              {(laid.get(d) ?? []).map(({ e, col, cols }) => {
                const c = colorOf(e.account_id); const h = Math.max(20, top(e.end_min) - top(e.start_min) - 2);
                return (
                  <button key={e.id} type="button" onClick={() => onEvent(e)} title={`${e.when} · ${e.title}${e.mine ? '' : ` (${e.member_name})`}`}
                    className={cn('absolute z-10 rounded border text-left px-1.5 py-0.5 overflow-hidden hover:brightness-95 hover:z-20', c.bg, c.border, c.text, !e.mine && 'opacity-75', e.self_response === 'declined' && 'line-through opacity-50', e.status === 'tentative' && 'border-dashed')}
                    style={{ top: top(e.start_min), height: h, left: `calc(${(100 * col) / cols}% + 2px)`, width: `calc(${100 / cols}% - 4px)` }}>
                    <div className="text-[11px] font-medium leading-tight truncate">{e.title}</div>
                    {h > 30 && <div className="text-[10px] opacity-80 truncate">{hm(e.start_min)}–{hm(e.end_min)}{e.meet ? ' · Meet' : ''}{e.crm?.company ? ` · ${e.crm.company}` : ''}</div>}
                    {h > 46 && !e.mine && <div className="text-[10px] opacity-70 truncate">{e.member_name}</div>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- agenda
export function Agenda({ events, crmOnly, tz, colorOf, onEvent, onCrmOnly }: { events: CalendarEvent[]; crmOnly: CrmOnlyMeeting[]; tz: string; colorOf: ColorOf; onEvent: (e: CalendarEvent) => void; onCrmOnly: (m: CrmOnlyMeeting) => void }) {
  const today = todayIn(tz);
  const days = Array.from(new Set([...events.map((e) => e.day), ...crmOnly.map((m) => m.day)])).sort();
  if (days.length === 0) return <div className="text-sm text-gray-400 py-10 text-center">Nothing in this range.</div>;
  return (
    <div className="space-y-4">
      {days.map((d) => (
        <div key={d}>
          <div className={cn('text-xs font-semibold uppercase tracking-wide mb-1', d === today ? 'text-indigo-700' : 'text-gray-500')}>{fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' })}{d === today ? ' · today' : ''}</div>
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg bg-white">
            {([...events.filter((e) => e.day === d).map((e) => ({ k: e.id, min: e.all_day ? -1 : e.start_min, e, m: undefined as CrmOnlyMeeting | undefined })), ...crmOnly.filter((m) => m.day === d).map((m) => ({ k: m.meeting_id, min: m.start_min, e: undefined as CalendarEvent | undefined, m }))]).sort((a, b) => a.min - b.min).map((row) => {
              if (row.m) { const m = row.m; return <li key={row.k}><button type="button" onClick={() => onCrmOnly(m)} className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 text-sm"><span className="w-24 tabular-nums text-gray-700">{hm(m.start_min)}–{hm(m.end_min)}</span><span className="w-2 h-2 rounded-full border border-dashed border-gray-400" /><span className="font-medium text-gray-900">{m.company_name}</span>{m.contact_name && <span className="text-gray-500">with {m.contact_name}</span>}<Badge tone="gray">CRM only</Badge></button></li>; }
              const e = row.e!; const c = colorOf(e.account_id);
              return (
                <li key={row.k}><button type="button" onClick={() => onEvent(e)} className={cn('w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 text-sm', e.self_response === 'declined' && 'opacity-50')}>
                  <span className="w-24 tabular-nums text-gray-700 shrink-0">{e.all_day ? 'all day' : `${hm(e.start_min)}–${hm(e.end_min)}`}</span>
                  <span className={cn('w-2 h-2 rounded-full shrink-0', c.dot)} />
                  <span className="font-medium text-gray-900 truncate">{e.title}</span>
                  {e.crm?.company && <Badge tone="indigo"><Building2 className="w-3 h-3" /> {e.crm.company}</Badge>}
                  {e.meet && <Video className="w-3.5 h-3.5 text-gray-400" aria-label="Google Meet" />}
                  <span className="ml-auto text-xs text-gray-500 truncate">{e.mine ? e.account_email : e.member_name}{e.attendees.length > 1 ? ` · ${e.attendees.length} guests` : ''}</span>
                </button></li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- event modal (view / edit / create)
export interface EventDraft { day: string; start_min: number; duration_min?: number; account_id?: string; title?: string; attendees?: string; meeting_id?: string; crm?: { company_id: string; company_name: string; contact_id?: string } }
type CompanyHit = { id: string; name: string; domain: string | null };
type ContactHit = { id: string; name: string; email: string | null };

function useCompanySearch(q: string) {
  const [hits, setHits] = useState<CompanyHit[]>([]);
  useEffect(() => {
    const s = q.trim(); if (s.length < 2) { setHits([]); return; }
    let live = true;
    const t = setTimeout(async () => { const { data } = await supabase.from('crm_companies').select('id, name, domain').or(`name.ilike.%${s}%,domain.ilike.%${s}%`).order('name').limit(8); if (live) setHits((data ?? []) as CompanyHit[]); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return hits;
}

const ymdhm = (day: string, min: number) => `${day} ${hm(min)}`;

export function EventModal({ open, onClose, event, draft, accounts, tz, colorOf, onSaved, onReconnect }: { open: boolean; onClose: () => void; event: CalendarEvent | null; draft: EventDraft | null; accounts: CalendarAccount[]; tz: string; colorOf: ColorOf; onSaved?: (msg: string) => void; onReconnect: (email?: string) => void }) {
  const invalidate = useCalendarInvalidate();
  const { timezone: teamTz, me, data: crmData } = useCrm();
  const settings = crmData?.settings ?? {};
  const inviteVars = (contact?: string | null, company?: string | null, notes?: string | null): InviteVars => ({ me: me?.display_name, contact, company, studio: settings.studio_name as string | undefined, notes });
  // What the invite templates last filled in, so a user edit is never overwritten when the contact changes.
  const auto = useRef({ title: '', description: '' });
  const mine = accounts.filter((a) => a.mine);
  const [mode, setMode] = useState<'view' | 'edit' | 'create'>('view');
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [confirmDelete, setConfirmDelete] = useState(false);
  // f.tz: the zone the Day/Start fields are typed in (defaults to the zone the calendar is being viewed in). Sent to the
  // server as `tz`; changing it keeps the wall-clock time, like Google Calendar's own editor.
  const [f, setF] = useState({ account_id: '', calendar: 'primary', title: '', day: '', start: '10:00', duration: '30', all_day: false, attendees: '', description: '', location: '', meet: true, notify: 'all' as Notify, tz });
  const [crm, setCrm] = useState<{ q: string; company: CompanyHit | null; contact_id: string; contacts: ContactHit[] }>({ q: '', company: null, contact_id: '', contacts: [] });
  const [attachOpen, setAttachOpen] = useState(false);
  const hits = useCompanySearch(crm.q);

  useEffect(() => {
    if (!open) return;
    setError(null); setConfirmDelete(false); setAttachOpen(false); auto.current = { title: '', description: '' };
    const defAcc = mine.find((a) => a.is_default)?.id ?? mine[0]?.id ?? '';
    if (event) {
      setMode('view');
      setF({ account_id: event.account_id, calendar: event.calendar_id === event.account_email ? 'primary' : event.calendar_id, title: event.title, day: event.day, start: hm(event.start_min), duration: String(Math.max(5, event.end_min - event.start_min)), all_day: event.all_day, attendees: event.attendees.filter((a) => !a.self).map((a) => a.email).join(', '), description: event.description, location: event.location, meet: !!event.meet, notify: 'all', tz });
      setCrm({ q: '', company: null, contact_id: '', contacts: [] });
    } else if (draft) {
      setMode('create');
      setF({ account_id: draft.account_id ?? defAcc, calendar: 'primary', title: draft.title ?? '', day: draft.day, start: hm(draft.start_min), duration: String(draft.duration_min ?? 30), all_day: false, attendees: draft.attendees ?? '', description: '', location: '', meet: true, notify: 'all', tz });
      setCrm({ q: '', company: draft.crm ? { id: draft.crm.company_id, name: draft.crm.company_name, domain: null } : null, contact_id: draft.crm?.contact_id ?? '', contacts: [] });
    }
  }, [open, event, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // New event with a CRM company/contact attached: fill title + notes from the team's invite templates (Settings →
  // Calendar invites) unless the user already typed their own. Called when the contacts load and when the contact changes.
  const fillInvite = (company: string, contact: string | null) => {
    if (mode !== 'create') return;
    const v = inviteVars(contact, company);
    const next = { title: inviteTitle(settings, v), description: inviteDescription(settings, v) };
    const prev = auto.current; auto.current = next;
    setF((x) => ({ ...x, title: !x.title.trim() || x.title === prev.title ? next.title : x.title, description: !x.description.trim() || x.description === prev.description ? next.description : x.description }));
  };

  useEffect(() => {
    const company = crm.company;
    if (!company) { setCrm((c) => ({ ...c, contacts: [] })); return; }
    const chosen = crm.contact_id;
    supabase.from('crm_contacts').select('id, name, email').eq('company_id', company.id).order('is_primary', { ascending: false }).then(({ data }) => {
      const list = (data ?? []) as ContactHit[];
      setCrm((c) => ({ ...c, contacts: list, contact_id: c.contact_id || list[0]?.id || '' }));
      fillInvite(company.name, list.find((p) => p.id === (chosen || list[0]?.id))?.name ?? null);
    });
  }, [crm.company]); // eslint-disable-line react-hooks/exhaustive-deps

  const acc = accounts.find((a) => a.id === f.account_id);
  const run = async (what: string, fn: () => Promise<string>, close = true) => { setBusy(what); setError(null); try { const msg = await fn(); await invalidate(); onSaved?.(msg); if (close) onClose(); } catch (e) { const err = parseError(e); setError(err.message + (err.code === 'E_CALENDAR_RECONNECT' || err.code === 'E_CALENDAR_SCOPE' ? ' — use Reconnect below.' : '')); } finally { setBusy(null); } };
  const guestEmails = () => f.attendees.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
  const crmPayload = () => (crm.company ? { company: crm.company.id, contact_id: crm.contact_id || undefined } : undefined);
  const startMin = () => { const [h, m] = f.start.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  // "10:00 New York = 19:30 Kolkata (team) · 15:00 London (calendar view)" — only the zones that differ from f.tz.
  const equivalents = (() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.day) || !f.start) return `${tzOffsetLabel(f.tz)} · changing the zone keeps the time you typed.`;
    const others = [{ z: teamTz, note: 'team' }, { z: tz, note: 'calendar view' }].filter((o, i, arr) => o.z !== f.tz && arr.findIndex((x) => x.z === o.z) === i);
    if (others.length === 0) return `${tzOffsetLabel(f.tz)} · changing the zone keeps the time you typed.`;
    const parts = others.map(({ z, note }) => { const c = convertWallClock(f.day, startMin(), f.tz, z); return `${hm(c.min)} ${tzShort(z)}${c.dayDelta ? ` (${c.dayDelta > 0 ? 'next' : 'previous'} day)` : ''} · ${note}`; });
    return `= ${parts.join(' · ')}`;
  })();

  const create = () => run('save', async () => {
    const r = await calendarApi.create({ account: f.account_id, calendar: f.calendar, title: f.title, start: f.all_day ? f.day : ymdhm(f.day, startMin()), duration_min: f.all_day ? undefined : Number(f.duration) || 30, all_day: f.all_day || undefined, attendees: guestEmails(), description: f.description || undefined, location: f.location || undefined, meet: f.meet, notify: f.notify, tz: f.tz, meeting_id: draft?.meeting_id, crm: draft?.meeting_id ? undefined : crmPayload() });
    if (!r.created) throw new CrmErr(`Not created: “${r.event.title}” already starts at that time on ${r.event.account_email}.`);
    return `Booked ${r.event.title} · ${r.event.when}${r.event.meet ? ' · Meet link added' : ''}${guestEmails().length && r.notify !== 'none' ? ' · invites sent' : ''}${r.overlaps.length ? ` · overlaps ${r.overlaps.map((o) => o.title).join(', ')}` : ''}${r.crm_error ? ` · CRM link failed: ${r.crm_error}` : r.event.crm?.company ? ` · linked to ${r.event.crm.company}` : ''}`;
  });
  const save = () => run('save', async () => {
    if (!event) return '';
    const r = await calendarApi.update({ event_id: event.id, account: event.account_id, calendar: f.calendar, title: f.title !== event.title ? f.title : undefined, start: f.all_day ? f.day : ymdhm(f.day, startMin()), duration_min: f.all_day ? undefined : Number(f.duration) || undefined, attendees: guestEmails(), description: f.description !== event.description ? f.description : undefined, location: f.location !== event.location ? f.location : undefined, meet: f.meet && !event.meet ? true : undefined, notify: f.notify, tz: f.tz });
    return `Updated ${r.event.title} · ${r.event.when}${r.meeting_updated ? ' · CRM meeting moved' : ''}${r.not_organizer ? ' · you are not the organizer, only your copy changed' : ''}`;
  });
  const remove = () => run('delete', async () => { if (!event) return ''; const r = await calendarApi.remove({ event_id: event.id, account: event.account_id, calendar: f.calendar, notify: f.notify }); return `Cancelled ${r.title}${r.meeting_cancelled ? ' · CRM meeting cancelled too' : ''}`; });
  const attach = () => run('attach', async () => {
    if (!event || !crm.company) return '';
    const m = await rpc<Row>('schedule_meeting', { p: { company: crm.company.id, contact_id: crm.contact_id || undefined, scheduled_at: event.start, duration_min: Math.max(5, event.end_min - event.start_min), attendees: event.attendees.filter((a) => !a.self).map((a) => a.email), notes: event.description || undefined } });
    await rpc('link_calendar_event', { p_meeting_id: m.id, p: { account_id: event.account_id, calendar_id: f.calendar, event_id: event.id, meet_link: event.meet || null, html_link: event.html_link || null, event_start: event.start, event_end: event.end, summary: event.title } });
    return `Attached to ${crm.company.name} — CRM meeting created`;
  });

  const Form = (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2"><Input label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={inviteTitle(settings, inviteVars('Naman Jain', 'Resourceplan')) || 'Aarushi <> Naman'} autoFocus /></div>
      {mode === 'create' && <Select label="Google account" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value, calendar: 'primary' })}>{mine.map((a) => <option key={a.id} value={a.id}>{a.email}{a.label ? ` (${a.label})` : ''}{a.is_default ? ' · default' : ''}</option>)}</Select>}
      {mode === 'create' && <Select label="Calendar" value={f.calendar} onChange={(e) => setF({ ...f, calendar: e.target.value })}><option value="primary">Primary</option>{(acc?.calendars ?? []).filter((c) => !c.primary && (c.access_role === 'owner' || c.access_role === 'writer')).map((c) => <option key={c.id} value={c.id}>{c.summary}</option>)}</Select>}
      <Input label="Day" type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
      <div className="grid grid-cols-2 gap-2">
        <Input label={`Start (${tzShort(f.tz)})`} type="time" step={300} value={f.start} disabled={f.all_day} onChange={(e) => setF({ ...f, start: e.target.value })} />
        <Input label="Minutes" type="number" min={5} step={5} value={f.duration} disabled={f.all_day} onChange={(e) => setF({ ...f, duration: e.target.value })} />
      </div>
      <div className="col-span-2">
        <Field label="Time zone of the day and start above" hint={f.all_day ? undefined : equivalents}>
          <TimezonePicker value={f.tz} onChange={(z) => setF({ ...f, tz: z })} teamTz={teamTz} />
        </Field>
      </div>
      <div className="col-span-2"><Input label="Guests (emails, comma separated)" value={f.attendees} onChange={(e) => setF({ ...f, attendees: e.target.value })} placeholder="naman@resourceplan.io" /></div>
      <div className="col-span-2 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.meet} disabled={f.all_day} onChange={(e) => setF({ ...f, meet: e.target.checked })} /> Google Meet link</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.all_day} onChange={(e) => setF({ ...f, all_day: e.target.checked, meet: e.target.checked ? false : f.meet })} /> All day</label>
        <label className="flex items-center gap-2">Invites <select className="px-2 py-1 text-sm rounded-md border border-gray-300" value={f.notify} onChange={(e) => setF({ ...f, notify: e.target.value as Notify })}><option value="all">email all guests</option><option value="externalOnly">external guests only</option><option value="none">no emails</option></select></label>
      </div>
      <Input label="Location" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Office / address (leave empty for online)" />
      <div className="col-span-2"><Textarea label="Agenda / notes" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} /></div>
      {mode === 'create' && !draft?.meeting_id && (
        <div className="col-span-2 rounded-md border border-gray-200 p-2.5 bg-gray-50/60">
          <div className="text-xs font-medium text-gray-700 mb-1.5 flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" /> Attach to a CRM company <span className="font-normal text-gray-500">(optional — creates the CRM meeting on their open deal)</span></div>
          <CrmPicker crm={crm} setCrm={setCrm} hits={hits} onContact={(c) => crm.company && fillInvite(crm.company.name, c?.name ?? null)} />
        </div>
      )}
    </div>
  );

  const e = event;
  const View = e && (
    <div className="space-y-3 text-sm">
      <div className="flex items-start gap-2">
        <span className={cn('mt-1.5 w-2.5 h-2.5 rounded-full shrink-0', colorOf(e.account_id).dot)} />
        <div className="min-w-0">
          <div className="text-base font-semibold text-gray-900">{e.title}</div>
          <div className="text-gray-700">{e.when}{e.recurring ? ' · repeats' : ''}</div>
          <div className="text-xs text-gray-500">{e.mine ? e.account_email : `${e.member_name} · ${e.account_email}`}{e.calendar_name && e.calendar_id !== e.account_email ? ` · ${e.calendar_name}` : ''}{!e.organizer_self && e.organizer ? ` · organised by ${e.organizer}` : ''}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {e.meet && <a href={e.meet} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"><Video className="w-4 h-4" /> Join Meet</a>}
        {e.html_link && <a href={e.html_link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"><ExternalLink className="w-4 h-4" /> Open in Google Calendar</a>}
      </div>
      {e.location && <div className="flex items-center gap-2 text-gray-700"><MapPin className="w-4 h-4 text-gray-400" /> {e.location}</div>}
      {e.attendees.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-gray-500 mb-1"><Users className="w-3.5 h-3.5" /> Guests</div>
          <ul className="space-y-0.5">{e.attendees.map((a) => <li key={a.email} className="flex items-center gap-2"><span className={cn('w-1.5 h-1.5 rounded-full', a.response === 'accepted' ? 'bg-green-500' : a.response === 'declined' ? 'bg-red-500' : a.response === 'tentative' ? 'bg-amber-400' : 'bg-gray-300')} /><span className="text-gray-800">{a.name || a.email}</span>{a.name && <span className="text-gray-400 text-xs">{a.email}</span>}<span className="text-xs text-gray-500">{a.organizer ? 'organiser' : RESPONSE_LABEL[a.response ?? ''] ?? a.response ?? ''}</span></li>)}</ul>
        </div>
      )}
      {e.description && <div className="text-gray-700 whitespace-pre-wrap text-[13px] border-l-2 border-gray-200 pl-2">{e.description}</div>}
      <div className="rounded-md border border-gray-200 p-2.5 bg-gray-50/60">
        {e.crm ? (
          <div className="flex items-center gap-2 flex-wrap"><Building2 className="w-4 h-4 text-indigo-600" /><span>CRM meeting with</span><Link href={`/crm/companies/${e.crm.company_id}${e.crm.meeting_id ? `?meeting=${e.crm.meeting_id}` : ''}`} className="font-medium text-indigo-700 hover:underline">{e.crm.company ?? 'company'}</Link>{e.crm.contact && <span className="text-gray-500">· {e.crm.contact}</span>}{e.crm.status && <Badge tone={e.crm.status === 'held' ? 'green' : e.crm.status === 'no_show' ? 'red' : e.crm.status === 'cancelled' ? 'gray' : 'blue'}>{e.crm.status.replace('_', '-')}</Badge>}{e.crm.status === 'scheduled' && <Link href={`/crm/capture?meeting=${e.crm.meeting_id}`} className="text-xs text-indigo-600 hover:underline">capture</Link>}</div>
        ) : !attachOpen ? (
          <button type="button" className="text-sm text-indigo-700 hover:underline inline-flex items-center gap-1.5" onClick={() => setAttachOpen(true)}><Link2 className="w-3.5 h-3.5" /> Attach to a CRM company (creates the CRM meeting)</button>
        ) : (
          <div className="space-y-2"><CrmPicker crm={crm} setCrm={setCrm} hits={hits} /><Button size="sm" disabled={!crm.company} loading={busy === 'attach'} onClick={attach}><Check className="w-3.5 h-3.5" /> Attach</Button></div>
        )}
      </div>
      {!e.mine && <div className="text-xs text-gray-500">This is {e.member_name}'s calendar — view only.</div>}
    </div>
  );

  const title = mode === 'create' ? 'New event' : mode === 'edit' ? 'Edit event' : 'Event';
  const footer = mode === 'view'
    ? <>{e?.mine && (confirmDelete ? <Button variant="danger" loading={busy === 'delete'} onClick={remove}>Yes, cancel it{e.attendees.length > 1 ? ' and tell the guests' : ''}</Button> : <Button variant="ghost" className="text-red-700 mr-auto" onClick={() => setConfirmDelete(true)}><Trash2 className="w-3.5 h-3.5" /> Cancel event</Button>)}<Button variant="secondary" onClick={onClose}>Close</Button>{e?.mine && <Button onClick={() => setMode('edit')}><Pencil className="w-3.5 h-3.5" /> Edit</Button>}</>
    : <><Button variant="secondary" onClick={mode === 'edit' ? () => setMode('view') : onClose}>{mode === 'edit' ? 'Back' : 'Cancel'}</Button><Button loading={busy === 'save'} disabled={!f.title.trim() || !f.day || (mode === 'create' && !f.account_id)} onClick={mode === 'create' ? create : save}>{mode === 'create' ? 'Book' : 'Save'}</Button></>;

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg" footer={footer}>
      {mode === 'view' ? View : mine.length === 0 ? <ErrorBox message="Connect one of your Google accounts first (Connect Google Calendar)." /> : Form}
      {error && <div className="mt-3 space-y-2"><ErrorBox message={error} />{/reconnect/i.test(error) && <Button size="sm" variant="secondary" onClick={() => onReconnect(acc?.email)}>Reconnect {acc?.email}</Button>}</div>}
    </Modal>
  );
}
class CrmErr extends Error {}

function CrmPicker({ crm, setCrm, hits, onContact }: { crm: { q: string; company: CompanyHit | null; contact_id: string; contacts: ContactHit[] }; setCrm: (f: (c: typeof crm) => typeof crm) => void; hits: CompanyHit[]; onContact?: (contact: ContactHit | null) => void }) {
  return crm.company ? (
    <div className="flex items-center gap-2 flex-wrap text-sm">
      <Badge tone="indigo">{crm.company.name}</Badge>
      <select className="px-2 py-1 text-sm rounded-md border border-gray-300" value={crm.contact_id} onChange={(e) => { setCrm((c) => ({ ...c, contact_id: e.target.value })); onContact?.(crm.contacts.find((p) => p.id === e.target.value) ?? null); }}><option value="">no contact</option>{crm.contacts.map((p) => <option key={p.id} value={p.id}>{p.name}{p.email ? ` · ${p.email}` : ''}</option>)}</select>
      <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => setCrm((c) => ({ ...c, company: null, contact_id: '', q: '' }))}>change</button>
    </div>
  ) : (
    <div className="relative">
      <input className="w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-300" placeholder="Search company by name or domain…" value={crm.q} onChange={(e) => setCrm((c) => ({ ...c, q: e.target.value }))} />
      {hits.length > 0 && <ul className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-48 overflow-auto text-sm">{hits.map((h) => <li key={h.id}><button type="button" className="w-full text-left px-2.5 py-1.5 hover:bg-gray-50" onClick={() => setCrm((c) => ({ ...c, company: h, q: '' }))}>{h.name}{h.domain && <span className="text-gray-400"> · {h.domain}</span>}</button></li>)}</ul>}
    </div>
  );
}

// ---------------------------------------------------------------- CRM-only meeting → add to Google Calendar
export function CrmOnlyModal({ meeting, open, onClose, accounts, onSaved }: { meeting: CrmOnlyMeeting | null; open: boolean; onClose: () => void; accounts: CalendarAccount[]; onSaved?: (msg: string) => void }) {
  const invalidate = useCalendarInvalidate();
  const mine = accounts.filter((a) => a.mine);
  const [account, setAccount] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setAccount(mine.find((a) => a.is_default)?.id ?? mine[0]?.id ?? ''); setError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!meeting) return null;
  const add = async () => { setBusy(true); setError(null); try { const r = await calendarApi.createForMeeting(meeting.meeting_id, { account }); await invalidate(); onSaved?.(`Added to Google Calendar · ${r.event.when}${r.event.meet ? ' · Meet link created' : ''}`); onClose(); } catch (e) { setError(parseError(e).message); } finally { setBusy(false); } };
  return (
    <Modal open={open} onClose={onClose} title="CRM meeting" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{mine.length > 0 && <Button loading={busy} onClick={add}><Video className="w-3.5 h-3.5" /> Add to Google Calendar</Button>}</>}>
      <div className="space-y-2 text-sm">
        <div className="font-semibold text-gray-900">{meeting.company_name}{meeting.contact_name ? <span className="font-normal text-gray-600"> · {meeting.contact_name}</span> : null}</div>
        <div className="text-gray-700">{fmtDay(meeting.day, { weekday: 'short', day: 'numeric', month: 'short' })} {hm(meeting.start_min)}–{hm(meeting.end_min)}</div>
        <div className="text-xs text-gray-500">Booked in the CRM but not on any Google Calendar yet. Adding it creates the event with a Meet link and invites {meeting.contact_email ? meeting.contact_email : 'the attendees on the meeting'}.</div>
        {mine.length > 1 && <Select label="On account" value={account} onChange={(e) => setAccount(e.target.value)}>{mine.map((a) => <option key={a.id} value={a.id}>{a.email}{a.label ? ` (${a.label})` : ''}</option>)}</Select>}
        {mine.length === 0 && <ErrorBox message="Connect one of your Google accounts first." />}
        <Link href={`/crm/companies/${meeting.company_id}?meeting=${meeting.meeting_id}`} className="text-xs text-indigo-600 hover:underline">Open in the CRM →</Link>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- free slots
export function FreeSlotsModal({ open, onClose, tz, onPick }: { open: boolean; onClose: () => void; tz: string; onPick: (slot: FreeSlot) => void }) {
  const [f, setF] = useState({ date: '', days: '5', duration: '30', window: '10:00-19:00', with: '', weekdays: true, accounts: 'mine' as 'mine' | 'team' });
  const [res, setRes] = useState<{ slots: FreeSlot[]; checked: string[]; not_visible: string[]; summary: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setF((x) => ({ ...x, date: todayIn(tz) })); setRes(null); setError(null); } }, [open, tz]);
  const find = async () => { setBusy(true); setError(null); try { setRes(await calendarApi.free({ date: f.date, days: Number(f.days) || 1, duration_min: Number(f.duration) || 30, window: f.window, with: f.with.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean), weekdays: f.weekdays, accounts: f.accounts, tz })); } catch (e) { setError(parseError(e).message); } finally { setBusy(false); } };
  return (
    <Modal open={open} onClose={onClose} title="Find a free slot" size="md" footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={busy} onClick={find}>Find</Button></>}>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <Input label="From" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <Input label="Days" type="number" min={1} max={31} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
        <Input label="Minutes" type="number" min={5} step={5} value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} />
        <Input label={`Hours (${tzShort(tz)})`} value={f.window} onChange={(e) => setF({ ...f, window: e.target.value })} placeholder="10:00-19:00" />
        <Select label="Busy time from" value={f.accounts} onChange={(e) => setF({ ...f, accounts: e.target.value as 'mine' | 'team' })}><option value="mine">my accounts</option><option value="team">the whole team</option></Select>
        <label className="flex items-end gap-2 pb-2"><input type="checkbox" checked={f.weekdays} onChange={(e) => setF({ ...f, weekdays: e.target.checked })} /> weekdays only</label>
        <div className="col-span-3"><Input label="Also check these guests (emails)" value={f.with} onChange={(e) => setF({ ...f, with: e.target.value })} hint="Only works when Google lets your account see their calendar (usually colleagues in the same Workspace)." /></div>
      </div>
      {error && <div className="mt-3"><ErrorBox message={error} /></div>}
      {busy && <div className="mt-4 flex justify-center"><Spinner /></div>}
      {res && !busy && (
        <div className="mt-3">
          <div className="text-xs text-gray-500 mb-1.5">Checked {res.checked.join(', ')}{res.not_visible.length ? ` · could not see ${res.not_visible.join(', ')}` : ''}</div>
          {res.slots.length === 0 ? <div className="text-sm text-gray-500">No free slot in that range.</div> : (
            <ul className="max-h-64 overflow-auto divide-y divide-gray-100 border border-gray-200 rounded-md">
              {res.slots.map((s) => <li key={s.start} className="flex items-center justify-between px-3 py-1.5 text-sm"><span className="tabular-nums text-gray-800">{s.label}</span><Button size="xs" onClick={() => onPick(s)}>Book here</Button></li>)}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- connect (paste-back) — hosted app with Desk's desktop client
export function ConnectPasteModal({ open, onClose, link, onConnected }: { open: boolean; onClose: () => void; link: { url: string; hint?: string } | null; onConnected: (msg: string, warn?: boolean) => void }) {
  const invalidate = useCalendarInvalidate();
  const [address, setAddress] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [opened, setOpened] = useState(false);
  useEffect(() => { if (open) { setAddress(''); setError(null); setOpened(false); } }, [open]);
  if (!link) return null;
  const finish = async () => {
    setBusy(true); setError(null);
    try { const r = await calendarApi.finish(address); await invalidate(); onConnected(`Google Calendar connected: ${r.email}${r.warning ? `\n${r.warning}` : ''}${r.note ? `\n${r.note}` : ''}`, !!r.warning); onClose(); }
    catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Connect Google Calendar${link.hint ? ` · ${link.hint}` : ''}`} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!address.includes('code=') && !address.includes('error=')} onClick={finish}><Check className="w-3.5 h-3.5" /> Finish</Button></>}>
      <ol className="space-y-3 text-sm text-gray-700 list-decimal pl-5">
        <li>
          <a href={link.url} target="_blank" rel="noreferrer" onClick={() => setOpened(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700"><ExternalLink className="w-4 h-4" /> Open Google sign-in</a>
          <div className="mt-1 text-xs text-gray-500">Pick the account and allow every calendar permission (it must include <em>view and edit events</em>).</div>
        </li>
        <li>
          Google then opens a page at <code className="text-xs bg-gray-100 px-1 rounded">127.0.0.1:53682</code> that <b>will not load</b> — that is expected. Copy the whole address from that tab's address bar and paste it here:
          <Textarea className="mt-1.5 font-mono text-xs" rows={3} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://127.0.0.1:53682/?state=…&code=…&scope=…" autoFocus={opened} />
        </li>
      </ol>
      <div className="mt-2 text-[11px] text-gray-500">The link works once and expires in 15 minutes. Running the app on localhost skips this step: Google comes straight back.</div>
      {error && <div className="mt-2"><ErrorBox message={error} /></div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- helpers used by the page
export const rangeLabel = (from: string, to: string) => (from === to ? fmtDay(from, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : `${fmtDay(from, { day: 'numeric', month: 'short' })} – ${fmtDay(to, { day: 'numeric', month: 'short', year: 'numeric' })}`);
export { shiftDay };
