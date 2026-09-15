'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, Card, ErrorBox } from '@/components/outreach/ui';
import { Plus, Trash2 } from 'lucide-react';
import type { ToastFn } from '../helpers';

interface Row { key: string; value: string; id: number }

function toRows(custom: Record<string, unknown>): Row[] {
  return Object.entries(custom ?? {}).map(([k, v], i) => ({ id: i, key: k, value: v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v) }));
}

/** Convert an edited string back to a JSON value: numbers/booleans/null/objects are preserved when they parse, otherwise kept as text. */
function toValue(s: string): unknown {
  const t = s.trim();
  if (t === '') return '';
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(t) || /^[[{]/.test(t)) { try { return JSON.parse(t); } catch { return s; } }
  return s;
}

export function LeadCustomFields({ leadId, custom, toast }: { leadId: string; custom: Record<string, unknown>; toast: ToastFn }) {
  const { workspace, canWrite } = useWorkspace();
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => toRows(custom));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextId, setNextId] = useState(rows.length);
  useEffect(() => { const r = toRows(custom); setRows(r); setNextId(r.length); }, [custom]);

  const dirty = JSON.stringify(rows.map((r) => [r.key, r.value])) !== JSON.stringify(toRows(custom).map((r) => [r.key, r.value]));
  const dupKeys = rows.map((r) => r.key.trim()).filter((k, i, a) => k && a.indexOf(k) !== i);

  const save = async () => {
    if (dupKeys.length) { setError(`Duplicate key: ${dupKeys[0]}`); return; }
    setBusy(true); setError(null);
    try {
      const next: Record<string, unknown> = {};
      for (const r of rows) { const k = r.key.trim(); if (k) next[k] = toValue(r.value); }
      const { error: err } = await supabase.from('outreach_leads').update({ custom: next }).eq('id', leadId);
      if (err) throw err;
      qc.invalidateQueries({ queryKey: qk.lead(leadId) });
      toast('Custom fields saved');
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  const update = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const inp = 'w-full px-2 py-1.5 text-sm rounded-md border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 read-only:bg-gray-50';

  return (
    <Card title="Custom fields" actions={canWrite ? <>
      {dirty && <Button size="sm" variant="secondary" onClick={() => { const r = toRows(custom); setRows(r); setNextId(r.length); }} disabled={busy}>Reset</Button>}
      <Button size="sm" variant="secondary" onClick={() => { setRows((rs) => [...rs, { id: nextId, key: '', value: '' }]); setNextId((n) => n + 1); }}><Plus className="w-3.5 h-3.5" /> Add</Button>
      {dirty && <Button size="sm" loading={busy} onClick={save}>Save</Button>}
    </> : undefined}>
      {rows.length === 0 ? <p className="text-sm text-gray-400">No custom fields. Use them in templates as <code className="text-xs bg-gray-100 px-1 rounded">{'{{custom.key}}'}</code>.</p> : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="grid grid-cols-[1fr,2fr,auto] gap-2 items-center">
              <input aria-label="Key" value={r.key} readOnly={!canWrite} onChange={(e) => update(r.id, { key: e.target.value })} placeholder="key" className={`${inp} font-mono text-xs`} />
              <input aria-label="Value" value={r.value} readOnly={!canWrite} onChange={(e) => update(r.id, { value: e.target.value })} placeholder="value" className={inp} />
              {canWrite ? <button type="button" title="Remove field" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button> : <span />}
            </div>
          ))}
        </div>
      )}
      {error && <ErrorBox className="mt-3" message={error} />}
    </Card>
  );
}
