'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, KeyRound, Plus } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { useClients, useMembers } from '@/lib/outreach/queries';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Modal, Select, Spinner, Table, Td, Th, fmtDate, timeAgo, useToast } from '@/components/outreach/ui';
import { ApiSubTabs } from '@/components/outreach/settings/SettingsTabs';
import { ConfirmModal, CopyField, Note, SettingsFrame } from '@/components/outreach/settings/shared';
import { sk, useApiKeys } from '@/components/outreach/settings/hooks';
import type { ApiKeyRow, CreatedApiKey } from '@/components/outreach/settings/types';
import type { Role } from '@/lib/outreach/types';

const API_BASE = `${(process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '')}/functions/v1/outreach-api/v1`;
const MARKETING = (process.env.NEXT_PUBLIC_MARKETING_URL || '').replace(/\/+$/, '');
const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', manager: 'Manager', member: 'Member', client_viewer: 'Client viewer (read only)' };
const ROLE_HINT: Record<string, string> = {
  manager: 'Everything a manager can do: sequences, senders, leads, reports, webhooks.',
  member: 'Leads, enrolment, inbox and tasks. Cannot change sequences or senders.',
  client_viewer: 'Read only. Good for dashboards and reporting tools.',
};

function keyState(k: ApiKeyRow): { label: string; tone: 'green' | 'red' | 'amber' } {
  if (k.revoked_at) return { label: 'Revoked', tone: 'red' };
  if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) return { label: 'Expired', tone: 'amber' };
  return { label: 'Active', tone: 'green' };
}

export default function ApiKeysSettingsPage() {
  const { workspace, role, isOwner, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const allowed = role === 'owner' || role === 'manager';
  const keys = useApiKeys(allowed ? ws : null);
  const clients = useClients(allowed ? ws : null);
  const members = useMembers(allowed ? ws : null);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [keyRole, setKeyRole] = useState<Role>('member');
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [expires, setExpires] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copiedAck, setCopiedAck] = useState(false);
  const [toRevoke, setToRevoke] = useState<ApiKeyRow | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  // A key can never have more rights than the person creating it, and never the owner role.
  const roleOptions: Role[] = isOwner || role === 'manager' ? ['manager', 'member', 'client_viewer'] : [];
  const clientName = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);
  const memberName = useMemo(() => new Map((members.data ?? []).map((m) => [m.user_id, m.display_name || m.email || 'a member'])), [members.data]);
  const today = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const nameError = !name.trim() ? 'Give the key a name so you can recognise it later' : name.trim().length > 80 ? 'Keep the name under 80 characters' : undefined;
  const expiresError = expires && new Date(`${expires}T23:59:59`).getTime() <= Date.now() ? 'Pick a date in the future' : undefined;
  const active = (keys.data ?? []).filter((k) => !k.revoked_at);
  const visible = showRevoked ? keys.data ?? [] : active;
  const revokedCount = (keys.data ?? []).length - active.length;

  function openCreate() { setName(''); setKeyRole('member'); setClientIds([]); setExpires(''); setSubmitted(false); setFormError(null); setCreateOpen(true); }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!ws || nameError || expiresError) return;
    setBusy(true); setFormError(null);
    try {
      const r = await rpc<CreatedApiKey>('create_api_key', { p_ws: ws, p_name: name.trim(), p_role: keyRole, p_client_ids: clientIds, p_expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null });
      setCreateOpen(false); setCopiedAck(false); setCreated(r);
      qc.invalidateQueries({ queryKey: sk.apiKeys(ws) });
    } catch (er) { setFormError(parseError(er).message); }
    finally { setBusy(false); }
  }

  async function revoke() {
    if (!toRevoke || !ws) return;
    setBusy(true);
    try { await rpc('revoke_api_key', { p_id: toRevoke.id }); await qc.invalidateQueries({ queryKey: sk.apiKeys(ws) }); toast.show('Key revoked. Requests with it now fail.'); setToRevoke(null); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(false); }
  }

  const curl = `curl "${API_BASE}/leads?limit=5" \\\n  -H "Authorization: Bearer ${created?.key ?? 'ok_live_…'}"`;

  return (
    <SettingsFrame min="manager">
      <ApiSubTabs />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><KeyRound className="w-4 h-4" /> API keys</span>} actions={canWrite && <Button size="sm" onClick={openCreate}><Plus className="w-3.5 h-3.5" /> Create key</Button>}>
          <p className="text-xs text-gray-500 mb-4">A key acts as the member who created it, limited to the role and clients you pick. It runs the same rules as the app: caps, schedules, blacklists and reply-stop all apply, so the API cannot send more than the app would. If that member leaves the workspace, their keys stop working.</p>
          {keys.isLoading ? <Spinner /> : keys.isError ? <ErrorBox message={parseError(keys.error).message} /> : !keys.data?.length ? (
            <EmptyState icon={<KeyRound className="w-6 h-6" />} title="No API keys yet" description="Create a key to connect Zapier, Make, n8n, Clay or your own code." action={canWrite ? <Button onClick={openCreate}><Plus className="w-4 h-4" /> Create key</Button> : undefined} />
          ) : (
            <>
              {visible.length === 0 ? <div className="text-sm text-gray-500 py-4">No active keys.</div> : (
                <Table>
                  <thead><tr><Th>Name</Th><Th>Key</Th><Th>Role</Th><Th>Clients</Th><Th>Last used</Th><Th>Expires</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                  <tbody>
                    {visible.map((k) => {
                      const st = keyState(k);
                      return (
                        <tr key={k.id} className={k.revoked_at ? 'opacity-60' : undefined}>
                          <Td><div className="font-medium text-gray-900">{k.name}</div><div className="text-[11px] text-gray-400">by {memberName.get(k.user_id) ?? (members.isSuccess ? 'a former member' : 'a member')} · {fmtDate(k.created_at, false)}</div></Td>
                          <Td className="font-mono text-xs whitespace-nowrap">{k.prefix}…</Td>
                          <Td className="whitespace-nowrap">{ROLE_LABEL[k.role]?.replace(' (read only)', '') ?? k.role}</Td>
                          <Td className="max-w-[180px]">{k.client_ids.length === 0 ? <span className="text-gray-500">All clients</span> : <span className="text-xs">{k.client_ids.map((id) => clientName.get(id) ?? 'deleted client').join(', ')}</span>}</Td>
                          <Td className="whitespace-nowrap">{k.last_used_at ? timeAgo(k.last_used_at) : <span className="text-gray-400">never</span>}</Td>
                          <Td className="whitespace-nowrap">{k.expires_at ? fmtDate(k.expires_at, false) : <span className="text-gray-400">never</span>}</Td>
                          <Td><Badge tone={st.tone}>{st.label}</Badge>{k.revoked_at && <div className="text-[11px] text-gray-400 mt-0.5">{fmtDate(k.revoked_at, false)}</div>}</Td>
                          <Td className="text-right">{!k.revoked_at && canWrite && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setToRevoke(k)}>Revoke</Button>}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
              {revokedCount > 0 && <button type="button" onClick={() => setShowRevoked(!showRevoked)} className="mt-3 text-xs text-indigo-600 hover:underline">{showRevoked ? 'Hide revoked keys' : `Show ${revokedCount} revoked key${revokedCount === 1 ? '' : 's'}`}</button>}
            </>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2"><BookOpen className="w-4 h-4" /> Using the API</span>}>
          <div className="space-y-3 text-sm text-gray-700">
            {MARKETING ? (
              <p>The full reference, the OpenAPI file and copy-paste recipes for Zapier, Make, n8n and Clay are on the <a href={`${MARKETING}/developers`} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline font-medium">developer pages</a>.</p>
            ) : (
              <p>Send the key as a bearer token. Every request is scoped to this workspace.</p>
            )}
            <CopyField label="Base URL" value={API_BASE} />
            <div>
              <div className="text-xs font-medium text-gray-600 mb-1">Try it</div>
              <pre className="text-[11px] leading-relaxed bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto"><code>{`curl "${API_BASE}/leads?limit=5" \\\n  -H "Authorization: Bearer ok_live_…"`}</code></pre>
            </div>
            <ul className="text-xs text-gray-500 list-disc pl-4 space-y-1">
              <li>Writes accept an <code>Idempotency-Key</code> header, so a retry never creates a duplicate.</li>
              <li>An update only changes the fields you send.</li>
              <li>Enrolling is preview first, then commit, like in the app.</li>
              <li>Errors come back as <code>{'{ code, message }'}</code> with codes such as <code>E_FORBIDDEN</code>.</li>
            </ul>
          </div>
        </Card>
      </div>

      <Modal open={createOpen} onClose={() => !busy && setCreateOpen(false)} title="Create API key"
        footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</Button><Button onClick={create} loading={busy}>Create key</Button></>}>
        <form onSubmit={create} className="space-y-4" noValidate>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Zapier, reporting dashboard…" error={submitted ? nameError : undefined} autoFocus maxLength={80} />
          <div>
            <Select label="Role" value={keyRole} onChange={(e) => setKeyRole(e.target.value as Role)}>{roleOptions.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>
            <span className="block text-xs text-gray-500 mt-1">{ROLE_HINT[keyRole]} A key can never have more rights than you, and never the owner role.</span>
          </div>
          <fieldset>
            <legend className="block text-xs font-medium text-gray-600 mb-1">Client scope (optional)</legend>
            {clients.isLoading ? <div className="text-xs text-gray-400">Loading clients…</div> : !clients.data?.length ? <div className="text-xs text-gray-500">No clients in this workspace. The key sees everything its role allows.</div> : (
              <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-0.5">
                {clients.data.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 px-1 py-1 text-sm rounded cursor-pointer hover:bg-gray-50">
                    <input type="checkbox" className="rounded border-gray-300 text-indigo-600" checked={clientIds.includes(c.id)} onChange={(e) => setClientIds(e.target.checked ? [...clientIds, c.id] : clientIds.filter((x) => x !== c.id))} /> {c.name}
                  </label>
                ))}
              </div>
            )}
            <span className="block text-xs text-gray-500 mt-1">{clientIds.length ? `The key only sees ${clientIds.length} client${clientIds.length === 1 ? '' : 's'}.` : 'Nothing ticked means all clients.'}</span>
          </fieldset>
          <Input label="Expires (optional)" type="date" min={today} value={expires} onChange={(e) => setExpires(e.target.value)} error={submitted ? expiresError : undefined} hint="Leave empty for a key that works until you revoke it." />
          {formError && <ErrorBox message={formError} />}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </Modal>

      {/* Shown once. Closing needs the tick, so nobody loses the key by clicking outside. */}
      <Modal open={!!created} onClose={() => { if (copiedAck) setCreated(null); }} title="Copy your API key now" size="lg"
        footer={<Button onClick={() => setCreated(null)} disabled={!copiedAck}>Done</Button>}>
        {created && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>This is the only time the key is shown. We store a hash of it, not the key, so we cannot show it again. If you lose it, revoke it and create a new one.</span></div>
            <CopyField label="API key" value={created.key} />
            <div><div className="text-xs font-medium text-gray-600 mb-1">Test it</div><pre className="text-[11px] leading-relaxed bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto"><code>{curl}</code></pre></div>
            <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer"><input type="checkbox" className="rounded border-gray-300 text-indigo-600" checked={copiedAck} onChange={(e) => setCopiedAck(e.target.checked)} /> I have copied it</label>
          </div>
        )}
      </Modal>

      <ConfirmModal open={!!toRevoke} onClose={() => setToRevoke(null)} onConfirm={revoke} loading={busy} title="Revoke this key?" confirmLabel="Revoke key">
        <p><strong>{toRevoke?.name}</strong> (<code className="text-xs">{toRevoke?.prefix}…</code>) stops working straight away. Anything that uses it, such as a Zap or a script, will start to fail.</p>
        <p>This cannot be undone. You can always create a new key.</p>
      </ConfirmModal>
      {!canWrite && allowed && <Note className="mt-6">This workspace is read-only, so keys cannot be created or revoked right now.</Note>}
      {toast.node}
    </SettingsFrame>
  );
}
