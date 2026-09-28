'use client';

import { useSyncExternalStore } from 'react';

/**
 * Platform-operator screens live under Settings → Admin (/outreach/settings/admin) and are shown ONLY when the app runs
 * on localhost. Nobody sees them on a deployed host, not even the platform admin account: operating the platform is done
 * from a local checkout. What belongs there: anything that is the same for every workspace, sender or user (deployment
 * setup, channel ceilings, warm-up caps, engine pause rules). Per-workspace settings stay in the other tabs.
 *
 * The edge function behind Platform setup (outreach-unipile-setup) additionally requires the platform admin email and a
 * localhost Origin, so a customer cannot reach it by calling the API directly either.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

const noSubscribe = () => () => {};

/** null until the browser is known (SSR / hydration), then true only on localhost. */
export function useIsLocalhost(): boolean | null {
  return useSyncExternalStore(noSubscribe, () => isLocalHost(window.location.hostname), () => null);
}

/** True only when the page is served from localhost. False during SSR and on every deployed host. */
export function useLocalhostOnly(): boolean {
  return useIsLocalhost() === true;
}
