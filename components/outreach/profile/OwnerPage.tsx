'use client';

// The account owner's pages (no login; the signed token is the credential): grant permission, approve a proposed
// change, revert an applied change. Each talks to the outreach-profile function's public actions.
import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { FIELD_GROUPS, FIDELITY, GROUP_LABELS, payloadKeyLabel, payloadValueText, type FieldGroup, type ProfileDoc, type ProfilePayload, type RevertBuild } from '@/lib/outreach/profile';
import { cn } from '@/lib/utils';

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/outreach-profile`;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN, { method: 'POST', headers: { 'content-type': 'application/json', apikey: ANON }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

function Shell({ title, children, icon }: { title: string; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50 flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-xl rounded-xl border border-gray-200 bg-white p-6 sm:p-8">
        <div className="flex items-center gap-2 mb-4">{icon}<h1 className="text-lg font-semibold text-gray-900">{title}</h1></div>
        {children}
        <p className="text-[11px] text-gray-400 mt-8">This page needs no login. The link in your email is the key: do not forward it. This service is not affiliated with LinkedIn.</p>
      </div>
    </main>
  );
}
const Btn = ({ children, onClick, disabled, variant = 'primary' }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger' }) => (
  <button onClick={onClick} disabled={disabled} className={cn('px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50', variant === 'primary' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : variant === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : 'border border-gray-300 text-gray-800 hover:bg-gray-50')}>{children}</button>
);

function Diff({ payload, assets, before }: { payload: ProfilePayload; assets: Record<string, string> | null | undefined; before: ProfileDoc | null }) {
  const p = payload as Record<string, unknown>;
  const rows = Object.keys(p).map((k) => ({ k, before: k === 'headline' ? before?.headline : k === 'summary' ? before?.summary : k === 'location' ? before?.location : k === 'skills' ? before?.skills?.map((s) => s.name) : null, after: p[k] }));
  if (assets?.picture || assets?.picture_url) rows.push({ k: 'picture', before: before?.picture_url ? 'current photo' : null, after: 'new photo' });
  if (assets?.cover_picture || assets?.cover_url) rows.push({ k: 'cover_picture', before: before?.cover_url ? 'current cover' : null, after: 'new cover' });
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-gray-500"><th className="py-1 pr-2">Field</th><th className="py-1 pr-2">Now</th><th className="py-1">Proposed</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.k} className="border-t border-gray-100 align-top"><td className="py-2 pr-2 font-medium text-gray-900 whitespace-nowrap">{payloadKeyLabel(r.k)}</td><td className="py-2 pr-2 text-gray-500 whitespace-pre-line">{payloadValueText(r.k, r.before)}</td><td className="py-2 text-gray-900 whitespace-pre-line">{payloadValueText(r.k, r.after)}</td></tr>)}</tbody>
    </table>
  );
}

type State = 'loading' | 'ready' | 'working' | 'done' | 'declined' | 'invalid' | 'error';
const ERR = { invalid: 'This link is not valid, has expired, or was already used. Ask the person who sent it for a new one.', error: 'Something went wrong. Try again in a minute.' };

// ---------------------------------------------------------------- authority
interface LinkInfo { sender_name: string | null; sender_picture: string | null; workspace_name: string; field_groups: FieldGroup[]; mode: 'propose_only' | 'direct'; owner_email: string; expires_at: string; expired: boolean; accepted_at: string | null; declined_at: string | null; grant_days: number | null }
export function AuthorityPage({ token }: { token: string }) {
  const [state, setState] = useState<State>('loading');
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [groups, setGroups] = useState<FieldGroup[]>([]);
  const [mode, setMode] = useState<'propose_only' | 'direct'>('propose_only');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let live = true;
    call<{ link: LinkInfo }>({ action: 'authority_preview', token }).then((r) => { if (!live) return; if (r.link.expired || r.link.accepted_at || r.link.declined_at) { setState('invalid'); return; } setLink(r.link); setGroups(r.link.field_groups); setMode(r.link.mode); setState('ready'); }).catch((e) => { if (live) { setMsg(String(e.message)); setState(/valid|used|expired/i.test(e.message) ? 'invalid' : 'error'); } });
    return () => { live = false; };
  }, [token]);
  async function decide(decision: 'accept' | 'decline') {
    setState('working');
    try { await call({ action: 'authority_accept', token, decision, field_groups: groups, mode }); setState(decision === 'accept' ? 'done' : 'declined'); }
    catch (e) { setMsg(String((e as Error).message)); setState('error'); }
  }
  return (
    <Shell title="Permission to edit your LinkedIn profile" icon={<ShieldCheck className="w-5 h-5 text-indigo-600" />}>
      {state === 'loading' && <p className="text-sm text-gray-600">Checking your link…</p>}
      {(state === 'invalid' || state === 'error') && <p className="text-sm text-red-700">{state === 'invalid' ? ERR.invalid : msg || ERR.error}</p>}
      {state === 'done' && <div className="flex items-start gap-2 text-sm text-green-800"><CheckCircle2 className="w-5 h-5 flex-shrink-0" /><div>Permission recorded for {groups.map((g) => GROUP_LABELS[g]).join(', ')} ({mode === 'direct' ? 'direct' : 'proposals'}). You will be emailed after every change, with a revert link. You can revoke this at any time by asking {link?.workspace_name}.</div></div>}
      {state === 'declined' && <div className="flex items-start gap-2 text-sm text-gray-700"><XCircle className="w-5 h-5 flex-shrink-0" /><div>Declined. Nothing on your profile can be changed through {link?.workspace_name}.</div></div>}
      {(state === 'ready' || state === 'working') && link && (
        <div className="space-y-4 text-sm">
          <p className="text-gray-700"><b>{link.workspace_name}</b> asks to edit parts of the LinkedIn profile <b>{link.sender_name ?? link.owner_email}</b>. Sending messages on your behalf was agreed when the account was connected. Editing your profile is a separate decision, per field.</p>
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1.5">Allow changes to</div>
            <div className="flex flex-wrap gap-1.5">{FIELD_GROUPS.filter((g) => link.field_groups.includes(g)).map((g) => { const on = groups.includes(g); return <button key={g} type="button" aria-pressed={on} onClick={() => setGroups(on ? groups.filter((x) => x !== g) : [...groups, g])} className={cn('text-xs px-2.5 py-1 rounded-full border', on ? 'bg-indigo-50 border-indigo-300 text-indigo-800' : 'border-gray-200 text-gray-600')}>{GROUP_LABELS[g]}</button>; })}</div>
            <div className="text-[11px] text-gray-500 mt-1">Untick anything you do not want touched.</div>
          </div>
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1.5">How</div>
            <label className="flex items-start gap-2 py-1"><input type="radio" name="mode" checked={mode === 'propose_only'} onChange={() => setMode('propose_only')} className="mt-1" /><span><b>Proposals only.</b> Every change is emailed to you first and happens only when you click Apply.</span></label>
            {link.mode === 'direct' && <label className="flex items-start gap-2 py-1"><input type="radio" name="mode" checked={mode === 'direct'} onChange={() => setMode('direct')} className="mt-1" /><span><b>Direct.</b> Changes are applied on schedule. You are emailed after each one with a one-click revert that works for 30 days.</span></label>}
          </div>
          <div className="text-xs text-gray-500">Never changed through this platform: your name, open-to-work settings, and network announcements. {link.grant_days ? `The permission expires after ${link.grant_days} days.` : 'The permission lasts until revoked.'}</div>
          <div className="flex gap-2 pt-2"><Btn onClick={() => decide('accept')} disabled={state === 'working' || !groups.length}>Allow {groups.length ? `(${groups.length})` : ''}</Btn><Btn variant="secondary" onClick={() => decide('decline')} disabled={state === 'working'}>Decline</Btn></div>
        </div>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------- approval
interface Approval { change: { id: string; status: string; field_groups: FieldGroup[]; payload: ProfilePayload; assets: Record<string, string>; requested_by_email: string | null; note: string | null; expires_at: string }; sender: { display_name: string | null; picture_url: string | null } | null; before: ProfileDoc | null }
export function ApprovalPage({ token }: { token: string }) {
  const [state, setState] = useState<State>('loading');
  const [data, setData] = useState<Approval | null>(null);
  const [msg, setMsg] = useState('');
  const [when, setWhen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call<Approval>({ action: 'approval_preview', token }).then((r) => { if (!live) return; if (r.change.status !== 'awaiting_owner') { setState('invalid'); return; } setData(r); setState('ready'); }).catch((e) => { if (live) { setMsg(String(e.message)); setState(/valid|used|expired/i.test(e.message) ? 'invalid' : 'error'); } });
    return () => { live = false; };
  }, [token]);
  async function decide(decision: 'apply' | 'decline') {
    setState('working');
    try { const r = await call<{ status: string; scheduled_for?: string }>({ action: 'approval_decide', token, decision }); setWhen(r.scheduled_for ?? null); setState(decision === 'apply' ? 'done' : 'declined'); }
    catch (e) { setMsg(String((e as Error).message)); setState('error'); }
  }
  return (
    <Shell title="A change to your LinkedIn profile" icon={<ShieldCheck className="w-5 h-5 text-indigo-600" />}>
      {state === 'loading' && <p className="text-sm text-gray-600">Checking your link…</p>}
      {(state === 'invalid' || state === 'error') && <p className="text-sm text-red-700">{state === 'invalid' ? ERR.invalid : msg || ERR.error}</p>}
      {state === 'done' && <div className="flex items-start gap-2 text-sm text-green-800"><CheckCircle2 className="w-5 h-5 flex-shrink-0" /><div>Applied. The change is scheduled{when ? ` for ${new Date(when).toLocaleString()}` : ' for the next working-hours slot'} and you will get an email with a revert link once it is on LinkedIn.</div></div>}
      {state === 'declined' && <div className="flex items-start gap-2 text-sm text-gray-700"><XCircle className="w-5 h-5 flex-shrink-0" /><div>Declined. Nothing was changed.</div></div>}
      {(state === 'ready' || state === 'working') && data && (
        <div className="space-y-4 text-sm">
          <p className="text-gray-700">{data.change.requested_by_email ?? 'Your outreach team'} proposes this change to <b>{data.sender?.display_name ?? 'your profile'}</b>. Nothing happens until you click Apply.</p>
          {data.change.note && <p className="text-gray-600 bg-gray-50 rounded-lg p-3 text-xs">{data.change.note}</p>}
          <Diff payload={data.change.payload} assets={data.change.assets} before={data.before} />
          <div className="text-xs text-gray-500">If you apply it, it is scheduled inside working hours and you are emailed afterwards with a one-click revert that works for 30 days. The link expires {new Date(data.change.expires_at).toLocaleDateString()}.</div>
          <div className="flex gap-2 pt-2"><Btn onClick={() => decide('apply')} disabled={state === 'working'}>Apply this change</Btn><Btn variant="secondary" onClick={() => decide('decline')} disabled={state === 'working'}>Decline</Btn></div>
        </div>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------- revert
interface Revert { change: { id: string; status: string; field_groups: FieldGroup[]; payload: ProfilePayload; applied_at: string | null; reverted_at: string | null }; sender: { display_name: string | null } | null; build: (RevertBuild & { error?: string }) | null }
export function RevertPage({ token }: { token: string }) {
  const [state, setState] = useState<State>('loading');
  const [data, setData] = useState<Revert | null>(null);
  const [msg, setMsg] = useState('');
  const [when, setWhen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call<Revert>({ action: 'revert_preview', token }).then((r) => { if (!live) return; setData(r); setState(r.change.reverted_at ? 'invalid' : 'ready'); }).catch((e) => { if (live) { setMsg(String(e.message)); setState(/valid|used|expired/i.test(e.message) ? 'invalid' : 'error'); } });
    return () => { live = false; };
  }, [token]);
  async function doRevert() {
    setState('working');
    try { const r = await call<{ status: string; scheduled_for?: string }>({ action: 'revert_apply', token }); setWhen(r.scheduled_for ?? null); setState('done'); }
    catch (e) { setMsg(String((e as Error).message)); setState('error'); }
  }
  const b = data?.build;
  return (
    <Shell title="Revert a change to your LinkedIn profile" icon={<ShieldCheck className="w-5 h-5 text-indigo-600" />}>
      {state === 'loading' && <p className="text-sm text-gray-600">Checking your link…</p>}
      {(state === 'invalid' || state === 'error') && <p className="text-sm text-red-700">{state === 'invalid' ? (data?.change.reverted_at ? 'This change was already reverted.' : ERR.invalid) : msg || ERR.error}</p>}
      {state === 'done' && <div className="flex items-start gap-2 text-sm text-green-800"><CheckCircle2 className="w-5 h-5 flex-shrink-0" /><div>The rollback is scheduled{when ? ` for ${new Date(when).toLocaleString()}` : ''}. You will get an email when it has landed.</div></div>}
      {(state === 'ready' || state === 'working') && data && (
        <div className="space-y-4 text-sm">
          <p className="text-gray-700">This restores <b>{data.sender?.display_name ?? 'your profile'}</b> to how it was before the change applied {data.change.applied_at ? new Date(data.change.applied_at).toLocaleString() : ''}. Here is what can be restored, and how faithfully:</p>
          {b && !b.error ? (
            <ul className="space-y-1.5">
              {b.fields.map((f) => <li key={f.key} className="flex items-start gap-2"><span className={cn('text-[11px] px-1.5 py-0.5 rounded-full flex-shrink-0', FIDELITY[f.fidelity].tone === 'green' ? 'bg-green-50 text-green-700' : FIDELITY[f.fidelity].tone === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-600')}>{FIDELITY[f.fidelity].label}</span><div><b>{payloadKeyLabel(f.key)}</b><div className="text-xs text-gray-600">{f.note}</div></div></li>)}
              {b.unrecoverable.map((u) => <li key={u.key} className="flex items-start gap-2"><span className="text-[11px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 flex-shrink-0">Not restorable</span><div><b>{payloadKeyLabel(u.key)}</b><div className="text-xs text-gray-600">{u.why}</div></div></li>)}
            </ul>
          ) : <p className="text-sm text-red-700">{b?.error ?? 'The rollback cannot be built.'}</p>}
          <div className="text-xs text-gray-500">The rollback follows the same daily limits as any change and is scheduled in working hours.</div>
          <div className="flex gap-2 pt-2"><Btn variant="danger" onClick={doRevert} disabled={state === 'working' || !b?.possible}>Revert now</Btn></div>
        </div>
      )}
    </Shell>
  );
}
