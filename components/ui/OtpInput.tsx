'use client';

import { useEffect, useRef } from 'react';

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Called once the full code has been entered (typed or pasted). */
  onComplete?: (value: string) => void;
  className?: string;
}

/**
 * Six-box one-time-code input for authenticator codes. Digits only, auto-advances,
 * backspace steps back, and a pasted code fills every box at once.
 */
export function OtpInput({
  value,
  onChange,
  length = 6,
  disabled = false,
  autoFocus = false,
  onComplete,
  className = '',
}: OtpInputProps) {
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const lastCompletedRef = useRef<string | null>(null);

  const digits = value.replace(/\D/g, '').slice(0, length);

  useEffect(() => {
    if (autoFocus) inputsRef.current[0]?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (digits.length === length && lastCompletedRef.current !== digits) {
      lastCompletedRef.current = digits;
      onComplete?.(digits);
    }
    if (digits.length < length) lastCompletedRef.current = null;
  }, [digits, length, onComplete]);

  const focusIndex = (index: number) => {
    const clamped = Math.max(0, Math.min(length - 1, index));
    inputsRef.current[clamped]?.focus();
    inputsRef.current[clamped]?.select();
  };

  const setDigitAt = (index: number, digit: string) => {
    const chars = digits.split('');
    while (chars.length < index) chars.push('');
    chars[index] = digit;
    const next = chars.join('').replace(/\D/g, '').slice(0, length);
    onChange(next);
  };

  const handleChange = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, '');
    if (!raw) {
      setDigitAt(index, '');
      return;
    }
    if (raw.length > 1) {
      // Multiple characters (paste or autofill): fill from this box onward.
      const next = (digits.slice(0, index) + raw).slice(0, length);
      onChange(next);
      focusIndex(Math.min(next.length, length - 1));
      return;
    }
    setDigitAt(index, raw);
    if (index < length - 1) focusIndex(index + 1);
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[index]) {
        e.preventDefault();
        onChange(digits.slice(0, index));
        focusIndex(index);
      } else if (index > 0) {
        e.preventDefault();
        onChange(digits.slice(0, index - 1));
        focusIndex(index - 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusIndex(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusIndex(index + 1);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    e.preventDefault();
    onChange(pasted);
    focusIndex(Math.min(pasted.length, length - 1));
  };

  return (
    <div className={`flex items-center gap-2 ${className}`} onPaste={handlePaste}>
      {Array.from({ length }).map((_, index) => (
        <input
          key={index}
          ref={(el) => {
            inputsRef.current[index] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={length}
          aria-label={`Digit ${index + 1} of ${length}`}
          value={digits[index] ?? ''}
          disabled={disabled}
          onChange={(e) => handleChange(index, e)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onFocus={(e) => e.target.select()}
          className="h-12 w-10 rounded-lg border border-gray-300 bg-white text-center text-lg font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-fainter focus:border-brand-default transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
        />
      ))}
    </div>
  );
}
