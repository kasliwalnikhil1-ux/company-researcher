'use client';

import { useEffect } from 'react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { installHealthClientEvents, setHealthWorkspace } from '@/lib/outreach/clientEvents';

/** Mounts once inside the outreach shell: installs the Health error / event listeners and keeps the workspace id current. */
export default function HealthClientEvents() {
  const { workspace } = useWorkspace();
  useEffect(() => installHealthClientEvents(), []);
  useEffect(() => { setHealthWorkspace(workspace?.id ?? null); }, [workspace?.id]);
  return null;
}
