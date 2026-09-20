'use client';

// Item 15: AI routing step. Each route is a label + a plain-language description; "Everything else" is fixed.
// "Test on 20 leads" asks the ai-variables function for the split without storing anything.
import { useState } from 'react';
import { ChevronDown, ChevronRight, FlaskConical, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { callFn, parseError } from '@/lib/outreach/api';
import { syncNodeBranches } from '@/lib/outreach/nodes';
import { AI_ROUTE_ELSE, type AiRouteOption, type GraphNode } from '@/lib/outreach/types';
import { Button, ErrorBox } from '@/components/outreach/ui';
import { useBuilder } from './context';
import { Callout, Note } from './FormsShared';

const MAX_ROUTES = 8;

interface RouteTestRow { lead_id?: string; lead_name?: string | null; name?: string | null; company?: string | null; branch?: string | null; reason?: string | null; facts?: unknown }
interface RouteTestResult { tested: number; split: Record<string, number>; rows: RouteTestRow[] }

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') { const o = v as Record<string, unknown>; return String(o.text ?? o.fact ?? o.value ?? JSON.stringify(v)); }
  return String(v);
}

/** The function's reply is read loosely: rows under results / leads / rows / decisions, split computed from the rows when absent. */
function readResult(raw: unknown): RouteTestResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = [r.results, r.leads, r.rows, r.decisions].find(Array.isArray) as RouteTestRow[] | undefined;
  const rows = (list ?? []).map((x) => ({ ...x, branch: x.branch || AI_ROUTE_ELSE }));
  let split: Record<string, number> = {};
  if (r.split && typeof r.split === 'object' && !Array.isArray(r.split)) {
    for (const [k, v] of Object.entries(r.split as Record<string, unknown>)) split[k] = Number(typeof v === 'object' && v ? (v as { count?: number }).count : v) || 0;
  } else {
    split = rows.reduce<Record<string, number>>((acc, x) => { const b = x.branch as string; acc[b] = (acc[b] ?? 0) + 1; return acc; }, {});
  }
  const tested = Number(r.tested ?? r.total) || rows.length || Object.values(split).reduce((s, n) => s + n, 0);
  return { tested, split, rows };
}

interface Props { node: GraphNode; cfg: Record<string, any>; update: (next: GraphNode) => void }

export default function AiRouteForm({ node, cfg, update }: Props) {
  const { workspaceId, sequenceId, readOnly } = useBuilder();
  const routes: AiRouteOption[] = Array.isArray(cfg.routes) ? cfg.routes : [];
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RouteTestResult | null>(null);
  const [openRow, setOpenRow] = useState<number | null>(null);

  const commit = (next: AiRouteOption[]) => update(syncNodeBranches({ ...node, config: { ...cfg, routes: next } }));
  const setRoute = (i: number, p: Partial<AiRouteOption>) => commit(routes.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const add = () => {
    let n = routes.length + 1;
    while (routes.some((r) => r.id === `route_${n}`)) n++;
    commit([...routes, { id: `route_${n}`, label: `Route ${n}`, description: '' }]);
  };
  const remove = (i: number) => commit(routes.filter((_, idx) => idx !== i));
  const labelOf = (id: string) => (id === AI_ROUTE_ELSE ? 'Everything else' : routes.find((r) => r.id === id)?.label || id);

  const undescribed = routes.some((r) => (r.description ?? '').trim().length < 3);
  const runTest = async () => {
    setTesting(true); setError(null); setResult(null); setOpenRow(null);
    try {
      // `routes` carries the text on screen, so an unsaved edit is what gets tested.
      const raw = await callFn('ai-variables', { action: 'route_test', workspace_id: workspaceId, sequence_id: sequenceId, node_id: node.id, routes });
      setResult(readResult(raw));
    } catch (e) { setError(parseError(e).message); }
    finally { setTesting(false); }
  };

  return (
    <div className="space-y-3">
      <Note>Describe each path in plain words. For every lead the AI reads the profile, the stored profile data and the custom fields, then picks one path. The decision is made once per lead. If no decision arrives within 6 hours, the lead takes “Everything else”.</Note>
      <ol className="space-y-2">
        {routes.map((r, i) => (
          <li key={r.id} className="rounded-lg border border-gray-200 p-2 space-y-1.5 bg-gray-50/50">
            <div className="flex items-center gap-1.5">
              <input value={r.label ?? ''} onChange={(e) => setRoute(i, { label: e.target.value })} maxLength={40} placeholder={`Route ${i + 1}`} aria-label={`Name of route ${i + 1}`} className="flex-1 min-w-0 px-2 py-1 text-xs font-medium rounded border border-gray-300 bg-white" />
              <button type="button" onClick={() => remove(i)} disabled={routes.length <= 1} className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400" aria-label={`Remove route ${r.label || i + 1}`}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <textarea value={r.description ?? ''} onChange={(e) => setRoute(i, { description: e.target.value })} rows={2} maxLength={400} placeholder="Who goes here? For example: founders and C-level at software companies" aria-label={`Who goes to ${r.label || `route ${i + 1}`}`} aria-invalid={(r.description ?? '').trim().length < 3 || undefined}
              className={cn('w-full px-2 py-1 text-xs rounded border bg-white', (r.description ?? '').trim().length < 3 ? 'border-amber-300' : 'border-gray-300')} />
          </li>
        ))}
        <li className="rounded-lg border border-dashed border-gray-300 p-2">
          <div className="text-xs font-medium text-gray-700">Everything else</div>
          <p className="text-[11px] text-gray-500 leading-4">Always there. Leads that fit no description, or that the AI is unsure about, go this way.</p>
        </li>
      </ol>
      <Button type="button" variant="secondary" size="sm" onClick={add} disabled={routes.length >= MAX_ROUTES}><Plus className="w-3.5 h-3.5" aria-hidden /> Add route</Button>
      {undescribed && <Callout tone="warn">Every route needs a description before the sequence can go live.</Callout>}
      <Note>Each route, and “Everything else”, is an exit of this step on the canvas. Connect each one to the step that should follow.</Note>

      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={runTest} loading={testing} disabled={readOnly || undescribed || routes.length === 0}><FlaskConical className="w-3.5 h-3.5" aria-hidden /> Test on 20 leads</Button>
          {testing && <span className="text-[11px] text-gray-500" aria-live="polite">Reading 20 profiles. This takes a moment.</span>}
        </div>
        <Note>The test is the review: routing decisions are stored with their reason in the lead timeline. Nothing from a test run is saved, and no lead is moved.</Note>
        {error && <ErrorBox message={error} className="!text-xs !p-2" />}
        {result && result.tested === 0 && <p className="text-xs text-gray-500">No leads to test with yet. Import leads first.</p>}
        {result && result.tested > 0 && (
          <div className="space-y-2" aria-live="polite">
            <ul className="space-y-1">
              {[...routes.map((r) => r.id), AI_ROUTE_ELSE].map((id) => {
                const n = result.split[id] ?? 0;
                const share = Math.round((n / result.tested) * 100);
                return (
                  <li key={id} className="text-xs">
                    <div className="flex justify-between gap-2"><span className="truncate text-gray-700">{labelOf(id)}</span><span className="tabular-nums text-gray-500">{n} · {share}%</span></div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className={cn('h-full', id === AI_ROUTE_ELSE ? 'bg-gray-400' : 'bg-fuchsia-500')} style={{ width: `${share}%` }} /></div>
                  </li>
                );
              })}
            </ul>
            {(result.split[AI_ROUTE_ELSE] ?? 0) / result.tested > 0.6 && <Callout>Most leads fell into “Everything else”. Try wider descriptions, or check that these leads have profile data.</Callout>}
            {result.rows.length > 0 && (
              <ul className="rounded-lg border border-gray-200 divide-y divide-gray-100">
                {result.rows.map((row, i) => {
                  const facts = Array.isArray(row.facts) ? row.facts.map(asText).filter(Boolean) : asText(row.facts) ? [asText(row.facts)] : [];
                  const open = openRow === i;
                  return (
                    <li key={row.lead_id ?? i} className="text-xs">
                      <button type="button" onClick={() => setOpenRow(open ? null : i)} aria-expanded={open} className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-gray-50">
                        {open ? <ChevronDown className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden /> : <ChevronRight className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden />}
                        <span className="truncate flex-1 text-gray-800">{row.lead_name || row.name || 'Lead'}{row.company ? <span className="text-gray-400"> · {row.company}</span> : null}</span>
                        <span className={cn('px-1.5 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap', row.branch === AI_ROUTE_ELSE ? 'bg-gray-100 text-gray-700' : 'bg-fuchsia-100 text-fuchsia-800')}>{labelOf(row.branch as string)}</span>
                      </button>
                      {open && (
                        <div className="px-2 pb-2 pl-6 space-y-1 text-gray-600">
                          <p>{row.reason || 'No reason given.'}</p>
                          {facts.length > 0 && <ul className="list-disc pl-4 text-[11px] text-gray-500">{facts.map((f, k) => <li key={k}>{f}</li>)}</ul>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
