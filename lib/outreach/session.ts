'use client';

/**
 * Who is using the outreach UI, and may they. Real mode passes the root contexts through unchanged.
 * Demo mode (`/product-tour`) is the fictional workspace owner with every product switched on, whoever is signed in.
 */
import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useAccess } from '@/contexts/AccessContext';
import { IS_DEMO } from './mode';

import { DEMO_USER_EMAIL, DEMO_USER_ID, DEMO_USER_NAME } from './demoIds';

export { DEMO_USER_EMAIL, DEMO_USER_ID, DEMO_USER_NAME };

export interface SessionUser { id: string; email?: string | null; user_metadata?: Record<string, unknown> }

const DEMO_USER: SessionUser = { id: DEMO_USER_ID, email: DEMO_USER_EMAIL, user_metadata: { full_name: DEMO_USER_NAME } };

/** `useAuth()` for outreach code: `{ user }`. */
export function useSessionUser(): { user: SessionUser | null; loading: boolean } {
  const auth = useAuth();
  if (IS_DEMO) return { user: DEMO_USER, loading: false };
  return { user: auth.user as SessionUser | null, loading: auth.loading };
}

/** `useAccess()` for outreach code: `{ loading, has }`. */
export function useOutreachAccess(): { loading: boolean; has: (key: string, fallback?: boolean) => boolean } {
  const access = useAccess();
  return useMemo(() => {
    if (IS_DEMO) return { loading: false, has: () => true };
    return { loading: access.loading, has: (key: string, fallback = true) => access.has(key as Parameters<typeof access.has>[0], fallback) };
  }, [access]);
}
