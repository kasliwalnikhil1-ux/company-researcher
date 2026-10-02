/**
 * outreach-exports-create in the demo: the same CSV (columns, order, escaping) built in the browser from the demo store,
 * handed back as an object URL of a Blob in place of the signed storage URL. Nothing leaves the browser.
 */
import type { Ctx } from '../ctx';
import { demoError } from '../ctx';
import type { Row } from '../store';
import { rowsOf } from './util';

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const LEAD_COLS = ['id', 'public_identifier', 'provider_id', 'profile_url', 'first_name', 'last_name', 'full_name', 'headline', 'company', 'title', 'location', 'email_work', 'email_personal', 'is_open_profile', 'do_not_contact', 'unsubscribed', 'source', 'list_id', 'stage_id', 'client_id', 'custom', 'created_at', 'updated_at'];
const MESSAGE_COLS = ['id', 'chat_id', 'direction', 'text', 'sent_at', 'intent', 'intent_confidence', 'summary', 'opens', 'clicks', 'unipile_message_id'];
const ACTION_COLS = ['id', 'enrollment_id', 'sender_id', 'lead_id', 'node_id', 'action_type', 'scheduled_for', 'status', 'attempt', 'error_code', 'decision', 'executed_at', 'created_at'];
const AUDIT_COLS = ['id', 'actor', 'actor_type', 'action', 'entity', 'entity_id', 'diff', 'at'];

const byTime = (k: string) => (a: Row, b: Row) => String(a[k] ?? '').localeCompare(String(b[k] ?? ''));

export function buildExport(ctx: Ctx, body: Row): { columns: string[]; rows: unknown[][] } {
  const store = ctx.store;
  const ws = ctx.ws;
  const pick = (r: Row, cols: string[]) => cols.map((c) => r[c] ?? null);
  switch (body.kind) {
    case 'leads': {
      const leads = store.t('outreach_leads').filter((l) => l.workspace_id === ws && (!body.client_id || l.client_id === body.client_id)).sort(byTime('created_at'));
      return { columns: LEAD_COLS, rows: leads.map((l) => pick(l, LEAD_COLS)) };
    }
    case 'messages': {
      const chats = new Map(store.t('outreach_chats').filter((c) => c.workspace_id === ws && (!body.client_id || c.client_id === body.client_id)).map((c) => [c.id, c]));
      const columns = [...MESSAGE_COLS, 'sender_id', 'lead_id', 'attendee_name', 'provider'];
      const rows = rowsOf(store, 'outreach_messages').filter((m) => chats.has(m.chat_id)).sort(byTime('sent_at')).map((m) => {
        const c = chats.get(m.chat_id)!;
        return [...pick(m, MESSAGE_COLS), c.sender_id, c.lead_id, c.attendee_name, c.provider];
      });
      if (body.include_notes === true) {
        columns.push('type');
        for (const r of rows) r.push('message');
        for (const n of rowsOf(store, 'outreach_chat_notes').filter((x) => x.workspace_id === ws && !x.deleted_at && chats.has(x.chat_id)).sort(byTime('created_at'))) {
          const c = chats.get(n.chat_id)!;
          const text = `[private note · ${n.author_type ?? 'user'} · ${n.visibility ?? 'team'}] ${String(n.body ?? '').replace(/@\[([^\]]+)\]\(user:[^)]+\)/g, '@$1')}`;
          const flat: Row = { id: n.id, chat_id: n.chat_id, direction: 'note', text, sent_at: n.created_at, sender_id: c.sender_id, lead_id: c.lead_id, attendee_name: c.attendee_name, provider: c.provider, type: 'note' };
          rows.push(columns.map((k) => flat[k] ?? null));
        }
      }
      return { columns, rows };
    }
    case 'actions': {
      const rows = rowsOf(store, 'outreach_actions').filter((a) => a.workspace_id === ws).sort(byTime('created_at')).map((a) => pick(a, ACTION_COLS));
      return { columns: ACTION_COLS, rows };
    }
    case 'audit': {
      const rows = rowsOf(store, 'outreach_audit_log').filter((a) => a.workspace_id === ws).sort(byTime('at')).map((a) => pick(a, AUDIT_COLS));
      return { columns: AUDIT_COLS, rows };
    }
    default:
      return demoError('E_PAYLOAD_INVALID', 'unknown kind');
  }
}

export function exportsCreate(ctx: Ctx, body: Row): Row {
  if (!body.workspace_id || !body.kind) demoError('E_PAYLOAD_INVALID');
  if (body.workspace_id !== ctx.ws) demoError('E_FORBIDDEN');
  const { columns, rows } = buildExport(ctx, body);
  const csv = [columns.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n');
  const includeNotes = body.kind === 'messages' && body.include_notes === true;
  const path = `${ctx.ws}/${body.kind}-${new Date().toISOString().replace(/[:.]/g, '-')}${includeNotes ? '-with-notes' : ''}.csv`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  return { ok: true, url, rows: rows.length, path };
}
