'use client';

import { createContext } from 'react';
import type { WhitelabelConfig } from '@/lib/whitelabel';

/**
 * Whitelabel config resolved on the server from the request host (see app/layout.tsx).
 * Lets client pages render the right brand in the initial HTML instead of the default brand.
 */
export const WhitelabelContext = createContext<WhitelabelConfig | null>(null);

export function WhitelabelProvider({
  config,
  children,
}: {
  config: WhitelabelConfig;
  children: React.ReactNode;
}) {
  return <WhitelabelContext.Provider value={config}>{children}</WhitelabelContext.Provider>;
}
