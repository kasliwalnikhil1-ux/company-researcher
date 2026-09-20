'use client';

// White-label branding (item 23). One source: the `outreach_branding*` RPCs.
//   useBranding(ws)          signed-in members (owners / managers also get the email fields)
//   brandingForHost(host)    custom domain, callable before login (anon RPC, active domains only)
//   brandingForInvite(token) invite page, callable before login
//   applyAccent(hex)         sets the CSS variables the branded surfaces read

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from './api';

export interface Branding {
  workspace_name?: string;
  product_name?: string;
  logo_url?: string;
  accent?: string;
  support_email?: string;
  help_url?: string;
  docs_url?: string;
  email_from_name?: string;        // owners and managers only
  email_from_address?: string;     // owners and managers only
  hide_platform_name?: boolean;
}
export interface HostBranding extends Branding { workspace_id: string; client_id: string | null; portal_only: true }

export const PLATFORM_NAME = 'CapitalxAI Outreach';
export const DEFAULT_ACCENT = '#4f46e5';
export const brandingKey = (ws: string) => ['outreach', ws, 'branding'] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
export function isHexColor(v: string | null | undefined): v is string { return !!v && HEX.test(v); }
export function isHttpsUrl(v: string | null | undefined): v is string {
  if (!v) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

/** The name a client should see. Never the platform name when the agency hides it. */
export function productName(b: Branding | null | undefined): string {
  if (b?.product_name) return b.product_name;
  if (b?.hide_platform_name) return b.workspace_name ?? 'Client portal';
  return PLATFORM_NAME;
}

/** Black or white, whichever reads better on the accent. */
export function contrastOn(hex: string): '#ffffff' | '#111827' {
  if (!isHexColor(hex)) return '#ffffff';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#111827' : '#ffffff';
}

/**
 * Sets `--outreach-accent` and `--outreach-accent-contrast` on the element (the document root by default).
 * Returns a function that restores the previous values. An invalid colour resets to the default.
 */
export function applyAccent(accent: string | null | undefined, el?: HTMLElement | null): () => void {
  if (typeof document === 'undefined') return () => {};
  const target = el ?? document.documentElement;
  const prev = { a: target.style.getPropertyValue('--outreach-accent'), c: target.style.getPropertyValue('--outreach-accent-contrast') };
  const value = isHexColor(accent) ? accent : DEFAULT_ACCENT;
  target.style.setProperty('--outreach-accent', value);
  target.style.setProperty('--outreach-accent-contrast', contrastOn(value));
  return () => {
    if (prev.a) target.style.setProperty('--outreach-accent', prev.a); else target.style.removeProperty('--outreach-accent');
    if (prev.c) target.style.setProperty('--outreach-accent-contrast', prev.c); else target.style.removeProperty('--outreach-accent-contrast');
  };
}

export function useBranding(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: brandingKey(workspaceId ?? ''), enabled: !!workspaceId, staleTime: 5 * 60_000,
    queryFn: async () => (await rpc<Branding | null>('branding', { p_ws: workspaceId })) ?? {},
  });
}

/** Works without a session. Returns null when the hostname is not an active custom domain. */
export async function brandingForHost(hostname: string): Promise<HostBranding | null> {
  const host = hostname.trim().toLowerCase().replace(/:\d+$/, '');
  if (!host) return null;
  return (await rpc<HostBranding | null>('branding_for_host', { p_hostname: host })) ?? null;
}

/** Works without a session. Returns null for an unknown token. */
export async function brandingForInvite(token: string): Promise<Branding | null> {
  return (await rpc<Branding | null>('branding_for_invite', { p_token: token })) ?? null;
}

/** Own hosts of the app. Anything else may be an agency's custom domain. Mirrors the list in `proxy.ts`. */
export function isAppHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/:\d+$/, '');
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.vercel.app')) return true;
  try { if (new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://app.capitalxai.com').hostname.toLowerCase() === h) return true; } catch { /* ignore */ }
  return false;
}

/** Branding of the custom domain the page is served from (null on the app's own hosts). */
export function useHostBranding() {
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => { const h = window.location.hostname; setHost(isAppHost(h) ? '' : h); }, []);
  return useQuery({ queryKey: ['outreach', 'host-branding', host ?? ''], enabled: !!host, staleTime: 10 * 60_000, retry: 0, queryFn: () => brandingForHost(host!) });
}
