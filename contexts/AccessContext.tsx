'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchMyAccess, type FeatureKey, type MyAccess } from '@/lib/platform/access';

interface Ctx {
  /** true until the first load for the signed-in user finishes (false when signed out) */
  loading: boolean;
  access: MyAccess | null;
  error: string | null;
  status: MyAccess['status'] | 'unknown';
  isAdmin: boolean;
  crmMember: boolean;
  /** platform defaults overlaid with this account's overrides */
  features: Record<string, boolean>;
  /** The effective switch for a feature: the admin's setting when there is one, otherwise `fallback`. */
  has: (key: FeatureKey, fallback?: boolean) => boolean;
  refresh: () => Promise<void>;
}

const AccessContext = createContext<Ctx | undefined>(undefined);

type Loaded = { userId: string; access: MyAccess | null; error: string | null };

export function AccessProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  // Everything derives from "what was loaded for which user", so a user change never needs a synchronous reset.
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const userId = user.id;
    try {
      const a = await fetchMyAccess();
      setLoaded({ userId, access: a, error: null });
    } catch (e) {
      // The database still enforces access; a failed read only affects what the sidebar shows.
      console.warn('[access] could not load platform access:', e);
      setLoaded((prev) => ({ userId, access: prev?.userId === userId ? prev.access : null, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const value = useMemo<Ctx>(() => {
    const current = user && loaded?.userId === user.id ? loaded : null;
    const access = current?.access ?? null;
    const features = access?.features ?? {};
    return {
      loading: !!user && !current,
      access,
      error: current?.error ?? null,
      status: access?.status ?? 'unknown',
      isAdmin: !!access?.is_admin,
      crmMember: !!access?.crm_member,
      features,
      has: (key, fallback = true) => (typeof features[key] === 'boolean' ? features[key] : fallback),
      refresh: load,
    };
  }, [user, loaded, load]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): Ctx {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error('useAccess must be used within AccessProvider');
  return ctx;
}

/** `useFeature('outreach')` → the effective switch for one feature. */
export function useFeature(key: FeatureKey, fallback = true): boolean {
  return useAccess().has(key, fallback);
}
