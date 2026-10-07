'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Copy, ExternalLink, BellOff, Bell, Power } from 'lucide-react';
import { rpc } from '@/lib/outreach/api';
import { Button, Modal, Select, Spinner, Table, Td, Th, Textarea, timeAgo, useToast } from '@/components/outreach/ui';
import { InfoTip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import {
  AREA_LABELS, AREA_ORDER, GLOSSARY, STATUS_DOT, STATUS_LABELS, STATUS_RANK, STATUS_TEXT,
  claudePrompt, fmtValue, guideLinks, guideOf, limitText, whatToDo,
  type HealthCheck, type HealthOverview, type HealthStatus,
} from '@/lib/outreach/health';
import Sparkline from './Sparkline';

/** Plain words with a `?` meaning (§3.3): wraps the eight glossary terms wherever they appear in a line. */
export function Words({ text }: { text: string }) {
  const terms = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(${terms.map((t) => t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})s?\\b`, 'i');
  const parts: React.ReactNode[] = [];
  let rest = text, i = 0;
  while (rest) {
    const m = re.exec(rest);
    if (!m) { parts.push(rest); break; }
    parts.push(rest.slice(0, m.index));
    const key = m[1].toLowerCase();
    parts.push(<InfoTip key={i++} text={GLOSSARY[key]}>{m[0]}</InfoTip>);
    rest = rest.slice(m.index + m[0].length);
  }
  return <>{parts}</>;
}

function Dot({ status, className }: { status: HealthStatus; className?: string }) {
  return <span className={cn('inline-block w-2.5 h-2.5 rounded-full shrink-0', STATUS_DOT[status], className)} aria-label={STATUS_LABELS[status]} title={STATUS_LABELS[status]} />;
}

/** Any evidence list rendered as a table; scalars as a definition list; `samples` (metrics history) as a short list. */
function Evidence({ ev }: { ev: Record<string, unknown> | null }) {
  if (!ev) return <div className="text-sm text-gray-500">No evidence recorded.</div>;
  const entries = Object.entries(ev).filter(([k]) => k !== 'live_query');
  const lists = entries.filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) as Array<[string, Array<Record<string, unknown>>]>;
  const scalars = entries.filter(([, v]) => v != null && (typeof v !== 'object' || (Array.isArray(v) && (!v.length || typeof v[0] !== 'object'))));
  return (
    <div className="space-y-3">
      {scalars.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
          {scalars.map(([k, v]) => <div key={k} className="flex gap-2 min-w-0"><dt className="text-gray-500 capitalize shrink-0">{k.replace(/_/g, ' ')}</dt><dd className="text-gray-900 tabular-nums truncate">{Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : typeof v === 'number' ? v.toLocaleString('en-US') : String(v)}</dd></div>)}
        </dl>
      )}
      {lists.map(([k, rows]) => {
        const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !/_id$/.test(c) || rows.length < 3);
        return (
          <div key={k}>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1 capitalize">{k.replace(/_/g, ' ')}</div>
            <div className="overflow-x-auto">
              <Table>
                <thead><tr>{cols.map((c) => <Th key={c} className="capitalize">{c.replace(/_/g, ' ')}</Th>)}</tr></thead>
                <tbody>{rows.slice(0, 12).map((r, i) => <tr key={i}>{cols.map((c) => <Td key={c} className={cn('max-w-[28rem] truncate', typeof r[c] === 'number' && 'tabular-nums')} title={typeof r[c] === 'string' ? (r[c] as string) : undefined}>{r[c] == null ? <span className="text-gray-300">—</span> : typeof r[c] === 'object' ? JSON.stringify(r[c]) : typeof r[c] === 'number' ? (r[c] as number).toLocaleString('en-US') : /^\d{4}-\d{2}-\d{2}T/.test(String(r[c])) ? timeAgo(String(r[c])) : String(r[c])}</Td>)}</tr>)}</tbody>
              </Table>
            </div>
            {rows.length > 12 && <div className="text-xs text-gray-500 mt-1">and {rows.length - 12} more</div>}
          </div>
        );
      })}
      {typeof ev.live_query === 'string' && <div><div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">To see it live, run this in Explorer</div><pre className="text-xs bg-gray-50 border border-gray-200 rounded p-2 whitespace-pre-wrap break-all">{ev.live_query}</pre></div>}
    </div>
  );
}

/** Look closer (§6): the evidence first, then the links, the numbered steps and the three-column table. */
function LookCloser({ check, settingsTz }: { check: HealthCheck; settingsTz: string }) {
  const full = useQuery({ queryKey: ['health-check', check.key], queryFn: () => rpc<HealthCheck>('health_check', { p_key: check.key }), refetchInterval: 60_000 });
  const guide = guideOf(check);
  const c = full.data ?? check;
  return (
    <div className="mt-3 border-t border-gray-100 pt-3 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-medium text-gray-900">Look closer · {guide?.title ?? check.name}</div>
        {guide && <div className="text-xs text-gray-500">Guide {guide.key} · checked {guide.checkedOn}</div>}
      </div>
      <section>
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">The evidence</div>
        {full.isLoading ? <Spinner /> : <Evidence ev={c.evidence} />}
        {c.recent && c.recent.length > 0 && <div className="mt-2"><Sparkline points={c.spark} width={320} height={32} title="Last 7 days, hourly" /><div className="text-[11px] text-gray-400">Last 7 days, one bar an hour</div></div>}
      </section>
      {guide && guide.links.length > 0 && (
        <section>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Open</div>
          <div className="flex flex-wrap gap-2">
            {guideLinks(guide).map((l) => <a key={l.label + l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-gray-200 bg-white text-xs text-indigo-700 hover:bg-indigo-50"><ExternalLink className="w-3 h-3" />{l.label}<span className="text-gray-400">· {l.kind === 'supabase' ? 'Supabase' : l.kind === 'app' ? 'this app' : 'provider'}</span></a>)}
          </div>
        </section>
      )}
      {guide?.intro && <p className="text-sm text-gray-700"><Words text={guide.intro} /></p>}
      {guide && guide.steps.length > 0 && (
        <section>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Steps</div>
          <ol className="list-decimal pl-5 space-y-1 text-sm text-gray-800">{guide.steps.map((s, i) => <li key={i}><Words text={s.replace(/\*\*/g, '').replace(/`/g, '')} /></li>)}</ol>
        </section>
      )}
      {guide && guide.read.length > 0 && (
        <section>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">How to read it</div>
          <div className="overflow-x-auto">
            <Table>
              <thead><tr><Th>If you see</Th><Th>It means</Th><Th>Do this</Th></tr></thead>
              <tbody>{guide.read.map((r, i) => <tr key={i}><Td className="text-gray-900 align-top"><Words text={r.see.replace(/`/g, '')} /></Td><Td className="align-top"><Words text={r.means.replace(/`/g, '')} /></Td><Td className="text-gray-700 align-top">{r.do.replace(/`/g, '')}{r.next && <span className="ml-1 text-xs text-indigo-600">→ guide {r.next}</span>}</Td></tr>)}</tbody>
            </Table>
          </div>
          {guide.after && <p className="text-xs text-gray-500 mt-2">{guide.after}</p>}
        </section>
      )}
      <div className="text-[11px] text-gray-400">Prompt time zone: {settingsTz}</div>
    </div>
  );
}

function SnoozeModal({ check, open, onClose, onDone }: { check: HealthCheck; open: boolean; onClose: () => void; onDone: () => void }) {
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const { show, node } = useToast();
  const m = useMutation({
    mutationFn: () => rpc('health_snooze', { p_key: check.key, p_until: new Date(Date.now() + Number(days) * 86400_000).toISOString(), p_reason: reason }),
    onSuccess: () => { onDone(); onClose(); },
    onError: (e: Error) => show(e.message, 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} title={`Snooze "${check.name}"`} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!reason.trim()}>Snooze</Button></>}>
      <div className="space-y-3">
        <Select label="For" value={days} onChange={(e) => setDays(e.target.value)}><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></Select>
        <Textarea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. LinkedIn weekly cap; clears Monday" />
        <p className="text-xs text-gray-500">A snoozed check leaves the top line, shows in its own group, and is listed in the daily email&apos;s footer. It sends no urgent email.</p>
      </div>
      {node}
    </Modal>
  );
}

function CheckCard({ check, open, onToggle, tz, onChanged }: { check: HealthCheck; open: boolean; onToggle: () => void; tz: string; onChanged: () => void }) {
  const [snooze, setSnooze] = useState(false);
  const { show, node } = useToast();
  const copy = async () => { try { await navigator.clipboard.writeText(claudePrompt(check, tz)); show('Prompt copied. Paste it into your coding tool.'); } catch { show('Could not copy', 'error'); } };
  const unsnooze = useMutation({ mutationFn: () => rpc('health_snooze', { p_key: check.key, p_until: null, p_reason: null }), onSuccess: onChanged, onError: (e: Error) => show(e.message, 'error') });
  const toggle = useMutation({ mutationFn: () => rpc('health_set_enabled', { p_key: check.key, p_enabled: !check.enabled }), onSuccess: onChanged, onError: (e: Error) => show(e.message, 'error') });
  const snoozed = !!check.snoozed_until;
  const since = check.since && check.status !== 'ok' ? `Since ${timeAgo(check.since)}` : null;
  return (
    <div id={`check-${check.key}`} className={cn('rounded-lg border bg-white p-3', check.status === 'act' && !snoozed ? 'border-red-200' : check.status === 'watch' && !snoozed ? 'border-amber-200' : 'border-gray-200', !check.enabled && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <Dot status={check.status} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <button type="button" onClick={onToggle} className="text-sm font-medium text-gray-900 text-left hover:underline" title={check.question}>{check.name}</button>
            <div className="text-sm tabular-nums text-gray-700">{check.status === 'unknown' ? <span className="text-gray-500">{STATUS_LABELS.unknown}</span> : <>{fmtValue(check.value, check.unit)}{limitText(check) && <span className="text-gray-400"> · {limitText(check)}</span>}</>}</div>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">{[since, check.pending && check.pending !== check.status ? `Seen ${STATUS_LABELS[check.pending as HealthStatus].toLowerCase()} once, waiting for the second check` : null, check.last_run_at ? `checked ${timeAgo(check.last_run_at)}` : 'not checked yet'].filter(Boolean).join(' · ')}</div>
          <p className="text-sm text-gray-800 mt-1"><Words text={check.summary} /></p>
          {check.status !== 'ok' && <p className="text-sm text-gray-700 mt-0.5"><span className="text-gray-500">What to do:</span> {whatToDo(check)}</p>}
          {snoozed && <p className="text-xs text-amber-800 mt-1">Snoozed until {new Date(check.snoozed_until!).toLocaleDateString()}: {check.snooze_reason}</p>}
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <Button size="sm" variant="secondary" onClick={onToggle}>{open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Look closer</Button>
            <Button size="sm" variant="secondary" onClick={copy}><Copy className="w-3.5 h-3.5" /> Copy prompt for Claude</Button>
            {snoozed ? <Button size="sm" variant="ghost" onClick={() => unsnooze.mutate()} loading={unsnooze.isPending}><Bell className="w-3.5 h-3.5" /> Unsnooze</Button> : <Button size="sm" variant="ghost" onClick={() => setSnooze(true)}><BellOff className="w-3.5 h-3.5" /> Snooze</Button>}
            <Button size="sm" variant="ghost" onClick={() => toggle.mutate()} loading={toggle.isPending} title={check.enabled ? 'Turn this check off' : 'Turn this check on'}><Power className="w-3.5 h-3.5" /> {check.enabled ? 'Off' : 'On'}</Button>
            <div className="ml-auto"><Sparkline points={check.spark} /></div>
          </div>
          {open && <LookCloser check={check} settingsTz={tz} />}
        </div>
      </div>
      <SnoozeModal check={check} open={snooze} onClose={() => setSnooze(false)} onDone={onChanged} />
      {node}
    </div>
  );
}

function Group({ title, checks, open, setOpen, tz, onChanged, defaultCollapsed = false, byArea = false }: { title: string; checks: HealthCheck[]; open: string | null; setOpen: (k: string | null) => void; tz: string; onChanged: () => void; defaultCollapsed?: boolean; byArea?: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [area, setArea] = useState<string | null>(null);
  if (!checks.length) return null;
  const shown = byArea && area ? checks.filter((c) => c.area === area) : checks;
  return (
    <section className="mb-6">
      <button type="button" onClick={() => setCollapsed((v) => !v)} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}{title} ({checks.length})
      </button>
      {!collapsed && byArea && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {AREA_ORDER.filter((a) => checks.some((c) => c.area === a)).map((a) => <button key={a} type="button" onClick={() => setArea(area === a ? null : a)} className={cn('px-2.5 py-1 rounded-full text-xs border', area === a ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50')}>{AREA_LABELS[a]} <span className="text-gray-400">{checks.filter((c) => c.area === a).length}</span></button>)}
        </div>
      )}
      {!collapsed && <div className="space-y-2">{shown.map((c) => <CheckCard key={c.key} check={c} open={open === c.key} onToggle={() => setOpen(open === c.key ? null : c.key)} tz={tz} onChanged={onChanged} />)}</div>}
    </section>
  );
}

export default function HealthNow({ overview, openKey, onOpenKey }: { overview: HealthOverview; openKey: string | null; onOpenKey: (k: string | null) => void }) {
  const qc = useQueryClient();
  const onChanged = () => { qc.invalidateQueries({ queryKey: ['health-overview'] }); };
  const tz = overview.settings?.time_zone ?? 'Asia/Kolkata';
  const groups = useMemo(() => {
    const on = overview.checks.filter((c) => c.enabled && !c.snoozed_until);
    const by = (s: HealthStatus) => on.filter((c) => c.status === s).sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
    return { act: by('act'), watch: by('watch'), unknown: by('unknown'), ok: by('ok'), snoozed: overview.checks.filter((c) => c.enabled && c.snoozed_until), off: overview.checks.filter((c) => !c.enabled) };
  }, [overview.checks]);
  useEffect(() => { if (openKey) document.getElementById(`check-${openKey}`)?.scrollIntoView({ block: 'center' }); }, [openKey]);
  return (
    <div>
      {overview.run?.errors?.length ? <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">Some checks hit an error on the last run: {overview.run.errors.map((e) => e.split(':')[0]).join(', ')}. They show as grey; the message is on each card.</div> : null}
      <Group title="Needs action" checks={groups.act} open={openKey} setOpen={onOpenKey} tz={tz} onChanged={onChanged} />
      <Group title="To watch" checks={groups.watch} open={openKey} setOpen={onOpenKey} tz={tz} onChanged={onChanged} />
      <Group title="Couldn't check" checks={groups.unknown} open={openKey} setOpen={onOpenKey} tz={tz} onChanged={onChanged} />
      <Group title="Fine" checks={groups.ok} open={openKey} setOpen={onOpenKey} tz={tz} onChanged={onChanged} defaultCollapsed={!groups.ok.some((c) => c.key === openKey)} byArea />
      <Group title="Snoozed" checks={groups.snoozed} open={openKey} setOpen={onOpenKey} tz={tz} onChanged={onChanged} />
      <Group title="Off" checks={groups.off} open={openKey} setOpen={onOpenKey} tz={tz} onChanged={onChanged} defaultCollapsed />
      {!overview.checks.length && <div className="text-sm text-gray-500">No checks yet. Apply migration 081 and run <code>select ops.health_run()</code>.</div>}
      <p className={cn('text-xs mt-2', STATUS_TEXT.unknown)}>Amber and red need two checks in a row before they show; key and billing problems and the immediate checks show at once. A check that could not run is grey, never green.</p>
    </div>
  );
}
