// AI fields (migration 066; docs/outreach/AI-FIELDS.md): a Personalized-lines variable whose output is "Fields" returns
// several typed fields from one AI call. Each field prints in a message as {{ai.<variable>.<field>}} and routes a lead in
// a Condition step as ai.<variable>.<field>. This file is the field model shared by the variable editor, the Line card,
// the Condition editor, the Insert Variables popup and the builder checks. The database is the authority: the rules here
// mirror outreach_hub_fields_valid / outreach_hub_fields_clean / outreach_hub_fields_summary so a form can say what is
// wrong before the save is refused.
import type { AiField, AiFieldType, AiFieldValue } from './types';

export const MAX_FIELDS = 8;
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,29}$/;
export const FIELD_TYPES: AiFieldType[] = ['text', 'number', 'yes_no', 'choice'];
export const FIELD_TYPE_LABEL: Record<AiFieldType, string> = { text: 'Text', number: 'Number', yes_no: 'Yes/No', choice: 'Choice' };
export const FIELD_TEXT_DEFAULT = 200;
export const FIELD_TEXT_MIN = 20;
export const FIELD_TEXT_MAX = 1000;
export const FIELD_OPTIONS_MIN = 2;
export const FIELD_OPTIONS_MAX = 12;
export const FIELD_OPTION_MAX_CHARS = 40;

/** The three variables every workspace has (067). They are written without a person and used as {{ ai_<key> }}. */
export const BUILTIN_AI_KEYS = ['contact_first_name', 'company_conversation', 'position_conversational'] as const;
export const isBuiltinKey = (key: string): boolean => (BUILTIN_AI_KEYS as readonly string[]).includes(key);

/** Anything that carries a variable's output and field list (a row of outreach_ai_variables, or a form draft). */
export interface FieldsSource { output?: string | null; fields?: AiField[] | null }
export const isFieldsVariable = (v: FieldsSource | null | undefined): boolean => v?.output === 'fields';
export const variableFields = (v: FieldsSource | null | undefined): AiField[] => (isFieldsVariable(v) && Array.isArray(v?.fields) ? v!.fields! : []);

/** A field key from its name: the slug rule of variable keys, 30 characters at most. */
export function fieldKeyFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'f$1').slice(0, 30).replace(/_+$/, '');
}

export const fieldPath = (varKey: string, fieldKey: string): string => `ai.${varKey}.${fieldKey}`;

/**
 * What a click on a field inserts into a message. Text, Number and Choice print their value; a Yes/No field inserts the
 * conditional instead, because printing it gives "true" / "false".
 */
export function fieldToken(varKey: string, field: Pick<AiField, 'key' | 'type'>): string {
  const path = fieldPath(varKey, field.key);
  return field.type === 'yes_no' ? `{{#if ${path}}}{{/if}}` : `{{${path}}}`;
}

/** One value as a person reads it: Yes / No for a yes/no field, '' when empty. */
export function fieldValueText(v: AiFieldValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/** "ICP fit: high · Pain: scaling outbound · Hiring sales: Yes" (the same line the database keeps in `text`). */
export function fieldsSummary(fields: AiField[], data: Record<string, AiFieldValue> | null | undefined): string {
  return fields.filter((f) => data?.[f.key] !== null && data?.[f.key] !== undefined).map((f) => `${f.name}: ${fieldValueText(data![f.key])}`).join(' · ');
}

// ---------------------------------------------------------------------------------------------------------------
// The field list of a variable (form model)
// ---------------------------------------------------------------------------------------------------------------
export interface FieldDraft {
  /** A stable id for React; never saved. */
  uid: string;
  key: string; name: string; type: AiFieldType; description: string;
  /** Choice: the options as typed, comma separated. */
  options: string;
  /** Text: the limit as typed. */
  max_chars: string;
  /** The field exists in the saved variable: its key cannot change (rename a key = delete the field and add it again). */
  saved: boolean;
  /** The key was typed by hand, so it no longer follows the name. */
  keyTyped?: boolean;
}

let uidSeq = 0;
const uid = () => `f${Date.now().toString(36)}${(uidSeq++).toString(36)}`;

export const newFieldDraft = (): FieldDraft => ({ uid: uid(), key: '', name: '', type: 'text', description: '', options: '', max_chars: String(FIELD_TEXT_DEFAULT), saved: false });
export const fieldDraftOf = (f: AiField): FieldDraft => ({
  uid: uid(), key: f.key, name: f.name ?? '', type: f.type, description: f.description ?? '', options: (f.options ?? []).join(', '),
  max_chars: String(f.max_chars ?? FIELD_TEXT_DEFAULT), saved: true,
});

/** "high, medium, low" → ['high', 'medium', 'low'] (trimmed, empties dropped). */
export function parseOptions(text: string): string[] {
  return text.split(',').map((o) => o.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** The field as it is saved. Only the keys its type uses are kept. */
export function fieldOf(d: FieldDraft): AiField {
  const f: AiField = { key: d.key, name: d.name.trim(), type: d.type };
  if (d.description.trim()) f.description = d.description.trim();
  if (d.type === 'text') f.max_chars = Number(d.max_chars) || FIELD_TEXT_DEFAULT;
  if (d.type === 'choice') f.options = parseOptions(d.options);
  return f;
}

export interface FieldProblem { name?: string; key?: string; options?: string; max_chars?: string; description?: string }

/** Problems per field (same order as the drafts), plus one for the list as a whole. */
export function fieldListProblems(drafts: FieldDraft[]): { list: FieldProblem[]; general?: string } {
  const general = drafts.length === 0 ? 'Add at least one field' : drafts.length > MAX_FIELDS ? `A variable can have up to ${MAX_FIELDS} fields` : undefined;
  const list = drafts.map((d, i): FieldProblem => {
    const p: FieldProblem = {};
    const name = d.name.trim();
    if (!name) p.name = 'Give the field a name';
    else if (name.length > 40) p.name = 'Keep the name under 40 characters';
    else if (drafts.some((o, j) => j !== i && o.name.trim().toLowerCase() === name.toLowerCase())) p.name = 'Another field has this name';
    if (!FIELD_KEY_RE.test(d.key)) p.key = 'Start with a letter. Use 2 to 30 lowercase letters, digits or underscores.';
    else if (drafts.some((o, j) => j !== i && o.key === d.key)) p.key = 'Another field uses this key';
    if (d.description.length > 300) p.description = 'Keep the description under 300 characters';
    if (d.type === 'text') {
      const n = Number(d.max_chars);
      if (!d.max_chars || !Number.isInteger(n) || n < FIELD_TEXT_MIN || n > FIELD_TEXT_MAX) p.max_chars = `Between ${FIELD_TEXT_MIN} and ${FIELD_TEXT_MAX}`;
    }
    if (d.type === 'choice') {
      const opts = parseOptions(d.options);
      const lower = opts.map((o) => o.toLowerCase());
      if (opts.length < FIELD_OPTIONS_MIN) p.options = 'List at least two options, separated by commas';
      else if (opts.length > FIELD_OPTIONS_MAX) p.options = `Up to ${FIELD_OPTIONS_MAX} options`;
      else if (opts.some((o) => o.length > FIELD_OPTION_MAX_CHARS)) p.options = `Keep each option under ${FIELD_OPTION_MAX_CHARS} characters`;
      else if (opts.some((o) => /[{}|]/.test(o))) p.options = 'Options cannot contain { } or |';
      else if (new Set(lower).size !== lower.length) p.options = 'Each option can appear once';
    }
    return p;
  });
  return { list, general };
}
export const hasFieldProblems = (r: { list: FieldProblem[]; general?: string }): boolean => !!r.general || r.list.some((p) => Object.values(p).some(Boolean));

/** True when two field lists save the same thing (order included). */
export function sameFields(a: FieldDraft[], b: FieldDraft[]): boolean {
  return a.length === b.length && a.every((d, i) => JSON.stringify(fieldOf(d)) === JSON.stringify(fieldOf(b[i])));
}

// ---------------------------------------------------------------------------------------------------------------
// The typed edit of one value (the Line card, the All lines table)
// ---------------------------------------------------------------------------------------------------------------
/** What the inputs hold: text as typed, a number as typed, 'true' | 'false' | '' for yes/no, an option or '' for a choice. */
export type FieldEdit = Record<string, string>;

export function editOf(fields: AiField[], data: Record<string, AiFieldValue> | null | undefined): FieldEdit {
  const e: FieldEdit = {};
  for (const f of fields) {
    const v = data?.[f.key];
    e[f.key] = v === null || v === undefined ? '' : String(v);
  }
  return e;
}

/** The object sent to outreach_hub_line_fields_edit. Empty inputs are null; the database coerces and checks the rest. */
export function editToData(fields: AiField[], edit: FieldEdit): Record<string, AiFieldValue> {
  const out: Record<string, AiFieldValue> = {};
  for (const f of fields) {
    const raw = (edit[f.key] ?? '').trim();
    if (!raw) out[f.key] = null;
    else if (f.type === 'yes_no') out[f.key] = raw === 'true';
    else if (f.type === 'number') out[f.key] = Number(raw.replace(/,/g, ''));
    else out[f.key] = raw;
  }
  return out;
}

/** Why an edit cannot be saved, per field key. `_` holds the problem of the edit as a whole. */
export function editProblems(fields: AiField[], edit: FieldEdit): Record<string, string> {
  const p: Record<string, string> = {};
  let filled = 0;
  for (const f of fields) {
    const raw = (edit[f.key] ?? '').trim();
    if (!raw) continue;
    filled++;
    if (f.type === 'number' && !/^-?[0-9]{1,15}(\.[0-9]{1,6})?$/.test(raw.replace(/,/g, ''))) p[f.key] = 'Enter a number';
    if (f.type === 'text') {
      const lim = (f.max_chars ?? FIELD_TEXT_DEFAULT) * 2;   // the same slack the database gives an edited line
      if (raw.length > lim) p[f.key] = `Keep it under ${lim.toLocaleString()} characters`;
      else if (/\{\{|\}\}/.test(raw)) p[f.key] = 'A value cannot contain {{ or }}';
    }
    if (f.type === 'choice' && !(f.options ?? []).some((o) => o.toLowerCase() === raw.toLowerCase())) p[f.key] = 'Pick one of the options';
  }
  if (filled === 0) p._ = 'Fill at least one field, or skip this lead';
  return p;
}

/** True when the inputs still hold what is stored. */
export function sameEdit(fields: AiField[], edit: FieldEdit, data: Record<string, AiFieldValue> | null | undefined): boolean {
  const stored = editOf(fields, data);
  return fields.every((f) => (edit[f.key] ?? '').trim() === (stored[f.key] ?? '').trim());
}
