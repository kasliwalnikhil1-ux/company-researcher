'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, MailX } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { Button, Card, ErrorBox, Spinner } from '@/components/outreach/ui';
import { CopyButton, CopyField, Note, SettingsFrame } from '@/components/outreach/settings/shared';
import TrackingDomainCard from '@/components/outreach/settings/TrackingDomainCard';
import { sk, useAiSettings } from '@/components/outreach/settings/hooks';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');

function bookingUrl(ws: string, secret: string, provider: 'calendly' | 'calcom') {
  return `${SUPABASE_URL}/functions/v1/outreach-booking-webhook?ws=${encodeURIComponent(ws)}&k=${encodeURIComponent(secret)}&p=${provider}`;
}

function Token({ children }: { children: string }) {
  return <span className="inline-flex items-center gap-1 align-middle"><code className="text-xs bg-gray-100 rounded px-1.5 py-0.5 text-gray-800">{children}</code><CopyButton value={children} label={`Copy ${children}`} className="w-6 h-6 border-0 bg-transparent" /></span>;
}

function UnsubscribeCard() {
  return (
    <Card title={<span className="flex items-center gap-2"><MailX className="w-4 h-4" /> Unsubscribe link</span>}>
      <div className="space-y-3 text-sm text-gray-700">
        <p>Put <Token>{'{{unsubscribe_link}}'}</Token> in every sequence email, for example in the footer: <span className="text-gray-500">&ldquo;Not relevant? {'<a href="{{unsubscribe_link}}">Unsubscribe</a>'}&rdquo;</span>.</p>
        <ul className="list-disc pl-5 space-y-1.5 text-gray-600">
          <li>Each link is signed for one lead. One click is enough: there is no login and no form.</li>
          <li>Emails that carry the link also get the one-click unsubscribe header, so Gmail and Outlook show their own Unsubscribe button next to the sender name.</li>
          <li>A click sets the lead&apos;s <strong>unsubscribed</strong> flag. That flag exits the lead from every sequence, cancels what is queued, and blocks future enrolment. The lead, its timeline and its conversations stay.</li>
          <li>The link is never rewritten for click tracking, so it stays short and trustworthy.</li>
          <li>The pre-launch check warns you when an email step has no unsubscribe link.</li>
        </ul>
        <p className="text-xs text-gray-500">Each unsubscribe also fires the <code>lead.unsubscribed</code> event for <Link href="/outreach/settings/webhooks" className="text-indigo-600 hover:underline">webhooks</Link>.</p>
      </div>
    </Card>
  );
}

function BookingCard() {
  const { workspace, isOwner, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const settings = useAiSettings(ws);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secret = settings.data?.booking_webhook_secret ?? null;

  async function createSecret() {
    if (!ws) return;
    setBusy(true); setError(null);
    try { await callFn('workspace-secrets', { workspace_id: ws, ensure: true }); await qc.invalidateQueries({ queryKey: sk.aiSettings(ws) }); }
    catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><CalendarCheck className="w-4 h-4" /> Meeting booking</span>}>
      <div className="space-y-4">
        <p className="text-sm text-gray-700">We do not replace your calendar. Keep Calendly or Cal.com, and tell it to notify us. When a lead books, the lead moves to the Meeting stage, its sequences end cleanly, the funnel counts the meeting and the <code className="text-xs">meeting.booked</code> event fires.</p>

        <ol className="space-y-4 text-sm text-gray-700 list-decimal pl-5">
          <li><strong>Give each sender a booking link.</strong> Open a sender, then Settings, and paste the link (it must start with https://).</li>
          <li>
            <strong>Use <Token>{'{{sender.booking_link}}'}</Token> in your messages.</strong> It adds the lead&apos;s id to the link as <code className="text-xs">utm_content</code>, which is how we know who booked. If you paste a booking link by hand, add <code className="text-xs">?utm_content=&lt;lead id&gt;</code> yourself. Without it we fall back to matching the invitee&apos;s email address.
          </li>
          <li>
            <strong>Add one of these webhook URLs in your booking tool.</strong>
            <div className="mt-3 space-y-3">
              {settings.isLoading ? <Spinner className="py-4" /> : settings.isError ? <ErrorBox message={parseError(settings.error).message} /> : !isOwner ? (
                <Note>The webhook URLs contain a secret, so only the workspace owner can see them.</Note>
              ) : !SUPABASE_URL ? (
                <ErrorBox message="NEXT_PUBLIC_SUPABASE_URL is not set, so the webhook URLs cannot be built." />
              ) : secret && ws ? (
                <>
                  <CopyField label="Calendly" value={bookingUrl(ws, secret, 'calendly')} secret hint="Create a webhook subscription for the events invitee.created and invitee.canceled (Calendly API or an integration tool; needs a paid Calendly plan)." />
                  <CopyField label="Cal.com" value={bookingUrl(ws, secret, 'calcom')} secret hint="Settings → Developer → Webhooks → New. Choose Booking created, Booking rescheduled and Booking cancelled." />
                  <p className="text-xs text-gray-500">The URLs are hidden on screen because they contain a secret. The copy buttons copy the full URL. Treat them like a password.</p>
                </>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-gray-600">This workspace has no webhook secret yet.</span>
                  <Button size="sm" onClick={createSecret} loading={busy} disabled={!canWrite}>Create webhook URLs</Button>
                </div>
              )}
              {error && <ErrorBox message={error} />}
            </div>
          </li>
        </ol>
        <p className="text-xs text-gray-500">A cancelled or rescheduled booking updates the record but does not move the lead back. The booking link is never rewritten for click tracking.</p>
      </div>
    </Card>
  );
}

export default function EmailSettingsPage() {
  return (
    <SettingsFrame min="manager">
      <div className="space-y-6 max-w-4xl">
        <TrackingDomainCard />
        <UnsubscribeCard />
        <BookingCard />
        <p className="text-xs text-gray-400">Mailbox signatures, BCC to CRM, mailbox pools and the separate email schedule are set per mailbox on the <Link href="/outreach/senders" className="text-indigo-600 hover:underline">Senders</Link> page. Tracking on manual replies is a <Link href="/outreach/settings/workspace" className="text-indigo-600 hover:underline">workspace setting</Link>.</p>
      </div>
    </SettingsFrame>
  );
}
