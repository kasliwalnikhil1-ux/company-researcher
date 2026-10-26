'use client';

import { useState } from 'react';
import { useRouter } from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk } from '@/lib/outreach/queries';
import { parseError, rpc } from '@/lib/outreach/api';
import type { Lead } from '@/lib/outreach/types';
import { Avatar, Badge, Button, Modal, fmtDate } from '@/components/outreach/ui';
import { Briefcase, ExternalLink, GitBranch, Mail, MapPin, MessageSquare, Phone, ShieldCheck, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import type { LeadWithIntel } from '@/lib/outreach/intel';
import { leadLinkedInUrl, leadName, type ToastFn } from '../helpers';
import { activeConsentByChannel, useLeadConsent } from '@/lib/outreach/channels';
import { ConsentBadge } from './LeadConsentCard';
import { KIND_LABEL, originLine, useLeadRelationshipActions, useLeadSummary } from '@/lib/outreach/leadsRelationships';
import { LeadStatusBadge } from '../relationships';

export function LeadHeader({ lead: leadRow, onEnroll, toast }: { lead: Lead; onEnroll: () => void; toast: ToastFn }) {
  const lead: LeadWithIntel = leadRow;
  const { workspace, canWrite } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const [confirm, setConfirm] = useState<'dnc' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const url = leadLinkedInUrl(lead);
  const consentQ = useLeadConsent(lead.id, workspace?.id);
  const consents = Object.values(activeConsentByChannel(consentQ.data));
  // 094: the status ladder, where the lead came from, and Add to prospects for inbox contacts / hidden leads
  const summaryQ = useLeadSummary(lead.id);
  const actions = useLeadRelationshipActions(workspace?.id);
  const isInboxContact = lead.origin === 'inbound' && !lead.prospect_since;
  const promote = async () => {
    try { await actions.promote.mutateAsync([lead.id]); toast(lead.hidden_at ? 'Unhidden and added to outbound' : 'Added to outbound'); }
    catch (e) { toast(parseError(e).message, 'error'); }
  };

  const invalidate = () => { qc.invalidateQueries({ queryKey: qk.lead(lead.id) }); if (workspace) { qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'leads'] }); qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'dashboard'] }); } };

  const toggleDnc = async () => {
    if (!workspace) return;
    setBusy(true);
    try {
      await rpc('bulk_leads', { p_ws: workspace.id, p_lead_ids: [lead.id], p_op: lead.do_not_contact ? 'clear_dnc' : 'set_dnc', p_value: null });
      invalidate();
      toast(lead.do_not_contact ? 'Do-not-contact cleared' : 'Marked as do-not-contact');
      setConfirm(null);
    } catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!workspace) return;
    setBusy(true);
    try {
      await rpc('bulk_leads', { p_ws: workspace.id, p_lead_ids: [lead.id], p_op: 'delete', p_value: null });
      qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'leads'] });
      qc.removeQueries({ queryKey: qk.lead(lead.id) });
      toast('Lead deleted');
      router.push('/outreach/leads');
    } catch (e) { toast(parseError(e).message, 'error'); setBusy(false); }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex flex-col md:flex-row md:items-start gap-4">
        <Avatar src={lead.picture_url} name={leadName(lead)} size={16} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-gray-900 truncate">{/^linkedin member$/i.test((lead.full_name ?? '').trim()) ? 'LinkedIn Member (name hidden)' : leadName(lead)}</h1>
            <LeadStatusBadge summary={summaryQ.data} size="sm" />
            {lead.kind && lead.kind !== 'person' && <span title="Classified from the first conversation. Unhide and add to outbound if this is a real person."><Badge tone="gray">{KIND_LABEL[lead.kind]}</Badge></span>}
            {lead.hidden_at && <span title={`Hidden from the leads page${lead.hidden_reason ? ` (${lead.hidden_reason.replace('_', ' ')})` : ''}. Use Add to outbound or Unhide to bring it back.`}><Badge tone="amber">Hidden</Badge></span>}
            {isInboxContact && !lead.hidden_at && <span title="They wrote to you and haven't been added to outreach yet."><Badge tone="blue">Inbound</Badge></span>}
            {lead.do_not_contact && <Badge tone="red"><ShieldOff className="w-3 h-3 mr-1" /> Do not contact</Badge>}
            {lead.unsubscribed && <Badge tone="amber">Unsubscribed</Badge>}
            {lead.is_open_profile === true && <Badge tone="blue">Open profile</Badge>}
            {lead.is_open_profile === false && <span title="Free InMail is not possible: connect first"><Badge tone="gray">Not an open profile</Badge></span>}
            {consents.map((c) => <ConsentBadge key={c.id} consent={c} />)}
          </div>
          {lead.headline && <p className="text-sm text-gray-700 mt-0.5">{lead.headline}</p>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 mt-1.5">
            {(lead.title || lead.company) && <span className="inline-flex items-center gap-1"><Briefcase className="w-3.5 h-3.5 text-gray-400" /> {[lead.title, lead.company].filter(Boolean).join(' · ')}</span>}
            {lead.location && <span className="inline-flex items-center gap-1"><MapPin className="w-3.5 h-3.5 text-gray-400" /> {lead.location}</span>}
            {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:underline"><ExternalLink className="w-3.5 h-3.5" /> {lead.public_identifier ? `in/${lead.public_identifier}` : 'LinkedIn profile'}</a>}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm mt-1.5">
            {lead.email_work && <a href={`mailto:${lead.email_work}`} className="inline-flex items-center gap-1 text-gray-700 hover:text-indigo-700"><Briefcase className="w-3.5 h-3.5 text-gray-400" /> {lead.email_work} <span className="text-xs text-gray-400">work</span></a>}
            {lead.email_personal && <a href={`mailto:${lead.email_personal}`} className="inline-flex items-center gap-1 text-gray-700 hover:text-indigo-700"><Mail className="w-3.5 h-3.5 text-gray-400" /> {lead.email_personal} <span className="text-xs text-gray-400">personal</span></a>}
            {!lead.email_work && !lead.email_personal && <span className="text-gray-400 text-xs">No email on file</span>}
            {lead.phone && <a href={`tel:${lead.phone}`} className="inline-flex items-center gap-1 text-gray-700 hover:text-indigo-700"><Phone className="w-3.5 h-3.5 text-gray-400" /> {lead.phone}</a>}
            {lead.last_replied_at && <span className="inline-flex items-center gap-1 text-purple-700" title={new Date(lead.last_replied_at).toLocaleString()}><MessageSquare className="w-3.5 h-3.5" /> Last replied {fmtDate(lead.last_replied_at)}{lead.last_replied_channel ? ` on ${lead.last_replied_channel === 'linkedin' ? 'LinkedIn' : lead.last_replied_channel === 'email' ? 'email' : lead.last_replied_channel === 'instagram' ? 'Instagram' : lead.last_replied_channel === 'whatsapp' ? 'WhatsApp' : lead.last_replied_channel}` : ''}</span>}
          </div>
          <p className="text-xs text-gray-400 mt-2">{originLine(lead, summaryQ.data, fmtDate)} · updated {fmtDate(lead.updated_at)}{lead.last_profile_fetch_at ? ` · profile fetched ${fmtDate(lead.last_profile_fetch_at)}` : ''}</p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap md:flex-col gap-2 md:items-stretch">
            {(isInboxContact || lead.hidden_at) && (
              <Button variant="secondary" onClick={promote} loading={actions.promote.isPending} title="Move this person to the Outbound tab (and unhide them)"><UserPlus className="w-4 h-4" /> Add to outbound</Button>
            )}
            <Button onClick={onEnroll} disabled={lead.do_not_contact} title={lead.do_not_contact ? 'Clear do-not-contact first' : 'Enrol in a sequence'}><GitBranch className="w-4 h-4" /> Enrol</Button>
            <Button variant="secondary" onClick={() => setConfirm('dnc')} title={lead.do_not_contact ? 'Clear do not contact — make this lead eligible for outreach again' : 'Mark as do not contact — exclude this lead from every sequence'}>{lead.do_not_contact ? <><ShieldCheck className="w-4 h-4" /> Clear DNC</> : <><ShieldOff className="w-4 h-4" /> Mark DNC</>}</Button>
            <Button variant="ghost" className="text-red-600" onClick={() => setConfirm('delete')}><Trash2 className="w-4 h-4" /> Delete</Button>
          </div>
        )}
      </div>
      <Modal open={confirm === 'dnc'} onClose={() => setConfirm(null)} title={lead.do_not_contact ? 'Clear do-not-contact?' : 'Mark as do-not-contact?'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button><Button variant={lead.do_not_contact ? 'primary' : 'danger'} loading={busy} onClick={toggleDnc}>{lead.do_not_contact ? 'Clear' : 'Mark DNC'}</Button></>}>
        <p className="text-sm text-gray-600">{lead.do_not_contact ? 'The lead becomes eligible for outreach again. Exited enrollments are not restarted.' : 'Live enrollments exit as suppressed, queued actions are cancelled, and no sequence will contact this person until you clear the flag.'}</p>
      </Modal>
      <Modal open={confirm === 'delete'} onClose={() => setConfirm(null)} title="Delete this lead?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button><Button variant="danger" loading={busy} onClick={remove}>Delete permanently</Button></>}>
        <p className="text-sm text-gray-600">Deletes {leadName(lead)} with tags, relation states, enrollments and tasks. Inbox conversations are kept. This cannot be undone.</p>
      </Modal>
    </div>
  );
}
