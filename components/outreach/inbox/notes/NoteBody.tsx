'use client';

// Private-note body renderer (private-notes-PRD.md §4.2, §5): a markdown subset — bold, italic, inline code, links,
// bullet / numbered lists, line breaks — plus @mention chips. Everything becomes React nodes; no HTML is ever injected.
import React from 'react';
import { cn } from '@/lib/utils';
import { MENTION_TOKEN_RE } from '@/lib/outreach/notes';

const INLINE_RE = new RegExp(
  [
    MENTION_TOKEN_RE.source,                                   // 1 name, 2 user id
    '(`[^`\\n]+`)',                                             // 3 code
    '(\\*\\*[^*\\n]+?\\*\\*)',                                  // 4 bold
    '(?<![\\w*])(\\*[^*\\s](?:[^*\\n]*?[^*\\s])?\\*)(?![\\w*])', // 5 bold (single star)
    '(?<![\\w_])(_[^_\\s](?:[^_\\n]*?[^_\\s])?_)(?![\\w_])',    // 6 italic
    '(\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^)\\s]+\\))',            // 7 markdown link
    '(https?:\\/\\/[^\\s<]+[^\\s<.,:;"\')\\]!?])',              // 8 bare url
  ].join('|'),
  'g',
);

export interface NoteBodyProps {
  text: string;
  /** the signed-in user's id: their own mention chip is highlighted more strongly */
  currentUserId?: string | null;
  /** mention user ids that can no longer read the conversation (chip without emphasis + tooltip) */
  noAccess?: Set<string>;
  className?: string;
}

function Inline({ text, currentUserId, noAccess }: { text: string; currentUserId?: string | null; noAccess?: Set<string> }): React.ReactElement {
  const out: React.ReactNode[] = [];
  let last = 0, k = 0;
  for (const mt of text.matchAll(INLINE_RE)) {
    const [whole, mName, mId, code, bold2, bold, italic, mdLink, url] = mt;
    const at = mt.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = k++;
    if (mName && mId) {
      const me = !!currentUserId && mId === currentUserId;
      const gone = noAccess?.has(mId);
      out.push(
        <span key={key} title={gone ? `${mName} can no longer see this conversation` : undefined}
          className={cn('inline-flex items-center rounded px-1 py-px text-[0.92em] font-medium align-baseline',
            me ? 'bg-amber-300/70 text-amber-950 ring-1 ring-amber-400' : gone ? 'bg-gray-100 text-gray-500 line-through decoration-gray-400' : 'bg-amber-100 text-amber-900')}>
          @{mName}
        </span>,
      );
    } else if (code) out.push(<code key={key} className="font-mono text-[0.9em] rounded px-1 bg-black/[0.06]">{code.slice(1, -1)}</code>);
    else if (bold2) out.push(<strong key={key}><Inline text={bold2.slice(2, -2)} currentUserId={currentUserId} noAccess={noAccess} /></strong>);
    else if (bold) out.push(<strong key={key}><Inline text={bold.slice(1, -1)} currentUserId={currentUserId} noAccess={noAccess} /></strong>);
    else if (italic) out.push(<em key={key}><Inline text={italic.slice(1, -1)} currentUserId={currentUserId} noAccess={noAccess} /></em>);
    else if (mdLink) {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(mdLink);
      if (m) out.push(<a key={key} href={m[2]} target="_blank" rel="noopener noreferrer" className="underline text-sky-800 hover:text-sky-900 break-all">{m[1]}</a>);
      else out.push(whole);
    } else if (url) out.push(<a key={key} href={url} target="_blank" rel="noopener noreferrer" className="underline text-sky-800 hover:text-sky-900 break-all">{url}</a>);
    else out.push(whole);
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] };

function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (ul && !/^\s*\*[^*\s].*\*\s*$/.test(line)) { if (last?.kind === 'ul') last.items.push(ul[1]); else blocks.push({ kind: 'ul', items: [ul[1]] }); continue; }
    if (ol) { if (last?.kind === 'ol') last.items.push(ol[1]); else blocks.push({ kind: 'ol', items: [ol[1]] }); continue; }
    if (!line.trim()) { if (last?.kind === 'p' && last.lines.length) blocks.push({ kind: 'p', lines: [] }); continue; }
    if (last?.kind === 'p') last.lines.push(line); else blocks.push({ kind: 'p', lines: [line] });
  }
  return blocks.filter((b) => (b.kind === 'p' ? b.lines.length > 0 : b.items.length > 0));
}

export default function NoteBody({ text, currentUserId, noAccess, className }: NoteBodyProps) {
  const blocks = React.useMemo(() => blocksOf(text), [text]);
  return (
    <div className={cn('text-sm leading-relaxed text-gray-900 break-words [overflow-wrap:anywhere] space-y-1.5', className)}>
      {blocks.map((b, i) => {
        if (b.kind === 'p') {
          return (
            <p key={i}>
              {b.lines.map((l, j) => (
                <React.Fragment key={j}>{j > 0 && <br />}<Inline text={l} currentUserId={currentUserId} noAccess={noAccess} /></React.Fragment>
              ))}
            </p>
          );
        }
        const Tag = b.kind === 'ul' ? 'ul' : 'ol';
        return (
          <Tag key={i} className={cn('pl-5 space-y-0.5', b.kind === 'ul' ? 'list-disc' : 'list-decimal')}>
            {b.items.map((it, j) => <li key={j}><Inline text={it} currentUserId={currentUserId} noAccess={noAccess} /></li>)}
          </Tag>
        );
      })}
    </div>
  );
}

/** One-line preview of a note body (chips flattened, markdown markers dropped). */
export function notePreview(body: string | null | undefined, max = 140): string {
  const s = (body ?? '').replace(MENTION_TOKEN_RE, '@$1').replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
