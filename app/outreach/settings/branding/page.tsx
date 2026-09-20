'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Palette, Save } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { DEFAULT_ACCENT, brandingKey, isHexColor, isHttpsUrl, useBranding, type Branding } from '@/lib/outreach/branding';
import { Button, Card, ErrorBox, Input, Spinner, useToast } from '@/components/outreach/ui';
import { SettingRow, SettingsFrame, Switch, isEmail } from '@/components/outreach/settings/shared';
import BrandingPreview from '@/components/outreach/settings/BrandingPreview';
import DomainsCard from '@/components/outreach/settings/DomainsCard';

type Form = { product_name: string; logo_url: string; accent: string; support_email: string; help_url: string; docs_url: string; email_from_name: string; email_from_address: string; hide_platform_name: boolean };
const toForm = (b: Branding | undefined): Form => ({
  product_name: b?.product_name ?? '', logo_url: b?.logo_url ?? '', accent: b?.accent ?? '', support_email: b?.support_email ?? '', help_url: b?.help_url ?? '',
  docs_url: b?.docs_url ?? '', email_from_name: b?.email_from_name ?? '', email_from_address: b?.email_from_address ?? '', hide_platform_name: !!b?.hide_platform_name,
});

function problems(f: Form) {
  const url = (v: string) => (v.trim() && !isHttpsUrl(v.trim()) ? 'Must start with https://' : undefined);
  return {
    product_name: f.product_name.trim().length > 60 ? 'Keep it under 60 characters' : undefined,
    logo_url: url(f.logo_url),
    accent: f.accent.trim() && !isHexColor(f.accent.trim()) ? 'Use a six-digit hex colour such as #0f766e' : undefined,
    support_email: f.support_email.trim() && !isEmail(f.support_email) ? 'Enter a full email address' : undefined,
    help_url: url(f.help_url), docs_url: url(f.docs_url),
    email_from_name: f.email_from_name.trim().length > 60 ? 'Keep it under 60 characters' : undefined,
    email_from_address: f.email_from_address.trim() && !isEmail(f.email_from_address) ? 'Enter a full email address' : undefined,
  };
}

function BrandingForm() {
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const branding = useBranding(ws);
  const [form, setForm] = useState<Form>(toForm(undefined));
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedPrint = JSON.stringify(toForm(branding.data));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setForm(JSON.parse(savedPrint) as Form); }, [savedPrint]);

  const errs = problems(form);
  const blocking = Object.values(errs).some(Boolean);
  // a soft warning only: it can still be saved, the hint explains the effect
  const nameHint = form.hide_platform_name && !form.product_name.trim() ? 'No product name yet: clients will see the workspace name instead.' : 'Shown in the portal header, the browser tab and emails.';
  const dirty = JSON.stringify(form) !== savedPrint;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const preview: Branding = useMemo(() => ({
    workspace_name: workspace?.name, product_name: form.product_name.trim() || undefined, logo_url: form.logo_url.trim() || undefined, accent: isHexColor(form.accent.trim()) ? form.accent.trim() : undefined,
    support_email: form.support_email.trim() || undefined, help_url: form.help_url.trim() || undefined, docs_url: form.docs_url.trim() || undefined,
    email_from_name: form.email_from_name.trim() || undefined, email_from_address: form.email_from_address.trim() || undefined, hide_platform_name: form.hide_platform_name,
  }), [form, workspace?.name]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ws || blocking) return;
    setBusy(true); setSaveError(null);
    try {
      const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
      await rpc<Branding>('set_branding', { p_ws: ws, p_branding: payload });
      await qc.invalidateQueries({ queryKey: brandingKey(ws) });
      toast.show('Branding saved. Clients see it the next time they open the portal.');
    } catch (er) { setSaveError(parseError(er).message); }
    finally { setBusy(false); }
  }

  if (branding.isLoading) return <Card title="Branding"><Spinner /></Card>;
  if (branding.isError) return <Card title="Branding"><ErrorBox message={parseError(branding.error).message} /></Card>;
  const ro = !canWrite;

  return (
    <Card title={<span className="flex items-center gap-2"><Palette className="w-4 h-4" /> Branding</span>}>
      <p className="text-xs text-gray-500 mb-4">What your clients see: in the client portal, on the invitation page and in every email they get from us. Your own team keeps the normal look.</p>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        <form onSubmit={save} className="lg:col-span-3 space-y-4" noValidate>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Product name" value={form.product_name} onChange={(e) => set('product_name', e.target.value)} placeholder="Agency Reports" maxLength={60} error={errs.product_name} hint={nameHint} disabled={ro} />
            <div>
              <span className="block text-xs font-medium text-gray-600 mb-1">Accent colour</span>
              <div className="flex gap-2">
                <input type="color" aria-label="Pick the accent colour" value={isHexColor(form.accent.trim()) ? form.accent.trim() : DEFAULT_ACCENT} onChange={(e) => set('accent', e.target.value)} disabled={ro} className="w-10 h-[38px] p-0.5 rounded-lg border border-gray-300 bg-white cursor-pointer disabled:cursor-not-allowed" />
                <div className="flex-1"><Input aria-label="Accent colour as hex" value={form.accent} onChange={(e) => set('accent', e.target.value)} placeholder={DEFAULT_ACCENT} error={errs.accent} spellCheck={false} disabled={ro} /></div>
              </div>
              {!errs.accent && <span className="block text-xs text-gray-500 mt-1">Buttons, links and the active menu item.</span>}
            </div>
          </div>
          <Input label="Logo URL" value={form.logo_url} onChange={(e) => set('logo_url', e.target.value)} placeholder="https://agency.com/logo.png" error={errs.logo_url} hint="A wide PNG or SVG on a transparent background, at least 56 px tall. It must be reachable over https." spellCheck={false} disabled={ro} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input label="Support email" type="email" value={form.support_email} onChange={(e) => set('support_email', e.target.value)} placeholder="help@agency.com" error={errs.support_email} disabled={ro} />
            <Input label="Help URL" value={form.help_url} onChange={(e) => set('help_url', e.target.value)} placeholder="https://agency.com/help" error={errs.help_url} spellCheck={false} disabled={ro} />
            <Input label="Docs URL" value={form.docs_url} onChange={(e) => set('docs_url', e.target.value)} placeholder="https://docs.agency.com" error={errs.docs_url} spellCheck={false} disabled={ro} />
          </div>
          <p className="text-xs text-gray-500 -mt-2">These three fill the Help menu your clients see. Leave one empty and it is left out.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="From name for client emails" value={form.email_from_name} onChange={(e) => set('email_from_name', e.target.value)} placeholder="Agency Reports" maxLength={60} error={errs.email_from_name} disabled={ro} />
            <Input label="From address for client emails" type="email" value={form.email_from_address} onChange={(e) => set('email_from_address', e.target.value)} placeholder="reports@agency.com" error={errs.email_from_address} hint="The domain must be verified with our email provider first. Until then we send from our own address with your from-name." disabled={ro} />
          </div>
          <div className="border border-gray-200 rounded-lg px-3">
            <SettingRow title="Hide the platform name from clients" description="The words CapitalxAI never appear in the portal, on the invitation page or in client emails. Set a product name too, otherwise clients see the workspace name." control={<Switch label="Hide the platform name from clients" checked={form.hide_platform_name} onChange={(v) => set('hide_platform_name', v)} disabled={ro} />} />
          </div>
          {saveError && <ErrorBox message={saveError} />}
          <div className="flex items-center justify-end gap-2">
            {dirty && <Button type="button" variant="secondary" onClick={() => setForm(JSON.parse(savedPrint) as Form)} disabled={busy}>Undo</Button>}
            <Button type="submit" loading={busy} disabled={ro || !dirty || blocking}><Save className="w-4 h-4" /> Save branding</Button>
          </div>
        </form>
        <div className="lg:col-span-2"><div className="lg:sticky lg:top-4"><div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Live preview{dirty ? ' · not saved yet' : ''}</div><BrandingPreview branding={preview} /></div></div>
      </div>
      {toast.node}
    </Card>
  );
}

export default function BrandingSettingsPage() {
  return (
    <SettingsFrame min="owner" deniedMessage="Only the workspace owner can change white-label settings.">
      <div className="space-y-6">
        <BrandingForm />
        <DomainsCard />
      </div>
    </SettingsFrame>
  );
}
