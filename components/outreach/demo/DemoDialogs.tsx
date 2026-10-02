'use client';

/**
 * The fake external steps of the product tour: connecting an account, a checkout and a consent screen. They stand in
 * for the provider's hosted pages, Stripe and a CRM's OAuth screen. Nothing here leaves the browser.
 */
import { useEffect, useState } from 'react';
import { CreditCard, Lock, ShieldCheck } from 'lucide-react';
import { Button, Input, Modal } from '@/components/outreach/ui';
import type { DemoDialog } from '@/lib/outreach/demoUi';

const PROVIDER_LABEL: Record<string, string> = { LINKEDIN: 'LinkedIn', GMAIL: 'Gmail', OUTLOOK: 'Outlook', IMAP: 'email (IMAP)', WHATSAPP: 'WhatsApp', INSTAGRAM: 'Instagram' };

function Note() {
  return <p className="text-xs text-gray-500 flex items-start gap-1.5 mt-4"><Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> This is a demo. No account is connected, no payment is taken and nothing leaves your browser.</p>;
}

function Connect({ d, onDone }: { d: Extract<DemoDialog, { kind: 'connect' }>; onDone: (ok: boolean) => void }) {
  const label = PROVIDER_LABEL[d.provider?.toUpperCase()] ?? d.provider;
  const [busy, setBusy] = useState(false);
  const isPhone = d.provider?.toUpperCase() === 'WHATSAPP';
  return (
    <Modal open onClose={() => onDone(false)} title={`Connect ${label} (demo)`} size="sm"
      footer={<><Button variant="secondary" onClick={() => onDone(false)}>Cancel</Button><Button loading={busy} onClick={() => { setBusy(true); setTimeout(() => onDone(true), 700); }} data-demo-connect>Connect demo account</Button></>}>
      <div className="space-y-3">
        {isPhone ? (
          <div className="flex flex-col items-center gap-2 py-2">
            <div className="w-36 h-36 grid grid-cols-6 gap-0.5 p-2 bg-white border border-gray-200 rounded-lg" aria-label="Sample QR code">
              {Array.from({ length: 36 }, (_, i) => <span key={i} className={(i * 7 + (i % 5)) % 3 ? 'bg-gray-900' : 'bg-white'} />)}
            </div>
            <p className="text-sm text-gray-600 text-center">In the product you scan this code with WhatsApp on your phone.</p>
          </div>
        ) : (
          <>
            <Input label={d.provider?.toUpperCase() === 'INSTAGRAM' ? 'Username' : 'Email'} value={d.provider?.toUpperCase() === 'INSTAGRAM' ? 'demo.account' : 'demo.account@example.com'} readOnly />
            <Input label="Password" type="password" value="demo-password" readOnly />
          </>
        )}
      </div>
      <Note />
    </Modal>
  );
}

function Checkout({ d, onDone }: { d: Extract<DemoDialog, { kind: 'checkout' }>; onDone: (ok: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={() => onDone(false)} title={d.title || 'Checkout (demo)'} size="sm"
      footer={<><Button variant="secondary" onClick={() => onDone(false)}>Cancel</Button><Button loading={busy} onClick={() => { setBusy(true); setTimeout(() => onDone(true), 800); }} data-demo-pay>{d.amount ? `Pay ${d.amount} (demo)` : 'Confirm (demo)'}</Button></>}>
      {d.lines?.length ? <ul className="text-sm text-gray-700 space-y-1 mb-4">{d.lines.map((l) => <li key={l}>{l}</li>)}</ul> : null}
      <div className="rounded-lg border border-gray-200 p-3 flex items-center gap-3 text-sm text-gray-700">
        <CreditCard className="w-5 h-5 text-gray-400" /> <span className="font-mono">4242 •••• •••• 4242</span> <span className="ml-auto text-gray-400">12/34</span>
      </div>
      <Note />
    </Modal>
  );
}

function Consent({ d, onDone }: { d: Extract<DemoDialog, { kind: 'consent' }>; onDone: (ok: boolean) => void }) {
  return (
    <Modal open onClose={() => onDone(false)} title={`Connect ${d.app} (demo)`} size="sm"
      footer={<><Button variant="secondary" onClick={() => onDone(false)}>Cancel</Button><Button onClick={() => onDone(true)} data-demo-allow>Allow (demo)</Button></>}>
      <p className="text-sm text-gray-700 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-600" /> {d.app} would be able to:</p>
      <ul className="list-disc pl-6 mt-2 text-sm text-gray-600 space-y-1">{(d.scopes?.length ? d.scopes : ['Read and update contacts', 'Log outreach activity']).map((s) => <li key={s}>{s}</li>)}</ul>
      <Note />
    </Modal>
  );
}

export default function DemoDialogs({ pending, onDone }: { pending: { d: DemoDialog } | null; onDone: (ok: boolean) => void }) {
  // a dialog opened by a handler blocks the page like the real external step would
  useEffect(() => { if (!pending) return; const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = prev; }; }, [pending]);
  if (!pending) return null;
  const d = pending.d;
  if (d.kind === 'connect') return <Connect d={d} onDone={onDone} />;
  if (d.kind === 'checkout') return <Checkout d={d} onDone={onDone} />;
  return <Consent d={d} onDone={onDone} />;
}
