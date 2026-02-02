'use client';

import { useRef, useEffect, useCallback } from 'react';

const ROW_HEIGHT = 24;

interface AutoResizeTextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  minRows?: number;
}

export function AutoResizeTextarea({
  value,
  onChange,
  minRows = 2,
  className = '',
  ...rest
}: AutoResizeTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const minHeight = ROW_HEIGHT * minRows;

  const adjust = useCallback(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${Math.max(ref.current.scrollHeight, minHeight)}px`;
    }
  }, [minHeight]);

  useEffect(() => {
    adjust();
  }, [value, adjust]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`;
  };

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={handleChange}
      rows={minRows}
      className={className}
      style={{ overflow: 'hidden', resize: 'none' }}
      {...rest}
    />
  );
}
