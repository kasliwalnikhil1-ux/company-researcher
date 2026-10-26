'use client';

// Channel marks next to a sequence name (PRD §6.1): the same brand marks the senders list uses, email as an envelope.
import React from 'react';
import { Mail } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { STATS_CHANNEL_LABEL, type ChannelUse, type StatsChannel } from '@/lib/outreach/sequenceStats';

export function ChannelGlyph({ channel, className }: { channel: StatsChannel; className?: string }) {
  if (channel === 'email') return <Mail className={cn('w-4 h-4 shrink-0 text-gray-500', className)} aria-label="Email" role="img" />;
  return <ProviderLogo provider={channel === 'linkedin' ? 'LINKEDIN' : channel === 'instagram' ? 'INSTAGRAM' : 'WHATSAPP'} className={className} />;
}

export function ChannelGlyphs({ channels, size = 'w-3.5 h-3.5' }: { channels: ChannelUse[]; size?: string }) {
  if (!channels?.length) return null;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {channels.map((c) => (
        <span key={c.channel} title={`${STATS_CHANNEL_LABEL[c.channel]}${c.from_earlier_version ? ' (from an earlier version)' : ''}`} className={cn('inline-flex', c.from_earlier_version && 'opacity-50')}>
          <ChannelGlyph channel={c.channel} className={size} />
        </span>
      ))}
    </span>
  );
}
