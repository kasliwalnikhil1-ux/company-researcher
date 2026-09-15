'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useClients, useLists, useTags } from '@/lib/outreach/queries';
import { callFn, parseError } from '@/lib/outreach/api';
import { Badge, Button, ErrorBox, Select, Spinner } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { FileSpreadsheet, UploadCloud, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import { TagMultiSelect } from './TagMultiSelect';
import { LEAD_FIELDS, dedupeKey, formatNumber, guessField, toCustomKey, type ToastFn } from '../helpers';

// papaparse ships without type definitions in this repo; keep a minimal local contract.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Papa = require('papaparse') as {
  parse: (file: File, opts: { header: boolean; skipEmptyLines: boolean | 'greedy'; complete: (r: { data: Record<string, string>[]; meta: { fields?: string[] }; errors: Array<{ message: string; row?: number }> }) => void; error: (e: Error) => void }) => void;
};

interface Parsed { file: File; headers: string[]; rows: Record<string, string>[]; warnings: string[] }
interface ColMap { field: string; customKey: string }
interface Dedupe { checked: number; existing: number; fresh: number; unkeyed: number }

const PREVIEW = 5;
const DEDUPE_SAMPLE = 200;
const MAX_BYTES = 50 * 1024 * 1024;

function resolveMapping(headers: string[], cols: Record<string, ColMap>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const c = cols[h];
    if (!c || !c.field) continue;
    if (c.field === 'custom') { const k = toCustomKey(c.customKey); if (k) out[h] = `custom.${k}`; }
    else out[h] = c.field;
  }
  return out;
}

export function CsvImport({ toast, onCreated }: { toast: ToastFn; onCreated: () => void }) {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const clients = useClients(workspace?.id);
  const lists = useLists(workspace?.id);
  const tags = useTags(workspace?.id);
  const inputRef = useRef<HTMLInputElement>(null);

  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parsing, setParsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cols, setCols] = useState<Record<string, ColMap>>({});
  const [dedupe, setDedupe] = useState<Dedupe | null>(null);
  const [dedupeBusy, setDedupeBusy] = useState(false);
  const [clientId, setClientId] = useState('');
  const [listId, setListId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mapping = useMemo(() => (parsed ? resolveMapping(parsed.headers, cols) : {}), [parsed, cols]);
  const mappedFields = useMemo(() => new Set(Object.values(mapping)), [mapping]);
  const hasKey = mappedFields.has('linkedin_url') || mappedFields.has('public_identifier') || mappedFields.has('email_work') || mappedFields.has('email_personal');
  const duplicateFields = useMemo(() => {
    const seen = new Map<string, number>();
    for (const f of Object.values(mapping)) seen.set(f, (seen.get(f) ?? 0) + 1);
    return Array.from(seen.entries()).filter(([, n]) => n > 1).map(([f]) => f);
  }, [mapping]);

  const loadFile = useCallback((file: File) => {
    setError(null); setDedupe(null);
    if (!/\.(csv|txt|tsv)$/i.test(file.name) && !/csv|text/i.test(file.type)) { setError('Choose a .csv file.'); return; }
    if (file.size > MAX_BYTES) { setError('File is larger than 50 MB. Split it into smaller files.'); return; }
    setParsing(true);
    Papa.parse(file, {
      header: true, skipEmptyLines: 'greedy',
      complete: (r) => {
        setParsing(false);
        const headers = (r.meta.fields ?? []).filter((h) => h != null);
        if (headers.length === 0 || r.data.length === 0) { setError('The file has no header row or no data rows.'); return; }
        const warnings = r.errors.slice(0, 3).map((e) => `${e.message}${e.row != null ? ` (row ${e.row + 2})` : ''}`);
        if (r.errors.length > 3) warnings.push(`…and ${r.errors.length - 3} more parse warnings`);
        setParsed({ file, headers, rows: r.data, warnings });
        const next: Record<string, ColMap> = {};
        const used = new Set<string>();
        for (const h of headers) {
          let g = guessField(h);
          if (g && used.has(g)) g = '';
          if (g) used.add(g);
          next[h] = { field: g, customKey: toCustomKey(h) };
        }
        setCols(next);
      },
      error: (e) => { setParsing(false); setError(`Could not parse file: ${e.message}`); },
    });
  }, []);

  const reset = () => { setParsed(null); setCols({}); setDedupe(null); setError(null); if (inputRef.current) inputRef.current.value = ''; };

  // Dedupe preview over the first 200 rows, recomputed when the mapping changes.
  useEffect(() => {
    if (!parsed || !workspace || !hasKey) { setDedupe(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setDedupeBusy(true);
      try {
        const sample = parsed.rows.slice(0, DEDUPE_SAMPLE);
        const pubs = new Set<string>(); const emails = new Set<string>(); let unkeyed = 0;
        for (const row of sample) {
          const k = dedupeKey(row, mapping);
          if (!k) { unkeyed++; continue; }
          if (k.kind === 'public_identifier') pubs.add(k.value); else emails.add(k.value);
        }
        const found = new Set<string>();
        if (pubs.size) {
          const { data, error: err } = await supabase.from('outreach_leads').select('public_identifier').eq('workspace_id', workspace.id).in('public_identifier', Array.from(pubs));
          if (err) throw err;
          for (const r of (data ?? []) as { public_identifier: string | null }[]) if (r.public_identifier) found.add(`p:${r.public_identifier.toLowerCase()}`);
        }
        if (emails.size) {
          const list = Array.from(emails);
          const [w, p] = await Promise.all([
            supabase.from('outreach_leads').select('email_work').eq('workspace_id', workspace.id).in('email_work', list),
            supabase.from('outreach_leads').select('email_personal').eq('workspace_id', workspace.id).in('email_personal', list),
          ]);
          if (w.error) throw w.error; if (p.error) throw p.error;
          for (const r of (w.data ?? []) as { email_work: string | null }[]) if (r.email_work) found.add(`e:${r.email_work.toLowerCase()}`);
          for (const r of (p.data ?? []) as { email_personal: string | null }[]) if (r.email_personal) found.add(`e:${r.email_personal.toLowerCase()}`);
        }
        let existing = 0;
        for (const v of pubs) if (found.has(`p:${v}`)) existing++;
        for (const v of emails) if (found.has(`e:${v}`)) existing++;
        const keyed = pubs.size + emails.size;
        if (!cancelled) setDedupe({ checked: sample.length, existing, fresh: keyed - existing, unkeyed });
      } catch (e) {
        if (!cancelled) { setDedupe(null); setError(parseError(e).message); }
      } finally {
        if (!cancelled) setDedupeBusy(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [parsed, mapping, hasKey, workspace]);

  const submit = async () => {
    if (!parsed || !workspace || !hasKey || duplicateFields.length) return;
    setError(null);
    try {
      setBusy('Uploading file…');
      const path = `${workspace.id}/${Date.now()}-${parsed.file.name}`;
      const up = await supabase.storage.from('outreach-imports').upload(path, parsed.file, { contentType: 'text/csv', upsert: false });
      if (up.error) throw up.error;
      setBusy('Creating import job…');
      await callFn('imports-create', { workspace_id: workspace.id, kind: 'csv', storage_path: path, mapping, row_count: parsed.rows.length, client_id: clientId || null, list_id: listId || null, tag_ids: tagIds });
      qc.invalidateQueries({ queryKey: qk.imports(workspace.id) });
      toast(`Import queued — ${formatNumber(parsed.rows.length)} rows`);
      reset(); setTagIds([]);
      onCreated();
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) loadFile(f); };

  if (!parsed) {
    return (
      <div className="space-y-3">
        <div role="button" tabIndex={0} aria-label="Choose a CSV file" onClick={() => inputRef.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
          className={cn('flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center cursor-pointer transition-colors', dragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-indigo-400 hover:bg-gray-50')}>
          {parsing ? <Spinner className="py-0" /> : <UploadCloud className="w-8 h-8 text-indigo-500" />}
          <p className="text-sm font-medium text-gray-900">{parsing ? 'Reading file…' : 'Drop a CSV here or click to choose'}</p>
          <p className="text-xs text-gray-500">First row must be a header. Include a LinkedIn profile URL or an email column so leads can be de-duplicated. Up to 50 MB.</p>
          <input ref={inputRef} type="file" accept=".csv,text/csv,.tsv,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
        </div>
        {error && <ErrorBox message={error} />}
      </div>
    );
  }

  const sel = 'w-full px-2 py-1.5 text-sm rounded-md border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
        <FileSpreadsheet className="w-5 h-5 text-indigo-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900 truncate">{parsed.file.name}</div>
          <div className="text-xs text-gray-500">{formatNumber(parsed.rows.length)} data rows · {parsed.headers.length} columns · {(parsed.file.size / 1024).toFixed(0)} KB</div>
        </div>
        <Button variant="ghost" size="sm" onClick={reset} title="Choose another file"><X className="w-4 h-4" /> Change file</Button>
      </div>
      {parsed.warnings.length > 0 && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{parsed.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}

      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">1. Map columns</h3>
        <p className="text-xs text-gray-500 mb-3">We guessed from the header names — adjust as needed. Unmapped columns are ignored. Choose “Custom field” to keep a column under a key of your choice.</p>
        <div className="overflow-x-auto border border-gray-200 rounded-xl">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 border-b border-gray-200">CSV column</th>
                <th className="px-3 py-2 border-b border-gray-200 w-56">Lead field</th>
                <th className="px-3 py-2 border-b border-gray-200">Preview (first {PREVIEW} rows)</th>
              </tr>
            </thead>
            <tbody>
              {parsed.headers.map((h) => {
                const c = cols[h] ?? { field: '', customKey: toCustomKey(h) };
                const dup = c.field && c.field !== 'custom' && duplicateFields.includes(c.field);
                return (
                  <tr key={h} className="align-top border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap max-w-[200px] truncate" title={h}>{h || <span className="text-gray-400 italic">(empty header)</span>}</td>
                    <td className="px-3 py-2">
                      <select aria-label={`Field for ${h}`} value={c.field} onChange={(e) => setCols((m) => ({ ...m, [h]: { ...c, field: e.target.value } }))} className={cn(sel, dup && 'border-red-400')}>
                        {LEAD_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                      {c.field === 'custom' && (
                        <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">custom.<input aria-label="Custom field key" value={c.customKey} onChange={(e) => setCols((m) => ({ ...m, [h]: { ...c, customKey: e.target.value } }))} className="flex-1 px-2 py-1 text-xs rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="key" /></div>
                      )}
                      {dup && <p className="text-xs text-red-600 mt-1">Mapped twice</p>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      <div className="flex flex-col gap-0.5 max-w-[360px]">
                        {parsed.rows.slice(0, PREVIEW).map((r, i) => <span key={i} className="truncate">{r[h] || <span className="text-gray-300">∅</span>}</span>)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!hasKey && <p className="text-xs text-amber-700 mt-2 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Map a LinkedIn URL / identifier or an email column — it is the de-duplication key.</p>}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">2. De-duplication preview</h3>
        {!hasKey ? <p className="text-xs text-gray-500">Map an identifier column to preview duplicates.</p> : dedupeBusy && !dedupe ? <p className="text-xs text-gray-500">Checking the first {DEDUPE_SAMPLE} rows…</p> : dedupe ? (
          <div className={cn('flex flex-wrap items-center gap-3 text-sm', dedupeBusy && 'opacity-60')}>
            <Badge tone="green">{formatNumber(dedupe.fresh)} new</Badge>
            <Badge tone="blue">{formatNumber(dedupe.existing)} existing (will be merged)</Badge>
            {dedupe.unkeyed > 0 && <Badge tone="amber">{formatNumber(dedupe.unkeyed)} without identifier (skipped)</Badge>}
            <span className="text-xs text-gray-500">based on the first {formatNumber(dedupe.checked)} of {formatNumber(parsed.rows.length)} rows. Existing leads keep their data; empty fields are filled from the file.</span>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">3. Options</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Select label="Client (optional)" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">No client</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Add to list (optional)" value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">No list</option>
            {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </div>
        <TagMultiSelect tags={tags.data ?? []} value={tagIds} onChange={setTagIds} />
      </section>

      {error && <ErrorBox message={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submit} loading={!!busy} disabled={!hasKey || duplicateFields.length > 0}>{busy ?? <><CheckCircle2 className="w-4 h-4" /> Import {formatNumber(parsed.rows.length)} rows</>}</Button>
        <span className="text-xs text-gray-500">The file is processed in the background; progress shows in the jobs table below.</span>
      </div>
    </div>
  );
}
