'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useClients, useLists, useSenders, useTags } from '@/lib/outreach/queries';
import { callFn, parseError } from '@/lib/outreach/api';
import { Badge, Button, ErrorBox, Input, Select } from '@/components/outreach/ui';
import { Info, Search } from 'lucide-react';
import { TagMultiSelect } from './TagMultiSelect';
import { SenderPicker, importableSenders, useSearchPageBudget } from './SenderPicker';
import { formatNumber, type ToastFn } from '../helpers';

interface Estimate { api: 'classic' | 'sales_navigator'; cap: number; per_page: number; pages_per_day: number; estimated_days: number; sender: string | null }

export function SearchUrlImport({ toast, onCreated }: { toast: ToastFn; onCreated: () => void }) {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const senders = useSenders(workspace?.id);
  const clients = useClients(workspace?.id);
  const lists = useLists(workspace?.id);
  const tags = useTags(workspace?.id);
  const ready = importableSenders(senders.data);

  const [url, setUrl] = useState('');
  const [senderId, setSenderId] = useState('');
  const [maxResults, setMaxResults] = useState('');
  const [clientId, setClientId] = useState('');
  const [listId, setListId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState<'estimate' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const budget = useSearchPageBudget(senderId || null);

  useEffect(() => { setEstimate(null); }, [url, senderId, maxResults]);

  const urlOk = /^https:\/\/(www\.)?linkedin\.com\//i.test(url.trim());
  const isSalesNav = /linkedin\.com\/sales\//i.test(url);
  const body = () => ({
    workspace_id: workspace!.id, kind: 'search_url' as const, sender_id: senderId, url: url.trim(),
    max_results: maxResults ? Math.max(1, parseInt(maxResults, 10) || 0) : undefined,
    client_id: clientId || null, list_id: listId || null, tag_ids: tagIds,
  });

  const runEstimate = async () => {
    if (!workspace || !urlOk || !senderId) return;
    setBusy('estimate'); setError(null);
    try {
      const res = await callFn<{ estimate: Estimate }>('imports-create', { ...body(), dry_run: true });
      setEstimate(res.estimate);
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  };

  const create = async () => {
    if (!workspace || !estimate) return;
    setBusy('create'); setError(null);
    try {
      await callFn('imports-create', body());
      qc.invalidateQueries({ queryKey: qk.imports(workspace.id) });
      toast('Import started — leads will arrive over the coming days');
      setUrl(''); setMaxResults(''); setEstimate(null); setTagIds([]);
      onCreated();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  };

  const rows = estimate ? Math.min(estimate.cap, maxResults ? parseInt(maxResults, 10) || estimate.cap : estimate.cap) : null;

  return (
    <div className="space-y-4">
      <Input label="LinkedIn or Sales Navigator people search URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.linkedin.com/search/results/people/?keywords=…"
        error={url.trim() && !urlOk ? 'Paste a full https://www.linkedin.com/… search URL' : undefined}
        hint={url.trim() && urlOk ? `Looks like a ${isSalesNav ? 'Sales Navigator' : 'Classic'} search. Only people searches can be imported.` : 'Run the search on LinkedIn with your filters applied, then copy the address bar URL.'} />
      <SenderPicker senders={ready} allSenders={senders.data ?? []} value={senderId} onChange={setSenderId} hint="The search runs from this account, one page at a time, inside its working hours." />
      {senderId && (
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <span className="font-medium text-gray-700">Today&apos;s search pages:</span>
          {budget.isLoading ? <span>loading…</span> : budget.data ? (
            <><span className="tabular-nums">{budget.data.used + budget.data.reserved} / {budget.data.cap}</span>{!budget.data.planned && <Badge tone="gray">cap for this level</Badge>}{budget.data.cap === 0 && <Badge tone="amber">no search budget today</Badge>}</>
          ) : <span>unavailable</span>}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Input label="Max results (optional)" type="number" min={1} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} placeholder={isSalesNav ? 'up to 2,500' : 'up to 1,000'} hint="LinkedIn stops returning results at 1,000 (Classic) or 2,500 (Sales Navigator)." />
        <Select label="Client (optional)" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">No client</option>
          {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select label="Add to list (optional)" value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">No list</option>
          {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      </div>
      <TagMultiSelect tags={tags.data ?? []} value={tagIds} onChange={setTagIds} />

      {estimate && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900"><Search className="w-4 h-4 text-indigo-600" /> {estimate.api === 'sales_navigator' ? 'Sales Navigator' : 'Classic LinkedIn'} people search <Badge tone="indigo">cap {formatNumber(estimate.cap)}</Badge></div>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><dt className="text-xs text-gray-500">Estimated rows</dt><dd className="font-semibold tabular-nums">{formatNumber(rows)}</dd></div>
            <div><dt className="text-xs text-gray-500">Results per page</dt><dd className="font-semibold tabular-nums">{estimate.per_page}</dd></div>
            <div><dt className="text-xs text-gray-500">Pages per day</dt><dd className="font-semibold tabular-nums">{estimate.pages_per_day}</dd></div>
            <div><dt className="text-xs text-gray-500">Estimated duration</dt><dd className="font-semibold tabular-nums">{estimate.estimated_days} day{estimate.estimated_days === 1 ? '' : 's'}</dd></div>
          </dl>
          <p className="text-xs text-gray-600 flex items-start gap-1.5"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> The job fetches a page every 20–90 minutes within {estimate.sender ?? 'the sender'}&apos;s working hours and daily search budget, so a large search finishes over several days. You can pause or cancel it at any time below.</p>
        </div>
      )}
      {error && <ErrorBox message={error} />}
      <div className="flex flex-wrap items-center gap-2">
        {!estimate ? (
          <Button onClick={runEstimate} loading={busy === 'estimate'} disabled={!urlOk || !senderId}>Check search</Button>
        ) : (
          <>
            <Button onClick={create} loading={busy === 'create'}>Start import</Button>
            <Button variant="secondary" onClick={() => setEstimate(null)} disabled={busy === 'create'}>Edit</Button>
          </>
        )}
      </div>
    </div>
  );
}
