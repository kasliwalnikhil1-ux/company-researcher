'use client';

// Gmail mobile app (Material 3) inbox and conversation. Rows are three lines: sender + time,
// subject, snippet (1 line by default; 2 selectable because some app versions/settings show more).

import type { Perspective, SimMessage, SimThread } from '@/lib/sequence-studio/simulate';
import { fmtListDate } from '@/lib/sequence-studio/simulate';
import { MessageBody } from './Body';
import { useExpansion } from './Desktop';
import { avatarColor, GIcon, initial } from './icons';
import { isMine, threadItems, type InboxRow } from './model';
import styles from './gmail.module.css';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export interface MobileChrome {
  platform: 'ios' | 'android';
  statusHeight: number;
  navHeight: number;
}

function StatusBar({ chrome }: { chrome: MobileChrome }) {
  return (
    <div className={styles.mStatus} style={{ height: chrome.statusHeight, fontSize: chrome.platform === 'ios' ? 15 : 13 }}>
      <span>9:41</span>
      <span className={styles.mStatusIcons}>
        <i style={{ width: 14 }} />
        <i style={{ width: 12 }} />
        <i style={{ width: 22, borderRadius: 3 }} />
      </span>
    </div>
  );
}

export function MobileInbox({
  rows,
  folder,
  now,
  meName,
  markOurs,
  snippetLines,
  chrome,
  onOpen,
}: {
  rows: InboxRow[];
  folder: 'Inbox' | 'Sent';
  now: Date;
  meName: string;
  markOurs: boolean;
  snippetLines: 1 | 2;
  chrome: MobileChrome;
  onOpen: (threadId: string) => void;
}) {
  return (
    <div className={styles.mRoot}>
      <StatusBar chrome={chrome} />
      <div className={styles.mSearch}>
        <GIcon name="menu" size={24} />
        <span className={styles.mSearchText}>Search in mail</span>
        <span className={styles.avatarSm} style={{ background: avatarColor(meName), margin: 0 }}>
          {initial(meName)}
        </span>
      </div>
      <div className={styles.mLabel}>{folder === 'Inbox' ? 'Primary' : 'Sent'}</div>
      <div className={styles.scroller} data-m="viewport" style={{ position: 'relative' }}>
        {rows.map((r) => (
          <div
            key={r.key}
            className={cx(styles.mRow, r.unread && styles.mUnread)}
            onClick={r.ours && r.threadId ? () => onOpen(r.threadId!) : undefined}
            style={{ cursor: r.ours ? 'pointer' : 'default' }}
            data-focus-row={r.focus || undefined}
          >
            {markOurs && r.ours && <span className={styles.ourMark} title="Simulator marker: the outreach being previewed" />}
            <span className={styles.avatar} style={{ background: avatarColor(r.avatarName) }}>
              {initial(r.avatarName)}
            </span>
            <div className={styles.mRowMain}>
              <div className={styles.mLine1}>
                <span className={styles.mSender}>
                  {r.names.map((n) => n.text).join('')}
                  {r.count > 1 && <span className={styles.count}>{r.count}</span>}
                </span>
                <span className={styles.mTime}>{fmtListDate(r.date, now)}</span>
              </div>
              <div className={styles.mSubject} data-clip={r.focus ? 'subject' : undefined}>
                <span data-m={r.focus ? 'subject' : undefined}>{r.subject}</span>
              </div>
              <div className={styles.mLine3}>
                <div className={styles.mSnippet} style={{ WebkitLineClamp: snippetLines }} data-clip={r.focus ? 'snippet' : undefined}>
                  <span data-m={r.focus ? 'snippet' : undefined}>{r.snippet}</span>
                </div>
                <span className={styles.mStar}>
                  <GIcon name={r.starred ? 'star' : 'starOutline'} size={22} style={r.starred ? { color: '#f4b400' } : undefined} />
                </span>
              </div>
            </div>
          </div>
        ))}
        <div style={{ height: 96 }} />
      </div>
      <span className={styles.mFab} style={{ bottom: chrome.navHeight + 16 }}>
        <GIcon name="edit" size={24} />
        Compose
      </span>
      <div className={styles.mNav} style={{ height: chrome.navHeight }}>
        <span className={cx(styles.mNavItem, styles.mNavActive)}>
          <span className={styles.mNavPill}>
            <GIcon name="mail" size={24} />
          </span>
          Mail
        </span>
        <span className={styles.mNavItem}>
          <span className={styles.mNavPill}>
            <GIcon name="video" size={24} />
          </span>
          Meet
        </span>
      </div>
    </div>
  );
}

function toLabel(m: SimMessage, perspective: Perspective) {
  const toMe = perspective === 'recipient' ? m.from === 'us' : m.from === 'prospect';
  return toMe ? 'me' : m.toName.split(/\s+/)[0];
}

export function MobileThread({
  thread,
  focusId,
  perspective,
  now,
  folder,
  draft,
  stoppedNote,
  chrome,
  onBack,
}: {
  thread?: SimThread;
  focusId?: string;
  perspective: Perspective;
  now: Date;
  folder: 'Inbox' | 'Sent';
  draft?: SimMessage;
  stoppedNote?: string;
  chrome: MobileChrome;
  onBack: () => void;
}) {
  const { expanded, toggle, showAll, setShowAll } = useExpansion(thread, focusId, perspective);
  const items = thread ? threadItems(thread, expanded, showAll) : [];
  return (
    <div className={styles.mRoot}>
      <StatusBar chrome={chrome} />
      <div className={styles.mTopBar}>
        <button type="button" className={styles.dIconBtn} onClick={onBack} aria-label="Back to inbox" style={{ background: 'none', border: 0, cursor: 'pointer' }}>
          <GIcon name="back" size={24} />
        </button>
        <span style={{ marginLeft: 'auto' }} className={styles.dIconBtn}>
          <GIcon name="archive" size={24} />
        </span>
        <span className={styles.dIconBtn}>
          <GIcon name="delete" size={24} />
        </span>
        <span className={styles.dIconBtn}>
          <GIcon name="mail" size={24} />
        </span>
        <span className={styles.dIconBtn}>
          <GIcon name="more" size={24} />
        </span>
      </div>
      <div className={styles.scroller} data-m="viewport">
        {thread && (
          <>
            <div className={styles.mSubjectBlock}>
              <h2 className={styles.mSubjectText}>
                <span data-m="open-subject">{thread.subject}</span>
                {folder === 'Inbox' && <span className={styles.labelChip}>Inbox</span>}
              </h2>
              <span style={{ color: '#747775', paddingTop: 2 }}>
                <GIcon name="starOutline" size={24} />
              </span>
            </div>
            {items.map((it, i) =>
              it.kind === 'older' ? (
                <div key={`older-${i}`} className={styles.olderRow} onClick={() => setShowAll(true)} role="button" aria-label={`Show ${it.count} older messages`}>
                  <span className={styles.olderCircle}>{it.count}</span>
                </div>
              ) : it.expanded ? (
                <div key={it.msg.id} data-msg={it.msg.id} className={styles.mMsg} style={{ borderTop: i ? '1px solid #eee' : undefined }}>
                  <div className={styles.mMsgHead} onClick={() => toggle(it.msg.id)}>
                    <span className={styles.avatar} style={{ background: avatarColor(it.msg.fromName) }}>
                      {initial(it.msg.fromName)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', minWidth: 0 }}>
                        <span className={styles.mMsgName}>{it.msg.fromName}</span>
                        <span className={styles.mMsgTime}>{fmtListDate(it.msg.time, now)}</span>
                      </div>
                      <div className={styles.mMsgTo}>
                        to {toLabel(it.msg, perspective)} <GIcon name="dropdown" size={18} />
                      </div>
                    </div>
                    <span style={{ color: '#444746' }}>
                      <GIcon name="reply" size={24} />
                    </span>
                    <span style={{ color: '#444746' }}>
                      <GIcon name="more" size={24} />
                    </span>
                  </div>
                  <MessageBody blocks={it.msg.blocks} quoted={it.msg.quoted} className={styles.mBody} measure={it.msg.id === focusId && !draft} />
                </div>
              ) : (
                <div key={it.msg.id} data-msg={it.msg.id} className={styles.mCollapsed} onClick={() => toggle(it.msg.id)} role="button" aria-label={`Expand message from ${it.msg.fromName}`}>
                  <span className={styles.avatar} style={{ background: avatarColor(it.msg.fromName) }}>
                    {initial(it.msg.fromName)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span className={styles.mMsgName} style={{ flex: 1 }}>
                        {isMine(it.msg, perspective) ? 'me' : it.msg.fromName}
                      </span>
                      <span className={styles.mMsgTime}>{fmtListDate(it.msg.time, now)}</span>
                    </div>
                    <div className={styles.mSubject} style={{ color: '#444746' }}>
                      {it.msg.snippet}
                    </div>
                  </div>
                </div>
              ),
            )}
            {stoppedNote && <div className={styles.stoppedNote} style={{ margin: 16 }}>{stoppedNote}</div>}
            {draft ? (
              <div className={styles.composer} style={{ margin: 12 }}>
                <div className={styles.composerHead}>
                  <GIcon name="reply" />
                  <span className={styles.composerChip}>{draft.toName}</span>
                  <span style={{ marginLeft: 'auto', color: '#0b57d0' }}>
                    <GIcon name="send" size={22} />
                  </span>
                </div>
                <MessageBody blocks={draft.blocks} quoted={draft.quoted} className={cx(styles.mBody, styles.composerBody)} measure />
              </div>
            ) : (
              <div className={styles.mReplyBar}>
                <span className={styles.mPill}>
                  <GIcon name="reply" />
                  Reply
                </span>
                <span className={styles.mPill}>
                  <GIcon name="forward" />
                  Forward
                </span>
                <span className={cx(styles.mPill)} style={{ width: 40, padding: 0, justifyContent: 'center' }}>
                  <GIcon name="mood" />
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
