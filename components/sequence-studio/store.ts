'use client';

// State for the sequence studio: the edited library with undo/redo, plus view state. Both are
// saved to localStorage (per browser) so work survives reloads. Nothing is sent to a server.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, Library } from '@/lib/sequence-studio/types';
import type { PreviewMode, Perspective } from '@/lib/sequence-studio/simulate';
import { importSourceMarkdown } from '@/lib/sequence-studio/importSource';
import { repairLibrary } from '@/lib/sequence-studio/studioFormat';
import { SOURCE_FILE_NAME, SOURCE_MD } from '@/lib/sequence-studio/source';
import { clone } from '@/lib/sequence-studio/util';

const STORAGE_KEY = 'sequence-studio.library.v1';
// v3: preview-first layout (phone preview at full size, opened view, zoom). Older keys are read
// once for the selected sequence/step only.
const UI_KEY = 'sequence-studio.ui.v3';
const UI_KEY_OLD = ['sequence-studio.ui.v2', 'sequence-studio.ui.v1'];
const HISTORY_LIMIT = 200;
const COALESCE_MS = 900;

export type EditorTab = 'message' | 'sequence' | 'variables' | 'replies' | 'guidance' | 'settings';
export type Density = 'default' | 'comfortable' | 'compact';
/** width: fit the device width (scroll for the rest), screen: whole device screen, actual: 100%. */
export type Zoom = 'width' | 'screen' | 'actual';

export interface PreviewState {
  device: 'desktop' | 'mobile';
  view: 'inbox' | 'opened';
  perspective: Perspective;
  mode: PreviewMode;
  desktopPreset: string;
  mobilePreset: string;
  desktopWidth: number | null;
  mobileWidth: number | null;
  density: Density;
  snippetLines: 1 | 2;
  draftLastReply: boolean;
  markOurs: boolean;
  zoom: Zoom;
}

/** What the editor is changing right now, so the preview can show and scroll to it. */
export interface EditFocus {
  field: 'subject' | 'body';
  /** A conversation turn being edited (the preview focuses that message). */
  turnId?: string;
  /** A subject variant being edited (the preview shows it even if another variant is selected). */
  subjectId?: string;
}

export interface UIState {
  sequenceId?: string;
  stepId?: string;
  tab: EditorTab;
  replyId?: string;
  conversationId?: string;
  blockId?: string;
  textMode: 'raw' | 'personalized';
  /** Version open in the editor; the preview shows it instead of the step's sent version. */
  versionPick?: { stepId: string; versionId: string };
  editFocus?: EditFocus;
  preview: PreviewState;
  /** Hide the sequences list and editor so the preview gets the full width. */
  previewOnly?: boolean;
  panels: { left: number; center: number; leftOpen: boolean; centerOpen: boolean };
}

export const DEFAULT_PREVIEW: PreviewState = {
  // A phone fits the preview column at 100%; desktop Gmail needs the expanded preview to be legible.
  device: 'mobile',
  view: 'opened',
  perspective: 'recipient',
  mode: 'message',
  desktopPreset: 'mac-1440',
  mobilePreset: 'iphone-15',
  desktopWidth: null,
  mobileWidth: null,
  density: 'default',
  snippetLines: 1,
  draftLastReply: false,
  markOurs: true,
  zoom: 'width',
};

function freshLibrary(): Library {
  return importSourceMarkdown(SOURCE_MD, SOURCE_FILE_NAME).library;
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function pickOld(v1: Partial<UIState> | null): Partial<UIState> | null {
  if (!v1) return null;
  const out: Partial<UIState> = {};
  if (v1.sequenceId) out.sequenceId = v1.sequenceId;
  if (v1.stepId) out.stepId = v1.stepId;
  if (v1.textMode) out.textMode = v1.textMode;
  return out;
}

interface History {
  past: Library[];
  present: Library;
  future: Library[];
  lastKey?: string;
  lastAt: number;
}

export function useStudioStore() {
  const [hist, setHist] = useState<History | null>(null);
  const [ui, setUiState] = useState<UIState>({
    tab: 'message',
    textMode: 'raw',
    preview: DEFAULT_PREVIEW,
    panels: { left: 220, center: 440, leftOpen: true, centerOpen: true },
  });
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed' | 'idle'>('idle');
  const loaded = useRef(false);

  // Load once on the client.
  useEffect(() => {
    const stored = readJSON<Library>(STORAGE_KEY);
    let lib: Library;
    try {
      lib = stored && Array.isArray(stored.sequences) ? stored : freshLibrary();
      repairLibrary(lib);
    } catch {
      lib = freshLibrary();
    }
    // Reading localStorage must wait for the client, so the first render is the loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHist({ past: [], present: lib, future: [], lastAt: 0 });
    const storedUi = readJSON<Partial<UIState>>(UI_KEY) ?? pickOld(UI_KEY_OLD.map((k) => readJSON<Partial<UIState>>(k)).find(Boolean) ?? null);
    setUiState((cur) => {
      const next = { ...cur, ...(storedUi ?? {}), preview: { ...DEFAULT_PREVIEW, ...(storedUi?.preview ?? {}) }, panels: { ...cur.panels, ...(storedUi?.panels ?? {}) } };
      const seq = lib.sequences.find((s) => s.id === next.sequenceId) ?? lib.sequences.find((s) => /recommended/i.test(s.name)) ?? lib.sequences[0];
      next.sequenceId = seq?.id;
      if (!seq?.steps.some((s) => s.id === next.stepId)) next.stepId = seq?.steps[0]?.id;
      return next;
    });
    loaded.current = true;
  }, []);

  // Autosave (debounced).
  useEffect(() => {
    if (!hist || !loaded.current) return;
    setSaveState('saving');
    const t = window.setTimeout(() => setSaveState(writeJSON(STORAGE_KEY, hist.present) ? 'saved' : 'failed'), 400);
    return () => window.clearTimeout(t);
  }, [hist?.present]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loaded.current) return;
    const t = window.setTimeout(() => writeJSON(UI_KEY, ui), 300);
    return () => window.clearTimeout(t);
  }, [ui]);

  /** Apply an edit. Edits sharing a `coalesce` key within ~1s become one undo step (typing). */
  const edit = useCallback((fn: (draft: Library) => void, coalesce?: string) => {
    setHist((h) => {
      if (!h) return h;
      const draft = clone(h.present);
      fn(draft);
      const now = Date.now();
      const merge = coalesce && h.lastKey === coalesce && now - h.lastAt < COALESCE_MS;
      return {
        past: merge ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: draft,
        future: [],
        lastKey: coalesce,
        lastAt: now,
      };
    });
  }, []);

  const replace = useCallback((lib: Library) => {
    setHist((h) => (h ? { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: lib, future: [], lastAt: 0 } : { past: [], present: lib, future: [], lastAt: 0 }));
  }, []);

  const undo = useCallback(() => {
    setHist((h) => (h && h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], lastAt: 0 } : h));
  }, []);
  const redo = useCallback(() => {
    setHist((h) => (h && h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), lastAt: 0 } : h));
  }, []);

  const setUi = useCallback((patch: Partial<UIState> | ((u: UIState) => Partial<UIState>)) => {
    setUiState((u) => ({ ...u, ...(typeof patch === 'function' ? patch(u) : patch) }));
  }, []);
  const setPreview = useCallback((patch: Partial<PreviewState>) => {
    setUiState((u) => ({ ...u, preview: { ...u.preview, ...patch } }));
  }, []);

  const resetToSource = useCallback(() => replace(freshLibrary()), [replace]);

  /** The editor is working on this step: the preview opens it (leaving a reply branch if one is open). */
  const focusStep = useCallback((sequenceId: string, stepId: string, field: EditFocus['field'] = 'body', subjectId?: string) => {
    setUiState((u) => {
      if (u.sequenceId === sequenceId && u.stepId === stepId && u.preview.mode !== 'conversation' && u.editFocus?.field === field && !u.editFocus.turnId && u.editFocus.subjectId === subjectId) return u;
      // Open the email being edited (Inbox view stays only if picked again while editing the same thing).
      return { ...u, sequenceId, stepId, editFocus: { field, subjectId }, preview: { ...u.preview, view: 'opened', mode: u.preview.mode === 'conversation' ? 'message' : u.preview.mode } };
    });
  }, []);

  /** The editor is working on this reply branch (optionally one of its turns): the preview opens it. */
  const focusConversation = useCallback((conv: Conversation, turnId?: string) => {
    setUiState((u) => {
      if (u.conversationId === conv.id && u.sequenceId === conv.sequenceId && u.preview.mode === 'conversation' && u.editFocus?.turnId === turnId) return u;
      return { ...u, sequenceId: conv.sequenceId, stepId: conv.afterStepId, conversationId: conv.id, editFocus: { field: 'body', turnId }, preview: { ...u.preview, view: 'opened', mode: 'conversation' } };
    });
  }, []);

  return useMemo(
    () => ({
      lib: hist?.present ?? null,
      canUndo: !!hist?.past.length,
      canRedo: !!hist?.future.length,
      edit,
      replace,
      undo,
      redo,
      ui,
      setUi,
      setPreview,
      saveState,
      resetToSource,
      focusStep,
      focusConversation,
    }),
    [hist, edit, replace, undo, redo, ui, setUi, setPreview, saveState, resetToSource, focusStep, focusConversation],
  );
}

export type Studio = ReturnType<typeof useStudioStore>;
