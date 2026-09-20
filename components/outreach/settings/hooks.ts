'use client';

// Query hooks for the settings screens. Reads go through RLS or the same RPCs the connector and the public API use.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from '@/lib/outreach/api';
import type { AiSettings, AiVariable, ApiKeyRow, BlacklistRow, Delivery, DomainRow, Integration, StageRow, SyncLogRow, TrackingDomain } from './types';

export const sk = {
  stages: (ws: string) => ['outreach', ws, 'stages', 'settings'] as const,
  blacklist: (ws: string) => ['outreach', ws, 'suppressions', 'v2'] as const,
  aiSettings: (ws: string) => ['outreach', ws, 'ai-settings'] as const,
  aiVariables: (ws: string) => ['outreach', ws, 'ai-variables'] as const,
  trackingDomains: (ws: string) => ['outreach', ws, 'tracking-domains'] as const,
  apiKeys: (ws: string) => ['outreach', ws, 'api-keys'] as const,
  deliveries: (ws: string) => ['outreach', ws, 'webhook-deliveries'] as const,
  integrations: (ws: string) => ['outreach', ws, 'integrations'] as const,
  syncLog: (id: string, errorsOnly: boolean) => ['outreach', 'integration', id, 'sync-log', errorsOnly] as const,
  domains: (ws: string) => ['outreach', ws, 'domains'] as const,
};

async function sel<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw parseError(error);
  return (data ?? []) as T;
}

type Id = string | null | undefined;

export function useSettingsStages(ws: Id) {
  return useQuery({ queryKey: sk.stages(ws ?? ''), enabled: !!ws, queryFn: () => sel<StageRow[]>(supabase.from('outreach_stages').select('id, workspace_id, name, position, color, kind, deal_value').eq('workspace_id', ws!).order('position')) });
}

/**
 * Newest entries first. The server caps a page (PostgREST max rows), so on a long list the page passes `search`
 * and the value is matched in the database instead of in the browser.
 */
export const BLACKLIST_WINDOW = 5000;
export function useBlacklist(ws: Id, search = '') {
  const term = search.trim().toLowerCase();
  return useQuery({
    queryKey: [...sk.blacklist(ws ?? ''), term] as const, enabled: !!ws, placeholderData: (prev) => prev,
    queryFn: async () => {
      let q = supabase.from('outreach_suppressions')
        .select('id, workspace_id, client_id, sequence_id, kind, value, reason, source, created_at', { count: 'exact' })
        .eq('workspace_id', ws!);
      if (term) q = q.ilike('value', `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      const { data, error, count } = await q.order('created_at', { ascending: false }).range(0, BLACKLIST_WINDOW - 1);
      if (error) throw parseError(error);
      return { rows: (data ?? []) as BlacklistRow[], total: count ?? (data ?? []).length };
    },
  });
}

export function useAiSettings(ws: Id) {
  return useQuery({ queryKey: sk.aiSettings(ws ?? ''), enabled: !!ws, queryFn: () => rpc<AiSettings>('workspace_ai_settings', { p_ws: ws }) });
}

export function useAiVariables(ws: Id) {
  return useQuery({ queryKey: sk.aiVariables(ws ?? ''), enabled: !!ws, queryFn: () => sel<AiVariable[]>(supabase.from('outreach_ai_variables').select('*').eq('workspace_id', ws!).order('created_at')) });
}

export function useTrackingDomains(ws: Id) {
  return useQuery({
    queryKey: sk.trackingDomains(ws ?? ''), enabled: !!ws,
    // DNS and approval happen elsewhere: poll while something is still pending.
    refetchInterval: (q) => ((q.state.data as TrackingDomain[] | undefined) ?? []).some((d) => d.status === 'pending_dns' || d.status === 'awaiting_approval') ? 60_000 : false,
    queryFn: () => sel<TrackingDomain[]>(supabase.from('outreach_tracking_domains').select('*').eq('workspace_id', ws!).order('created_at')),
  });
}

export function useApiKeys(ws: Id) {
  return useQuery({
    queryKey: sk.apiKeys(ws ?? ''), enabled: !!ws,
    // key_hash is not selectable (column privileges), so name the columns.
    queryFn: () => sel<ApiKeyRow[]>(supabase.from('outreach_api_keys').select('id, workspace_id, user_id, name, prefix, role, client_ids, last_used_at, expires_at, revoked_at, created_at').eq('workspace_id', ws!).order('created_at', { ascending: false })),
  });
}

export function useDeliveries(ws: Id) {
  return useQuery({ queryKey: sk.deliveries(ws ?? ''), enabled: !!ws, refetchInterval: 30_000, queryFn: async () => (await rpc<Delivery[] | null>('api_deliveries', { p_ws: ws, p_webhook: null, p_limit: 100 })) ?? [] });
}

export function useIntegrations(ws: Id) {
  return useQuery({
    queryKey: sk.integrations(ws ?? ''), enabled: !!ws,
    refetchInterval: (q) => ((q.state.data as Integration[] | undefined) ?? []).some((i) => i.status === 'connecting') ? 10_000 : false,
    queryFn: () => sel<Integration[]>(supabase.from('outreach_integrations').select('id, workspace_id, provider, status, account_label, settings, field_mapping, stage_mapping, last_sync_at, last_pull_at, last_error, created_at').eq('workspace_id', ws!)),
  });
}

export function useSyncLog(integrationId: Id, errorsOnly: boolean) {
  return useQuery({
    queryKey: sk.syncLog(integrationId ?? '', errorsOnly), enabled: !!integrationId, refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase.from('outreach_crm_sync_log').select('id, integration_id, workspace_id, lead_id, direction, op, status, detail, at').eq('integration_id', integrationId!).order('at', { ascending: false }).limit(200);
      if (errorsOnly) q = q.eq('status', 'error');
      const rows = await sel<SyncLogRow[]>(q);
      // The log has no foreign key to leads, so names are fetched in a second query (RLS applies).
      const ids = [...new Set(rows.map((r) => r.lead_id).filter((x): x is string => !!x))];
      if (!ids.length) return rows;
      const leads = await sel<Array<{ id: string; full_name: string | null }>>(supabase.from('outreach_leads').select('id, full_name').in('id', ids));
      const byId = new Map(leads.map((l) => [l.id, l]));
      return rows.map((r) => ({ ...r, outreach_leads: r.lead_id ? byId.get(r.lead_id) ?? null : null }));
    },
  });
}

export function useDomains(ws: Id) {
  return useQuery({
    queryKey: sk.domains(ws ?? ''), enabled: !!ws,
    refetchInterval: (q) => ((q.state.data as DomainRow[] | undefined) ?? []).some((d) => d.status === 'pending_dns' || d.status === 'verifying') ? 60_000 : false,
    queryFn: async () => (await rpc<DomainRow[] | null>('domains', { p_ws: ws })) ?? [],
  });
}
