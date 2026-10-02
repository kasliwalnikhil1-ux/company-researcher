/**
 * Demo seed of the sequences area (runs after the 60-day history, and only adjusts it consistently):
 *  - an A/B test on the first message of the SaaS sequence (config.variants; the sent messages carry their variant);
 *  - version 3 of the Orchard Lane sequence: the follow-up is written by a person, then a call (manual and call tasks);
 *  - a few enrollments that failed on a step (Failed leads drawer, recover);
 *  - about 20 open tasks across kinds and teammates (some overdue, some for Orchard Lane) and a few completed ones;
 *  - two auto-enrol rules with their log.
 */
import { autoLayout } from '../../../graphLayout';
import type { Graph } from '../../../types';
import { Engine } from '../sim/engine';
import { renderFor } from '../sim/render';
import type { DemoStore, Row } from '../store';
import { pickWeighted } from '../sequences/core';
import { CLIENT, DEMO_WS_ID, LIST, MEMBER, SENDER, SEQ, STAGE, TAG } from './ids';

const H = 3_600_000;
const D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export const SAAS_VARIANT_B = 'Hi {{first_name|there}}, glad we connected. Quick one: how is {{company|your team}} booking first meetings today? We help similar SaaS teams add 10 to 15 a month without hiring. Open to comparing notes?';
const DENTAL_MANUAL = 'Write a short personal note before you mark this done: mention something from their practice (a new location, a post, a review), then ask how new-patient bookings are going this quarter.';
const DENTAL_SCRIPT = 'Introduce yourself as calling on behalf of Orchard Lane Dental.\nAsk who handles new-patient marketing at the practice.\nMention the free 15-minute review of their booking funnel.\nIf interested: offer two times for a call this week.';
const CALL_SCRIPT = 'Thank them for replying on LinkedIn.\nAsk what prompted the interest and how they book first meetings today.\nOffer a 20-minute walkthrough and agree a time before hanging up.';

function setGraph(s: DemoStore, seqId: string, g: Graph) {
  const seq = s.get('outreach_sequences', seqId)!;
  seq.graph = g;
  const v = s.t('outreach_sequence_versions').find((x) => x.sequence_id === seqId && x.version === seq.head_version);
  if (v) v.graph = copy(g);
}

// ---------------------------------------------------------------------------
function seedVariants(s: DemoStore) {
  const seq = s.get('outreach_sequences', SEQ.saas);
  if (!seq?.graph?.nodes?.message_1) return;
  const g = copy(seq.graph) as Graph;
  const node = g.nodes.message_1;
  const variants = [
    { id: 'a', label: 'A', weight: 50, text: String(node.config?.text ?? '') },
    { id: 'b', label: 'B', weight: 50, text: SAAS_VARIANT_B },
  ];
  node.config = { ...(node.config ?? {}), variants };
  setGraph(s, SEQ.saas, g);
  const enr = new Map(s.t('outreach_enrollments').filter((e) => e.sequence_id === SEQ.saas).map((e) => [e.id, e]));
  const msgByAction = new Map(s.t('outreach_messages').filter((m) => m.action_id).map((m) => [m.action_id, m]));
  for (const a of s.t('outreach_actions')) {
    if (a.node_id !== 'message_1' || !a.enrollment_id || !enr.has(a.enrollment_id) || a.status === 'queued') continue;
    const e = enr.get(a.enrollment_id)!;
    const v = pickWeighted(variants, `${e.id}:message_1:variant`)!;   // the same pick the send hook makes later
    if (a.status !== 'sent') continue;
    a.variant_id = v.id;
    if (v.id !== 'b') continue;
    const text = renderFor(s, SAAS_VARIANT_B, e.lead_id, a.sender_id, e.id);
    a.payload = { ...(a.payload ?? {}), text };
    const m = msgByAction.get(a.id);
    if (!m) continue;
    m.text = text;
    const chat = s.get('outreach_chats', m.chat_id);
    if (chat && chat.last_message_at === m.sent_at && chat.last_direction === 'out') chat.last_message_preview = text.replace(/\s+/g, ' ').slice(0, 140);
  }
}

// ---------------------------------------------------------------------------
type TaskSeed = Partial<Row> & { kind: string; title: string };
function task(s: DemoStore, t: TaskSeed, now: number): Row {
  return s.insert('outreach_tasks', {
    workspace_id: DEMO_WS_ID, client_id: null, lead_id: null, sender_id: null, enrollment_id: null, node_id: null, chat_id: null, body: null,
    ai_draft: null, draft_kind: null, due_at: iso(now + D), assigned_to: null, completed_at: null, completed_by: null, result: null, created_at: iso(now - D), ...t,
  }, { silent: true })[0];
}

function seedDental(s: DemoStore, now: number) {
  const seq = s.get('outreach_sequences', SEQ.dental);
  if (!seq?.graph?.nodes?.follow_up || !seq.graph.nodes.end_done) return;
  const g = copy(seq.graph) as Graph;
  g.nodes.follow_up = { ...g.nodes.follow_up, label: 'Personal follow-up (written by you)', mode: 'manual', config: { ...(g.nodes.follow_up.config ?? {}), text: DENTAL_MANUAL }, next: 'call' };
  g.nodes.call = { id: 'call', type: 'call_task', label: 'Call the practice', config: { title: 'Call the practice owner', script: DENTAL_SCRIPT }, branches: { connected: 'tag_hot', voicemail: 'end_done', no_answer: 'end_done', wrong_number: 'end_done', next: 'end_done' }, position: { x: 0, y: 0 } };
  g.nodes.tag_hot = { id: 'tag_hot', type: 'add_tag', label: 'Tag as hot', config: { tag_id: TAG.hot }, next: 'end_done', position: { x: 0, y: 0 } };
  const g3 = autoLayout(g);
  seq.graph = g3;
  seq.head_version = 3;
  seq.updated_at = iso(now - 5 * D);
  s.insert('outreach_sequence_versions', { sequence_id: SEQ.dental, version: 3, graph: copy(g3), created_by: MEMBER.sam, created_at: iso(now - 5 * D), note: 'Personal follow-ups and a call for practices that connect', publish_mode: 'all' }, { noId: true, silent: true });

  const engine = new Engine(s);
  const waiting = s.t('outreach_enrollments').filter((e) => e.sequence_id === SEQ.dental && e.status === 'waiting_connection').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  const lead = (id: string) => s.get('outreach_leads', id)!;
  const accept = (e: Row, at: number) => {
    const st = engine.state(e.lead_id, e.sender_id);
    Object.assign(st, { relation: 'first', invite_accepted_at: iso(at), invite_detected_at: iso(at + 30 * 60_000), _accept_at: null });
    const l = lead(e.lead_id);
    if ([STAGE.new, STAGE.contacted].includes(l.stage_id)) l.stage_id = STAGE.connected;
  };
  const invitedAt = (e: Row) => Date.parse(engine.state(e.lead_id, e.sender_id).invite_sent_at ?? e.created_at);
  // four leads accepted a couple of days ago: a teammate writes the follow-up (manual step)
  const manual = waiting.slice(0, 4);
  manual.forEach((e, k) => {
    const acc = Math.min(invitedAt(e) + (6 + k * 5) * H, now - (2.5 + k * 0.4) * D);
    accept(e, acc);
    const entered = acc + D;
    Object.assign(e, { status: 'waiting_task', current_node_id: 'follow_up', node_entered_at: iso(entered), wait_until: null, updated_at: iso(entered) });
    const l = lead(e.lead_id);
    task(s, {
      kind: 'manual_node', client_id: CLIENT.orchard, lead_id: l.id, sender_id: e.sender_id, enrollment_id: e.id, node_id: 'follow_up',
      title: `Write a personal follow-up to ${l.full_name}`, body: DENTAL_MANUAL, due_at: iso(entered + D), created_at: iso(entered),
      assigned_to: k % 2 === 0 ? MEMBER.leo : null,
    }, now);
  });
  // two leads got their follow-up and are waiting for a call
  const callers = [...waiting.slice(4)].sort((a, b) => Number(!!lead(b.lead_id).phone) - Number(!!lead(a.lead_id).phone)).slice(0, 2);
  callers.forEach((e, k) => {
    const acc = Math.min(invitedAt(e) + (5 + k * 4) * H, now - (3.4 - k * 0.3) * D);
    accept(e, acc);
    const sentAt = acc + D + 3 * H;
    const l = lead(e.lead_id);
    const first = String(l.first_name ?? 'there');
    const text = k === 0
      ? `Hi ${first}, thanks for connecting! I saw ${l.company ?? 'the practice'} opened Saturday appointments recently, that must keep the front desk busy. How are new-patient bookings going this quarter?`
      : `Hi ${first}, great to connect. Congrats on the reviews for ${l.company ?? 'the practice'}, patients clearly love the team. Curious how most new patients find you these days?`;
    const sender = s.get('outreach_senders', e.sender_id)!;
    const done = task(s, {
      kind: 'manual_node', client_id: CLIENT.orchard, lead_id: l.id, sender_id: e.sender_id, enrollment_id: e.id, node_id: 'follow_up',
      title: `Write a personal follow-up to ${l.full_name}`, body: DENTAL_MANUAL, due_at: iso(acc + 2 * D), created_at: iso(acc + D),
      assigned_to: MEMBER.leo, completed_at: iso(sentAt), completed_by: MEMBER.leo, result: { text }, ai_draft: text,
    }, now);
    const a = s.insert('outreach_actions', {
      workspace_id: DEMO_WS_ID, enrollment_id: e.id, import_job_id: null, lead_id: l.id, node_id: 'follow_up', variant_id: null, scheduled_for: iso(sentAt), attempt: 1,
      decision: null, created_at: iso(sentAt - 60_000), status: 'sent', executed_at: iso(sentAt), reserved_at: iso(sentAt - 30_000),
      payload: { text, approved_task_id: done.id, approved_by: MEMBER.leo }, response: { ok: true }, error_code: null, action_type: 'message', sender_id: sender.id,
    }, { silent: true })[0];
    const chat = engine.ensureChat(l, sender, sentAt, null);
    engine.appendMessage(chat, { direction: 'out', text, at: sentAt, action_id: a.id, sent_by: MEMBER.leo, origin: 'sequence' });
    const st = engine.state(l.id, sender.id);
    Object.assign(st, { last_outbound_at: iso(sentAt), unipile_chat_id: chat.unipile_chat_id });
    Object.assign(e, { status: 'waiting_task', current_node_id: 'call', node_entered_at: iso(sentAt), wait_until: null, updated_at: iso(sentAt) });
    task(s, {
      kind: 'call', client_id: CLIENT.orchard, lead_id: l.id, sender_id: e.sender_id, enrollment_id: e.id, node_id: 'call', title: 'Call the practice owner',
      body: `Phone: ${l.phone ?? 'not on file'}\n${DENTAL_SCRIPT}`, due_at: iso(sentAt + D), created_at: iso(sentAt), assigned_to: k === 0 ? MEMBER.leo : MEMBER.priya,
    }, now);
  });
}

// ---------------------------------------------------------------------------
function seedFailures(s: DemoStore) {
  const codes = ['429: too many requests', 'network_timeout_max', '503: service unavailable', '401: session expired', '429: too many requests'];
  const ended = s.t('outreach_enrollments').filter((e) => e.sequence_id === SEQ.saas && e.status === 'completed' && e.current_node_id === 'end_not_connected').sort((a, b) => a.id.localeCompare(b.id));
  let k = 0;
  for (const e of ended) {
    if (k >= codes.length) break;
    const a = s.t('outreach_actions').find((x) => x.enrollment_id === e.id && x.node_id === 'withdraw' && x.status === 'sent');
    if (!a) continue;
    Object.assign(a, { status: 'failed', error_code: codes[k], response: null, attempt: 3 });
    Object.assign(e, { status: 'failed', current_node_id: 'withdraw', exit_reason: codes[k], completed_at: a.executed_at, updated_at: a.executed_at });
    const st = s.t('outreach_lead_sender_state').find((x) => x.lead_id === e.lead_id && x.sender_id === a.sender_id);
    if (st && st.relation !== 'first') Object.assign(st, { relation: 'pending_out', invite_withdrawn_at: null });
    k++;
  }
}

// ---------------------------------------------------------------------------
function seedLooseTasks(s: DemoStore, now: number) {
  const team = [MEMBER.maya, MEMBER.sam, MEMBER.priya, null];
  // follow-ups on conversations where the lead replied
  const firstIn = s.t('outreach_messages').filter((m) => m.direction === 'in' && m.is_first_reply).sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));
  const order = ['interested', 'question', 'not_now'];
  const picks = [...firstIn].sort((a, b) => (order.indexOf(a.intent) + 10 * Number(order.indexOf(a.intent) < 0)) - (order.indexOf(b.intent) + 10 * Number(order.indexOf(b.intent) < 0))).slice(0, 10);
  const what: Record<string, string> = { interested: 'Asked for more details. Send the case study and suggest two times for a call.', question: 'Asked how it works. Answer their question and share the one-page overview.', not_now: 'Said the timing is not right. Check back in when they suggested.' };
  picks.forEach((m, k) => {
    const chat = s.get('outreach_chats', m.chat_id);
    const l = chat?.lead_id ? s.get('outreach_leads', chat.lead_id) : undefined;
    if (!chat || !l) return;
    const created = Date.parse(m.sent_at) + 2 * H;
    const due = k < 3 ? now - (k + 1) * 9 * H : now + (k - 2) * 14 * H;
    const isDone = k >= 8;
    task(s, {
      kind: 'follow_up', client_id: chat.client_id ?? l.client_id ?? null, lead_id: l.id, sender_id: chat.sender_id, chat_id: chat.id,
      title: `Follow up with ${l.full_name}`, body: what[m.intent] ?? 'Reply to their message and keep the conversation going.',
      due_at: iso(Math.max(due, created + H)), created_at: iso(created),
      assigned_to: l.client_id === CLIENT.orchard ? MEMBER.leo : team[k % team.length],
      ...(isDone ? { completed_at: iso(Math.min(now - H, created + 20 * H)), completed_by: MEMBER.maya, result: { text: null } } : {}),
    }, now);
  });
  // calls with leads who left a number
  const phones = s.t('outreach_leads').filter((l) => l.phone && !l.do_not_contact && !l.client_id).sort((a, b) => String(b.last_replied_at ?? '').localeCompare(String(a.last_replied_at ?? '')) || a.id.localeCompare(b.id)).slice(0, 5);
  phones.forEach((l, k) => {
    const isDone = k === 4;
    task(s, {
      kind: 'call', lead_id: l.id, sender_id: SENDER.li_maya, title: `Call ${l.full_name}`, body: `Phone: ${l.phone}\n${CALL_SCRIPT}`,
      due_at: iso(k === 0 ? now - 5 * H : now + k * 20 * H), created_at: iso(now - (k + 1) * 11 * H), assigned_to: [MEMBER.sam, MEMBER.maya, MEMBER.priya, MEMBER.sam, MEMBER.maya][k],
      ...(isDone ? { completed_at: iso(now - 3 * H), completed_by: MEMBER.maya, result: { outcome: 'voicemail', notes: 'Left a short message, will try again Thursday.' } } : {}),
    }, now);
  });
  // the sender that lost its session
  const rs = s.get('outreach_senders', SENDER.li_reconnect);
  if (rs) task(s, {
    kind: 'reconnect', client_id: rs.client_id ?? CLIENT.orchard, sender_id: rs.id, title: `Reconnect ${rs.display_name}'s LinkedIn account`,
    body: `LinkedIn asked ${rs.display_name} to sign in again. Nothing is sent from this account until it is reconnected. Open the sender page to send a new sign-in link.`,
    due_at: iso(now - H), created_at: iso(Date.parse(rs.last_disconnect_at ?? iso(now - 7 * H))), assigned_to: MEMBER.leo,
  }, now);
}

// ---------------------------------------------------------------------------
function seedRules(s: DemoStore, now: number) {
  const r1 = s.insert('outreach_auto_enroll_rules', {
    workspace_id: DEMO_WS_ID, sequence_id: SEQ.saas, name: 'New leads in “SaaS founders · North America”', list_id: LIST.founders, filter: {}, daily_cap: 25, active: true,
    last_run_at: iso(now - 3 * H), created_by: MEMBER.maya, created_at: iso(now - 20 * D),
  }, { silent: true })[0];
  s.insert('outreach_auto_enroll_rules', {
    workspace_id: DEMO_WS_ID, sequence_id: SEQ.agencies, name: 'Managing partners in “Agency owners”', list_id: LIST.agencies, filter: { title_contains: 'Partner' }, daily_cap: 15, active: false,
    last_run_at: iso(now - 9 * D), created_by: MEMBER.sam, created_at: iso(now - 12 * D),
  }, { silent: true });
  // the SaaS batches since the rule was created came in through it
  const byDay = new Map<string, Row[]>();
  for (const e of s.t('outreach_enrollments')) {
    if (e.sequence_id !== SEQ.saas || Date.parse(e.created_at) < Date.parse(r1.created_at)) continue;
    e.rule_id = r1.id;
    const day = String(e.created_at).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(e);
  }
  let id = 1;
  for (const [day, list] of [...byDay.entries()].sort()) {
    s.insert('outreach_auto_enroll_log', { id: id++, rule_id: r1.id, day, matched: list.length, enrolled: list.length, skipped: { active: 0, suppressed: 0, replied_recently: 0, other: 0 }, at: list[0].created_at }, { noId: true, silent: true });
  }
}

export function seedSequences(s: DemoStore, now: number): void {
  seedVariants(s);
  seedFailures(s);
  seedDental(s, now);
  seedLooseTasks(s, now);
  seedRules(s, now);
}
