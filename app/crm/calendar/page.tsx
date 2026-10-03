'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useCrm } from '@/contexts/CrmContext';
import { parseError } from '@/lib/crm/api';
import { calendarApi, dayIn, minutesIn, mondayOf, shiftDay, todayIn, useCalendarAccounts, useCalendarEvents, useCalendarInvalidate, type CalendarAccount, type CalendarEvent, type FreeSlot } from '@/lib/crm/calendar';
import { AccountChips, AccountModal, Agenda, ConnectPasteModal, CrmOnlyModal, EventModal, FreeSlotsModal, TimeGrid, colorMap, rangeLabel, type CrmOnlyMeeting, type EventDraft } from '@/components/crm/calendar';
import { Button, EmptyState, ErrorBox, PageHeader, Spinner, useToast } from '@/components/crm/ui';
import { TimezonePicker } from '@/components/crm/TimezonePicker';
import { tzOffsetLabel, tzShort, useViewTimezone } from '@/lib/crm/timezones';
import { cn } from '@/lib/utils';
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, Link2, Search } from 'lucide-react';

// Calendar: every Google account the team has connected, on one grid. The grid is drawn in a "view" timezone (team
// default, India, US, UK or any IANA zone — remembered per browser); the server converts everything to it. Members
// connect their own accounts (several allowed, one default); teammates' events are visible but only the owner
// books/moves/cancels. CRM meetings that have no Google event yet appear as dashed blocks so they can be added in one click.

type View = 'day' | 'week' | 'agenda';

export default function CalendarPage() {
  const { timezone: teamTz, me } = useCrm();
  const router = useRouter();
  const search = useSearchParams();
  const { show, node: toast } = useToast();
  const invalidate = useCalendarInvalidate();
  const [timezone, setTimezone, tzReady] = useViewTimezone(teamTz);

  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(() => todayIn(teamTz));
  const [calendars, setCalendars] = useState<'primary' | 'all'>('primary');
  const [selected, setSelected] = useState<Set<string> | null>(null);   // null = all accounts
  const [eventFor, setEventFor] = useState<CalendarEvent | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [manage, setManage] = useState<CalendarAccount | null>(null);
  const [crmOnlyFor, setCrmOnlyFor] = useState<CrmOnlyMeeting | null>(null);
  const [freeOpen, setFreeOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pasteLink, setPasteLink] = useState<{ url: string; hint?: string } | null>(null);

  const accountsQ = useCalendarAccounts();
  const accounts = accountsQ.data?.accounts ?? [];
  const configured = accountsQ.data?.configured ?? true;
  const mine = accounts.filter((a) => a.mine);
  const colorOf = useMemo(() => colorMap(accounts), [accounts]);

  // range
  const from = view === 'week' ? mondayOf(anchor) : view === 'day' ? anchor : anchor;
  const to = view === 'week' ? shiftDay(from, 6) : view === 'day' ? anchor : shiftDay(anchor, 13);
  const days = useMemo(() => Array.from({ length: view === 'week' ? 7 : 1 }, (_, i) => shiftDay(from, i)), [from, view]);
  const activeIds = useMemo(() => (selected ? accounts.filter((a) => selected.has(a.id)) : accounts).map((a) => a.id), [accounts, selected]);

  const eventsQ = useCalendarEvents({ from, to, accounts: activeIds.length && activeIds.length !== accounts.length ? activeIds : 'team', calendars, tz: timezone }, accounts.length > 0 && configured && tzReady);
  const events = useMemo(() => (eventsQ.data?.events ?? []).filter((e) => activeIds.includes(e.account_id)), [eventsQ.data, activeIds]);

  // CRM meetings in range with no Google event
  const crmOnlyQ = useQuery({
    queryKey: ['crm', 'calendar', 'crm-only', from, to, timezone],
    queryFn: async () => {
      const { data, error } = await supabase.from('crm_meetings_v').select('id, company_id, company_name, contact_name, contact_email, scheduled_at, duration_min, status, owner_id, has_calendar_event')
        .gte('scheduled_at', `${from}T00:00:00+14:00`).lte('scheduled_at', `${to}T23:59:59-12:00`).eq('status', 'scheduled').eq('has_calendar_event', false);
      if (error) throw parseError(error);
      return ((data ?? []) as any[]).map((m): CrmOnlyMeeting => { const s = minutesIn(m.scheduled_at, timezone); return { meeting_id: m.id, company_id: m.company_id, company_name: m.company_name, contact_name: m.contact_name, contact_email: m.contact_email, scheduled_at: m.scheduled_at, duration_min: m.duration_min, status: m.status, owner_id: m.owner_id, day: dayIn(m.scheduled_at, timezone), start_min: s, end_min: Math.min(1440, s + (m.duration_min ?? 30)) }; }).filter((m) => m.day >= from && m.day <= to);
    },
  });
  const crmOnly = crmOnlyQ.data ?? [];

  // ?calendar=connected|error after the Google round-trip
  useEffect(() => {
    const st = search.get('calendar');
    if (!st) return;
    if (st === 'connected') { show(`Google Calendar connected: ${search.get('account') ?? ''}${search.get('warning') ? `\n${search.get('warning')}` : ''}${search.get('note') ? `\n${search.get('note')}` : ''}`, search.get('warning') ? 'error' : 'success', 6000); invalidate(); }
    else show(`Could not connect Google Calendar: ${search.get('reason') ?? 'unknown error'}`, 'error', 9000);
    router.replace('/crm/calendar');
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async (hint?: string) => {
    setConnecting(true);
    try {
      const r = await calendarApi.connectUrl(hint, `${window.location.origin}/crm/calendar`);
      if (r.mode === 'auto') { window.location.href = r.url; return; }
      setPasteLink({ url: r.url, hint });
    } catch (e) { show(parseError(e).message, 'error'); }
    setConnecting(false);
  };

  const go = (n: number) => setAnchor((a) => shiftDay(a, view === 'week' ? 7 * n : view === 'day' ? n : 14 * n));
  const newEvent = (day = anchor, startMin = 10 * 60) => { setEventFor(null); setDraft({ day, start_min: startMin }); };
  const pickSlot = (s: FreeSlot) => { setFreeOpen(false); setEventFor(null); setDraft({ day: s.day, start_min: minutesIn(s.start, timezone), duration_min: Math.min(60, Math.round((new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000)) }); };

  const loading = accountsQ.isLoading;
  const err = accountsQ.error ? parseError(accountsQ.error) : eventsQ.error ? parseError(eventsQ.error) : null;

  return (
    // Full-height column (viewport minus the shell padding, plus the mobile top bar) so the grid fills the screen and
    // scrolls inside itself instead of leaving dead space under a fixed-height box.
    <div className="flex flex-col h-[calc(100dvh-5rem)] md:h-[calc(100dvh-1.5rem)] min-h-[520px]">
      <PageHeader title="Calendar" subtitle={`${accounts.length ? `${accounts.length} connected account${accounts.length === 1 ? '' : 's'} · ` : ''}times in ${tzShort(timezone)} (${tzOffsetLabel(timezone)})${timezone !== teamTz ? ` · team default is ${tzShort(teamTz)}` : ''}`}
        actions={<div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setFreeOpen(true)} disabled={mine.length === 0}><Search className="w-3.5 h-3.5" /> Find a slot</Button>
          <Button size="sm" onClick={() => newEvent()} disabled={mine.length === 0}><CalendarPlus className="w-3.5 h-3.5" /> New event</Button>
          <Button variant={mine.length ? 'secondary' : 'primary'} size="sm" loading={connecting} onClick={() => connect(mine.length ? undefined : me?.email ?? undefined)} disabled={!configured}><Link2 className="w-3.5 h-3.5" /> {mine.length ? 'Connect another account' : 'Connect Google Calendar'}</Button>
        </div>} />

      {!configured && <ErrorBox message="Google Calendar is not set up on the server yet. An admin runs scripts/crm-set-calendar-secrets.sh (docs/crm/SETUP.md → Google Calendar); everything else in the CRM works meanwhile." />}
      {err && <ErrorBox message={err.message} />}

      {loading ? <div className="py-16 flex justify-center"><Spinner /></div> : accounts.length === 0 ? (
        <EmptyState icon={<CalendarDays className="w-8 h-8" />} title="No Google Calendar connected yet" description="Connect your Google account (work, personal, or both). The team sees each other's meetings here; booking a CRM meeting then also creates the Google event with a Meet link and invites."
          action={configured ? <Button loading={connecting} onClick={() => connect(me?.email ?? undefined)}><Link2 className="w-4 h-4" /> Connect Google Calendar</Button> : undefined} />
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-1">
              <Button variant="secondary" size="xs" onClick={() => setAnchor(todayIn(timezone))}>Today</Button>
              <button type="button" onClick={() => go(-1)} className="p-1 rounded hover:bg-gray-100 text-gray-600" aria-label="Previous"><ChevronLeft className="w-4 h-4" /></button>
              <button type="button" onClick={() => go(1)} className="p-1 rounded hover:bg-gray-100 text-gray-600" aria-label="Next"><ChevronRight className="w-4 h-4" /></button>
              <span className="ml-1 text-sm font-semibold text-gray-900">{rangeLabel(from, to)}</span>
              {eventsQ.isFetching && <Spinner className="w-3.5 h-3.5 ml-1" />}
            </div>
            <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5 text-xs">
              {(['day', 'week', 'agenda'] as View[]).map((v) => <button key={v} type="button" onClick={() => setView(v)} className={cn('px-2.5 py-1 rounded capitalize', view === v ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>{v}</button>)}
            </div>
            <TimezonePicker compact value={timezone} onChange={setTimezone} teamTz={teamTz} />
            <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={calendars === 'all'} onChange={(e) => setCalendars(e.target.checked ? 'all' : 'primary')} /> all calendars (not just primary)</label>
            <div className="ml-auto"><AccountChips accounts={accounts} selected={new Set(activeIds)} onToggle={(id) => setSelected((s) => { const n = new Set(s ?? accounts.map((a) => a.id)); if (n.has(id)) n.delete(id); else n.add(id); return n.size === accounts.length ? null : n; })} colorOf={colorOf} onManage={setManage} /></div>
          </div>

          {eventsQ.data?.errors?.length ? <ErrorBox message={eventsQ.data.errors.map((e) => `${e.account}: ${e.message}`).join(' · ')} /> : null}

          {view === 'agenda'
            ? <div className="flex-1 min-h-0 overflow-y-auto"><Agenda events={events} crmOnly={crmOnly} tz={timezone} colorOf={colorOf} onEvent={setEventFor} onCrmOnly={setCrmOnlyFor} /></div>
            : <TimeGrid className="flex-1 min-h-0" days={days} events={events} crmOnly={crmOnly} tz={timezone} colorOf={colorOf} onEvent={setEventFor} onCrmOnly={setCrmOnlyFor} onSlot={(d, m) => mine.length && newEvent(d, m)} />}
          {view !== 'agenda' && <div className="text-[11px] text-gray-500 shrink-0">Click an empty slot to book · dashed blocks are CRM meetings with no Google event yet · teammates' events are lighter and view-only.</div>}
        </div>
      )}

      <EventModal open={!!eventFor || !!draft} onClose={() => { setEventFor(null); setDraft(null); }} event={eventFor} draft={draft} accounts={accounts} tz={timezone} colorOf={colorOf} onSaved={(m) => show(m)} onReconnect={(email) => connect(email)} />
      <AccountModal account={manage} open={!!manage} onClose={() => setManage(null)} onReconnect={(email) => connect(email)} />
      <CrmOnlyModal meeting={crmOnlyFor} open={!!crmOnlyFor} onClose={() => setCrmOnlyFor(null)} accounts={accounts} onSaved={(m) => show(m)} />
      <FreeSlotsModal open={freeOpen} onClose={() => setFreeOpen(false)} tz={timezone} onPick={pickSlot} />
      <ConnectPasteModal open={!!pasteLink} onClose={() => setPasteLink(null)} link={pasteLink} onConnected={(m, warn) => show(m, warn ? 'error' : 'success', 6000)} />
      {toast}
    </div>
  );
}
