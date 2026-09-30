'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, Inbox, Users, Contact, GitBranch, CheckSquare, Building2, CreditCard, Settings, BarChart3, Sparkles, type LucideIcon } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useDashboard } from '@/lib/outreach/queries';
import { useSidebarCollapsed, useSidebarFlat } from '@/contexts/SidebarContext';
import { cn } from '@/lib/utils';
import { Modal, Input, Button } from './ui';

type NavBadge = 'unread' | 'tasks_open' | 'ai_review';
interface NavItem { href: string; label: string; icon: LucideIcon; exact?: boolean; prefix?: string; badge?: NavBadge; manager?: boolean; owner?: boolean; writer?: boolean }

export const OUTREACH_NAV: NavItem[] = [
  { href: '/outreach', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/outreach/inbox', label: 'Inbox', icon: Inbox, badge: 'unread' },
  { href: '/outreach/senders', label: 'Senders', icon: Contact },
  { href: '/outreach/leads', label: 'Leads', icon: Users },
  { href: '/outreach/sequences', label: 'Sequences', icon: GitBranch },
  { href: '/outreach/tasks', label: 'Tasks', icon: CheckSquare, badge: 'tasks_open' },
  { href: '/outreach/ai-review', label: 'AI Personalization', icon: Sparkles, badge: 'ai_review', writer: true },
  { href: '/outreach/reports', label: 'Reports', icon: BarChart3 },
  { href: '/outreach/clients', label: 'Clients', icon: Building2, manager: true },
  { href: '/outreach/billing', label: 'Billing', icon: CreditCard, owner: true },
  { href: '/outreach/settings/workspace', label: 'Settings', icon: Settings, prefix: '/outreach/settings', writer: true },
];

const CLIENT_VIEWER_HIDDEN = ['/outreach/senders', '/outreach/sequences', '/outreach/tasks', '/outreach/clients'];

export const aiReviewCountKey = (ws: string) => ['outreach', ws, 'ai-review-count'] as const;

/**
 * AI lines that are written and wait for a person (`outreach_ai_values.status = 'generated'`).
 * Polled every 30 s; the shell also refreshes it on realtime changes. RLS limits the count to leads the member can see.
 */
export function useAiReviewCount(ws: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: aiReviewCountKey(ws ?? ''), enabled: !!ws && enabled, refetchInterval: 30_000, retry: 0,
    queryFn: async () => {
      const { count, error } = await supabase.from('outreach_ai_values').select('id', { count: 'exact', head: true }).eq('workspace_id', ws!).eq('status', 'generated');
      if (error) throw error;
      return count ?? 0;
    },
  });
}

/** Outreach sub-nav items visible to the current role, with active state and badge counts. */
export function useOutreachNav() {
  const pathname = usePathname();
  const { workspace, isManager, isOwner, role } = useWorkspace();
  const dash = useDashboard(workspace?.id);
  const isClientViewer = role === 'client_viewer';
  const aiReview = useAiReviewCount(workspace?.id, !isClientViewer);
  const counts: Record<NavBadge, number> = {
    unread: Number((dash.data as any)?.unread ?? 0),
    tasks_open: Number((dash.data as any)?.tasks_open ?? 0),
    // the dashboard carries the same number; use it while the direct count is loading or unavailable
    ai_review: Number(aiReview.data ?? (dash.data as any)?.ai_lines_awaiting ?? 0),
  };
  return OUTREACH_NAV
    .filter((n) => (!n.manager || isManager) && (!n.owner || isOwner) &&!(isClientViewer && (n.writer || CLIENT_VIEWER_HIDDEN.includes(n.href))))
    .map((n) => ({
      ...n,
      active: n.exact ? pathname === n.href : pathname.startsWith(n.prefix ?? n.href),
      count: n.badge ? counts[n.badge] : 0,
    }));
}

export function CountBadge({ count }: { count: number }) {
  if (!(count > 0)) return null;
  return <span className="ml-1 text-[10px] bg-indigo-600 text-white rounded-full px-1.5 py-0.5 leading-none">{count > 99 ? '99+' : count}</span>;
}

export function NewWorkspaceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { createWorkspace } = useWorkspace();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="New workspace" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={creating} onClick={async () => { setCreating(true); try { await createWorkspace(newName || 'New workspace'); onClose(); setNewName(''); } finally { setCreating(false); } }}>Create</Button></>}>
      <Input label="Workspace name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Acme Agency" />
    </Modal>
  );
}

const NEW_WORKSPACE = '__new__';

/**
 * Outreach workspace switcher + sub-nav, rendered under "Outreach" in the main sidebar.
 * On GrowthxAI (SidebarFlatContext) the items are the main menu itself, styled as top-level items.
 */
export function OutreachSidebarNav() {
  const { workspace, workspaces, switchWorkspace, role } = useWorkspace();
  const items = useOutreachNav();
  const collapsed = useSidebarCollapsed();
  const flat = useSidebarFlat();
  const isClientViewer = role === 'client_viewer';
  const [createOpen, setCreateOpen] = useState(false);
  if (!workspace) return null;

  if (collapsed) {
    return (
      <div className={flat ? 'space-y-2' : 'space-y-1 py-1 border-y border-gray-100'}>
        {items.map((n) => (
          <Link key={n.href} href={n.href} title={n.label} aria-label={n.label} aria-current={n.active ? 'page' : undefined}
            className={cn('relative flex items-center justify-center rounded-lg', flat ? 'px-2 py-2.5' : 'py-2', n.active ? 'bg-indigo-50 text-indigo-700' : flat ? 'text-gray-700 hover:bg-gray-50' : 'text-gray-500 hover:bg-gray-50')}>
            <n.icon className={flat ? 'w-5 h-5' : 'w-4 h-4'} />
            {n.count > 0 && <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-indigo-600" />}
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div className={flat ? 'space-y-2' : 'ml-6 pl-3 border-l border-gray-200 space-y-1 py-1'}>
      <select
        value={workspace.id}
        onChange={(e) => {
          if (e.target.value === NEW_WORKSPACE) setCreateOpen(true);
          else switchWorkspace(e.target.value);
        }}
        className="w-full mb-1 px-2 py-1.5 text-sm font-semibold rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        aria-label="Workspace"
      >
        {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        {!isClientViewer && <option value={NEW_WORKSPACE}>+ New workspace</option>}
      </select>
      {items.map((n) => (
        <Link key={n.href} href={n.href} aria-current={n.active ? 'page' : undefined} className={cn('flex items-center rounded-lg text-sm font-medium', flat ? 'gap-3 px-4 py-2.5' : 'gap-2 px-3 py-2', n.active ? 'bg-indigo-50 text-indigo-700' : flat ? 'text-gray-700 hover:bg-gray-50' : 'text-gray-600 hover:bg-gray-50')}>
          <n.icon className={flat ? 'w-5 h-5' : 'w-4 h-4'} />
          <span className="flex-1">{n.label}</span>
          <CountBadge count={n.count} />
        </Link>
      ))}
      {/* Portal: the mobile sidebar is transformed, which would trap a fixed-position modal inside it. */}
      {createOpen && createPortal(<NewWorkspaceModal open onClose={() => setCreateOpen(false)} />, document.body)}
    </div>
  );
}
