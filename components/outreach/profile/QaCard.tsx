'use client';

// Profile QA score (PRD §8.4): the checks with severity and a fix hint, from the last snapshot.
import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import { Badge, Card, fmtDate } from '@/components/outreach/ui';
import { QA_SEVERITY, qaTone, type ProfileOverview } from '@/lib/outreach/profile';
import { cn } from '@/lib/utils';

export function QaScoreBadge({ score }: { score: number | null | undefined }) {
  const tone = qaTone(score);
  return <span className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full', tone === 'green' ? 'bg-green-50 text-green-700' : tone === 'amber' ? 'bg-amber-50 text-amber-700' : tone === 'red' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-500')} title="Profile quality score">Profile {score ?? '—'}</span>;
}

export default function QaCard({ qa, snapshotAt }: { qa: ProfileOverview['qa']; snapshotAt: string | null }) {
  if (!qa) return <Card title="Profile quality"><div className="text-sm text-gray-500">No snapshot yet. Press <b>Refresh snapshot</b> above to read the profile and score it.</div></Card>;
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const checks = [...qa.checks].sort((a, b) => Number(a.pass !== false) - Number(b.pass !== false) || order[a.severity] - order[b.severity]);
  const failing = checks.filter((c) => c.pass === false);
  return (
    <Card title={<span className="flex items-center gap-2">Profile quality <QaScoreBadge score={qa.score} /></span>} actions={<span className="text-[11px] text-gray-400">scored {fmtDate(qa.computed_at)}{snapshotAt ? ` · profile read ${fmtDate(snapshotAt, false)}` : ''}</span>}>
      {failing.length === 0 ? <div className="flex items-center gap-2 text-sm text-green-700"><CheckCircle2 className="w-4 h-4" /> Nothing to fix.</div> : (
        <ul className="space-y-2">
          {checks.map((c) => (
            <li key={c.code} className={cn('flex items-start gap-2 rounded-lg border p-2.5 text-sm', c.pass === false ? (c.severity === 'critical' || c.severity === 'high' ? 'border-red-200 bg-red-50' : c.severity === 'medium' ? 'border-amber-200 bg-amber-50' : 'border-blue-200 bg-blue-50') : c.pass === null ? 'border-gray-200 bg-gray-50' : 'border-green-100 bg-green-50/50')}>
              <span className="mt-0.5 flex-shrink-0">{c.pass === false ? <AlertTriangle className={cn('w-4 h-4', c.severity === 'low' ? 'text-blue-600' : c.severity === 'medium' ? 'text-amber-600' : 'text-red-600')} /> : c.pass === null ? <HelpCircle className="w-4 h-4 text-gray-400" /> : <CheckCircle2 className="w-4 h-4 text-green-600" />}</span>
              <div className="min-w-0 flex-1">
                <div className="text-gray-900">{c.detail}</div>
                {c.pass === false && <div className="text-xs text-gray-600 mt-0.5">{c.fix_hint}</div>}
              </div>
              {c.pass === false && <Badge tone={QA_SEVERITY[c.severity].tone}>{QA_SEVERITY[c.severity].label}</Badge>}
            </li>
          ))}
        </ul>
      )}
      <div className="text-[11px] text-gray-500 mt-3">A critical failure (no photo, under 150 connections) keeps the account from moving up a warm-up level. The score is compared with acceptance rates on the Profiles page.</div>
    </Card>
  );
}
