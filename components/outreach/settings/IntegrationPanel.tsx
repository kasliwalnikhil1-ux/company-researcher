'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, Save, Unplug } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { qk, useClients, useLists } from '@/lib/outreach/queries';
import { Button, Card, ErrorBox, Select, Spinner, timeAgo, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { ConfirmModal, Note, SettingRow, Switch } from './shared';
import MappingEditor, { fromPairs, pairProblems, toPairs, type Pair } from './MappingEditor';
import SyncLogTable from './SyncLogTable';
import { sk } from './hooks';
import { CRM_PROVIDERS, DEFAULT_FIELD_MAPPING, DEFAULT_STAGE_MAPPING, LEAD_FIELDS, SYNC_RULES, crmLabel } from './crm';
import { STAGE_KINDS, type CrmSegment, type Integration, type IntegrationSettings, type SyncRule } from './types';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Everything for one connected CRM: who gets synced, what is pushed, mappings, list import, the sync log, disconnect. */
export default function IntegrationPanel({ integration }: { integration: Integration }) {
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id ?? '';
  const qc = useQueryClient();
  const toast = useToast();
  const meta = CRM_PROVIDERS.find((p) => p.value === integration.provider)!;
  const name = crmLabel(integration.provider);
  const live = integration.status === 'active' || integration.status === 'error';

  // ---- settings + mappings: one form, one save ----
  // Keyed on the stored JSON, not on object identity, so a background refetch never wipes unsaved edits.
  const print = JSON.stringify([integration.settings ?? {}, integration.field_mapping ?? {}, integration.stage_mapping ?? {}]);
  const fieldDefaults = DEFAULT_FIELD_MAPPING[integration.provider];
  const stageDefaults = DEFAULT_STAGE_MAPPING[integration.provider];
  const { savedSettings, savedFields, savedStages } = useMemo(() => {
    const [st, fm, sm] = JSON.parse(print) as [IntegrationSettings, Record<string, string>, Record<string, string>];
    const savedSettings: Required<IntegrationSettings> = {
      sync_rule: (st.sync_rule ?? 'replied') as SyncRule, log_messages: st.log_messages ?? true,
      create_deal_on_interested: st.create_deal_on_interested ?? false, suppress_customers: st.suppress_customers ?? false,
    };
    return { savedSettings, savedFields: Object.keys(fm).length ? fm : fieldDefaults, savedStages: Object.keys(sm).length ? sm : stageDefaults };
  }, [print, fieldDefaults, stageDefaults]);

  const [settings, setSettings] = useState(savedSettings);
  const [fields, setFields] = useState<Pair[]>(toPairs(savedFields));
  const [stages, setStages] = useState<Pair[]>(toPairs(savedStages));
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  useEffect(() => { setSettings(savedSettings); setFields(toPairs(savedFields)); setStages(toPairs(savedStages)); }, [savedSettings, savedFields, savedStages]);

  const fieldProblem = pairProblems(fields);
  const stageProblem = pairProblems(stages) ?? (stages.some((s) => s.key.trim() && !STAGE_KINDS.some((k) => k.value === s.key.trim())) ? 'Pick a stage kind from the list on the left.' : null);
  const dirty = !same(settings, savedSettings) || !same(fromPairs(fields), savedFields) || !same(fromPairs(stages), savedStages);

  async function save() {
    if (fieldProblem || stageProblem) return;
    setBusy('save'); setSaveError(null);
    try {
      const f = fromPairs(fields); const s = fromPairs(stages);
      // `{}` tells the sync worker to use its defaults, so an untouched mapping is stored as empty
      await rpc('integration_save', { p_id: integration.id, p_settings: settings, p_field_mapping: same(f, fieldDefaults) ? {} : f, p_stage_mapping: same(s, stageDefaults) ? {} : s });
      await qc.invalidateQueries({ queryKey: sk.integrations(ws) });
      toast.show(`Saved. The next sync with ${name} uses these settings.`);
    } catch (e) { setSaveError(parseError(e).message); }
    finally { setBusy(null); }
  }

  async function syncNow() {
    setBusy('sync');
    try {
      await callFn('crm-oauth', { action: 'sync_now', integration_id: integration.id });
      toast.show('Sync started. New entries appear in the log below within a minute.');
      setTimeout(() => { qc.invalidateQueries({ queryKey: sk.integrations(ws) }); qc.invalidateQueries({ queryKey: ['outreach', 'integration', integration.id] }); }, 4000);
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function disconnect() {
    setBusy('disconnect');
    try {
      await rpc('integration_disconnect', { p_id: integration.id });
      await Promise.all([qc.invalidateQueries({ queryKey: sk.integrations(ws) }), qc.invalidateQueries({ queryKey: sk.blacklist(ws) }), qc.invalidateQueries({ queryKey: qk.suppressions(ws) })]);
      toast.show(`${name} disconnected.`); setConfirmDisconnect(false);
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  // ---- import a CRM list ----
  const [segmentsOpen, setSegmentsOpen] = useState(false);
  const [segmentId, setSegmentId] = useState('');
  const [listId, setListId] = useState('');
  const [clientId, setClientId] = useState('');
  const lists = useLists(segmentsOpen ? ws : null);
  const clients = useClients(segmentsOpen ? ws : null);
  const segments = useQuery({
    queryKey: ['outreach', 'integration', integration.id, 'segments'], enabled: segmentsOpen && live, staleTime: 5 * 60_000, retry: 0,
    queryFn: async () => { const r = await callFn<{ segments?: CrmSegment[] } | CrmSegment[]>('crm-oauth', { action: 'segments', integration_id: integration.id }); return Array.isArray(r) ? r : r?.segments ?? []; },
  });

  async function importSegment() {
    const seg = (segments.data ?? []).find((s) => s.id === segmentId);
    if (!seg) return;
    setBusy('import');
    try {
      await callFn('crm-oauth', { action: 'import_segment', integration_id: integration.id, segment_id: seg.id, segment_name: seg.name, list_id: listId || null, client_id: clientId || null });
      toast.show(`Importing "${seg.name}". People we already have are updated, not duplicated. The sync log shows the result.`);
      setSegmentId('');
      setTimeout(() => qc.invalidateQueries({ queryKey: ['outreach', 'integration', integration.id] }), 4000);
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  const editable = canWrite && live;

  return (
    <div className="space-y-6">
      <Card title={`${name}: who gets synced`} actions={live && <Button size="sm" variant="secondary" onClick={syncNow} loading={busy === 'sync'} disabled={!canWrite}><RefreshCw className="w-3.5 h-3.5" /> Sync now</Button>}>
        <fieldset disabled={!editable} className="space-y-2">
          <legend className="sr-only">Who gets synced</legend>
          {SYNC_RULES.map((r) => (
            <label key={r.value} className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer', settings.sync_rule === r.value ? 'border-indigo-500 bg-indigo-50/50' : 'border-gray-200 hover:bg-gray-50', !editable && 'cursor-not-allowed opacity-70')}>
              <input type="radio" name={`sync-rule-${integration.id}`} className="mt-1 text-indigo-600 border-gray-300" checked={settings.sync_rule === r.value} onChange={() => setSettings({ ...settings, sync_rule: r.value })} />
              <span><span className="block text-sm font-medium text-gray-900">{r.label}{r.value === 'replied' && <span className="ml-2 text-xs font-normal text-indigo-700">default</span>}</span><span className="block text-xs text-gray-500 mt-0.5">{r.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-gray-500 mt-2">Once a lead is linked to a {name} record it stays in step, whatever the rule says later.</p>

        <div className="divide-y divide-gray-100 mt-4 border-t border-gray-100">
          <SettingRow title="Log messages on the timeline" description={`Sent messages, emails and replies show up as notes on the ${name} contact.`} control={<Switch label="Log messages on the timeline" checked={settings.log_messages} onChange={(v) => setSettings({ ...settings, log_messages: v })} disabled={!editable} />} />
          <SettingRow title="Create a deal when a reply is interested" description="One deal per lead, named after the lead and the sequence. The deal value comes from your Won stage when it has one." control={<Switch label="Create a deal when a reply is interested" checked={settings.create_deal_on_interested} onChange={(v) => setSettings({ ...settings, create_deal_on_interested: v })} disabled={!editable} />} />
          <SettingRow title="Keep customers and open deals on the blacklist" description={<>On every sync we read your {name} customers and the companies with an open deal, and block them for the whole workspace so no sequence contacts them. These entries show the source &ldquo;CRM: {name}&rdquo; on the Blacklists page and are removed when you disconnect.</>} control={<Switch label="Keep customers and open deals on the blacklist" checked={settings.suppress_customers} onChange={(v) => setSettings({ ...settings, suppress_customers: v })} disabled={!editable} />} />
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card title="Field mapping">
          <p className="text-xs text-gray-500 mb-3">Which of our lead fields fill which {name} property. Use <code>custom.your_field</code> for a custom lead field. An empty value on our side never blanks a field in {name}.</p>
          <MappingEditor pairs={fields} onChange={setFields} options={LEAD_FIELDS} defaults={fieldDefaults} leftLabel="Our field" rightLabel={`${name} property`} rightPlaceholder="internal property name" disabled={!editable} allowCustom />
          {fieldProblem && <div className="text-xs text-red-600 mt-2">{fieldProblem}</div>}
        </Card>
        <Card title="Stage mapping">
          <p className="text-xs text-gray-500 mb-3">When a lead reaches one of our stage kinds, set this {meta.stageNoun} in {name}. A kind that is not listed is not pushed. {Object.keys(stageDefaults).length === 0 && `Values differ per ${name} account, so there are no defaults: copy them from your ${name} settings.`}</p>
          <MappingEditor pairs={stages} onChange={setStages} options={STAGE_KINDS.map((k) => ({ value: k.value, label: k.label }))} defaults={stageDefaults} leftLabel="Our stage kind" rightLabel={`${name} ${meta.stageNoun}`} rightPlaceholder={meta.stageNoun} disabled={!editable} />
          {stageProblem && <div className="text-xs text-red-600 mt-2">{stageProblem}</div>}
        </Card>
      </div>

      {(dirty || saveError) && editable && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 shadow-sm">
          <span className="text-sm text-amber-900">{saveError ?? 'You have unsaved changes.'}</span>
          <div className="flex gap-2"><Button variant="secondary" onClick={() => { setSettings(savedSettings); setFields(toPairs(savedFields)); setStages(toPairs(savedStages)); setSaveError(null); }} disabled={busy === 'save'}>Undo</Button><Button onClick={save} loading={busy === 'save'} disabled={!!fieldProblem || !!stageProblem}><Save className="w-4 h-4" /> Save</Button></div>
        </div>
      )}

      <Card title={`Import a ${name} ${meta.segmentNoun}`}>
        {!live ? <Note>Connect {name} again to import from it.</Note> : !segmentsOpen ? (
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-gray-600">Bring a {meta.segmentNoun} of {name} contacts in as leads. People we already have are updated, not duplicated, and blacklists still apply.</p><Button variant="secondary" onClick={() => setSegmentsOpen(true)} disabled={!canWrite}><Download className="w-4 h-4" /> Choose a {meta.segmentNoun}</Button></div>
        ) : segments.isLoading ? <Spinner className="py-6" /> : segments.isError ? <ErrorBox message={parseError(segments.error).message} /> : !segments.data?.length ? <div className="text-sm text-gray-500">No {meta.segmentNoun}s found in {name}. Create one there, then come back.</div> : (
          <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr_auto] gap-3 md:items-end">
            <Select label={`${name} ${meta.segmentNoun}`} value={segmentId} onChange={(e) => setSegmentId(e.target.value)}><option value="">Choose…</option>{segments.data.map((s) => <option key={s.id} value={s.id}>{s.name}{s.count != null ? ` (${Number(s.count).toLocaleString()})` : ''}</option>)}</Select>
            <Select label="Add to list (optional)" value={listId} onChange={(e) => setListId(e.target.value)}><option value="">No list</option>{(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
            <Select label="Client (optional)" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">No client</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            <Button onClick={importSegment} loading={busy === 'import'} disabled={!segmentId || !canWrite}>Import</Button>
          </div>
        )}
      </Card>

      <Card><SyncLogTable integrationId={integration.id} provider={integration.provider} /></Card>

      <Card title="Disconnect">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gray-600 max-w-2xl">Stops the sync and deletes the stored {name} access. Last sync: {integration.last_sync_at ? timeAgo(integration.last_sync_at) : 'never'}.</p>
          <Button variant="danger" onClick={() => setConfirmDisconnect(true)} disabled={!canWrite || integration.status === 'disconnected'}><Unplug className="w-4 h-4" /> Disconnect {name}</Button>
        </div>
      </Card>

      <ConfirmModal open={confirmDisconnect} onClose={() => setConfirmDisconnect(false)} onConfirm={disconnect} loading={busy === 'disconnect'} title={`Disconnect ${name}?`} confirmLabel="Disconnect">
        <p><strong>Removed:</strong> the stored {name} access tokens, and the blacklist entries that came from {name} (&ldquo;customers and open deals&rdquo;).</p>
        <p><strong>Kept:</strong> every lead, timeline and conversation here, everything already written to {name}, your settings and mappings, and the sync log.</p>
        <p>You can connect again at any time. Leads that were linked before pick up where they left off.</p>
      </ConfirmModal>
      {toast.node}
    </div>
  );
}
