// Builds the messages and threads the Gmail preview shows. Threading comes only from each
// step's thread setting (new / continue an earlier step) — never from a "Re:" in a subject.

import type { Conversation, Library, Profile, Sequence, Step } from './types';
import { blocksText, collapseWhitespace, renderBody, renderInline, type BlockNode, type Inline } from './emailText';
import { resolveText, type ResolveContext } from './variables';

export type PreviewMode = 'message' | 'upto' | 'full' | 'conversation';
export type Perspective = 'recipient' | 'sender';

export interface Quoted {
  header: string;
  blocks: BlockNode[];
  quoted?: Quoted;
}

export interface SimMessage {
  id: string;
  from: 'us' | 'prospect';
  fromName: string;
  fromEmail: string;
  toName: string;
  toEmail: string;
  time: Date;
  subject: string;
  subjectInl: Inline[];
  blocks: BlockNode[];
  /** Preview text: hidden preheader (html) — shown visibly in the body for plain text. */
  previewText: string;
  snippet: string;
  /** Visible body text (no quote, no signature) for counts. */
  bodyText: string;
  quoted?: Quoted;
  stepId?: string;
  stepIndex?: number;
  turnId?: string;
  sample: boolean;
  label: string;
}

export interface SimThread {
  id: string;
  subject: string;
  subjectInl: Inline[];
  messages: SimMessage[];
}

export interface Simulation {
  threads: SimThread[];
  focusMessageId?: string;
  focusThreadId?: string;
  stopped: { index: number; name: string }[];
  now: Date;
  missing: string[];
}

export interface SimOptions {
  sequenceId?: string;
  stepId?: string;
  mode: PreviewMode;
  conversationId?: string;
  profile?: Profile;
}

export function parseLocal(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

export function stepTimes(seq: Sequence, startAt: string): Date[] {
  const out: Date[] = [];
  let t = parseLocal(startAt);
  seq.steps.forEach((st, i) => {
    const d = new Date(t);
    d.setDate(d.getDate() + Math.max(0, st.delayDays || 0));
    if (i > 0 && d.getTime() <= out[i - 1].getTime()) d.setTime(out[i - 1].getTime() + 60_000);
    out.push(d);
    t = d;
  });
  return out;
}

/** Index of the step whose thread `index` joins (itself when it starts a thread). */
export function threadRootIndex(seq: Sequence, index: number): number {
  let i = index;
  const seen = new Set<number>();
  while (i > 0 && seq.steps[i].threadMode === 'continue' && !seen.has(i)) {
    seen.add(i);
    const st = seq.steps[i];
    const from = st.continueFromStepId ? seq.steps.findIndex((s) => s.id === st.continueFromStepId) : i - 1;
    i = from >= 0 && from < i ? from : i - 1;
  }
  return i;
}

export function selectedSubjectRaw(step: Step): string {
  return step.subjects.find((s) => s.id === step.selectedSubjectId)?.text ?? step.subjects[0]?.text ?? '';
}

export function reSubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** The subject a step is sent with: its own (new thread) or inherited from the thread. */
export function stepSubjectRaw(seq: Sequence, index: number): { text: string; inherited: boolean; rootIndex: number } {
  const root = threadRootIndex(seq, index);
  const rootSubject = selectedSubjectRaw(seq.steps[root]);
  if (root === index) return { text: rootSubject, inherited: false, rootIndex: root };
  return { text: reSubject(rootSubject), inherited: true, rootIndex: root };
}

export function selectedVersion(step: Step) {
  return step.versions.find((v) => v.id === step.selectedVersionId) ?? step.versions[0];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtTime(d: Date): string {
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Inbox list date (US locale): time today, "Oct 3" this year, "10/3/25" otherwise. */
export function fmtListDate(d: Date, now: Date): string {
  if (sameDay(d, now)) return fmtTime(d);
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

function ago(d: Date, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const days = Math.round(h / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Opened-message header date: "9:14 AM (2 hours ago)" / "Mon, Oct 5, 9:14 AM (3 days ago)". */
export function fmtHeaderDate(d: Date, now: Date): string {
  const base = sameDay(d, now) ? fmtTime(d) : `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === now.getFullYear() ? '' : `, ${d.getFullYear()}`}, ${fmtTime(d)}`;
  return `${base} (${ago(d, now)})`;
}

export function fmtQuoteHeader(d: Date, name: string, email: string): string {
  return `On ${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${fmtTime(d)} ${name} <${email}> wrote:`;
}

export function simulate(lib: Library, opts: SimOptions): Simulation {
  const seq = lib.sequences.find((s) => s.id === opts.sequenceId) ?? lib.sequences[0];
  const ctx: ResolveContext = { profile: opts.profile, variables: lib.variables };
  const fmt = lib.settings.bodyFormat;
  const prospect = { name: opts.profile?.recipientName || 'Prospect', email: opts.profile?.recipientEmail || 'prospect@example.com' };
  const us = lib.sender;
  const missing = new Set<string>();
  // Signatures keep their line breaks whatever the body format.
  const sigBlocks = (on: boolean) => (on && lib.signature.trim() ? renderBody(lib.signature, ctx, 'plain') : []);
  const noteMissing = (blocks: BlockNode[] | Inline[]) => {
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (o.t === 'var' && o.status === 'missing') missing.add(o.name as string);
      for (const v of Object.values(o)) if (Array.isArray(v)) v.forEach(walk);
    };
    (blocks as unknown[]).forEach(walk);
  };

  const conv: Conversation | undefined = opts.mode === 'conversation' ? lib.conversations.find((c) => c.id === opts.conversationId) : undefined;
  if (!seq) return { threads: [], stopped: [], now: new Date(), missing: [] };

  const times = stepTimes(seq, lib.settings.startAt);
  let index = Math.max(0, seq.steps.findIndex((s) => s.id === (conv ? conv.afterStepId : opts.stepId)));
  if (index < 0 || index >= seq.steps.length) index = 0;

  const threads = new Map<string, SimThread>();
  const order: SimMessage[] = [];

  const push = (threadKey: string, m: SimMessage) => {
    let th = threads.get(threadKey);
    if (!th) {
      th = { id: threadKey, subject: m.subject, subjectInl: m.subjectInl, messages: [] };
      threads.set(threadKey, th);
    }
    th.messages.push(m);
    order.push(m);
  };

  const quoteOf = (m: SimMessage | undefined): Quoted | undefined =>
    m ? { header: fmtQuoteHeader(m.time, m.fromName, m.fromEmail), blocks: m.blocks, quoted: m.quoted } : undefined;

  const stepMessage = (i: number): { key: string; msg: SimMessage } => {
    const st = seq.steps[i];
    const v = selectedVersion(st);
    const subj = stepSubjectRaw(seq, i);
    const key = seq.steps[subj.rootIndex].id;
    // Preview text (preheader) is no longer part of the studio: Gmail's snippet is the start of the body.
    const preview = '';
    const visibleBody = renderBody(v?.body ?? '', ctx, fmt);
    const sig = sigBlocks(st.includeSignature);
    const blocks = [...visibleBody, ...sig];
    const prev = threads.get(key)?.messages.slice(-1)[0];
    const subjectInl = renderInline(subj.text, ctx);
    noteMissing(blocks);
    noteMissing(subjectInl);
    const text = blocksText(blocks);
    return {
      key,
      msg: {
        id: `m_${st.id}`,
        from: 'us',
        fromName: us.name,
        fromEmail: us.email,
        toName: prospect.name,
        toEmail: prospect.email,
        time: times[i],
        subject: resolveText(subj.text, ctx),
        subjectInl,
        blocks,
        previewText: preview,
        snippet: collapseWhitespace(`${fmt === 'html' && preview.trim() ? `${preview} ` : ''}${text}`).slice(0, 200),
        bodyText: blocksText(visibleBody),
        quoted: subj.inherited && st.quotePrevious ? quoteOf(prev) : undefined,
        stepId: st.id,
        stepIndex: i,
        sample: false,
        label: `Step ${i + 1} · ${st.name}`,
      },
    };
  };

  const stopped: { index: number; name: string }[] = [];
  let lastStep = seq.steps.length - 1;
  if (opts.mode === 'message' || opts.mode === 'upto' || opts.mode === 'conversation') lastStep = index;

  // In single-message mode, earlier steps are still built (for quoting) but not shown.
  const hidden = new Set<string>();
  for (let i = 0; i <= lastStep; i += 1) {
    const { key, msg } = stepMessage(i);
    push(key, msg);
    if (opts.mode === 'message' && i < index) hidden.add(msg.id);
  }

  // The selected step is the focus in every mode, so "Whole sequence" opens the step being edited.
  let focus: SimMessage | undefined = order.find((m) => m.stepIndex === index) ?? order[order.length - 1];

  if (conv) {
    const afterMsg = order.find((m) => m.stepIndex === index)!;
    const key = seq.steps[threadRootIndex(seq, index)].id;
    let t = new Date(afterMsg.time.getTime() + lib.settings.replyAfterHours * 3600_000);
    let prev: SimMessage = afterMsg;
    conv.turns.forEach((turn, k) => {
      if (k > 0) t = new Date(t.getTime() + (turn.role === 'us' ? lib.settings.answerAfterHours : lib.settings.replyAfterHours) * 3600_000);
      const reply = turn.replyId ? lib.replies.find((r) => r.id === turn.replyId) : undefined;
      const source = turn.role === 'prospect' ? turn.text : turn.custom || !reply ? turn.text : reply.body;
      const bodyBlocks = renderBody(source, ctx, turn.role === 'prospect' ? 'plain' : fmt);
      const blocks = turn.role === 'us' ? [...bodyBlocks, ...sigBlocks(true)] : bodyBlocks;
      noteMissing(blocks);
      const subject = reSubject(threads.get(key)!.subject);
      const m: SimMessage = {
        id: `m_${turn.id}`,
        from: turn.role,
        fromName: turn.role === 'us' ? us.name : prospect.name,
        fromEmail: turn.role === 'us' ? us.email : prospect.email,
        toName: turn.role === 'us' ? prospect.name : us.name,
        toEmail: turn.role === 'us' ? prospect.email : us.email,
        time: t,
        subject,
        subjectInl: renderInline(subject, ctx),
        blocks,
        previewText: '',
        snippet: collapseWhitespace(blocksText(blocks)).slice(0, 200),
        bodyText: blocksText(bodyBlocks),
        quoted: quoteOf(prev),
        turnId: turn.id,
        sample: turn.sample,
        label: turn.role === 'prospect' ? `Prospect reply${turn.sample ? ' (sample)' : ''}` : `Our reply${reply ? ` · ${reply.title}` : ''}`,
      };
      push(key, m);
      prev = m;
      focus = m;
    });
    for (let i = index + 1; i < seq.steps.length; i += 1) {
      if (lib.settings.stopOnReply && conv.turns.length) stopped.push({ index: i, name: seq.steps[i].name });
      else {
        const { key: k2, msg } = stepMessage(i);
        push(k2, msg);
      }
    }
  }

  // Chronological order inside each thread; threads newest first.
  const list = [...threads.values()]
    .map((th) => {
      const messages = th.messages.filter((m) => !hidden.has(m.id)).sort((a, b) => a.time.getTime() - b.time.getTime());
      // The list shows the subject of the first message the inbox actually holds.
      return { ...th, messages, subject: messages[0]?.subject ?? th.subject, subjectInl: messages[0]?.subjectInl ?? th.subjectInl };
    })
    .filter((th) => th.messages.length)
    .sort((a, b) => b.messages[b.messages.length - 1].time.getTime() - a.messages[a.messages.length - 1].time.getTime());
  const latest = Math.max(...list.flatMap((th) => th.messages.map((m) => m.time.getTime())));
  const now = new Date(latest + 7 * 60_000);
  if (opts.mode === 'message' && focus) focus = list.flatMap((t) => t.messages).find((m) => m.id === focus!.id);
  const focusThread = list.find((th) => th.messages.some((m) => m.id === focus?.id));
  return { threads: list, focusMessageId: focus?.id, focusThreadId: focusThread?.id, stopped, now, missing: [...missing] };
}
