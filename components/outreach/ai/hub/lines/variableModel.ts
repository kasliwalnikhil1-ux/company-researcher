'use client';

// Personalized lines: a variable is a prompt plus what the AI returns for each lead.
//   One line   a sentence, used in a message as {{ai.<key>|<fallback>}}
//   Fields     up to 8 named, typed fields from one AI call, used as {{ai.<key>.<field>|<fallback>}} and in a Condition step
// This is the form model shared by the "New variable" dialog and the variable page, and the writes behind them.
// Name, prompt, fallback, limits and the field list are written straight to outreach_ai_variables under RLS (owners and
// managers); the mode has its own RPC (useVariableSetMode in lib/outreach/aiHub.ts) because switching off also stops queued lines.
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/outreach/backend';
import { hk } from '@/lib/outreach/aiHub';
import { fieldDraftOf, fieldListProblems, fieldOf, hasFieldProblems, isFieldsVariable, sameFields, variableFields, type FieldDraft, type FieldProblem } from '@/lib/outreach/aiFields';
import { ik, type AiVariable } from '@/lib/outreach/intel';
import type { AiVariableOutput } from '@/lib/outreach/types';

export const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const PROMPT_MAX = 2000;
/** A Fields variable has no line of its own, but the columns are still required: the default limit and no fallback. */
const FIELDS_MAX_CHARS = 220;

export interface VariableDraft {
  id: string | null; key: string; name: string; prompt: string; fallback: string; needs_posts: boolean; max_chars: string;
  /** Picked when the variable is created; it cannot change afterwards. */
  output: AiVariableOutput;
  /** The field list of a Fields variable. A one-line variable keeps what was typed here but never saves it. */
  fields: FieldDraft[];
}
export const EMPTY_DRAFT: VariableDraft = { id: null, key: '', name: '', prompt: '', fallback: '', needs_posts: false, max_chars: '220', output: 'text', fields: [] };
export const draftOf = (v: AiVariable): VariableDraft => ({
  id: v.id, key: v.key, name: v.name ?? '', prompt: v.prompt ?? '', fallback: v.fallback ?? '', needs_posts: !!v.needs_posts, max_chars: String(v.max_chars ?? 220),
  output: isFieldsVariable(v) ? 'fields' : 'text', fields: variableFields(v).map(fieldDraftOf),
});
export const sameDraft = (a: VariableDraft, b: VariableDraft) =>
  a.name.trim() === b.name.trim() && a.prompt.trim() === b.prompt.trim() && a.needs_posts === b.needs_posts && a.key === b.key && a.output === b.output
  && (a.output === 'fields' ? sameFields(a.fields, b.fields) : a.fallback.trim() === b.fallback.trim() && a.max_chars === b.max_chars);

/** What goes into a message: {{ai.opener|fallback text}}. */
export const variableToken = (key: string, fallback?: string | null) => `{{ai.${key}${fallback ? `|${fallback}` : ''}}}`;
export const keyFromName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'v$1').slice(0, 40);

export interface VariableProblems {
  name?: string; key?: string; prompt?: string; fallback?: string; max_chars?: string;
  /** Fields: what is wrong per field, in the order of the list. Absent when every field is fine. */
  fields?: FieldProblem[];
  /** Fields: what is wrong with the list as a whole (no field, too many). */
  fieldList?: string;
}
export function variableProblems(d: VariableDraft, others: Array<Pick<AiVariable, 'id' | 'key'>>): VariableProblems {
  const max = Number(d.max_chars);
  const typed = d.output === 'fields';
  const list = typed ? fieldListProblems(d.fields) : null;
  return {
    name: !d.name.trim() ? 'Give it a name' : undefined,
    key: !KEY_RE.test(d.key) ? 'Start with a letter. Use 2 to 40 lowercase letters, digits or underscores.' : others.some((o) => o.key === d.key && o.id !== d.id) ? 'Another variable already uses this key' : undefined,
    prompt: d.prompt.trim().length < 20 ? (typed ? 'Describe what to work out in a sentence or two' : 'Describe what to write in a sentence or two') : d.prompt.length > PROMPT_MAX ? `Keep the prompt under ${PROMPT_MAX.toLocaleString()} characters` : undefined,
    // a Fields variable has neither: each text field has its own limit, and the fallback is written in the token
    fallback: typed ? undefined : d.fallback.includes('}}') || d.fallback.includes('|') ? 'The fallback cannot contain | or }}' : d.fallback.length > 300 ? 'Keep the fallback under 300 characters' : undefined,
    max_chars: typed ? undefined : !d.max_chars || !Number.isInteger(max) || max < 20 || max > 1000 ? 'Between 20 and 1000' : undefined,
    fields: list && hasFieldProblems({ list: list.list }) ? list.list : undefined,
    fieldList: list?.general,
  };
}
export const hasProblems = (p: VariableProblems) => Object.values(p).some(Boolean);

/**
 * Create (no id) or update. A new variable starts on Review (the column's default).
 * The output is sent only when a Fields variable is created: it is fixed after that (the database refuses a change), and
 * a one-line variable is the column's default. Removing a field that a sequence still uses, or changing its type, is
 * refused by the database with a message that names the sequences; the caller shows it as it is.
 */
export async function saveVariable(ws: string, d: VariableDraft): Promise<void> {
  const typed = d.output === 'fields';
  const row = typed
    ? { name: d.name.trim(), prompt: d.prompt.trim(), needs_posts: d.needs_posts, fields: d.fields.map(fieldOf) }
    : { name: d.name.trim(), prompt: d.prompt.trim(), fallback: d.fallback.trim(), needs_posts: d.needs_posts, max_chars: Number(d.max_chars) };
  if (d.id) {
    // the key is fixed after creation: sequences already refer to it
    const { data, error } = await db.from('outreach_ai_variables').update({ ...row, updated_at: new Date().toISOString() }).eq('id', d.id).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('E_FORBIDDEN: only owners and managers can edit variables');
    return;
  }
  const { data: u } = await db.auth.getUser();
  const created = typed ? { output: 'fields', fallback: '', max_chars: FIELDS_MAX_CHARS } : {};
  const { error } = await db.from('outreach_ai_variables').insert({ ...row, ...created, key: d.key, workspace_id: ws, created_by: u.user?.id ?? null });
  if (error) throw error;
}

/** Deletes the variable and every line written for it. */
export async function deleteVariable(id: string): Promise<void> {
  const { data, error } = await db.from('outreach_ai_variables').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('E_FORBIDDEN: only owners and managers can delete variables');
}

/** After a variable changed: the lists that show it (Setup, the pickers in a sequence step, the lines and their batches). */
export function useInvalidateVariables(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useCallback(async () => {
    if (!ws) return;
    qc.invalidateQueries({ queryKey: hk.all(ws) });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai_variables'] });   // the variable picker of a sequence step
    qc.invalidateQueries({ queryKey: ik.aiBatches(ws) });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-review'] });
    await qc.invalidateQueries({ queryKey: ik.aiVariables(ws) });
  }, [qc, ws]);
}
