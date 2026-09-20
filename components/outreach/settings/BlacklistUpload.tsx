'use client';

import { useRef, useState } from 'react';
import { FileUp, Upload, X } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { Badge, Button, ErrorBox } from '@/components/outreach/ui';
import { Note } from './shared';
import type { AddSuppressionsResult, BlacklistKind } from './types';

// papaparse ships without type definitions in this repo; keep a minimal local contract.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Papa = require('papaparse') as {
  parse: (file: File, opts: { header: boolean; skipEmptyLines: boolean | 'greedy'; complete: (r: { data: string[][]; errors: Array<{ message: string; row?: number }> }) => void; error: (e: Error) => void }) => void;
};

export const CHUNK = 5000;          // rows per `add_suppressions` call (the function accepts up to 20,000)
const MAX_ROWS = 200_000;
const MAX_BYTES = 25 * 1024 * 1024;

const KIND_ALIASES: Record<string, BlacklistKind> = {
  domain: 'domain', website: 'domain', email: 'email', 'email address': 'email',
  public_identifier: 'public_identifier', linkedin: 'public_identifier', 'linkedin profile': 'public_identifier', profile: 'public_identifier', person: 'public_identifier',
  company: 'company', 'company name': 'company', 'linkedin company': 'company', organisation: 'company', organization: 'company',
};
const VALUE_HEADERS = ['value', 'domain', 'email', 'company', 'linkedin', 'linkedin url', 'linkedin_url', 'profile url', 'profile_url', 'url', 'website'];
const KIND_HEADERS = ['kind', 'type'];
const REASON_HEADERS = ['reason', 'note', 'notes', 'comment'];

export interface ParsedRow { value: string; kind?: BlacklistKind; reason?: string }
interface Parsed { name: string; rows: ParsedRow[]; hadHeader: boolean; dropped: number; unknownKinds: number; warnings: string[] }

/** One value per row. Optional `kind` and `reason` columns are found by their header. Without a header the first column is the value. */
export function rowsFromCsv(data: string[][]): Omit<Parsed, 'name' | 'warnings'> {
  const clean = data.map((r) => r.map((c) => (c ?? '').toString().trim()));
  const first = (clean[0] ?? []).map((c) => c.toLowerCase());
  const hadHeader = first.some((c) => VALUE_HEADERS.includes(c) || KIND_HEADERS.includes(c) || REASON_HEADERS.includes(c)) && !first.some((c) => c.includes('@') || c.includes('/'));
  let vi = 0, ki = -1, ri = -1;
  if (hadHeader) {
    ki = first.findIndex((c) => KIND_HEADERS.includes(c));
    ri = first.findIndex((c) => REASON_HEADERS.includes(c));
    vi = first.findIndex((c) => c === 'value');
    if (vi < 0) vi = first.findIndex((c, i) => i !== ki && i !== ri && VALUE_HEADERS.includes(c));
    if (vi < 0) vi = first.findIndex((_c, i) => i !== ki && i !== ri);
    if (vi < 0) vi = 0;
  }
  const rows: ParsedRow[] = [];
  const seen = new Set<string>();
  let dropped = 0, unknownKinds = 0;
  for (const r of hadHeader ? clean.slice(1) : clean) {
    const value = r[vi] ?? '';
    if (!value) { dropped++; continue; }
    const rawKind = ki >= 0 ? (r[ki] ?? '').toLowerCase() : '';
    const kind = rawKind ? KIND_ALIASES[rawKind] : undefined;
    if (rawKind && !kind) unknownKinds++;
    const key = `${kind ?? ''}|${value.toLowerCase()}`;
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    const reason = ri >= 0 ? r[ri] : '';
    rows.push({ value, ...(kind ? { kind } : {}), ...(reason ? { reason: reason.slice(0, 300) } : {}) });
  }
  return { rows, hadHeader, dropped, unknownKinds };
}

export default function BlacklistUpload({ workspaceId, clientId, sequenceId, scopeLabel, scopeReady, disabled, onDone }: {
  workspaceId: string; clientId: string | null; sequenceId: string | null; scopeLabel: string; scopeReady: boolean; disabled?: boolean; onDone: (r: AddSuppressionsResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; total: number; added: number; skipped: number } | null>(null);
  const [result, setResult] = useState<(AddSuppressionsResult & { failedAfter?: number; message?: string }) | null>(null);
  const uploading = !!progress;

  function reset() { setParsed(null); setError(null); setResult(null); if (inputRef.current) inputRef.current.value = ''; }

  function pick(file: File | undefined) {
    setError(null); setResult(null); setParsed(null);
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name)) { setError('Choose a .csv or .txt file.'); return; }
    if (file.size > MAX_BYTES) { setError('This file is larger than 25 MB. Split it and upload the parts one by one.'); return; }
    setParsing(true);
    Papa.parse(file, {
      header: false, skipEmptyLines: 'greedy',
      complete: (r) => {
        setParsing(false);
        const out = rowsFromCsv(r.data);
        if (!out.rows.length) { setError('No values found. Put one value per row in the first column.'); return; }
        if (out.rows.length > MAX_ROWS) { setError(`This file has ${out.rows.length.toLocaleString()} rows. The limit is ${MAX_ROWS.toLocaleString()} per upload.`); return; }
        const warnings: string[] = [];
        if (out.unknownKinds) warnings.push(`${out.unknownKinds.toLocaleString()} row${out.unknownKinds === 1 ? ' has' : 's have'} a kind we do not know. We will work it out from the value instead. Known kinds: domain, email, linkedin, company.`);
        if (r.errors.length) warnings.push(`${r.errors.length.toLocaleString()} line${r.errors.length === 1 ? '' : 's'} could not be read cleanly${r.errors[0]?.row != null ? ` (first at line ${r.errors[0].row + 1})` : ''}.`);
        setParsed({ name: file.name, ...out, warnings });
      },
      error: (e) => { setParsing(false); setError(`Could not read the file: ${e.message}`); },
    });
  }

  async function upload() {
    if (!parsed || !scopeReady) return;
    setError(null); setResult(null);
    let added = 0, skipped = 0, sent = 0;
    setProgress({ sent, total: parsed.rows.length, added, skipped });
    try {
      for (let i = 0; i < parsed.rows.length; i += CHUNK) {
        const chunk = parsed.rows.slice(i, i + CHUNK);
        const r = await rpc<AddSuppressionsResult>('add_suppressions', { p_ws: workspaceId, p_rows: chunk, p_client: clientId, p_sequence: sequenceId, p_source: 'csv' });
        added += r?.added ?? 0; skipped += r?.skipped ?? 0; sent += chunk.length;
        setProgress({ sent, total: parsed.rows.length, added, skipped });
      }
      setResult({ added, skipped });
      setParsed(null);
      if (inputRef.current) inputRef.current.value = '';
      onDone({ added, skipped });
    } catch (e) {
      // earlier chunks are already saved: say so, so the person can upload the same file again safely (duplicates are skipped)
      setResult({ added, skipped, failedAfter: sent, message: parseError(e).message });
      if (added) onDone({ added, skipped });
    } finally { setProgress(null); }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">One value per row. Optional columns: <code>kind</code> (domain, email, linkedin or company) and <code>reason</code>. Without a <code>kind</code> we work it out from the value. Full LinkedIn URLs are fine.</p>
      <input ref={inputRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" id="blacklist-csv" onChange={(e) => pick(e.target.files?.[0])} disabled={disabled || uploading} />
      {!parsed && (
        <label htmlFor="blacklist-csv" className={`flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-gray-300 rounded-lg px-4 py-6 text-center text-sm text-gray-600 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/40'} focus-within:ring-2 focus-within:ring-indigo-500`}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!disabled && !uploading) pick(e.dataTransfer.files?.[0]); }}>
          <FileUp className="w-5 h-5 text-gray-400" />
          <span>{parsing ? 'Reading the file…' : 'Choose a CSV file or drop it here'}</span>
        </label>
      )}
      {error && <ErrorBox message={error} />}
      {parsed && (
        <div className="border border-gray-200 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0"><div className="text-sm font-medium text-gray-900 truncate">{parsed.name}</div>
              <div className="text-xs text-gray-500">{parsed.rows.length.toLocaleString()} value{parsed.rows.length === 1 ? '' : 's'}{parsed.dropped ? `, ${parsed.dropped.toLocaleString()} empty or repeated rows left out` : ''}{parsed.hadHeader ? ', header row found' : ''}</div></div>
            <button type="button" onClick={reset} disabled={uploading} aria-label="Remove file" className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"><X className="w-4 h-4" /></button>
          </div>
          <ul className="text-xs text-gray-600 space-y-0.5">
            {parsed.rows.slice(0, 4).map((r, i) => <li key={i} className="flex items-center gap-2 min-w-0"><span className="font-mono truncate">{r.value}</span>{r.kind && <Badge>{r.kind === 'public_identifier' ? 'linkedin' : r.kind}</Badge>}{r.reason && <span className="text-gray-400 truncate">{r.reason}</span>}</li>)}
            {parsed.rows.length > 4 && <li className="text-gray-400">and {(parsed.rows.length - 4).toLocaleString()} more</li>}
          </ul>
          {parsed.warnings.map((w) => <Note key={w} tone="amber" className="text-xs">{w}</Note>)}
          {progress ? (
            <div aria-live="polite">
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${Math.round((progress.sent / progress.total) * 100)}%` }} /></div>
              <div className="text-xs text-gray-500 mt-1">{progress.sent.toLocaleString()} of {progress.total.toLocaleString()} sent. {progress.added.toLocaleString()} added so far.</div>
            </div>
          ) : (
            <Button className="w-full" onClick={upload} disabled={disabled || !scopeReady}><Upload className="w-4 h-4" /> Block {parsed.rows.length.toLocaleString()} value{parsed.rows.length === 1 ? '' : 's'} for {scopeLabel}</Button>
          )}
          {!scopeReady && <div className="text-xs text-amber-700">Pick the client or sequence first.</div>}
        </div>
      )}
      {result && (
        <div aria-live="polite">
          {result.message
            ? <ErrorBox message={`Stopped after ${(result.failedAfter ?? 0).toLocaleString()} rows: ${result.message} ${result.added.toLocaleString()} were added before that. You can upload the same file again; entries already on the list are skipped.`} />
            : <Note tone="green"><strong>{result.added.toLocaleString()}</strong> added, <strong>{result.skipped.toLocaleString()}</strong> skipped. Skipped rows were already on this list or were empty.</Note>}
        </div>
      )}
    </div>
  );
}
