'use client';

// Settings → Email & booking → Email log (custom-sending-domain-PRD.md §8.2).
import { SettingsFrame } from '@/components/outreach/settings/shared';
import { EmailSubTabs } from '@/components/outreach/settings/SettingsTabs';
import EmailLogCard from '@/components/outreach/settings/EmailLogCard';

export default function EmailLogPage() {
  return (
    <SettingsFrame min="manager">
      <EmailSubTabs />
      <div className="space-y-6 max-w-6xl">
        <EmailLogCard />
      </div>
    </SettingsFrame>
  );
}
