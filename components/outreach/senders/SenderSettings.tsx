'use client';

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Save, X } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk, useSenders } from '@/lib/outreach/queries';
import { Button, Card, ErrorBox, Input, Select, Textarea } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { EMAIL_RE, isMailbox, type SenderV2 } from './insights';
import TrackingDomainCard from './TrackingDomainCard';

type Notify = (message: string, type?: 'success' | 'error') => void;
const MAX_RECIPIENTS = 10;

// ---------------------------------------------------------------------------
// Chips input for email addresses
// ---------------------------------------------------------------------------
function EmailChips({ label, value, onChange, disabled, hint, max = MAX_RECIPIENTS }: { label: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; hint?: string; max?: number }) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function commit(raw: string): boolean {
    const parts = raw.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return true;
    const next = [...value];
    for (const p of parts) {
      if (!EMAIL_RE.test(p)) { setError(`"${p}" is not an email address.`); setDraft(parts.filter((x) => !next.includes(x)).join(', ')); onChange(next); return false; }
      if (next.includes(p)) continue;
      if (next.length >= max) { setError(`At most ${max} recipients.`); setDraft(''); onChange(next); return false; }
      next.push(p);
    }
    setError(null); setDraft(''); onChange(next);
    return true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === ' ' && draft.trim())) { e.preventDefault(); commit(draft); }
    else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  }

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-600 mb-1">{label} <span className="font-normal text-gray-400">({value.length}/{max})</span></label>
      <div className={cn('flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-lg border bg-white focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-500', error ? 'border-red-400' : 'border-gray-300', disabled && 'opacity-60')}>
        {value.map((em) => (
          <span key={em} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 text-indigo-800 text-xs pl-2.5 pr-1 py-0.5 max-w-full">
            <span className="truncate">{em}</span>
            {!disabled && <button type="button" onClick={() => { onChange(value.filter((x) => x !== em)); setError(null); }} aria-label={`Remove ${em}`} className="p-0.5 rounded-full hover:bg-indigo-100"><X className="w-3 h-3" /></button>}
          </span>
        ))}
        <input id={id} type="email" inputMode="email" autoComplete="off" value={draft} disabled={disabled || value.length >= max} aria-invalid={!!error} aria-describedby={`${id}-help`}
          onChange={(e) => { setDraft(e.target.value); setError(null); }} onKeyDown={onKeyDown} onBlur={() => commit(draft)}
          onPaste={(e) => { const text = e.clipboardData.getData('text'); if (/[\s,;]/.test(text.trim())) { e.preventDefault(); commit(`${draft} ${text}`); } }}
          placeholder={value.length >= max ? '' : value.length ? 'Add another' : 'name@company.com'} className="flex-1 min-w-[140px] px-1 py-1 text-sm bg-transparent text-gray-900 placeholder:text-gray-400 focus:outline-none disabled:cursor-not-allowed" />
      </div>
      <div id={`${id}-help`} className={cn('text-xs mt-1', error ? 'text-red-600' : 'text-gray-500')} role={error ? 'alert' : undefined}>{error ?? hint}</div>
    </div>
  );
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const costText = (v: SenderV2['monthly_cost']) => (v == null || String(v) === '' ? '' : String(Number(v)));

// ---------------------------------------------------------------------------
export default function SenderSettings({ sender, isManager, canWrite, notify, workspaceSettings }: { sender: SenderV2; isManager: boolean; canWrite: boolean; notify: Notify; workspaceSettings?: Record<string, unknown> }) {
  const qc = useQueryClient();
  const canManage = isManager && canWrite;
  const mailbox = isMailbox(sender);
  const senders = useSenders(mailbox ? sender.workspace_id : null);
  const people = useMemo(() => (senders.data ?? []).filter((s) => s.provider === 'LINKEDIN'), [senders.data]);

  const alertKey = (sender.alert_emails ?? []).join(',');   // a refetch returns a new array: compare by content so typing is not reset
  const initial = useMemo(() => ({
    alert_emails: alertKey ? alertKey.split(',') : [], booking_link: sender.booking_link ?? '', monthly_cost: costText(sender.monthly_cost),
    parent_sender_id: sender.parent_sender_id ?? '', signature: sender.signature ?? '', bcc_address: sender.bcc_address ?? '',
    track_replies: sender.track_replies == null ? 'default' : sender.track_replies ? 'on' : 'off',
  }), [alertKey, sender.booking_link, sender.monthly_cost, sender.parent_sender_id, sender.signature, sender.bcc_address, sender.track_replies]);
  const [form, setForm] = useState(initial);
  useEffect(() => { setForm(initial); }, [initial]);
  const [busy, setBusy] = useState<'general' | 'mailbox' | null>(null);
  const [errors, setErrors] = useState<{ general?: string; mailbox?: string }>({});
  const [preview, setPreview] = useState(false);

  const defaultCost = workspaceSettings?.sender_monthly_cost;
  const currency = typeof workspaceSettings?.currency === 'string' ? workspaceSettings.currency : 'USD';
  const wsTrack = workspaceSettings?.track_replies === true || workspaceSettings?.track_replies === 'true';

  const bookingError = form.booking_link.trim() && !/^https:\/\/\S+$/i.test(form.booking_link.trim()) ? 'The link must start with https://' : undefined;
  const costError = form.monthly_cost.trim() && !(Number(form.monthly_cost) >= 0) ? 'Enter a number, or leave it empty.' : undefined;
  const bccError = form.bcc_address.trim() && !EMAIL_RE.test(form.bcc_address.trim()) ? 'Enter one email address.' : undefined;

  const generalPatch = useMemo(() => {
    const p: Record<string, unknown> = {};
    if (!sameList(form.alert_emails, initial.alert_emails)) p.alert_emails = form.alert_emails;
    if (form.booking_link.trim() !== initial.booking_link) p.booking_link = form.booking_link.trim() || null;
    if (form.monthly_cost.trim() !== initial.monthly_cost) p.monthly_cost = form.monthly_cost.trim() === '' ? null : Number(form.monthly_cost);
    return p;
  }, [form, initial]);
  const mailboxPatch = useMemo(() => {
    const p: Record<string, unknown> = {};
    if (form.parent_sender_id !== initial.parent_sender_id) p.parent_sender_id = form.parent_sender_id || null;
    if (form.signature !== initial.signature) p.signature = form.signature.trim() ? form.signature : null;
    if (form.bcc_address.trim() !== initial.bcc_address) p.bcc_address = form.bcc_address.trim() || null;
    if (form.track_replies !== initial.track_replies) p.track_replies = form.track_replies === 'default' ? null : form.track_replies === 'on';
    return p;
  }, [form, initial]);

  async function save(which: 'general' | 'mailbox') {
    const patch = which === 'general' ? generalPatch : mailboxPatch;
    if (!Object.keys(patch).length) return;
    setBusy(which); setErrors((e) => ({ ...e, [which]: undefined }));
    try {
      await rpc('update_sender', { p_sender: sender.id, p_patch: patch });
      notify('Sender settings saved.');
      await Promise.all([qc.invalidateQueries({ queryKey: qk.sender(sender.id) }), qc.invalidateQueries({ queryKey: qk.senders(sender.workspace_id) })]);
    } catch (e) { setErrors((x) => ({ ...x, [which]: parseError(e).message })); }
    finally { setBusy(null); }
  }

  const generalDirty = Object.keys(generalPatch).length > 0;
  const mailboxDirty = Object.keys(mailboxPatch).length > 0;

  return (
    <div className="space-y-6">
      {!canManage && <div className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">Only managers can change these settings.</div>}

      <Card title="Alerts, booking and cost" actions={canManage ? <Button size="sm" onClick={() => save('general')} loading={busy === 'general'} disabled={!generalDirty || !!busy || !!bookingError || !!costError}><Save className="w-3.5 h-3.5" /> Save</Button> : undefined}>
        <div className="space-y-5">
          <EmailChips label="Alert recipients" value={form.alert_emails} onChange={(v) => setForm((f) => ({ ...f, alert_emails: v }))} disabled={!canManage}
            hint="These people get an email when this sender disconnects, runs out of leads or a sequence it is in stops. Owners and managers always get it. Press Enter after each address." />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <Input label="Booking link" type="url" inputMode="url" value={form.booking_link} onChange={(e) => setForm((f) => ({ ...f, booking_link: e.target.value }))} disabled={!canManage} placeholder="https://calendly.com/name/intro" error={bookingError}
                hint="Use it in messages as {{sender.booking_link}}. A booking marks the lead as “Meeting booked” and takes them out of the sequence." />
              <p className="text-xs text-gray-500 mt-1">Bookings reach us through a Calendly or Cal.com webhook. The webhook URL to paste there is in <Link href="/outreach/settings/email" className="text-indigo-600 hover:underline">Settings → Email &amp; booking</Link>.</p>
            </div>
            <Input label={`Monthly cost (${currency})`} type="number" min={0} step="0.01" inputMode="decimal" value={form.monthly_cost} onChange={(e) => setForm((f) => ({ ...f, monthly_cost: e.target.value }))} disabled={!canManage} error={costError}
              placeholder={defaultCost != null && defaultCost !== '' ? `${String(defaultCost)} (workspace default)` : 'Not set'}
              hint="What this sender costs you per month: seat, LinkedIn plan, proxy. It feeds cost per reply on the Reports page. Leave it empty to use the workspace default." />
          </div>
          {errors.general && <ErrorBox message={errors.general} />}
        </div>
      </Card>

      {mailbox && (
        <Card title="Mailbox" actions={canManage ? <Button size="sm" onClick={() => save('mailbox')} loading={busy === 'mailbox'} disabled={!mailboxDirty || !!busy || !!bccError}><Save className="w-3.5 h-3.5" /> Save</Button> : undefined}>
          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <Select label="Belongs to" value={form.parent_sender_id} onChange={(e) => setForm((f) => ({ ...f, parent_sender_id: e.target.value }))} disabled={!canManage || senders.isLoading}>
                  <option value="">Nobody (a shared mailbox)</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.display_name ?? p.public_identifier ?? 'Unnamed sender'}</option>)}
                </Select>
                <p className="text-xs text-gray-500 mt-1">Pick the LinkedIn sender who owns this mailbox. An email step can then send from all of that person&apos;s mailboxes and splits the emails evenly between them. A contact who was emailed before always gets the same mailbox.</p>
                {!senders.isLoading && people.length === 0 && <p className="text-xs text-amber-700 mt-1">There is no LinkedIn sender in this workspace yet.</p>}
              </div>
              <div>
                <Input label="BCC to CRM" type="email" value={form.bcc_address} onChange={(e) => setForm((f) => ({ ...f, bcc_address: e.target.value }))} disabled={!canManage} placeholder="12345@bcc.hubspot.com" error={bccError}
                  hint="Every email from this mailbox is copied to this address. HubSpot, Pipedrive and Salesforce log emails this way." />
              </div>
            </div>

            <div>
              <Select label="Track opens and clicks on manual replies" value={form.track_replies} onChange={(e) => setForm((f) => ({ ...f, track_replies: e.target.value }))} disabled={!canManage} className="md:max-w-sm">
                <option value="default">Workspace default (now {wsTrack ? 'on' : 'off'})</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
              <p className="text-xs text-gray-500 mt-1">This covers replies a person writes in the inbox. A tracking pixel in a one-to-one reply can hurt deliverability, so it is off unless you turn it on. Sequence emails are always tracked.</p>
            </div>

            <div>
              <div className="flex items-end justify-between gap-3">
                <div className="flex-1">
                  <Textarea label="Signature (HTML allowed)" value={form.signature} onChange={(e) => setForm((f) => ({ ...f, signature: e.target.value }))} disabled={!canManage} rows={6} spellCheck={false} className="font-mono text-xs"
                    placeholder={'<p>Jane Doe<br>Head of Growth, Acme</p>'} hint="Add it to an email step with {{sender.signature}}. Plain text works too." />
                </div>
              </div>
              <div className="mt-2">
                <button type="button" onClick={() => setPreview((v) => !v)} aria-expanded={preview} className="text-xs text-indigo-600 hover:underline">{preview ? 'Hide preview' : 'Show preview'}</button>
                {preview && (form.signature.trim()
                  ? <iframe title="Signature preview" sandbox="" className="mt-2 w-full h-40 rounded-lg border border-gray-200 bg-white" srcDoc={`<!doctype html><html><head><base target="_blank"><style>body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111827;margin:12px}img{max-width:100%}</style></head><body>${/<[a-z][\s\S]*>/i.test(form.signature) ? form.signature : form.signature.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</body></html>`} />
                  : <p className="mt-2 text-xs text-gray-500">Nothing to preview yet.</p>)}
              </div>
            </div>
            {errors.mailbox && <ErrorBox message={errors.mailbox} />}
          </div>
        </Card>
      )}

      {mailbox && <TrackingDomainCard sender={sender} canManage={canManage} notify={notify} />}
    </div>
  );
}
