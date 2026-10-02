'use client';

import { useState } from 'react';
import { parseError } from '@/lib/outreach/api';
import { FIELD_KEY_RE, fieldOf } from '@/lib/outreach/aiFields';
import type { AiVariable } from '@/lib/outreach/intel';
import { Button, ErrorBox, Modal } from '@/components/outreach/ui';
import { FieldTokenChips } from './FieldListEditor';
import VariableFields, { VariableToken } from './VariableFields';
import { EMPTY_DRAFT, hasProblems, saveVariable, useInvalidateVariables, variableProblems, type VariableDraft } from './variableModel';

/**
 * "New variable": the same form as the variable page, plus the one choice that cannot change later: One line or Fields.
 * A new variable starts on Review. Render it only while it is open.
 */
export default function NewVariableModal({ ws, others, onClose, onCreated }: {
  /** `others`: every variable of the workspace, the built-in ones included (a key can be used once). */
  ws: string; others: AiVariable[]; onClose: () => void; onCreated: (name: string) => void;
}) {
  const invalidate = useInvalidateVariables(ws);
  const [draft, setDraft] = useState<VariableDraft>({ ...EMPTY_DRAFT });
  const [keyTyped, setKeyTyped] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const problems = variableProblems(draft, others);
  const typed = draft.output === 'fields';
  const tokenFields = typed ? draft.fields.filter((f) => FIELD_KEY_RE.test(f.key)).map(fieldOf) : [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (busy || hasProblems(problems)) return;
    setBusy(true); setFormError(null);
    try {
      await saveVariable(ws, draft);
      await invalidate();
      onCreated(draft.name.trim());
    } catch (er) {
      const pe = parseError(er);
      setFormError(/duplicate key|unique/i.test(pe.message) ? 'Another variable already uses this key.' : pe.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} size={typed ? 'xl' : 'lg'} title="New variable"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy}>Create variable</Button></>}>
      <form onSubmit={save} className="space-y-4" noValidate>
        <VariableFields draft={draft} onChange={setDraft} errors={submitted ? problems : {}} autoKey={!keyTyped} onKeyTyped={() => setKeyTyped(true)} autoFocus />
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">Use it in a message as</div>
          {typed
            ? tokenFields.length > 0
              ? <FieldTokenChips varKey={draft.key || 'key'} fields={tokenFields} />
              : <p className="text-xs text-gray-500">Name a field to see its token.</p>
            : <VariableToken varKey={draft.key || 'key'} fallback={draft.fallback.trim()} />}
        </div>
        {/* the Fields form is long: the marked part may be out of sight when Create is pressed */}
        {typed && submitted && hasProblems(problems) && <p role="alert" className="text-xs text-red-600">Something above is not filled in correctly. Check the parts marked in red.</p>}
        {formError && <ErrorBox message={formError} />}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
