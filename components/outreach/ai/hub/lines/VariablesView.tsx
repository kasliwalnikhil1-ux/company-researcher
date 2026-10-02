'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, Wand2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { isFieldsVariable, variableFields } from '@/lib/outreach/aiFields';
import { hubHref, linesHref, useHubSetup } from '@/lib/outreach/aiHub';
import { useAiVariables, type AiGenerateResult } from '@/lib/outreach/intel';
import { Badge, Button, EmptyState, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { GenerateLinesModal } from '@/components/outreach/ai/GenerateLinesModal';
import BuiltinVariables, { builtinsOf } from './BuiltinVariables';
import { FieldTokenChips } from './FieldListEditor';
import NewVariableModal from './NewVariableModal';
import VariableModeSwitch, { VariableCounts } from './VariableModeSwitch';
import { VariableToken } from './VariableFields';

const NO_SELECTION: string[] = [];
/** A list row shows the first tokens of a Fields variable; the rest are on its page. */
const ROW_TOKENS = 3;

/**
 * AI → Setup → Personalized lines, the Variables view (it was Settings → AI variables).
 * One row per variable: its token (or, for a Fields variable, its fields and their first tokens), what the AI writes,
 * the mode and how many lines are ready or waiting. Under the list, "Built in": the variables every workspace has,
 * read-only with an On / Off switch.
 * Owners and managers create variables and change the mode; members read, and can generate lines.
 */
export default function VariablesView({ header }: { header: ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id ?? null;
  const canEdit = isManager && canWrite;
  const vars = useAiVariables(ws);
  const setup = useHubSetup(ws);
  const [creating, setCreating] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);

  const counts = useMemo(() => new Map((setup.data?.variables ?? []).map((v) => [v.id, v])), [setup.data]);
  // The workspace's own variables; the built-in ones have their own section and are never edited.
  const list = useMemo(() => (vars.data ?? []).filter((v) => !v.builtin), [vars.data]);
  const builtins = useMemo(() => builtinsOf(vars.data), [vars.data]);
  // A new batch is followed in the All lines view, where its lines arrive.
  const onGenerated = (r: AiGenerateResult) => router.push(linesHref(r.batch_id));

  if (!ws) return null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        {header}
        <div className="flex flex-wrap items-center gap-2">
          {canWrite && <Button variant="secondary" onClick={() => setGenerateOpen(true)}><Wand2 className="w-4 h-4" /> Generate lines</Button>}
          {canEdit && <Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New variable</Button>}
        </div>
      </div>

      <Note tone="indigo" className="mb-4">
        A variable is what the AI writes for each lead: one line, or a few named fields. You use it in a message as a token, for example <code className="text-xs bg-white border border-indigo-100 rounded px-1">{'{{ai.opener|fallback}}'}</code>. <strong>Only approved lines are ever sent.</strong> Everything else uses the fallback.
      </Note>

      {vars.isLoading ? <Spinner /> : vars.isError ? <ErrorBox message={parseError(vars.error).message} /> : list.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl">
          <EmptyState icon={<Wand2 className="w-6 h-6" />} title="No variables yet"
            description={canEdit
              ? 'A variable is one personal line per lead, such as an opener about their current role. Write the instruction once, generate the lines, review them, then use the variable in any message.'
              : 'A variable is one personal line per lead, such as an opener about their current role. An owner or a manager creates the first one.'}
            action={canEdit ? <Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New variable</Button> : undefined} />
        </div>
      ) : (
        <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
          {list.map((v) => {
            const typed = isFieldsVariable(v);
            const fields = variableFields(v);
            return (
              <li key={v.id} className="px-5 py-4 flex flex-col lg:flex-row lg:items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={hubHref.setupLine(v.id)} className="text-sm font-medium text-gray-900 hover:text-indigo-700 hover:underline">{v.name}</Link>
                    {v.needs_posts && <Badge tone="purple">uses recent posts</Badge>}
                    {typed ? <Badge tone="indigo">Fields</Badge> : <Badge>max {v.max_chars} characters</Badge>}
                  </div>
                  {typed ? (
                    <>
                      <p className="text-xs text-gray-700 mt-1.5 truncate" title={fields.map((f) => f.name).join(', ')}>{fields.map((f) => f.name).join(' · ')}</p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <FieldTokenChips varKey={v.key} fields={fields.slice(0, ROW_TOKENS)} className="min-w-0" />
                        {fields.length > ROW_TOKENS && <Link href={hubHref.setupLine(v.id)} className="text-xs text-indigo-600 hover:underline whitespace-nowrap">and {fields.length - ROW_TOKENS} more</Link>}
                      </div>
                    </>
                  ) : <VariableToken varKey={v.key} fallback={v.fallback} size="sm" className="mt-1.5" />}
                  <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">{v.prompt}</p>
                  <VariableCounts counts={counts.get(v.id)} variableId={v.id} className="mt-1.5" />
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <VariableModeSwitch ws={ws} variable={v} canEdit={canEdit} compact notify={toast.show} />
                  <Link href={hubHref.setupLine(v.id)} aria-label={`${canEdit ? 'Edit' : 'Open'} ${v.name}`}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors whitespace-nowrap px-2.5 py-1.5 text-xs bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                    {canEdit && <Pencil className="w-3.5 h-3.5" aria-hidden="true" />}{canEdit ? 'Edit' : 'Open'}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {setup.error && list.length > 0 && <p className="text-xs text-gray-500 mt-2">The line counts could not be loaded: {parseError(setup.error).message}</p>}

      <BuiltinVariables ws={ws} variables={builtins} canEdit={canEdit} notify={toast.show} className="mt-8" />

      {/* every variable, the built-in ones included: a key can be used once in a workspace */}
      {creating && <NewVariableModal ws={ws} others={vars.data ?? []} onClose={() => setCreating(false)}
        onCreated={(name) => { setCreating(false); toast.show(`“${name}” created. It is on Review. Generate lines for your leads next.`); }} />}
      {generateOpen && <GenerateLinesModal open onClose={() => setGenerateOpen(false)} workspaceId={ws} isManager={isManager} selection={NO_SELECTION} onGenerated={onGenerated} />}
      {toast.node}
    </div>
  );
}
