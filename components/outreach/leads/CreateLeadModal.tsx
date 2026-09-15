'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useLists, useStages } from '@/lib/outreach/queries';
import { parseError, rpc } from '@/lib/outreach/api';
import { Button, ErrorBox, Input, Modal, Select } from '@/components/outreach/ui';
import { normalizePublicIdentifier, type ToastFn } from './helpers';

const EMPTY = { identifier: '', first_name: '', last_name: '', company: '', title: '', headline: '', email_work: '', email_personal: '', client_id: '', list_id: '', stage_id: '' };

export function CreateLeadModal({ open, onClose, toast }: { open: boolean; onClose: () => void; toast: ToastFn }) {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const clients = useClients(workspace?.id);
  const lists = useLists(workspace?.id);
  const stages = useStages(workspace?.id);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const pub = normalizePublicIdentifier(form.identifier);
  const identifierInvalid = form.identifier.trim() !== '' && !pub;
  const hasKey = !!pub || !!form.email_work.trim() || !!form.email_personal.trim();

  const close = () => { setForm(EMPTY); setError(null); onClose(); };

  const submit = async (openAfter: boolean) => {
    if (!workspace || !hasKey || identifierInvalid) return;
    setBusy(true); setError(null);
    try {
      const lead: Record<string, unknown> = {
        public_identifier: pub, profile_url: pub ? `https://www.linkedin.com/in/${pub}` : null,
        first_name: form.first_name.trim() || null, last_name: form.last_name.trim() || null,
        company: form.company.trim() || null, title: form.title.trim() || null, headline: form.headline.trim() || null,
        email_work: form.email_work.trim() || null, email_personal: form.email_personal.trim() || null,
        client_id: form.client_id || null, list_id: form.list_id || null, stage_id: form.stage_id || null,
      };
      const res = await rpc<Array<{ id: string; created: boolean }> | { id: string; created: boolean }>('upsert_lead', { p_ws: workspace.id, p_lead: lead, p_source: 'manual' });
      const row = Array.isArray(res) ? res[0] : res;
      qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'leads'] });
      qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'dashboard'] });
      toast(row?.created ? 'Lead created' : 'Lead already existed — details merged');
      close();
      if (openAfter && row?.id) router.push(`/outreach/leads/${row.id}`);
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="New lead" size="lg"
      footer={<>
        <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="secondary" onClick={() => submit(true)} loading={busy} disabled={!hasKey || identifierInvalid}>Create &amp; open</Button>
        <Button onClick={() => submit(false)} loading={busy} disabled={!hasKey || identifierInvalid}>Create</Button>
      </>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        <Input label="LinkedIn URL or public identifier" placeholder="https://www.linkedin.com/in/jane-doe or jane-doe" value={form.identifier} onChange={set('identifier')}
          error={identifierInvalid ? 'Paste a linkedin.com/in/… URL or a bare identifier' : undefined}
          hint={pub ? `Identifier: ${pub}` : 'Required unless you provide an email. Existing leads with the same identifier are merged.'} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label="First name" value={form.first_name} onChange={set('first_name')} autoComplete="off" />
          <Input label="Last name" value={form.last_name} onChange={set('last_name')} autoComplete="off" />
          <Input label="Company" value={form.company} onChange={set('company')} autoComplete="off" />
          <Input label="Title" value={form.title} onChange={set('title')} autoComplete="off" />
        </div>
        <Input label="Headline" value={form.headline} onChange={set('headline')} autoComplete="off" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label="Work email" type="email" value={form.email_work} onChange={set('email_work')} autoComplete="off" />
          <Input label="Personal email" type="email" value={form.email_personal} onChange={set('email_personal')} autoComplete="off" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Select label="Client" value={form.client_id} onChange={set('client_id')}>
            <option value="">No client</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="List" value={form.list_id} onChange={set('list_id')}>
            <option value="">No list</option>
            {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select label="Stage" value={form.stage_id} onChange={set('stage_id')}>
            <option value="">No stage</option>
            {stages.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        {!hasKey && form.identifier === '' && form.email_work === '' && form.email_personal === '' ? null : !hasKey ? <p className="text-xs text-amber-700">A LinkedIn identifier or an email is required to create a lead.</p> : null}
        {error && <ErrorBox message={error} />}
        <button type="submit" className="hidden" aria-hidden="true" />
      </form>
    </Modal>
  );
}
