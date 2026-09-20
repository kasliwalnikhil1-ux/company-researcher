'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { fnUrl } from '@/lib/outreach/api';
import { getValidAccessToken } from '@/lib/api';
import type { Intent, Member, Message } from '@/lib/outreach/types';

export const INTENTS: Intent[] = ['interested', 'question', 'not_now', 'not_interested', 'ooo', 'wrong_person', 'unclear', 'unclassified'];

export const INTENT_LABELS: Record<Intent, string> = {
  interested: 'Interested',
  question: 'Question',
  not_now: 'Not now',
  not_interested: 'Not interested',
  ooo: 'Out of office',
  wrong_person: 'Wrong person',
  unclear: 'Unclear',
  unclassified: 'Unclassified',
};

/** LinkedIn messages can be edited/deleted for 60 minutes after sending. */
export const EDIT_WINDOW_MS = 60 * 60 * 1000;

export type MessageAttachment = Message['attachments'][number] & { mimetype?: string; storage?: boolean; email?: boolean };

export function memberLabel(m: Member | null | undefined, fallback = 'Unassigned'): string {
  if (!m) return fallback;
  return m.display_name || m.email || `${m.user_id.slice(0, 8)}…`;
}

export function findMember(members: Member[] | undefined, userId: string | null | undefined): Member | undefined {
  if (!userId) return undefined;
  return members?.find((m) => m.user_id === userId);
}

/** True when the keyboard event originates from a text-editing element (so global shortcuts should be ignored). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** A ticking clock; re-renders every `intervalMs` while `enabled`. */
export function useNow(intervalMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}

export function editWindowRemainingMs(sentAt: string, now: number): number {
  return EDIT_WINDOW_MS - (now - new Date(sentAt).getTime());
}

export function fmtRemaining(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  return m >= 1 ? `${m}m left` : '<1m left';
}

// ---------------------------------------------------------------------------
// Attachment proxy: fetch the bytes with the user JWT and expose an object URL.
// Object URLs are cached per (message, attachment) for the lifetime of the tab.
// ---------------------------------------------------------------------------
const urlCache = new Map<string, string>();

export function attachmentProxyUrl(messageId: string, attachmentId: string): string {
  return `${fnUrl('attachment-proxy')}?message_id=${encodeURIComponent(messageId)}&attachment_id=${encodeURIComponent(attachmentId)}`;
}

export function useAttachmentUrl(messageId: string, attachmentId: string) {
  const key = `${messageId}:${attachmentId}`;
  const [url, setUrl] = useState<string | null>(() => urlCache.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (): Promise<string | null> => {
    const cached = urlCache.get(key);
    if (cached) { setUrl(cached); return cached; }
    setLoading(true);
    setError(null);
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(attachmentProxyUrl(messageId, attachmentId), {
        headers: { Authorization: `Bearer ${token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '' },
      });
      if (!res.ok) {
        let msg = `Download failed (${res.status})`;
        try { const j = await res.json(); msg = j?.message ?? j?.error ?? msg; } catch { /* non-JSON body */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      urlCache.set(key, objectUrl);
      if (alive.current) setUrl(objectUrl);
      return objectUrl;
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [key, messageId, attachmentId]);

  return { url, loading, error, load };
}

export function triggerDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Minimal HTML sanitizer for rendering inbound email bodies. Removes active content
 * (scripts, frames, styles, forms), inline event handlers and javascript:/data: URLs.
 */
const BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'BASE', 'SVG', 'MATH', 'TEMPLATE']);
export function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined' || !html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (BLOCKED_TAGS.has(child.tagName)) { child.remove(); continue; }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') child.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'src' || name === 'xlink:href') && (value.startsWith('javascript:') || value.startsWith('vbscript:') || (value.startsWith('data:') && !value.startsWith('data:image/')))) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer nofollow'); }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function fmtBytes(n: number | undefined): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// `?chats=<comma separated ids>&label=<text>`: the reports page links here with exactly the threads behind a number.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useInboxRestrict(): { ids: string[]; label: string } | null {
  const params = useSearchParams();
  const chats = params.get('chats');
  const label = params.get('label');
  return useMemo(() => {
    if (chats == null) return null;
    const ids = Array.from(new Set(chats.split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s))));
    return { ids, label: (label ?? '').trim().slice(0, 120) };
  }, [chats, label]);
}
