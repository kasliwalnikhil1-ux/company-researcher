import type { NeedsYouRow } from '@/lib/outreach/aiHub';
import type { RunWarning } from '@/lib/outreach/aiReplies';
import { sameEdit, type FieldEdit } from '@/lib/outreach/aiFields';
import type { AiField, AiFieldValue } from '@/lib/outreach/types';
import { readFieldData, readFields } from '@/components/outreach/ai/hub/lines/FieldValueEditor';

/** One card = one row of outreach_ai_needs_you. Ids are only unique within a type. */
export const cardKey = (r: Pick<NeedsYouRow, 'type' | 'id'>) => `${r.type}:${r.id}`;

export type Notify = (message: string, type?: 'success' | 'error') => void;

/** What a card can do. Every action goes through here so removal, Undo, errors and the refetch behave the same on all types. */
export interface CardApi {
  canWrite: boolean;
  /** The member may send replies (the server refuses a send without it). */
  canReply: boolean;
  isManager: boolean;
  /** Run now. The cards leave at once; they come back with a toast if the call fails. */
  act: <T>(rows: NeedsYouRow | NeedsYouRow[], fn: () => Promise<T>, done?: string | ((result: T) => string)) => Promise<boolean>;
  /** Skip, Dismiss, Discard, Cancel: the cards leave at once, the call is made 5 seconds later unless Undo is pressed. */
  defer: (rows: NeedsYouRow | NeedsYouRow[], label: string, fn: () => Promise<unknown>) => void;
  notify: Notify;
  /** Refetch the hub after a change that keeps the card (a step draft written again). */
  refresh: () => void;
  answerQuestion: (groupId: string, answer: string) => Promise<unknown>;
}

export interface CardProps { row: NeedsYouRow; hidden: boolean; api: CardApi }

// ---------------------------------------------------------------------------------------------------------------
// meta readers: `meta` is jsonb built by the view (063), so every field is checked before it is used
// ---------------------------------------------------------------------------------------------------------------
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const meta = (row: Pick<NeedsYouRow, 'meta'>): Record<string, unknown> => rec(row.meta) ?? {};

export const metaText = (row: Pick<NeedsYouRow, 'meta'>, key: string): string | null => str(meta(row)[key]);
export const metaFlag = (row: Pick<NeedsYouRow, 'meta'>, key: string): boolean => meta(row)[key] === true;
export const metaValue = (row: Pick<NeedsYouRow, 'meta'>, key: string): unknown => meta(row)[key];

/**
 * Line: the value of a Fields variable (066: the view adds `output`, `fields` and `data` to `meta`). Null for a one-line
 * variable, which keeps its text in `ai_text`.
 */
export function lineFields(row: Pick<NeedsYouRow, 'meta'>): { fields: AiField[]; data: Record<string, AiFieldValue> | null } | null {
  const m = meta(row);
  if (m.output !== 'fields') return null;
  const fields = readFields(m.fields);
  return fields.length ? { fields, data: readFieldData(m.data) } : null;
}

/** What a line card is editing: the text of a one-line variable, or the typed inputs of a Fields variable. */
export type LineEdit = string | FieldEdit;

/** True when a line card holds an edit that differs from what is stored (a bulk approve leaves such a card out). */
export function lineEditDirty(row: Pick<NeedsYouRow, 'meta' | 'ai_text'>, edit: LineEdit | undefined): boolean {
  if (edit === undefined) return false;
  if (typeof edit === 'string') return edit.trim() !== (row.ai_text ?? '').trim();
  const f = lineFields(row);
  return !!f && !sameEdit(f.fields, edit, f.data);
}

/** Only http(s) links are rendered as links: sources and examples come from crawled pages and visitors. */
export function safeUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
}

/** Reply: the engine's warnings, without the one the reason line already says. */
export function replyWarnings(row: NeedsYouRow): RunWarning[] {
  const out: RunWarning[] = [];
  for (const w of arr(meta(row).warnings)) {
    const o = rec(w);
    const code = typeof w === 'string' ? w : str(o?.code) ?? '';
    const text = str(o?.text) ?? '';
    if ((!code && !text) || code === row.reason) continue;
    out.push({ code, text });
  }
  return out;
}

/** Website: the pages the suggestion was written from. */
export function websiteSources(row: NeedsYouRow): Array<{ title: string; url: string | null }> {
  const out: Array<{ title: string; url: string | null }> = [];
  for (const s of arr(meta(row).sources)) {
    const o = rec(s);
    if (!o) continue;
    const url = safeUrl(o.url);
    const title = str(o.title) ?? url;
    if (title) out.push({ title, url });
  }
  return out;
}

/** Question: up to three recent messages that asked it. */
export function questionExamples(row: NeedsYouRow): Array<{ text: string; chatId: string | null; at: string | null }> {
  const out: Array<{ text: string; chatId: string | null; at: string | null }> = [];
  for (const e of arr(meta(row).examples)) {
    const o = rec(e);
    const text = str(o?.text);
    if (o && text) out.push({ text, chatId: str(o.chat_id), at: str(o.at) });
  }
  return out.slice(0, 3);
}
