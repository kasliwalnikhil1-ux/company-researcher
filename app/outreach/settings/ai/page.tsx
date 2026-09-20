'use client';

import { SettingsFrame } from '@/components/outreach/settings/shared';
import LlmKeyCard from '@/components/outreach/settings/LlmKeyCard';
import AiVariablesCard from '@/components/outreach/settings/AiVariablesCard';
import FinderKeysCard from '@/components/outreach/settings/FinderKeysCard';

export default function AiSettingsPage() {
  return (
    <SettingsFrame min="manager">
      <div className="space-y-6 max-w-4xl">
        <LlmKeyCard />
        <AiVariablesCard />
        <FinderKeysCard />
      </div>
    </SettingsFrame>
  );
}
