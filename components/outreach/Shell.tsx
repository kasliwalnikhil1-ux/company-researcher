'use client';

import Link from 'next/link';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useOutreachRealtime } from '@/lib/outreach/queries';
import { cn } from '@/lib/utils';
import { ChevronDown, Plus, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useOutreachNav, CountBadge, NewWorkspaceModal } from './OutreachNav';

export default function OutreachShell({ children }: { children: React.ReactNode }) {
  const { workspace, workspaces, switchWorkspace, suspended } = useWorkspace();
  useOutreachRealtime(workspace?.id);
  const nav = useOutreachNav();
  const [wsOpen, setWsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-gray-50">
      {/* Desktop top bar. On mobile the workspace switcher + nav live under "Outreach" in the main sidebar. */}
      <div className="hidden md:block bg-white border-b border-gray-200 px-4 md:px-6">
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
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap', n.active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
                <n.icon className="w-4 h-4" />
                {n.label}
                <CountBadge count={n.count} />
              </Link>
            ))}
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
      <NewWorkspaceModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
