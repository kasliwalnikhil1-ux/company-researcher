'use client';

import { useId, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { callFn, parseError } from '@/lib/outreach/api';
import { fieldOf } from '@/lib/outreach/aiFields';
import { factLines, type AiPreviewResult } from '@/lib/outreach/intel';
import type { AiField } from '@/lib/outreach/types';
import { Button, Card, ErrorBox } from '@/components/outreach/ui';
import { useDebounced } from '@/components/outreach/inbox/hooks';
import { useLeadSearch, type PreviewLead } from '@/components/outreach/sequences/FormsShared';
import { cn } from '@/lib/utils';
import { FieldValueTable, fieldDataEmpty, readFieldData } from './FieldValueEditor';
import { variableProblems, type VariableDraft } from './variableModel';

const leadLabel = (l: PreviewLead) => `${l.full_name ?? 'Unnamed lead'}${l.company ? ` · ${l.company}` : ''}`;

/** What one try returned, with the form values it was made with (the form may have changed since). */
interface Tried { lead: PreviewLead; fields: AiField[] | null; fallback: string; result?: AiPreviewResult; error?: string }

/**
 * "Try on a lead" on the variable page (owners and managers): writes the variable once for one lead with what is in the
 * form now, saved or not, and shows the result. Nothing is stored and nothing is sent.
 *   onInvalid   the form cannot be tried as it is: the page shows what is wrong
 */
export default function TryOnLead({ ws, draft, onInvalid }: { ws: string; draft: VariableDraft; onInvalid: () => void }) {
  const id = useId();
  const listId = `${id}-leads`;
  const [search, setSearch] = useState('');
  const [lead, setLead] = useState<PreviewLead | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState<Tried | null>(null);
  const [blocked, setBlocked] = useState(false);
  const debounced = useDebounced(search, 250);
  // With a lead picked the box shows its name: that is not a search.
  const found = useLeadSearch(ws, lead ? '' : debounced, open);
  const options = found.data ?? [];
  const typed = draft.output === 'fields';

  const pick = (l: PreviewLead) => { setLead(l); setSearch(leadLabel(l)); setOpen(false); };

  const run = async () => {
    if (!lead || busy) return;
    const p = variableProblems(draft, []);
    if (p.prompt || p.fields || p.fieldList || p.fallback || p.max_chars) { setBlocked(true); onInvalid(); return; }
    setBlocked(false);
    const fields = typed ? draft.fields.map(fieldOf) : null;
    const fallback = typed ? '' : draft.fallback.trim();
    setBusy(true); setTried(null);
    try {
      const result = await callFn<AiPreviewResult>('ai-variables', {
        action: 'preview_variable', workspace_id: ws, lead_id: lead.id, ...(draft.id ? { variable_id: draft.id } : {}),
        // what is in the form wins over the saved variable
        variable: { prompt: draft.prompt.trim(), max_chars: typed ? 220 : Number(draft.max_chars), needs_posts: draft.needs_posts, fallback, output: draft.output, fields: fields ?? [] },
      });
      setTried({ lead, fields, fallback, result });
    } catch (e) { setTried({ lead, fields, fallback, error: parseError(e).message }); }
    finally { setBusy(false); }
  };

  const result = tried?.result ?? null;
  const data = result ? readFieldData(result.data) : null;
  const text = (result?.text ?? result?.line ?? '').trim();
  const facts = factLines(result?.facts);

  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><FlaskConical className="w-4 h-4 text-fuchsia-500" aria-hidden="true" /> Try on a lead</span>} className="min-w-0">
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative flex-1 min-w-[220px]" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
            <label htmlFor={id} className="block text-xs font-medium text-gray-600 mb-1">Lead</label>
            <input id={id} type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" autoComplete="off"
              aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
              value={search} placeholder="Search by name or company"
              onFocus={() => { if (!lead) setOpen(true); }}
              onChange={(e) => { setSearch(e.target.value); setLead(null); setActive(0); setOpen(true); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive((a) => Math.min(options.length - 1, a + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                else if (e.key === 'Enter') { e.preventDefault(); if (open && options[active]) pick(options[active]); else void run(); }
                else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
              }}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" />
            {open && (
              <ul id={listId} role="listbox" aria-label="Leads" className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg py-1 text-sm">
                {found.isLoading ? <li className="px-3 py-1.5 text-gray-400">Searching…</li>
                  : found.error ? <li className="px-3 py-1.5 text-red-600">{parseError(found.error).message}</li>
                  : options.length === 0 ? <li className="px-3 py-1.5 text-gray-500">No lead matches.</li>
                  : options.map((l, i) => (
                    <li key={l.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(l)}
                      className={cn('px-3 py-1.5 cursor-pointer truncate', i === active ? 'bg-indigo-50 text-indigo-900' : 'text-gray-900')}>{leadLabel(l)}</li>
                  ))}
              </ul>
            )}
          </div>
          <Button type="button" variant="secondary" loading={busy} disabled={!lead} onClick={() => void run()} title={lead ? undefined : 'Pick a lead first'}>Try</Button>
        </div>
        <p className="text-xs text-gray-500">{typed ? 'Fills the fields once for this lead' : 'Writes the line once for this lead'} with what is in the form now, saved or not. Nothing is saved and nothing is sent.</p>
        {blocked && <p role="alert" className="text-xs text-red-600">The form above is not ready to try. Check the parts marked in red.</p>}
        {busy && <p className="text-xs text-gray-500" role="status">Asking the AI. This takes a few seconds.</p>}
        {tried?.error && <ErrorBox message={tried.error} />}
        {tried && result && (
          <div className="text-sm bg-fuchsia-50/60 border border-fuchsia-100 rounded-lg p-3 space-y-2" role="status">
            <div className="text-xs text-gray-600">Result for <span className="font-medium text-gray-900">{leadLabel(tried.lead)}</span></div>
            {tried.fields ? (
              <>
                <FieldValueTable fields={tried.fields} data={data} />
                {(result.blank || fieldDataEmpty(tried.fields, data)) && <p className="text-gray-600">Nothing usable on the profile, so every field stays empty. Messages use the fallback written in each token.</p>}
              </>
            ) : text ? <p className="text-gray-900 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</p>
              : <p className="text-gray-600">Nothing usable on the profile, so the fallback is used{(result.fallback ?? tried.fallback) ? <>: <span className="text-gray-900">{result.fallback ?? tried.fallback}</span></> : '.'}</p>}
            {facts.length > 0 && (
              <div className="text-xs text-gray-600">
                <span className="font-medium">Facts used</span>
                <ul className="mt-0.5 ml-4 list-disc space-y-0.5">{facts.map((f, i) => <li key={i} className="break-words [overflow-wrap:anywhere]">{f}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
