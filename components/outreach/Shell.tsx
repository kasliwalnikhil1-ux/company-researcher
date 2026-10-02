'use client';

import Link from '@/lib/outreach/nav';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, LifeBuoy, BookOpen, Mail, HelpCircle } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useOutreachRealtime } from '@/lib/outreach/queries';
import { applyAccent, isHexColor, isHttpsUrl, productName, useBranding, type Branding } from '@/lib/outreach/branding';
import { useSessionUser } from '@/lib/outreach/session';
import { useNotificationsRealtime, type IncomingNotification } from '@/lib/outreach/notes';
import MentionToast from './inbox/notes/MentionToast';
import { changeHref, longDate, useBilling } from '@/lib/outreach/billing';

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
  const { workspace, suspended, isClientViewer, isOwner } = useWorkspace();
  // plan state for the banners (billing v2): trial ending, trial ended, subscription ended, client access not on the plan
  const billing = useBilling(workspace?.id).data;
  const plan = billing?.plan ?? workspace?.plan;
  const trialDays = billing?.enforced && plan === 'trial' ? billing.trial?.days_left ?? null : null;
  const { user } = useSessionUser();
  useOutreachRealtime(workspace?.id);
  // Private notes: the signed-in user's notification stream (bell badge + toast for a fresh @mention)
  const [toasts, setToasts] = useState<IncomingNotification[]>([]);
  useNotificationsRealtime(workspace?.id, user?.id, (n) => setToasts((t) => [...t.filter((x) => x.id !== n.id), n].slice(-3)));

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

  return (
    <div className="flex-1 flex flex-col min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-gray-50">
      {/* The workspace switcher + nav live under "Outreach" in the main sidebar; clients get their brand + help links in a slim bar here. */}
      {branded && (branding.support_email || branding.help_url || branding.docs_url) && (
        <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-2 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-900 min-w-0"><BrandMark branding={branding} fallback={workspace?.name ?? 'P'} /><span className="truncate">{productName({ ...branding, hide_platform_name: true, workspace_name: branding.workspace_name ?? workspace?.name })}</span></span>
          <HelpMenu branding={branding} />
        </div>
      )}
      {suspended && (
        <div className="bg-red-50 border-b border-red-200 text-red-800 text-sm px-6 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {isClientViewer
            ? <span>This workspace is paused. Your data is safe and read-only for now.{branding.support_email ? <> Questions: <a className="underline font-medium" href={`mailto:${branding.support_email}`}>{branding.support_email}</a></> : null}</span>
            : plan === 'trial_expired'
              ? <span>The trial has ended. The account is disconnected and nothing is being sent. Everything is kept{billing?.data_delete_after ? ` until ${longDate(billing.data_delete_after)}` : ' for 30 days'}. {isOwner ? <Link href={changeHref()} className="underline font-medium">Subscribe</Link> : 'The workspace owner can subscribe on the Billing page.'}</span>
              : plan === 'cancelled'
                ? <span>This subscription has ended. Senders are paused and the workspace is read-only{billing?.data_delete_after ? `; your data is kept until ${longDate(billing.data_delete_after)}` : ''}. {isOwner ? <Link href={changeHref()} className="underline font-medium">Subscribe again</Link> : 'The workspace owner can subscribe again on the Billing page.'}</span>
                : <span>This workspace is suspended for non-payment. Senders are paused and the workspace is read-only. They resume on their own once billing is fixed. {isOwner ? <Link href="/outreach/billing" className="underline font-medium">Update billing</Link> : 'The workspace owner can fix it on the Billing page.'}</span>}
        </div>
      )}
      {trialDays != null && trialDays <= 2 && !isClientViewer && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-sm px-6 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{trialDays <= 0 ? 'Your trial ends today.' : `Your trial ends in ${trialDays} day${trialDays === 1 ? '' : 's'}.`} Subscribe to keep your account connected. {isOwner ? <Link href={changeHref()} className="underline font-medium">Subscribe</Link> : 'The workspace owner can subscribe on the Billing page.'}</span>
        </div>
      )}
      {billing?.cancel_at_period_end && !suspended && isOwner && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-sm px-6 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> <span>Your subscription ends on {longDate(billing.current_period_end)}. <Link href="/outreach/billing" className="underline font-medium">Keep it</Link></span>
        </div>
      )}
      {workspace?.stripe_status === 'past_due' && !suspended && !isClientViewer && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-sm px-6 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> <span>Payment is past due. The workspace becomes read-only 7 days after the failed payment. <Link href="/outreach/billing" className="underline font-medium">Update billing</Link></span>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <div className="px-4 md:px-6 py-6 max-w-[1600px] mx-auto w-full">
          {billing?.access_blocked === 'client_viewer_plan' ? (
            <div className="max-w-xl mx-auto mt-16 text-center">
              <h1 className="text-lg font-semibold text-gray-900">Your agency&apos;s plan no longer includes client access</h1>
              <p className="text-sm text-gray-600 mt-2">Nothing was deleted. Your access comes back as soon as the agency&apos;s plan includes it again.{branding.support_email ? <> Questions: <a className="underline" href={`mailto:${branding.support_email}`}>{branding.support_email}</a></> : null}</p>
            </div>
          ) : children}
        </div>
      </div>
      <MentionToast items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
