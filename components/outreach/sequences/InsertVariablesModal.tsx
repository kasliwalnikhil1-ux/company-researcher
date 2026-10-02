'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from '@/lib/outreach/nav';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hubHref } from '@/lib/outreach/aiHub';
import type { RenderContext } from '@/lib/outreach/render';
import { exampleFor, matchesSearch, VARIABLE_CATALOG, VARIABLE_TABS, visibleRows, workspaceRows, type CatalogVariable, type PopupAiVariable, type VariableTab } from '@/lib/outreach/variables';

const TAB_KEY = 'outreach.insert-variables.tab';
const isTab = (v: unknown): v is VariableTab => VARIABLE_TABS.some((t) => t.id === v);
/** The tab last used in this browser session (AI Variables the first time). */
function readTab(): VariableTab {
  try { const v = window.sessionStorage.getItem(TAB_KEY); return isTab(v) ? v : 'ai'; } catch { return 'ai'; /* storage blocked */ }
}
function writeTab(t: VariableTab) { try { window.sessionStorage.setItem(TAB_KEY, t); } catch { /* storage blocked */ } }

interface Props {
  onClose: () => void;
  /** Insert one row of the catalogue into the message. The field closes the popup and puts the cursor where it belongs. */
  onInsert: (v: CatalogVariable) => void;
  channel: 'linkedin' | 'email';
  /** URL and JSON fields: conditionals and spintax are not offered. */
  plain: boolean;
  aiVars: { data?: PopupAiVariable[] | null; isLoading: boolean; error: unknown };
  customKeys: string[];
  /** The render context of the lead and sender the Preview panel uses. null while it loads or when there is no lead. */
  ctx: RenderContext | null;
  ctxLoading: boolean;
  /** "Priya Sharma": whose values the Example column shows. */
  leadName: string | null;
}

/**
 * The Insert Variables popup of a message box: a search over every variable, five tabs, and a Variable Name | Example
 * table. The example is the variable rendered for the preview lead by the same renderer that sends the message.
 * Render it only while it is open. It is drawn on the page body, so the step drawer cannot clip it.
 */
export default function InsertVariablesModal({ onClose, onInsert, channel, plain, aiVars, customKeys, ctx, ctxLoading, leadName }: Props) {
  const titleId = useId();
  const listId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState('');
  const [chosenTab, setTabState] = useState<VariableTab>(readTab);
  const [active, setActive] = useState(0);
  const [customKey, setCustomKey] = useState('');

  const all = useMemo(() => visibleRows([...VARIABLE_CATALOG, ...workspaceRows(aiVars.data, customKeys)], { channel, plain }), [aiVars.data, customKeys, channel, plain]);
  const searching = q.trim() !== '';
  const byTab = useMemo(() => {
    const m = new Map<VariableTab, CatalogVariable[]>();
    for (const t of VARIABLE_TABS) m.set(t.id, all.filter((v) => v.tab === t.id && matchesSearch(v, q)));
    return m;
  }, [all, q]);
  // While searching: when the chosen tab has no match, the first tab that has one is shown instead.
  const tab = useMemo<VariableTab>(() => {
    if (!searching || (byTab.get(chosenTab)?.length ?? 0) > 0) return chosenTab;
    return VARIABLE_TABS.find((t) => (byTab.get(t.id)?.length ?? 0) > 0)?.id ?? chosenTab;
  }, [searching, byTab, chosenTab]);
  const rows = useMemo(() => byTab.get(tab) ?? [], [byTab, tab]);
  const totalMatches = useMemo(() => VARIABLE_TABS.reduce((n, t) => n + (byTab.get(t.id)?.length ?? 0), 0), [byTab]);

  const setTab = useCallback((t: VariableTab) => { setTabState(t); writeTab(t); setActive(0); }, []);

  useEffect(() => { searchRef.current?.focus(); }, []);
  // the page behind does not scroll while the popup is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const activeRow = rows[Math.min(active, rows.length - 1)] ?? null;
  const optionId = (i: number) => `${listId}-o${i}`;
  useEffect(() => {
    if (!activeRow) return;
    document.getElementById(optionId(Math.min(active, rows.length - 1)))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rows.length]);

  const insertCustom = () => {
    const key = customKey.trim();
    if (!key) return;
    onInsert({ tab: 'contact', token: `{{ custom.${key} }}`, insert: 'token', sample: key });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const i = VARIABLE_TABS.findIndex((t) => t.id === tab);
      const n = VARIABLE_TABS.length;
      setTab(VARIABLE_TABS[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n].id);
      return;
    }
    // the custom-key box has its own Enter; arrows there move the text cursor
    if ((e.target as HTMLElement).dataset?.customKey !== undefined) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && e.target === searchRef.current) { e.preventDefault(); if (activeRow) onInsert(activeRow); }
    else if (e.key === 'Tab') {
      // keep the focus inside the popup
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]');
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  const tabMeta = VARIABLE_TABS.find((t) => t.id === tab)!;
  const ownAiRows = rows.filter((v) => v.section?.startsWith('Your variables')).length;

  const body = (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative flex max-h-[70vh] w-[720px] max-w-full flex-col rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h3 id={titleId} className="text-base font-semibold text-gray-900">Insert Variables</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><X className="h-4 w-4" aria-hidden /></button>
        </div>

        <div className="px-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" aria-hidden />
            <input ref={searchRef} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Search variables" aria-label="Search variables"
              role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeRow ? optionId(Math.min(active, rows.length - 1)) : undefined} autoComplete="off" spellCheck={false}
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
        </div>

        <div role="tablist" aria-label="Variable groups" className="mt-3 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-gray-200 px-5">
          {VARIABLE_TABS.map((t) => {
            const n = byTab.get(t.id)?.length ?? 0;
            const on = t.id === tab;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => setTab(t.id)} disabled={searching && n === 0}
                className={cn('whitespace-nowrap border-b-2 px-2.5 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-default disabled:opacity-40',
                  on ? 'border-indigo-600 font-medium text-indigo-700' : 'border-transparent text-gray-600 hover:text-gray-900')}>
                {t.label}{searching && <span className="tabular-nums"> ({n})</span>}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-x-4 border-b border-gray-100 px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          <span>Variable Name</span>
          <span title={leadName ? `What ${leadName} would get` : undefined}>Example{leadName && ctx ? <span className="font-normal normal-case tracking-normal text-gray-400"> · {leadName}</span> : null}</span>
        </div>

        <div id={listId} role="listbox" aria-label={`${tabMeta.label} variables`} className="min-h-[160px] flex-1 overflow-y-auto px-2 py-1">
          {totalMatches === 0 && searching ? (
            <p className="px-3 py-8 text-center text-sm text-gray-500">No variables match</p>
          ) : (
            <>
              {rows.map((v, i) => {
                const heading = v.section && v.section !== rows[i - 1]?.section ? v.section : null;
                const example = exampleFor(v, ctx);
                const on = i === Math.min(active, rows.length - 1);
                return (
                  <div key={`${v.token}-${i}`}>
                    {heading && <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{heading}</div>}
                    <button id={optionId(i)} type="button" role="option" aria-selected={on} onClick={() => onInsert(v)} onMouseMove={() => { if (!on) setActive(i); }}
                      className={cn('grid w-full grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-center gap-x-4 rounded-md px-3 py-1.5 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', on ? 'bg-indigo-50' : 'hover:bg-gray-50')}>
                      <span className="truncate font-mono text-gray-900" title={v.token}>{v.token}</span>
                      {v.describe ? <span className="truncate italic text-gray-500" title={v.describe}>{v.describe}</span>
                        : example === null ? <span className="truncate text-gray-400" title={ctxLoading ? undefined : 'An example. Open Preview to pick a lead'}>{ctxLoading ? 'Loading…' : v.sample || '—'}</span>
                        : example === '' ? <span className="text-gray-400" title="Empty for this lead">—</span>
                        : <span className="truncate text-gray-700" title={example}>{example}</span>}
                    </button>
                  </div>
                );
              })}

              {tab === 'ai' && !searching && (
                aiVars.isLoading ? <p className="px-3 py-2 text-xs text-gray-400">Loading your variables…</p>
                  : aiVars.error ? <p className="px-3 py-2 text-xs text-red-600" role="alert">Your variables could not be loaded.</p>
                  : ownAiRows === 0 ? (
                    <>
                      <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Your variables</div>
                      <p className="px-3 py-1 text-xs text-gray-500">Create one under <Link href={hubHref.setupLines()} target="_blank" className="text-indigo-700 hover:underline">AI → Setup → Personalized lines</Link>.</p>
                    </>
                  ) : null
              )}
              {tab === 'contact' && !searching && (
                <div className="px-3 pb-2 pt-3">
                  <label htmlFor={`${listId}-custom`} className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">{customKeys.length ? 'Another custom field' : 'Custom fields'}</label>
                  <div className="flex gap-2">
                    <input id={`${listId}-custom`} data-custom-key="" value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="custom field key" spellCheck={false}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); insertCustom(); } }}
                      className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 font-mono text-xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    <button type="button" disabled={!customKey.trim()} onClick={insertCustom} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Insert</button>
                  </div>
                </div>
              )}
              {rows.length === 0 && searching && <p className="px-3 py-6 text-center text-xs text-gray-500">Nothing in this tab matches.</p>}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-gray-100 px-5 py-2.5 text-[11px] text-gray-500">
          <span className="min-w-0">{tabMeta.footer}</span>
          <span className="whitespace-nowrap text-gray-400">↑ ↓ to move · Enter to insert · Esc to close</span>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
