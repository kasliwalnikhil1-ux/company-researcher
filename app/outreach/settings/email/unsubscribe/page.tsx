'use client';

// Settings → Email & booking → Unsubscribe link.
import { SettingsFrame } from '@/components/outreach/settings/shared';
import { EmailSubTabs } from '@/components/outreach/settings/SettingsTabs';
import { UnsubscribeCard } from '@/components/outreach/settings/EmailBookingCards';

export default function UnsubscribePage() {
  return (
    <SettingsFrame min="manager">
      <EmailSubTabs />
      <div className="space-y-6 max-w-4xl">
        <UnsubscribeCard />
      </div>
    </SettingsFrame>
  );
}
