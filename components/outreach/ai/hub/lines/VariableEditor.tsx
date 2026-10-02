'use client';

import { useMemo, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useRouter } from '@/lib/outreach/nav';
import { Trash2, Wand2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { isFieldsVariable, variableFields } from '@/lib/outreach/aiFields';
import { hubHref, linesHref, useHubSetup } from '@/lib/outreach/aiHub';
import { useAiVariables, type AiGenerateResult, type AiVariable } from '@/lib/outreach/intel';
import { Badge, Button, Card, EmptyState, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/settings/shared';
import ActivityTable from '@/components/outreach/ai/hub/ActivityTable';
import { GenerateLinesModal } from '@/components/outreach/ai/GenerateLinesModal';
import { BuiltinSwitch, BuiltinToken } from './BuiltinVariables';
import { FieldTokenChips } from './FieldListEditor';
import TryOnLead from './TryOnLead';
import VariableFields, { VariableToken } from './VariableFields';
import VariableModeSwitch, { VariableCounts } from './VariableModeSwitch';
import { deleteVariable, draftOf, hasProblems, sameDraft, saveVariable, useInvalidateVariables, variableProblems, type VariableDraft } from './variableModel';

const NO_SELECTION: string[] = [];
const linkButton = 'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors whitespace-nowrap px-4 py-2 text-sm bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

/**
 * AI → Setup → Personalized lines → one variable: what the AI writes, the mode, the token and the lines it wrote.
 * Owners and managers edit; members read, and can generate lines.
 * A built-in variable has no settings: its page explains that and offers the On / Off switch.
 */
export default function VariableEditor({ variableId }: { variableId: string }) {
  const { workspace } = useWorkspace();
  const ws = workspace?.id ?? null;
  const vars = useAiVariables(ws);
  const [deleted, setDeleted] = useState(false);
  const variable = useMemo(() => vars.data?.find((v) => v.id === variableId) ?? null, [vars.data, variableId]);

  // `deleted`: the list is read again before the browser has left this page; keep the spinner instead of "not found"
  if (!ws || vars.isLoading || deleted) return <Spinner />;
  if (vars.isError) return <ErrorBox message={parseError(vars.error).message} />;
  if (!variable) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl">
        <EmptyState icon={<Wand2 className="w-6 h-6" />} title="This variable does not exist" description="It may have been deleted, or it belongs to another workspace."
          action={<Link href={hubHref.setupLines()} className={linkButton}>Back to Personalized lines</Link>} />
      </div>
    );
  }
  if (variable.builtin) return <BuiltinPage ws={ws} variable={variable} />;
  return <VariablePage key={variable.id} ws={ws} variable={variable} all={vars.data ?? []} onDeleted={() => setDeleted(true)} />;
}

/** A built-in variable cannot be edited or deleted (the database refuses both): say so, and show what it does. */
function BuiltinPage({ ws, variable }: { ws: string; variable: AiVariable }) {
  const toast = useToast();
  const { isManager, canWrite } = useWorkspace();
  const canEdit = isManager && canWrite;
  return (
    <div className="max-w-2xl">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="text-base font-semibold text-gray-900 break-words">{variable.name}</h2>
        <Badge>built in</Badge>
      </div>
      <Card title="A built-in variable" actions={<BuiltinSwitch ws={ws} variable={variable} canEdit={canEdit} notify={toast.show} />}>
        <div className="space-y-3 text-sm text-gray-700">
          <p>{variable.prompt}</p>
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Use it in a message as</div>
            <BuiltinToken variable={variable} />
          </div>
          <p className="text-xs text-gray-500">Every workspace has this variable. It tidies a field the lead already has, so nobody needs to approve it, and it cannot be edited or deleted. You can switch it on or off. When it is off, messages use the lead&apos;s own field as it is.</p>
          {!canEdit && <p className="text-xs text-gray-500">Only owners and managers can switch it on or off.</p>}
          <Link href={hubHref.setupLines()} className={linkButton}>Back to Personalized lines</Link>
        </div>
      </Card>
      {toast.node}
    </div>
  );
}

function VariablePage({ ws, variable, all, onDeleted }: { ws: string; variable: AiVariable; all: AiVariable[]; onDeleted: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { isManager, canWrite } = useWorkspace();
  const canEdit = isManager && canWrite;
  const setup = useHubSetup(ws);
  const invalidate = useInvalidateVariables(ws);

  // `edits` is null until something is typed, so a fresh read of the variable (a mode change, a teammate's save) shows up.
  const saved = useMemo(() => draftOf(variable), [variable]);
  const [edits, setEdits] = useState<VariableDraft | null>(null);
  const draft = edits ?? saved;
  const dirty = !!edits && !sameDraft(edits, saved);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);

  const problems = variableProblems(draft, all);
  const counts = setup.data?.variables?.find((v) => v.id === variable.id) ?? null;
  const waiting = Number(counts?.waiting ?? 0) || 0;
  const typed = isFieldsVariable(variable);
  // The tokens that work today: the saved fields, not the ones still being typed.
  const savedFields = variableFields(variable);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || busy || !dirty) return;
    setSubmitted(true);
    if (hasProblems(problems)) return;
    setBusy(true); setFormError(null);
    try {
      await saveVariable(ws, draft);
      await invalidate();
      setEdits(null); setSubmitted(false);
      toast.show(typed ? 'Variable saved. Values that are already approved stay as they are. A lead gets a new field when its value is written again.' : 'Variable saved. Lines that are already approved stay as they are.');
    } catch (er) { setFormError(parseError(er).message); }   // "Pain" is used in: … comes from the database, shown as it is
    finally { setBusy(false); }
  }

  async function remove() {
    setDeleting(true);
    try {
      await deleteVariable(variable.id);
      onDeleted();
      router.replace(hubHref.setupLines());
      invalidate();
    } catch (er) { toast.show(parseError(er).message, 'error'); setConfirmDelete(false); }
    finally { setDeleting(false); }
  }

  const onGenerated = (r: AiGenerateResult) => router.push(linesHref(r.batch_id));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900 break-words">{variable.name}</h2>
            {variable.needs_posts && <Badge tone="purple">uses recent posts</Badge>}
            {typed && <Badge tone="indigo">Fields</Badge>}
          </div>
          <VariableCounts counts={counts} variableId={variable.id} className="mt-1" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canWrite && <Button variant="secondary" onClick={() => setGenerateOpen(true)}><Wand2 className="w-4 h-4" /> Generate lines</Button>}
          {canEdit && <Button variant="secondary" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmDelete(true)}><Trash2 className="w-4 h-4" /> Delete variable</Button>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,340px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card title="What the AI writes" className="min-w-0">
            <form onSubmit={save} noValidate>
              <VariableFields draft={draft} onChange={setEdits} errors={submitted ? problems : {}} readOnly={!canEdit} />
              {formError && <ErrorBox message={formError} className="mt-4" />}
              {canEdit ? (
                <div className="flex flex-wrap items-center gap-3 mt-4">
                  <Button type="submit" loading={busy} disabled={!dirty}>Save</Button>
                  {dirty && <button type="button" onClick={() => { setEdits(null); setSubmitted(false); setFormError(null); }} disabled={busy} className="text-sm text-gray-600 hover:underline">Discard changes</button>}
                  {dirty && <span className="text-xs text-amber-700" role="status">You have changes that are not saved.</span>}
                </div>
              ) : <p className="text-xs text-gray-500 mt-4">Only owners and managers can change a variable.</p>}
            </form>
          </Card>
          {canEdit && <TryOnLead ws={ws} draft={draft} onInvalid={() => setSubmitted(true)} />}
        </div>

        <div className="space-y-4 min-w-0">
          <Card title="Mode">
            <VariableModeSwitch ws={ws} variable={variable} canEdit={canEdit} notify={toast.show} />
            {!canEdit && <p className="text-xs text-gray-500 mt-2">Only owners and managers can change the mode.</p>}
          </Card>
          <Card title="Use it in a message">
            {typed ? (
              <>
                <FieldTokenChips varKey={variable.key} fields={savedFields} />
                <p className="text-xs text-gray-500 mt-2">Click a token to copy it, then paste it into a sequence step. A lead without an approved value gets the fallback you write inside the token, for example <code className="text-[11px] break-all">{`{{ai.${variable.key}.${(savedFields.find((f) => f.type !== 'yes_no') ?? savedFields[0])?.key ?? 'field'}|your fallback}}`}</code>.</p>
                <p className="text-xs text-gray-500 mt-2">Route leads on a field with a Condition step in the sequence builder (AI fields).</p>
              </>
            ) : (
              <>
                <VariableToken varKey={variable.key} fallback={draft.fallback.trim()} />
                <p className="text-xs text-gray-500 mt-2">Paste the token into a sequence step. A lead without an approved line gets the fallback text instead.</p>
              </>
            )}
          </Card>
        </div>
      </div>

      <section aria-labelledby="variable-lines-title" className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-3">
          <div>
            <h3 id="variable-lines-title" className="text-sm font-semibold text-gray-900">Lines of this variable</h3>
            <p className="text-xs text-gray-500 mt-0.5">What the AI wrote for each lead. Approve, skip or rewrite lines in <Link href={hubHref.needsYou({ type: 'line', where: variable.id, mine: false })} className="text-indigo-600 hover:underline">Needs you</Link> or in <Link href={linesHref()} className="text-indigo-600 hover:underline">All lines</Link>.</p>
          </div>
          {setup.data && (waiting > 0
            ? <Link href={hubHref.needsYou({ type: 'line', where: variable.id, mine: false })} className="text-sm font-medium text-indigo-600 hover:underline">{waiting.toLocaleString()} waiting for you</Link>
            : <span className="text-sm text-gray-500">None waiting for you</span>)}
        </div>
        <ActivityTable ws={ws} fixed={{ feature: 'line', where: variable.id }} emptyText="No lines were written for this variable in this period. Try a longer period, or generate lines." />
      </section>

      <ConfirmModal open={confirmDelete} onClose={() => { if (!deleting) setConfirmDelete(false); }} onConfirm={remove} loading={deleting} title="Delete this variable?" confirmLabel="Delete variable">
        <p><strong>{variable.name}</strong> and every line written for it, approved ones included, are deleted.</p>
        {typed
          ? <p>Messages that still use its fields will send the fallback written in each token, and a Condition step on one of its fields will find it empty. Check your sequences first.</p>
          : <p>Messages that still contain <code className="text-xs">{`{{ai.${variable.key}}}`}</code> will send their fallback text. Check your sequences first.</p>}
      </ConfirmModal>
      {generateOpen && <GenerateLinesModal open onClose={() => setGenerateOpen(false)} workspaceId={ws} isManager={isManager} selection={NO_SELECTION} variableId={variable.id} onGenerated={onGenerated} />}
      {toast.node}
    </div>
  );
}
