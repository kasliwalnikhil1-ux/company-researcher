'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Wand2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { isFieldsVariable, variableFields } from '@/lib/outreach/aiFields';
import { hubHref } from '@/lib/outreach/aiHub';
import { useAiVariables } from '@/lib/outreach/intel';
import { Card } from '@/components/outreach/ui';
import { FieldValueTable, readFieldData } from '@/components/outreach/ai/hub/lines/FieldValueEditor';

interface ApprovedValue { id: string; text: string | null; data: unknown; status: string; variable_id: string }

/**
 * Personalized lines of one lead: what a message can use for this person today. Approved values only (the same rule the
 * sender follows); the built-in variables are left out. A one-line variable shows its line, a Fields variable its
 * Field · Value table. The card is not rendered at all when the lead has no approved line.
 */
export function LeadAiLines({ leadId }: { leadId: string }) {
  const { workspace, role } = useWorkspace();
  const ws = workspace?.id ?? null;
  const allowed = !!ws && role !== 'client_viewer';   // Personalized lines are not shown to client viewers
  const vars = useAiVariables(allowed ? ws : null);
  // The key sits under 'ai-review', so approving, editing or skipping a line anywhere refreshes this card.
  const values = useQuery({
    queryKey: ['outreach', ws ?? '', 'ai-review', 'lead', leadId], enabled: allowed && !!leadId, staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_ai_values').select('id, text, data, status, variable_id').eq('lead_id', leadId).eq('status', 'approved');
      if (error) throw parseError(error);
      return (data ?? []) as ApprovedValue[];
    },
  });

  const items = useMemo(() => {
    const byId = new Map((vars.data ?? []).map((v) => [v.id, v]));
    const out: Array<{ id: string; variableId: string; name: string; text: string; fields: ReturnType<typeof variableFields> | null; data: ReturnType<typeof readFieldData> }> = [];
    for (const x of values.data ?? []) {
      const v = byId.get(x.variable_id);
      if (!v || v.builtin) continue;
      const typed = isFieldsVariable(v);
      const text = (x.text ?? '').trim();
      if (!typed && !text) continue;
      out.push({ id: x.id, variableId: v.id, name: v.name, text, fields: typed ? variableFields(v) : null, data: typed ? readFieldData(x.data) : null });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [vars.data, values.data]);

  if (items.length === 0) return null;

  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><Wand2 className="w-4 h-4 text-gray-400" aria-hidden="true" /> Personalized lines</span>}>
      <ul className="space-y-3">
        {items.map((it) => (
          <li key={it.id} className="min-w-0">
            <Link href={hubHref.setupLine(it.variableId)} className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-indigo-700 hover:underline">{it.name}</Link>
            {it.fields
              ? <FieldValueTable fields={it.fields} data={it.data} compact className="mt-1" />
              : <p className="text-sm text-gray-900 whitespace-pre-wrap break-words [overflow-wrap:anywhere] mt-0.5">{it.text}</p>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-400 mt-3">Approved lines only. These are what a message can use for this lead.</p>
    </Card>
  );
}
