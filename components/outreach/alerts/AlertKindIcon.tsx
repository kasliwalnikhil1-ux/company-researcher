'use client';

// One icon per notification kind: bell rows, toasts and the Settings alert table use the same set.
import { Bot, Globe, Lock, MessageSquare, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

const ICONS: Record<string, { Icon: typeof Lock; color: string; label: string }> = {
  reply_new: { Icon: MessageSquare, color: 'text-indigo-600', label: 'Reply' },
  webchat_message: { Icon: Globe, color: 'text-orange-600', label: 'Website chat' },
  note_mention: { Icon: Lock, color: 'text-amber-600', label: 'Mention in a private note' },
  ai_handoff: { Icon: Bot, color: 'text-violet-600', label: 'AI handoff' },
  assigned: { Icon: UserCheck, color: 'text-sky-600', label: 'Assigned to you' },
};

export default function AlertKindIcon({ kind, muted, className }: { kind: string; muted?: boolean; className?: string }) {
  const k = ICONS[kind] ?? ICONS.note_mention;
  return <k.Icon aria-label={k.label} className={cn('w-4 h-4 flex-shrink-0', muted ? 'text-gray-300' : k.color, className)} />;
}
