'use client';

// Settings → Notifications (private-notes-PRD.md §6.1): per-user preferences for mentions. In-app is always on; email
// goes out only when the mention is still unread after the chosen delay. Browser push is not available on this platform.
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { Card, PageHeader, PageLoader, Select, Toggle, useToast } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { useNotificationPrefs, useSetNotificationPref, type NotificationKind } from '@/lib/outreach/notes';
import { parseError } from '@/lib/outreach/api';

const KINDS: Array<{ kind: NotificationKind; label: string; hint: string }> = [
  { kind: 'note_mention', label: 'Mentions in private notes', hint: 'A teammate writes @you in an internal note on a conversation.' },
];
const DELAYS: Array<{ value: 10 | 30 | 60; label: string }> = [{ value: 10, label: 'after 10 minutes' }, { value: 30, label: 'after 30 minutes' }, { value: 60, label: 'after 1 hour' }];

export default function NotificationSettingsPage() {
  const { workspace } = useWorkspace();
  const ws = workspace?.id ?? '';
  const toast = useToast();
  const prefs = useNotificationPrefs(ws || null);
  const set = useSetNotificationPref(ws);
  const save = (kind: NotificationKind, patch: { email?: boolean; email_delay_min?: 10 | 30 | 60 }) => {
    const cur = prefs.data?.[kind] ?? { push: true, email: true, email_delay_min: 10 as const };
    set.mutate({ kind, email: patch.email ?? cur.email, email_delay_min: patch.email_delay_min ?? cur.email_delay_min, push: cur.push }, { onError: (e) => toast.show(parseError(e).message, 'error'), onSuccess: () => toast.show('Saved') });
  };
  return (
    <div>
      <PageHeader title="Notifications" subtitle="How you hear about mentions. These settings are yours; every teammate has their own." />
      <SettingsTabs />
      {prefs.isLoading ? <PageLoader /> : (
        <div className="space-y-4 max-w-2xl">
          {KINDS.map((k) => {
            const p = prefs.data?.[k.kind] ?? { push: true, email: true, email_delay_min: 10 as const };
            return (
              <Card key={k.kind} title={k.label}>
                <p className="text-sm text-gray-600 mb-4">{k.hint}</p>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div><div className="text-sm font-medium text-gray-900">In-app</div><div className="text-xs text-gray-500">Bell, toast and the Mentions tab of the inbox. Always on.</div></div>
                    <Toggle checked disabled onChange={() => { /* always on */ }} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-[1_1_14rem]"><div className="text-sm font-medium text-gray-900">Email</div><div className="text-xs text-gray-500">Only when the mention is still unread after the delay. Several notes on one conversation arrive as one email.</div></div>
                    <div className="flex items-center gap-2 ml-auto">
                      <Select value={String(p.email_delay_min)} disabled={!p.email || set.isPending} onChange={(e) => save(k.kind, { email_delay_min: Number(e.target.value) as 10 | 30 | 60 })} aria-label="Email delay" className="text-sm">
                        {DELAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </Select>
                      <Toggle checked={p.email} disabled={set.isPending} onChange={(v) => save(k.kind, { email: v })} />
                    </div>
                  </div>
                  <p className="text-xs text-gray-400">Browser push notifications are not offered on this platform yet.</p>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {toast.node}
    </div>
  );
}
