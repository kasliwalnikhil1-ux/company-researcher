'use client';

import { useState } from 'react';
import { useSenderEvents } from '@/lib/outreach/queries';
import { Badge, Card, EmptyState, ErrorBox, Spinner, fmtDate, timeAgo } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

const KIND_TONES: Record<string, 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple' | 'pink'> = {
  status: 'blue', health: 'green', proxy: 'purple', warmup: 'indigo', reconnect: 'amber', reject: 'red', schedule: 'gray', caps: 'gray', checkpoint: 'amber', pause: 'amber',
};

function summarize(kind: string, data: Record<string, unknown>): string {
  const parts: string[] = [];
  const pick = (k: string) => { const v = data[k]; return v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v); };
  if (kind === 'status') { const s = pick('status') ?? pick('to'); const r = pick('reason') ?? pick('status_reason'); if (s) parts.push(`→ ${s}`); if (r) parts.push(r); }
  else if (kind === 'health') { const s = pick('score'); if (s) parts.push(`score ${s}`); const t = pick('trigger'); if (t) parts.push(t); }
  else if (kind === 'proxy') { const c = pick('country'); if (c) parts.push(`country ${c}`); }
  else if (kind === 'warmup') { const l = pick('level') ?? pick('to'); if (l) parts.push(`level ${l}`); const r = pick('reason'); if (r) parts.push(r); }
  else if (kind === 'reconnect') { const m = pick('method'); const r = pick('result'); if (m) parts.push(m); if (r) parts.push(r); }
  else if (kind === 'reject') { const c = pick('code'); if (c) parts.push(c); }
  else if (kind === 'schedule') { const t = pick('timezone'); if (t) parts.push(t); }
  else if (kind === 'caps') { parts.push(Object.entries(data).map(([k, v]) => `${k}=${String(v)}`).join(', ') || 'cleared'); }
  else if (kind === 'checkpoint') { parts.push(data.solved ? 'solved' : `code ${pick('code') ?? ''}`); }
  return parts.join(' · ');
}

export default function EventsTimeline({ senderId }: { senderId: string }) {
  const events = useSenderEvents(senderId);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  if (events.isLoading) return <Spinner />;
  if (events.isError) return <ErrorBox message={(events.error as Error).message} />;
  const rows = events.data ?? [];

  return (
    <Card title="Events" actions={<span className="text-xs text-gray-400">latest {rows.length}</span>}>
      {rows.length === 0 ? <EmptyState title="No events yet" description="Status changes, health recomputes, proxy and schedule edits show up here." /> : (
        <ol className="relative border-l border-gray-200 ml-2">
          {rows.map((e) => {
            const hasData = e.data && Object.keys(e.data).length > 0;
            const isOpen = !!open[e.id];
            return (
              <li key={e.id} className="ml-4 pb-5 last:pb-0">
                <span className={cn('absolute -left-1.5 mt-1.5 w-3 h-3 rounded-full border-2 border-white', e.kind === 'reject' ? 'bg-red-400' : e.kind === 'health' ? 'bg-green-400' : e.kind === 'status' ? 'bg-blue-400' : 'bg-gray-300')} />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={KIND_TONES[e.kind] ?? 'gray'}>{e.kind}</Badge>
                  <span className="text-sm text-gray-800">{summarize(e.kind, e.data ?? {})}</span>
                  <span className="text-xs text-gray-400 ml-auto" title={fmtDate(e.at)}>{timeAgo(e.at)}</span>
                </div>
                {hasData && (
                  <div className="mt-1">
                    <button type="button" onClick={() => setOpen({ ...open, [e.id]: !isOpen })} className="text-xs text-indigo-600 hover:underline">{isOpen ? 'Hide details' : 'Show details'}</button>
                    {isOpen && <pre className="mt-1 p-3 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-700 overflow-x-auto max-h-64">{JSON.stringify(e.data, null, 2)}</pre>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
