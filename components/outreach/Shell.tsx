'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useOutreachRealtime, useDashboard } from '@/lib/outreach/queries';
import { cn } from '@/lib/utils';
import { LayoutDashboard, Inbox, Users, Contact, GitBranch, CheckSquare, Building2, Settings, ChevronDown, Plus, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
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

export default function OutreachShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { workspace, workspaces, switchWorkspace, isManager, suspended, createWorkspace, role } = useWorkspace();
  useOutreachRealtime(workspace?.id);
  const dash = useDashboard(workspace?.id);
  const [wsOpen, setWsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const isClientViewer = role === 'client_viewer';

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 md:px-6">
        <div className="flex items-center gap-4 h-12">
          <div className="relative">
            <button onClick={() => setWsOpen((o) => !o)} className="flex items-center gap-2 text-sm font-semibold text-gray-900 hover:bg-gray-100 rounded-lg px-2 py-1">
              <span className="w-6 h-6 rounded-md bg-indigo-600 text-white text-xs flex items-center justify-center">{(workspace?.name ?? 'W')[0]}</span>
              <span className="max-w-[180px] truncate">{workspace?.name ?? 'Workspace'}</span>
              <ChevronDown className="w-4 h-4 text-gray-400" />
            </button>
            {wsOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setWsOpen(false)} />
                <div className="absolute z-30 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                  {workspaces.map((w) => (
                    <button key={w.id} onClick={() => { switchWorkspace(w.id); setWsOpen(false); }} className={cn('w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between', w.id === workspace?.id && 'bg-indigo-50 text-indigo-700')}>
                      <span className="truncate">{w.name}</span>
                      <span className="text-xs text-gray-400">{w.role}</span>
                    </button>
                  ))}
                  <div className="border-t border-gray-100 mt-1 pt-1">
                    <button onClick={() => { setWsOpen(false); setCreateOpen(true); }} className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"><Plus className="w-4 h-4" /> New workspace</button>
                  </div>
                </div>
              </>
            )}
          </div>
          <nav className="flex items-center gap-1 overflow-x-auto flex-1">
            {NAV.filter((n) => (!n.manager || isManager) && !(isClientViewer && ['/outreach/senders', '/outreach/sequences', '/outreach/tasks', '/outreach/clients'].includes(n.href))).map((n) => {
              const active = n.exact ? pathname === n.href : pathname.startsWith(n.prefix ?? n.href);
              const count = n.badge ? (dash.data as any)?.[n.badge] : 0;
              return (
                <Link key={n.href} href={n.href} className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap', active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
                  <n.icon className="w-4 h-4" />
                  {n.label}
                  {count > 0 && <span className="ml-1 text-[10px] bg-indigo-600 text-white rounded-full px-1.5 py-0.5 leading-none">{count > 99 ? '99+' : count}</span>}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
      {suspended && (
        <div className="bg-red-50 border-b border-red-200 text-red-800 text-sm px-6 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> This workspace is suspended for non-payment. Senders are paused and the workspace is read-only. <Link href="/outreach/settings/billing" className="underline font-medium">Update billing</Link>
        </div>
      )}
      {workspace?.stripe_status === 'past_due' && !suspended && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-sm px-6 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> Payment is past due. The workspace becomes read-only 7 days after the failed payment. <Link href="/outreach/settings/billing" className="underline font-medium">Update billing</Link>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <div className="px-4 md:px-6 py-6 max-w-[1600px] mx-auto w-full">{children}</div>
      </div>
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New workspace" size="sm"
        footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button><Button loading={creating} onClick={async () => { setCreating(true); try { await createWorkspace(newName || 'New workspace'); setCreateOpen(false); setNewName(''); } finally { setCreating(false); } }}>Create</Button></>}>
        <Input label="Workspace name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Acme Agency" />
      </Modal>
    </div>
  );
}
