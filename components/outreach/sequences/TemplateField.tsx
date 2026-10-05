'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Braces, Eye, GitBranch, Loader2, Search, Shuffle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { useLeadCustomKeys } from '@/lib/outreach/intel';
import { missingVariables, renderTemplate, spintaxInfo } from '@/lib/outreach/render';
import { VARIABLE_CATALOG, visibleRows, workspaceRows, type CatalogVariable } from '@/lib/outreach/variables';
import { useBuilder } from './context';
import { senderName } from './helpers';
import { hubHref, useHubSetup } from '@/lib/outreach/aiHub';
import { setPreviewTarget, useAiVariables, useLeadSearch, usePreviewTarget, useRenderContext, type PreviewLead } from './FormsShared';
import InsertVariablesModal from './InsertVariablesModal';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Character limit of the step. The counter measures the LONGEST spintax combination, like the server validator. */
  max?: number;
  multiline?: boolean;
  rows?: number;
  hint?: string;
  placeholder?: string;
  className?: string;
  /** 'email' also offers {{ unsubscribe_link }} and {{ sender_signature }}. */
  channel?: 'linkedin' | 'email';
  /** Hide the spintax / conditional helpers (URLs, JSON bodies). */
  plain?: boolean;
}

type Panel = 'vars' | 'cond' | 'preview' | null;

function leadLabel(l: PreviewLead | null | undefined): string {
  if (!l) return 'No lead';
  return [l.full_name || l.public_identifier || 'Unnamed lead', l.company].filter(Boolean).join(' · ');
}

/** The name inside a token: "{{ first_name }}" → "first_name". Tokens with a filter or a quoted list have none. */
const tokenName = (token: string): string | null => /^\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|[^}]*)?\}\}$/.exec(token)?.[1] ?? null;
const USES_AI_RE = /\{\{\s*(?:#if\s+)?ai\.|\{%-?\s*if\s+ai\./;
const AI_KEY_RE = /(?:\{\{\s*(?:#if\s+)?|\{%-?\s*if\s+)ai\.([a-z0-9_]+)/g;

/**
 * Text input / textarea for message templates: the Insert Variables popup, spintax and conditional helpers,
 * a counter that uses the longest spintax combination, and "Preview as lead" rendered from the same context the executor uses.
 */
export default function TemplateField({ label, value, onChange, max, multiline = true, rows = 4, hint, placeholder, className, channel = 'linkedin', plain = false }: Props) {
  const { workspaceId, sampleLead, customKeys, poolSenders, senders } = useBuilder();
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const fieldId = useId();
  const [panel, setPanel] = useState<Panel>(null);
  const [leadSearch, setLeadSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const aiVars = useAiVariables(workspaceId);
  const target = usePreviewTarget();
  const varsOpen = panel === 'vars';
  // every custom field of the workspace's leads (the sample lead's own keys until that list has loaded)
  const wsKeys = useLeadCustomKeys(varsOpen || panel === 'cond' ? workspaceId : null).data;
  const allCustomKeys = useMemo(() => Array.from(new Set([...(wsKeys ?? []), ...customKeys])), [wsKeys, customKeys]);

  useEffect(() => { const t = setTimeout(() => setDebounced(leadSearch), 250); return () => clearTimeout(t); }, [leadSearch]);
  useEffect(() => {
    if (!panel || panel === 'vars') return;   // the popup handles its own keys
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPanel(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [panel]);

  // --- editing helpers -------------------------------------------------------
  // A box nobody has clicked into reports its cursor at 0: a variable then goes to the end of the text, not in front of it.
  const touched = useRef(false);
  const selection = (): { start: number; end: number } => {
    const el = ref.current;
    if (!touched.current) return { start: value.length, end: value.length };
    const start = el?.selectionStart ?? value.length;
    return { start, end: el?.selectionEnd ?? start };
  };
  const replaceRange = (start: number, end: number, text: string, caret: number) => {
    onChange(value.slice(0, start) + text + value.slice(end));
    setPanel((p) => (p === 'preview' ? p : null));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(start + caret, start + caret); } catch { /* input types without selection support */ }
    });
  };
  /** A click on a row of the popup. A conditional wraps the selected text and leaves the cursor inside the `if`. */
  const insertVariable = (v: CatalogVariable) => {
    const { start, end } = selection();
    if (v.insert === 'if' && v.open) {
      const picked = value.slice(start, end);
      replaceRange(start, end, v.open + picked + v.token.slice(v.open.length), v.open.length + picked.length);
    } else replaceRange(start, end, v.token, v.token.length);
  };
  const closeVariables = () => {
    setPanel(null);
    requestAnimationFrame(() => ref.current?.focus());
  };
  const wrapSpintax = () => {
    const { start, end } = selection();
    const picked = value.slice(start, end);
    // Options cannot contain braces (same rule as the server), so a selection with a variable in it cannot become spintax.
    if (picked && !/[{}|]/.test(picked)) replaceRange(start, end, `{${picked}|}`, picked.length + 2);
    else replaceRange(start, picked ? start : end, '{Hi|Hello|Hey}', '{Hi|Hello|Hey}'.length);
  };
  const wrapConditional = (path: string) => {
    const { start, end } = selection();
    const picked = value.slice(start, end);
    const open = `{{#if ${path}}}`;
    const body = picked || `{{${path}}}`;
    replaceRange(start, end, `${open}${body}{{/if}}`, open.length + body.length);
  };

  // --- counter ---------------------------------------------------------------
  const info = useMemo(() => spintaxInfo(value), [value]);
  const over = max != null && info.maxLen > max;
  const usesAi = USES_AI_RE.test(value);
  // "opener: 312 ready · 14 waiting for you" for every {{ai.<key>}} this step uses (AI hub §4.4)
  const aiKeys = useMemo(() => Array.from(new Set(Array.from(value.matchAll(AI_KEY_RE), (m) => m[1]))), [value]);
  const lineStats = useHubSetup(usesAi ? workspaceId : null).data?.variables;

  // --- preview ---------------------------------------------------------------
  const previewOpen = panel === 'preview';
  const lead: PreviewLead | null = target.lead ?? sampleLead;
  const senderOptions = poolSenders.length ? poolSenders : senders;
  const senderId = target.senderId && senderOptions.some((s) => s.id === target.senderId) ? target.senderId : senderOptions[0]?.id ?? null;
  const ctxQ = useRenderContext(lead?.id, senderId, previewOpen);
  const found = useLeadSearch(workspaceId, debounced, previewOpen);
  const rendered = ctxQ.data ? renderTemplate(value, ctxQ.data) : '';
  const missing = ctxQ.data ? missingVariables(value, ctxQ.data) : [];
  const renderedLen = [...rendered].length;

  const inputCls = cn('w-full px-3 py-2 text-sm rounded-lg border bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-50', over ? 'border-red-400' : 'border-gray-300', className);
  const toolCls = 'inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 disabled:opacity-50';
  // "If": every field a sentence can depend on (the same names the popup lists, without the links and the filter examples)
  const condPaths = useMemo(() => {
    const list = visibleRows([...VARIABLE_CATALOG, ...workspaceRows(aiVars.data, allCustomKeys)], { channel, plain: false });
    const names = list.filter((v) => v.tab !== 'advanced' && !v.emailOnly).map((v) => (v.insert === 'if' ? /#if\s+([a-zA-Z0-9_.]+)/.exec(v.token)?.[1] ?? null : tokenName(v.token)));
    return Array.from(new Set(names.filter((n): n is string => !!n && !n.endsWith('booking_link'))));
  }, [aiVars.data, allCustomKeys, channel]);

  return (
    <div className="block relative">
      <div className="flex items-start justify-between mb-1 gap-2">
        <label htmlFor={fieldId} className="text-xs font-medium text-gray-600 pt-0.5">{label}</label>
        <span className="flex items-center flex-wrap justify-end gap-0.5">
          {max != null && (
            <span className={cn('text-xs tabular-nums mr-1', over ? 'text-red-600 font-medium' : 'text-gray-400')} title={info.combinations > 1 ? 'The longest spintax combination is what counts' : undefined} aria-live="polite">
              {info.maxLen.toLocaleString()}/{max.toLocaleString()}
            </span>
          )}
          <button type="button" onClick={() => setPanel(varsOpen ? null : 'vars')} aria-haspopup="dialog" aria-expanded={varsOpen} title="Insert a variable: lead, company, sender, AI and date fields" className={cn(toolCls, 'text-indigo-600 hover:bg-indigo-50')}><Braces className="w-3 h-3" aria-hidden /> Insert Variables</button>
          {!plain && <button type="button" onClick={wrapSpintax} title="Rotate wording: select text and click to turn it into {a|b}" className={cn(toolCls, 'text-indigo-600 hover:bg-indigo-50')}><Shuffle className="w-3 h-3" aria-hidden /> Spintax</button>}
          {!plain && <button type="button" onClick={() => setPanel(panel === 'cond' ? null : 'cond')} aria-haspopup="dialog" aria-expanded={panel === 'cond'} title="Show text only when a field has a value" className={cn(toolCls, 'text-indigo-600 hover:bg-indigo-50')}><GitBranch className="w-3 h-3" aria-hidden /> If</button>}
          <button type="button" onClick={() => setPanel(previewOpen ? null : 'preview')} aria-expanded={previewOpen} title="Preview as a real lead" className={cn(toolCls, previewOpen ? 'bg-gray-200 text-gray-800' : 'text-gray-600 hover:bg-gray-100')}><Eye className="w-3 h-3" aria-hidden /> Preview</button>
        </span>
      </div>
      {multiline ? (
        <textarea id={fieldId} ref={(el) => { ref.current = el; }} value={value} onChange={(e) => onChange(e.target.value)} onFocus={() => { touched.current = true; }} rows={rows} placeholder={placeholder} aria-invalid={over || undefined} className={cn(inputCls, 'min-h-[80px]')} />
      ) : (
        <input id={fieldId} ref={(el) => { ref.current = el; }} value={value} onChange={(e) => onChange(e.target.value)} onFocus={() => { touched.current = true; }} placeholder={placeholder} aria-invalid={over || undefined} className={inputCls} />
      )}
      {over && <span className="block text-xs text-red-600 mt-1">The longest version is {info.maxLen.toLocaleString()} characters. The limit is {max!.toLocaleString()}. Shorten the text or the longest spintax option.</span>}
      {info.combinations > 1 && <span className="block text-xs text-gray-500 mt-1">{info.combinations >= 1000000000 ? 'Over a billion' : info.combinations.toLocaleString()} combinations. Each lead always gets the same one. The counter uses the longest.</span>}
      {usesAi && <span className="block text-xs text-fuchsia-700 mt-1">Only approved lines are used. Anything not approved falls back.</span>}
      {usesAi && aiKeys.map((k) => {
        const v = lineStats?.find((x) => x.key === k);
        if (!v) return null;
        return (
          <span key={k} className="block text-xs text-gray-600 mt-0.5">
            <span className="font-mono">{k}</span>: {v.approved.toLocaleString()} ready
            {v.waiting > 0 && <> · <Link href={hubHref.needsYou({ type: 'line', where: v.id, mine: false })} target="_blank" className="text-indigo-700 hover:underline">{v.waiting.toLocaleString()} waiting for you</Link></>}
            {v.mode === 'off' && ' · switched off, no new lines are written'}
          </span>
        );
      })}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}

      {varsOpen && (
        <InsertVariablesModal onClose={closeVariables} onInsert={insertVariable} channel={channel} plain={plain} aiVars={aiVars} customKeys={allCustomKeys} />
      )}

      {panel === 'cond' && <div className="fixed inset-0 z-20" onClick={() => setPanel(null)} aria-hidden />}
      {panel === 'cond' && (
        <div role="dialog" aria-label="Conditional text" className="absolute right-0 z-30 mt-1 w-72 max-w-[90vw] bg-white border border-gray-200 rounded-lg shadow-lg py-1 max-h-72 overflow-y-auto">
          <p className="px-3 py-2 text-[11px] text-gray-500 leading-4">Pick a field. The selected text is shown only when that field has a value, so a missing field never leaves a broken sentence. Add <span className="font-mono">{'{{else}}'}</span> inside for a second wording.</p>
          {condPaths.length === 0 && <p className="px-3 py-1 text-xs text-gray-500">No fields available.</p>}
          {condPaths.map((p) => (
            <button key={p} type="button" onClick={() => wrapConditional(p)} className="w-full text-left px-3 py-1.5 text-xs font-mono text-gray-800 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none">{`{{#if ${p}}}…{{/if}}`}</button>
          ))}
        </div>
      )}

      {previewOpen && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50/60 p-2.5 text-xs space-y-2" role="region" aria-label={`${label} preview`}>
          <div className="grid grid-cols-2 gap-2">
            <div className="relative min-w-0">
              <span className="block text-[11px] text-gray-500 mb-0.5">Preview as lead</span>
              <div className="relative">
                <Search className="w-3 h-3 text-gray-400 absolute left-2 top-2" aria-hidden />
                <input value={leadSearch} onChange={(e) => setLeadSearch(e.target.value)} placeholder={leadLabel(lead)} aria-label="Search for a lead to preview" className="w-full pl-6 pr-2 py-1 text-xs rounded border border-gray-300 bg-white placeholder:text-gray-600" />
              </div>
              {leadSearch.trim() !== '' && (
                <div className="absolute left-0 right-0 z-30 mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
                  {found.isLoading ? <p className="px-2 py-1.5 text-gray-400">Searching…</p>
                    : found.error ? <p className="px-2 py-1.5 text-red-600">{parseError(found.error).message}</p>
                    : (found.data ?? []).length === 0 ? <p className="px-2 py-1.5 text-gray-500">No lead matches.</p>
                    : found.data!.map((l) => (
                      <button key={l.id} type="button" onClick={() => { setPreviewTarget({ lead: l }); setLeadSearch(''); }} className="w-full text-left px-2 py-1.5 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none truncate">{leadLabel(l)}</button>
                    ))}
                </div>
              )}
            </div>
            <label className="block min-w-0">
              <span className="block text-[11px] text-gray-500 mb-0.5">From sender</span>
              <select value={senderId ?? ''} onChange={(e) => setPreviewTarget({ senderId: e.target.value || null })} className="w-full px-2 py-1 text-xs rounded border border-gray-300 bg-white" disabled={senderOptions.length === 0}>
                {senderOptions.length === 0 && <option value="">No sender</option>}
                {senderOptions.map((s) => <option key={s.id} value={s.id}>{senderName(s)}</option>)}
              </select>
            </label>
          </div>
          {!lead ? (
            <p className="text-gray-500">No leads in this workspace yet. Import a lead to preview.</p>
          ) : ctxQ.isLoading ? (
            <p className="flex items-center gap-1.5 text-gray-500"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Loading {lead.full_name || 'lead'}…</p>
          ) : ctxQ.error ? (
            <p className="text-red-600" role="alert">{parseError(ctxQ.error).message}</p>
          ) : (
            <>
              <div className="whitespace-pre-wrap break-words text-gray-800 bg-white border border-gray-200 rounded-md p-2 max-h-56 overflow-y-auto">{rendered || <span className="text-gray-400">(empty)</span>}</div>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                <span>Exactly what {lead.full_name || 'this lead'} would get{info.combinations > 1 ? ', spintax included' : ''}.</span>
                {max != null && <span className={cn('tabular-nums', renderedLen > max && 'text-red-600 font-medium')}>{renderedLen.toLocaleString()} characters for this lead</span>}
              </div>
              {max != null && renderedLen > max && <p className="text-red-600">For this lead the text is over the limit of {max.toLocaleString()}. Long field values count too.</p>}
              {missing.length > 0 && <p className="text-amber-700">Empty for this lead, and no fallback: {missing.map((m) => `{{${m}}}`).join(', ')}. Add a fallback like <span className="font-mono">{`{{${missing[0]}|…}}`}</span> or wrap the sentence in an “If”.</p>}
              {channel === 'email' && /unsubscribe_link/.test(value) && <p className="text-gray-500">The unsubscribe link here is an example. The real link is unique to each lead.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
