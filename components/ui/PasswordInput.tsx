'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  containerClassName?: string;
}

/**
 * Password field with a press-and-hold reveal button (Gmail-style): the value is
 * visible only while the eye is held down, and re-masks as soon as it is released,
 * the field loses focus, or the tab goes to the background.
 */
export function PasswordInput({
  className = '',
  containerClassName = '',
  onBlur,
  ...rest
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const hide = useCallback(() => setRevealed(false), []);

  // Never leave the password on screen when the user switches away.
  useEffect(() => {
    if (!revealed) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [revealed, hide]);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Keep focus (and the caret) in the input, and suppress the long-press
    // text-selection / callout behaviour on touch devices.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setRevealed(true);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.repeat) return;
    setRevealed(true);
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter') hide();
  };

  return (
    <div className={`relative ${containerClassName}`}>
      <input
        {...rest}
        ref={inputRef}
        type={revealed ? 'text' : 'password'}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={`${className} pr-11`}
        onBlur={(e) => {
          hide();
          onBlur?.(e);
        }}
      />
      <button
        type="button"
        aria-label="Press and hold to show password"
        aria-pressed={revealed}
        title="Press and hold to show"
        className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:text-gray-600 select-none touch-none"
        onPointerDown={handlePointerDown}
        onPointerUp={hide}
        onPointerCancel={hide}
        onLostPointerCapture={hide}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={hide}
      >
        {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
