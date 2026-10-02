/**
 * What the real executor does at send time that the demo engine leaves out, added through its send hook:
 *  - a queued step whose text a person edited (set_action_text) goes out with the edited text;
 *  - a step with A/B variants (config.variants) picks a variant by weight and sends that variant's copy.
 * The engine renders the step's base text before the hook runs, so the message row it writes next (and the chat
 * preview) are corrected as they are written, through the store's change events.
 */
import { VARIANT_TEXT_KEY } from '../../../nodes';
import type { NodeType } from '../../../types';
import { engineFor, simHooks } from '../sim/engine';
import { renderFor } from '../sim/render';
import type { DemoStore, Row } from '../store';
import { pickWeighted } from './core';

/** Edited texts of queued actions, by action id (kept in the saved state). */
export const EDITS_KEY = 'seq:queuedEdits';

type Pending = { text: string; html: string | null };
const pendingByAction = new WeakMap<DemoStore, Map<string, Pending>>();
const pendingChat = new WeakMap<DemoStore, Map<string, string>>();
const subscribed = new WeakSet<DemoStore>();

function listen(store: DemoStore) {
  if (subscribed.has(store)) return;
  subscribed.add(store);
  store.subscribe((ev) => {
    if (ev.eventType === 'INSERT' && ev.table === 'outreach_messages' && ev.new?.action_id) {
      const p = pendingByAction.get(store)?.get(ev.new.action_id);
      if (!p) return;
      pendingByAction.get(store)!.delete(ev.new.action_id);
      ev.new.text = p.text;
      if (p.html != null) ev.new.html = p.html;
      if (!pendingChat.has(store)) pendingChat.set(store, new Map());
      pendingChat.get(store)!.set(ev.new.chat_id, p.text.replace(/\s+/g, ' ').slice(0, 140));
    } else if (ev.eventType === 'UPDATE' && ev.table === 'outreach_chats' && ev.new) {
      const preview = pendingChat.get(store)?.get(ev.new.id);
      if (preview == null) return;
      pendingChat.get(store)!.delete(ev.new.id);
      ev.new.last_message_preview = preview;
    }
  });
}

const textKeyOf = (type: string): 'note' | 'text' | 'html' => VARIANT_TEXT_KEY[type as NodeType] ?? (type === 'send_invite' ? 'note' : type === 'send_email' ? 'html' : 'text');

function onSent(store: DemoStore, action: Row) {
  if (!['message', 'inmail', 'email', 'invite', 'comment'].includes(action.action_type)) return;
  const edits = store.meta<Record<string, Row>>(EDITS_KEY, () => ({}));
  let text: string | null = null;
  let subject: string | null = null;
  const edit = edits[action.id];
  if (edit) {
    text = edit.text ?? null; subject = edit.subject ?? null;
    delete edits[action.id];
  } else if (!action.payload?.approved_task_id && !action.payload?.approved_by) {
    const e = action.enrollment_id ? store.get('outreach_enrollments', action.enrollment_id) : undefined;
    if (!e) return;
    const node = (engineFor(store).graphOf(e) as Row | null)?.nodes?.[action.node_id] as Row | undefined;
    const variants: Row[] = Array.isArray(node?.config?.variants) ? node!.config.variants : [];
    if (variants.length < 2) return;
    const v = pickWeighted(variants, `${e.id}:${node!.id}:variant`);
    if (!v) return;
    action.variant_id = v.id;
    const tmpl = v[textKeyOf(node!.type)];
    if (typeof tmpl !== 'string' || !tmpl.trim()) return;
    text = renderFor(store, tmpl, e.lead_id, action.sender_id, e.id);
    if (typeof v.subject === 'string' && v.subject.trim()) subject = renderFor(store, v.subject, e.lead_id, action.sender_id, e.id);
  }
  if (text == null) return;
  const p: Row = { ...(action.payload ?? {}) };
  if (action.action_type === 'invite') p.note = text;
  else if (action.action_type === 'email') { p.html = text; if (subject) p.subject = subject; }
  else p.text = text;
  action.payload = p;
  if (!['message', 'inmail', 'email'].includes(action.action_type)) return;
  listen(store);
  if (!pendingByAction.has(store)) pendingByAction.set(store, new Map());
  const isMail = action.action_type === 'email';
  pendingByAction.get(store)!.set(action.id, { text: isMail ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : text, html: isMail ? text : null });
}

let installed = false;
export function installSendOverrides() {
  if (installed) return;
  installed = true;
  simHooks.onSent.push(onSent);
}
