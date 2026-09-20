'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useClients, useLists, useStages } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import type { Lead } from '@/lib/outreach/types';
import { Button, Card, ErrorBox, Input, Select } from '@/components/outreach/ui';
import type { ToastFn } from '../helpers';

type Form = { first_name: string; last_name: string; headline: string; company: string; title: string; location: string; email_work: string; email_personal: string; phone: string; client_id: string; list_id: string; stage_id: string };

function fromLead(l: Lead): Form {
  return {
    first_name: l.first_name ?? '', last_name: l.last_name ?? '', headline: l.headline ?? '', company: l.company ?? '', title: l.title ?? '', location: l.location ?? '',
    email_work: l.email_work ?? '', email_personal: l.email_personal ?? '', phone: (l as Lead & { phone?: string | null }).phone ?? '', client_id: l.client_id ?? '', list_id: l.list_id ?? '', stage_id: l.stage_id ?? '',
  };
}

export function LeadEditForm({ lead, toast }: { lead: Lead; toast: ToastFn }) {
  const { workspace, canWrite } = useWorkspace();
  const qc = useQueryClient();
  const clients = useClients(workspace?.id);
  const lists = useLists(workspace?.id);
  const stages = useStages(workspace?.id);
  const [form, setForm] = useState<Form>(() => fromLead(lead));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setForm(fromLead(lead)); }, [lead]);
  const dirty = JSON.stringify(form) !== JSON.stringify(fromLead(lead));
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true); setError(null);
    try {
      const first = form.first_name.trim() || null; const last = form.last_name.trim() || null;
      const patch: Partial<Lead> & { phone?: string | null } = {
        first_name: first, last_name: last, headline: form.headline.trim() || null, company: form.company.trim() || null, title: form.title.trim() || null, location: form.location.trim() || null,
        email_work: form.email_work.trim().toLowerCase() || null, email_personal: form.email_personal.trim().toLowerCase() || null,
        client_id: form.client_id || null, list_id: form.list_id || null, stage_id: form.stage_id || null,
        phone: form.phone.trim() || null,
      };
      if ((first || last) && (first !== lead.first_name || last !== lead.last_name)) patch.full_name = [first, last].filter(Boolean).join(' ');
      const { error: err } = await supabase.from('outreach_leads').update(patch).eq('id', lead.id);
      if (err) throw err;
      qc.invalidateQueries({ queryKey: qk.lead(lead.id) });
      if (workspace) qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'leads'] });
      toast('Lead saved');
    } catch (e) {
      const err = parseError(e);
      setError(/duplicate|unique/i.test(err.message) ? 'Another lead already uses that email or identifier.' : err.message);
    } finally { setBusy(false); }
  };

  const ro = !canWrite;
  return (
    <Card title="Details" actions={canWrite && dirty ? <><Button size="sm" variant="secondary" onClick={() => setForm(fromLead(lead))} disabled={busy}>Reset</Button><Button size="sm" form="lead-edit-form" type="submit" loading={busy}>Save</Button></> : undefined}>
      <form id="lead-edit-form" onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="First name" value={form.first_name} onChange={set('first_name')} readOnly={ro} />
          <Input label="Last name" value={form.last_name} onChange={set('last_name')} readOnly={ro} />
        </div>
        <Input label="Headline" value={form.headline} onChange={set('headline')} readOnly={ro} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Company" value={form.company} onChange={set('company')} readOnly={ro} />
          <Input label="Title" value={form.title} onChange={set('title')} readOnly={ro} />
        </div>
        <Input label="Location" value={form.location} onChange={set('location')} readOnly={ro} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Work email" type="email" value={form.email_work} onChange={set('email_work')} readOnly={ro} />
          <Input label="Personal email" type="email" value={form.email_personal} onChange={set('email_personal')} readOnly={ro} />
        </div>
        <Input label="Phone" type="tel" value={form.phone} onChange={set('phone')} readOnly={ro} hint="Shown on call tasks." />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select label="Client" value={form.client_id} onChange={set('client_id')} disabled={ro}>
            <option value="">No client</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="List" value={form.list_id} onChange={set('list_id')} disabled={ro}>
            <option value="">No list</option>
            {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Stage" value={form.stage_id} onChange={set('stage_id')} disabled={ro}>
            <option value="">No stage</option>
            {stages.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        {error && <ErrorBox message={error} />}
        {canWrite && dirty && <div className="flex justify-end gap-2 sm:hidden"><Button type="submit" loading={busy}>Save</Button></div>}
      </form>
    </Card>
  );
}
