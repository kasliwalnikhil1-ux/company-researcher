'use client';

import { useMemo } from 'react';
import {
  getWhitelabelConfig,
  getLogoPath,
  getOgImagePath,
  type WhitelabelConfig,
} from '@/lib/whitelabel';

export interface UseWhitelabelReturn extends WhitelabelConfig {
  /** Resolved path to the logo image */
  logoPath: string;
  /** Resolved path to the OG image */
  ogImagePath: string;
}

/**
 * React hook that resolves whitelabel settings from the current browser hostname.
 *
 * Safe for SSR – during server render (or when window is unavailable) the
 * default config is returned. On the client the hostname is read synchronously
 * during the first render so there is no flash of wrong branding.
 */
export function useWhitelabel(): UseWhitelabelReturn {
  const config = useMemo(() => {
    const hostname = typeof window !== 'undefined' ? window.location.hostname : undefined;
    return getWhitelabelConfig(hostname);
  }, []);

  return useMemo(
    () => ({
      ...config,
      logoPath: getLogoPath(config),
      ogImagePath: getOgImagePath(config),
    }),
    [config],
  );
}
