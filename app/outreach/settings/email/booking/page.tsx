'use client';

// Settings → Email & booking → Meeting booking (Calendly / Cal.com webhook).
import { SettingsFrame } from '@/components/outreach/settings/shared';
import { EmailSubTabs } from '@/components/outreach/settings/SettingsTabs';
import { BookingCard } from '@/components/outreach/settings/EmailBookingCards';

export default function BookingPage() {
  return (
    <SettingsFrame min="manager">
      <EmailSubTabs />
      <div className="space-y-6 max-w-4xl">
        <BookingCard />
      </div>
    </SettingsFrame>
  );
}
