'use client';

// Sequence studio: organise, edit and preview outreach sequences and reply conversations in a
// local Gmail-style simulator. Left: sequences + timeline. Centre: editor tabs. Right: preview.
// Everything runs in the browser; work is saved to localStorage.

import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Braces, Check, ChevronDown, ChevronLeft, ChevronRight, CloudAlert, Download, FileUp, Redo2, Settings2, Undo2 } from 'lucide-react';
import type { Conversation, ImportResult } from '@/lib/sequence-studio/types';
import { importSourceMarkdown } from '@/lib/sequence-studio/importSource';
import { exportMarkdown, importMarkdown, mergeLibraries } from '@/lib/sequence-studio/studioFormat';
import { useStudioStore, type EditorTab } from './store';
import NavPanel from './NavPanel';
import MessageTab from './MessageTab';
import SequenceTab from './SequenceTab';
import VariablesTab from './VariablesTab';
import RepliesTab from './RepliesTab';
import SettingsTab from './SettingsTab';
import BlockList from './BlockList';
import ImportDialog from './ImportDialog';
import GmailPreview from './preview/GmailPreview';
import { TextModeToggle } from './MessageTab';
import { Btn, IconBtn, SectionTitle, TabButton } from './ui';

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'message', label: 'Message' },
  { id: 'sequence', label: 'Sequence' },
  { id: 'replies', label: 'Replies' },
];
// Less-used tabs show as icons so the strip fits the editor column without scrolling.
const ICON_TABS = [
  { id: 'variables', label: 'Variables', Icon: Braces },
  { id: 'guidance', label: 'Guidance & notes', Icon: BookOpen },
  { id: 'settings', label: 'Settings', Icon: Settings2 },
] as const;

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'library'
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** `toolbarSlot`: an element in the page header to render the save state, undo and import/export into. */
export default function SequenceStudio({ toolbarSlot }: { toolbarSlot?: HTMLElement | null }) {
  const studio = useStudioStore();
  const { lib, ui, setUi, setPreview, edit, undo, redo, canUndo, canRedo, saveState, replace } = studio;
  const previewOnly = !!ui.previewOnly;
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<{ name: string; result: ImportResult } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [exportOpen]);

  // Undo/redo shortcuts outside text fields (text fields keep their own native undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && previewOnly && !isTyping(e.target)) setUi({ previewOnly: false });
      if (!(e.ctrlKey || e.metaKey) || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, previewOnly, setUi]);

  const readFile = useCallback(async (file: File) => {
    setImportError(null);
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      setImportError(`${file.name} is not a Markdown file (.md).`);
      return;
    }
    try {
      const text = await file.text();
      setPending({ name: file.name, result: importMarkdown(text, file.name, importSourceMarkdown) });
    } catch (e) {
      setImportError(`Could not read ${file.name}: ${(e as Error).message}`);
    }
  }, []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
  };

  const applyImport = (mode: 'replace' | 'merge') => {
    if (!pending || !lib) return;
    const next = mode === 'replace' ? pending.result.library : mergeLibraries(lib, pending.result.library);
    replace(next);
    const seq = mode === 'replace' ? next.sequences[0] : next.sequences[lib.sequences.length] ?? next.sequences[0];
    setUi({ sequenceId: seq?.id, stepId: seq?.steps[0]?.id, tab: 'message', replyId: undefined, conversationId: undefined });
    setPending(null);
  };

  const exportAll = () => lib && download(`${slug(lib.title)}.md`, exportMarkdown(lib));
  const exportSeq = (id: string) => {
    if (!lib) return;
    const s = lib.sequences.find((x) => x.id === id);
    download(`${slug(s?.name ?? 'sequence')}.md`, exportMarkdown(lib, id));
  };

  const previewConversation = (c: Conversation) => {
    setUi({ sequenceId: c.sequenceId, stepId: c.afterStepId, conversationId: c.id });
    setPreview({ mode: 'conversation', view: 'opened' });
  };

  // Panel resizing.
  const startResize = (which: 'left' | 'center') => (e: RPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = which === 'left' ? ui.panels.left : ui.panels.center;
    const onMove = (ev: PointerEvent) => {
      const w = Math.round(start + ev.clientX - startX);
      setUi((u) => ({ panels: { ...u.panels, [which]: which === 'left' ? Math.min(420, Math.max(200, w)) : Math.min(760, Math.max(340, w)) } }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (!lib) return <div className="flex flex-1 items-center justify-center text-sm text-gray-500">Loading the sequence library…</div>;

  const ctx = { profile: lib.profiles.find((p) => p.id === lib.activeProfileId), variables: lib.variables };
  const seq = lib.sequences.find((s) => s.id === ui.sequenceId);

  const toolbar = (
    <div className="flex items-center gap-1.5 py-1">
      <span className="mr-1 inline-flex items-center gap-1 text-xs text-gray-500" title={`${lib.title}${lib.sourceFileName ? ` (from ${lib.sourceFileName})` : ''}. Saved in this browser only.`}>
        {saveState === 'failed' ? <CloudAlert className="h-3.5 w-3.5 text-red-600" /> : <Check className="h-3.5 w-3.5 text-emerald-600" />}
        {saveState === 'saving' ? 'Saving…' : saveState === 'failed' ? 'Not saved' : 'Saved'}
      </span>
      <IconBtn label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo2 className="h-4 w-4" />
      </IconBtn>
      <IconBtn label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        <Redo2 className="h-4 w-4" />
      </IconBtn>
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) readFile(f);
          e.target.value = '';
        }}
      />
      <Btn size="sm" tone="ghost" onClick={() => fileRef.current?.click()} title="Import a .md file (or drop one anywhere here)">
        <FileUp className="h-3.5 w-3.5" /> Import
      </Btn>
      <div ref={exportRef} className="relative">
        <Btn size="sm" onClick={() => setExportOpen((v) => !v)} aria-expanded={exportOpen}>
          <Download className="h-3.5 w-3.5" /> Export <ChevronDown className="h-3 w-3" />
        </Btn>
        {exportOpen && (
          <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-gray-200 bg-white p-1 text-sm shadow-lg" role="menu">
            {seq && (
              <button type="button" role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-gray-50" onClick={() => { exportSeq(seq.id); setExportOpen(false); }}>
                <span className="block font-medium text-gray-900">This sequence</span>
                <span className="block text-xs text-gray-500">{seq.name} with its reply branches</span>
              </button>
            )}
            <button type="button" role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-gray-50" onClick={() => { exportAll(); setExportOpen(false); }}>
              <span className="block font-medium text-gray-900">Whole library</span>
              <span className="block text-xs text-gray-500">Every sequence, reply, variable and note</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col bg-white"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {!toolbarSlot && <div className="flex flex-none justify-end border-b border-gray-200 px-3">{toolbar}</div>}
      {toolbarSlot && createPortal(toolbar, toolbarSlot)}
      {importError && (
        <div className="flex-none border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800" role="alert">
          {importError}{' '}
          <button type="button" className="underline" onClick={() => setImportError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Panels */}
      <div ref={layoutRef} className="flex min-h-0 flex-1">
        {ui.previewOnly ? null : ui.panels.leftOpen ? (
          <aside className="relative flex-none border-r border-gray-200 bg-gray-50/60" style={{ width: ui.panels.left }} aria-label="Sequences and steps">
            <NavPanel studio={studio} onCollapse={() => setUi((u) => ({ panels: { ...u.panels, leftOpen: false } }))} />
            <div role="separator" aria-orientation="vertical" aria-label="Resize sequences panel" onPointerDown={startResize('left')} className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-indigo-200/60" />
          </aside>
        ) : (
          <button type="button" className="flex w-6 flex-none items-start justify-center border-r border-gray-200 bg-gray-50 pt-3 text-gray-500 hover:bg-gray-100" onClick={() => setUi((u) => ({ panels: { ...u.panels, leftOpen: true } }))} aria-label="Show sequences panel">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}

        {ui.previewOnly ? null : ui.panels.centerOpen ? (
          <section className="relative flex min-w-0 flex-none flex-col border-r border-gray-200" style={{ width: ui.panels.center }} aria-label="Editor">
            <div className="flex flex-none items-center gap-0.5 border-b border-gray-200 px-2">
              <div className="-mb-px flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]" role="tablist" aria-label="Editor tabs">
                {TABS.map((t) => (
                  <TabButton key={t.id} active={ui.tab === t.id} onClick={() => setUi({ tab: t.id })} className="px-2">
                    {t.label}
                  </TabButton>
                ))}
                <span className="ml-auto" />
                {ICON_TABS.map(({ id, label, Icon }) => (
                  <TabButton key={id} active={ui.tab === id} onClick={() => setUi({ tab: id })} className="px-2" label={label}>
                    <Icon className="h-4 w-4" />
                  </TabButton>
                ))}
              </div>
              <IconBtn label="Collapse editor" className="h-6 w-6 flex-none" onClick={() => setUi((u) => ({ panels: { ...u.panels, centerOpen: false } }))}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </IconBtn>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4" role="tabpanel">
              {ui.tab === 'message' && <MessageTab studio={studio} />}
              {ui.tab === 'sequence' && <SequenceTab studio={studio} onExportSequence={exportSeq} />}
              {ui.tab === 'variables' && <VariablesTab studio={studio} />}
              {ui.tab === 'replies' && <RepliesTab studio={studio} onPreviewConversation={previewConversation} />}
              {ui.tab === 'guidance' && (
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <p className="flex-1 text-sm text-gray-600">Principles, subject guidance, example openings and frameworks from the source. Never part of an email or preview.</p>
                    <TextModeToggle studio={studio} />
                  </div>
                  <BlockList blocks={lib.blocks} ctx={ctx} mode={ui.textMode} emptyText="No guidance." onEdit={(fn, key) => edit((d) => fn(d.blocks), key)} />
                  {seq && seq.blocks.length > 0 && (
                    <>
                      <SectionTitle>{seq.name} — supporting content</SectionTitle>
                      <BlockList blocks={seq.blocks} ctx={ctx} mode={ui.textMode} emptyText="" onEdit={(fn, key) => edit((d) => fn(d.sequences.find((s) => s.id === seq.id)!.blocks), key)} />
                    </>
                  )}
                </div>
              )}
              {ui.tab === 'settings' && <SettingsTab studio={studio} />}
            </div>
            <div role="separator" aria-orientation="vertical" aria-label="Resize editor" onPointerDown={startResize('center')} className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-indigo-200/60" />
          </section>
        ) : (
          <button type="button" className="flex w-6 flex-none items-start justify-center border-r border-gray-200 bg-gray-50 pt-3 text-gray-500 hover:bg-gray-100" onClick={() => setUi((u) => ({ panels: { ...u.panels, centerOpen: true } }))} aria-label="Show editor">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}

        <section className="flex min-h-0 min-w-[420px] flex-1 flex-col" aria-label="Gmail preview">
          <GmailPreview studio={studio} expanded={previewOnly} onExpand={(v) => setUi({ previewOnly: v })} />
        </section>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-indigo-50/80 ring-4 ring-inset ring-indigo-400">
          <div className="rounded-lg bg-white px-5 py-3 text-sm font-medium text-indigo-900 shadow">Drop a .md file to review it before importing</div>
        </div>
      )}
      {pending && <ImportDialog fileName={pending.name} result={pending.result} onApply={applyImport} onCancel={() => setPending(null)} />}
    </div>
  );
}
