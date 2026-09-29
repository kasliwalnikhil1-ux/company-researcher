'use client';

// The LinkedIn account owner's Autopilot consent pages (no login; the signed token in the email is the credential).
// ConsentPage shows the master prompt that will speak for them, the limits and three example drafts, and records
// consent. RevokePage turns Autopilot off from the link in the confirmation email. Both talk to the public actions of
// the outreach-ai-reply function (docs/outreach/AI-REPLIES-CONTRACT.md §4). Mail scanners open every link, so
// opening a page never changes anything: only the buttons do.
import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, Clock, ShieldCheck, XCircle } from 'lucide-react';
import type { Decision } from '@/lib/outreach/aiReplies';
import { contrastOn, isHexColor, isHttpsUrl, type Branding } from '@/lib/outreach/branding';
import { cn } from '@/lib/utils';

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/outreach-ai-reply`;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

class CallError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN, { method: 'POST', headers: { 'content-type': 'application/json', apikey: ANON }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CallError(String(data?.error ?? `Request failed (${res.status})`), String(data?.code ?? `E_HTTP_${res.status}`), res.status);
  return data as T;
}

/** A token that is unknown, used, expired or withdrawn, as opposed to a server or network failure. */
function isInvalidLink(e: unknown): boolean {
  if (!(e instanceof CallError)) return false;
  return e.status === 404 || e.status === 410 || /NOT_FOUND|INVALID|EXPIRED|USED|TOKEN|CANCELLED|REVOKED/.test(e.code) || /valid|used|expired/i.test(e.message);
}

type ConsentStatus = 'pending' | 'accepted' | 'expired' | 'cancelled' | 'outdated';
interface ConsentView {
  status: ConsentStatus;
  sender_name: string | null;
  workspace_name: string;
  branding: Branding | null;
  email: string | null;
  master_prompt: { body: string; version: number; scope_label: string | null };
  scope: { daily_cap: number; delay_min_s: number; delay_max_s: number };
  examples: Array<{ prospect: string; reply: string | null; stage: string | null; stage_label?: string | null; decision: Decision }>;
  expires_at: string;
  consent_months?: number;
}

type State = 'loading' | 'ready' | 'working' | 'done' | 'invalid' | 'error';
const INVALID = 'This link is not valid or was already used. Ask the person who sent it for a new one.';
const RETRY = 'Something went wrong. Try again in a minute.';

const minutes = (s: number) => Math.max(1, Math.round(s / 60));
const stageLabel = (key: string) => { const t = key.replace(/_/g, ' ').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : key; };
const fmt = (iso: string | null | undefined) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };

function Shell({ title, icon, brand, children }: { title: string; icon?: React.ReactNode; brand?: Branding | null; children: React.ReactNode }) {
  const name = brand?.product_name || brand?.workspace_name || '';
  return (
    <main className="min-h-screen bg-gray-50 flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white p-6 sm:p-8">
        {isHttpsUrl(brand?.logo_url)
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={brand!.logo_url} alt={name} className="max-h-8 max-w-[180px] mb-5" />
          : name ? <div className="text-sm font-semibold text-gray-900 mb-5">{name}</div> : null}
        <div className="flex items-center gap-2 mb-4">{icon}<h1 className="text-lg font-semibold text-gray-900" aria-live="polite">{title}</h1></div>
        {children}
        {brand?.support_email && <p className="text-xs text-gray-500 mt-6">Questions? Write to <a className="underline" href={`mailto:${brand.support_email}`}>{brand.support_email}</a>.</p>}
        <p className="text-[11px] text-gray-400 mt-8">This page needs no login. The link in your email is the key: do not forward it. This service is not affiliated with LinkedIn.</p>
      </div>
    </main>
  );
}

function Btn({ children, onClick, disabled, variant = 'primary', accent }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; variant?: 'primary' | 'danger'; accent?: string | null }) {
  const branded = variant === 'primary' && isHexColor(accent);
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={branded ? { backgroundColor: accent!, color: contrastOn(accent!) } : undefined}
      className={cn('px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-500',
        variant === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : branded ? 'hover:opacity-90' : 'bg-indigo-600 text-white hover:bg-indigo-700')}>
      {children}
    </button>
  );
}

function Example({ ex, n }: { ex: ConsentView['examples'][number]; n: number }) {
  return (
    <li className="rounded-lg border border-gray-200 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
        <span>Example {n}</span>
        {ex.stage && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">Stage: {ex.stage_label || stageLabel(ex.stage)}</span>}
      </div>
      <div>
        <div className="text-[11px] font-medium text-gray-500 mb-0.5">They wrote</div>
        <p className="text-sm text-gray-800 whitespace-pre-wrap bg-gray-50 rounded-md px-2.5 py-2">{ex.prospect}</p>
      </div>
      <div>
        <div className="text-[11px] font-medium text-gray-500 mb-0.5">The AI would</div>
        {ex.decision === 'send' && ex.reply
          ? <p className="text-sm text-gray-900 whitespace-pre-wrap bg-indigo-50/60 rounded-md px-2.5 py-2">{ex.reply}</p>
          : <p className="text-sm text-gray-600 italic">{ex.decision === 'escalate' ? 'Not reply, and hand the conversation to a person.' : 'Not reply. No answer is needed here.'}</p>}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- consent
export function ConsentPage({ token }: { token: string }) {
  const [state, setState] = useState<State>(token ? 'loading' : 'invalid');
  const [view, setView] = useState<ConsentView | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [revokeUrl, setRevokeUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    if (!token) return;
    call<ConsentView>({ action: 'consent_view', token })
      .then((r) => {
        if (!live) return;
        // A pending link past its expiry (clock skew, or the page left open) reads as expired.
        setView(r.status === 'pending' && new Date(r.expires_at).getTime() < Date.now() ? { ...r, status: 'expired' } : r);
        setState('ready');
      })
      .catch((e) => { if (!live) return; setMsg(e instanceof Error ? e.message : ''); setState(isInvalidLink(e) ? 'invalid' : 'error'); });
    return () => { live = false; };
  }, [token]);

  async function accept() {
    setState('working');
    try { const r = await call<{ ok: boolean; revoke_url?: string | null }>({ action: 'consent_accept', token }); setRevokeUrl(r.revoke_url ?? null); setState('done'); }
    catch (e) { setMsg(e instanceof Error ? e.message : ''); setState(isInvalidLink(e) ? 'invalid' : 'error'); }
  }

  const brand = view ? { ...(view.branding ?? {}), workspace_name: view.branding?.workspace_name ?? view.workspace_name } : null;
  const who = view?.workspace_name || 'Your team';
  const account = view?.sender_name ? `the LinkedIn account ${view.sender_name}` : 'your LinkedIn account';
  const status: ConsentStatus | null = view?.status ?? null;
  const hold = view ? `${minutes(view.scope.delay_min_s)}–${minutes(view.scope.delay_max_s)} minutes` : '';

  if (state === 'done') {
    return (
      <Shell title="Autopilot is on for your account" icon={<CheckCircle2 className="w-5 h-5 text-green-600" />} brand={brand}>
        <div className="space-y-4 text-sm text-gray-700">
          <p>Thanks. The AI can now reply to LinkedIn messages as {view?.sender_name ?? 'you'}, following the prompt you just read and within the limits shown.</p>
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">To turn it off at any time, use this link</div>
            {revokeUrl
              ? <a href={revokeUrl} className="block break-all font-mono text-xs text-indigo-700 underline bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">{revokeUrl}</a>
              : <p className="text-xs text-gray-600">The link is in the confirmation email.</p>}
            <p className="text-xs text-gray-500 mt-1.5">We have also emailed it to you{view?.email ? ` at ${view.email}` : ''}. Keep that email.</p>
          </div>
          <p className="text-xs text-gray-500">If {who} changes what the prompt says about situations or facts, you will be asked again before the AI replies as you.</p>
        </div>
      </Shell>
    );
  }

  if (state === 'loading') return <Shell title="Autopilot for your LinkedIn account" icon={<Bot className="w-5 h-5 text-indigo-600" />}><p className="text-sm text-gray-600">Checking your link…</p></Shell>;
  if (state === 'invalid' || (state === 'error' && !view)) {
    return <Shell title="Autopilot for your LinkedIn account" icon={<XCircle className="w-5 h-5 text-red-600" />} brand={brand}><p className="text-sm text-red-700">{state === 'invalid' ? INVALID : msg || RETRY}</p></Shell>;
  }
  if (!view) return null;

  if (status === 'accepted') {
    return (
      <Shell title="You already gave consent" icon={<CheckCircle2 className="w-5 h-5 text-green-600" />} brand={brand}>
        <p className="text-sm text-gray-700">The AI can reply to LinkedIn messages as {view.sender_name ?? 'you'} for {who}. To turn it off, use the link in the confirmation email.</p>
      </Shell>
    );
  }
  if (status === 'expired') {
    return (
      <Shell title="This link has expired" icon={<Clock className="w-5 h-5 text-gray-500" />} brand={brand}>
        <p className="text-sm text-gray-700">Nothing was changed. If you still want to allow AI replies, ask {who} to send you a new link.</p>
      </Shell>
    );
  }
  if (status === 'outdated') {
    return (
      <Shell title="The prompt changed since this link was sent" icon={<Clock className="w-5 h-5 text-gray-500" />} brand={brand}>
        <p className="text-sm text-gray-700">{who} changed what the AI says in some situations or which facts it may use. Nothing was changed. Look for a newer email with the updated prompt, or ask {who} to send one.</p>
      </Shell>
    );
  }
  if (status === 'cancelled') {
    return (
      <Shell title="This request was withdrawn" icon={<XCircle className="w-5 h-5 text-gray-500" />} brand={brand}>
        <p className="text-sm text-gray-700">{who} withdrew this request, or replaced it with a newer one after changing the prompt. Check your email for a more recent link. Nothing was changed.</p>
      </Shell>
    );
  }

  const cap = view.scope.daily_cap;
  return (
    <Shell title="Let AI reply on LinkedIn as you?" icon={<ShieldCheck className="w-5 h-5 text-indigo-600" />} brand={brand}>
      <div className="space-y-6 text-sm">
        <div className="space-y-2 text-gray-700">
          <p><b>{who}</b> asks for your permission to turn on Autopilot for {account}.</p>
          <p>Autopilot lets the AI answer replies on LinkedIn as you, after a hold of {hold}, up to {cap} {cap === 1 ? 'message' : 'messages'} a day. It never claims to be human. Your consent lasts {view.consent_months ?? 12} months and you can revoke it any time from the link in your email.</p>
          <p>When a conversation needs a person (a contract, a complaint, a question the prompt does not cover), the AI does not reply and hands it to your team instead.</p>
        </div>

        <section>
          <h2 className="text-sm font-semibold text-gray-900">The prompt that will speak for you</h2>
          <p className="text-xs text-gray-500 mt-0.5 mb-2">The AI follows these instructions every time it writes as you. Read all of it.{view.master_prompt.scope_label ? ` ${view.master_prompt.scope_label}, version ${view.master_prompt.version}.` : ` Version ${view.master_prompt.version}.`}</p>
          <pre tabIndex={0} aria-label="Master prompt" className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-gray-800 bg-gray-50 border border-gray-200 rounded-lg p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{view.master_prompt.body}</pre>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Limits</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="rounded-lg border border-gray-200 px-3 py-2"><dt className="text-xs text-gray-500">Most AI replies a day</dt><dd className="text-gray-900 font-medium">{cap}</dd></div>
            <div className="rounded-lg border border-gray-200 px-3 py-2"><dt className="text-xs text-gray-500">Wait before each reply is sent</dt><dd className="text-gray-900 font-medium">{hold}</dd></div>
          </dl>
          <p className="text-xs text-gray-500 mt-1.5">During the wait, your team can stop or edit the reply.</p>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-gray-900">What it would write</h2>
          <p className="text-xs text-gray-500 mt-0.5 mb-2">Drafts written from recent conversations on your account. Nothing here was sent.</p>
          {view.examples.length
            ? <ol className="space-y-2">{view.examples.map((ex, i) => <Example key={i} ex={ex} n={i + 1} />)}</ol>
            : <p className="text-xs text-gray-500">There are no recent conversations on this account to draft from yet.</p>}
        </section>

        <div className="border-t border-gray-100 pt-5 space-y-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={state === 'working'} className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
            <span className="text-gray-800">I&apos;ve read the prompt and agree that the AI may reply as me within these limits.</span>
          </label>
          {state === 'error' && <p className="text-sm text-red-700">{msg || RETRY}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Btn onClick={accept} disabled={!agreed || state === 'working'} accent={view.branding?.accent}>{state === 'working' ? 'Saving…' : 'Give consent'}</Btn>
            <span className="text-xs text-gray-500">Don&apos;t agree? Close this page. Nothing changes.</span>
          </div>
          <p className="text-xs text-gray-500">{view.email ? `Sent to ${view.email}. ` : ''}This link expires {fmt(view.expires_at)}.</p>
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------- revoke
export function RevokePage({ token }: { token: string }) {
  const [state, setState] = useState<State>(token ? 'loading' : 'invalid');
  const [info, setInfo] = useState<{ status: 'active' | 'revoked'; sender_name: string | null; workspace_name: string | null; branding: Branding | null } | null>(null);
  const [msg, setMsg] = useState('');

  // opening the page only reads: whose Autopilot this link turns off (mail scanners open every link)
  useEffect(() => {
    let live = true;
    if (!token) return;
    call<{ status: 'active' | 'revoked'; sender_name: string | null; workspace_name: string | null; branding: Branding | null }>({ action: 'consent_revoke_view', token })
      .then((r) => { if (!live) return; setInfo(r); setState('ready'); })
      .catch((e) => { if (!live) return; setMsg(e instanceof Error ? e.message : ''); setState(isInvalidLink(e) ? 'invalid' : 'ready'); });
    return () => { live = false; };
  }, [token]);

  async function revoke() {
    setState('working');
    try { await call<{ ok: boolean }>({ action: 'consent_revoke', token }); setState('done'); }
    catch (e) { setMsg(e instanceof Error ? e.message : ''); setState(isInvalidLink(e) ? 'invalid' : 'error'); }
  }

  const brand = info ? { ...(info.branding ?? {}), workspace_name: info.branding?.workspace_name ?? info.workspace_name ?? undefined } : null;
  const account = info?.sender_name ? `the LinkedIn account ${info.sender_name}` : 'your LinkedIn account';
  if (state === 'loading') return <Shell title="Turn off Autopilot" icon={<Bot className="w-5 h-5 text-indigo-600" />}><p className="text-sm text-gray-600">Checking your link…</p></Shell>;
  if (state === 'done' || info?.status === 'revoked') {
    return (
      <Shell title="Autopilot is off" icon={<CheckCircle2 className="w-5 h-5 text-green-600" />} brand={brand}>
        <p className="text-sm text-gray-700">Autopilot is off for {account}. Scheduled AI replies are cancelled.</p>
        <p className="text-xs text-gray-500 mt-3">Your team can still get AI drafts, but a person has to send each one. To turn Autopilot back on, they will need to ask you again.</p>
      </Shell>
    );
  }
  if (state === 'invalid') {
    return <Shell title="Turn off Autopilot" icon={<XCircle className="w-5 h-5 text-red-600" />}><p className="text-sm text-red-700">This link is not valid. If Autopilot is still on for your account, ask your team to turn it off, or reply to the email that brought you here.</p></Shell>;
  }
  return (
    <Shell title="Turn off Autopilot for your LinkedIn account?" icon={<ShieldCheck className="w-5 h-5 text-indigo-600" />} brand={brand}>
      <div className="space-y-4 text-sm text-gray-700">
        <p>This stops the AI from sending LinkedIn replies as {info?.sender_name ?? 'you'}{info?.workspace_name ? ` for ${info.workspace_name}` : ''}. Any AI replies waiting to go out are cancelled straight away.</p>
        {state === 'error' && <p className="text-sm text-red-700">{msg || RETRY}</p>}
        <Btn variant="danger" onClick={revoke} disabled={state === 'working'}>{state === 'working' ? 'Turning off…' : 'Turn off Autopilot'}</Btn>
      </div>
    </Shell>
  );
}
