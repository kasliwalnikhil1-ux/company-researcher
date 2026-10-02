'use client';

import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { parseError } from '@/lib/outreach/api';
import { MODE_LINE, hubHref, useVariableSetMode, variableMode, type HubMode, type HubSetupVariable } from '@/lib/outreach/aiHub';
import { ik } from '@/lib/outreach/intel';
import ModeSwitch from '@/components/outreach/ai/hub/ModeSwitch';
import { ConfirmModal } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';

/**
 * Off · Review · Auto for one variable. Auto is locked: a person approves every line today.
 * Switching off asks first, because lines that are still being written stop there.
 *   canEdit   owners and managers; everyone else sees the mode but cannot change it
 *   notify    the page's toast (one toast for the whole list, not one per row)
 */
export default function VariableModeSwitch({ ws, variable, canEdit, compact, notify, className }: {
  ws: string; variable: { id: string; name: string; mode?: string | null }; canEdit: boolean; compact?: boolean;
  notify: (message: string, type?: 'success' | 'error') => void; className?: string;
}) {
  const qc = useQueryClient();
  const setMode = useVariableSetMode(ws);
  const stored = variableMode(variable);
  // The switch shows the picked mode at once and keeps it until the variables have been read again.
  const [picked, setPicked] = useState<'off' | 'review' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const apply = async (next: 'off' | 'review') => {
    if (picked) return;
    setPicked(next);
    try {
      await setMode.mutateAsync({ variableId: variable.id, mode: next });
      setConfirmOff(false);
      notify(next === 'off' ? `“${variable.name}” is off. No new lines are written for it.` : `“${variable.name}” is on Review. A person approves each line.`);
      await qc.invalidateQueries({ queryKey: ik.aiVariables(ws) }).catch(() => { /* the list keeps what it had */ });
    } catch (e) {
      setConfirmOff(false);
      notify(parseError(e).message, 'error');
    } finally { setPicked(null); }
  };
  const pick = (m: HubMode) => { if (m === 'off') setConfirmOff(true); else if (m === 'review') apply('review'); };

  return (
    <>
      <ModeSwitch value={picked ?? stored} onChange={pick} lines={MODE_LINE.line} locked={{ auto: MODE_LINE.line.auto }} disabled={!canEdit} busy={!!picked}
        compact={compact} label={`Mode of ${variable.name}`} className={className} />
      <ConfirmModal open={confirmOff} onClose={() => { if (!setMode.isPending) setConfirmOff(false); }} onConfirm={() => apply('off')} loading={setMode.isPending}
        title={`Switch “${variable.name}” off?`} confirmLabel="Switch off">
        <p>Lines that are still being written stop. Their leads use the fallback.</p>
        <p>Approved lines keep being used. You can switch back to Review at any time.</p>
      </ConfirmModal>
    </>
  );
}

/** "312 ready · 14 waiting for you": approved lines of a variable, and the ones in Needs you (linked). */
export function VariableCounts({ counts, variableId, className }: { counts: Pick<HubSetupVariable, 'approved' | 'waiting'> | null | undefined; variableId: string; className?: string }) {
  if (!counts) return null;
  const ready = Number(counts.approved ?? 0) || 0;
  const waiting = Number(counts.waiting ?? 0) || 0;
  return (
    <p className={cn('text-xs text-gray-600', className)}>
      {ready.toLocaleString()} ready
      {waiting > 0 && <> · <Link href={hubHref.needsYou({ type: 'line', where: variableId, mine: false })} className="font-medium text-indigo-600 hover:underline">{waiting.toLocaleString()} waiting for you</Link></>}
    </p>
  );
}
