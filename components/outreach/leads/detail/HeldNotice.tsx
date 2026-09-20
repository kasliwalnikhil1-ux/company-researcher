'use client';

import { useState } from 'react';
import { Hand, LogOut, Play } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import type { EnrollmentWithHold } from '@/lib/outreach/intel';
import { Button, fmtDate } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { ToastFn } from '../helpers';

/** Item 1: a lead whose sequence is set to "hold for review" replied. A person decides: resume, or exit the lead. */
export function HeldNotice({ enrollment, sequenceName, canWrite, compact, onDone, toast }: {
  enrollment: EnrollmentWithHold; sequenceName?: string | null; canWrite: boolean; compact?: boolean; onDone: () => void; toast: ToastFn;
}) {
  const [busy, setBusy] = useState<'resume' | 'exit' | null>(null);
  const act = async (kind: 'resume' | 'exit') => {
    setBusy(kind);
    try {
      if (kind === 'resume') await rpc('resume_enrollment', { p_id: enrollment.id });
      else await rpc('exit_enrollment', { p_id: enrollment.id, p_reason: 'replied' });
      toast(kind === 'resume' ? 'Sequence resumed. The next step will be planned.' : 'Lead exited from the sequence.');
      onDone();
    } catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  };
  return (
    <div className={cn('rounded-lg border border-amber-200 bg-amber-50', compact ? 'p-2.5' : 'p-3')} role="status">
      <div className="flex items-start gap-2">
        <Hand className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className={cn('font-medium text-amber-900', compact ? 'text-xs' : 'text-sm')}>Held for review after a reply</div>
          <p className="text-xs text-amber-800 mt-0.5">
            {sequenceName ? <>{sequenceName} is paused for this lead</> : <>The sequence is paused for this lead</>}{enrollment.held_at ? <> since {fmtDate(enrollment.held_at)}</> : null}. Read the reply, then resume to send the next step or exit the lead.
          </p>
          {canWrite && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Button size="sm" loading={busy === 'resume'} disabled={busy === 'exit'} onClick={() => act('resume')}><Play className="w-3 h-3" /> Resume sequence</Button>
              <Button size="sm" variant="secondary" className="text-red-600" loading={busy === 'exit'} disabled={busy === 'resume'} onClick={() => act('exit')}><LogOut className="w-3 h-3" /> Exit lead</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
