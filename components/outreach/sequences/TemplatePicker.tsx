'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Info, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { normalizeGraph } from '@/lib/outreach/graph';
import { qk, useClients } from '@/lib/outreach/queries';
import { SEQUENCE_TEMPLATES, type SequenceTemplate } from '@/lib/outreach/templates';
import { Button, ErrorBox, Input, Modal, Select } from '@/components/outreach/ui';
import MiniCanvas from './MiniCanvas';
import { autoLayout, formatGraphError } from './helpers';

/**
 * "Start from a template": pick one of the ready-made flows, name it, and open it in the builder.
 * Creates the sequence the same way "New sequence" does, then saves the template's steps as version 1.
 * The body mounts only while open, so every opening starts from a clean selection.
 */
export default function TemplatePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <TemplatePickerBody onClose={onClose} />;
}

function TemplatePickerBody({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace();
  const ws = workspace?.id ?? null;
  const router = useRouter();
  const qc = useQueryClient();
  const clients = useClients(ws);
  const [selectedId, setSelectedId] = useState(SEQUENCE_TEMPLATES[0].id);
  const [name, setName] = useState(SEQUENCE_TEMPLATES[0].name);
  const [client, setClient] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const template: SequenceTemplate = SEQUENCE_TEMPLATES.find((t) => t.id === selectedId) ?? SEQUENCE_TEMPLATES[0];
  const graph = useMemo(() => autoLayout(template.build()), [template]);

  const pick = (t: SequenceTemplate) => { setSelectedId(t.id); setName(t.name); setError(null); };

  const create = async () => {
    if (!ws || !name.trim() || busy) return;
    setBusy(true); setError(null);
    let id: string | null = null;
    try {
      id = await rpc<string>('create_sequence', { p_workspace: ws, p_name: name.trim(), p_client_id: client || null });
      await rpc('save_sequence', { p_id: id, p_graph: normalizeGraph(graph) });
      qc.invalidateQueries({ queryKey: qk.sequences(ws) });
      router.push(`/outreach/sequences/${id}`);
    } catch (e) {
      // the steps could not be saved: do not leave an empty sequence behind
      if (id) await supabase.from('outreach_sequences').delete().eq('id', id);
      setError(formatGraphError(parseError(e)));
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={() => !busy && onClose()} title="Start from a template" size="xl"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button loading={busy} disabled={!name.trim()} onClick={create}>Create and open</Button>
      </>}>
      <div className="grid grid-cols-1 md:grid-cols-[15rem_1fr] gap-5">
        <ul className="space-y-1" role="listbox" aria-label="Templates">
          {SEQUENCE_TEMPLATES.map((t) => {
            const active = t.id === template.id;
            return (
              <li key={t.id}>
                <button type="button" role="option" aria-selected={active} onClick={() => pick(t)}
                  className={cn('w-full text-left rounded-lg border px-3 py-2 transition-colors', active ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50')}>
                  <div className="flex items-start gap-2">
                    <span className={cn('mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0', active ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 text-transparent')}><Check className="w-3 h-3" /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900">{t.name}</span>
                      <span className="block text-xs text-gray-500">{t.tagline}</span>
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="min-w-0 space-y-4">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">{template.name}</h4>
            <p className="text-sm text-gray-600 mt-1">{template.description}</p>
            {template.needs && (
              <p className="mt-2 inline-flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5"><Users className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {template.needs}</p>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">What happens</div>
              <ol className="space-y-1.5">
                {template.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 text-gray-600 text-[11px] font-medium flex items-center justify-center mt-px">{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Preview</div>
              <div className="h-64 rounded-lg border border-gray-200 overflow-hidden"><MiniCanvas key={template.id} graph={graph} /></div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-gray-100">
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
            <Select label="Client (optional)" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">No client</option>
              {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <p className="flex items-start gap-1.5 text-xs text-gray-500"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> The steps open in the builder as a draft. Edit the copy and timing, pick the sender pool, then activate. Nothing is sent until then.</p>
          {error && <ErrorBox message={error} />}
        </div>
      </div>
    </Modal>
  );
}
