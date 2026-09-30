'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, Copy, ExternalLink, KeyRound, Lock, MonitorSmartphone, RefreshCw, Save, ShieldCheck, XCircle, CalendarClock } from 'lucide-react';
import { BROWSER_SIGNIN_ENABLED } from '@/lib/outreach/features';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { reasonText } from '@/lib/outreach/reasons';
import { qk, useActions } from '@/lib/outreach/queries';
import { Badge, Button, Card, EmptyState, Input, Select, StatusPill, Table, Td, Th, fmtDate, timeAgo } from '@/components/outreach/ui';
import { ACTION_LABELS, AUTH_METHOD_LABELS, COUNTRIES, HEALTH_KEYS, PROVIDER_LABELS, copyText, healthTextClass, healthTone, isAbandonedSignIn, isFuture, statusReasonText } from './helpers';
import { cn, normalizeEmail } from '@/lib/utils';
import type { Client, Sender } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;

const RECONNECT_METHODS: Array<{ id: 'credentials' | 'browser'; label: string; description: string }> = [
  { id: 'credentials', label: 'Sign in with LinkedIn', description: 'Email and password, plus any code LinkedIn asks for.' },
  { id: 'browser', label: 'Use the browser they’re signed in on', description: 'A small browser add-on approves the open LinkedIn account. No password.' },
];

/** WhatsApp: the number-age attestation (PRD §7.4). Level 0 cannot be promoted until it is recorded. */
function AccountAgeAttestation({ sender, canManage, notify, onDone }: { sender: Sender; canManage: boolean; notify: Notify; onDone: () => void }) {
  const [months, setMonths] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const n = Number(months);
  const ok = months !== '' && Number.isInteger(n) && n >= 6;
  const attested = !!sender.account_age_attested_at && typeof sender.account_age_months === 'number';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try {
      await callFn('sender-manage', { sender_id: sender.id, action: 'attest_account_age', months: n });
      notify('Number age recorded.');
      setEditing(false); setMonths('');
      onDone();
    } catch (err) { notify(parseError(err).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-100">
      <div className="text-xs font-medium text-gray-600 mb-1 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> Number age</div>
      {attested && !editing ? (
        <>
          <div className="text-sm text-gray-900">Number age attested: {sender.account_age_months} months on {fmtDate(sender.account_age_attested_at, false)}</div>
          <div className="text-[11px] text-gray-400 mt-1">Fresh numbers get restricted quickly, so the first governor level needs this on record. {canManage && <button type="button" onClick={() => setEditing(true)} className="text-indigo-600 hover:underline">Update</button>}</div>
        </>
      ) : (
        <>
          {!attested && <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Not attested yet. The number stays at level 0 (2 new conversations a day) until someone confirms it is at least 6 months old with real conversations on it.</div>}
          {canManage ? (
            <form onSubmit={submit} className="flex flex-col sm:flex-row sm:items-end gap-2 mt-2">
              <div className="flex-1"><Input label="Months in use" type="number" min={6} step={1} inputMode="numeric" placeholder="e.g. 18" value={months} onChange={(e) => setMonths(e.target.value)} error={months !== '' && !ok ? 'A whole number of at least 6' : undefined} /></div>
              <div className="flex gap-2">
                {editing && <Button type="button" variant="secondary" onClick={() => { setEditing(false); setMonths(''); }} disabled={busy}>Cancel</Button>}
                <Button type="submit" loading={busy} disabled={!ok}>Attest number age</Button>
              </div>
            </form>
          ) : <div className="text-[11px] text-gray-400 mt-1">Only managers can attest.</div>}
        </>
      )}
    </div>
  );
}

export default function SenderOverview({ sender, clients, isManager, canWrite, connected, notify }: { sender: Sender; clients: Client[]; isManager: boolean; canWrite: boolean; connected: string | null; notify: Notify }) {
  const qc = useQueryClient();
  const canManage = isManager && canWrite;
  const [busy, setBusy] = useState<string | null>(null);
  const [reloginLink, setReloginLink] = useState<string | null>(null);
  const [reconnectChoice, setReconnectMethod] = useState<'credentials' | 'browser'>(sender.auth_method === 'browser' ? 'browser' : 'credentials');
  const reconnectMethod = BROWSER_SIGNIN_ENABLED ? reconnectChoice : 'credentials';
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const serverForm = { display_name: sender.display_name ?? '', client_id: sender.client_id ?? '', owner_email: sender.owner_email ?? '' };
  const serverFormKey = `${sender.id}|${serverForm.display_name}|${serverForm.client_id}|${serverForm.owner_email}`;
  const [form, setForm] = useState(serverForm);
  const [formKey, setFormKey] = useState(serverFormKey);
  // Reset the draft when the server copy changes (different sender, or a save came back). Done during render, not in an effect.
  if (formKey !== serverFormKey) { setFormKey(serverFormKey); setForm(serverForm); }

  const upcoming = useActions({ sender_id: sender.id, status: ['queued', 'reserved'], upcoming: true, limit: 20 });
  const recent = useActions({ sender_id: sender.id, status: ['sent', 'failed'], limit: 20 });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.sender(sender.id) });
    qc.invalidateQueries({ queryKey: qk.senderEvents(sender.id) });
    qc.invalidateQueries({ queryKey: qk.senders(sender.workspace_id) });
    qc.invalidateQueries({ queryKey: qk.dashboard(sender.workspace_id) });
  };

  // The hosted page's failure redirect (?connected=0) is the only signal for a closed or expired sign-in page: flag the row now
  // so it shows as "Sign-in not completed" instead of "Connecting" (the server sweep would do it within the hour anyway).
  const flagIncomplete = connected === '0' && sender.status === 'connecting' && !sender.unipile_account_id && !sender.status_reason;
  useEffect(() => {
    if (!flagIncomplete) return;
    callFn('sender-manage', { sender_id: sender.id, action: 'sign_in_incomplete' }).then(invalidate).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagIncomplete, sender.id]);

  async function manage(action: string, extra: Record<string, unknown> = {}, successMsg?: string) {
    setBusy(action);
    try {
      const r = await callFn<Record<string, unknown>>('sender-manage', { sender_id: sender.id, action, ...extra });
      if (action === 'reconnect_cookie') { notify(r.ok ? 'Reconnect requested with the stored cookie. Status updates within a minute.' : `Cookie reconnect not possible: ${String(r.reason ?? 'unknown')}`, r.ok ? 'success' : 'error'); }
      else if (action === 'plan_now') { notify(`Planner ran: ${String(r.planned ?? r.created ?? r.count ?? 'done')} action(s) scheduled.`); }
      else if (action === 'recompute_health') { notify(typeof r.score === 'number' ? `Health recomputed: ${r.score}` : 'Health recompute skipped (debounced).'); }
      else if (action === 'checkpoint') { notify('Verification code submitted.'); setCode(''); setShowCode(false); }
      else notify(successMsg ?? 'Done.');
      invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  /** "Sign in now" opens a fresh hosted sign-in link here. "Copy" gives the owner a re-login link that lasts 7 days and creates
   *  the hosted link only when they open it. One copied link per method choice. */
  async function reconnect(mode: 'redirect' | 'copy') {
    setBusy(`reconnect_${mode}`);
    try {
      const args = { sender_id: sender.id, action: 'reconnect_link', ...(isLinkedIn ? { connect_method: reconnectMethod } : {}) };
      if (mode === 'redirect') {
        const r = await callFn<{ link: string }>('sender-manage', args);
        window.location.href = String(r.link ?? '');
        return;
      }
      let link = reloginLink;
      if (!link) {
        const r = await callFn<{ link: string }>('sender-manage', { ...args, mode: 'copy' });
        link = String(r.link ?? '');
        setReloginLink(link);
      }
      const ok = await copyText(link);
      notify(ok ? 'Link copied. It works for 7 days.' : 'Could not copy automatically. Copy the link below instead.', ok ? 'success' : 'error');
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function saveDetails() {
    setBusy('details');
    try {
      await rpc('update_sender', { p_sender: sender.id, p_patch: { display_name: form.display_name.trim() || null, client_id: form.client_id || null, owner_email: normalizeEmail(form.owner_email) || null } });
      notify('Sender details saved.'); invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  const needsRelogin = sender.status === 'credentials';
  // a first sign-in that never finished, or that the hosted page reported as failed: the card is highlighted like a re-login
  const signInFailed = isAbandonedSignIn(sender) || (sender.status === 'error' && !sender.unipile_account_id);
  const canReconnect = sender.status !== 'disabled' && (sender.status === 'connecting' || sender.status === 'error' || sender.auth_method === 'cookie');
  const urgent = needsRelogin || signInFailed;
  const checkpointHint = /checkpoint|otp|2fa|in_app|validation|captcha|phone/i.test(sender.status_reason ?? '');
  const breakdown = HEALTH_KEYS.map((k) => ({ ...k, value: typeof sender.health_breakdown?.[k.key] === 'number' ? Math.round(sender.health_breakdown[k.key]) : null }));
  const locked = isFuture(sender.warmup_locked_until);
  const isLinkedIn = sender.provider === 'LINKEDIN';
  const isInstagram = sender.provider === 'INSTAGRAM';
  const isWhatsApp = sender.provider === 'WHATSAPP';
  const maxLevel = isWhatsApp ? 4 : 5;
  const channelName = PROVIDER_LABELS[sender.provider];
  const profileHref = isLinkedIn && sender.public_identifier ? `https://www.linkedin.com/in/${sender.public_identifier}` : isInstagram && sender.public_identifier ? `https://www.instagram.com/${sender.public_identifier.replace(/^@/, '')}/` : null;

  return (
    <div className="space-y-6">
      {connected === '1' && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 text-green-800 text-sm border border-green-200"><CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>Hosted login completed. The account is syncing — the profile, connections count and inbox backfill arrive within a few minutes.</span></div>
      )}
      {connected === '0' && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 text-red-800 text-sm border border-red-200"><XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>Hosted login did not complete. {canManage ? 'Create a fresh sign-in link below (copied links work for 7 days) or disable this sender.' : 'Ask a manager to generate a fresh link.'}</span></div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title="Connection" actions={canManage ? (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => manage('refresh_profile', {}, 'Profile refreshed.')} loading={busy === 'refresh_profile'} disabled={!!busy || !sender.unipile_account_id} title="Update this sender's details shown here (name, photo, connections count, Premium / Sales Navigator / Recruiter). Use after you change your LinkedIn profile. Does not touch the inbox."><RefreshCw className="w-3.5 h-3.5" /> Refresh profile</Button>
            <Button size="sm" variant="secondary" onClick={() => manage('resync', {}, 'Conversations are being refreshed. New messages arrive over the next few minutes.')} loading={busy === 'resync'} disabled={!!busy || !sender.unipile_account_id} title="Re-import this account's conversations from LinkedIn so the inbox catches up. Use when messages look missing or stale, or after reconnecting. New messages arrive over the next few minutes; you do not need to press it again."><RefreshCw className="w-3.5 h-3.5" /> Refresh conversations</Button>
            <Button size="sm" variant="secondary" onClick={() => manage('recompute_health')} loading={busy === 'recompute_health'} disabled={!!busy}><Activity className="w-3.5 h-3.5" /> Recheck health</Button>
            <Button size="sm" variant="secondary" onClick={() => manage('plan_now')} loading={busy === 'plan_now'} disabled={!!busy || sender.status !== 'ok'} title="Schedule this sender's remaining actions for today right now, from its active sequences, within its schedule and daily limits. Runs automatically every 20 minutes anyway; use this after enrolling leads, changing the schedule or reconnecting when you do not want to wait. Safe to press more than once."><CalendarClock className="w-3.5 h-3.5" /> Schedule today’s actions</Button>
          </div>
        ) : undefined}>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill status={sender.status} reason={statusReasonText(sender.status_reason)} />
            {sender.status_reason && <span className="text-sm text-gray-600">{statusReasonText(sender.status_reason)}</span>}
            {isFuture(sender.paused_until) && <Badge tone="amber">{sender.provider_warning ? 'paused after a warning until' : 'auto-paused until'} {fmtDate(sender.paused_until)}</Badge>}
            {isFuture(sender.outreach_allowed_from) && <Badge tone="blue">quiet period: outreach starts {fmtDate(sender.outreach_allowed_from)}</Badge>}
            {isFuture(sender.invite_blocked_until) && <Badge tone="amber">invites blocked until {fmtDate(sender.invite_blocked_until, false)}</Badge>}
          </div>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 mt-4 text-sm">
            <div><dt className="text-xs text-gray-500">Provider</dt><dd className="text-gray-900">{PROVIDER_LABELS[sender.provider]}</dd></div>
            <div><dt className="text-xs text-gray-500">Auth method</dt><dd className="text-gray-900">{AUTH_METHOD_LABELS[sender.auth_method] ?? sender.auth_method}</dd></div>
            <div><dt className="text-xs text-gray-500">Connected</dt><dd className="text-gray-900">{fmtDate(sender.connected_at)}</dd></div>
            <div><dt className="text-xs text-gray-500">Last sync</dt><dd className="text-gray-900" title={fmtDate(sender.last_synced_at)}>{timeAgo(sender.last_synced_at)}</dd></div>
            <div><dt className="text-xs text-gray-500">Last OK</dt><dd className="text-gray-900">{timeAgo(sender.last_ok_at)}</dd></div>
            <div><dt className="text-xs text-gray-500">Last disconnect</dt><dd className="text-gray-900">{timeAgo(sender.last_disconnect_at)}</dd></div>
            <div><dt className="text-xs text-gray-500">Reconnect attempts</dt><dd className="text-gray-900">{sender.reconnect_attempts}</dd></div>
            <div><dt className="text-xs text-gray-500">Rejects (1h)</dt><dd className={cn('text-gray-900', sender.rejects_1h >= 3 && 'text-red-700 font-medium')}>{sender.rejects_1h}</dd></div>
          </dl>

          {(needsRelogin || canReconnect) && canManage && (
            <div className={cn('mt-5 rounded-xl border p-4', urgent ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50')}>
              <div className={cn('text-sm font-semibold flex items-center gap-2', urgent ? 'text-red-900' : 'text-gray-900')}><KeyRound className="w-4 h-4" /> {needsRelogin ? 'This account needs a fresh login' : signInFailed ? 'The sign-in was not completed' : 'Reconnect with a secure sign-in'}</div>
              <p className={cn('text-sm mt-1', urgent ? 'text-red-800' : 'text-gray-600')}>{needsRelogin ? `${channelName} ended the session. Actions are held until the owner signs in again.`
                : signInFailed ? `${sender.status_reason === 'SIGN_IN_FAILED' || sender.status_reason === 'CREATION_FAIL' ? `${channelName} rejected the sign-in (wrong password, or a verification step was not finished).` : 'The sign-in page was closed or its link expired (links last 15 minutes).'} Nothing was connected: send a fresh link and the owner can try again.`
                : sender.auth_method === 'cookie' ? 'Connected by cookie, so profile edits are locked. Have the owner sign in to unlock them.' : 'Use this if the account is stuck connecting or shows an error.'}</p>
              <p className={cn('text-sm', urgent ? 'text-red-800' : 'text-gray-600')}>Not the owner? Copy the link and send it to {sender.owner_email ?? 'them'}.</p>
              {isLinkedIn && BROWSER_SIGNIN_ENABLED && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
                  {RECONNECT_METHODS.map((m) => (
                    <button key={m.id} type="button" onClick={() => { setReconnectMethod(m.id); setReloginLink(null); }} aria-pressed={reconnectMethod === m.id}
                      className={cn('text-left p-3 rounded-lg border bg-white transition-colors', reconnectMethod === m.id ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-gray-200 hover:bg-gray-50')}>
                      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">{m.id === 'browser' ? <MonitorSmartphone className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />} {m.label}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{m.description}</div>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                <Button onClick={() => reconnect('redirect')} loading={busy === 'reconnect_redirect'} disabled={!!busy}><ExternalLink className="w-4 h-4" /> Sign in now</Button>
                <Button variant="secondary" onClick={() => reconnect('copy')} loading={busy === 'reconnect_copy'} disabled={!!busy}><Copy className="w-4 h-4" /> Copy sign-in link</Button>
                {needsRelogin && sender.auth_method === 'cookie' && <Button variant="secondary" onClick={() => manage('reconnect_cookie')} loading={busy === 'reconnect_cookie'} disabled={!!busy}>Retry cookie reconnect</Button>}
              </div>
              {reloginLink && (
                <div className="mt-3">
                  <div className="text-xs text-gray-600 mb-1">Sign-in link (works for 7 days)</div>
                  <input readOnly value={reloginLink} onFocus={(e) => e.currentTarget.select()} aria-label="Sign-in link" className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 bg-white text-gray-700" />
                </div>
              )}
            </div>
          )}

          {isLinkedIn && canManage && sender.status !== 'ok' && sender.status !== 'disabled' && sender.unipile_account_id && (
            <div className={cn('mt-4 rounded-xl border p-4', checkpointHint ? 'border-amber-300 bg-amber-50' : 'border-gray-200')}>
              {checkpointHint || showCode ? (
                <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) manage('checkpoint', { code: code.trim() }); }} className="flex flex-col sm:flex-row sm:items-end gap-2">
                  <div className="flex-1">
                    <Input label="Verification code (LinkedIn checkpoint)" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code from email / app" inputMode="numeric" autoComplete="one-time-code" hint="LinkedIn asked the owner to verify. Enter the code they received to complete the login." />
                  </div>
                  <Button type="submit" loading={busy === 'checkpoint'} disabled={!code.trim() || !!busy}>Submit code</Button>
                </form>
              ) : (
                <button type="button" onClick={() => setShowCode(true)} className="text-sm text-indigo-600 hover:underline">Have a verification code from LinkedIn? Enter it here</button>
              )}
            </div>
          )}
        </Card>

        <Card title="Health">
          <div className="flex items-end gap-3">
            <div className={cn('text-4xl font-bold tabular-nums', healthTextClass(sender.health_score))}>{sender.health_score}</div>
            <div className="text-xs text-gray-500 pb-1.5">{sender.health_score >= 85 ? 'Excellent — eligible for level-up after 14 days' : sender.health_score >= 70 ? 'Good' : sender.health_score >= 50 ? 'Caps scaled ×0.6' : 'Below 50 — sender auto-paused'}</div>
          </div>
          <div className="mt-4 space-y-2.5">
            {breakdown.map((b) => (
              <div key={b.key} title={b.hint}>
                <div className="flex justify-between text-xs text-gray-600"><span>{b.label}</span><span className="tabular-nums">{b.value ?? '—'}</span></div>
                <div className="h-1.5 mt-1 bg-gray-100 rounded-full overflow-hidden">
                  <div className={cn('h-full', b.value == null ? 'bg-gray-300' : healthTone(b.value) === 'green' ? 'bg-green-500' : healthTone(b.value) === 'lime' ? 'bg-lime-500' : healthTone(b.value) === 'amber' ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${b.value ?? 0}%` }} />
                </div>
              </div>
            ))}
          </div>
          {typeof sender.health_breakdown?.computed_at === 'string' && <div className="text-[11px] text-gray-400 mt-3">Computed {timeAgo(String(sender.health_breakdown.computed_at))}</div>}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card title="Profile">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-gray-500">Warm-up level</dt><dd className="flex items-center gap-2"><Badge tone="indigo">Level {sender.warmup_level} / {maxLevel}</Badge>{locked && <span className="inline-flex items-center gap-1 text-xs text-gray-500" title="Onboarding gate: new or small accounts stay at level 0 for at least 28 days"><Lock className="w-3 h-3" /> until {fmtDate(sender.warmup_locked_until, false)}</span>}</dd></div>
            {isLinkedIn && <div className="flex justify-between gap-3"><dt className="text-gray-500">Connections</dt><dd className="text-gray-900 tabular-nums">{sender.connections_count == null ? 'unknown' : sender.connections_count.toLocaleString()}</dd></div>}
            {isInstagram && sender.connections_count != null && <div className="flex justify-between gap-3"><dt className="text-gray-500">Followers</dt><dd className="text-gray-900 tabular-nums">{sender.connections_count.toLocaleString()}</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-gray-500">{isWhatsApp ? 'Number' : isInstagram ? 'Handle' : 'Profile'}</dt><dd className="text-gray-900 truncate">{profileHref ? <a className="text-indigo-600 hover:underline" href={profileHref} target="_blank" rel="noreferrer">{sender.public_identifier}</a> : sender.public_identifier || '—'}</dd></div>
            {isLinkedIn && (
              <div className="flex justify-between gap-3"><dt className="text-gray-500">Plans</dt><dd className="flex flex-wrap gap-1 justify-end">
                {sender.is_premium && <Badge tone="amber">Premium</Badge>}{sender.has_sales_nav && <Badge tone="blue">Sales Navigator</Badge>}{sender.has_recruiter && <Badge tone="purple">Recruiter</Badge>}
                {!sender.is_premium && !sender.has_sales_nav && !sender.has_recruiter && <span className="text-gray-400">Basic</span>}
              </dd></div>
            )}
            <div className="flex justify-between gap-3"><dt className="text-gray-500">Timezone</dt><dd className="text-gray-900">{sender.timezone}</dd></div>
          </dl>
          {isWhatsApp && <AccountAgeAttestation sender={sender} canManage={canManage} notify={notify} onDone={invalidate} />}
          {isLinkedIn && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="text-xs font-medium text-gray-600 mb-1 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> Proxy</div>
              <div className="text-sm text-gray-900">{sender.proxy_country ? `${COUNTRIES.find((c) => c.code === sender.proxy_country)?.name ?? sender.proxy_country} (${sender.proxy_country})` : 'Pinned at connect'}</div>
              <div className="text-[11px] text-gray-400 mt-1">{sender.proxy_country ? 'Set from this app. ' : 'Fixed IP near wherever the owner opened the sign-in link. '}{canManage ? 'Change it only if the owner really is somewhere else, under the Danger tab.' : 'Only managers can change it.'}</div>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2" title="Details" actions={canManage ? <Button size="sm" onClick={saveDetails} loading={busy === 'details'} disabled={!!busy}><Save className="w-3.5 h-3.5" /> Save</Button> : undefined}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input label="Display name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} disabled={!canManage} />
            <Select label="Client" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} disabled={!canManage}>
              <option value="">No client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input label="Owner email" type="email" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} onBlur={() => setForm((f) => ({ ...f, owner_email: normalizeEmail(f.owner_email) }))} disabled={!canManage} hint="Receives re-login reminders" />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card title="Upcoming actions" actions={<span className="text-xs text-gray-400">next 20 queued</span>}>
          {upcoming.isLoading ? <div className="text-sm text-gray-400 py-4 text-center">Loading…</div> : !upcoming.data?.length ? (
            <EmptyState title="Nothing queued" description={sender.status === 'ok' ? 'The nightly planner fills tomorrow\'s windows from active enrollments.' : 'Actions are only planned while the sender is connected.'} />
          ) : (
            <Table>
              <thead><tr><Th>When</Th><Th>Action</Th><Th>Lead</Th><Th>Status</Th></tr></thead>
              <tbody>{upcoming.data.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap">{fmtDate(a.scheduled_for)}</Td>
                  <Td>{ACTION_LABELS[a.action_type] ?? a.action_type}</Td>
                  <Td>{a.lead_id ? <Link className="text-indigo-600 hover:underline" href={`/outreach/leads/${a.lead_id}`}>{a.outreach_leads?.full_name ?? a.outreach_leads?.public_identifier ?? 'Lead'}</Link> : <span className="text-gray-400">—</span>}</Td>
                  <Td><Badge tone={a.status === 'reserved' ? 'blue' : 'gray'}>{a.status}</Badge></Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
        <Card title="Recent actions" actions={<span className="text-xs text-gray-400">last 20 sent / failed</span>}>
          {recent.isLoading ? <div className="text-sm text-gray-400 py-4 text-center">Loading…</div> : !recent.data?.length ? <EmptyState title="No actions executed yet" /> : (
            <Table>
              <thead><tr><Th>When</Th><Th>Action</Th><Th>Lead</Th><Th>Result</Th></tr></thead>
              <tbody>{recent.data.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap">{fmtDate(a.executed_at ?? a.scheduled_for)}</Td>
                  <Td>{ACTION_LABELS[a.action_type] ?? a.action_type}</Td>
                  <Td>{a.lead_id ? <Link className="text-indigo-600 hover:underline" href={`/outreach/leads/${a.lead_id}`}>{a.outreach_leads?.full_name ?? a.outreach_leads?.public_identifier ?? 'Lead'}</Link> : <span className="text-gray-400">—</span>}</Td>
                  <Td>
                    <Badge tone={a.status === 'sent' ? 'green' : 'red'}>{a.status}</Badge>
                    {a.error_code && <span className="ml-2 text-xs text-red-600">{reasonText(a.error_code, a.decision)}</span>}
                  </Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
