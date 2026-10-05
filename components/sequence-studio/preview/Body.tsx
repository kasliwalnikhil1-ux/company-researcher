'use client';

// Renders the recipient view of a message (BlockNode tree from emailText.ts). Missing
// placeholders stay visible as their raw {{token}}, marked, so nothing is silently invented.

import { Fragment, useState, type ReactNode } from 'react';
import type { BlockNode, Inline } from '@/lib/sequence-studio/emailText';
import type { Quoted } from '@/lib/sequence-studio/simulate';
import styles from './gmail.module.css';

export function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <Fragment key={i}>{n.text}</Fragment>;
          case 'var':
            return n.status === 'missing' ? (
              <span key={i} className={styles.missing} title={`Missing value for {{${n.name}}}`}>
                {n.raw}
              </span>
            ) : (
              <Fragment key={i}>{n.value}</Fragment>
            );
          case 'b':
            return (
              <b key={i}>
                <Inlines nodes={n.children} />
              </b>
            );
          case 'i':
            return (
              <i key={i}>
                <Inlines nodes={n.children} />
              </i>
            );
          case 'code':
            return <Fragment key={i}>{n.text}</Fragment>;
          case 'a':
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.preventDefault()} title={n.href}>
                <Inlines nodes={n.children} />
              </a>
            );
          case 'br':
            return <br key={i} />;
        }
      })}
    </>
  );
}

export function Blocks({ blocks }: { blocks: BlockNode[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'p':
            return (
              <p key={i}>
                <Inlines nodes={b.inl} />
              </p>
            );
          case 'h':
            return (
              <h4 key={i}>
                <Inlines nodes={b.inl} />
              </h4>
            );
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, k) => (
                  <li key={k}>
                    <Inlines nodes={it} />
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={b.start}>
                {b.items.map((it, k) => (
                  <li key={k}>
                    <Inlines nodes={it} />
                  </li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={i} className={styles.quoteBlock}>
                <Blocks blocks={b.blocks} />
              </blockquote>
            );
          case 'hr':
            return <hr key={i} />;
        }
      })}
    </>
  );
}

function QuotedView({ q }: { q: Quoted }) {
  return (
    <div className={styles.quoted}>
      <p className={styles.quoteHeader}>{q.header}</p>
      <blockquote className={styles.quoteBlock}>
        <Blocks blocks={q.blocks} />
        {q.quoted && <QuotedView q={q.quoted} />}
      </blockquote>
    </div>
  );
}

/** Message body + Gmail's "•••" trimmed-content toggle for the quoted part. */
export function MessageBody({ blocks, quoted, className, measure, extra }: { blocks: BlockNode[]; quoted?: Quoted; className: string; measure?: boolean; extra?: ReactNode }) {
  const [showQuote, setShowQuote] = useState(false);
  return (
    <div className={className}>
      <div data-m={measure ? 'body' : undefined}>
        <Blocks blocks={blocks} />
      </div>
      {quoted && (
        <>
          <button type="button" className={styles.trim} aria-label={showQuote ? 'Hide trimmed content' : 'Show trimmed content'} title="Show trimmed content" onClick={() => setShowQuote((s) => !s)}>
            <i />
            <i />
            <i />
          </button>
          {showQuote && <QuotedView q={quoted} />}
        </>
      )}
      {extra}
    </div>
  );
}
