'use client';

// Small pieces shared by the step forms: notes, the AI-variable list, and the "preview as lead" target + render context.
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from '@/lib/outreach/api';
import { buildContext, type RenderContext } from '@/lib/outreach/render';
import type { AiVariable, Lead, RenderContextJson } from '@/lib/outreach/types';

export function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-xs text-gray-500 leading-5', className)}>{children}</p>;
}

export function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: React.ReactNode }) {
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <div role={tone === 'warn' ? 'alert' : 'note'} className={cn('flex items-start gap-1.5 text-xs rounded-md px-2 py-1.5 leading-5', tone === 'warn' ? 'text-amber-800 bg-amber-50' : 'text-sky-800 bg-sky-50')}>
      <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** Example unsubscribe address for previews. The real link is signed per lead when the email is sent. */
export const PREVIEW_UNSUBSCRIBE_LINK = 'https://example.com/unsubscribe';

// ---------------------------------------------------------------------------
// AI variables of the workspace ({{ai.<key>}})
// ---------------------------------------------------------------------------
export function useAiVariables(ws: string | null | undefined) {
  return useQuery({
    queryKey: ['outreach', ws ?? '', 'ai_variables'], enabled: !!ws, staleTime: 60000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_ai_variables').select('*').eq('workspace_id', ws!).order('name');
      if (error) throw parseError(error);
      return (data ?? []) as AiVariable[];
    },
  });
}

// ---------------------------------------------------------------------------
// Preview target: one lead + sender shared by every template field, so subject, body and variants preview the same person.
// ---------------------------------------------------------------------------
export type PreviewLead = Pick<Lead, 'id' | 'full_name' | 'company' | 'public_identifier'>;
interface PreviewTarget { lead: PreviewLead | null; senderId: string | null }

let target: PreviewTarget = { lead: null, senderId: null };
const listeners = new Set<() => void>();
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function snapshot() { return target; }

export function setPreviewTarget(patch: Partial<PreviewTarget>) {
  target = { ...target, ...patch };
  listeners.forEach((fn) => fn());
}

export function usePreviewTarget(): PreviewTarget {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useLeadSearch(ws: string | null | undefined, search: string, enabled: boolean) {
  const term = search.trim().replace(/[%,()]/g, ' ');
  return useQuery({
    queryKey: ['outreach', ws ?? '', 'preview_leads', term], enabled: !!ws && enabled, staleTime: 30000,
    queryFn: async () => {
      let q = supabase.from('outreach_leads').select('id, full_name, company, public_identifier').eq('workspace_id', ws!);
      if (term) q = q.or(`full_name.ilike.%${term}%,company.ilike.%${term}%`);
      const { data, error } = await q.order('updated_at', { ascending: false }).limit(8);
      if (error) throw parseError(error);
      return (data ?? []) as PreviewLead[];
    },
  });
}

/**
 * The exact context the executor renders with (RPC render_context), so the preview is what gets sent.
 * Without an enrollment the RPC seeds spintax from the lead and sender; an enrolled lead is seeded by its enrollment id.
 */
export function useRenderContext(leadId: string | null | undefined, senderId: string | null | undefined, enabled = true) {
  return useQuery<RenderContext>({
    queryKey: ['outreach', 'render_context', leadId ?? '', senderId ?? ''], enabled: !!leadId && enabled, staleTime: 60000,
    queryFn: async () => {
      const json = await rpc<RenderContextJson>('render_context', { p_lead: leadId, p_sender: senderId ?? null });
      return buildContext(json, { unsubscribe_link: PREVIEW_UNSUBSCRIBE_LINK });
    },
  });
}
