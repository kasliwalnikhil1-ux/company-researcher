'use client';

// Scenario cards (changes doc §9.1): what to do in a situation, on/off, ordered. Every change is a new prompt version.
import { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useScenarioDelete, useScenarioSave, useScenarioToggle, useScenariosReorder, type ScenarioCard, type ScenarioDraft } from '@/lib/outreach/aiRepliesSequence';
import { Button, ErrorBox, Input, Modal, Textarea, Toggle } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';
import { Section, errText } from './shared';

export default function ScenariosSection({ sequenceId, cards, canEdit, notify }: { sequenceId: string; cards: ScenarioCard[]; canEdit: boolean; notify: (m: string, t?: 'success' | 'error') => void }) {
  const save = useScenarioSave(sequenceId);
  const toggle = useScenarioToggle(sequenceId);
  const del = useScenarioDelete(sequenceId);
  const reorder = useScenariosReorder(sequenceId);
  const [editing, setEditing] = useState<ScenarioDraft | null>(null);
  const [toDelete, setToDelete] = useState<ScenarioCard | null>(null);
  const busy = save.isPending || toggle.isPending || del.isPending || reorder.isPending;
  const sorted = [...cards].sort((a, b) => a.position - b.position);

  const fail = (e: unknown) => notify(errText(e), 'error');
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= sorted.length) return;
    const ids = sorted.map((c) => c.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids, { onError: fail });
  };

  return (
    <Section title="Scenarios" help="What to do in a specific situation. Cards that are on go into the prompt in this order; the AI names the card it followed on every reply."
      actions={canEdit && <Button size="sm" variant="secondary" onClick={() => setEditing({ title: '', when_text: '', do_text: '', enabled: true })}><Plus className="w-3.5 h-3.5" />Add</Button>}>
      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 rounded-lg border border-dashed border-gray-300 px-3 py-4 text-center">No scenario cards yet. Add one for the price question, a proposed meeting time, &ldquo;not now&rdquo; and the like.</p>
      ) : (
        <ol className="space-y-2">
          {sorted.map((c, i) => (
            <li key={c.id} className={cn('rounded-lg border p-3 flex items-start gap-3', c.enabled ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-70')}>
              <div className="pt-0.5"><Toggle checked={c.enabled} disabled={!canEdit || busy} onChange={(v) => toggle.mutate({ id: c.id, enabled: v }, { onError: fail })} label={c.enabled ? 'On' : 'Off'} /></div>
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-medium text-gray-900">{c.title}</div>
                <div className="text-gray-600 mt-0.5"><span className="text-xs uppercase tracking-wide text-gray-400 mr-1">When</span>{c.when_text}</div>
                <div className="text-gray-600 mt-0.5 whitespace-pre-wrap"><span className="text-xs uppercase tracking-wide text-gray-400 mr-1">Do</span>{c.do_text}</div>
              </div>
              {canEdit && (
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button type="button" onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label={`Move ${c.title} up`} className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={busy || i === sorted.length - 1} aria-label={`Move ${c.title} down`} className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
                  <button type="button" onClick={() => setEditing({ id: c.id, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled })} disabled={busy} aria-label={`Edit ${c.title}`} className="p-1.5 rounded text-gray-500 hover:bg-gray-100"><Pencil className="w-4 h-4" /></button>
                  <button type="button" onClick={() => setToDelete(c)} disabled={busy} aria-label={`Delete ${c.title}`} className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-gray-500">Each change creates a new prompt version.</p>

      {editing && (
        <ScenarioModal key={editing.id ?? 'new'} initial={editing} loading={save.isPending} onClose={() => setEditing(null)}
          onSave={async (d) => { try { await save.mutateAsync(d); setEditing(null); notify(d.id ? 'Scenario saved.' : 'Scenario added.'); } catch (e) { fail(e); } }} />
      )}
      <ConfirmModal open={!!toDelete} onClose={() => setToDelete(null)} loading={del.isPending} title="Delete this scenario?" confirmLabel="Delete"
        onConfirm={async () => { if (!toDelete) return; try { await del.mutateAsync(toDelete.id); setToDelete(null); } catch (e) { fail(e); setToDelete(null); } }}>
        <p>&ldquo;{toDelete?.title}&rdquo; is removed from the prompt. Turn it off instead if you may want it back.</p>
      </ConfirmModal>
    </Section>
  );
}

export function ScenarioModal({ initial, loading, onClose, onSave }: { initial: ScenarioDraft; loading: boolean; onClose: () => void; onSave: (d: ScenarioDraft) => void }) {
  const [d, setD] = useState<ScenarioDraft>(initial);
  const ok = d.title.trim().length > 0 && d.title.length <= 80 && d.when_text.trim().length > 0 && d.when_text.length <= 500 && d.do_text.trim().length > 0 && d.do_text.length <= 1500;
  return (
    <Modal open onClose={onClose} title={initial.id ? 'Edit scenario' : 'Add scenario'} size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button><Button loading={loading} disabled={!ok} onClick={() => onSave({ ...d, title: d.title.trim(), when_text: d.when_text.trim(), do_text: d.do_text.trim() })}>Save</Button></>}>
      <div className="space-y-3">
        <Input label="Title" value={d.title} maxLength={80} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Pricing question" autoFocus />
        <Textarea label="When" hint="How to recognise the situation." rows={2} maxLength={500} value={d.when_text} onChange={(e) => setD({ ...d, when_text: e.target.value })} placeholder="They ask what it costs, rates, budget, or a quote" />
        <Textarea label="Do" hint="What the AI says or does. Facts and numbers here count as allowed facts." rows={4} maxLength={1500} value={d.do_text} onChange={(e) => setD({ ...d, do_text: e.target.value })} placeholder="Say projects start at X; offer a 15-min call for an exact quote" />
        <Toggle checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="On" />
        {!ok && (d.title || d.when_text || d.do_text) && <ErrorBox message="Title up to 80, When up to 500 and Do up to 1500 characters, none empty." />}
      </div>
    </Modal>
  );
}
