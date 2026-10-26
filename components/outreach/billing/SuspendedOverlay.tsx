'use client';

// The full-screen notice an owner sees while the workspace is paused for billing (sender-lifecycle-PRD v1.2 §5.9.3):
// Pay invoice (the Stripe hosted invoice, no login), Update card (the Billing page), Export data. Dismissible for the
// session; the app behind it stays read-only until payment is updated.
import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { AlertTriangle, CreditCard, Download, ExternalLink } from 'lucide-react';
import { Button } from '@/components/outreach/ui';
import { longDate, type BillingClock } from '@/lib/outreach/billing';

const KEY = (ws: string) => `outreach-suspended-seen:${ws}`;

export function SuspendedOverlay({ clock, workspaceId }: { clock: BillingClock; workspaceId: string }) {
  const [dismissed, setDismissed] = useState(() => { try { return window.sessionStorage.getItem(KEY(workspaceId)) === '1'; } catch { return false; } });
  if (dismissed) return null;
  const remove = clock.steps.find((s) => s.step === 'remove');
  const erase = clock.steps.find((s) => s.step === 'erase');
  const close = () => { setDismissed(true); try { window.sessionStorage.setItem(KEY(workspaceId), '1'); } catch { /* ignore */ } };
  return (
    <div className="fixed inset-0 z-50 bg-gray-900/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="suspended-title">
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6">
        <div className="flex items-start gap-3">
          <span className="w-9 h-9 rounded-full bg-red-100 text-red-700 flex items-center justify-center shrink-0"><AlertTriangle className="w-5 h-5" /></span>
          <div className="min-w-0">
            <h2 id="suspended-title" className="text-lg font-semibold text-gray-900">Your workspace is paused</h2>
            <p className="text-sm text-gray-600 mt-1">The invoice is still unpaid{clock.past_due_since ? ` since ${longDate(clock.past_due_since)}` : ''}. Nothing is sent, nothing can be edited or enrolled; your inbox, leads, reports and exports stay readable. Replies keep arriving; pay to answer them.</p>
            <ul className="text-sm text-gray-700 mt-3 space-y-1">
              {remove && !remove.done && <li>Connected accounts are disconnected on <strong>{longDate(remove.at)}</strong> (history kept).</li>}
              {remove?.done && <li>Your connected accounts were disconnected. Whoever signs in to each one gets a sign-in link once payment is updated; its history comes back.</li>}
              {erase && <li>Workspace data is deleted on <strong>{longDate(erase.at)}</strong> unless paid or exported before then.</li>}
            </ul>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-5">
          {clock.overdue_invoice_url && <a href={clock.overdue_invoice_url} target="_blank" rel="noopener noreferrer"><Button><ExternalLink className="w-4 h-4" /> Pay invoice</Button></a>}
          <Link href="/outreach/billing" onClick={close}><Button variant={clock.overdue_invoice_url ? 'secondary' : 'primary'}><CreditCard className="w-4 h-4" /> Update card</Button></Link>
          <Link href="/outreach/settings/workspace" onClick={close}><Button variant="secondary"><Download className="w-4 h-4" /> Export data</Button></Link>
          <span className="flex-1" />
          <Button variant="ghost" onClick={close}>Continue read-only</Button>
        </div>
      </div>
    </div>
  );
}
