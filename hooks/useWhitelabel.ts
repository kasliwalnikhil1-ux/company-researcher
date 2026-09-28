'use client';

import { useContext, useMemo } from 'react';
import {
  getWhitelabelConfig,
  getLogoPath,
  getOgImagePath,
  type WhitelabelConfig,
} from '@/lib/whitelabel';
import { WhitelabelContext } from '@/contexts/WhitelabelContext';

export interface UseWhitelabelReturn extends WhitelabelConfig {
  /** Resolved path to the logo image */
  logoPath: string;
  /** Resolved path to the OG image */
  ogImagePath: string;
}

/**
 * React hook that returns the whitelabel settings for the current domain.
 *
 * The root layout resolves the config from the request host and provides it through
 * WhitelabelContext, so server render and hydration agree and there is no flash of wrong
 * branding. Outside that provider it falls back to window.location.hostname.
 */
export function useWhitelabel(): UseWhitelabelReturn {
  const provided = useContext(WhitelabelContext);
  const config = useMemo(() => {
    if (provided) return provided;
    const hostname = typeof window !== 'undefined' ? window.location.hostname : undefined;
    return getWhitelabelConfig(hostname);
  }, [provided]);

  return useMemo(
    () => ({
      ...config,
      logoPath: getLogoPath(config),
      ogImagePath: getOgImagePath(config),
    }),
    [config],
  );
}
