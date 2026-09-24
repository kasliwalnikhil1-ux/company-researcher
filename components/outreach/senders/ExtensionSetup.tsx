'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardPaste, Copy, KeyRound, Puzzle, RefreshCw } from 'lucide-react';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import { Badge, Button, Card, Input, Modal, Textarea, fmtDate, timeAgo } from '@/components/outreach/ui';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { copyText } from './helpers';
import type { Sender } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;

export default function ExtensionSetup({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const canEdit = isManager && canWrite;
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const cookieOptIn = (workspace?.settings as Record<string, unknown> | undefined)?.cookie_mode_opt_in !== false;

  async function issue() {
    setConfirm(false); setBusy(true);
    try {
      const t = await rpc<string>('issue_sender_token', { p_sender: sender.id });
      setToken(t); setCopied(false);
      notify('Pairing token issued. It is shown only once.');
      qc.invalidateQueries({ queryKey: qk.sender(sender.id) });
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(false); }
  }

  const isLinkedIn = sender.provider === 'LINKEDIN';

  return (
    <div className="space-y-6">
      {isLinkedIn && <PasteCookie sender={sender} canEdit={canEdit} cookieOptIn={cookieOptIn} notify={notify} />}

      <Card title={<span className="flex items-center gap-2"><Puzzle className="w-4 h-4" /> Chrome extension (cookie sync)</span>}>
        <div className="text-sm text-gray-700 space-y-2">
          <p>The optional Chrome extension runs in the account owner's own browser and keeps this sender connected without repeated hosted logins. Every few hours (and whenever LinkedIn rotates the session cookie) it reads the <code className="text-xs bg-gray-100 px-1 rounded">li_at</code> / <code className="text-xs bg-gray-100 px-1 rounded">li_a</code> cookies plus the browser user-agent and posts them to this workspace, where they are encrypted at rest. If LinkedIn ever drops the session, the reconnect worker retries with the latest cookie automatically.</p>
          <p>The extension never sees the owner's password, and the pairing token below only allows cookie uploads for <strong>this sender</strong>. The extension refuses to sync if a different LinkedIn account is logged in.</p>
        </div>
        {!isLinkedIn && <div className="mt-4 text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">Cookie sync applies to LinkedIn senders only. Mailboxes stay connected through OAuth.</div>}
        {isLinkedIn && (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <div className="text-sm">
                <span className="text-gray-500">Pairing token:</span>{' '}
                {sender.extension_token_issued_at ? <Badge tone="green">issued {timeAgo(sender.extension_token_issued_at)}</Badge> : <Badge tone="gray">not issued</Badge>}
                {sender.extension_token_issued_at && <span className="text-xs text-gray-400 ml-2">{fmtDate(sender.extension_token_issued_at)}</span>}
              </div>
              {canEdit && cookieOptIn && (
                <Button size="sm" variant={sender.extension_token_issued_at ? 'secondary' : 'primary'} loading={busy} onClick={() => (sender.extension_token_issued_at ? setConfirm(true) : issue())}>
                  {sender.extension_token_issued_at ? <><RefreshCw className="w-3.5 h-3.5" /> Regenerate pairing token</> : <><KeyRound className="w-3.5 h-3.5" /> Generate pairing token</>}
                </Button>
              )}
              {!canEdit && <span className="text-xs text-gray-400">Only managers can issue tokens.</span>}
              {canEdit && !cookieOptIn && <span className="text-xs text-amber-700">Cookie mode is switched off for this workspace. Enable “Cookie-mode opt-in” under Settings → Workspace to issue pairing tokens.</span>}
            </div>
            {token && (
              <div className="mt-4 rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50 p-4">
                <div className="text-xs font-semibold text-indigo-900 uppercase tracking-wide">Copy this now — it will not be shown again</div>
                <div className="mt-2 p-4 rounded-lg bg-white border border-indigo-200 font-mono text-sm sm:text-base tracking-wider break-all text-gray-900 select-all" aria-label="Pairing token">{token}</div>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Button size="sm" onClick={async () => { const ok = await copyText(token); setCopied(ok); notify(ok ? 'Token copied.' : 'Copy failed — select the token and copy manually.', ok ? 'success' : 'error'); }}>{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy token'}</Button>
                  <span className="text-xs text-indigo-900">Send it to the account owner over a private channel. Anyone with the token can upload cookies for this sender until it is regenerated.</span>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {isLinkedIn && (
        <Card title="Setup instructions for the account owner">
          <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
            <li>Open <code className="text-xs bg-gray-100 px-1 rounded">chrome://extensions</code>, turn on <strong>Developer mode</strong>, click <strong>Load unpacked</strong> and choose the <code className="text-xs bg-gray-100 px-1 rounded">/extension</code> folder from the project (or the packaged build your admin shared).</li>
            <li>Click the extension icon, paste the pairing token above, and press <strong>Pair</strong>. The badge shows the time of the last successful sync.</li>
            <li>Stay logged in to LinkedIn in that browser profile with <strong>this</strong> account ({sender.public_identifier ? <span className="font-medium">{sender.public_identifier}</span> : 'the connected profile'}). The extension checks the profile id and shows an error badge if another account is logged in.</li>
            <li>Leave Chrome running; syncs happen every 3 hours and immediately when LinkedIn rotates the cookie. Nothing else is required.</li>
          </ol>
          <p className="text-xs text-gray-500 mt-4">To revoke access, regenerate the token (old token stops working immediately) or disable the sender with “purge secrets”.</p>
        </Card>
      )}

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Regenerate pairing token?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button><Button onClick={issue} loading={busy}>Regenerate</Button></>}>
        <p className="text-sm text-gray-700">The current token stops working immediately and the extension must be paired again with the new one. Existing stored cookies are kept.</p>
      </Modal>
    </div>
  );
}

/** Manual alternative to the extension: paste the li_at cookie copied from the owner's browser. */
function PasteCookie({ sender, canEdit, cookieOptIn, notify }: { sender: Sender; canEdit: boolean; cookieOptIn: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const [liAt, setLiAt] = useState('');
  const [liA, setLiA] = useState('');
  const [ua, setUa] = useState(() => (typeof navigator !== 'undefined' ? navigator.userAgent : ''));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await callFn<{ ok: boolean; reconnect: { ok: boolean; reason?: string } | null }>('sender-manage', { sender_id: sender.id, action: 'set_cookie', li_at: liAt, li_a: liA || undefined, user_agent: ua });
      setLiAt(''); setLiA('');
      if (!r.reconnect) notify('Session cookie saved. It will be used if this sender disconnects.');
      else if (r.reconnect.ok) notify('Session cookie saved. Reconnecting the sender now.');
      else notify(`Cookie saved, but the reconnect did not start (${r.reconnect.reason ?? 'unknown reason'}).`, 'error');
      qc.invalidateQueries({ queryKey: qk.sender(sender.id) });
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><ClipboardPaste className="w-4 h-4" /> Paste session cookie</span>}>
      <div className="text-sm text-gray-700 space-y-2">
        <p>No extension needed. In the browser where the account owner is logged in to LinkedIn as <strong>{sender.public_identifier ?? 'this sender'}</strong>, copy the value of the <code className="text-xs bg-gray-100 px-1 rounded">li_at</code> cookie for <code className="text-xs bg-gray-100 px-1 rounded">linkedin.com</code> (with a cookie editor extension, or DevTools → Application → Cookies) and paste it below. It is encrypted at rest and used to reconnect this sender.</p>
        <p className="text-gray-500">A pasted cookie does not refresh itself. If the owner logs out of LinkedIn or LinkedIn ends the session, paste a new one.</p>
      </div>
      {!canEdit && <p className="mt-4 text-xs text-gray-400">Only managers can save session cookies.</p>}
      {canEdit && !cookieOptIn && <p className="mt-4 text-xs text-amber-700">Cookie mode is switched off for this workspace. Enable “Cookie-mode opt-in” under Settings → Workspace to save session cookies.</p>}
      {canEdit && cookieOptIn && (
        <div className="mt-4 space-y-3">
          <Textarea label="li_at cookie value" rows={3} className="font-mono text-xs" value={liAt} onChange={(e) => setLiAt(e.target.value)} placeholder="AQEDA…" autoComplete="off" spellCheck={false} />
          <Input label="li_a cookie value (optional)" hint="Only Sales Navigator / Recruiter accounts have it." className="font-mono text-xs" value={liA} onChange={(e) => setLiA(e.target.value)} autoComplete="off" spellCheck={false} />
          <Input label="Browser user-agent" hint="Pre-filled with this browser. If the cookie was copied from another browser, paste that browser’s user-agent instead (search “what is my user agent” there)." className="font-mono text-xs" value={ua} onChange={(e) => setUa(e.target.value)} spellCheck={false} />
          <div className="flex justify-end"><Button loading={busy} disabled={!liAt.trim() || !ua.trim()} onClick={save}>Save cookie</Button></div>
        </div>
      )}
    </Card>
  );
}
