'use client';

// Agent presence for web chat (web-chat-PRD.md §5.7): while any outreach page is open, this pings every minute so the
// widget can show "online" and auto-assignment can pick the agent. Members only (client viewers never take chats).
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useWebchatPresence } from '@/lib/outreach/webchat';

export default function WebchatPresence() {
  const { workspace, isClientViewer, suspended } = useWorkspace();
  useWebchatPresence(workspace?.id ?? null, !isClientViewer && !suspended);
  return null;
}
