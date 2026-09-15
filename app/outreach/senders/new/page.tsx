'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, Linkedin, Mail, ShieldAlert } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients } from '@/lib/outreach/queries';
import { callFn, parseError } from '@/lib/outreach/api';
import { Button, Card, ErrorBox, Input, PageHeader, Select, Toggle, useToast } from '@/components/outreach/ui';
import { browserTimezone, copyText, timezoneOptions } from '@/components/outreach/senders/helpers';
import { cn } from '@/lib/utils';
import type { Provider } from '@/lib/outreach/types';

const PROVIDERS: Array<{ id: Provider; label: string; description: string; icon: React.ReactNode }> = [
  { id: 'LINKEDIN', label: 'LinkedIn', description: 'Invitations, messages, profile views, InMail. Warms up from level 0.', icon: <Linkedin className="w-5 h-5" /> },
  { id: 'GMAIL', label: 'Gmail', description: 'Google Workspace or personal Gmail via OAuth. Used for email steps.', icon: <Mail className="w-5 h-5" /> },
  { id: 'OUTLOOK', label: 'Outlook', description: 'Microsoft 365 / Outlook.com via OAuth. Used for email steps.', icon: <Mail className="w-5 h-5" /> },
  { id: 'IMAP', label: 'IMAP / SMTP', description: 'Any other mailbox with IMAP and SMTP credentials.', icon: <Mail className="w-5 h-5" /> },
];

const LEGAL_POINTS = [
  'This product is not affiliated with, endorsed by, or sponsored by LinkedIn.',
  'Automating actions on a LinkedIn account breaches LinkedIn\'s User Agreement. LinkedIn may restrict or permanently close accounts that automate activity.',
  'The account holder bears the restriction risk. Keep volumes conservative, let the warm-up run, and never share one account across several people.',
  'A session token for the account is held on the account holder\'s behalf so we can act as them. It is revocable at any time from the sender page (Disable) or by logging out of LinkedIn.',
  'No identity rental: you may only connect accounts whose owner has agreed to this use. Do not connect purchased, borrowed or fabricated accounts.',
];

export default function ConnectSenderPage() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const clients = useClients(ws);
  const toast = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<Provider>('LINKEDIN');
  const [acknowledged, setAcknowledged] = useState(false);
  const [clientId, setClientId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone());
  const [recruiter, setRecruiter] = useState(false);
  const [launching, setLaunching] = useState<'redirect' | 'copy' | null>(null);
  const [result, setResult] = useState<{ link: string; sender_id: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tzList = useMemo(() => timezoneOptions(), []);
  const recruiterEnabled = !!(workspace?.settings as Record<string, unknown> | undefined)?.recruiter_enabled;
  const emailOk = !ownerEmail || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail);

  if (!isManager || !canWrite) {
    return (
      <div>
        <PageHeader title="Connect sender" />
        <ErrorBox message={canWrite ? 'Only owners and managers can connect senders.' : 'This workspace is read-only right now, so new senders cannot be connected.'} />
        <Link href="/outreach/senders" className="inline-block mt-4 text-sm text-indigo-600 hover:underline">Back to senders</Link>
      </div>
    );
  }

  async function ensureLink(): Promise<{ link: string; sender_id: string }> {
    if (result) return result;
    const r = await callFn<{ link: string; sender_id: string }>('sender-connect', {
      workspace_id: ws, provider, client_id: clientId || null, owner_email: ownerEmail.trim() || null, display_name: displayName.trim() || null,
      recruiter: provider === 'LINKEDIN' && recruiterEnabled ? recruiter : false, timezone,
    });
    setResult(r);
    return r;
  }

  async function launch(mode: 'redirect' | 'copy') {
    setLaunching(mode); setError(null);
    try {
      const r = await ensureLink();
      if (mode === 'redirect') { window.location.href = r.link; return; }
      const ok = await copyText(r.link);
      setCopied(ok);
      toast.show(ok ? 'Link copied — it expires in 15 minutes.' : 'Could not copy automatically; copy the link below.', ok ? 'success' : 'error');
    } catch (e) {
      setError(parseError(e).message);
    } finally { setLaunching(null); }
  }

  const steps = ['Provider', 'Details', 'Launch'];

  return (
    <div className="max-w-3xl">
      <PageHeader title="Connect sender" subtitle="Add a LinkedIn account or mailbox through Unipile's hosted login" actions={<Link href="/outreach/senders"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /> Senders</Button></Link>} />

      <ol className="flex items-center gap-2 mb-6 text-sm">
        {steps.map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3; const active = step === n; const done = step > n;
          return (
            <li key={label} className="flex items-center gap-2">
              <span className={cn('w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold', active ? 'bg-indigo-600 text-white' : done ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500')}>{done ? <Check className="w-3.5 h-3.5" /> : n}</span>
              <span className={cn(active ? 'text-gray-900 font-medium' : 'text-gray-500')}>{label}</span>
              {i < steps.length - 1 && <span className="w-6 h-px bg-gray-200 mx-1" />}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <Card title="1. Choose what to connect">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
            {PROVIDERS.map((p) => (
              <button key={p.id} type="button" onClick={() => setProvider(p.id)} aria-pressed={provider === p.id}
                className={cn('text-left p-4 rounded-xl border transition-colors', provider === p.id ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-gray-200 hover:bg-gray-50')}>
                <div className="flex items-center gap-2 font-semibold text-gray-900">{p.icon} {p.label}</div>
                <div className="text-xs text-gray-500 mt-1">{p.description}</div>
              </button>
            ))}
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 mb-2"><ShieldAlert className="w-4 h-4" /> Please read before connecting</div>
            <ul className="list-disc pl-5 space-y-1 text-sm text-amber-900">{LEGAL_POINTS.map((t) => <li key={t}>{t}</li>)}</ul>
            <label className="flex items-start gap-2 mt-3 text-sm text-gray-800 cursor-pointer">
              <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              <span>I have read the notice above, I have the account owner's consent, and I understand the account holder bears the restriction risk.</span>
            </label>
          </div>
          <div className="flex justify-end mt-5"><Button disabled={!acknowledged} onClick={() => setStep(2)}>Continue <ArrowRight className="w-4 h-4" /></Button></div>
        </Card>
      )}

      {step === 2 && (
        <Card title="2. Sender details">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select label="Client (optional)" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">No client — shared across the workspace</option>
              {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input label="Display name" placeholder={provider === 'LINKEDIN' ? 'e.g. Jane (Sales)' : 'e.g. jane@acme.com'} value={displayName} onChange={(e) => setDisplayName(e.target.value)} hint="Shown in tables and the inbox. The real profile name is pulled in after connection." />
            <div className="md:col-span-2">
              <Input label="Owner email" type="email" placeholder="owner@company.com" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} error={emailOk ? undefined : 'Enter a valid email address'}
                hint="The person who owns this account — they will log in themselves; you never see their password. Re-login reminders and pairing instructions are emailed here." />
            </div>
            <Select label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {!tzList.includes(timezone) && <option value={timezone}>{timezone}</option>}
              {tzList.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </Select>
            <div className="text-xs text-gray-500 md:pt-6">Actions are scheduled inside the sender's local working hours (default Mon–Fri 09:00–18:00). Pick the timezone where the account owner actually works; you can refine the windows later.</div>
            {provider === 'LINKEDIN' && recruiterEnabled && (
              <div className="md:col-span-2 flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-gray-900">Enable LinkedIn Recruiter features</div>
                  <div className="text-xs text-gray-500">Only for accounts with a Recruiter seat. Leaves the Recruiter product enabled in the hosted login.</div>
                </div>
                <Toggle checked={recruiter} onChange={setRecruiter} />
              </div>
            )}
          </div>
          <div className="flex justify-between mt-5">
            <Button variant="secondary" onClick={() => setStep(1)}><ArrowLeft className="w-4 h-4" /> Back</Button>
            <Button disabled={!emailOk} onClick={() => setStep(3)}>Continue <ArrowRight className="w-4 h-4" /></Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card title="3. Launch hosted login">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-5">
            <dt className="text-gray-500">Provider</dt><dd className="text-gray-900 font-medium">{PROVIDERS.find((p) => p.id === provider)?.label}</dd>
            <dt className="text-gray-500">Client</dt><dd className="text-gray-900">{clientId ? clients.data?.find((c) => c.id === clientId)?.name ?? '—' : 'None'}</dd>
            <dt className="text-gray-500">Display name</dt><dd className="text-gray-900">{displayName || <span className="text-gray-400">auto</span>}</dd>
            <dt className="text-gray-500">Owner email</dt><dd className="text-gray-900">{ownerEmail || <span className="text-gray-400">not set</span>}</dd>
            <dt className="text-gray-500">Timezone</dt><dd className="text-gray-900">{timezone}</dd>
            {provider === 'LINKEDIN' && recruiterEnabled && (<><dt className="text-gray-500">Recruiter</dt><dd className="text-gray-900">{recruiter ? 'Enabled' : 'Disabled'}</dd></>)}
          </dl>
          <div className="rounded-lg bg-gray-50 border border-gray-200 p-4 text-sm text-gray-700 space-y-1.5 mb-5">
            <p>Clicking <strong>Open hosted login</strong> creates a one-time link that opens Unipile's hosted login page. {provider === 'LINKEDIN' ? 'The account owner signs in to LinkedIn there (including any 2FA / verification code).' : 'The mailbox owner authorises access there via OAuth.'} Credentials never touch this app.</p>
            <p>The link <strong>expires in 15 minutes</strong>. When the login succeeds you are redirected back to the new sender's page; if it fails you can generate a fresh link from there.</p>
            <p>If someone else owns the account, use <strong>Copy link</strong> and send it to them instead of opening it yourself — the proxy is pinned to the country of whoever opens the link.</p>
          </div>
          {error && <ErrorBox message={error} className="mb-4" />}
          {result && (
            <div className="mb-4">
              <div className="text-xs font-medium text-gray-600 mb-1">Hosted login link (valid 15 minutes)</div>
              <div className="flex gap-2">
                <input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 bg-gray-50 text-gray-700" aria-label="Hosted login link" />
                <Button variant="secondary" onClick={() => launch('copy')} loading={launching === 'copy'}>{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} Copy</Button>
              </div>
              <div className="text-xs text-gray-500 mt-1">Sender created as <Link href={`/outreach/senders/${result.sender_id}`} className="text-indigo-600 hover:underline">connecting</Link>; it turns green once the login completes.</div>
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="secondary" onClick={() => setStep(2)} disabled={!!result}><ArrowLeft className="w-4 h-4" /> Back</Button>
            <div className="flex gap-2">
              {!result && <Button variant="secondary" onClick={() => launch('copy')} loading={launching === 'copy'} disabled={!!launching}><Copy className="w-4 h-4" /> Copy link to send to the sender owner</Button>}
              <Button onClick={() => launch('redirect')} loading={launching === 'redirect'} disabled={!!launching}><ExternalLink className="w-4 h-4" /> Open hosted login</Button>
            </div>
          </div>
        </Card>
      )}
      {toast.node}
    </div>
  );
}
