'use client';

import { useEffect, useState } from 'react';

/**
 * Platform-operator screens (deployment secrets, connector webhooks) are shown ONLY when the app runs on localhost.
 * Nobody sees them on a deployed host, not even the platform admin account: operating the deployment is done from a
 * local checkout. The edge function behind them (outreach-unipile-setup) additionally requires the platform admin
 * email and a localhost Origin, so a customer cannot reach it by calling the API directly either.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/** True only when the page is served from localhost. False during SSR and on every deployed host. */
export function useLocalhostOnly(): boolean {
  const [local, setLocal] = useState(false);
  useEffect(() => { setLocal(isLocalHost(window.location.hostname)); }, []);
  return local;
}
