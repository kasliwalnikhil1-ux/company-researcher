'use client';

// Settings → Email & booking → Sending domain (custom-sending-domain-PRD.md §8.1). The other sections are sibling routes.
import { SettingsFrame } from '@/components/outreach/settings/shared';
import { EmailSubTabs } from '@/components/outreach/settings/SettingsTabs';
import EmailSendingPanel from '@/components/outreach/settings/EmailSendingPanel';

export default function EmailSendingPage() {
  return (
    <SettingsFrame min="manager">
      <EmailSubTabs />
      <div className="space-y-6 max-w-4xl">
        <EmailSendingPanel />
      </div>
    </SettingsFrame>
  );
}
