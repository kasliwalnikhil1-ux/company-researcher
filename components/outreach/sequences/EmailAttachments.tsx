'use client';

// Files sent with every email of a "Send email" step. Uploaded to the private outreach-attachments bucket under
// <ws>/sequence-files/<sequence>/<node>/ and listed on the step as config.attachments = [{path, name, mime, size}].
// The engine downloads them at send time (execute.ts stepAttachments).
import { useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { parseError } from '@/lib/outreach/api';
import { Button } from '@/components/outreach/ui';
import { fmtBytes } from '@/components/outreach/inbox/hooks';
import { useBuilder } from './context';
import { Note } from './FormsShared';

const BUCKET = 'outreach-attachments';
const MAX_FILES = 5;
const MAX_TOTAL = 10 * 1024 * 1024;   // most mail servers reject a message much above this once encoded

export interface StepAttachment { path: string; name: string; mime: string | null; size: number }

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';

export function EmailAttachments({ nodeId, value, onChange }: { nodeId: string; value: unknown; onChange: (next: StepAttachment[] | undefined) => void }) {
  const { workspaceId, sequenceId, readOnly } = useBuilder();
  const files: StepAttachment[] = Array.isArray(value) ? (value as StepAttachment[]).filter((f) => f && typeof f.path === 'string') : [];
  const total = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    setError(null);
    if (files.length + picked.length > MAX_FILES) { setError(`An email can carry at most ${MAX_FILES} files.`); return; }
    const size = picked.reduce((s, f) => s + f.size, total);
    if (size > MAX_TOTAL) { setError(`Files are limited to ${fmtBytes(MAX_TOTAL)} in total per email. Share a link for bigger files.`); return; }
    setBusy(true);
    const added: StepAttachment[] = [];
    try {
      for (const f of picked) {
        const path = `${workspaceId}/sequence-files/${sequenceId}/${nodeId}/${Date.now()}-${safeName(f.name)}`;
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined, upsert: false });
        if (upErr) throw new Error(`Could not upload ${f.name}: ${parseError(upErr).message}`);
        added.push({ path, name: f.name, mime: f.type || null, size: f.size });
      }
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      if (added.length) onChange([...files, ...added]);
      setBusy(false);
    }
  };

  const remove = (path: string) => {
    const next = files.filter((f) => f.path !== path);
    onChange(next.length ? next : undefined);
  };

  return (
    <div className="space-y-1.5">
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li key={f.path} className="inline-flex items-center gap-1.5 text-xs pl-2 pr-1 py-1 rounded-md border border-gray-200 bg-white text-gray-700 max-w-full">
              <Paperclip className="w-3 h-3 flex-shrink-0 text-gray-400" aria-hidden />
              <span className="truncate max-w-[180px]" title={f.name}>{f.name}</span>
              <span className="text-gray-400">{fmtBytes(f.size)}</span>
              {!readOnly && <button type="button" onClick={() => remove(f.path)} className="p-0.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" aria-label={`Remove ${f.name}`}><X className="w-3 h-3" /></button>}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <>
          <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Attach files" onChange={(e) => { const l = e.target.files; void add(l).finally(() => { if (input.current) input.current.value = ''; }); }} />
          <Button type="button" variant="secondary" size="sm" loading={busy} disabled={busy || files.length >= MAX_FILES} onClick={() => input.current?.click()}><Paperclip className="w-3.5 h-3.5" aria-hidden /> Attach files</Button>
        </>
      )}
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
      {files.length > 0 && <Note>These files go with every email this step sends, in every variant. Attachments in a first email can land it in spam more often than a link does.</Note>}
    </div>
  );
}
