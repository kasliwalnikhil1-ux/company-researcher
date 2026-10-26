'use client';

// Settings → Email & booking → Tracking domain: the workspace default for link tracking in outreach emails.
import { SettingsFrame } from '@/components/outreach/settings/shared';
import { EmailSubTabs } from '@/components/outreach/settings/SettingsTabs';
import Link from '@/lib/outreach/nav';
import TrackingDomainCard from '@/components/outreach/settings/TrackingDomainCard';

export default function TrackingDomainPage() {
  return (
    <SettingsFrame min="manager">
      <EmailSubTabs />
      <div className="space-y-6 max-w-4xl">
        <TrackingDomainCard />
        <p className="text-xs text-gray-400">Mailbox signatures, BCC to CRM, mailbox pools and the separate email schedule are set per mailbox on the <Link href="/outreach/senders" className="text-indigo-600 hover:underline">Senders</Link> page. Tracking on manual replies is a <Link href="/outreach/settings/workspace" className="text-indigo-600 hover:underline">workspace setting</Link>.</p>
      </div>
    </SettingsFrame>
  );
}
