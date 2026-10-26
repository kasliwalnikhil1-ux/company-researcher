'use client';

// Settings → Email & booking → sending domain (custom-sending-domain-PRD.md §4, §8.1), also used per client (§4.3) with
// `clientId`. Steps: choose the domain → add the DNS records → verify → sender identity → send a test → turn on. Pause /
// Resume / Remove and the paused banner. The read-only lists of which emails use a brand domain and which always come
// from GrowthxAI are operator knowledge: `EmailTypesCatalogue` renders them on Settings → Admin only.
import { useEffect, useMemo, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { AlertTriangle, CheckCircle2, Copy, Globe, Mail, Pause, Play, RefreshCw, Send, ShieldCheck, Trash2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import {
  PAUSE_TEXT, RECORD_LABEL, RECORD_TONE, STATE_LABEL, STATE_TONE, displayState, sendingDomainApi, typeLabel, useEmailTypes, useInvalidateSendingDomains, useSendingDomains, warmupStage,
  type DnsRecord, type DomainCheck, type EmailTypeRow, type SendingDomain, type TestResult,
} from '@/lib/outreach/emailSending';
import { Badge, Button, Card, ErrorBox, Input, Modal, Spinner, Table, Td, Th, fmtDate, useToast } from '@/components/outreach/ui';
import { ConfirmModal, CopyButton, copyText } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';

const PLATFORM = 'GrowthxAI';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const GUIDES: Array<{ name: string; steps: string[] }> = [
  { name: 'Cloudflare', steps: ['Open the domain → DNS → Records → Add record.', 'Type: as in the table. Name: paste the host exactly as shown (Cloudflare does not append your domain to a full host name). Content: the value. Proxy status: DNS only (grey cloud).', 'MX records: enter the priority in the Priority field.'] },
  { name: 'GoDaddy', steps: ['My Products → the domain → DNS → Add New Record.', 'Type and Value as in the table. In Name, GoDaddy appends your domain automatically: enter only the part before your domain (for notify.acme.com use "send.notify", not "send.notify.acme.com").', 'MX records: Priority as shown.'] },
  { name: 'Namecheap', steps: ['Domain List → Manage → Advanced DNS → Add New Record.', 'Host: only the part before your domain (Namecheap appends it). Value: paste the value. TTL: Automatic.', 'MX records go under Mail Settings → Custom MX.'] },
  { name: 'Squarespace (Google Domains)', steps: ['Domains → the domain → DNS → Custom records → Add record.', 'Host: only the part before your domain. Type, Data and Priority as in the table.'] },
  { name: 'Hostinger', steps: ['Domains → the domain → DNS / Nameservers → Manage DNS records.', 'Name: only the part before your domain (Hostinger appends it). Type, Points to / Content, Priority as in the table.'] },
  { name: 'Route 53', steps: ['Hosted zones → the zone → Create record.', 'Record name: the full host as shown (Route 53 shows the zone after the box; enter the part before it). Record type, Value and, for MX, "priority value" on one line as "10 feedback-smtp…".'] },
];

function copyAll(d: SendingDomain): string {
  return d.records.map((r) => `${r.type}\t${r.name}\t${r.value}${r.priority != null ? `\t${r.priority}` : ''}`).join('\n');
}

function StateChip({ d }: { d: SendingDomain }) {
  const s = displayState(d);
  return <Badge tone={STATE_TONE[s]}>{STATE_LABEL[s]}</Badge>;
}

function PlanGate({ minPlan }: { minPlan: string }) {
  return (
    <Card title={<span className="flex items-center gap-2"><Globe className="w-4 h-4" /> Your own sending domain</span>}>
      <p className="text-sm text-gray-700">Send notification emails to your clients and account holders from your own domain, such as <span className="font-mono">notify.yourcompany.com</span>, instead of {PLATFORM}&apos;s. Available on <b>{minPlan}</b>.</p>
      <div className="mt-3"><Link href="/outreach/billing/change"><Button size="sm">See plans</Button></Link></div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// step 1: choose the domain
// ---------------------------------------------------------------------------
function SetupForm({ ws, clientId, suggested, onCreated }: { ws: string; clientId: string | null; suggested: string; onCreated: () => void }) {
  const [domain, setDomain] = useState(suggested);
  const [check, setCheck] = useState<DomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  async function runCheck(): Promise<DomainCheck | null> {
    if (!clean) { setCheck(null); return null; }
    setChecking(true); setError(null);
    try { const c = await sendingDomainApi.check(ws, clean, clientId); setCheck(c); return c; }
    catch (e) { setError(parseError(e).message); return null; }
    finally { setChecking(false); }
  }
  async function create() {
    setBusy(true); setError(null);
    try {
      const c = check?.domain === clean ? check : await runCheck();
      if (!c?.ok) return;
      await sendingDomainApi.create(ws, clean, clientId);
      onCreated();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Globe className="w-4 h-4" /> Pick the domain your notification emails come from</span>}>
      <p className="text-sm text-gray-600 mb-4">Use a subdomain of a domain you own, such as <span className="font-mono">notify.</span> or <span className="font-mono">mail.</span>, never the domain you send outreach from. You add a few DNS records; you never give us a mailbox password.</p>
      <div className="max-w-md">
        <Input label="Sending domain" placeholder="notify.yourcompany.com" value={domain} onChange={(e) => { setDomain(e.target.value); setCheck(null); }} onBlur={() => runCheck()} disabled={busy} autoCapitalize="none" spellCheck={false} />
      </div>
      {checking && <div className="mt-2 text-xs text-gray-500 inline-flex items-center gap-1.5"><Spinner className="w-3.5 h-3.5" /> Checking…</div>}
      {check && check.domain === clean && (
        <div className="mt-3 space-y-2">
          {check.errors.map((m) => <div key={m} className="flex items-start gap-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-3"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {m}</div>)}
          {check.warnings.map((m) => <div key={m} className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {m}</div>)}
          {check.ok && !check.warnings.length && <div className="flex items-center gap-2 text-sm text-green-800"><CheckCircle2 className="w-4 h-4" /> Looks good.</div>}
        </div>
      )}
      {error && <ErrorBox message={error} className="mt-3" />}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={create} loading={busy} disabled={!clean || checking || (check?.domain === clean && !check.ok)}>Create and show the DNS records</Button>
        <span className="text-xs text-gray-500">Nothing is sent from it until you turn it on at the end.</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// the domain card
// ---------------------------------------------------------------------------
function RecordsTable({ d }: { d: SendingDomain }) {
  const notFound = d.records.some((r) => r.hint === 'not_found_public_dns');
  return (
    <div>
      <Table>
        <thead><tr><Th>Record</Th><Th>Type</Th><Th>Host</Th><Th>Value</Th><Th>Priority</Th><Th>Status</Th></tr></thead>
        <tbody>
          {d.records.map((r: DnsRecord) => (
            <tr key={`${r.type}-${r.name}-${r.value}`}>
              <Td className="font-medium text-gray-900">{r.record}</Td>
              <Td>{r.type}</Td>
              <Td><span className="inline-flex items-center gap-1 font-mono text-xs break-all">{r.name}<CopyButton value={r.name} label="Copy host" className="w-6 h-6 border-0 bg-transparent" /></span></Td>
              <Td><span className="inline-flex items-center gap-1 font-mono text-xs break-all max-w-[360px]">{r.value}<CopyButton value={r.value} label="Copy value" className="w-6 h-6 border-0 bg-transparent flex-shrink-0" /></span></Td>
              <Td>{r.priority ?? ''}</Td>
              <Td><Badge tone={RECORD_TONE[r.status] ?? 'gray'}>{RECORD_LABEL[r.status] ?? r.status}</Badge></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {notFound && (
        <div className="mt-3 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <b>A record is not visible on public DNS yet.</b> The most common mistake: some providers add your domain to the host name automatically, which gives <span className="font-mono">send.{d.domain}.{d.domain}</span>. If yours does that, enter only the part before your domain. Changes can take up to an hour to show.
        </div>
      )}
    </div>
  );
}

function Guides() {
  return (
    <details className="mt-3">
      <summary className="text-sm text-indigo-600 cursor-pointer">Where to add these records at your DNS provider</summary>
      <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
        {GUIDES.map((g) => (
          <div key={g.name} className="rounded-lg border border-gray-200 p-3">
            <div className="text-sm font-medium text-gray-900 mb-1">{g.name}</div>
            <ol className="list-decimal pl-4 text-xs text-gray-600 space-y-1">{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
        ))}
      </div>
    </details>
  );
}

function IdentityForm({ ws, d, onSaved, disabled }: { ws: string; d: SendingDomain; onSaved: () => void; disabled: boolean }) {
  const serverForm = { from_name: d.from_name ?? '', from_local_part: d.from_local_part ?? 'notifications', reply_to: d.reply_to ?? '', accent: d.branding?.accent ?? '', footer: d.branding?.footer ?? '', logo_path: d.branding?.logo_path ?? '' };
  const serverKey = JSON.stringify(serverForm);
  const [form, setForm] = useState(serverForm);
  const [key, setKey] = useState(serverKey);
  if (key !== serverKey) { setKey(serverKey); setForm(serverForm); }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { show, node } = useToast();
  const replyOk = EMAIL_RE.test(form.reply_to.trim());
  const localOk = /^[a-z0-9._-]{1,64}$/.test(form.from_local_part.trim().toLowerCase());
  const dirty = JSON.stringify(form) !== serverKey;

  async function save() {
    setBusy(true); setError(null);
    try {
      await sendingDomainApi.update(ws, d.id, { from_name: form.from_name.trim() || null, from_local_part: form.from_local_part.trim().toLowerCase(), reply_to: form.reply_to.trim().toLowerCase(), branding: { accent: form.accent.trim() || null, footer: form.footer.trim() || null, logo_path: form.logo_path.trim() || null } });
      show('Saved.'); onSaved();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input label="From name" value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} placeholder="Acme Growth" disabled={disabled} hint="Shown as the sender of every branded email." />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">From address</label>
          <div className="flex items-center">
            <input value={form.from_local_part} onChange={(e) => setForm({ ...form, from_local_part: e.target.value })} disabled={disabled} className={cn('min-w-0 flex-1 px-3 py-2 text-sm rounded-l-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500', !localOk && 'border-red-300')} />
            <span className="px-3 py-2 text-sm rounded-r-lg border border-l-0 border-gray-300 bg-gray-50 text-gray-600 font-mono">@{d.domain}</span>
          </div>
          {!localOk && <div className="text-xs text-red-600 mt-1">Letters, numbers, dots, dashes and underscores only.</div>}
        </div>
        <Input label="Reply-to" type="email" value={form.reply_to} onChange={(e) => setForm({ ...form, reply_to: e.target.value })} placeholder="support@yourcompany.com" disabled={disabled} error={form.reply_to && !replyOk ? 'Enter a full email address' : undefined} hint="Required. A real address you read: replies go there, never to us." />
        <Input label="Accent colour (optional)" value={form.accent} onChange={(e) => setForm({ ...form, accent: e.target.value })} placeholder="#4f46e5" disabled={disabled} />
        <Input label="Logo URL (optional)" value={form.logo_path} onChange={(e) => setForm({ ...form, logo_path: e.target.value })} placeholder="https://…/logo.png" disabled={disabled} />
        <Input label="Footer line (optional)" value={form.footer} onChange={(e) => setForm({ ...form, footer: e.target.value })} placeholder="Acme Growth · 12 Market St, London" disabled={disabled} />
      </div>
      {error && <ErrorBox message={error} className="mt-3" />}
      <div className="mt-4"><Button size="sm" onClick={save} loading={busy} disabled={disabled || !dirty || !replyOk || !localOk}>Save identity</Button></div>
      {node}
    </div>
  );
}

function TypeList({ rows, title, blurb }: { rows: EmailTypeRow[]; title: string; blurb: string }) {
  return (
    <Card title={title}>
      <p className="text-sm text-gray-600 mb-3">{blurb}</p>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-2 py-1 border-b border-gray-50">
            <span className="text-gray-900">{typeLabel(r.key)}{r.note ? <span className="text-gray-400"> · {r.note}</span> : null}</span>
            <span className="flex items-center gap-1 flex-shrink-0">
              <Badge tone="gray">{r.audience === 'holder' ? 'account holder' : r.audience}</Badge>
              {r.safety_critical && <Badge tone="amber">always delivered</Badge>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Settings → Admin: the catalogue split by domain rule. Operator knowledge, not a customer setting. */
export function EmailTypesCatalogue() {
  const types = useEmailTypes(true);
  if (types.isLoading) return <Spinner />;
  if (types.isError) return <ErrorBox message={parseError(types.error).message} />;
  if (!types.data) return null;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <TypeList rows={types.data.brand} title="Emails that use a workspace's own domain" blurb="Emails to a workspace's clients and to people outside its team who sign in to an account. If the domain is paused they come from GrowthxAI with “on behalf of” until it is fixed, so nothing is missed." />
      <TypeList rows={types.data.platform} title={`Always from ${PLATFORM}`} blurb="Emails to a workspace's own team stay on the GrowthxAI domain. Billing and safety emails cannot be turned off." />
    </div>
  );
}

function DomainCard({ ws, d, onChange }: { ws: string; d: SendingDomain; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [itOpen, setItOpen] = useState(false);
  const [itEmail, setItEmail] = useState('');
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeNote, setResumeNote] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const [dmarc, setDmarc] = useState<{ found: boolean; policy: string | null } | null>(null);
  const { show, node } = useToast();
  const { role } = useWorkspace();
  const state = displayState(d);
  const verified = String(d.resend_status ?? '').toLowerCase() === 'verified';
  const wu = warmupStage(d);

  async function run(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key); setError(null);
    try { await fn(); if (done) show(done); onChange(); }
    catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  }

  const stepDone = (ok: boolean) => ok ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <span className="inline-block w-4 h-4 rounded-full border-2 border-gray-300" />;

  return (
    <div className="space-y-6">
      {d.paused_at && d.paused_reason && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-300 bg-amber-50 text-sm text-amber-900">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Emails from {d.domain} are paused</div>
            <p className="mt-1">Paused because {PAUSE_TEXT[d.paused_reason].cause}{d.paused_detail ? ` (${d.paused_detail})` : ''}. Every email that would have used it goes from {PLATFORM} meanwhile, so nothing is lost. {PAUSE_TEXT[d.paused_reason].fix}</p>
          </div>
        </div>
      )}

      <Card title={<span className="flex items-center gap-2"><Globe className="w-4 h-4" /> {d.domain} <StateChip d={d} /></span>}
        actions={<div className="flex items-center gap-2">
          {state === 'active' && <Button size="sm" variant="secondary" onClick={() => run('pause', () => sendingDomainApi.pause(ws, d.id), 'Paused.')} loading={busy === 'pause'} disabled={!!busy}><Pause className="w-3.5 h-3.5" /> Pause</Button>}
          {state === 'paused' && d.paused_reason !== 'plan' && <Button size="sm" onClick={() => (d.paused_reason === 'bounces' || d.paused_reason === 'complaints') ? setResumeOpen(true) : run('resume', () => sendingDomainApi.resume(ws, d.id), 'Resumed.')} loading={busy === 'resume'} disabled={!!busy}><Play className="w-3.5 h-3.5" /> Resume</Button>}
          <Button size="sm" variant="danger" onClick={() => setRemoveOpen(true)} disabled={!!busy}><Trash2 className="w-3.5 h-3.5" /> Remove domain</Button>
        </div>}>
        <p className="text-sm text-gray-700">
          {state === 'active' ? <>Emails to your clients and account holders come from <b className="font-mono">{d.from_local_part}@{d.domain}</b>.</>
            : state === 'ready' ? <>Verified. Fill in the sender identity, send a test, then turn it on.</>
            : state === 'failed' ? <>The DNS records were not found for 7 days. Add them and press Check now; emails keep coming from {PLATFORM} meanwhile.</>
            : <>Waiting for the DNS records. Emails come from {PLATFORM} until the domain is turned on.</>}
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 text-sm">
          <div><div className="text-xs text-gray-500">Warm-up</div><div className="text-gray-900">{wu.label}</div>{d.daily_cap != null && <div className="text-xs text-gray-500">{d.sent_today ?? 0} of {d.daily_cap} today; the rest go from {PLATFORM}</div>}</div>
          <div><div className="text-xs text-gray-500">Last 7 days</div><div className="text-gray-900">{d.last7?.sent ?? 0} sent · {d.last7?.delivered ?? 0} delivered</div><div className="text-xs text-gray-500">{d.last7?.bounced ?? 0} bounced · {d.last7?.complained ?? 0} complaints{d.fallbacks7 ? ` · ${d.fallbacks7} fell back to ${PLATFORM}` : ''}</div></div>
          <div><div className="text-xs text-gray-500">Verified</div><div className="text-gray-900">{d.verified_at ? fmtDate(d.verified_at, false) : '—'}</div></div>
          <div><div className="text-xs text-gray-500">Last checked</div><div className="text-gray-900">{d.last_checked_at ? fmtDate(d.last_checked_at) : 'Not yet'}</div></div>
        </div>
        {error && <ErrorBox message={error} className="mt-4" />}
      </Card>

      <Card title={<span className="flex items-center gap-2">{stepDone(verified)} Add these DNS records so mail providers trust it</span>}
        actions={<div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={async () => { const ok = await copyText(copyAll(d)); show(ok ? 'All records copied.' : 'Could not copy.', ok ? 'success' : 'error'); }}><Copy className="w-3.5 h-3.5" /> Copy all</Button>
          <Button size="sm" variant="secondary" onClick={() => setItOpen(true)}><Mail className="w-3.5 h-3.5" /> Email these records to my IT person</Button>
          <Button size="sm" onClick={() => run('verify', () => sendingDomainApi.verify(ws, d.id), 'Checked.')} loading={busy === 'verify'} disabled={!!busy}><RefreshCw className="w-3.5 h-3.5" /> Check now</Button>
        </div>}>
        <p className="text-sm text-gray-600 mb-3">Add every record below at the company that manages your DNS. We check them every 10 minutes for the first three days, then hourly for a week. Press <b>Check now</b> any time.</p>
        <RecordsTable d={d} />
        <Guides />
        {(d.dmarc_found === false || dmarc?.found === false) && !(dmarc?.found) && (
          <div className="mt-3 flex items-start justify-between gap-3 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <span><ShieldCheck className="w-4 h-4 inline mr-1" /> Gmail and Yahoo expect a DMARC record on domains that send to them. Ask your IT person to add one (a TXT on <span className="font-mono">_dmarc.{d.domain.split('.').slice(-2).join('.')}</span> with <span className="font-mono">v=DMARC1; p=none</span> is enough to start). Not blocking.</span>
            <Button size="sm" variant="ghost" onClick={async () => { setBusy('dmarc'); try { const r = await sendingDomainApi.dmarc(ws, d.id); setDmarc(r); show(r.found ? `DMARC found (p=${r.policy ?? 'none'}).` : 'Still no DMARC record.'); onChange(); } catch (e) { setError(parseError(e).message); } finally { setBusy(null); } }} loading={busy === 'dmarc'}>Re-check</Button>
          </div>
        )}
        {(d.dmarc_found === true || dmarc?.found) && <div className="mt-3 text-xs text-green-700 inline-flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> DMARC record found{dmarc?.policy ? ` (p=${dmarc.policy})` : ''}.</div>}
      </Card>

      <Card title={<span className="flex items-center gap-2">{stepDone(!!d.reply_to)} The name and reply address your clients will see</span>}>
        <IdentityForm ws={ws} d={d} onSaved={onChange} disabled={!!busy} />
      </Card>

      <Card title={<span className="flex items-center gap-2">{stepDone(state === 'active')} Send yourself a test, then turn it on</span>}>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => run('test', async () => { setTest(await sendingDomainApi.test(ws, d.id)); })} loading={busy === 'test'} disabled={!!busy || !verified || !d.reply_to}><Send className="w-3.5 h-3.5" /> Send a test to me</Button>
          {state !== 'active' && state !== 'paused' && <Button size="sm" onClick={() => run('activate', () => sendingDomainApi.activate(ws, d.id), 'The domain is on.')} loading={busy === 'activate'} disabled={!!busy || state !== 'ready' || !d.reply_to}><Play className="w-3.5 h-3.5" /> Turn on</Button>}
          {!verified && <span className="text-xs text-gray-500">The DNS records have to be verified first.</span>}
          {verified && !d.reply_to && <span className="text-xs text-gray-500">Set the reply-to address first.</span>}
        </div>
        {test && (
          <div className={cn('mt-3 text-sm rounded-lg p-3 border', test.ok ? 'bg-green-50 border-green-200 text-green-900' : 'bg-red-50 border-red-200 text-red-900')}>
            {test.ok ? <>Sent from <span className="font-mono">{test.from}</span>{test.fell_back ? ` (fell back to ${PLATFORM})` : ''}. Delivery shows up in the <Link href="/outreach/settings/email/log" className="underline">Email log</Link> within a minute.</> : <>The test could not be sent{test.error ? `: ${test.error}` : ''}.</>}
          </div>
        )}
        {role === 'owner' || role === 'manager' ? null : <p className="text-xs text-gray-500 mt-2">Only owners and managers can change these settings.</p>}
      </Card>

      <Modal open={itOpen} onClose={() => setItOpen(false)} title="Email the DNS records" size="sm"
        footer={<><Button variant="secondary" onClick={() => setItOpen(false)}>Cancel</Button><Button onClick={() => run('it', () => sendingDomainApi.emailRecords(ws, d.id, itEmail.trim()), 'Sent.').then(() => setItOpen(false))} loading={busy === 'it'} disabled={!EMAIL_RE.test(itEmail.trim())}>Send</Button></>}>
        <p className="text-sm text-gray-600 mb-3">We send the table above, with the usual mistakes to avoid, from the {PLATFORM} address.</p>
        <Input label="Their email" type="email" value={itEmail} onChange={(e) => setItEmail(e.target.value)} placeholder="it@yourcompany.com" autoFocus />
      </Modal>

      <Modal open={resumeOpen} onClose={() => setResumeOpen(false)} title="Resume sending from this domain" size="sm"
        footer={<><Button variant="secondary" onClick={() => setResumeOpen(false)}>Cancel</Button><Button onClick={() => run('resume', () => sendingDomainApi.resume(ws, d.id, resumeNote.trim()), 'Resumed.').then(() => setResumeOpen(false))} loading={busy === 'resume'} disabled={!resumeNote.trim()}>Resume</Button></>}>
        <p className="text-sm text-gray-600 mb-3">It was paused because {d.paused_reason ? PAUSE_TEXT[d.paused_reason].cause : 'of a problem'}. Say what was fixed; the note is kept with the domain.</p>
        <Input label="What changed" value={resumeNote} onChange={(e) => setResumeNote(e.target.value)} placeholder="Removed the old list that bounced" autoFocus />
      </Modal>

      <ConfirmModal open={removeOpen} onClose={() => setRemoveOpen(false)} title={`Remove ${d.domain}?`} confirmLabel="Remove domain" loading={busy === 'remove'}
        onConfirm={() => run('remove', () => sendingDomainApi.remove(ws, d.id), 'Domain removed.').then(() => setRemoveOpen(false))}>
        <p>The domain and its sending key are deleted from our email provider. Emails go from {PLATFORM} from then on. You can add it again later; the DNS records would have to be set up again.</p>
      </ConfirmModal>
      {node}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function EmailSendingPanel({ clientId = null }: { clientId?: string | null }) {
  const { workspace, isManager } = useWorkspace();
  const ws = workspace?.id ?? null;
  const list = useSendingDomains(ws, clientId);
  const invalidate = useInvalidateSendingDomains();
  const suggested = useMemo(() => {
    const site = String((workspace?.settings as Record<string, unknown> | undefined)?.website ?? '');
    const host = site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').trim();
    return host ? `notify.${host}` : '';
  }, [workspace?.settings]);
  const domains = list.data?.domains ?? [];
  const mine = domains.find((d) => (d.client_id ?? null) === clientId) ?? null;
  // the worker verifies in the background: keep the page fresh while a domain is verifying
  const verifying = !!mine && (mine.state === 'setup' || mine.state === 'verifying');
  useEffect(() => {
    if (!verifying || !ws) return;
    const t = setInterval(() => invalidate(ws), 60_000);
    return () => clearInterval(t);
  }, [verifying, ws, invalidate]);

  if (!ws) return null;
  if (list.isLoading) return <Spinner />;
  if (list.isError) return <ErrorBox message={parseError(list.error).message} />;
  if (!isManager) return <ErrorBox message="Only owners and managers can set up a sending domain." />;
  if (!list.data?.feature) return <PlanGate minPlan={list.data?.min_plan ?? 'Scale'} />;
  if (clientId && !list.data.client_domains) return <PlanGate minPlan="Enterprise" />;
  if (clientId && !mine && list.data.client_domain_limit != null && domains.filter((d) => d.client_id).length >= list.data.client_domain_limit) {
    return <Card title="Email sending"><p className="text-sm text-gray-700">Your plan includes {list.data.client_domain_limit} client domains and they are all in use. Contact support for more.</p></Card>;
  }

  return (
    <div className="space-y-6">
      {mine ? <DomainCard ws={ws} d={mine} onChange={() => invalidate(ws)} /> : <SetupForm ws={ws} clientId={clientId} suggested={suggested} onCreated={() => invalidate(ws)} />}
      {clientId && !mine && domains.find((d) => !d.client_id) && <p className="text-xs text-gray-500">Without its own domain, this client&apos;s emails use the workspace domain {domains.find((d) => !d.client_id)!.domain}.</p>}
    </div>
  );
}
