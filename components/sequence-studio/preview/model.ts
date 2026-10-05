// Inbox rows for the simulator: our simulated threads mixed with fictional ordinary mail,
// seen from the selected perspective (the prospect's inbox or ours).

import type { Perspective, SimMessage, SimThread, Simulation } from '@/lib/sequence-studio/simulate';
import { RECIPIENT_FILLER, SENDER_FILLER } from '@/lib/sequence-studio/samples';

export interface InboxRow {
  key: string;
  threadId?: string;
  ours: boolean;
  names: { text: string; bold: boolean }[];
  count: number;
  subject: string;
  snippet: string;
  date: Date;
  unread: boolean;
  starred: boolean;
  attachment?: string;
  focus: boolean;
  avatarName: string;
}

export function isMine(m: SimMessage, perspective: Perspective) {
  return perspective === 'recipient' ? m.from === 'prospect' : m.from === 'us';
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

export function threadNames(th: SimThread, perspective: Perspective, unread: boolean) {
  const seen: { name: string; mine: boolean }[] = [];
  for (const m of th.messages) {
    const mine = isMine(m, perspective);
    const name = mine ? 'me' : m.fromName;
    if (!seen.some((s) => s.name === name)) seen.push({ name, mine });
  }
  if (seen.length === 1) return [{ text: seen[0].name, bold: unread && !seen[0].mine }];
  return seen.map((s, i) => ({ text: (s.mine ? 'me' : first(s.name)) + (i < seen.length - 1 ? ', ' : ''), bold: unread && !s.mine }));
}

export function buildRows(sim: Simulation, perspective: Perspective, opts: { recipientName: string }): { rows: InboxRow[]; folder: 'Inbox' | 'Sent'; unreadCount: number } {
  const incoming = sim.threads.filter((th) => th.messages.some((m) => !isMine(m, perspective)));
  const folder: 'Inbox' | 'Sent' = incoming.length ? 'Inbox' : 'Sent';
  const shown = folder === 'Inbox' ? incoming : sim.threads;
  const rows: InboxRow[] = shown.map((th) => {
    const last = th.messages[th.messages.length - 1];
    const unread = folder === 'Inbox' && !isMine(last, perspective);
    const other = [...th.messages].reverse().find((m) => !isMine(m, perspective));
    return {
      key: th.id,
      threadId: th.id,
      ours: true,
      names: folder === 'Sent' ? [{ text: `To: ${opts.recipientName}`, bold: false }] : threadNames(th, perspective, unread),
      count: th.messages.length,
      subject: th.subject,
      snippet: last.snippet,
      date: last.time,
      unread,
      starred: false,
      focus: th.id === sim.focusThreadId,
      avatarName: other?.fromName ?? (folder === 'Sent' ? opts.recipientName : last.fromName),
    };
  });
  if (folder === 'Inbox') {
    const filler = perspective === 'recipient' ? RECIPIENT_FILLER : SENDER_FILLER;
    for (const [i, f] of filler.entries()) {
      rows.push({
        key: `filler-${i}`,
        ours: false,
        names: [{ text: f.fromName, bold: f.unread }],
        count: 1,
        subject: f.subject,
        snippet: f.snippet,
        date: new Date(sim.now.getTime() - f.minutesAgo * 60_000),
        unread: f.unread,
        starred: !!f.starred,
        attachment: f.attachment,
        focus: false,
        avatarName: f.fromName,
      });
    }
  }
  rows.sort((a, b) => b.date.getTime() - a.date.getTime());
  return { rows, folder, unreadCount: rows.filter((r) => r.unread).length };
}

/** Which messages start expanded when a thread opens: the focus message, unread incoming
 *  messages and the latest one. */
export function initialExpanded(th: SimThread, focusId: string | undefined, perspective: Perspective): Set<string> {
  // The message being edited is the one open; the rest collapse like older messages do in Gmail.
  if (focusId && th.messages.some((m) => m.id === focusId)) return new Set([focusId]);
  const out = new Set<string>();
  const last = th.messages[th.messages.length - 1];
  if (last) out.add(last.id);
  if (focusId) out.add(focusId);
  if (!isMine(last, perspective)) for (const m of th.messages) if (!isMine(m, perspective) && m.time >= last.time) out.add(m.id);
  return out;
}

/** Thread items with Gmail's "N older messages" collapse when several are hidden in a row. */
export type ThreadItem = { kind: 'msg'; msg: SimMessage; expanded: boolean } | { kind: 'older'; count: number };

export function threadItems(th: SimThread, expanded: Set<string>, showAll: boolean): ThreadItem[] {
  const items: ThreadItem[] = th.messages.map((msg) => ({ kind: 'msg', msg, expanded: expanded.has(msg.id) }));
  if (showAll) return items;
  // Collapse runs of more than 3 collapsed messages after the first one.
  const out: ThreadItem[] = [];
  let run: ThreadItem[] = [];
  const flush = () => {
    if (run.length > 3) {
      out.push(run[0], { kind: 'older', count: run.length - 2 }, run[run.length - 1]);
    } else out.push(...run);
    run = [];
  };
  items.forEach((it) => {
    if (it.kind === 'msg' && !it.expanded) run.push(it);
    else {
      flush();
      out.push(it);
    }
  });
  flush();
  return out;
}
