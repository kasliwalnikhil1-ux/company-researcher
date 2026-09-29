'use client';

import { useState, type ReactNode } from 'react';
import { CheckCircle2, Circle, GraduationCap } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useGraduation, useMasterPromptList } from '@/lib/outreach/aiReplies';
import { Badge, Button, Card, EmptyState, ErrorBox, Select, Spinner, fmtDate, timeAgo } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { pct } from './format';

const toPct = (v: number | null | undefined) => (v == null ? null : v <= 1 ? v * 100 : v);

/** Graduation per master prompt (PRD §16.2): progress toward autopilot and what is still missing. */
export default function GraduationPanel({ ws, onOpenPrompt, onOpenSimulator }: { ws: string; onOpenPrompt: () => void; onOpenSimulator: () => void }) {
  const list = useMasterPromptList(ws);
  const [picked, setPicked] = useState<string | null>(null);
  const prompts = list.data ?? [];
  const mp = picked ?? prompts.find((p) => p.scope === 'workspace')?.id ?? prompts[0]?.id ?? null;
  const g = useGraduation(ws, mp);

  if (list.isLoading) return <Spinner />;
  if (list.error) return <ErrorBox message={parseError(list.error).message} />;
  if (!prompts.length) {
    return (
      <Card>
        <EmptyState icon={<GraduationCap className="w-6 h-6" />} title="No master prompt yet"
          description="Graduation is tracked per master prompt. Save one to start drafting; drafts your team sends count toward autopilot."
          action={<Button onClick={onOpenPrompt}>Write the master prompt</Button>} />
      </Card>
    );
  }

  const d = g.data;
  const share = toPct(d?.light_edit_share);
  const minShare = toPct(d?.requirements.min_share) ?? 80;
  const minDrafts = d?.requirements.min_drafts ?? 30;
  const status = d?.graduated_at ? { label: `Graduated ${fmtDate(d.graduated_at, false)}`, tone: 'green' as const }
    : d?.eligible ? { label: 'Eligible', tone: 'green' as const } : { label: 'Not yet', tone: 'gray' as const };

  return (
    <Card title="Graduation"
      actions={<Select aria-label="Master prompt" value={mp ?? ''} onChange={(e) => setPicked(e.target.value)} className="py-1.5 text-xs">
        {prompts.map((p) => <option key={p.id} value={p.id}>{p.scope_label} · v{p.version}</option>)}
      </Select>}>
      <p className="text-sm text-gray-600">
        Autopilot unlocks for this prompt when, over the last {d?.window_days ?? 60} days, at least {minDrafts} drafts were sent by a person, at least {Math.round(minShare)}% of them unedited or lightly edited, no edit changed a price, date or link, and every saved test conversation passes.
        Style-only prompt changes keep the count; a change to what it says starts it again.
      </p>
      {g.isLoading && <Spinner />}
      {g.error && <ErrorBox className="mt-4" message={parseError(g.error).message} />}
      {d && (
        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            {d.bypass && <Badge tone="purple">Graduation bypassed by the platform admin</Badge>}
            <span className="text-xs text-gray-500">Counting drafts from version {d.since_version} onward.</span>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <Meter label="Drafts sent by a person" value={`${d.drafts_sent} of ${minDrafts}`} progress={d.drafts_sent / Math.max(1, minDrafts)} ok={d.drafts_sent >= minDrafts} />
            <Meter label="Sent unedited or lightly edited" value={`${pct(d.light_edit_share)} (${d.light_edits} drafts) · needs ${Math.round(minShare)}%`}
              progress={share == null ? 0 : share / Math.max(1, minShare)} ok={share != null && share >= minShare} />
            <Meter label="Edits that changed a price, date or link" value={d.facts_changed === 0 ? 'None' : String(d.facts_changed)} progress={d.facts_changed === 0 ? 1 : 0} ok={d.facts_changed === 0} />
            <Meter label="Test conversations passing"
              value={d.regression.total ? `${d.regression.passed} of ${d.regression.total}${d.regression.last_run_at ? ` · run ${timeAgo(d.regression.last_run_at)}` : ''}` : 'None saved yet'}
              progress={d.regression.total ? d.regression.passed / d.regression.total : 0} ok={d.regression.total > 0 && d.regression.passed === d.regression.total}
              action={<button type="button" onClick={onOpenSimulator} className="text-xs text-indigo-600 hover:underline">Open the simulator</button>} />
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Still needed</div>
            {d.missing.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-green-800"><CheckCircle2 className="w-4 h-4 text-green-600" aria-hidden="true" />Nothing — this prompt meets every requirement.</p>
            ) : (
              <ul className="space-y-1.5">
                {d.missing.map((m) => (
                  <li key={m} className="flex items-start gap-2 text-sm text-gray-700"><Circle className="w-4 h-4 mt-0.5 text-gray-300 flex-shrink-0" aria-hidden="true" />{m}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Meter({ label, value, progress, ok, action }: { label: string; value: string; progress: number; ok: boolean; action?: ReactNode }) {
  const w = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)) * 100;
  return (
    <div className="rounded-xl border border-gray-200 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-gray-500">{label}</div>
        {ok ? <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" aria-label="Met" /> : <Circle className="w-4 h-4 text-gray-300 flex-shrink-0" aria-label="Not met" />}
      </div>
      <div className="text-sm font-medium text-gray-900 mt-0.5">{value}</div>
      <div className="mt-2 h-1.5 rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)} aria-label={label}>
        <div className={cn('h-full rounded-full', ok ? 'bg-green-500' : 'bg-indigo-500')} style={{ width: `${w}%` }} />
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
