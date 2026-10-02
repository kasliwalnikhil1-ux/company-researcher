'use client';

// AI → Knowledge (ai-hub-unified-ui-changes.md §6, as built: docs/outreach/AI-HUB.md): one library per workspace.
// Sources are workspace rows that a sequence links on its prompt and a website in its settings; Q&A pairs are shared
// unless limited; unanswered questions are answered in Needs you.
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { hubHref, useHubKnowledge, type QaPair } from '@/lib/outreach/aiHub';
import { Button, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { errText } from '@/components/outreach/sequences/ai/shared';
import { cn } from '@/lib/utils';
import { AddDocumentModal, AddWebsiteModal, type AddedSource } from './AddSourceModals';
import AddCatalogueModal from './AddCatalogueModal';
import QaEditorModal from './QaEditorModal';
import QaView from './QaView';
import SourcesView from './SourcesView';
import UseInModal from './UseInModal';
import { NO_TARGETS } from './shared';

export type KnowledgeViewKey = 'sources' | 'qa';
const VIEWS: Array<{ key: KnowledgeViewKey; label: string }> = [{ key: 'sources', label: 'Sources' }, { key: 'qa', label: 'Q&A' }];

export default function KnowledgeLibrary({ ws, view }: { ws: string; view: KnowledgeViewKey }) {
  const { isManager, canWrite } = useWorkspace();
  const canEdit = isManager && canWrite;
  const router = useRouter();
  const toast = useToast();
  const hub = useHubKnowledge(ws);
  const [adding, setAdding] = useState<'website' | 'document' | 'catalogue' | null>(null);
  const [useIn, setUseIn] = useState<(AddedSource & { justAdded?: boolean; catalogue?: boolean }) | null>(null);
  const [qaEdit, setQaEdit] = useState<{ pair: QaPair | null } | null>(null);

  const targets = hub.data?.targets ?? NO_TARGETS;
  // a new source is not attached anywhere: the next step is choosing where it is used
  const added = (s: AddedSource) => { setUseIn({ ...s, justAdded: true, catalogue: adding === 'catalogue' }); setAdding(null); };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <nav aria-label="Knowledge views" className="inline-flex rounded-lg border border-gray-300 p-0.5 bg-gray-50">
          {VIEWS.map((v) => (
            <Link key={v.key} href={hubHref.knowledge(v.key)} aria-current={view === v.key ? 'page' : undefined}
              className={cn('px-3 py-1 text-sm rounded-md', view === v.key ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900')}>{v.label}</Link>
          ))}
        </nav>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setAdding('website')}><Plus className="w-3.5 h-3.5" aria-hidden="true" />Website</Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding('document')}><Plus className="w-3.5 h-3.5" aria-hidden="true" />Document</Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding('catalogue')}><Plus className="w-3.5 h-3.5" aria-hidden="true" />Product catalogue</Button>
            <Button size="sm" variant={view === 'qa' ? 'primary' : 'secondary'} onClick={() => setQaEdit({ pair: null })}><Plus className="w-3.5 h-3.5" aria-hidden="true" />Q&amp;A</Button>
          </div>
        )}
      </div>

      {view === 'qa' ? (
        <QaView ws={ws} canEdit={canEdit} onAdd={() => setQaEdit({ pair: null })} onEdit={(pair) => setQaEdit({ pair })} notify={toast.show} />
      ) : hub.isLoading ? <Spinner /> : hub.error ? <ErrorBox message={errText(hub.error)} /> : hub.data ? (
        <SourcesView ws={ws} data={hub.data} canEdit={canEdit} canAnswer={isManager} notify={toast.show}
          onAdd={setAdding} onUseIn={(s) => setUseIn({ id: s.id, title: s.title })} onOpenQa={() => router.push(hubHref.knowledge('qa'))} />
      ) : null}

      {adding === 'website' && <AddWebsiteModal ws={ws} onClose={() => setAdding(null)} onAdded={added} notify={toast.show} />}
      {adding === 'document' && <AddDocumentModal ws={ws} onClose={() => setAdding(null)} onAdded={added} notify={toast.show} />}
      {adding === 'catalogue' && <AddCatalogueModal ws={ws} onClose={() => setAdding(null)} onAdded={added} notify={toast.show} />}
      {useIn && (
        <UseInModal key={useIn.id} ws={ws} source={useIn} justAdded={useIn.justAdded} catalogue={useIn.catalogue} live={hub.data?.sources?.find((s) => s.id === useIn.id)}
          targets={targets} loading={hub.isLoading} onClose={() => setUseIn(null)} />
      )}
      {qaEdit && (
        <QaEditorModal key={qaEdit.pair?.id ?? 'new'} ws={ws} pair={qaEdit.pair} targets={targets} targetsLoading={hub.isLoading} onClose={() => setQaEdit(null)}
          onSaved={(created) => {
            setQaEdit(null);
            toast.show(created ? 'Q&A added.' : 'Q&A saved.');
            if (created && view !== 'qa') router.push(hubHref.knowledge('qa'));
          }} />
      )}
      {toast.node}
    </div>
  );
}
