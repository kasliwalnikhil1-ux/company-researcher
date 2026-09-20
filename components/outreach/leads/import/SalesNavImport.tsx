'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, RefreshCw } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import { callFn, parseError } from '@/lib/outreach/api';
import { ik, type SnOption, type SnOptions } from '@/lib/outreach/intel';
import { Button, ErrorBox, Input, Select } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { SenderPicker, importableSenders } from './SenderPicker';
import { EMPTY_COMMON, ImportOptions, importStartedMessage, useImportCreator, type ImportCommon } from './ImportOptions';
import type { ToastFn } from '../helpers';

type Mode = 'sn_saved_search' | 'sn_lead_list';
const SN_URL = /^https:\/\/(www\.)?linkedin\.com\/sales\//i;

/** Accepts a few shapes so a small naming difference in the function does not empty the picker. */
function normalize(raw: unknown): SnOptions {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown): SnOption[] => (Array.isArray(v) ? v : []).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const id = o.id ?? o.saved_search_id ?? o.lead_list_id;
    const count = o.count ?? o.total ?? o.size;
    return { id: id == null ? '' : String(id), name: String(o.name ?? o.title ?? o.label ?? id ?? 'Untitled'), count: typeof count === 'number' ? count : null };
  }).filter((o) => o.id);
  return { saved_searches: list(r.saved_searches ?? r.searches), lead_lists: list(r.lead_lists ?? r.lists) };
}

export function SalesNavImport({ toast, onCreated }: { toast: ToastFn; onCreated: () => void }) {
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  const ready = importableSenders(senders.data);
  const create = useImportCreator();
  const [mode, setMode] = useState<Mode>('sn_saved_search');
  const [senderId, setSenderId] = useState('');
  const [pick, setPick] = useState('');
  const [url, setUrl] = useState('');
  const [common, setCommon] = useState<ImportCommon>(EMPTY_COMMON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sender = ready.find((s) => s.id === senderId);

  // GET outreach-imports-create?action=sn_options: two budgeted lookups, cached for 6 hours per sender; refresh=1 asks LinkedIn again.
  const [forceRefresh, setForceRefresh] = useState(false);
  const optionsQ = useQuery({
    queryKey: ik.snOptions(senderId), enabled: !!senderId && !!workspace && !!sender?.has_sales_nav, staleTime: 30 * 60_000, retry: false,
    queryFn: async () => {
      const qs = `action=sn_options&sender_id=${encodeURIComponent(senderId)}${forceRefresh ? '&refresh=1' : ''}`;
      setForceRefresh(false);
      return normalize(await callFn(`imports-create?${qs}`, {}, { method: 'GET' }));
    },
  });
  const reload = () => { setForceRefresh(true); setTimeout(() => optionsQ.refetch(), 0); };
  const options = useMemo(() => (mode === 'sn_saved_search' ? optionsQ.data?.saved_searches : optionsQ.data?.lead_lists) ?? [], [mode, optionsQ.data]);
  useEffect(() => { setPick(''); }, [mode, senderId]);

  const urlOk = SN_URL.test(url.trim());
  const chosen = options.find((o) => o.id === pick);
  const canSubmit = !!senderId && !!sender?.has_sales_nav && (!!pick || urlOk);
  const noun = mode === 'sn_saved_search' ? 'saved search' : 'lead list';

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      const params: Record<string, unknown> = pick
        ? { [mode === 'sn_saved_search' ? 'saved_search_id' : 'lead_list_id']: pick, name: chosen?.name ?? null }
        : { url: url.trim() };
      const r = await create({ kind: mode, sender_id: senderId, fields: params, name: `Sales Navigator ${noun}${chosen ? `: ${chosen.name}` : ''}` }, common);
      const m = importStartedMessage('Import started. Leads will arrive over the coming days.', r);
      toast(m.message, m.type);
      setPick(''); setUrl(''); setCommon((c) => ({ ...c, cadence: '' }));
      onCreated();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-600 flex items-start gap-1.5 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span><span className="font-medium text-gray-800">Cost and speed:</span> same as a search URL. Pages of up to 50 results are read with the sender&apos;s daily search allowance, inside working hours, so a list of 2,500 takes several days. The sender needs a Sales Navigator seat.</span>
      </p>
      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="tablist" aria-label="Sales Navigator source">
        {([['sn_saved_search', 'Saved search'], ['sn_lead_list', 'Lead list']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)} className={cn('px-3 py-1.5 text-sm rounded-md', mode === id ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50')}>{label}</button>
        ))}
      </div>
      <SenderPicker senders={ready} allSenders={senders.data ?? []} value={senderId} onChange={setSenderId} hint="Saved searches and lead lists belong to one LinkedIn account. Pick the account that owns them." />
      {sender && !sender.has_sales_nav && <p className="text-xs text-amber-700">{sender.display_name ?? 'This sender'} has no Sales Navigator seat, so saved searches and lead lists cannot be read. Pick a sender that has one, or use a normal search URL.</p>}

      {senderId && sender?.has_sales_nav && (
        <div className="space-y-2">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Select label={`Choose a ${noun}`} value={pick} onChange={(e) => { setPick(e.target.value); if (e.target.value) setUrl(''); }} disabled={optionsQ.isLoading || options.length === 0}>
                <option value="">{optionsQ.isLoading ? 'Loading from Sales Navigator…' : options.length ? `Choose a ${noun}…` : `No ${noun}s found`}</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.name}{o.count != null ? ` (${o.count.toLocaleString()})` : ''}</option>)}
              </Select>
            </div>
            <Button variant="secondary" onClick={reload} loading={optionsQ.isFetching} title="Ask LinkedIn again. This uses two searches from today's allowance." aria-label="Reload the list"><RefreshCw className="w-4 h-4" /></Button>
          </div>
          {optionsQ.error && <p className="text-xs text-amber-700">The list could not be loaded: {parseError(optionsQ.error).message}. You can paste the link instead.</p>}
          <Input label={`Or paste the Sales Navigator ${noun} link`} value={url} onChange={(e) => { setUrl(e.target.value); if (e.target.value) setPick(''); }} placeholder="https://www.linkedin.com/sales/…"
            error={url.trim() && !urlOk ? 'Paste a full https://www.linkedin.com/sales/… link.' : undefined} />
        </div>
      )}

      <ImportOptions kind={mode} value={common} onChange={setCommon} />
      {error && <ErrorBox message={error} />}
      <Button onClick={submit} loading={busy} disabled={!canSubmit}>Start import</Button>
    </div>
  );
}
