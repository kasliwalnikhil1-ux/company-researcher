'use client';

// Settings → Notifications: per-person choices, saved on the user and following them to every browser.
//   Reply alerts (reply-notifications-PRD.md §6): this browser, sound, scope, the alert table, options, pause, browsers.
//   Email for mentions (private-notes-PRD.md §6.1): sent only when the mention is still unread after the chosen delay.
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { Card, PageHeader, PageLoader, Select, Toggle, useToast } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import AlertSettingsSections from '@/components/outreach/alerts/AlertSettings';
import { useNotificationPrefs, useSetNotificationPref } from '@/lib/outreach/notes';
import { useSessionUser } from '@/lib/outreach/session';
import { parseError } from '@/lib/outreach/api';

const DELAYS: Array<{ value: 10 | 30 | 60; label: string }> = [{ value: 10, label: 'after 10 minutes' }, { value: 30, label: 'after 30 minutes' }, { value: 60, label: 'after 1 hour' }];

export default function NotificationSettingsPage() {
  const { workspace } = useWorkspace();
  const { user } = useSessionUser();
  const ws = workspace?.id ?? '';
  const toast = useToast();
  const prefs = useNotificationPrefs(ws || null);
  const set = useSetNotificationPref(ws);
  const mention = prefs.data?.note_mention ?? { push: true, email: true, email_delay_min: 10 as const };
  const saveEmail = (patch: { email?: boolean; email_delay_min?: 10 | 30 | 60 }) => {
    set.mutate({ kind: 'note_mention', email: patch.email ?? mention.email, email_delay_min: patch.email_delay_min ?? mention.email_delay_min, push: mention.push },
      { onError: (e) => toast.show(parseError(e).message, 'error'), onSuccess: () => toast.show('Saved') });
  };
  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace?.name} />
      <SettingsTabs />
      {!ws || !user || prefs.isLoading ? <PageLoader /> : (
        <div className="space-y-4 max-w-3xl">
          <AlertSettingsSections ws={ws} userId={user.id} toast={toast.show} />
          <Card title="Email for mentions">
            <p className="text-sm text-gray-600 mb-3">A teammate writes @you in a private note and you have not read it yet.</p>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 flex-[1_1_14rem]"><div className="text-sm font-medium text-gray-900">Email me</div><div className="text-xs text-gray-500">Several notes on one conversation arrive as one email.</div></div>
              <div className="flex items-center gap-2 ml-auto">
                <Select value={String(mention.email_delay_min)} disabled={!mention.email || set.isPending} onChange={(e) => saveEmail({ email_delay_min: Number(e.target.value) as 10 | 30 | 60 })} aria-label="Email delay" className="text-sm">
                  {DELAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </Select>
                <Toggle checked={mention.email} disabled={set.isPending} onChange={(v) => saveEmail({ email: v })} />
              </div>
            </div>
          </Card>
        </div>
      )}
      {toast.node}
    </div>
  );
}
