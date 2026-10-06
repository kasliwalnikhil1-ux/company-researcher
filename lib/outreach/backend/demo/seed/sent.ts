/**
 * Demo seed for the inbox's Replies / Sent views (inbox-replies-sent-PRD.md §9 step 5). Runs after the inbox seed and
 * only moves the history on the way the engine would, so both views come out of the same data:
 *
 *   Sent       the history's sends (sequence steps nobody answered, connection requests with and without a note, some
 *              accepted), teammates' and the AI's replies, and two replies the account owner typed on the phone / in
 *              LinkedIn itself (origin external_device);
 *   Replies    plus two out-of-office auto-replies on email (one followed by a real answer) and a bounce notice that
 *              stays out of Replies (its email is listed under Failed · Bounced);
 *   Scheduled  the planner's slots (sim/engine.ts planAhead): leads who just accepted wait a day for the first message,
 *              agency leads whose reply window ends get the email; Leo's disconnected account holds three invitations,
 *              one lead is paused; AI replies in their hold (one in warm-up);
 *   Failed     four steps that did not go out (rate limit, timeout, LinkedIn error, an invitation sent too recently) on
 *              leads that can be retried, skipped or removed, and the bounced email.
 * Fictional people only: every row belongs to a seeded lead (no new people, so every lead keeps a face).
 */
import { REPLY_BANK } from '../sim/replies';
import { Engine, EVENTS, engineFor } from '../sim/engine';
import { inSchedule, simWallClock } from '../sim/caps';
import { addMessage } from '../inbox/shared';
import { openRun, planReply, updateRun } from '../aihub/replies';
import type { DemoStore, Row } from '../store';
import { DEMO_WS_ID, SENDER, SEQ, STAGE, leadId } from './ids';

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);

function msgsOf(s: DemoStore, chatId: string): Row[] {
  return s.t('outreach_messages').filter((m) => m.chat_id === chatId).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
}

/** The latest time at or before `t` inside the sender's working hours. */
function workingBefore(s: DemoStore, sender: Row, t: number): number {
  for (let x = t, i = 0; i < 6 * 48; i++, x -= 30 * M) if (inSchedule(sender, simWallClock(s, x))) return x;
  return t;
}

const state = (s: DemoStore, lead: string, sender: string) => s.t('outreach_lead_sender_state').find((x) => x.lead_id === lead && x.sender_id === sender);

/** Invitation accepted at `at` (what processEvents does), the lead moves to Connected. */
function accept(s: DemoStore, e: Row, at: number) {
  const st = state(s, e.lead_id, e.sender_id);
  if (st) Object.assign(st, { relation: 'first', invite_accepted_at: iso(at), invite_detected_at: iso(at + 20 * M), _accept_at: null });
  const lead = s.get('outreach_leads', e.lead_id);
  if (lead && [STAGE.new, STAGE.contacted].includes(lead.stage_id)) lead.stage_id = STAGE.connected;
}

/** Connection requests waiting for an answer, oldest invitation first. */
function waitingInvites(s: DemoStore, seq: string): Row[] {
  return s.t('outreach_enrollments').filter((e) => e.sequence_id === seq && e.status === 'waiting_connection' && e.current_node_id === 'wait')
    .map((e) => ({ e, st: state(s, e.lead_id, e.sender_id) }))
    .filter((x) => x.st?.relation === 'pending_out' && x.st.invite_sent_at)
    .sort((a, b) => String(a.st!.invite_sent_at).localeCompare(String(b.st!.invite_sent_at)) || a.e.id.localeCompare(b.e.id))
    .map((x) => x.e);
}

// ------------------------------------------------------------------------------------------------ the planner's next sends
function seedInFlight(s: DemoStore, now: number, engine: Engine): Row[] {
  const moved: Row[] = [];
  // SaaS: five of this week's open invitations were accepted in the last day; the first message waits a day (delay_1).
  // The two newest stay for seedFailedSteps; the older ones keep waiting (and are withdrawn when their window ends).
  waitingInvites(s, SEQ.saas).reverse().slice(2, 7).forEach((e, k) => {
    const at = now - (3 + k * 3) * H;
    accept(s, e, at);
    engine.step(e, at + 30 * M);
    moved.push(e);
  });
  // Agencies: three accepted two to three days ago and got the LinkedIn message; nobody answered, so the email is next
  waitingInvites(s, SEQ.agencies).reverse().slice(1, 4).forEach((e, k) => {
    const sender = s.get('outreach_senders', e.sender_id);
    if (!sender) return;
    const sendAt = workingBefore(s, sender, now - (52 + k * 7) * H);
    accept(s, e, sendAt - 50 * M);
    engine.step(e, sendAt);
    moved.push(e);
  });
  return moved;
}

/** Leo's account lost its LinkedIn session this morning: three Orchard Lane invitations it had planned are held. */
function seedHeldOnReconnect(s: DemoStore, now: number) {
  const leo = s.get('outreach_senders', SENDER.li_reconnect);
  const seq = s.get('outreach_sequences', SEQ.dental);
  const node = seq?.graph?.nodes?.send_invite;
  if (!leo || !seq || !node) return;
  if (!(seq.sender_pool ?? []).includes(leo.id)) {
    seq.sender_pool = [...(seq.sender_pool ?? []), leo.id];
    seq.sender_pools = { ...(seq.sender_pools ?? {}), LINKEDIN: [...(seq.sender_pools?.LINKEDIN ?? []), leo.id] };
  }
  const enrolled = new Set(s.t('outreach_enrollments').map((e) => e.lead_id));
  const leads = Array.from({ length: 6 }, (_, k) => s.get('outreach_leads', leadId(335 + k))).filter((l): l is Row => !!l && !enrolled.has(l.id) && !l.do_not_contact).slice(0, 3);
  leads.forEach((l, k) => {
    const created = now - (30 - k) * H;
    const e = s.insert('outreach_enrollments', {
      workspace_id: DEMO_WS_ID, sequence_id: seq.id, sequence_version: seq.head_version ?? 1, lead_id: l.id, sender_id: leo.id, status: 'active',
      current_node_id: 'send_invite', node_entered_at: iso(created + H), wait_until: null, exit_reason: null, restart_count: 0, rotation_count: 0, priority: 100,
      pinned_version: null, held_at: null, hold_reason: null, wait_reason: null, rule_id: null, current_channel: 'LINKEDIN', channel_sender_map: { LINKEDIN: leo.id },
      created_by: null, created_at: iso(created), updated_at: iso(created + H), completed_at: null,
    }, { silent: true })[0];
    s.insert('outreach_actions', {
      workspace_id: DEMO_WS_ID, enrollment_id: e.id, import_job_id: null, lead_id: l.id, node_id: 'send_invite', variant_id: null, scheduled_for: iso(now - (5 - k) * H),
      attempt: 1, decision: null, created_at: iso(created + H), status: 'queued', executed_at: null, reserved_at: null, payload: {}, response: null, error_code: null,
      action_type: 'invite', sender_id: leo.id,
    }, { silent: true });
  });
}

// ------------------------------------------------------------------------------------------------ failed steps
function seedFailedSteps(s: DemoStore, now: number) {
  const fail = (e: Row, a: Row, code: string) => {
    Object.assign(a, { status: 'failed', error_code: code, response: null, attempt: 3 });
    for (const q of s.t('outreach_actions')) if (q.enrollment_id === e.id && q.status === 'queued') { q.status = 'cancelled'; q.decision = 'failed'; }
    Object.assign(e, { status: 'failed', current_node_id: a.node_id, exit_reason: code, wait_until: null, completed_at: a.executed_at, updated_at: a.executed_at });
  };
  const recentInvite = (e: Row) => s.t('outreach_actions').find((a) => a.enrollment_id === e.id && a.node_id === 'invite' && a.status === 'sent' && now - Date.parse(a.executed_at) < 6 * D);
  // invitations LinkedIn refused to take: the request never reached them
  const invites: Array<[Row, string]> = [];
  const saas = waitingInvites(s, SEQ.saas).reverse();
  const agencies = waitingInvites(s, SEQ.agencies).reverse();
  if (saas[0]) invites.push([saas[0], '429: too many requests']);
  if (saas[1]) invites.push([saas[1], 'network_timeout_max']);
  if (agencies[0]) invites.push([agencies[0], '422: cannot_resend_yet']);
  for (const [e, code] of invites) {
    const a = recentInvite(e);
    if (!a) continue;
    fail(e, a, code);
    const st = state(s, e.lead_id, a.sender_id);
    if (st) Object.assign(st, { relation: 'none', invite_sent_at: null, invitation_id: null, invite_had_note: null, _accept_at: null });
  }
  // a LinkedIn message that hit a temporary error (its conversation had nothing else in it)
  const sent = s.t('outreach_actions').filter((a) => a.status === 'sent' && a.action_type === 'message' && a.node_id === 'message_1' && a.enrollment_id && now - Date.parse(a.executed_at) < 5 * D && now - Date.parse(a.executed_at) > 6 * H)
    .sort((a, b) => String(b.executed_at).localeCompare(String(a.executed_at)));
  for (const a of sent) {
    const msg = s.t('outreach_messages').find((m) => m.action_id === a.id);
    const e = s.get('outreach_enrollments', a.enrollment_id);
    if (!msg || !e || !['waiting_delay', 'active'].includes(e.status)) continue;
    const chat = s.get('outreach_chats', msg.chat_id);
    if (!chat || msgsOf(s, chat.id).length !== 1 || s.t('outreach_chat_notes').some((n) => n.chat_id === chat.id)) continue;
    s.remove('outreach_messages', (m) => m.id === msg.id, { silent: true });
    s.remove('outreach_chats', (c) => c.id === chat.id, { silent: true });
    s.remove(EVENTS, (x) => x.chat_id === chat.id, { silent: true });
    const st = state(s, e.lead_id, a.sender_id);
    if (st) st.last_outbound_at = null;
    fail(e, a, '503: service unavailable');
    break;
  }
}

// ------------------------------------------------------------------------------------------------ email: auto-replies and a bounce
/** Email threads where our sequence email is the only message (sent 4 h to 5 days ago), newest first. */
function lonelyEmails(s: DemoStore, now: number): Array<{ chat: Row; mail: Row; lead: Row }> {
  const out: Array<{ chat: Row; mail: Row; lead: Row }> = [];
  for (const c of s.t('outreach_chats')) {
    if (!MAIL.has(c.provider) || !c.lead_id) continue;
    const ms = msgsOf(s, c.id);
    const lead = s.get('outreach_leads', c.lead_id);
    if (ms.length !== 1 || ms[0].direction !== 'out' || !ms[0].action_id || !lead?.email_work) continue;
    const age = now - Date.parse(ms[0].sent_at);
    if (age < 4 * H || age > 5 * D) continue;
    out.push({ chat: c, mail: ms[0], lead });
  }
  return out.sort((a, b) => String(b.mail.sent_at).localeCompare(String(a.mail.sent_at)));
}

function seedEmailNotices(s: DemoStore, now: number) {
  const list = lonelyEmails(s, now);
  const mailbox = (c: Row) => s.get('outreach_senders', c.sender_id);
  const head = (from: Row, to: Row, subject: string) => ({ email: { from, to: [to], cc: [], bcc: [], reply_to: [], subject } });
  // 1. an out-of-office, nothing else (Replies, tagged Auto-reply; not Needs reply)
  const ooo = list[0];
  if (ooo) {
    const first = String(ooo.lead.first_name);
    const at = Date.parse(ooo.mail.sent_at) + 3 * M;
    const m = addMessage(s, ooo.chat, {
      direction: 'in', at, intent: 'ooo', summary: 'Out of office until next week.', sender_name: ooo.lead.full_name,
      text: `Thank you for your email. I am out of the office until Monday with limited access to email. For anything urgent, please contact our office team.\n\nBest regards,\n${first}`,
      content_attributes: head({ name: ooo.lead.full_name, email: ooo.lead.email_work }, { name: mailbox(ooo.chat)?.display_name, email: mailbox(ooo.chat)?.owner_email }, `Automatic reply: ${ooo.chat.subject ?? 'Your message'}`),
    });
    m.is_first_reply = false;
  }
  // 2. an out-of-office, then the person answered once back (Needs reply)
  const back = list[1];
  if (back) {
    const first = String(back.lead.first_name);
    const at = Date.parse(back.mail.sent_at) + 2 * M;
    const subject = back.chat.subject ?? 'Your message';
    const mb = mailbox(back.chat);
    const auto = addMessage(s, back.chat, {
      direction: 'in', at, intent: 'ooo', summary: 'Away at a conference this week.', sender_name: back.lead.full_name, read: true,
      text: REPLY_BANK.ooo[REPLY_BANK.ooo.length - 1] ?? 'I am away this week and will reply when I am back.',
      content_attributes: head({ name: back.lead.full_name, email: back.lead.email_work }, { name: mb?.display_name, email: mb?.owner_email }, `Out of Office: ${subject}`),
    });
    auto.is_first_reply = false;
    const replyAt = Math.min(now - 40 * M, at + 26 * H);
    const reply = addMessage(s, back.chat, {
      direction: 'in', at: replyAt, intent: 'interested', summary: 'Back from a conference; open to a call next week.', sender_name: back.lead.full_name, replied_to_action_id: back.mail.action_id,
      text: `Hi ${String(mb?.display_name ?? '').split(' ')[0] || 'there'},\n\nBack at my desk now, sorry for the auto-reply. This is relevant for us, we are trying to land more retainers this quarter. Could we do a short call next week?\n\n${first}`,
      content_attributes: head({ name: back.lead.full_name, email: back.lead.email_work }, { name: mb?.display_name, email: mb?.owner_email }, `Re: ${subject}`),
    });
    reply.is_first_reply = true;
    const st = state(s, back.lead.id, back.chat.sender_id);
    if (st) Object.assign(st, { replied: true, last_inbound_at: iso(replyAt) });
    Object.assign(back.lead, { last_replied_at: iso(replyAt), last_replied_channel: 'email' });
    if ([STAGE.new, STAGE.contacted, STAGE.connected, STAGE.replied].includes(back.lead.stage_id)) back.lead.stage_id = STAGE.interested;
  }
  // 3. the address does not exist: the mail server's notice comes back in the thread (Failed · Bounced, not Replies)
  const bounce = list[2];
  if (bounce) {
    const gmail = bounce.chat.provider === 'GMAIL';
    const to = String(bounce.lead.email_work);
    const at = Date.parse(bounce.mail.sent_at) + 4 * M;
    const m = addMessage(s, bounce.chat, {
      direction: 'in', at, read: true, sender_name: gmail ? 'Mail Delivery Subsystem' : 'Microsoft Outlook',
      text: gmail
        ? `Address not found\n\nYour message wasn't delivered to ${to} because the address couldn't be found, or is unable to receive mail.`
        : `Your message to ${to} couldn't be delivered.\n\n${to.split('@')[0]} wasn't found at ${to.split('@')[1]}.`,
      content_attributes: head({ name: gmail ? 'Mail Delivery Subsystem' : 'Microsoft Outlook', email: gmail ? 'mailer-daemon@googlemail.com' : 'postmaster@outlook.com' },
        { name: mailbox(bounce.chat)?.display_name, email: mailbox(bounce.chat)?.owner_email }, gmail ? 'Delivery Status Notification (Failure)' : `Undeliverable: ${bounce.chat.subject ?? ''}`.trim()),
    });
    m.is_first_reply = false;
    const st = state(s, bounce.lead.id, bounce.chat.sender_id);
    if (st) st.email_bounced = true;
  }
}

// ------------------------------------------------------------------------------------------------ replies from the phone / LinkedIn itself
function seedOutsideReplies(s: DemoStore, now: number) {
  const busy = new Set(s.t('outreach_ai_reply_runs').filter((r) => ['draft_ready', 'scheduled', 'debouncing', 'drafting'].includes(r.status)).map((r) => r.chat_id));
  // WhatsApp: Maya answered the "check with my cofounder" message from her phone
  const wa = s.t('outreach_chats').find((c) => c.sender_id === SENDER.whatsapp && c.lead_id === leadId(96));
  const waLast = wa ? msgsOf(s, wa.id).pop() : undefined;
  if (wa && waLast?.direction === 'in') {
    const at = Math.min(now - 2 * H, Date.parse(waLast.sent_at) + 55 * M);
    addMessage(s, wa, { direction: 'out', text: 'Sounds good! Talk next week 👍', at, origin: 'external_device', sent_by: null, read_at: iso(at + 20 * M) });
  }
  // LinkedIn: an account owner answered in LinkedIn itself
  const li = s.t('outreach_chats').filter((c) => c.provider === 'LINKEDIN' && c.lead_id && !busy.has(c.id) && !c.ai_handed_off_at && c.last_direction === 'in' && c.last_message_at
    && now - Date.parse(c.last_message_at) > 3 * H && now - Date.parse(c.last_message_at) < 4 * D && c.id !== wa?.id)
    .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)))[0];
  if (li) {
    const lead = s.get('outreach_leads', li.lead_id);
    const at = Date.parse(li.last_message_at) + 35 * M;
    addMessage(s, li, { direction: 'out', text: `Thanks ${lead?.first_name ?? ''}! Let me check my calendar and come back to you with a couple of times.`.replace(' !', '!'), at, origin: 'external_device', sent_by: null, read_at: iso(at + 50 * M) });
  }
}

// ------------------------------------------------------------------------------------------------ AI replies in their hold
function seedAiHolds(s: DemoStore, now: number) {
  const holds = [{ wait: 26 * M, warmup: true }, { wait: 9 * M, warmup: false }];
  const candidates = s.t('outreach_chats').filter((c) => c.provider === 'LINKEDIN' && c.lead_id && !c.ai_handed_off_at && c.last_direction === 'in' && c.last_message_at && now - Date.parse(c.last_message_at) < 3 * H)
    .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
  for (const c of candidates) {
    const h = holds[0];
    if (!h) break;
    const inbound = msgsOf(s, c.id).filter((m) => m.direction === 'in').slice(-1);
    if (!inbound.length) continue;
    const plan = planReply(s, c, inbound, { sequenceId: c.reply_sequence_id ?? null });
    if (plan.decision !== 'send' || !plan.text) continue;
    // opened as a draft and then put in its hold, so the seed arms no timer (the runtime's job queue takes it over)
    const r = openRun(s, c, inbound, { mode: 'draft', sequenceId: c.reply_sequence_id ?? null, at: Date.parse(inbound[0].sent_at) });
    if (!r.draft_text || r.decision !== 'send') continue;
    const sendAt = now + h.wait;
    updateRun(s, r.id, {
      status: 'scheduled', mode: 'autopilot', policy_snapshot: { ...(r.policy_snapshot ?? {}), mode: 'autopilot' }, scheduled_send_at: iso(sendAt),
      timings: { ...(r.timings ?? {}), scheduled_at: r.timings?.drafted_at ?? iso(now), warmup: h.warmup },
    });
    // the AI area's job queue sends it when the hold is over (also on the next read once the time has passed)
    s.meta<Row[]>('ai_jobs', () => []).push({ kind: 'send', id: r.id, due: sendAt });
    holds.shift();
  }
}

// ------------------------------------------------------------------------------------------------
export function seedSent(s: DemoStore, now: number): void {
  const engine = new Engine(s);
  seedInFlight(s, now, engine);
  seedFailedSteps(s, now);
  seedHeldOnReconnect(s, now);
  seedEmailNotices(s, now);
  seedOutsideReplies(s, now);
  engine.resetIndexes();
  // the planner's look-ahead at "now", then one of the planned leads is paused by a teammate (Held · paused)
  engine.planAhead(now);
  const planned = s.t('outreach_actions').filter((a) => a.status === 'queued' && a.node_id === 'message_1' && a.enrollment_id)
    .sort((a, b) => String(b.scheduled_for).localeCompare(String(a.scheduled_for)))[0];
  const pe = planned ? s.get('outreach_enrollments', planned.enrollment_id) : undefined;
  if (pe && pe.status === 'waiting_delay') Object.assign(pe, { status: 'paused', paused_from: 'waiting_delay', updated_at: iso(now - 50 * M) });
  seedAiHolds(s, now);
  engineFor(s).resetIndexes();
}
