'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus, AlertTriangle, LifeBuoy, BookOpen, Mail, HelpCircle } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useOutreachRealtime } from '@/lib/outreach/queries';
import { applyAccent, isHexColor, isHttpsUrl, productName, useBranding, type Branding } from '@/lib/outreach/branding';
import { cn } from '@/lib/utils';
import { useOutreachNav, CountBadge, NewWorkspaceModal, aiReviewCountKey } from './OutreachNav';

/** Keeps the "AI review" badge fresh: `outreach_ai_values` is in the realtime publication. */
function useAiReviewRealtime(ws: string | null | undefined, enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!ws || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase.channel(`outreach-ai-review:${ws}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_ai_values', filter: `workspace_id=eq.${ws}` }, () => {
        // a batch writes many rows at once: refresh once per second at most
        if (timer) return;
        timer = setTimeout(() => { timer = null; qc.invalidateQueries({ queryKey: aiReviewCountKey(ws) }); }, 1000);
      })
      .subscribe();
    return () => { if (timer) clearTimeout(timer); supabase.removeChannel(ch); };
  }, [ws, enabled, qc]);
}

function BrandMark({ branding, fallback }: { branding: Branding; fallback: string }) {
  const [failed, setFailed] = useState(false);
  const name = productName(branding);
  if (isHttpsUrl(branding.logo_url) && !failed) {
    return <img src={branding.logo_url} alt={name} referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-7 max-w-[140px] object-contain" />;
  }
  return <span className="w-6 h-6 rounded-md text-xs flex items-center justify-center font-semibold" style={{ background: 'var(--outreach-accent, #4f46e5)', color: 'var(--outreach-accent-contrast, #fff)' }}>{(name || fallback)[0]?.toUpperCase()}</span>;
}

function HelpMenu({ branding }: { branding: Branding }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey); window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open]);
  const links = [
    isHttpsUrl(branding.help_url) && { href: branding.help_url, label: 'Help centre', icon: LifeBuoy },
    isHttpsUrl(branding.docs_url) && { href: branding.docs_url, label: 'Documentation', icon: BookOpen },
    branding.support_email && { href: `mailto:${branding.support_email}`, label: `Email ${branding.support_email}`, icon: Mail },
  ].filter(Boolean) as Array<{ href: string; label: string; icon: typeof LifeBuoy }>;
  if (!links.length) return null;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50">
        <HelpCircle className="w-4 h-4" /> Help
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
          {links.map((l) => (
            <a key={l.href} role="menuitem" href={l.href} target={l.href.startsWith('mailto:') ? undefined : '_blank'} rel="noopener noreferrer" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
              <l.icon className="w-4 h-4 text-gray-400" /> <span className="truncate">{l.label}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OutreachShell({ children }: { children: React.ReactNode }) {
  const { workspace, workspaces, switchWorkspace, suspended, isClientViewer } = useWorkspace();
  useOutreachRealtime(workspace?.id);
  useAiReviewRealtime(workspace?.id, !isClientViewer);
  const nav = useOutreachNav();
  const [wsOpen, setWsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // White-label: clients see the agency's name, logo, colour and help links. The team keeps the normal look.
  const brandingQuery = useBranding(isClientViewer ? workspace?.id : null);
  const branded = isClientViewer;
  const branding: Branding = (branded && brandingQuery.data) || {};
  const accent = branded && isHexColor(branding.accent) ? branding.accent : null;
  useEffect(() => { if (!accent) return; return applyAccent(accent); }, [accent]);
  useEffect(() => {
    if (!branded || !brandingQuery.data) return;
    const prev = document.title;
    document.title = productName(brandingQuery.data);
    return () => { document.title = prev; };
  }, [branded, brandingQuery.data]);

  const activeStyle = accent ? { color: accent, background: `${accent}14` } : undefined;
  const canSwitch = !branded || workspaces.length > 1;

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-gray-50">
      {/* Desktop top bar. On mobile the workspace switcher + nav live under "Outreach" in the main sidebar. */}
      <div className="hidden md:block bg-white border-b border-gray-200 px-4 md:px-6">
        <div className="flex items-center gap-4 h-12">
          <div className="relative">
            {branded ? (
              <button type="button" disabled={!canSwitch} onClick={() => setWsOpen((o) => !o)} aria-haspopup={canSwitch ? 'menu' : undefined} aria-expanded={canSwitch ? wsOpen : undefined}
                className={cn('flex items-center gap-2 text-sm font-semibold text-gray-900 rounded-lg px-2 py-1', canSwitch && 'hover:bg-gray-100')}>
                {brandingQuery.isLoading ? <span className="w-24 h-5 rounded bg-gray-100 animate-pulse" /> : <><BrandMark branding={branding} fallback={workspace?.name ?? 'P'} /><span className="max-w-[200px] truncate">{productName({ ...branding, hide_platform_name: true, workspace_name: branding.workspace_name ?? workspace?.name })}</span></>}
                {canSwitch && <ChevronDown className="w-4 h-4 text-gray-400" />}
              </button>
            ) : (
              <button type="button" onClick={() => setWsOpen((o) => !o)} aria-haspopup="menu" aria-expanded={wsOpen} className="flex items-center gap-2 text-sm font-semibold text-gray-900 hover:bg-gray-100 rounded-lg px-2 py-1">
                <span className="w-6 h-6 rounded-md bg-indigo-600 text-white text-xs flex items-center justify-center">{(workspace?.name ?? 'W')[0]}</span>
                <span className="max-w-[180px] truncate">{workspace?.name ?? 'Workspace'}</span>
                <ChevronDown className="w-4 h-4 text-gray-400" />
              </button>
            )}
            {wsOpen && canSwitch && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setWsOpen(false)} />
                <div role="menu" className="absolute z-30 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                  {workspaces.map((w) => (
                    <button key={w.id} role="menuitem" onClick={() => { switchWorkspace(w.id); setWsOpen(false); }} className={cn('w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between', w.id === workspace?.id && 'bg-indigo-50 text-indigo-700')}>
                      <span className="truncate">{w.name}</span>
                      <span className="text-xs text-gray-400">{w.role.replace('_', ' ')}</span>
                    </button>
                  ))}
                  {!branded && (
                    <div className="border-t border-gray-100 mt-1 pt-1">
                      <button role="menuitem" onClick={() => { setWsOpen(false); setCreateOpen(true); }} className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"><Plus className="w-4 h-4" /> New workspace</button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <nav className="flex items-center gap-1 overflow-x-auto flex-1" aria-label="Outreach">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} aria-current={n.active ? 'page' : undefined} style={n.active ? activeStyle : undefined}
                className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap', n.active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
                <n.icon className="w-4 h-4" />
                {n.label}
                <CountBadge count={n.count} />
              </Link>
            ))}
          </nav>
          {branded && <HelpMenu branding={branding} />}
        </div>
      </div>
      {/* Mobile: the main sidebar carries the nav, so the help links sit in a slim bar here. */}
      {branded && (branding.support_email || branding.help_url || branding.docs_url) && (
        <div className="md:hidden bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-900 min-w-0"><BrandMark branding={branding} fallback={workspace?.name ?? 'P'} /><span className="truncate">{productName({ ...branding, hide_platform_name: true, workspace_name: branding.workspace_name ?? workspace?.name })}</span></span>
          <HelpMenu branding={branding} />
        </div>
      )}
      {suspended && (
        <div className="bg-red-50 border-b border-red-200 text-red-800 text-sm px-6 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {isClientViewer
            ? <span>This workspace is paused. Your data is safe and read-only for now.{branding.support_email ? <> Questions: <a className="underline font-medium" href={`mailto:${branding.support_email}`}>{branding.support_email}</a></> : null}</span>
            : <span>This workspace is suspended for non-payment. Senders are paused and the workspace is read-only. They resume on their own once billing is fixed. <Link href="/outreach/settings/billing" className="underline font-medium">Update billing</Link></span>}
        </div>
      )}
      {workspace?.stripe_status === 'past_due' && !suspended && !isClientViewer && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-sm px-6 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> <span>Payment is past due. The workspace becomes read-only 7 days after the failed payment. <Link href="/outreach/settings/billing" className="underline font-medium">Update billing</Link></span>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <div className="px-4 md:px-6 py-6 max-w-[1600px] mx-auto w-full">{children}</div>
      </div>
      <NewWorkspaceModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
