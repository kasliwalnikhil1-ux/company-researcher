'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Download, Search, Sparkles } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import {
  ACTIVITY_DEFAULTS, ACTIVITY_PAGE, ACTIVITY_RANGES, AI_FEATURES, FEATURE_LABEL, FEATURE_ONE, fetchAiActivityAll, useAiActivity, useHubSetup, whoHref, whoText,
  type ActivityFilters, type ActivityRange, type AiFeature, type AiOutputRow, type HubSetup,
} from '@/lib/outreach/aiHub';
import { downloadCsv } from '@/lib/outreach/reports';
import { Badge, Button, EmptyState, ErrorBox, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { PaginationBar } from '@/components/outreach/Pagination';
import { cn } from '@/lib/utils';

const FEATURE_TONE: Record<AiFeature, 'indigo' | 'purple' | 'pink' | 'blue' | 'gray'> = { reply: 'indigo', line: 'purple', draft: 'pink', website: 'blue', profile: 'gray' };
const field = 'text-sm rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500';

/** "10:42" today, "2 Oct, 10:42" this year, "2 Oct 2025, 10:42" before. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`;
}

/** The places an output can come from, for the Where filter: sequences, variables, websites (what the member may see). */
function whereOptions(setup: HubSetup | undefined, feature: AiFeature | null): Array<{ group: string; items: Array<{ id: string; name: string }> }> {
  if (!setup) return [];
  const seq = { group: 'Sequences', items: setup.sequences.map((s) => ({ id: s.id, name: s.name })) };
  const vars = { group: 'Variables', items: setup.variables.map((v) => ({ id: v.id, name: v.key })) };
  const sites = { group: 'Websites', items: setup.websites.map((w) => ({ id: w.id, name: w.name })) };
  const all = feature === 'reply' || feature === 'draft' ? [seq] : feature === 'line' ? [vars] : feature === 'website' ? [sites] : feature === 'profile' ? [] : [seq, vars, sites];
  return all.filter((g) => g.items.length > 0);
}

/**
 * Activity: what the AI generated, nothing else. Time · Feature · Where · Who · What the AI wrote.
 *
 * The same table is the Activity page (all filters) and, with `fixed`, the pre-filtered list on a sequence's AI tab (its
 * replies), a variable's page (its lines) and a website's assistant settings (its answers). A fixed filter is not shown.
 *   filters / onFilters   controlled filters (the page keeps them in the URL); omit both for a self-contained table
 *   canExport             managers: CSV of the visible columns, every row of the current filter (up to 5,000)
 */
export default function ActivityTable({ ws, fixed, filters, onFilters, canExport, pageSize = ACTIVITY_PAGE, emptyText, className }: {
  ws: string; fixed?: { feature?: AiFeature; where?: string }; filters?: ActivityFilters; onFilters?: (f: ActivityFilters) => void;
  canExport?: boolean; pageSize?: number; emptyText?: string; className?: string;
}) {
  const [own, setOwn] = useState<ActivityFilters>(ACTIVITY_DEFAULTS);
  const raw = filters ?? own;
  const f: ActivityFilters = useMemo(() => ({ ...raw, feature: fixed?.feature ?? raw.feature, where: fixed?.where ?? raw.where }), [raw, fixed?.feature, fixed?.where]);
  const set = (p: Partial<ActivityFilters>) => { const next = { ...raw, ...p }; if (onFilters) onFilters(next); else setOwn(next); };

  // the search box is typed into freely and applied after a short pause
  // (`applied` is the search this box sent last, `seen` the applied search of the last render. A search that changes
  // elsewhere, a cleared filter or the back button, replaces the box; the box's own search landing late, which is how
  // the URL-driven page works, keeps what was typed since.)
  const [box, setBox] = useState({ value: raw.q, applied: raw.q, seen: raw.q });
  if (raw.q !== box.seen) setBox({ value: raw.q === box.applied ? box.value : raw.q, applied: raw.q, seen: raw.q });
  const typed = box.value;
  const setTyped = (value: string) => setBox((b) => ({ ...b, value }));
  useEffect(() => {
    if (typed === raw.q) return;
    const t = setTimeout(() => { setBox((b) => ({ ...b, applied: typed })); set({ q: typed }); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const filterKey = JSON.stringify(f);
  const [pageState, setPageState] = useState({ key: filterKey, page: 0 });
  const page = pageState.key === filterKey ? pageState.page : 0;
  const listQ = useAiActivity(ws, f, page, pageSize);
  const setup = useHubSetup(fixed?.where ? null : ws);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const rows = listQ.data?.rows ?? [];
  const total = listQ.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const setPage = (p: number) => setPageState({ key: filterKey, page: Math.max(0, Math.min(pageCount - 1, p)) });
  const options = whereOptions(setup.data, f.feature);
  const showFeature = !fixed?.feature;
  const showWhere = !fixed?.where;
  const waitingForDates = f.range === 'custom' && !f.from;

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const exportCsv = async () => {
    setExporting(true); setExportError(null);
    try {
      const all = await fetchAiActivityAll(ws, f);
      downloadCsv<AiOutputRow>(`ai-activity_${new Date().toISOString().slice(0, 10)}.csv`, [
        { header: 'Time', value: (r) => new Date(r.created_at).toISOString() },
        { header: 'Feature', value: (r) => FEATURE_ONE[r.feature] ?? r.feature },
        { header: 'Where', value: (r) => r.where_name },
        { header: 'Who', value: (r) => whoText(r) },
        { header: 'What the AI wrote', value: (r) => r.text },
      ], all);
    } catch (e) { setExportError(parseError(e).message); }
    finally { setExporting(false); }
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {showFeature && (
          <select aria-label="Feature" value={f.feature ?? ''} onChange={(e) => set({ feature: (e.target.value || null) as AiFeature | null, where: null })} className={field}>
            <option value="">All features</option>
            {AI_FEATURES.map((k) => <option key={k} value={k}>{FEATURE_LABEL[k]}</option>)}
          </select>
        )}
        {showWhere && options.length > 0 && (
          <select aria-label="Where" value={f.where ?? ''} onChange={(e) => set({ where: e.target.value || null })} className={cn(field, 'max-w-[240px]')}>
            <option value="">{f.feature === 'line' ? 'All variables' : f.feature === 'website' ? 'All websites' : f.feature === 'reply' || f.feature === 'draft' ? 'All sequences' : 'Everywhere'}</option>
            {options.map((g) => options.length > 1
              ? <optgroup key={g.group} label={g.group}>{g.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>
              : g.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>))}
          </select>
        )}
        <select aria-label="Dates" value={f.range} onChange={(e) => set({ range: e.target.value as ActivityRange })} className={field}>
          {ACTIVITY_RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        {f.range === 'custom' && (
          <>
            <input type="date" aria-label="From" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} className={field} />
            <span className="text-xs text-gray-500">to</span>
            <input type="date" aria-label="To" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} className={field} />
          </>
        )}
        <label className="relative flex-1 min-w-[180px] max-w-xs">
          <span className="sr-only">Search the text</span>
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search text…" aria-label="Search what the AI wrote" className={cn(field, 'w-full pl-8')} />
        </label>
        <div className="flex-1" />
        {canExport && <Button variant="secondary" size="sm" loading={exporting} disabled={total === 0} onClick={exportCsv} title="Every row of this filter, up to 5,000"><Download className="w-3.5 h-3.5" /> Export CSV</Button>}
      </div>
      {exportError && <ErrorBox message={exportError} className="mb-3" />}

      {waitingForDates ? (
        <div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<Sparkles className="w-6 h-6" />} title="Pick the dates" description="Choose a start date to see what the AI wrote in that period." /></div>
      ) : listQ.isLoading ? <Spinner className="py-10" /> : listQ.error ? <ErrorBox message={parseError(listQ.error).message} /> : rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl">
          <EmptyState icon={<Sparkles className="w-6 h-6" />} title="Nothing here yet"
            description={emptyText ?? (f.q.trim() ? 'No text in this period matches your search. Try other words or a longer period.' : 'The AI wrote nothing in this period. Try a longer period or another filter.')} />
        </div>
      ) : (
        <>
          <div className={cn('transition-opacity', listQ.isPlaceholderData && 'opacity-60')}>
            <Table>
              <thead>
                <tr>
                  <Th className="w-36">Time</Th>
                  {showFeature && <Th className="w-32">Feature</Th>}
                  {showWhere && <Th>Where</Th>}
                  <Th>Who</Th>
                  <Th>What the AI wrote</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = whoHref(r);
                  const expanded = open.has(`${r.feature}:${r.id}`);
                  return (
                      <tr key={`${r.feature}:${r.id}`} className="align-top">
                        <Td className="whitespace-nowrap text-gray-500 align-top" title={new Date(r.created_at).toLocaleString()}>{when(r.created_at)}</Td>
                        {showFeature && <Td className="align-top"><Badge tone={FEATURE_TONE[r.feature] ?? 'gray'}>{FEATURE_ONE[r.feature] ?? r.feature}</Badge></Td>}
                        {showWhere && <Td className="align-top max-w-[200px]"><span className="block truncate" title={r.where_name ?? undefined}>{r.where_name ?? <span className="text-gray-400">—</span>}</span></Td>}
                        <Td className="align-top max-w-[220px]">
                          {href ? <Link href={href} className="block truncate text-gray-900 hover:text-indigo-700 hover:underline" title={whoText(r)}>{whoText(r) || 'Open'}</Link>
                                : <span className="block truncate" title={whoText(r)}>{whoText(r) || <span className="text-gray-400">—</span>}</span>}
                        </Td>
                        <Td className="align-top min-w-[280px] cursor-pointer" onClick={() => toggle(`${r.feature}:${r.id}`)}>
                          <button type="button" aria-expanded={expanded} className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">
                            <span className={cn('block text-gray-800', expanded ? 'whitespace-pre-wrap break-words' : 'truncate max-w-[60ch] lg:max-w-[80ch]')}>{r.text}</span>
                          </button>
                        </Td>
                      </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
          {total > pageSize && <PaginationBar page={page} pageCount={pageCount} setPage={setPage} total={total} from={page * pageSize + 1} to={Math.min(total, (page + 1) * pageSize)} />}
        </>
      )}
    </div>
  );
}
