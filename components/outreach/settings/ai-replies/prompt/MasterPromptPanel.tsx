'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useDeleteMasterPrompt, useMasterPrompt, useMasterPromptList } from '@/lib/outreach/aiReplies';
import type { MasterPrompt, PromptListRow, PromptScope } from '@/lib/outreach/aiReplies';
import { useClients, useSequences, useStages } from '@/lib/outreach/queries';
import { Button, Card, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { ConfirmModal, Note } from '@/components/outreach/settings/shared';
import { WithDraftProvider, sameScope, useAiPromptDraft } from './draftContext';
import type { PromptScopeRef } from './draftContext';
import { normalize } from './promptModel';
import PromptEditor from './PromptEditor';
import { aiErrorText } from '../simulator/simModel';
import ScopePicker, { scopeLabel, scopeValue } from './ScopePicker';

export interface MasterPromptPanelProps {
  ws: string;
  canEdit: boolean;
  initialScope?: { scope: PromptScope; scopeId: string | null };
}

const WORKSPACE: PromptScopeRef = { scope: 'workspace', scopeId: null };

/** Settings → AI replies → Master prompt. Wrap it together with SimulatorPanel in <AiPromptDraftProvider> to share the draft. */
export function MasterPromptPanel(props: MasterPromptPanelProps) {
  return <WithDraftProvider><Panel {...props} /></WithDraftProvider>;
}
export default MasterPromptPanel;

/** Where an override inherits from, as a scope we can load. */
function inheritedScope(p: MasterPrompt | undefined, rows: PromptListRow[] | undefined): PromptScopeRef | null {
  if (!p || p.exists || !p.inherited) return null;
  if (p.inherited.scope === 'workspace') return WORKSPACE;
  const row = rows?.find((r) => r.id === p.inherited!.id);
  return row ? { scope: row.scope, scopeId: row.scope_id } : null;
}

function Panel({ ws, canEdit, initialScope }: MasterPromptPanelProps) {
  const ctx = useAiPromptDraft();
  const toast = useToast();
  const scope = ctx.scope ?? initialScope ?? WORKSPACE;
  const list = useMasterPromptList(ws);
  const clients = useClients(ws);
  const sequences = useSequences(ws);
  const stages = useStages(ws);
  const prompt = useMasterPrompt(ws, scope.scope, scope.scopeId);
  const inhRef = inheritedScope(prompt.data, list.data);
  const inherited = useMasterPrompt(inhRef ? ws : null, inhRef?.scope ?? 'workspace', inhRef?.scopeId ?? null);
  const remove = useDeleteMasterPrompt(ws);

  const [creating, setCreating] = useState<string | null>(null);
  const [pending, setPending] = useState<PromptScopeRef | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [nonce, setNonce] = useState(0);

  const sKey = scopeValue(scope);
  const label = scopeLabel(scope, clients.data, sequences.data, list.data);
  const data = prompt.data;
  // an override being created survives a tab switch through the kept draft
  const keptNew = !!ctx.draft?.dirty && sameScope(ctx.draft, scope) && !ctx.draft.masterPromptId && scope.scope !== 'workspace';
  const isCreating = creating === sKey || keptNew;
  const dirty = !!ctx.draft?.dirty;

  function applyScope(s: PromptScopeRef) {
    ctx.publishDraft(null);
    ctx.setScope(s);
    setCreating(null);
    setPending(null);
  }
  const requestScope = (s: PromptScopeRef) => {
    if (scopeValue(s) === sKey) return;
    if (dirty) setPending(s); else applyScope(s);
  };

  async function reload() {
    await prompt.refetch();
    ctx.publishDraft(null);
    setNonce((n) => n + 1);
  }

  async function doRemove() {
    if (scope.scope === 'workspace' || !scope.scopeId) return;
    try {
      await remove.mutateAsync({ scope: scope.scope, scopeId: scope.scopeId });
      ctx.publishDraft(null);
      setCreating(null); setConfirmRemove(false);
      toast.show('Override removed. This now uses the inherited prompt.');
    } catch (e) { toast.show(aiErrorText(e).message, 'error'); }
  }

  const inhLabel = inhRef ? scopeLabel(inhRef, clients.data, sequences.data, list.data) : null;
  const pipelineStages = stages.data ?? [];

  let body: React.ReactNode;
  if (prompt.isLoading || list.isLoading) body = <Spinner />;
  else if (prompt.isError || !data) body = <ErrorBox message={aiErrorText(prompt.error).message} />;
  else if (data.exists || scope.scope === 'workspace' || isCreating) {
    const waitInherited = isCreating && !data.exists && !!inhRef && inherited.isLoading;
    const source = data.exists ? data : isCreating && inherited.data?.exists ? inherited.data : null;
    body = waitInherited ? <Spinner /> : (
      <>
        {!data.exists && scope.scope === 'workspace' && (
          <Note tone="indigo" className="mb-4">Your AI drafts start once you save a master prompt. Replace the &lt;placeholders&gt; below with your own details first.</Note>
        )}
        {isCreating && !data.exists && (
          <Note className="mb-4">
            New override for {label}, started from {source ? (inhLabel ?? 'the inherited prompt') : 'the starting template'}. It takes effect when you save it.{' '}
            <button type="button" className="underline underline-offset-2" onClick={() => { ctx.publishDraft(null); setCreating(null); }}>Cancel</button>
          </Note>
        )}
        <PromptEditor key={`${sKey}:${nonce}`} ws={ws} canEdit={canEdit} scope={scope} scopeLabel={label}
          pipelineStages={pipelineStages} latestVersion={data.exists ? data.version : null} onReload={reload}
          initial={{
            prompt: normalize(source ?? data.template),
            id: data.exists ? data.id : null, version: data.exists ? data.version : null,
            savedBy: data.exists ? data.updated_by_name : null, savedAt: data.exists ? data.updated_at : null,
          }} />
      </>
    );
  } else {
    body = (
      <div className="rounded-lg border border-dashed border-gray-300 p-5 text-center space-y-3">
        <p className="text-sm text-gray-700">
          {inhRef ? <>Inherits from <span className="font-medium">{inhLabel}</span>{data.inherited ? ` (version ${data.inherited.version})` : ''}.</> : <>No prompt to inherit yet. Save the workspace prompt first, or give {label} its own.</>}
        </p>
        <p className="text-xs text-gray-500">Create an override when this {scope.scope} needs its own facts, situations or style.</p>
        {canEdit && <Button size="sm" onClick={() => setCreating(sKey)}>Create override</Button>}
      </div>
    );
  }

  return (
    <Card title="Master prompt"
      actions={<>
        <ScopePicker value={scope} onChange={requestScope} rows={list.data ?? []} clients={clients.data ?? []} sequences={sequences.data ?? []} />
        {canEdit && scope.scope !== 'workspace' && data?.exists && (
          <Button variant="secondary" size="sm" onClick={() => setConfirmRemove(true)}><Trash2 className="w-3.5 h-3.5" />Remove override</Button>
        )}
      </>}>
      <p className="text-sm text-gray-600 mb-4">
        How the AI replies: who it speaks for, what it offers, how a conversation moves, and when to hand over.
        Clients and sequences can have their own override; everything else uses the workspace prompt.
      </p>
      {body}
      <ConfirmModal open={confirmRemove} onClose={() => setConfirmRemove(false)} onConfirm={doRemove} loading={remove.isPending}
        title="Remove this override?" confirmLabel="Remove override">
        <p>{label} will use {inhLabel ?? 'the workspace prompt'} again.</p>
      </ConfirmModal>
      <ConfirmModal open={!!pending} onClose={() => setPending(null)} onConfirm={() => pending && applyScope(pending)}
        title="Discard unsaved changes?" confirmLabel="Discard and switch">
        <p>You have unsaved changes to the {label} prompt. Switching loses them.</p>
      </ConfirmModal>
      {toast.node}
    </Card>
  );
}
