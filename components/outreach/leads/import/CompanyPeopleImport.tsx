'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, ErrorBox, Input, Textarea } from '@/components/outreach/ui';
import { SenderPicker, importableSenders } from './SenderPicker';
import { EMPTY_COMMON, ImportOptions, importStartedMessage, useImportCreator, type ImportCommon } from './ImportOptions';
import { formatNumber, type ToastFn } from '../helpers';

const MAX_COMPANIES = 100;
const MAX_TITLES = 10;
const COMPANY_URL = /linkedin\.com\/(company|school|showcase)\//i;

/** One line → what outreach-imports-create expects: a LinkedIn company link, a numeric company id, or a name. */
function toCompany(line: string): { name?: string; linkedin_url?: string; company_id?: string } {
  if (/^https?:\/\//i.test(line)) return { linkedin_url: line };
  if (/^\d{3,}$/.test(line)) return { company_id: line };
  return { name: line };
}
const MAX_PER_COMPANY = 25;

export function CompanyPeopleImport({ toast, onCreated }: { toast: ToastFn; onCreated: () => void }) {
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  const ready = importableSenders(senders.data);
  const create = useImportCreator();
  const [companiesText, setCompaniesText] = useState('');
  const [titles, setTitles] = useState('');
  const [perCompany, setPerCompany] = useState('10');
  const [senderId, setSenderId] = useState('');
  const [common, setCommon] = useState<ImportCommon>(EMPTY_COMMON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const companies = useMemo(() => Array.from(new Set(companiesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))), [companiesText]);
  const titleKeywords = useMemo(() => Array.from(new Set(titles.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))), [titles]);
  const cap = Math.min(MAX_PER_COMPANY, Math.max(1, parseInt(perCompany, 10) || 0));
  const capInvalid = !/^\d+$/.test(perCompany.trim()) || parseInt(perCompany, 10) < 1 || parseInt(perCompany, 10) > MAX_PER_COMPANY;
  const tooMany = companies.length > MAX_COMPANIES;
  const badUrl = companies.find((c) => /^https?:\/\//i.test(c) && !COMPANY_URL.test(c));
  const canSubmit = !!senderId && companies.length > 0 && !tooMany && !capInvalid && titleKeywords.length > 0 && titleKeywords.length <= MAX_TITLES && !badUrl;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      const r = await create({ kind: 'company_people', sender_id: senderId, fields: { companies: companies.map(toCompany), title_keywords: titleKeywords, per_company: cap }, name: `People in ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}` }, common);
      const m = importStartedMessage(`Import started for ${formatNumber(companies.length)} compan${companies.length === 1 ? 'y' : 'ies'}. This is the slowest source, so expect days.`, r);
      toast(m.message, m.type);
      setCompaniesText(''); setCommon((c) => ({ ...c, cadence: '' }));
      onCreated();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-amber-900 flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span><span className="font-medium">Slowest source.</span> Each company needs one lookup plus up to three search pages of 10 people, all from the sender&apos;s small daily search allowance, which every other import shares. Plan for about one working day per 10 to 30 companies. Company links or ids skip the lookup.</span>
      </p>
      <Textarea label="Companies, one per line" value={companiesText} onChange={(e) => setCompaniesText(e.target.value)} className="min-h-[140px]" placeholder={'Acme Inc\nhttps://www.linkedin.com/company/globex/'}
        hint={`Company names or LinkedIn company links. ${formatNumber(companies.length)} of ${MAX_COMPANIES} used. A link is more reliable than a name.`} />
      {tooMany && <p className="text-xs text-red-600">Use at most {MAX_COMPANIES} companies per import. Split the list.</p>}
      {badUrl && <p className="text-xs text-red-600">“{badUrl}” is not a LinkedIn company link.</p>}
      <div className="grid grid-cols-1 md:grid-cols-[1fr,200px] gap-3">
        <Input label="Title keywords" value={titles} onChange={(e) => setTitles(e.target.value)} placeholder="head of sales, vp sales, revenue" error={titleKeywords.length > MAX_TITLES ? `Use at most ${MAX_TITLES} keywords.` : undefined} hint="At least one, separated by commas. A person matches when their title contains any of them." />
        <Input label="People per company" type="number" min={1} max={MAX_PER_COMPANY} value={perCompany} onChange={(e) => setPerCompany(e.target.value)} error={capInvalid ? `Between 1 and ${MAX_PER_COMPANY}.` : undefined} hint={capInvalid ? undefined : `At most ${MAX_PER_COMPANY}.`} />
      </div>
      {companies.length > 0 && !capInvalid && <p className="text-xs text-gray-500">Up to {formatNumber(companies.length * cap)} leads.</p>}
      <SenderPicker senders={ready} allSenders={senders.data ?? []} value={senderId} onChange={setSenderId} hint="Searches run from this account, inside its working hours. A Sales Navigator seat gives better title matching." />
      <ImportOptions kind="company_people" value={common} onChange={setCommon} />
      {error && <ErrorBox message={error} />}
      <Button onClick={submit} loading={busy} disabled={!canSubmit}>Start import</Button>
    </div>
  );
}
