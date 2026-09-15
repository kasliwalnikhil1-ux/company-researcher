'use client';

import { useMemo, useRef, useState } from 'react';
import { Braces, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TEMPLATE_VARIABLES } from '@/lib/outreach/nodes';
import { missingVariables, renderTemplate } from '@/lib/outreach/render';
import { useBuilder } from './context';
import { senderName } from './helpers';

const FALLBACKS: Record<string, string> = { first_name: 'there', full_name: 'there', company: 'your company', title: 'your role', 'sender.first_name': '', 'sender.full_name': '' };

export function tokenFor(variable: string): string {
  const fb = FALLBACKS[variable];
  return fb ? `{{${variable}|${fb}}}` : `{{${variable}}}`;
}

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
  multiline?: boolean;
  rows?: number;
  hint?: string;
  placeholder?: string;
  className?: string;
}

/** Text input/textarea with a template-variable picker (inserts at the cursor) and a live preview using a real lead. */
export default function TemplateField({ label, value, onChange, max, multiline = true, rows = 4, hint, placeholder, className }: Props) {
  const { sampleLead, customKeys, poolSenders, senders } = useBuilder();
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [open, setOpen] = useState<'vars' | 'preview' | null>(null);
  const [customKey, setCustomKey] = useState('');

  const variables = useMemo(() => {
    const base = TEMPLATE_VARIABLES.filter((v) => v !== 'custom.<key>');
    return [...base, ...customKeys.map((k) => `custom.${k}`)];
  }, [customKeys]);

  const insert = (token: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    setOpen(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      try { el.setSelectionRange(pos, pos); } catch { /* input types that do not support selection */ }
    });
  };

  const sender = poolSenders[0] ?? senders[0] ?? null;
  const preview = sampleLead ? renderTemplate(value, { lead: sampleLead, sender }) : '';
  const missing = sampleLead ? missingVariables(value, { lead: sampleLead, sender }) : [];
  const over = max != null && value.length > max;

  const inputCls = cn('w-full px-3 py-2 text-sm rounded-lg border bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-50', over ? 'border-red-400' : 'border-gray-300', className);

  return (
    <div className="block relative">
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-xs font-medium text-gray-600">{label}</span>
        <span className="flex items-center gap-1">
          {max != null && <span className={cn('text-xs tabular-nums mr-1', over ? 'text-red-600 font-medium' : 'text-gray-400')}>{value.length}/{max}</span>}
          <button type="button" onClick={() => setOpen(open === 'vars' ? null : 'vars')} title="Insert a variable" className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:bg-indigo-50 rounded px-1.5 py-0.5"><Braces className="w-3 h-3" /> Variable</button>
          <button type="button" onClick={() => setOpen(open === 'preview' ? null : 'preview')} title="Preview with a real lead" className="inline-flex items-center gap-1 text-[11px] text-gray-600 hover:bg-gray-100 rounded px-1.5 py-0.5"><Eye className="w-3 h-3" /> Preview</button>
        </span>
      </div>
      {multiline ? (
        <textarea ref={(el) => { ref.current = el; }} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} className={cn(inputCls, 'min-h-[80px]')} />
      ) : (
        <input ref={(el) => { ref.current = el; }} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputCls} />
      )}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}

      {open && <div className="fixed inset-0 z-20" onClick={() => setOpen(null)} />}
      {open === 'vars' && (
        <div className="absolute right-0 z-30 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg py-1 max-h-72 overflow-y-auto">
          {variables.map((v) => (
            <button key={v} type="button" onClick={() => insert(tokenFor(v))} className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between gap-2">
              <span className="font-mono text-gray-800">{v}</span>
              {FALLBACKS[v] && <span className="text-gray-400 truncate">fallback “{FALLBACKS[v]}”</span>}
            </button>
          ))}
          <div className="border-t border-gray-100 mt-1 px-3 py-2">
            <div className="text-[11px] text-gray-500 mb-1">Custom field</div>
            <div className="flex gap-1">
              <input value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="key" aria-label="Custom field key" className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-gray-300" onKeyDown={(e) => { if (e.key === 'Enter' && customKey.trim()) insert(`{{custom.${customKey.trim()}}}`); }} />
              <button type="button" disabled={!customKey.trim()} onClick={() => insert(`{{custom.${customKey.trim()}}}`)} className="text-xs px-2 py-1 rounded bg-indigo-600 text-white disabled:opacity-50">Insert</button>
            </div>
          </div>
        </div>
      )}
      {open === 'preview' && (
        <div className="absolute right-0 z-30 mt-1 w-80 max-w-[90vw] bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs">
          {!sampleLead ? (
            <p className="text-gray-500">No leads in this workspace yet — import a lead to preview.</p>
          ) : (
            <>
              <div className="text-[11px] text-gray-500 mb-1">Preview for <span className="font-medium text-gray-700">{sampleLead.full_name || sampleLead.public_identifier || 'most recent lead'}</span>{sender ? ` from ${senderName(sender)}` : ''}</div>
              <div className="whitespace-pre-wrap break-words text-gray-800 bg-gray-50 rounded-md p-2 max-h-48 overflow-y-auto">{preview || <span className="text-gray-400">(empty)</span>}</div>
              {missing.length > 0 && <p className="mt-2 text-amber-700">Empty for this lead (no fallback): {missing.join(', ')}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
