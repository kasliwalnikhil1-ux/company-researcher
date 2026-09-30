'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Trash2, UserRound } from 'lucide-react';
import { Button, PageLoader, Select, Textarea, ErrorBox, fmtDate, timeAgo } from '@/components/outreach/ui';
import { LEAD_STATUSES, SOURCE_LABEL, answerLabel, answerText, flag, leadsApi, placeOf, type LeadDetail, type LeadStatus } from '@/lib/platform/leads';
import { ConfirmModal, CopyField, Drawer, KV, Section, StatusBadge, errMsg, useAdminToast } from './shared';
import { LeadStatusBadge, SourceBadge } from './LeadsTab';

export default function LeadDrawer({ leadId, onClose, onOpenUser, onOpenLead }: { leadId: string | null; onClose: () => void; onOpenUser: (id: string) => void; onOpenLead: (id: string) => void }) {
  const q = useQuery({ queryKey: ['admin', 'leads', 'detail', leadId], queryFn: () => leadsApi.get(leadId as string), enabled: !!leadId });
  const l = q.data;
  return (
    <Drawer open={!!leadId} onClose={onClose} title={l ? (l.name ?? l.email ?? 'Lead') : 'Lead'} subtitle={l ? <span>{l.email}{l.company ? ` · ${l.company}` : ''}</span> : undefined}
      actions={l ? <div className="flex items-center gap-2"><SourceBadge source={l.source} /><LeadStatusBadge status={l.status} /></div> : undefined}>
      {q.isLoading && <PageLoader className="min-h-[40vh]" />}
      {q.error && <ErrorBox message={errMsg(q.error)} />}
      {l && <Body key={l.id + l.updated_at} l={l} onClose={onClose} onOpenUser={onOpenUser} onOpenLead={onOpenLead} />}
    </Drawer>
  );
}

function Body({ l, onClose, onOpenUser, onOpenLead }: { l: LeadDetail; onClose: () => void; onOpenUser: (id: string) => void; onOpenLead: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useAdminToast();
  const [status, setStatus] = useState<LeadStatus>(l.status);
  const [note, setNote] = useState(l.note ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = status !== l.status || (note.trim() || '') !== (l.note ?? '');

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'leads'] });

  const save = async () => {
    setBusy(true);
    try {
      await leadsApi.set(l.id, { status, note });
      toast('Lead saved');
      refresh();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await leadsApi.remove(l.id);
      toast('Lead deleted');
      refresh();
      onClose();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); setConfirmDelete(false); }
  };

  const answers = Object.entries(l.answers ?? {}).filter(([, v]) => answerText(v) !== '');
  const utm = Object.entries(l.utm ?? {});
  const mapHref = l.latitude != null && l.longitude != null ? `https://www.google.com/maps?q=${l.latitude},${l.longitude}` : l.country ? `https://www.google.com/maps/search/${encodeURIComponent(placeOf(l))}` : null;

  return (
    <div className="space-y-4">
      <Section title="Who" description={`${SOURCE_LABEL[l.source]} · ${fmtDate(l.created_at)} (${timeAgo(l.created_at)})`}>
        <dl className="grid grid-cols-2 gap-3">
          <KV label="Name">{l.name ?? <span className="text-gray-400">—</span>}</KV>
          <KV label="Company">{l.company ?? <span className="text-gray-400">—</span>}</KV>
          <KV label="Email">{l.email ? <CopyField value={l.email} /> : <span className="text-gray-400">—</span>}</KV>
          <KV label="Page">{l.page ?? <span className="text-gray-400">—</span>}</KV>
        </dl>
      </Section>

      <Section title="Answers" description={l.source === 'app_signup' ? 'App sign-ups carry no form answers; the website forms this email filled are listed under Timeline.' : 'What they typed or picked on the form.'}>
        {answers.length === 0 ? <p className="text-sm text-gray-400">Nothing recorded.</p> : (
          <dl className="grid grid-cols-2 gap-3">
            {answers.map(([k, v]) => <KV key={k} label={answerLabel(k)}><span className="whitespace-pre-wrap break-words">{answerText(v)}</span></KV>)}
          </dl>
        )}
      </Section>

      <Section title="Location" description="From the request that reached us. Only what the network told us; nothing is asked of the visitor." actions={mapHref ? <a href={mapHref} target="_blank" rel="noopener" className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1">Map <ExternalLink className="w-3 h-3" /></a> : undefined}>
        {!l.country && !l.timezone && !l.ip ? <p className="text-sm text-gray-400">Not available for this lead.</p> : (
          <dl className="grid grid-cols-2 gap-3">
            <KV label="Place">{l.country ? <span><span className="mr-1">{flag(l.country)}</span>{placeOf(l)}</span> : <span className="text-gray-400">unknown</span>}</KV>
            <KV label="Timezone">{l.timezone ?? <span className="text-gray-400">—</span>}</KV>
            <KV label="IP">{l.ip ? <span className="font-mono text-xs">{l.ip}</span> : <span className="text-gray-400">—</span>}</KV>
            <KV label="Coordinates">{l.latitude != null && l.longitude != null ? <span className="font-mono text-xs">{l.latitude.toFixed(3)}, {l.longitude.toFixed(3)}</span> : <span className="text-gray-400">—</span>}</KV>
          </dl>
        )}
      </Section>

      <Section title="Account" description="The app account with this email, if there is one.">
        {l.account ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><StatusBadge status={l.account.status} />{l.account.is_admin && <span className="text-xs text-indigo-600">admin</span>}</div>
              <div className="text-xs text-gray-500 mt-1">Signed up {fmtDate(l.account.created_at)} · last seen {l.account.last_sign_in_at ? timeAgo(l.account.last_sign_in_at) : 'never'}</div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => onOpenUser(l.account!.id)}><UserRound className="w-4 h-4" />Open account</Button>
          </div>
        ) : <p className="text-sm text-gray-400">No account yet. When this email signs up, the two are linked automatically.</p>}
      </Section>

      {(l.booked_at || l.booking) && (
        <Section title="Onboarding call" description="Booked from the app's welcome screen.">
          <dl className="grid grid-cols-2 gap-3">
            <KV label="Booked">{l.booked_at ? fmtDate(l.booked_at) : '—'}</KV>
            <KV label="Calendly event">{typeof l.booking?.event === 'string' ? <a href={l.booking.event as string} className="text-indigo-600 hover:underline break-all" target="_blank" rel="noopener">{l.booking.event as string}</a> : '—'}</KV>
          </dl>
        </Section>
      )}

      <Section title="Timeline" description="Every other lead with this email, newest first.">
        {l.timeline.length === 0 ? <p className="text-sm text-gray-400">Nothing else from this email.</p> : (
          <ul className="divide-y divide-gray-100">
            {l.timeline.map((t) => (
              <li key={t.id} className="py-2 flex items-center justify-between gap-3">
                <button type="button" className="text-left min-w-0" onClick={() => onOpenLead(t.id)}>
                  <div className="flex items-center gap-2"><SourceBadge source={t.source} /><span className="text-xs text-gray-500">{fmtDate(t.created_at)}</span></div>
                  {t.page && <div className="text-[11px] text-gray-400 mt-0.5">{t.page}</div>}
                </button>
                <LeadStatusBadge status={t.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Technical" description="Referrer, campaign tags and the browser, for attribution.">
        <dl className="grid grid-cols-2 gap-3">
          <KV label="Referrer">{l.referrer ? <span className="break-all text-xs">{l.referrer}</span> : <span className="text-gray-400">direct / unknown</span>}</KV>
          <KV label="UTM">{utm.length ? <span className="text-xs">{utm.map(([k, v]) => `${k}=${v}`).join(' · ')}</span> : <span className="text-gray-400">—</span>}</KV>
          <KV label="Browser">{l.user_agent ? <span className="text-xs break-all">{l.user_agent}</span> : <span className="text-gray-400">—</span>}</KV>
          <KV label="Lead id"><span className="font-mono text-xs">{l.id}</span></KV>
        </dl>
      </Section>

      <Section title="Follow-up" description="Status and a private note. Only admins see these.">
        <div className="space-y-3">
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Textarea label="Note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. spoke on 2 Oct, wants 12 senders, follow up after trial" />
          <div className="flex items-center gap-2">
            <Button size="sm" loading={busy} disabled={!dirty} onClick={save}>Save</Button>
            <Button size="sm" variant="danger" className="ml-auto" onClick={() => setConfirmDelete(true)}><Trash2 className="w-4 h-4" />Delete lead</Button>
          </div>
        </div>
      </Section>

      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} title="Delete this lead?" danger confirmLabel="Delete"
        message={<p>The form submission is removed for good. The account (if any) is not touched.</p>} />
    </div>
  );
}
