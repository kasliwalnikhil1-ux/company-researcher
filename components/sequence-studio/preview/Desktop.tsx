'use client';

// Desktop Gmail-style inbox and opened conversation (GM3 web layout: 64px header, 256px nav,
// rounded white list card, side panel). `data-m` / `data-clip` attributes mark the elements the
// measurement code reads; they never change layout.

import { useState } from 'react';
import type { Perspective, SimMessage, SimThread } from '@/lib/sequence-studio/simulate';
import { fmtHeaderDate, fmtListDate } from '@/lib/sequence-studio/simulate';
import type { Density } from '../store';
import { MessageBody } from './Body';
import { avatarColor, GIcon, initial } from './icons';
import { initialExpanded, isMine, threadItems, type InboxRow } from './model';
import styles from './gmail.module.css';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function useExpansion(thread: SimThread | undefined, focusId: string | undefined, perspective: Perspective) {
  // Expansion state belongs to one thread/focus; a new key starts from Gmail's defaults again.
  const key = `${thread?.id}|${focusId}|${thread?.messages.length}|${perspective}`;
  const [state, setState] = useState<{ key: string; expanded: Set<string>; showAll: boolean } | null>(null);
  const current = state?.key === key ? state : { key, expanded: thread ? initialExpanded(thread, focusId, perspective) : new Set<string>(), showAll: false };
  const toggle = (id: string) => {
    const n = new Set(current.expanded);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setState({ ...current, expanded: n });
  };
  const setShowAll = (v: boolean) => setState({ ...current, showAll: v });
  return { expanded: current.expanded, toggle, showAll: current.showAll, setShowAll };
}

/** The Gmail "M" mark (2020 logo), so the local simulator reads like the real inbox. */
function GmailLogo() {
  return (
    <svg viewBox="52 42 88 66" width={40} height={30} aria-label="Gmail" role="img" style={{ flex: 'none' }}>
      <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
      <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
      <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
      <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
      <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
    </svg>
  );
}

function Header({ meName }: { meName: string }) {
  return (
    <div className={styles.dHeader}>
      <span className={styles.dIconBtn}>
        <GIcon name="menu" size={24} />
      </span>
      <span className={styles.logo}>
        <GmailLogo />
        <span>Gmail</span>
      </span>
      <div className={styles.search}>
        <span className={styles.dIconBtnSm}>
          <GIcon name="search" size={24} />
        </span>
        <span>Search mail</span>
        <span className={styles.dIconBtnSm}>
          <GIcon name="tune" size={24} />
        </span>
      </div>
      <div className={styles.headerRight}>
        <span className={styles.dIconBtnSm}>
          <GIcon name="help" size={24} />
        </span>
        <span className={styles.dIconBtnSm}>
          <GIcon name="settings" size={24} />
        </span>
        <span className={styles.dIconBtnSm}>
          <GIcon name="apps" size={24} />
        </span>
        <span className={styles.avatarSm} style={{ background: avatarColor(meName) }}>
          {initial(meName)}
        </span>
      </div>
    </div>
  );
}

function Nav({ folder, unread }: { folder: 'Inbox' | 'Sent'; unread: number }) {
  const items: { icon: Parameters<typeof GIcon>[0]['name']; label: string; count?: number }[] = [
    { icon: 'inbox', label: 'Inbox', count: unread },
    { icon: 'starOutline', label: 'Starred' },
    { icon: 'clock', label: 'Snoozed' },
    { icon: 'send', label: 'Sent' },
    { icon: 'file', label: 'Drafts' },
  ];
  return (
    <nav className={styles.nav}>
      <span className={styles.compose}>
        <GIcon name="edit" size={24} />
        Compose
      </span>
      {items.map((it) => (
        <div key={it.label} className={cx(styles.navItem, folder === it.label && styles.navItemActive)}>
          <GIcon name={it.icon} size={20} />
          <span>{it.label}</span>
          {it.count ? <span className={styles.navCount}>{it.count}</span> : null}
        </div>
      ))}
    </nav>
  );
}

function SidePanel() {
  return (
    <div className={styles.sidePanel} aria-hidden>
      <span className={styles.sideDot} style={{ background: '#4285f4' }} />
      <span className={styles.sideDot} style={{ background: '#fbbc04' }} />
      <span className={styles.sideDot} style={{ background: '#1e8e3e' }} />
      <span className={styles.sideDot} style={{ background: '#5f6368', opacity: 0.4 }} />
    </div>
  );
}

function Row({ r, density, now, markOurs, onOpen }: { r: InboxRow; density: Density; now: Date; markOurs: boolean; onOpen: (id: string) => void }) {
  const chips = density === 'default' && !!r.attachment;
  return (
    <div
      className={cx(styles.row, r.unread && styles.rowUnread, density === 'compact' && styles.rowCompact, r.ours && styles.rowClickable)}
      onClick={r.ours && r.threadId ? () => onOpen(r.threadId!) : undefined}
      data-focus-row={r.focus || undefined}
      title={r.ours ? 'Open this conversation' : undefined}
    >
      {markOurs && r.ours && <span className={styles.ourMark} title="Simulator marker: this is the outreach being previewed (not part of Gmail)" />}
      <div className={styles.rowInner}>
        <div className={styles.rowLead}>
          <span className={styles.checkbox} />
          <GIcon name={r.starred ? 'star' : 'starOutline'} size={20} style={r.starred ? { color: '#f4b400' } : undefined} />
        </div>
        <div className={styles.rowSender}>
          {r.names.map((n, i) => (
            <span key={i} style={{ fontWeight: n.bold ? 700 : 400 }}>
              {n.text}
            </span>
          ))}
          {r.count > 1 && <span className={styles.count}>{r.count}</span>}
        </div>
        <div className={styles.rowLine} data-clip={r.focus ? 'row' : undefined}>
          <span className={styles.rowSubject} data-m={r.focus ? 'subject' : undefined}>
            {r.subject}
          </span>
          <span className={styles.rowSnippet}>
            {' - '}
            <span data-m={r.focus ? 'snippet' : undefined}>{r.snippet}</span>
          </span>
        </div>
        {!!r.attachment && density !== 'default' && <GIcon name="attach" size={18} style={{ color: '#5f6368', marginLeft: 8 }} />}
        <div className={styles.rowDate}>{fmtListDate(r.date, now)}</div>
      </div>
      {chips && (
        <div className={styles.chipRow}>
          <span className={styles.chip}>
            <span className={styles.chipIcon} />
            {r.attachment}
          </span>
        </div>
      )}
    </div>
  );
}

export function DesktopInbox({
  rows,
  folder,
  unreadCount,
  density,
  now,
  meName,
  markOurs,
  onOpen,
}: {
  rows: InboxRow[];
  folder: 'Inbox' | 'Sent';
  unreadCount: number;
  density: Density;
  now: Date;
  meName: string;
  markOurs: boolean;
  onOpen: (threadId: string) => void;
}) {
  return (
    <>
      <Header meName={meName} />
      <div className={styles.dBody}>
        <Nav folder={folder} unread={unreadCount} />
        <div className={styles.card}>
          <div className={styles.toolbar}>
            <span className={styles.dIconBtnSm}>
              <span className={styles.checkbox} />
            </span>
            <GIcon name="dropdown" size={18} />
            <span className={styles.dIconBtnSm}>
              <GIcon name="refresh" />
            </span>
            <span className={styles.dIconBtnSm}>
              <GIcon name="more" />
            </span>
            <div className={styles.toolbarRight}>
              <span style={{ marginRight: 12 }}>1–{Math.min(50, rows.length)} of {folder === 'Inbox' ? '2,431' : rows.length}</span>
              <span className={styles.dIconBtnSm} style={{ opacity: 0.4 }}>
                <GIcon name="left" />
              </span>
              <span className={styles.dIconBtnSm}>
                <GIcon name="right" />
              </span>
            </div>
          </div>
          {folder === 'Inbox' && (
            <div className={styles.tabs}>
              <div className={cx(styles.tab, styles.tabActive)}>
                <GIcon name="inbox" />
                Primary
              </div>
              <div className={styles.tab}>
                <GIcon name="tag" />
                Promotions
              </div>
              <div className={styles.tab}>
                <GIcon name="people" />
                Social
              </div>
            </div>
          )}
          <div className={styles.scroller} data-m="viewport">
            {rows.map((r) => (
              <Row key={r.key} r={r} density={density} now={now} markOurs={markOurs} onOpen={onOpen} />
            ))}
          </div>
        </div>
        <SidePanel />
      </div>
    </>
  );
}

function toLabel(m: SimMessage, perspective: Perspective) {
  const toMe = perspective === 'recipient' ? m.from === 'us' : m.from === 'prospect';
  return toMe ? 'me' : m.toName.split(/\s+/)[0];
}

function Expanded({ m, now, perspective, focus }: { m: SimMessage; now: Date; perspective: Perspective; focus: boolean }) {
  return (
    <div className={styles.msg}>
      <div className={styles.msgAvatarCol}>
        <span className={styles.avatar} style={{ background: avatarColor(m.fromName) }}>
          {initial(m.fromName)}
        </span>
      </div>
      <div className={styles.msgMain}>
        <div className={styles.msgHead}>
          <div className={styles.msgFrom}>
            <span className={styles.msgName}>{m.fromName}</span>
            <span className={styles.msgEmail}>&lt;{m.fromEmail}&gt;</span>
            <div className={styles.msgTo}>
              to {toLabel(m, perspective)} <GIcon name="dropdown" size={16} />
            </div>
          </div>
          <div className={styles.msgMeta}>
            <span>{fmtHeaderDate(m.time, now)}</span>
            <span className={styles.dIconBtnSm} style={{ width: 32, height: 32 }}>
              <GIcon name="starOutline" />
            </span>
            <span className={styles.dIconBtnSm} style={{ width: 32, height: 32 }}>
              <GIcon name="mood" />
            </span>
            <span className={styles.dIconBtnSm} style={{ width: 32, height: 32 }}>
              <GIcon name="reply" />
            </span>
            <span className={styles.dIconBtnSm} style={{ width: 32, height: 32 }}>
              <GIcon name="more" />
            </span>
          </div>
        </div>
        <MessageBody blocks={m.blocks} quoted={m.quoted} className={styles.body} measure={focus} />
      </div>
    </div>
  );
}

export function DesktopThread({
  thread,
  focusId,
  perspective,
  now,
  meName,
  folder,
  draft,
  stoppedNote,
  onBack,
}: {
  thread?: SimThread;
  focusId?: string;
  perspective: Perspective;
  now: Date;
  meName: string;
  folder: 'Inbox' | 'Sent';
  draft?: SimMessage;
  stoppedNote?: string;
  onBack: () => void;
}) {
  const { expanded, toggle, showAll, setShowAll } = useExpansion(thread, focusId, perspective);
  const items = thread ? threadItems(thread, expanded, showAll) : [];
  return (
    <>
      <Header meName={meName} />
      <div className={styles.dBody}>
        <Nav folder={folder} unread={0} />
        <div className={styles.card}>
          <div className={styles.toolbar}>
            <button type="button" className={styles.dIconBtnSm} onClick={onBack} aria-label="Back to inbox" style={{ background: 'none', border: 0, cursor: 'pointer' }}>
              <GIcon name="back" />
            </button>
            <span className={styles.dIconBtnSm} style={{ marginLeft: 16 }}>
              <GIcon name="archive" />
            </span>
            <span className={styles.dIconBtnSm}>
              <GIcon name="spam" />
            </span>
            <span className={styles.dIconBtnSm}>
              <GIcon name="delete" />
            </span>
            <span className={styles.dIconBtnSm} style={{ marginLeft: 16 }}>
              <GIcon name="mail" />
            </span>
            <span className={styles.dIconBtnSm}>
              <GIcon name="clock" />
            </span>
            <span className={styles.dIconBtnSm} style={{ marginLeft: 16 }}>
              <GIcon name="label" />
            </span>
            <span className={styles.dIconBtnSm}>
              <GIcon name="more" />
            </span>
            <div className={styles.toolbarRight}>
              <span style={{ marginRight: 12 }}>1 of 2,431</span>
              <span className={styles.dIconBtnSm} style={{ opacity: 0.4 }}>
                <GIcon name="left" />
              </span>
              <span className={styles.dIconBtnSm}>
                <GIcon name="right" />
              </span>
            </div>
          </div>
          <div className={styles.scroller} data-m="viewport">
            {!thread ? (
              <div style={{ padding: 40, color: '#5e5e5e', fontSize: 14 }}>No message to show.</div>
            ) : (
              <div className={styles.threadPad}>
                <div className={styles.subjectRow}>
                  <h2 className={styles.subject} style={{ flex: 1 }}>
                    <span data-m="open-subject">{thread.subject}</span>
                    {folder === 'Inbox' && <span className={styles.labelChip}>Inbox ×</span>}
                  </h2>
                  <span className={styles.dIconBtnSm}>
                    <GIcon name="print" />
                  </span>
                  <span className={styles.dIconBtnSm}>
                    <GIcon name="openNew" />
                  </span>
                </div>
                {items.map((it, i) =>
                  it.kind === 'older' ? (
                    <div key={`older-${i}`} className={styles.olderRow} onClick={() => setShowAll(true)} role="button" aria-label={`Show ${it.count} older messages`}>
                      <span className={styles.olderCircle}>{it.count}</span>
                    </div>
                  ) : it.expanded ? (
                    <div key={it.msg.id} data-msg={it.msg.id} onDoubleClick={() => toggle(it.msg.id)}>
                      <Expanded m={it.msg} now={now} perspective={perspective} focus={it.msg.id === focusId && !draft} />
                    </div>
                  ) : (
                    <div key={it.msg.id} data-msg={it.msg.id} className={styles.collapsed} onClick={() => toggle(it.msg.id)} role="button" aria-label={`Expand message from ${it.msg.fromName}`}>
                      <div className={styles.msgAvatarCol}>
                        <span className={styles.avatar} style={{ background: avatarColor(it.msg.fromName) }}>
                          {initial(it.msg.fromName)}
                        </span>
                      </div>
                      <span className={styles.collapsedName}>{isMine(it.msg, perspective) ? 'me' : it.msg.fromName}</span>
                      <span className={styles.collapsedSnippet}>{it.msg.snippet}</span>
                      <span style={{ fontSize: 12, color: '#5e5e5e', whiteSpace: 'nowrap' }}>{fmtListDate(it.msg.time, now)}</span>
                    </div>
                  ),
                )}
                {stoppedNote && <div className={styles.stoppedNote}>{stoppedNote}</div>}
                {draft ? (
                  <div className={styles.composer}>
                    <div className={styles.composerHead}>
                      <GIcon name="reply" />
                      <GIcon name="dropdown" size={16} />
                      <span className={styles.composerChip}>{draft.toName}</span>
                    </div>
                    <MessageBody blocks={draft.blocks} quoted={draft.quoted} className={cx(styles.body, styles.composerBody)} measure />
                    <div className={styles.composerFoot}>
                      <span className={styles.send}>Send</span>
                      <GIcon name="format" />
                      <GIcon name="attach" />
                      <GIcon name="mood" />
                      <span style={{ marginLeft: 'auto' }}>
                        <GIcon name="delete" />
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className={styles.replyBar}>
                    <span className={styles.pill}>
                      <GIcon name="reply" />
                      Reply
                    </span>
                    <span className={styles.pill}>
                      <GIcon name="forward" />
                      Forward
                    </span>
                    <span className={cx(styles.pill, styles.pillRound)}>
                      <GIcon name="mood" />
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <SidePanel />
      </div>
    </>
  );
}
