'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useState } from 'react';
import { LayoutDashboard, Inbox, Users, Contact, GitBranch, CheckSquare, Building2, Settings } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useDashboard } from '@/lib/outreach/queries';
import { cn } from '@/lib/utils';
import { Modal, Input, Button } from './ui';

const NAV = [
  { href: '/outreach', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/outreach/inbox', label: 'Inbox', icon: Inbox, badge: 'unread' },
  { href: '/outreach/senders', label: 'Senders', icon: Contact },
  { href: '/outreach/leads', label: 'Leads', icon: Users },
  { href: '/outreach/sequences', label: 'Sequences', icon: GitBranch },
  { href: '/outreach/tasks', label: 'Tasks', icon: CheckSquare, badge: 'tasks_open' },
  { href: '/outreach/clients', label: 'Clients', icon: Building2, manager: true },
  { href: '/outreach/settings/workspace', label: 'Settings', icon: Settings, prefix: '/outreach/settings' },
];

const CLIENT_VIEWER_HIDDEN = ['/outreach/senders', '/outreach/sequences', '/outreach/tasks', '/outreach/clients'];

/** Outreach sub-nav items visible to the current role, with active state and badge counts. */
export function useOutreachNav() {
  const pathname = usePathname();
  const { workspace, isManager, role } = useWorkspace();
  const dash = useDashboard(workspace?.id);
  const isClientViewer = role === 'client_viewer';
  return NAV
    .filter((n) => (!n.manager || isManager) && !(isClientViewer && CLIENT_VIEWER_HIDDEN.includes(n.href)))
    .map((n) => ({
      ...n,
      active: n.exact ? pathname === n.href : pathname.startsWith(n.prefix ?? n.href),
      count: (n.badge ? (dash.data as any)?.[n.badge] : 0) as number,
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

/** Mobile-only: Outreach workspace switcher + sub-nav, rendered under "Outreach" in the main sidebar. */
export function OutreachSidebarNav() {
  const { workspace, workspaces, switchWorkspace } = useWorkspace();
  const items = useOutreachNav();
  const [createOpen, setCreateOpen] = useState(false);
  if (!workspace) return null;

  return (
    <div className="ml-6 pl-3 border-l border-gray-200 space-y-1 py-1">
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
        <option value={NEW_WORKSPACE}>+ New workspace</option>
      </select>
      {items.map((n) => (
        <Link key={n.href} href={n.href} className={cn('flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium', n.active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
          <n.icon className="w-4 h-4" />
          <span className="flex-1">{n.label}</span>
          <CountBadge count={n.count} />
        </Link>
      ))}
      {/* Portal: the mobile sidebar is transformed, which would trap a fixed-position modal inside it. */}
      {createOpen && createPortal(<NewWorkspaceModal open onClose={() => setCreateOpen(false)} />, document.body)}
    </div>
  );
}
