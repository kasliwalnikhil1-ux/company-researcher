/**
 * Replies / Sent bookkeeping in the demo (migration 075): the columns the database keeps on `outreach_chats`
 * (first_inbound_at, last_inbound_at, first_outbound_at, last_outbound_at, last_auto_reply_at, waiting_on, ai_answering)
 * and on `outreach_messages` (replied_at, is_auto_reply, is_bounce, bounced_at).
 *
 * The real database maintains them with triggers on every write; the demo recomputes them from the messages before a
 * read whenever the store changed (cached by `store.rev`), with the same rules:
 *   - what a message counts as = outreach__msg_kind (system events / CSAT count as nothing; ours; bounce; auto; person);
 *   - is_bounce / is_auto_reply = outreach_trg_message_kind (email bounce / auto-reply subject rules on first sight, the
 *     classifier's `ooo` intent, a correction away from `ooo` clears it);
 *   - the chat timestamps and replied_at = outreach_chat_direction_recompute (window rule + the step-credit rule);
 *   - bounced_at = outreach_trg_message_direction (our latest email in the thread, else the quoted address in 72 h);
 *   - ai_answering = outreach__chat_ai_answering.
 * The values are written onto the rows in place (no change event): they are derived, like the database's.
 */
import { tableHooks } from '../query';
import type { DemoStore, Row } from '../store';

const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);
const BOUNCE_RE = /(mailer-daemon|postmaster|delivery (status )?notification|undeliverable|delivery failure|mail delivery failed|returned mail)/i;
const AUTO_SUBJECT_RE = /^\s*(auto(matic)?[ -]?(reply|response|antwort)|autoreply|out of (the )?office|ooo\b|abwesenheit|r[ée]ponse automatique|respuesta autom[áa]tica|risposta automatica|absence)/i;
const H = 3_600_000;

export type MsgKind = 'person' | 'auto' | 'bounce' | 'ours' | null;

export const CHAT_VIEW_COLUMNS = ['first_inbound_at', 'last_inbound_at', 'first_outbound_at', 'last_outbound_at', 'last_auto_reply_at', 'waiting_on', 'ai_answering'];
export const MESSAGE_VIEW_COLUMNS = ['replied_at', 'is_auto_reply', 'is_bounce', 'bounced_at'];

/** = outreach__msg_kind */
export function msgKind(m: Row): MsgKind {
  if (m.event_type != null || ['event', 'csat'].includes(String(m.content_type ?? 'text')) || String(m.sender_type ?? '') === 'system') return null;
  if (m.direction === 'out') return 'ours';
  if (m.is_bounce) return 'bounce';
  if (m.is_auto_reply) return 'auto';
  return 'person';
}

/** = outreach__chat_ai_answering */
export function chatAiAnswering(store: DemoStore, c: Row): boolean {
  if (c.provider === 'WEBCHAT') return !!c.ai_handled && !c.handed_off_at && !['off', 'review'].includes(String(c.ai_mode ?? 'off'));
  if (c.ai_handed_off_at) return false;
  if (c.ai_run_status === 'scheduled' || c.ai_run_status === 'sending') return true;
  if (c.ai_run_status === 'debouncing' || c.ai_run_status === 'drafting') return store.get('outreach_ai_reply_runs', c.ai_run_id)?.mode === 'autopilot';
  return false;
}

/**
 * outreach_trg_message_kind: the email rules apply when the message is first seen (the insert), the `ooo` intent rule on
 * insert and on every change of the intent. `_kind_intent` keeps the intent the flags were last set for.
 */
function classify(m: Row, chat: Row | undefined): void {
  if (m.direction !== 'in') {
    if (m.is_auto_reply !== false) m.is_auto_reply = false;
    if (m.is_bounce !== false) m.is_bounce = false;
    return;
  }
  const intent = m.intent ?? null;
  if (typeof m.is_bounce !== 'boolean' || typeof m.is_auto_reply !== 'boolean') {
    let bounce = false, auto = false;
    if (chat && MAIL.has(chat.provider)) {
      const e = (m.content_attributes?.email ?? {}) as Row;
      const from = String(e.from?.email ?? e.from?.identifier ?? m.sender_identifier ?? '').toLowerCase();
      const subject = String(e.subject ?? '');
      if (BOUNCE_RE.test(`${from} ${subject}`)) bounce = true;
      else if (AUTO_SUBJECT_RE.test(subject)) auto = true;
    }
    if (intent === 'ooo') auto = true;
    m.is_bounce = bounce; m.is_auto_reply = auto; m._kind_intent = intent;
  } else if (intent !== (m._kind_intent ?? null)) {
    if (intent === 'ooo') m.is_auto_reply = true;
    else if (m._kind_intent === 'ooo') m.is_auto_reply = false;
    m._kind_intent = intent;
  }
}

const minOf = (a: string | null, b: string) => (a == null || b < a ? b : a);
const maxOf = (a: string | null, b: string) => (a == null || b > a ? b : a);
const byTime = (x: Row, y: Row) => (x.sent_at < y.sent_at ? -1 : x.sent_at > y.sent_at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
const set = (r: Row, k: string, v: unknown) => { if (r[k] !== v) r[k] = v; };

const seen = new WeakMap<DemoStore, { rev: number; state: unknown }>();

/** Recomputes the Replies / Sent columns when the store changed since the last time. Cheap when nothing changed. */
export function ensureInboxViews(store: DemoStore): void {
  const last = seen.get(store);
  if (last && last.rev === store.rev && last.state === store.state) return;
  const chats = store.t('outreach_chats');
  const chatById = new Map(chats.map((c) => [c.id, c]));
  const byChat = new Map<string, Row[]>();
  for (const m of store.t('outreach_messages')) {
    classify(m, chatById.get(m.chat_id));
    let list = byChat.get(m.chat_id);
    if (!list) byChat.set(m.chat_id, (list = []));
    list.push(m);
  }
  for (const list of byChat.values()) list.sort(byTime);

  // bounced_at: each bounce notice marks the email it answers (outreach_trg_message_direction), oldest notice first
  const bounces: Row[] = [];
  for (const [cid, list] of byChat) {
    const c = chatById.get(cid);
    for (const m of list) {
      if (m.direction === 'out') m.bounced_at = null;
      else if (c && c.provider !== 'WEBCHAT' && msgKind(m) === 'bounce') bounces.push(m);
    }
  }
  bounces.sort(byTime);
  for (const b of bounces) {
    const ch = chatById.get(b.chat_id)!;
    let target: Row | undefined;
    for (const o of byChat.get(b.chat_id) ?? []) if (o.direction === 'out' && o.sent_at <= b.sent_at && !o.bounced_at) target = o;
    if (!target && b.text) {
      const text = String(b.text).toLowerCase();
      const from = new Date(Date.parse(b.sent_at) - 72 * H).toISOString();
      for (const oc of chats) {
        if (oc.sender_id !== ch.sender_id || oc.id === ch.id || !String(oc.attendee_provider_id ?? '').includes('@') || !text.includes(String(oc.attendee_provider_id).toLowerCase())) continue;
        for (const o of byChat.get(oc.id) ?? []) {
          if (o.direction === 'out' && !o.bounced_at && o.sent_at >= from && o.sent_at <= b.sent_at && (!target || o.sent_at > target.sent_at)) target = o;
        }
      }
    }
    if (!target) continue;
    target.bounced_at = b.sent_at;
    const tc = chatById.get(target.chat_id);
    const st = tc?.lead_id ? store.t('outreach_lead_sender_state').find((x) => x.lead_id === tc.lead_id && x.sender_id === tc.sender_id) : undefined;
    if (st && !st.email_bounced) st.email_bounced = true;
  }

  for (const c of chats) {
    const list = byChat.get(c.id) ?? [];
    let fi: string | null = null, li: string | null = null, la: string | null = null, fo: string | null = null, lo: string | null = null;
    const kinds = list.map((m) => msgKind(m));
    list.forEach((m, i) => {
      const k = kinds[i];
      if (k === 'person' || k === 'auto') fi = minOf(fi, m.sent_at);
      if (k === 'person') li = maxOf(li, m.sent_at);
      if (k === 'auto') la = maxOf(la, m.sent_at);
      if (k === 'ours') { fo = minOf(fo, m.sent_at); lo = maxOf(lo, m.sent_at); }
    });
    const webchat = c.provider === 'WEBCHAT';
    if (webchat) fi = c.created_at ? minOf(fi, c.created_at) : fi;
    set(c, 'first_inbound_at', fi);
    set(c, 'last_inbound_at', li);
    set(c, 'last_auto_reply_at', la);
    set(c, 'first_outbound_at', fo);
    set(c, 'last_outbound_at', lo);
    set(c, 'waiting_on', li == null ? null : lo == null || li > lo ? 'us' : 'them');
    set(c, 'ai_answering', chatAiAnswering(store, c));
    if (webchat) { for (const m of list) if (m.replied_at === undefined) m.replied_at = null; continue; }

    // replied_at: the next counted message is theirs (window rule), or a reply was credited to the step (step rule)
    const seq = list.map((m, i) => ({ m, k: kinds[i] })).filter((x) => x.k === 'person' || x.k === 'ours');
    const nextPerson = new Map<Row, string>();
    for (let i = 0; i + 1 < seq.length; i++) if (seq[i].k === 'ours' && seq[i + 1].k === 'person') nextPerson.set(seq[i].m, seq[i + 1].m.sent_at);
    list.forEach((m, i) => {
      if (kinds[i] !== 'ours') { set(m, 'replied_at', null); return; }
      let r: string | null = nextPerson.get(m) ?? null;
      if (m.action_id) {
        list.forEach((x, j) => { if (kinds[j] === 'person' && x.replied_to_action_id === m.action_id && x.sent_at >= m.sent_at) r = minOf(r, x.sent_at); });
      }
      set(m, 'replied_at', r);
    });
  }
  seen.set(store, { rev: store.rev, state: store.state });
}

let registered = false;
/** beforeRead hooks on the two tables (chained after the ones already there, e.g. the snooze wake-up). */
export function registerInboxViews(): void {
  if (registered) return;
  registered = true;
  const cols: Record<string, string[]> = { outreach_chats: CHAT_VIEW_COLUMNS, outreach_messages: MESSAGE_VIEW_COLUMNS };
  for (const t of Object.keys(cols)) {
    const prev = tableHooks[t] ?? {};
    tableHooks[t] = {
      ...prev,
      beforeRead: (s) => { prev.beforeRead?.(s); ensureInboxViews(s); },
      // the database's columns: a browser's direct update never changes them (075 outreach_trg_chat_inbox_views)
      readOnly: [...(prev.readOnly ?? []), ...cols[t]],
    };
  }
}
