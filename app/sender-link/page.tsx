'use client';

// Public page for the account owner (sender-lifecycle-PRD.md §4, no login). Emails to a sender owner carry a signed single-use
// link here: "Disconnect my account" removes the sender (leads exit, the connector account is deleted, history stays) and
// "Request deletion of my data" files a request for the workspace owner. Opening the page changes nothing: mail scanners open
// every link. The buttons do, through the outreach-sender-owner-link function.
import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/outreach-sender-owner-link`;

type Brand = { product_name?: string; workspace_name?: string; logo_url?: string; accent?: string; support_email?: string };
type Info = { valid: boolean; used: boolean; expired: boolean; purpose: string; expires_at: string; sender: { id: string; name: string | null; provider: string; status: string; erase_scheduled_at: string | null }; workspace: { name: string | null }; branding: Brand };
type State = 'loading' | 'ready' | 'working' | 'disconnected' | 'pending' | 'requested' | 'invalid' | 'used' | 'expired' | 'error';
const CHANNEL: Record<string, string> = { LINKEDIN: 'LinkedIn account', INSTAGRAM: 'Instagram account', WHATSAPP: 'WhatsApp number', GMAIL: 'Gmail mailbox', OUTLOOK: 'Outlook mailbox', IMAP: 'mailbox' };

function Inner() {
  const params = useSearchParams();
  const t = params.get('t') ?? '';
  const [state, setState] = useState<State>('loading');
  const [info, setInfo] = useState<Info | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);

  useEffect(() => {
    if (!t) { setState('invalid'); return; }
    let cancelled = false;
    fetch(`${FN}?t=${encodeURIComponent(t)}`, { headers: { accept: 'application/json' } })
      .then(async (r) => ({ ok: r.ok, body: (await r.json().catch(() => ({}))) as Info & { ok?: boolean } }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok || !body.sender) { setState('invalid'); return; }
        setInfo(body);
        setState(body.used ? 'used' : body.expired ? 'expired' : 'ready');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [t]);

  async function act(action: 'disconnect' | 'erase_request') {
    setState('working');
    try {
      const r = await fetch(FN, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ t, action }) });
      const body = await r.json().catch(() => ({})) as { ok?: boolean; code?: string; state?: string };
      if (r.ok && body.ok) setState(action === 'disconnect' ? (body.state === 'removal_pending' ? 'pending' : 'disconnected') : 'requested');
      else if (r.status === 410) setState(body.code === 'E_LINK_EXPIRED' ? 'expired' : 'used');
      else if (r.status === 400) setState('invalid');
      else setState('error');
    } catch { setState('error'); }
  }

  const brand = info?.branding ?? {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(brand.accent ?? '') ? brand.accent! : '#1f2937';
  const brandName = brand.product_name || brand.workspace_name || info?.workspace.name || '';
  const senderName = info?.sender.name ?? 'your account';
  const channel = CHANNEL[info?.sender.provider ?? ''] ?? 'account';
  const alreadyGone = info?.sender.status === 'removed' || info?.sender.status === 'erased';
  const copy: Record<State, { title: string; body: string }> = {
    loading: { title: 'One moment', body: 'Checking your link.' },
    ready: { title: `Disconnect ${senderName} from ${brandName || 'this workspace'}?`, body: `This is the ${channel} connected to ${info?.workspace.name ?? 'the workspace'}. Disconnecting stops every message sent on your behalf, deletes the stored sign-in and unlinks the account. Conversations that already happened stay in the workspace's records; you can ask for them to be deleted below. The workspace is told.` },
    working: { title: 'Working', body: 'This takes a second.' },
    disconnected: { title: 'Your account is disconnected', body: `Nothing more is sent from ${senderName}. ${info?.sender.provider === 'LINKEDIN' ? 'LinkedIn may still list the session under “Where you’re signed in”; you can end it there.' : info?.sender.provider === 'WHATSAPP' ? 'On your phone, WhatsApp → Linked devices lets you log out the remaining device.' : ''} You can close this page.` },
    pending: { title: 'Disconnecting', body: `We asked the connector to unlink ${senderName}; it has not confirmed yet. Nothing more is sent in the meantime and we keep retrying. You can close this page.` },
    requested: { title: 'Deletion requested', body: `The workspace owner has been asked to delete the conversations and personal data of ${senderName}. They decide and schedule it; under the GDPR the answer is usually due within one month.` },
    invalid: { title: 'This link is not valid', body: 'The link is incomplete or has been changed. Use the link from the email again, or reply to the email.' },
    used: { title: 'This link was already used', body: 'Each link works once. If you need to act again, reply to the email you received.' },
    expired: { title: 'This link has expired', body: 'Links work for 30 days. Reply to the email you received to get a new one.' },
    error: { title: 'Something went wrong', body: 'We could not reach the server. Try again in a minute, or reply to the email.' },
  };

  return (
    <main className="min-h-screen bg-gray-50 flex items-start justify-center px-4">
      <div className="mt-[10vh] w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center">
        {brand.logo_url && /^https:\/\//.test(brand.logo_url)
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={brand.logo_url} alt={brandName} className="mx-auto max-h-9 max-w-[180px]" />
          : brandName ? <div className="text-lg font-semibold text-gray-900">{brandName}</div> : null}
        <h1 className="mt-5 text-xl font-semibold text-gray-900" aria-live="polite">{copy[state].title}</h1>
        <p className="mt-2 text-gray-600">{copy[state].body}</p>
        {state === 'ready' && (
          <div className="mt-6 space-y-3">
            {!alreadyGone && (
              <button type="button" onClick={() => act('disconnect')} style={{ backgroundColor: accent }}
                className="w-full rounded-lg px-6 py-2.5 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-500">
                Disconnect my account
              </button>
            )}
            {alreadyGone && <p className="text-sm text-gray-500">This account is already disconnected.</p>}
            {!info?.sender.erase_scheduled_at && (
              confirmErase ? (
                <div className="rounded-lg border border-gray-200 p-3 text-left text-sm text-gray-700">
                  <p>Ask the workspace to delete the conversations and personal data linked to {senderName}? This also disconnects the account if it is still connected. The workspace owner decides and schedules the deletion.</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => act('erase_request')} className="rounded-lg border border-red-300 px-4 py-2 text-red-700 hover:bg-red-50">Request deletion</button>
                    <button type="button" onClick={() => setConfirmErase(false)} className="rounded-lg px-4 py-2 text-gray-600 hover:bg-gray-100">Back</button>
                  </div>
                </div>
              ) : <button type="button" onClick={() => setConfirmErase(true)} className="text-sm text-gray-600 underline">Request deletion of my data</button>
            )}
            {info?.sender.erase_scheduled_at && <p className="text-sm text-gray-500">Deletion of this account’s data is already scheduled.</p>}
          </div>
        )}
        {state === 'error' && <button type="button" onClick={() => act('disconnect')} style={{ backgroundColor: accent }} className="mt-5 rounded-lg px-6 py-2.5 text-white">Try again</button>}
        {brand.support_email && <p className="mt-6 text-sm text-gray-500">Questions? Write to <a className="underline" href={`mailto:${brand.support_email}`}>{brand.support_email}</a>.</p>}
      </div>
    </main>
  );
}

export default function SenderLinkPage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
