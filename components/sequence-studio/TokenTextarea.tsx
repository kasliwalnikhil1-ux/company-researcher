'use client';

// Textarea that highlights {{placeholders}} while you type (a mirror layer sits under a
// transparent-text textarea), and a read-only "personalized" view of the same text.

import { Fragment, useId, type ReactNode } from 'react';
import { segments, TOKEN_RE, type ResolveContext } from '@/lib/sequence-studio/variables';
import { cx } from './ui';

const TOKEN_CLASS = {
  sample: 'bg-indigo-100 text-indigo-900 rounded-sm',
  fallback: 'bg-amber-100 text-amber-900 rounded-sm',
  missing: 'bg-red-100 text-red-800 rounded-sm underline decoration-red-500 decoration-dashed underline-offset-2',
} as const;

const BOX = 'px-3 py-2 text-sm leading-6 whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-[inherit]';

function mirror(text: string, ctx: ResolveContext): ReactNode[] {
  return segments(text, ctx).map((s, i) =>
    s.type === 'text' ? <Fragment key={i}>{s.text}</Fragment> : <span key={i} className={TOKEN_CLASS[s.status]}>{s.raw}</span>,
  );
}

export function TokenTextarea({
  value,
  onChange,
  ctx,
  mode = 'raw',
  label,
  placeholder,
  singleLine,
  minRows = 3,
  className,
  tone = 'default',
}: {
  value: string;
  onChange: (v: string) => void;
  ctx: ResolveContext;
  mode?: 'raw' | 'personalized';
  label: string;
  placeholder?: string;
  singleLine?: boolean;
  minRows?: number;
  className?: string;
  tone?: 'default' | 'note';
}) {
  const id = useId();
  const minH = singleLine ? undefined : `${minRows * 1.5 + 1}rem`;
  const frame = cx(
    'relative rounded-lg border',
    tone === 'note' ? 'border-amber-300 bg-amber-50' : 'border-gray-300 bg-white',
    'focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500',
    className,
  );
  if (mode === 'personalized') {
    return (
      <div className={cx(frame, 'bg-gray-50')} aria-label={`${label} (personalized, read-only)`} role="textbox" aria-readonly>
        <div className={cx(BOX, 'text-gray-900')} style={{ minHeight: minH }}>
          {segments(value, ctx).map((s, i) =>
            s.type === 'text' ? (
              <Fragment key={i}>{s.text}</Fragment>
            ) : s.status === 'missing' ? (
              <span key={i} className={TOKEN_CLASS.missing} title={`No sample value or fallback for {{${s.name}}}`}>
                {s.raw}
              </span>
            ) : (
              <span key={i} className={TOKEN_CLASS[s.status]} title={`{{${s.name}}} — ${s.status === 'sample' ? 'sample value' : 'fallback'}`}>
                {s.value}
              </span>
            ),
          )}
          {!value && <span className="text-gray-400">{placeholder}</span>}
        </div>
      </div>
    );
  }
  return (
    <div className={frame}>
      <div aria-hidden className={cx(BOX, 'pointer-events-none text-gray-900')} style={{ minHeight: minH }}>
        {mirror(value, ctx)}
        {/* keeps the height right when the text ends with a newline */}
        {'​'}
      </div>
      <textarea
        id={id}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        spellCheck
        onChange={(e) => onChange(singleLine ? e.target.value.replace(/\r?\n/g, ' ') : e.target.value)}
        onKeyDown={(e) => {
          if (singleLine && e.key === 'Enter') e.preventDefault();
        }}
        className={cx(
          BOX,
          'absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-gray-900 outline-none placeholder:text-gray-400 selection:bg-indigo-300/40',
        )}
      />
    </div>
  );
}

export function hasTokens(text: string) {
  return new RegExp(TOKEN_RE.source).test(text);
}
