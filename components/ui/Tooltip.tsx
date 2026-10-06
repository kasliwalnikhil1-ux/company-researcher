'use client';

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

// One tooltip look for the whole app (the "Last 7 days" metric tips on the outreach dashboard):
// dark rounded card, white text, centred above the target, flipped below when there is no room.

const GAP = 6;
const EDGE = 8;

/** The tooltip card. Portalled to <body> with fixed position so scrolling tables, overflow and transforms never clip it. */
export function TooltipBubble({ anchor, id, children }: { anchor: DOMRect; id?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: 0, top: 0, visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const below = anchor.top - GAP - height < EDGE;
    const left = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, EDGE), window.innerWidth - width - EDGE);
    setStyle({ left, top: below ? anchor.bottom + GAP : anchor.top - GAP - height });
  }, [anchor, children]);
  return createPortal(
    <div ref={ref} id={id} role="tooltip" style={style}
      className="fixed z-[10000] w-max max-w-[min(18rem,calc(100vw-16px))] rounded-lg bg-gray-900 px-3 py-2 text-xs font-normal normal-case tracking-normal leading-relaxed text-white shadow-lg pointer-events-none whitespace-pre-line break-words text-left">
      {children}
    </div>,
    document.body,
  );
}

/** Inline term with a dotted underline that explains itself on hover or keyboard focus. */
export function InfoTip({ text, children, className }: { text?: string | null; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const show = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  }, []);
  const hide = useCallback(() => setAnchor(null), []);
  if (!text) return <span className={className}>{children}</span>;
  return (
    <span ref={ref} tabIndex={0} aria-describedby={anchor ? id : undefined} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
      className={cn('cursor-help underline decoration-dotted decoration-gray-300 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm', className)}>
      {children}
      {anchor && <TooltipBubble anchor={anchor} id={id}>{text}</TooltipBubble>}
    </span>
  );
}

const STASH = 'data-tip-title';
const DELAY_MS = 250;
const WARM_MS = 300;

/**
 * Shows every native `title` attribute in the app as a TooltipBubble instead of the browser's own tooltip.
 * While an element is hovered (or keyboard-focused) its title moves to data-tip-title so the native
 * tooltip stays hidden; it is put back when the pointer leaves, so accessible names are unchanged.
 * Opt an area out with data-native-title. Mounted once in the root layout.
 */
export function GlobalTooltips() {
  const [tip, setTip] = useState<{ anchor: DOMRect; text: string } | null>(null);

  useEffect(() => {
    let current: Element | null = null;
    let timer: number | undefined;
    let open = false;
    let lastClose = 0;
    const observer = new MutationObserver(() => {
      // The title changed while hovered (e.g. "Copy" → "Copied"): take the new text, keep the native one hidden.
      if (!current) return;
      const t = current.getAttribute('title');
      if (t === null) return;
      current.setAttribute(STASH, t);
      current.removeAttribute('title');
      if (!t.trim()) close();
      else if (open) setTip({ anchor: current.getBoundingClientRect(), text: t.trim() });
    });

    const dismiss = () => {
      window.clearTimeout(timer);
      if (open) lastClose = Date.now();
      open = false;
      setTip(null);
    };
    const close = () => {
      dismiss();
      observer.disconnect();
      if (!current) return;
      const t = current.getAttribute(STASH);
      current.removeAttribute(STASH);
      if (t !== null && !current.hasAttribute('title')) current.setAttribute('title', t);
      current = null;
    };
    const titled = (node: EventTarget | null): Element | null => {
      const el = node instanceof Element ? node.closest('[title]') : null;
      if (!el || el.tagName === 'IFRAME' || el.closest('[data-native-title]')) return null;
      return el.getAttribute('title')?.trim() ? el : null;
    };
    const begin = (el: Element, immediate: boolean) => {
      close();
      const raw = el.getAttribute('title') ?? '';
      el.setAttribute(STASH, raw);
      el.removeAttribute('title');
      current = el;
      observer.observe(el, { attributes: true, attributeFilter: ['title'] });
      const reveal = () => {
        if (current !== el || !el.isConnected) return;
        open = true;
        setTip({ anchor: el.getBoundingClientRect(), text: raw.trim() });
      };
      if (immediate || Date.now() - lastClose < WARM_MS) reveal();
      else timer = window.setTimeout(reveal, DELAY_MS);
    };

    const onOver = (e: MouseEvent) => {
      const el = titled(e.target);
      if (el) { if (el !== current) begin(el, false); return; }
      if (current && e.target instanceof Node && current.contains(e.target)) return;
      close();
    };
    const onOut = (e: MouseEvent) => { if (!e.relatedTarget) close(); };
    const onFocusIn = (e: FocusEvent) => {
      const el = titled(e.target);
      if (el && el === e.target && el.matches(':focus-visible')) begin(el, true);
    };
    const onFocusOut = (e: FocusEvent) => { if (current && e.target === current) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', close);
    return () => {
      close();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('blur', close);
    };
  }, []);

  return tip ? <TooltipBubble anchor={tip.anchor}>{tip.text}</TooltipBubble> : null;
}
