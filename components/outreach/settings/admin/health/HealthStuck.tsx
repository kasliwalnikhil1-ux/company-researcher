'use client';

import { useQuery } from '@tanstack/react-query';
import { Copy, MessageSquare } from 'lucide-react';
import { rpc } from '@/lib/outreach/api';
import { Button, Card, ErrorBox, Spinner, Table, Td, Th, timeAgo, useToast } from '@/components/outreach/ui';
import Link from '@/lib/outreach/nav';
import { SIGNAL_MEANS, SIGNAL_TEXT, customerMessage, stuckPrompt, type HealthStuck as Stuck } from '@/lib/outreach/health';

export default function HealthStuck() {
  const q = useQuery({ queryKey: ['health-stuck'], queryFn: () => rpc<Stuck>('health_stuck'), refetchInterval: 120_000 });
  const { show, node } = useToast();
  const copy = async (text: string, what: string) => { try { await navigator.clipboard.writeText(text); show(`${what} copied.`); } catch { show('Could not copy', 'error'); } };
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} />;
  const d = q.data!;
  const codesSeen = [...new Set(d.who.flatMap((w) => w.signals.map((s) => s.code)))].sort();
  return (
    <div className="space-y-6">
      <Card title={`Who is stuck (${d.who.length})`}>
        <p className="text-xs text-gray-500 mb-3">One row per workspace, today, sorted by how many signals it shows. Signals come from what the app records: senders, sequences, imports, and the fixed list of events (no message text, no lead data).</p>
        {d.who.length === 0 ? <div className="text-sm text-gray-500">Nobody looks stuck today.</div> : (
          <Table>
            <thead><tr><Th>Workspace</Th><Th>Signals</Th><Th>Since</Th><Th>Screen</Th><Th></Th></tr></thead>
            <tbody>{d.who.map((w) => (
              <tr key={w.workspace_id}>
                <Td className="text-gray-900 align-top">{w.name}</Td>
                <Td className="align-top"><ul className="space-y-0.5">{w.signals.map((s, i) => <li key={i} className="text-sm"><span className="text-[11px] font-mono text-gray-400 mr-1">{s.code}</span>{SIGNAL_TEXT[s.code] ?? s.code}{s.detail && Object.keys(s.detail).length > 0 && <span className="text-gray-400"> · {Object.entries(s.detail).filter(([k]) => !/_id$/.test(k)).map(([k, v]) => `${k} ${String(v)}`).join(', ')}</span>}</li>)}</ul></Td>
                <Td className="align-top text-gray-600 whitespace-nowrap">{timeAgo(w.since)}</Td>
                <Td className="align-top text-xs text-gray-600 font-mono">{w.route}</Td>
                <Td className="align-top whitespace-nowrap"><Link href={`/outreach/settings/admin?workspace=${w.workspace_id}`} className="text-xs text-indigo-600 hover:underline">Open</Link></Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Card title="Where people get stuck (last 7 days)">
        <p className="text-xs text-gray-500 mb-3">Screens ranked by stuck signals, with the number of workspaces affected. This is the list of things to make clearer.</p>
        {d.where.length === 0 ? <div className="text-sm text-gray-500">No signals in the last 7 days.</div> : (
          <Table>
            <thead><tr><Th>Screen</Th><Th className="text-right">Signals</Th><Th className="text-right">Workspaces</Th><Th>Which</Th></tr></thead>
            <tbody>{d.where.map((r) => <tr key={r.route}><Td className="font-mono text-xs text-gray-900">{r.route}</Td><Td className="text-right tabular-nums">{r.signals}</Td><Td className="text-right tabular-nums">{r.workspaces}</Td><Td className="text-xs text-gray-600">{Object.entries(r.codes ?? {}).map(([c, n]) => `${c} ×${n}`).join(', ')}</Td></tr>)}</tbody>
          </Table>
        )}
      </Card>
      <Card title="What to do">
        <p className="text-xs text-gray-500 mb-3">Per signal: what it usually means, a prompt to change the screen, and a short plain note offering help to the customer.</p>
        <Table>
          <thead><tr><Th>Signal</Th><Th>It usually means</Th><Th></Th></tr></thead>
          <tbody>{Object.keys(SIGNAL_TEXT).map((code) => {
            const rows = d.who.filter((w) => w.signals.some((s) => s.code === code));
            const route = rows[0]?.signals.find((s) => s.code === code)?.route ?? '';
            return (
              <tr key={code} className={codesSeen.includes(code) ? '' : 'opacity-60'}>
                <Td className="text-gray-900 align-top"><span className="text-[11px] font-mono text-gray-400 mr-1">{code}</span>{SIGNAL_TEXT[code]}{rows.length > 0 && <span className="ml-1 text-[11px] text-indigo-700">{rows.length} today</span>}</Td>
                <Td className="text-gray-700 align-top">{SIGNAL_MEANS[code]}</Td>
                <Td className="align-top whitespace-nowrap">
                  <Button size="sm" variant="secondary" onClick={() => copy(stuckPrompt(route || '(the screen for this signal)', code, SIGNAL_TEXT[code], rows.length), 'Prompt')}><Copy className="w-3.5 h-3.5" /> Copy prompt for Claude</Button>
                  <Button size="sm" variant="ghost" className="ml-1" onClick={() => copy(customerMessage(code, rows[0]?.name ?? 'your workspace'), 'Message')}><MessageSquare className="w-3.5 h-3.5" /> Copy a message to the customer</Button>
                </Td>
              </tr>
            );
          })}</tbody>
        </Table>
      </Card>
      {node}
    </div>
  );
}
