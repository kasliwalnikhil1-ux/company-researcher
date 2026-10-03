'use client';

// Knowledge → "Use in…": which sequences (Replies) and websites (Website agent) answer from one source.
// Every tick is saved at once through outreach_hub_knowledge_link; there is no Save button.
// A product catalogue is used by websites only: ticking one adds it to that website's catalogues (Assistant → Products).
import { useState } from 'react';
import { useKnowledgeLink, type HubKnowledgeSource, type KnowledgeTargetKind } from '@/lib/outreach/aiHub';
import { Button, ErrorBox, Modal, Spinner } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { errText, plural } from '@/components/outreach/sequences/ai/shared';
import { TargetChecklist, targetKey, type KnowledgeTargets } from './shared';

/**
 * `source` is what was clicked (or just added); `live` is its row in the library once the list has it. The ticks start
 * from `live.used_in` and are kept here from then on, so a slow refetch never flips a box back.
 */
export default function UseInModal({ ws, source, live, targets: allTargets, loading, justAdded, catalogue, onClose }: {
  ws: string; source: { id: string; title: string }; live?: HubKnowledgeSource; targets: KnowledgeTargets; loading?: boolean; justAdded?: boolean;
  /** The source is a product catalogue (known before the library has its row). */
  catalogue?: boolean; onClose: () => void;
}) {
  const isCatalogue = catalogue || live?.kind === 'catalogue';
  const targets: KnowledgeTargets = isCatalogue ? { sequences: [], websites: allTargets.websites } : allTargets;
  const link = useKnowledgeLink(ws);
  const [on, setOn] = useState<Set<string>>(() => new Set((live?.used_in ?? []).map((t) => targetKey(t.kind, t.id))));
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const withKey = (s: Set<string>, key: string, add: boolean) => { const n = new Set(s); if (add) n.add(key); else n.delete(key); return n; };

  async function toggle(kind: KnowledgeTargetKind, id: string, next: boolean) {
    const key = targetKey(kind, id);
    setError(null);
    setBusy((b) => withKey(b, key, true));
    setOn((s) => withKey(s, key, next));
    try { await link.mutateAsync({ sourceId: source.id, kind, targetId: id, on: next }); }
    catch (e) {
      setOn((s) => withKey(s, key, !next));
      const name = (kind === 'sequence' ? targets.sequences : targets.websites)?.find((x) => x.id === id)?.name;
      setError(`${name ? `${name}: ` : ''}${errText(e)}`);
    } finally { setBusy((b) => withKey(b, key, false)); }
  }

  const nothing = (targets.sequences?.length ?? 0) + (targets.websites?.length ?? 0) === 0;

  return (
    <Modal open onClose={onClose} title={`Use “${source.title}” in…`} size="lg" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          {isCatalogue
            ? `${justAdded ? 'The catalogue is in your library and its products are being read. ' : ''}Tick the websites whose assistant may recommend products from it. Each change is saved right away.`
            : `${justAdded ? 'The source is in your library. ' : ''}Tick the places that may answer from it. Each change is saved right away.`}
        </p>
        {live?.status === 'error' && <Note tone="amber">This source could not be read, so the AI finds nothing in it yet.</Note>}
        {loading ? <Spinner className="py-6" /> : nothing ? (
          <p className="text-sm text-gray-500">{isCatalogue ? 'There is no website to use it in yet. Add one under Website agents.' : 'There is no sequence or website to use it in yet.'}</p>
        ) : isCatalogue ? (
          <TargetChecklist targets={targets} websitesOnly isChecked={(k) => on.has(k)} isBusy={(k) => busy.has(k)} onToggle={toggle} />
        ) : (
          <TargetChecklist targets={targets} isChecked={(k) => on.has(k)} isBusy={(k) => busy.has(k)} onToggle={toggle} />
        )}
        {error && <ErrorBox message={error} />}
        {isCatalogue ? (
          <p className="text-xs text-gray-500">
            {on.size === 0 ? 'Not used yet.' : `Used in ${on.size} ${plural(on.size, 'website')}.`} The assistant recommends from it once <b>Recommend products</b> is on for that website (Website agents → the website → AI agent → Products) and the catalogue has products.
          </p>
        ) : (
          <p className="text-xs text-gray-500">
            {on.size === 0 ? 'Not used yet.' : `Used in ${on.size} ${plural(on.size, 'place')}.`} Adding it to a sequence, or taking it off, saves a new version of that sequence&rsquo;s prompt. On Auto, the next 10 replies of that sequence wait so you can check them.
          </p>
        )}
      </div>
    </Modal>
  );
}
