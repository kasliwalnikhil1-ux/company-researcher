'use client';

import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import type { RegressionResult } from '@/lib/outreach/aiReplies';
import { CopyField, Note } from '@/components/outreach/settings/shared';

export type RegressionState =
  | { status: 'running' }
  | { status: 'done'; result: RegressionResult }
  | { status: 'error'; message: string };

export interface SaveOutcome {
  version: number;
  kind: 'style' | 'substantive';
  reconsent: { senders: number; links: Array<{ sender_id: string; sender_name: string; url: string }> } | null;
}

function RegressionLine({ state, onOpenSimulator }: { state: RegressionState; onOpenSimulator: () => void }) {
  const link = <button type="button" onClick={onOpenSimulator} className="text-indigo-700 underline underline-offset-2 hover:text-indigo-900">Open the simulator</button>;
  if (state.status === 'running') return <div className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="w-4 h-4 animate-spin" />Re-running your saved conversations…</div>;
  if (state.status === 'error') return <div className="text-sm text-gray-600">Could not re-run the saved conversations: {state.message}. {link}</div>;
  const r = state.result;
  if (!r.total) return <div className="text-sm text-gray-600">No saved conversations to check yet. Save one from the simulator to catch changes on the next edit. {link}</div>;
  const failed = r.results.filter((s) => !s.passed);
  const changed = r.results.filter((s) => s.turns.some((t) => t.changed));
  return (
    <div className="text-sm space-y-1">
      <div className="flex items-center gap-2">
        {failed.length ? <XCircle className="w-4 h-4 text-red-600" /> : <CheckCircle2 className="w-4 h-4 text-green-600" />}
        <span className="font-medium text-gray-900">{r.passed}/{r.total} saved conversations pass</span>
        {changed.length > 0 && <span className="text-gray-500">· replies changed in {changed.length}</span>}
      </div>
      {failed.length > 0 && <div className="text-gray-700">Now different: {failed.map((s) => s.name).join(', ')}.</div>}
      {(failed.length > 0 || changed.length > 0) && <div>{link} to see what changed.</div>}
    </div>
  );
}

export default function SaveResult({ outcome, regression, onOpenSimulator, onDismiss }: {
  outcome: SaveOutcome;
  regression: RegressionState | null;
  onOpenSimulator: () => void;
  onDismiss: () => void;
}) {
  const rc = outcome.reconsent;
  return (
    <div className="rounded-lg border border-green-200 bg-green-50/60 p-3 space-y-3" role="status">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5" />
        <div className="flex-1 text-sm text-green-900">
          Saved as version {outcome.version} ({outcome.kind === 'style' ? 'style only' : 'substantive'}).
          {outcome.kind === 'substantive' && rc && rc.senders > 0 && (
            <> Autopilot needs fresh approval from {rc.senders} sender owner{rc.senders === 1 ? '' : 's'}.{rc.links.length === 0 && ' We emailed them.'}</>
          )}
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="p-1 rounded text-green-800 hover:bg-green-100"><X className="w-3.5 h-3.5" /></button>
      </div>
      {rc && rc.links.length > 0 && (
        <Note tone="amber">
          <div className="mb-2">We couldn&apos;t email these owners. Send them their approval link yourself:</div>
          <div className="space-y-2">{rc.links.map((l) => <CopyField key={l.sender_id} label={l.sender_name} value={l.url} />)}</div>
        </Note>
      )}
      {regression && <RegressionLine state={regression} onOpenSimulator={onOpenSimulator} />}
    </div>
  );
}
