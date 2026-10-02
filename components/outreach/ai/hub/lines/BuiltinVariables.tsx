'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { parseError } from '@/lib/outreach/api';
import { BUILTIN_AI_KEYS } from '@/lib/outreach/aiFields';
import { useVariableSetMode, variableMode } from '@/lib/outreach/aiHub';
import { ik, type AiVariable } from '@/lib/outreach/intel';
import { Badge } from '@/components/outreach/ui';
import { CopyButton, Switch } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';

type Notify = (message: string, type?: 'success' | 'error') => void;

/** How a built-in variable is written in a message: {{ ai_contact_first_name }}. */
export const builtinToken = (key: string) => `{{ ai_${key} }}`;

/** The built-in variables of a workspace, in their fixed order. */
export function builtinsOf(all: AiVariable[] | null | undefined): AiVariable[] {
  const order = (v: AiVariable) => { const i = (BUILTIN_AI_KEYS as readonly string[]).indexOf(v.key); return i < 0 ? BUILTIN_AI_KEYS.length : i; };
  return (all ?? []).filter((v) => v.builtin).sort((a, b) => order(a) - order(b));
}

/** The token of a built-in variable with a copy button. */
export function BuiltinToken({ variable, className }: { variable: Pick<AiVariable, 'key' | 'name'>; className?: string }) {
  const token = builtinToken(variable.key);
  return (
    <div className={cn('flex items-center gap-2 min-w-0', className)}>
      <code title={token} className="min-w-0 text-xs bg-gray-50 border border-gray-200 text-gray-800 truncate rounded px-1.5 py-1">{token}</code>
      <CopyButton value={token} label={`Copy the token of ${variable.name}`} className="w-7 h-7" />
    </div>
  );
}

/**
 * On / Off for one built-in variable (stored as the variable's mode: review = on, off = off). Owners and managers switch;
 * everyone else sees the state. Off is harmless: messages then use the lead's own field as it is.
 */
export function BuiltinSwitch({ ws, variable, canEdit, notify }: { ws: string; variable: Pick<AiVariable, 'id' | 'name' | 'mode'>; canEdit: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const setMode = useVariableSetMode(ws);
  // The switch shows the picked state at once and keeps it until the variables have been read again.
  const [picked, setPicked] = useState<boolean | null>(null);
  const on = picked ?? variableMode(variable) !== 'off';

  const apply = async (next: boolean) => {
    if (picked !== null) return;
    setPicked(next);
    try {
      await setMode.mutateAsync({ variableId: variable.id, mode: next ? 'review' : 'off' });
      notify(next ? `“${variable.name}” is on.` : `“${variable.name}” is off. Messages use the lead's own field as it is.`);
      await qc.invalidateQueries({ queryKey: ik.aiVariables(ws) }).catch(() => { /* the list keeps what it had */ });
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setPicked(null); }
  };

  if (!canEdit) return <Badge tone={on ? 'green' : 'gray'}>{on ? 'On' : 'Off'}</Badge>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-xs text-gray-600 w-6 text-right" aria-hidden="true">{on ? 'On' : 'Off'}</span>
      <Switch label={variable.name} checked={on} disabled={picked !== null} onChange={(v) => void apply(v)} />
    </span>
  );
}

/**
 * "Built in": the variables every workspace has. They tidy a field the lead already has, so nobody approves them and
 * they cannot be edited or deleted: one read-only row each, with the token and an On / Off switch.
 */
export default function BuiltinVariables({ ws, variables, canEdit, notify, className }: {
  ws: string; variables: AiVariable[]; canEdit: boolean; notify: Notify; className?: string;
}) {
  if (variables.length === 0) return null;
  return (
    <section aria-labelledby="builtin-variables-title" className={className}>
      <h3 id="builtin-variables-title" className="text-sm font-semibold text-gray-900">Built in</h3>
      <p className="text-xs text-gray-500 mt-0.5 mb-2">
        Every workspace has these. They tidy a field the lead already has, so nobody needs to approve them. They are written when a lead is in a sequence that uses them.
        {!canEdit && ' Only owners and managers can switch them on or off.'}
      </p>
      <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {variables.map((v) => (
          <li key={v.id} className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-gray-900">{v.name}</span>
                <Badge>built in</Badge>
              </div>
              <BuiltinToken variable={v} className="mt-1.5" />
              <p className="text-xs text-gray-500 mt-1.5">{v.prompt}</p>
            </div>
            <div className="flex-shrink-0 sm:pt-0.5"><BuiltinSwitch ws={ws} variable={v} canEdit={canEdit} notify={notify} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}
