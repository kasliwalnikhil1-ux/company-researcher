'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { rpc, parseError } from '@/lib/crm/api';
import type { CrmContextData, Lookup, LookupKind, Member } from '@/lib/crm/types';

interface Ctx {
  data: CrmContextData | null;
  loading: boolean;
  error: string | null;
  isMember: boolean;
  me: Member | null;
  members: Member[];
  activeMembers: Member[];
  timezone: string;
  staleAfterDays: number;
  lookups: (kind: LookupKind, includeInactive?: boolean) => Lookup[];
  lookupLabel: (kind: LookupKind, id: string | null | undefined) => string;
  fxRates: Record<string, number>;
  currencies: string[];
  refresh: () => Promise<void>;
}

const CrmCtx = createContext<Ctx | undefined>(undefined);

export function CrmProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [data, setData] = useState<CrmContextData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      setData(await rpc<CrmContextData>('context'));
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const value = useMemo<Ctx>(() => {
    const lists: Record<LookupKind, Lookup[]> = {
      icp_segment: data?.icp_segments ?? [],
      source_channel: data?.source_channels ?? [],
      activity_type: data?.activity_types ?? [],
    };
    return {
      data,
      loading,
      error,
      isMember: !!data?.is_member,
      me: data?.me ?? null,
      members: data?.members ?? [],
      activeMembers: (data?.members ?? []).filter((m) => m.is_active),
      timezone: data?.timezone ?? 'Asia/Kolkata',
      staleAfterDays: data?.stale_after_days ?? 14,
      lookups: (kind, includeInactive = false) => lists[kind].filter((l) => includeInactive || l.is_active),
      lookupLabel: (kind, id) => (id ? lists[kind].find((l) => l.id === id)?.label ?? '—' : '—'),
      fxRates: data?.fx_rates ?? {},
      currencies: Object.keys(data?.fx_rates ?? { USD: 1 }).sort(),
      refresh: load,
    };
  }, [data, loading, error, load]);

  return <CrmCtx.Provider value={value}>{children}</CrmCtx.Provider>;
}

export function useCrm(): Ctx {
  const ctx = useContext(CrmCtx);
  if (!ctx) throw new Error('useCrm must be used within CrmProvider');
  return ctx;
}
