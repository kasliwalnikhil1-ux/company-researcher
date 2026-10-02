'use client';

import { useState } from 'react';
import { Check, Pencil, RefreshCw, SkipForward } from 'lucide-react';
import { editLineFields, reviewLines } from '@/lib/outreach/aiHub';
import { editOf, editProblems, editToData, sameEdit, type FieldEdit } from '@/lib/outreach/aiFields';
import { factLines } from '@/lib/outreach/intel';
import type { AiField, AiFieldValue } from '@/lib/outreach/types';
import { Button, Textarea } from '@/components/outreach/ui';
import { FieldValueEditor, FieldValueTable } from '@/components/outreach/ai/hub/lines/FieldValueEditor';
import NeedCard, { ClampText, Hint, Part } from './NeedCard';
import { lineFields, metaText, metaValue, type CardProps, type LineEdit } from './types';

interface LineCardProps extends CardProps {
  checked: boolean; onCheck: () => void;
  /** undefined = not being edited. A one-line variable edits its text, a Fields variable its typed inputs. */
  edit: LineEdit | undefined; onEdit: (edit: LineEdit | undefined) => void;
}

const HANDLED = 'This line was already handled.';

/** The facts the AI relied on, folded. The same on both kinds of line. */
function Facts({ facts }: { facts: string[] }) {
  if (facts.length === 0) return null;
  return (
    <details className="text-xs text-gray-600">
      <summary className="w-fit cursor-pointer select-none text-gray-500 hover:text-gray-800 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Facts used ({facts.length})</summary>
      <ul className="mt-1 ml-4 list-disc space-y-0.5">{facts.map((f, i) => <li key={i} className="break-words [overflow-wrap:anywhere]">{f}</li>)}</ul>
    </details>
  );
}

/** Approve · Edit · Regenerate · Skip: the same four on both kinds of line (they act on the whole value). */
function ReadActions({ row, api, approve, onEdit }: Pick<LineCardProps, 'row' | 'api'> & { approve: () => void; onEdit: () => void }) {
  return (
    <>
      <Button size="sm" onClick={approve}><Check className="w-3.5 h-3.5" /> Approve</Button>
      <Button size="sm" variant="secondary" onClick={onEdit}><Pencil className="w-3.5 h-3.5" /> Edit</Button>
      <Button size="sm" variant="secondary" onClick={() => void api.act(row, () => reviewLines([row.id], 'regenerate'), 'The line is being written again. It comes back here when it is ready.')} title="Write a new line for this lead"><RefreshCw className="w-3.5 h-3.5" /> Regenerate</Button>
      <Button size="sm" variant="ghost" onClick={() => api.defer(row, 'Line skipped', () => reviewLines([row.id], 'skip'))} title="The fallback is used for this lead"><SkipForward className="w-3.5 h-3.5" /> Skip</Button>
    </>
  );
}

/**
 * Line: one Personalized line waiting for approval. The edit lives in the view (not here) because a bulk approve has to
 * know which lines carry an unsaved edit and leave them out.
 * A one-line variable shows its line; a Fields variable shows its fields as a Field · Value table and edits them one by one.
 */
export default function LineCard(props: LineCardProps) {
  const typed = lineFields(props.row);
  return typed ? <FieldsLineCard {...props} fields={typed.fields} data={typed.data} /> : <TextLineCard {...props} />;
}

function TextLineCard({ row, hidden, api, checked, onCheck, edit: anyEdit, onEdit }: LineCardProps) {
  const edit = typeof anyEdit === 'string' ? anyEdit : undefined;
  const line = (row.ai_text ?? '').trim();
  const editing = edit !== undefined;
  const facts = factLines(metaValue(row, 'facts'));
  const fallback = metaText(row, 'fallback');
  const maxChars = Number(metaValue(row, 'max_chars'));
  const name = row.who_name ?? 'this lead';

  const approve = () => void api.act(row, () => reviewLines([row.id], 'approve'), (n) => (n > 0 ? 'Line approved.' : HANDLED));
  const save = () => {
    const text = (edit ?? '').trim();
    if (!text) return;
    if (text === line) { onEdit(undefined); approve(); return; }
    void api.act(row, () => reviewLines([row.id], 'edit', text), (n) => (n > 0 ? 'Line saved and approved.' : HANDLED)).then((ok) => { if (ok) onEdit(undefined); });
  };

  return (
    <NeedCard row={row} hidden={hidden}
      lead={api.canWrite ? <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select the line for ${name}`} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /> : undefined}
      ai={editing ? (
        <Textarea label={`Line for ${name}`} value={edit} onChange={(e) => onEdit(e.target.value)} rows={2} autoFocus className="min-h-[60px]"
          counter={Number.isFinite(maxChars) && maxChars > 0 ? { max: maxChars, value: (edit ?? '').length } : undefined}
          hint="Ctrl+Enter saves and approves. Esc discards the edit."
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); onEdit(undefined); }
          }} />
      ) : (
        <Part><ClampText text={line} /></Part>
      )}
      extra={<>
        <Facts facts={facts} />
        <Hint>{fallback ? <>Skip uses the fallback: <span className="text-gray-700">{fallback}</span></> : 'Skip uses the fallback written in the message.'}</Hint>
      </>}
      actions={api.canWrite ? (
        editing ? (
          <>
            <Button size="sm" disabled={!(edit ?? '').trim()} onClick={save}><Check className="w-3.5 h-3.5" /> Save and approve</Button>
            <Button size="sm" variant="ghost" onClick={() => onEdit(undefined)}>Discard edit</Button>
          </>
        ) : <ReadActions row={row} api={api} approve={approve} onEdit={() => onEdit(line)} />
      ) : undefined} />
  );
}

function FieldsLineCard({ row, hidden, api, checked, onCheck, edit: anyEdit, onEdit, fields, data }: LineCardProps & { fields: AiField[]; data: Record<string, AiFieldValue> | null }) {
  const edit: FieldEdit | undefined = anyEdit !== undefined && typeof anyEdit !== 'string' ? anyEdit : undefined;
  const editing = edit !== undefined;
  // What does not fit is said after the first try to save, not while the person is still typing.
  const [tried, setTried] = useState(false);
  const facts = factLines(metaValue(row, 'facts'));
  const name = row.who_name ?? 'this lead';

  const approve = () => void api.act(row, () => reviewLines([row.id], 'approve'), (n) => (n > 0 ? 'Line approved.' : HANDLED));
  const discard = () => { setTried(false); onEdit(undefined); };
  const save = () => {
    if (!edit) return;
    if (Object.keys(editProblems(fields, edit)).length > 0) { setTried(true); return; }
    // Nothing changed: it is a plain approve.
    if (sameEdit(fields, edit, data)) { discard(); approve(); return; }
    // A value the database refuses comes back as a toast that names the field; the card returns with the inputs as typed.
    void api.act(row, () => editLineFields(row.id, editToData(fields, edit)), 'Fields saved and approved.').then((ok) => { if (ok) discard(); });
  };

  return (
    <NeedCard row={row} hidden={hidden}
      lead={api.canWrite ? <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select the line for ${name}`} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /> : undefined}
      ai={editing ? (
        <div>
          <FieldValueEditor fields={fields} edit={edit} onChange={onEdit} onSave={save} onDiscard={discard} showProblems={tried} who={name} autoFocus />
          <p className="text-xs text-gray-500 mt-1.5">Ctrl+Enter saves and approves. Esc discards the edit. Leave a field empty when the profile does not say.</p>
        </div>
      ) : (
        <Part><FieldValueTable fields={fields} data={data} className="max-w-2xl" /></Part>
      )}
      extra={<>
        <Facts facts={facts} />
        <Hint>Skip uses the fallback written in the message. A Condition step then reads every field as empty.</Hint>
      </>}
      actions={api.canWrite ? (
        editing ? (
          <>
            <Button size="sm" onClick={save}><Check className="w-3.5 h-3.5" /> Save and approve</Button>
            <Button size="sm" variant="ghost" onClick={discard}>Discard edit</Button>
          </>
        ) : <ReadActions row={row} api={api} approve={approve} onEdit={() => { setTried(false); onEdit(editOf(fields, data)); }} />
      ) : undefined} />
  );
}
