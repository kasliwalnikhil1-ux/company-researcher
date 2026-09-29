'use client';

// Shared state between the master prompt editor and the conversation simulator (Settings → AI replies).
// The page wraps both panels in <AiPromptDraftProvider>. Each panel also works on its own: without a provider
// it wraps itself (see `WithDraftProvider`), so nothing breaks when a panel is rendered alone.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { DraftPrompt, PromptScope } from '@/lib/outreach/aiReplies';

export interface PromptScopeRef { scope: PromptScope; scopeId: string | null }

/** What the editor was loaded with. Kept with the draft so edits survive a tab switch (the editor unmounts). */
export interface EditorBase { prompt: DraftPrompt; id: string | null; version: number | null; savedBy: string | null; savedAt: string | null }

/** What the editor currently holds for one scope. Published on every edit; `dirty` = differs from the saved version. */
export interface PromptDraftSnapshot extends PromptScopeRef {
  scopeLabel: string;
  /** Saved prompt id at this scope (null while the prompt or the override is not saved yet). */
  masterPromptId: string | null;
  /** Version the editor started from (null for a first save). */
  baseVersion: number | null;
  dirty: boolean;
  /** Ready to send (guided body compiled) — what the simulator passes as `draft_prompt`. */
  prompt: DraftPrompt;
  /** The editor's own state, restored when it mounts again for the same scope. */
  editor: { base: EditorBase; edited: DraftPrompt | null };
}

export interface AiPromptDraftCtx {
  /** True when a real provider is mounted above. */
  hasProvider: boolean;
  /** Scope picked in the editor (null = the editor has not changed it; panels fall back to their props). */
  scope: PromptScopeRef | null;
  setScope: (s: PromptScopeRef) => void;
  draft: PromptDraftSnapshot | null;
  publishDraft: (d: PromptDraftSnapshot | null) => void;
  /** Opens the simulator tab/section. Set by the page; when absent the panels scroll to `#ai-simulator`. */
  openSimulator: () => void;
}

export const SIMULATOR_ANCHOR = 'ai-simulator';

function scrollToSimulator() {
  if (typeof document === 'undefined') return;
  document.getElementById(SIMULATOR_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const noop = () => { /* no provider */ };
const AiPromptDraftContext = createContext<AiPromptDraftCtx>({
  hasProvider: false, scope: null, setScope: noop, draft: null, publishDraft: noop, openSimulator: scrollToSimulator,
});

export function AiPromptDraftProvider({ children, onOpenSimulator }: { children: React.ReactNode; onOpenSimulator?: () => void }) {
  const [scope, setScopeState] = useState<PromptScopeRef | null>(null);
  const [draft, setDraft] = useState<PromptDraftSnapshot | null>(null);
  const setScope = useCallback((s: PromptScopeRef) => setScopeState(s), []);
  const publishDraft = useCallback((d: PromptDraftSnapshot | null) => setDraft(d), []);
  const dirty = !!draft?.dirty;
  // unsaved edits live here, not in the editor, so the page-level guard sits here too
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  const value = useMemo<AiPromptDraftCtx>(() => ({
    hasProvider: true, scope, setScope, draft, publishDraft, openSimulator: onOpenSimulator ?? scrollToSimulator,
  }), [scope, setScope, draft, publishDraft, onOpenSimulator]);
  return <AiPromptDraftContext.Provider value={value}>{children}</AiPromptDraftContext.Provider>;
}

export function useAiPromptDraft(): AiPromptDraftCtx {
  return useContext(AiPromptDraftContext);
}

/** Wraps its children in a provider when none is mounted above, so a panel works on its own. */
export function WithDraftProvider({ children }: { children: React.ReactNode }) {
  const ctx = useAiPromptDraft();
  return ctx.hasProvider ? <>{children}</> : <AiPromptDraftProvider>{children}</AiPromptDraftProvider>;
}

export const sameScope = (a: PromptScopeRef | null | undefined, b: PromptScopeRef | null | undefined) =>
  !!a && !!b && a.scope === b.scope && (a.scopeId ?? null) === (b.scopeId ?? null);
