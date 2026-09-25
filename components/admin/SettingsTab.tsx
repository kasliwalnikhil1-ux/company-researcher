'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, ErrorBox, fmtDate } from '@/components/outreach/ui';
import { useAccess } from '@/contexts/AccessContext';
import { FEATURES } from '@/lib/platform/access';
import { adminApi } from '@/lib/platform/admin';
import { AccountPicker, ConfirmModal, Section, TriState, errMsg, useAdminToast } from './shared';

export default function SettingsTab({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useAdminToast();
  const me = useAccess();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: adminApi.settings });
  const s = q.data;
  const savedMode = s?.settings.signup_mode ?? 'approval';
  const savedDefaults = s?.settings.default_features ?? {};
  // null = untouched (shows the saved value)
  const [modeEdit, setModeEdit] = useState<'approval' | 'open' | null>(null);
  const [defaultsEdit, setDefaultsEdit] = useState<Record<string, boolean> | null>(null);
  const mode = modeEdit ?? savedMode;
  const defaults = defaultsEdit ?? savedDefaults;
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; email: string | null } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const act = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); toast(label); refresh(); me.refresh(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };
  const defaultsDirty = defaultsEdit !== null && JSON.stringify(defaultsEdit) !== JSON.stringify(savedDefaults);

  return (
    <div className="space-y-4">
      {q.error && <ErrorBox message={errMsg(q.error)} />}

      <Section title="New sign-ups" description="What happens to an account the moment someone signs up.">
        <div className="space-y-2">
          <label className="flex items-start gap-3 p-3 border rounded-lg cursor-pointer has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50/40">
            <input type="radio" className="mt-1" checked={mode === 'approval'} onChange={() => setModeEdit('approval')} />
            <div><div className="text-sm font-medium text-gray-900">Approval required</div><div className="text-xs text-gray-500">The account is created but sees a “waiting for approval” screen until an admin approves it here. New sign-ups appear under Accounts → Pending.</div></div>
          </label>
          <label className="flex items-start gap-3 p-3 border rounded-lg cursor-pointer has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50/40">
            <input type="radio" className="mt-1" checked={mode === 'open'} onChange={() => setModeEdit('open')} />
            <div><div className="text-sm font-medium text-gray-900">Open</div><div className="text-xs text-gray-500">Every new account is active at once with the default features below. You can still block individual accounts.</div></div>
          </label>
        </div>
        {s && mode !== savedMode && (
          <div className="mt-3 flex gap-2">
            <Button size="sm" loading={busy === 'mode'} onClick={() => act('mode', 'Sign-up mode saved', async () => { await adminApi.setSetting('signup_mode', mode); setModeEdit(null); })}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setModeEdit(null)}>Discard</Button>
          </div>
        )}
      </Section>

      <Section title="Default features for every account" description="Applies to every account whose switch is on “Default”. Per-account overrides (Accounts → open an account → What this account can see) win over these.">
        <div className="divide-y divide-gray-100">
          {FEATURES.map((f) => (
            <div key={f.key} className="flex items-start justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900">{f.label}</div>
                <div className="text-xs text-gray-500">{f.description}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">App rule when unset: {f.defaultRule}</div>
              </div>
              <TriState value={defaults[f.key]} onChange={(v) => setDefaultsEdit(() => { const n = { ...defaults }; if (v === undefined) delete n[f.key]; else n[f.key] = v; return n; })} />
            </div>
          ))}
        </div>
        {defaultsDirty && (
          <div className="mt-3 flex gap-2">
            <Button size="sm" loading={busy === 'defaults'} onClick={() => act('defaults', 'Defaults saved', async () => { await adminApi.setSetting('default_features', defaults); setDefaultsEdit(null); })}>Save defaults</Button>
            <Button size="sm" variant="ghost" onClick={() => setDefaultsEdit(null)}>Discard</Button>
          </div>
        )}
      </Section>

      <Section title="Admins" description="Admins can open this page and change every account. At least one must remain; you cannot remove yourself.">
        <div className="max-w-md mb-4">
          <AccountPicker placeholder="Add an admin by email…" exclude={(s?.admins ?? []).map((a) => a.user_id)} onPick={(u) => act('add', `${u.email} is now an admin`, () => adminApi.setAdmin(u.id, true))} />
        </div>
        <ul className="divide-y divide-gray-100">
          {(s?.admins ?? []).map((a) => {
            const self = a.user_id === me.access?.user_id;
            return (
              <li key={a.user_id} className="flex items-center gap-3 py-2 text-sm">
                <button type="button" className="font-medium text-gray-900 hover:underline" onClick={() => onOpenUser(a.user_id)}>{a.email ?? a.user_id}</button>
                {self && <Badge tone="indigo">you</Badge>}
                <span className="text-xs text-gray-400">since {fmtDate(a.created_at, false)}{a.note ? ` · ${a.note}` : ''}</span>
                {!self && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRemoving({ id: a.user_id, email: a.email })}>Remove</Button>}
              </li>
            );
          })}
        </ul>
      </Section>

      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} title="Remove admin access?" confirmLabel="Remove"
        message={<>{removing?.email} keeps a normal account and loses this page.</>}
        onConfirm={() => act('rm', 'Admin removed', () => adminApi.setAdmin(removing!.id, false))} />
    </div>
  );
}
