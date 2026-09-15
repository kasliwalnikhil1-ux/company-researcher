'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useTags } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, Card } from '@/components/outreach/ui';
import { Plus, X } from 'lucide-react';
import { chipStyle, type ToastFn } from '../helpers';
import { ManageTaxonomyModal } from '../ManageTaxonomy';

export function LeadTagsEditor({ leadId, tagIds, toast }: { leadId: string; tagIds: string[]; toast: ToastFn }) {
  const { workspace, canWrite } = useWorkspace();
  const qc = useQueryClient();
  const tags = useTags(workspace?.id);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const current = (tags.data ?? []).filter((t) => tagIds.includes(t.id));
  const available = (tags.data ?? []).filter((t) => !tagIds.includes(t.id));

  const invalidate = () => { qc.invalidateQueries({ queryKey: qk.lead(leadId) }); if (workspace) qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'leads'] }); };
  const add = async (tagId: string) => {
    setBusy(tagId);
    try {
      const { error } = await supabase.from('outreach_lead_tags').upsert({ lead_id: leadId, tag_id: tagId }, { onConflict: 'lead_id,tag_id', ignoreDuplicates: true });
      if (error) throw error;
      invalidate(); setAdding(false);
    } catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  };
  const remove = async (tagId: string) => {
    setBusy(tagId);
    try {
      const { error } = await supabase.from('outreach_lead_tags').delete().eq('lead_id', leadId).eq('tag_id', tagId);
      if (error) throw error;
      invalidate();
    } catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  };

  return (
    <Card title="Tags" actions={canWrite ? <Button size="sm" variant="ghost" onClick={() => setManage(true)}>Manage</Button> : undefined}>
      <div className="flex flex-wrap items-center gap-1.5">
        {current.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium border" style={chipStyle(t.color)}>
            {t.name}
            {canWrite && <button type="button" title={`Remove ${t.name}`} disabled={busy === t.id} onClick={() => remove(t.id)} className="rounded-full hover:bg-black/10 p-0.5"><X className="w-3 h-3" /></button>}
          </span>
        ))}
        {current.length === 0 && <span className="text-sm text-gray-400">No tags</span>}
        {canWrite && (
          <div className="relative">
            <button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border border-dashed border-gray-300 text-gray-600 hover:bg-gray-50"><Plus className="w-3 h-3" /> Add</button>
            {adding && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setAdding(false)} />
                <div role="menu" className="absolute left-0 top-full mt-1 z-30 w-52 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                  {available.length === 0 ? <div className="px-3 py-2 text-xs text-gray-500">{tags.data?.length ? 'All tags applied' : 'No tags yet — create one via Manage.'}</div> : available.map((t) => (
                    <button key={t.id} role="menuitem" type="button" disabled={busy === t.id} onClick={() => add(t.id)} className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: t.color ?? '#6b7280' }} /> <span className="truncate">{t.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {manage && <ManageTaxonomyModal kind="tags" open onClose={() => setManage(false)} toast={toast} />}
    </Card>
  );
}
