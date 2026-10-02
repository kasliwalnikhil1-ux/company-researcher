'use client';

import { useMemo, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, Wand2 } from 'lucide-react';
import { db } from '@/lib/outreach/backend';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { isFieldsVariable, variableFields } from '@/lib/outreach/aiFields';
import { hubHref, variableMode } from '@/lib/outreach/aiHub';
import { useLists, useTags } from '@/lib/outreach/queries';
import { factLines, fetchLeadIds, useAiVariables, type AiGenerateResult, type AiPreviewResult } from '@/lib/outreach/intel';
import { Button, ErrorBox, Modal, Select } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { FieldValueTable, fieldDataEmpty, readFieldData } from './hub/lines/FieldValueEditor';

const MAX_LEADS = 2000;   // outreach_ai_generate_request
type SourceKind = 'selection' | 'list' | 'tag';

/** "Generate lines". Render it only while it is open (`{open && <GenerateLinesModal open … />}`): it starts fresh each time. */
export function GenerateLinesModal({ open, onClose, workspaceId, isManager, selection, variableId: presetVariableId, onGenerated }: {
  open: boolean; onClose: () => void; workspaceId: string; isManager: boolean;
  /** Lead ids handed over from the leads list (may be empty). */
  selection: string[];
  /** The variable to start on (the variable's own page). It can still be changed in the dialog. */
  variableId?: string;
  onGenerated: (r: AiGenerateResult) => void;
}) {
  const variables = useAiVariables(workspaceId);
  // Lines are generated for the workspace's own variables. The built-in ones are written without a person, when a
  // sequence uses them, so they are not offered here.
  const own = useMemo(() => variables.data?.filter((v) => !v.builtin), [variables.data]);
  const lists = useLists(workspaceId);
  const tags = useTags(workspaceId);
  const [pickedVariable, setVariableId] = useState(presetVariableId ?? '');
  // The picked variable. Until one is picked: the first that can be generated for (one that is not switched off).
  const variableId = useMemo(() => {
    const list = own ?? [];
    if (list.some((v) => v.id === pickedVariable)) return pickedVariable;
    return (list.find((v) => variableMode(v) !== 'off') ?? list[0])?.id ?? '';
  }, [own, pickedVariable]);
  const [source, setSource] = useState<SourceKind>(selection.length ? 'selection' : 'list');
  const [listId, setListId] = useState('');
  const [tagId, setTagId] = useState('');
  const [regenerate, setRegenerate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedSample, setSampleLead] = useState('');
  // A try-out belongs to the variable and the lead it was made for: with another variable or lead it is not shown.
  const [tried, setTried] = useState<{ key: string; result?: AiPreviewResult; error?: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // Lead ids of the chosen list or tag (capped: a batch takes at most 2000 leads).
  const sourceKey = source === 'list' ? listId : source === 'tag' ? tagId : 'selection';
  const idsQ = useQuery({
    queryKey: ['outreach', workspaceId, 'ai-generate-ids', source, sourceKey], enabled: open && source !== 'selection' && !!sourceKey, staleTime: 60_000,
    queryFn: () => fetchLeadIds(workspaceId, source === 'list' ? { list_id: listId } : { tag_id: tagId }, MAX_LEADS + 1),
  });
  const allIds = useMemo(() => (source === 'selection' ? selection : idsQ.data ?? []), [source, selection, idsQ.data]);
  const leadIds = useMemo(() => allIds.slice(0, MAX_LEADS), [allIds]);
  const truncated = allIds.length > MAX_LEADS;

  // A few leads to try the prompt on.
  const sampleIds = useMemo(() => leadIds.slice(0, 8), [leadIds]);
  const sampleQ = useQuery({
    queryKey: ['outreach', workspaceId, 'ai-generate-sample', sampleIds], enabled: open && sampleIds.length > 0, staleTime: 60_000,
    queryFn: async () => {
      const { data, error: err } = await db.from('outreach_leads').select('id, full_name, company').in('id', sampleIds);
      if (err) throw parseError(err);
      return (data ?? []) as { id: string; full_name: string | null; company: string | null }[];
    },
  });
  // The picked lead while it is among the samples, else the first sample.
  const sampleLead = sampleQ.data?.some((l) => l.id === pickedSample) ? pickedSample : sampleQ.data?.[0]?.id ?? '';
  const triedKey = `${variableId}:${sampleLead}`;
  const preview = tried?.key === triedKey ? tried.result ?? null : null;
  const previewError = tried?.key === triedKey ? tried.error ?? null : null;

  const variable = own?.find((v) => v.id === variableId);
  // A Fields variable returns several named values per lead instead of one line.
  const typed = isFieldsVariable(variable);
  const fields = variableFields(variable);
  // An off variable writes no new lines (outreach_ai_generate_request raises E_AI_VARIABLE_OFF): say so before the click.
  const variableOff = !!variable && variableMode(variable) === 'off';

  const tryPrompt = async () => {
    if (!variableId || !sampleLead) return;
    const key = triedKey;
    setPreviewBusy(true); setTried(null);
    try {
      const result = await callFn<AiPreviewResult>('ai-variables', { action: 'preview_variable', workspace_id: workspaceId, variable_id: variableId, lead_id: sampleLead });
      setTried({ key, result });
    } catch (e) { setTried({ key, error: parseError(e).message }); }
    finally { setPreviewBusy(false); }
  };

  const submit = async () => {
    if (!variableId || variableOff || leadIds.length === 0) return;
    setBusy(true); setError(null);
    try {
      const r = await rpc<AiGenerateResult>('ai_generate_request', { p_ws: workspaceId, p_variable: variableId, p_lead_ids: leadIds, p_sequence: null, p_regenerate: regenerate });
      onGenerated(r);
      onClose();
    } catch (e) {
      const pe = parseError(e);
      if (pe.code === 'E_AI_VARIABLE_OFF') {
        // someone switched it off while this dialog was open: read the modes again so the picker shows it
        variables.refetch();
        setError('This variable is switched off, so no lines were written. Switch it to Review under AI → Setup → Personalized lines, or pick another variable.');
      } else setError(pe.message);
    }
    finally { setBusy(false); }
  };

  const previewText = (preview?.text ?? preview?.line ?? '').trim();
  const previewFacts = factLines(preview?.facts);
  const previewData = preview ? readFieldData(preview.data) : null;
  const noVariables = variables.isSuccess && (own?.length ?? 0) === 0;

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Generate lines" size="lg"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} disabled={!variableId || variableOff || leadIds.length === 0} onClick={submit}><Wand2 className="w-4 h-4" /> Generate for {leadIds.length.toLocaleString()} lead{leadIds.length === 1 ? '' : 's'}</Button></>}>
      <div className="space-y-4">
        <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">Lines are written ahead of time and wait for a person to approve them. Only approved lines are ever sent. Everything else uses the fallback. The AI may only use facts that are on the profile, and leaves the line blank when there is nothing usable.</p>

        {variables.error && <ErrorBox message={parseError(variables.error).message} />}
        {noVariables ? (
          <div className="text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            There are no variables yet. {isManager ? <>Create one under <Link href={hubHref.setupLines()} className="text-indigo-600 hover:underline">AI → Setup → Personalized lines</Link>: a prompt plus a fallback, used in messages as <code className="text-xs bg-white px-1 rounded border border-amber-200">{'{{ai.icebreaker|fallback}}'}</code>.</> : 'Ask a manager to create one under AI → Setup → Personalized lines.'}
          </div>
        ) : (
          <Select label="Variable" value={variableId} onChange={(e) => setVariableId(e.target.value)} disabled={variables.isLoading}>
            {variables.isLoading && <option value="">Loading…</option>}
            {own?.map((v) => <option key={v.id} value={v.id}>{v.name} · {isFieldsVariable(v) ? `Fields (${variableFields(v).length})` : `{{ai.${v.key}}}`}{variableMode(v) === 'off' ? ' (off)' : ''}</option>)}
          </Select>
        )}
        {variableOff && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 -mt-2" role="status">
            This variable is switched off, so no new lines are written for it. {isManager ? <>Switch it to Review under <Link href={hubHref.setupLine(variableId)} className="text-indigo-700 underline">AI → Setup → Personalized lines</Link>.</> : 'Ask a manager to switch it to Review.'}
          </p>
        )}
        {variable && (
          <div className="text-xs text-gray-500 -mt-2 space-y-0.5">
            <p className="line-clamp-2"><span className="font-medium text-gray-600">Prompt:</span> {variable.prompt}</p>
            {typed
              ? <p><span className="font-medium text-gray-600">Fields:</span> {fields.map((f) => f.name).join(', ')}{variable.needs_posts ? ' · uses recent posts' : ''}</p>
              : <p><span className="font-medium text-gray-600">Fallback:</span> {variable.fallback || <span className="italic">empty</span>} · up to {variable.max_chars} characters{variable.needs_posts ? ' · uses recent posts' : ''}</p>}
          </div>
        )}

        <fieldset>
          <legend className="block text-xs font-medium text-gray-600 mb-1">Leads</legend>
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 mb-2" role="radiogroup" aria-label="Where the leads come from">
            {([['selection', `Current selection${selection.length ? ` (${selection.length.toLocaleString()})` : ''}`], ['list', 'A list'], ['tag', 'A tag']] as const).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={source === id} disabled={id === 'selection' && selection.length === 0} onClick={() => setSource(id)}
                className={cn('px-3 py-1.5 text-sm rounded-md disabled:opacity-40 disabled:cursor-not-allowed', source === id ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50')}>{label}</button>
            ))}
          </div>
          {source === 'selection' && selection.length === 0 && <p className="text-xs text-gray-500">Select leads on the <Link href="/outreach/leads" className="text-indigo-600 hover:underline">leads page</Link> and choose “Generate lines” to pass them here.</p>}
          {source === 'list' && (
            <Select aria-label="List" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Choose a list…</option>
              {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}
          {source === 'tag' && (
            <Select aria-label="Tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">Choose a tag…</option>
              {tags.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          )}
          {source !== 'selection' && sourceKey && (
            <p className="text-xs text-gray-500 mt-1">{idsQ.isLoading ? 'Counting leads…' : idsQ.error ? parseError(idsQ.error).message : `${leadIds.length.toLocaleString()} lead${leadIds.length === 1 ? '' : 's'}`}</p>
          )}
          {truncated && <p className="text-xs text-amber-700 mt-1">A batch takes at most {MAX_LEADS.toLocaleString()} leads. The first {MAX_LEADS.toLocaleString()} are used. Run it again for the rest.</p>}
        </fieldset>

        <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
          <input type="checkbox" checked={regenerate} onChange={(e) => setRegenerate(e.target.checked)} className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
          <span>Write new lines for leads that already have one<span className="block text-xs text-gray-500">Off: existing lines are kept, and only missing, blank, failed and skipped ones are written. On: approved lines are replaced too and need approving again.</span></span>
        </label>

        {variableId && sampleIds.length > 0 && (
          <div className="rounded-xl border border-gray-200 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900"><FlaskConical className="w-4 h-4 text-fuchsia-500" /> Try the prompt on one lead</div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[200px]">
                <Select aria-label="Lead to try" value={sampleLead} onChange={(e) => setSampleLead(e.target.value)} disabled={sampleQ.isLoading}>
                  {sampleQ.isLoading && <option value="">Loading…</option>}
                  {sampleQ.data?.map((l) => <option key={l.id} value={l.id}>{l.full_name ?? 'Unnamed lead'}{l.company ? ` · ${l.company}` : ''}</option>)}
                </Select>
              </div>
              <Button variant="secondary" loading={previewBusy} disabled={!sampleLead} onClick={tryPrompt}>Try it</Button>
            </div>
            <p className="text-xs text-gray-500">{typed ? 'Fills the fields for this lead and shows them here.' : 'Writes one line and shows it here.'} Nothing is saved and nothing is sent.</p>
            {previewError && <ErrorBox message={previewError} />}
            {preview && (
              <div className="text-sm bg-fuchsia-50/60 border border-fuchsia-100 rounded-lg p-3 space-y-1.5">
                {typed ? (
                  <>
                    <FieldValueTable fields={fields} data={previewData} />
                    {(preview.blank || fieldDataEmpty(fields, previewData)) && <p className="text-gray-600">Nothing usable on the profile, so every field stays empty. Messages use the fallback written in each token.</p>}
                  </>
                ) : previewText ? <p className="text-gray-900 whitespace-pre-wrap">{previewText}</p> : <p className="text-gray-600">Nothing usable on the profile, so the fallback is used{(preview.fallback ?? variable?.fallback) ? <>: <span className="text-gray-900">{preview.fallback ?? variable?.fallback}</span></> : '.'}</p>}
                {previewFacts.length > 0 && <div className="text-xs text-gray-600"><span className="font-medium">Facts used:</span> {previewFacts.join(' · ')}</div>}
              </div>
            )}
          </div>
        )}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
