'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { rpc, parseError } from '@/lib/outreach/api';
import type { Workspace, Role } from '@/lib/outreach/types';

interface Ctx {
  workspaces: Workspace[];
  workspace: Workspace | null;
  loading: boolean;
  error: string | null;
  role: Role | null;
  isOwner: boolean;
  isManager: boolean;   // owner or manager
  canWrite: boolean;    // owner/manager/member and plan active
  canReply: boolean;
  suspended: boolean;
  switchWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
}

const WorkspaceContext = createContext<Ctx | undefined>(undefined);
const LS_KEY = 'outreach-workspace-id';

export function OutreachWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      let rows = await rpc<Workspace[]>('my_workspaces');
      if (!rows || rows.length === 0) {
        await rpc('ensure_workspace', { p_name: null });
        rows = await rpc<Workspace[]>('my_workspaces');
      }
      setWorkspaces(rows);
      let stored: string | null = null;
      try { stored = localStorage.getItem(LS_KEY); } catch { /* ignore */ }
      const pick = rows.find((w) => w.id === stored) ?? rows[0] ?? null;
      setCurrentId(pick?.id ?? null);
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const switchWorkspace = useCallback((id: string) => {
    setCurrentId(id);
    try { localStorage.setItem(LS_KEY, id); } catch { /* ignore */ }
  }, []);

  const createWorkspace = useCallback(async (name: string) => {
    const w = await rpc<any>('create_workspace', { p_name: name });
    await load();
    switchWorkspace(w.id);
    return w as Workspace;
  }, [load, switchWorkspace]);

  const workspace = useMemo(() => workspaces.find((w) => w.id === currentId) ?? null, [workspaces, currentId]);
  const role = workspace?.role ?? null;
  const suspended = workspace?.plan === 'suspended';

  const value: Ctx = {
    workspaces,
    workspace,
    loading,
    error,
    role,
    isOwner: role === 'owner',
    isManager: role === 'owner' || role === 'manager',
    canWrite: !!role && role !== 'client_viewer' && !suspended,
    canReply: !!workspace?.can_reply && !suspended,
    suspended,
    switchWorkspace,
    refresh: load,
    createWorkspace,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Ctx {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within OutreachWorkspaceProvider');
  return ctx;
}
