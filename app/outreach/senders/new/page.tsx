'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, KeyRound, Linkedin, Mail, MonitorSmartphone } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients } from '@/lib/outreach/queries';
import { callFn, parseError } from '@/lib/outreach/api';
import { BackLink, Button, Card, ErrorBox, Input, PageHeader, SearchableSelect, Select, Toggle, useToast } from '@/components/outreach/ui';
import { browserTimezone, copyText, timezoneChoices } from '@/components/outreach/senders/helpers';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { cn } from '@/lib/utils';
import type { Provider } from '@/lib/outreach/types';
import { BROWSER_SIGNIN_ENABLED } from '@/lib/outreach/features';

type ConnectMethod = 'credentials' | 'browser';

const CONNECT_METHODS: Array<{ id: ConnectMethod; label: string; description: string; icon: React.ReactNode }> = [
  { id: 'credentials', label: 'Sign in with LinkedIn', description: 'The account owner signs in with their LinkedIn email and password, plus any code LinkedIn asks for. Works in any browser.', icon: <KeyRound className="w-4 h-4" /> },
  { id: 'browser', label: 'Use the browser they’re already signed in on', description: 'The account owner installs a small browser add-on and approves the LinkedIn account already open on their computer. No password is typed anywhere.', icon: <MonitorSmartphone className="w-4 h-4" /> },
];

const PROVIDERS: Array<{ id: Provider; label: string; description: string; icon: React.ReactNode }> = [
  { id: 'LINKEDIN', label: 'LinkedIn', description: 'Connection requests, messages, profile views and InMail. Activity starts low and ramps up safely.', icon: <Linkedin className="w-5 h-5" /> },
  { id: 'INSTAGRAM', label: 'Instagram', description: 'Follows, likes, comments and direct messages. At most 10 actions an hour and 100 a day; new accounts start slower.', icon: <ProviderLogo provider="INSTAGRAM" className="w-5 h-5" /> },
  { id: 'WHATSAPP', label: 'WhatsApp', description: 'Conversations with people who agreed to hear from you. Messages to new people need a recorded consent. After connecting, outreach waits 24 hours.', icon: <ProviderLogo provider="WHATSAPP" className="w-5 h-5" /> },
  { id: 'GMAIL', label: 'Gmail', description: 'Google Workspace or personal Gmail. Used for email steps.', icon: <Mail className="w-5 h-5" /> },
  { id: 'OUTLOOK', label: 'Outlook', description: 'Microsoft 365 or Outlook.com. Used for email steps.', icon: <Mail className="w-5 h-5" /> },
  { id: 'IMAP', label: 'Other email', description: 'Any other inbox, using the mail server details from your email provider.', icon: <Mail className="w-5 h-5" /> },
];

const LEGAL_LINKS = [
  { label: 'Terms of Service', href: 'https://growthxai.com/legal/terms/' },
  { label: 'Acceptable Use Policy', href: 'https://growthxai.com/legal/acceptable-use/' },
  { label: 'Disclosure', href: 'https://growthxai.com/legal/disclosure/' },
];

export default function ConnectSenderPage() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const clients = useClients(ws);
  const toast = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<Provider>('LINKEDIN');
  const [connectMethodChoice, setConnectMethod] = useState<ConnectMethod>('credentials');
  const connectMethod: ConnectMethod = BROWSER_SIGNIN_ENABLED ? connectMethodChoice : 'credentials';
  const [acknowledged, setAcknowledged] = useState(false);
  const [clientId, setClientId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone());
  const [recruiter, setRecruiter] = useState(false);
  // WhatsApp: the number must be at least 6 months old with real conversations (PRD §7.4). Both fields are required.
  const [ageAttested, setAgeAttested] = useState(false);
  const [ageMonths, setAgeMonths] = useState('');
  const [launching, setLaunching] = useState<'redirect' | 'copy' | null>(null);
  const [result, setResult] = useState<{ link: string; sender_id: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tzList = useMemo(() => timezoneChoices(), []);
  const recruiterEnabled = !!(workspace?.settings as Record<string, unknown> | undefined)?.recruiter_enabled;
  const emailOk = !ownerEmail || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail);
  const isWhatsApp = provider === 'WHATSAPP';
  const isInstagram = provider === 'INSTAGRAM';
  const isMailbox = !['LINKEDIN', 'INSTAGRAM', 'WHATSAPP'].includes(provider);
  const monthsNum = Number(ageMonths);
  const monthsOk = ageMonths !== '' && Number.isInteger(monthsNum) && monthsNum >= 6;
  const attestationOk = !isWhatsApp || (ageAttested && monthsOk);

  if (!isManager || !canWrite) {
    return (
      <div>
        <BackLink href="/outreach/senders">Back to senders</BackLink>
        <PageHeader title="Connect an account" />
        <ErrorBox message={canWrite ? 'Only owners and managers can connect accounts.' : 'This workspace is read-only right now, so new accounts cannot be connected.'} />
      </div>
    );
  }

  async function ensureLink(): Promise<{ link: string; sender_id: string }> {
    if (result) return result;
    const r = await callFn<{ link: string; sender_id: string }>('sender-connect', {
      workspace_id: ws, provider, client_id: clientId || null, owner_email: ownerEmail.trim() || null, display_name: displayName.trim() || null,
      recruiter: provider === 'LINKEDIN' && recruiterEnabled ? recruiter : false, timezone,
      connect_method: provider === 'LINKEDIN' ? connectMethod : 'credentials',
      ...(isWhatsApp ? { account_age_months: monthsNum, account_age_attested: true } : {}),
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
      toast.show(ok ? 'Link copied. It expires in 15 minutes.' : 'Could not copy automatically. Copy the link below instead.', ok ? 'success' : 'error');
    } catch (e) {
      setError(parseError(e).message);
    } finally { setLaunching(null); }
  }

  const steps = ['Account', 'Details', 'Sign in'];
  const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label ?? 'LinkedIn';
  const heading = provider === 'LINKEDIN' ? 'Connect your LinkedIn account' : isInstagram ? 'Connect your Instagram account' : isWhatsApp ? 'Connect your WhatsApp number' : provider === 'IMAP' ? 'Connect your email inbox' : `Connect your ${providerLabel} inbox`;
  const subtitle = provider === 'LINKEDIN' ? 'Connect your account to start outreach and manage conversations here.'
    : isInstagram ? 'Connect the account to follow, engage and message from your sequences, with limits that keep it safe.'
      : isWhatsApp ? 'Connect the number to message people who agreed to hear from you, and answer them here.'
        : 'Connect your inbox to send and receive email from your sequences here.';
  const connectLabel = provider === 'LINKEDIN' ? 'Connect LinkedIn' : isInstagram ? 'Connect Instagram' : isWhatsApp ? 'Connect WhatsApp' : `Connect ${providerLabel}`;

  return (
    <div className="max-w-6xl">
      <BackLink href="/outreach/senders">Back to senders</BackLink>
      <PageHeader title={heading} subtitle={subtitle} />

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
        <Card title="1. What would you like to connect?">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-5">
            {PROVIDERS.map((p) => (
              <button key={p.id} type="button" onClick={() => setProvider(p.id)} aria-pressed={provider === p.id}
                className={cn('text-left p-4 rounded-xl border transition-colors', provider === p.id ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-gray-200 hover:bg-gray-50')}>
                <div className="flex items-center gap-2 font-semibold text-gray-900">{p.icon} {p.label}</div>
                <div className="text-xs text-gray-500 mt-1">{p.description}</div>
              </button>
            ))}
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>
              I have the account owner&apos;s permission and agree to the{' '}
              {LEGAL_LINKS.map((l, i) => (
                <span key={l.href}>
                  <a href={l.href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-800 underline">{l.label}</a>
                  {i < LEGAL_LINKS.length - 2 ? ', ' : i === LEGAL_LINKS.length - 2 ? ', and ' : '.'}
                </span>
              ))}
            </span>
          </label>
          <div className="flex justify-end mt-5"><Button disabled={!acknowledged} onClick={() => setStep(2)}>Continue <ArrowRight className="w-4 h-4" /></Button></div>
        </Card>
      )}

      {step === 2 && (
        <Card title="2. Account details">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
            <Input label="Display name" placeholder={provider === 'LINKEDIN' ? 'e.g. Jane (Sales)' : isInstagram ? 'e.g. @acme.studio' : isWhatsApp ? 'e.g. Jane’s WhatsApp' : 'e.g. jane@acme.com'} value={displayName} onChange={(e) => setDisplayName(e.target.value)} hint="Shown in lists and the inbox. The real profile name is filled in once the account is connected." />
            <Input label="Owner email" type="email" placeholder="owner@company.com" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} error={emailOk ? undefined : 'Enter a valid email address'}
              hint="The person who owns this account. They sign in themselves. We email them here if the account ever needs to be signed in again." />
            <div>
              <SearchableSelect label="Timezone" value={timezone} onChange={setTimezone} options={tzList} searchPlaceholder="Search city, region or GMT offset…" />
              <div className="text-xs text-gray-500 mt-1">Outreach is sent during the account owner&apos;s working hours (Mon–Fri, 9am–6pm by default). Choose where they actually work. You can change the hours later.</div>
            </div>
            <div>
              <Select label="Client (optional)" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">No client (shared across the workspace)</option>
                {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <div className="text-xs text-gray-500 mt-1">Assign this account to a client to keep it inside that client&apos;s campaigns and reports. Leave empty to share it across the workspace.</div>
            </div>
            {provider === 'LINKEDIN' && BROWSER_SIGNIN_ENABLED && (
              <div className="md:col-span-2">
                <div className="text-sm font-medium text-gray-900 mb-2">How will the account owner sign in?</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {CONNECT_METHODS.map((m) => (
                    <button key={m.id} type="button" onClick={() => setConnectMethod(m.id)} aria-pressed={connectMethod === m.id}
                      className={cn('text-left p-4 rounded-xl border transition-colors', connectMethod === m.id ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-gray-200 hover:bg-gray-50')}>
                      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">{m.icon} {m.label}</div>
                      <div className="text-xs text-gray-500 mt-1">{m.description}</div>
                    </button>
                  ))}
                </div>
                <div className="text-xs text-gray-500 mt-2">Both options connect the account the same way, and the owner can disconnect it at any time.</div>
              </div>
            )}
            {isWhatsApp && (
              <div className="md:col-span-2 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="text-sm font-semibold text-gray-900">Number age (required)</div>
                <p className="text-xs text-gray-600 mt-1">Fresh numbers get restricted after two or three new conversations. We only run outreach from numbers that have been in real use for at least 6 months, and the first level allows 2 new conversations a day until the number proves itself.</p>
                <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer mt-3">
                  <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" checked={ageAttested} onChange={(e) => setAgeAttested(e.target.checked)} />
                  <span>This number is at least 6 months old and has real conversations on it</span>
                </label>
                <div className="mt-3 max-w-xs">
                  <Input label="Months in use" type="number" min={6} step={1} inputMode="numeric" placeholder="e.g. 18" value={ageMonths} onChange={(e) => setAgeMonths(e.target.value)}
                    error={ageMonths !== '' && !monthsOk ? 'Enter a whole number of at least 6' : undefined} hint="Recorded with your name and the date. It appears on the number’s page." />
                </div>
              </div>
            )}
            {isInstagram && (
              <div className="md:col-span-2 rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600 space-y-1">
                <div className="text-sm font-semibold text-gray-900">How Instagram ramps up</div>
                <p>The account starts at level 0: it can follow, like and view profiles, but not send direct messages yet. Levels rise as health stays high. Every level keeps to 10 actions an hour.</p>
                <p>If Instagram flags automated behaviour, outreach pauses for 48 hours and drops one level. You can resume earlier from the account’s page if you accept the risk.</p>
              </div>
            )}
            {provider === 'LINKEDIN' && recruiterEnabled && (
              <div className="md:col-span-2 flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-gray-900">This account has a LinkedIn Recruiter seat</div>
                  <div className="text-xs text-gray-500">Turn this on only if the account pays for LinkedIn Recruiter.</div>
                </div>
                <Toggle checked={recruiter} onChange={setRecruiter} />
              </div>
            )}
          </div>
          <div className="flex justify-between mt-5">
            <Button variant="secondary" onClick={() => setStep(1)}><ArrowLeft className="w-4 h-4" /> Back</Button>
            <Button disabled={!emailOk || !attestationOk} onClick={() => setStep(3)} title={!attestationOk ? 'Tick the attestation and enter the months in use to continue' : undefined}>Continue <ArrowRight className="w-4 h-4" /></Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card title="3. Sign in to connect">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-5">
            <dt className="text-gray-500">Account type</dt><dd className="text-gray-900 font-medium">{PROVIDERS.find((p) => p.id === provider)?.label}</dd>
            {clientId && (<><dt className="text-gray-500">Client</dt><dd className="text-gray-900">{clients.data?.find((c) => c.id === clientId)?.name ?? '—'}</dd></>)}
            {displayName && (<><dt className="text-gray-500">Display name</dt><dd className="text-gray-900">{displayName}</dd></>)}
            {ownerEmail && (<><dt className="text-gray-500">Owner email</dt><dd className="text-gray-900">{ownerEmail}</dd></>)}
            <dt className="text-gray-500">Timezone</dt><dd className="text-gray-900">{timezone}</dd>
            {provider === 'LINKEDIN' && BROWSER_SIGNIN_ENABLED && (<><dt className="text-gray-500">Sign-in</dt><dd className="text-gray-900">{CONNECT_METHODS.find((m) => m.id === connectMethod)?.label}</dd></>)}
            {provider === 'LINKEDIN' && recruiterEnabled && (<><dt className="text-gray-500">Recruiter</dt><dd className="text-gray-900">{recruiter ? 'Enabled' : 'Disabled'}</dd></>)}
            {isWhatsApp && (<><dt className="text-gray-500">Number age</dt><dd className="text-gray-900">{ageMonths} months, attested</dd></>)}
          </dl>
          <div className="rounded-lg bg-gray-50 border border-gray-200 p-4 text-sm text-gray-700 space-y-1.5 mb-5">
            <p>You’ll be taken to a secure sign-in page. {isWhatsApp ? 'You will see a QR code (or a pairing code) on the sign-in page. Open WhatsApp on the phone → Linked devices → Link a device and scan it.' : isInstagram ? 'Sign in with the Instagram username and password; complete any code Instagram asks for.' : isMailbox ? 'Sign in to your inbox and allow access, then return here to finish connecting.' : connectMethod === 'browser' ? 'Install the browser add-on if asked, approve the LinkedIn account already open in that browser, then return here to finish connecting. If the page cannot find the add-on on its own, it shows a short code to paste into the add-on under “Link a profile”.' : 'Complete any verification LinkedIn asks for, then return here to finish connecting.'}</p>
            {isWhatsApp && <p>Once linked, the number rests for <strong>24 hours</strong> before any outreach goes out. Replies to people who write in are not held back.</p>}
            <p>The link <strong>expires in 15 minutes</strong>. Once the sign-in is done you’ll land on the new account’s page. If something goes wrong, you can create a fresh link from there.</p>
            <p>Connecting someone else’s account? Use <strong>Copy sign-in link</strong> and send it to the account owner so they can sign in themselves. {isWhatsApp ? 'They need the phone with the number to hand.' : 'The proxy is pinned to the country of whoever opens the link.'}</p>
          </div>
          {error && <ErrorBox message={error} className="mb-4" />}
          {result && (
            <div className="mb-4">
              <div className="text-xs font-medium text-gray-600 mb-1">Sign-in link (valid for 15 minutes)</div>
              <div className="flex gap-2">
                <input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 bg-gray-50 text-gray-700" aria-label="Sign-in link" />
                <Button variant="secondary" onClick={() => launch('copy')} loading={launching === 'copy'}>{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} Copy</Button>
              </div>
              <div className="text-xs text-gray-500 mt-1">The account now shows as <Link href={`/outreach/senders/${result.sender_id}`} className="text-indigo-600 hover:underline">connecting</Link>. It becomes active once the sign-in is complete.</div>
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="secondary" onClick={() => setStep(2)} disabled={!!result}><ArrowLeft className="w-4 h-4" /> Back</Button>
            <div className="flex gap-2">
              {!result && <Button variant="secondary" onClick={() => launch('copy')} loading={launching === 'copy'} disabled={!!launching}><Copy className="w-4 h-4" /> Copy sign-in link</Button>}
              <Button onClick={() => launch('redirect')} loading={launching === 'redirect'} disabled={!!launching}><ExternalLink className="w-4 h-4" /> {connectLabel}</Button>
            </div>
          </div>
        </Card>
      )}
      {toast.node}
    </div>
  );
}
