'use client';

// Live Gmail-style preview: controls, the device frame (desktop / mobile × inbox / opened) and
// the measurements read back from the rendered layout.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleAlert, CircleCheck, Maximize2, Minimize2, Monitor, SlidersHorizontal, Smartphone } from 'lucide-react';
import { simulate, type SimMessage, type SimThread } from '@/lib/sequence-studio/simulate';
import { countWords } from '@/lib/sequence-studio/emailText';
import type { PreviewState, Studio } from '../store';
import { Btn, IconBtn, Seg, Select, Toggle, cx } from '../ui';
import { DesktopInbox, DesktopThread } from './Desktop';
import { MobileInbox, MobileThread, type MobileChrome } from './Mobile';
import { buildRows } from './model';
import { measurePreview, type Measures } from './measure';
import styles from './gmail.module.css';

export const DESKTOP_PRESETS = [
  { id: 'laptop-1366', label: '1366 × 657 — small laptop', w: 1366, h: 657, note: 'A 1366×768 laptop screen minus about 110px of browser chrome.' },
  { id: 'mac-1440', label: '1440 × 789 — MacBook / 1440p', w: 1440, h: 789, note: 'A 1440×900 screen minus browser chrome; common on Mac laptops.' },
  { id: 'fhd-1920', label: '1920 × 953 — 1080p monitor', w: 1920, h: 953, note: 'The most common desktop resolution (1920×1080) minus browser chrome.' },
];

export const MOBILE_PRESETS: { id: string; label: string; w: number; h: number; chrome: MobileChrome; note: string }[] = [
  { id: 'iphone-15', label: 'iPhone 15 / 16 — 393 × 852', w: 393, h: 852, chrome: { platform: 'ios', statusHeight: 54, navHeight: 83 }, note: 'Gmail for iOS on a 6.1" iPhone.' },
  { id: 'iphone-pro-max', label: 'iPhone 16 Pro Max — 440 × 956', w: 440, h: 956, chrome: { platform: 'ios', statusHeight: 54, navHeight: 83 }, note: 'Gmail for iOS on the largest iPhone.' },
  { id: 'pixel-8', label: 'Pixel 8 — 412 × 915', w: 412, h: 915, chrome: { platform: 'android', statusHeight: 32, navHeight: 80 }, note: 'Gmail for Android on a Pixel 8.' },
  { id: 'android-small', label: 'Compact Android — 360 × 800', w: 360, h: 800, chrome: { platform: 'android', statusHeight: 28, navHeight: 80 }, note: 'Gmail for Android on a narrow phone.' },
];

const DENSITY_NOTE = {
  default: 'Default density: 40px rows; attachments show as chips on a second line (so rows with files grow).',
  comfortable: 'Comfortable density: 40px rows; attachments show only as a paperclip.',
  compact: 'Compact density: 32px rows; attachments show only as a paperclip.',
};

/** One labelled bar in the details panel: how much of something is visible. */
function Meter({ label, shown, total, unit, tone, title, children }: { label: string; shown: number; total: number; unit: string; tone: 'ok' | 'warn' | 'plain'; title?: string; children?: React.ReactNode }) {
  const pct = total > 0 ? Math.min(100, (shown / total) * 100) : 100;
  const bar = { ok: 'bg-emerald-500', warn: 'bg-amber-500', plain: 'bg-indigo-400' }[tone];
  return (
    <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3" title={title}>
      <span className="text-gray-500">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-gray-200">
        <span className={cx('block h-full rounded-full', bar)} style={{ width: `${pct}%` }} />
      </span>
      <span className="flex items-center gap-2 whitespace-nowrap tabular-nums text-gray-700">
        {shown}/{total} {unit}
        {children}
      </span>
    </div>
  );
}

const MODE_OPTIONS: { value: PreviewState['mode']; label: string }[] = [
  { value: 'message', label: 'This email' },
  { value: 'upto', label: 'Thread up to this step' },
  { value: 'full', label: 'Whole sequence' },
  { value: 'conversation', label: 'With a prospect reply' },
];

/** Small labelled row inside the view-options menu. */
function Opt({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      {children}
    </div>
  );
}

/** One fit-check result in the strip under the preview. */
function Check({ tone, children, title }: { tone: 'ok' | 'warn' | 'bad' | 'plain'; children: React.ReactNode; title?: string }) {
  const tones = { ok: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-700', plain: 'text-gray-600' };
  const Icon = tone === 'ok' ? CircleCheck : tone === 'plain' ? null : CircleAlert;
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap', tones[tone])}>
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </span>
  );
}

export default function GmailPreview({ studio, expanded, onExpand }: { studio: Studio; expanded: boolean; onExpand: (v: boolean) => void }) {
  const { lib: savedLib, ui, setPreview, setUi, edit } = studio;
  const p = ui.preview;
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const optsRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 800, h: 600 });
  const [measures, setMeasures] = useState<Measures | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [optsOpen, setOptsOpen] = useState(false);
  // Thread opened by clicking a row; forgotten when the previewed message changes or on any edit.
  const [openPick, setOpenPick] = useState<{ focus?: string; id: string; lib: unknown; editFocus: unknown } | null>(null);
  const lastEditKey = useRef('');

  const seq = savedLib?.sequences.find((s) => s.id === ui.sequenceId) ?? savedLib?.sequences[0];
  const pick = ui.versionPick;
  const editFocus = ui.editFocus;
  const pickSubjectStep = editFocus?.subjectId ? ui.stepId : undefined;
  const pickSubjectId = editFocus?.subjectId;

  // The preview follows the editor: the version open there and the subject variant being typed,
  // even when other ones are selected for sending.
  const lib = useMemo(() => {
    if (!savedLib || !seq || (!pick && !pickSubjectId)) return savedLib;
    let changed = false;
    const sequences = savedLib.sequences.map((s) =>
      s.id !== seq.id
        ? s
        : {
            ...s,
            steps: s.steps.map((st) => {
              let next = st;
              if (pick && st.id === pick.stepId && st.selectedVersionId !== pick.versionId) {
                const v = st.versions.find((x) => x.id === pick.versionId);
                if (v) next = { ...next, selectedVersionId: v.id, selectedSubjectId: v.subjectId ?? st.selectedSubjectId };
              }
              if (pickSubjectId && st.id === pickSubjectStep && next.selectedSubjectId !== pickSubjectId && st.subjects.some((x) => x.id === pickSubjectId)) {
                next = { ...next, selectedSubjectId: pickSubjectId };
              }
              if (next !== st) changed = true;
              return next;
            }),
          },
    );
    return changed ? { ...savedLib, sequences } : savedLib;
  }, [savedLib, pick, pickSubjectStep, pickSubjectId, seq]);

  const conv = p.mode === 'conversation' ? lib?.conversations.find((c) => c.id === ui.conversationId && c.sequenceId === seq?.id) ?? lib?.conversations.find((c) => c.sequenceId === seq?.id) : undefined;
  const profile = lib?.profiles.find((x) => x.id === lib.activeProfileId) ?? lib?.profiles[0];
  const focusStepId = conv ? conv.afterStepId : ui.stepId;
  const stepIndex = seq ? Math.max(0, seq.steps.findIndex((s) => s.id === focusStepId)) : 0;
  const step = seq?.steps[stepIndex];

  const sim = useMemo(
    () => (lib && seq ? simulate(lib, { sequenceId: seq.id, stepId: focusStepId, mode: p.mode === 'conversation' && !conv ? 'message' : p.mode, conversationId: conv?.id, profile }) : null),
    [lib, seq, focusStepId, p.mode, conv, profile],
  );

  // Sender perspective may show our last reply as an unsent draft in the composer.
  const { threads, draft } = useMemo(() => {
    if (!sim) return { threads: [] as SimThread[], draft: undefined as SimMessage | undefined };
    if (!(p.draftLastReply && p.perspective === 'sender' && conv)) return { threads: sim.threads, draft: undefined };
    const th = sim.threads.find((t) => t.id === sim.focusThreadId);
    const last = th?.messages[th.messages.length - 1];
    if (!th || !last || last.from !== 'us' || !last.turnId) return { threads: sim.threads, draft: undefined };
    return { threads: sim.threads.map((t) => (t === th ? { ...t, messages: t.messages.slice(0, -1) } : t)), draft: last };
  }, [sim, p.draftLastReply, p.perspective, conv]);

  const simView = useMemo(() => (sim ? { ...sim, threads } : null), [sim, threads]);
  const { rows, folder, unreadCount } = useMemo(
    () => (simView ? buildRows(simView, p.perspective, { recipientName: profile?.recipientName || 'Prospect' }) : { rows: [], folder: 'Inbox' as const, unreadCount: 0 }),
    [simView, p.perspective, profile],
  );

  const openThreadId = openPick && openPick.focus === sim?.focusThreadId && openPick.lib === savedLib && openPick.editFocus === editFocus ? openPick.id : undefined;
  const openThread = threads.find((t) => t.id === (openThreadId ?? sim?.focusThreadId)) ?? threads[0];
  // A reply-branch turn being edited becomes the focused message (expanded and scrolled to).
  const editMsgId = editFocus?.turnId ? threads.flatMap((t) => t.messages).find((m) => m.turnId === editFocus.turnId)?.id : undefined;
  const focusId = editMsgId ?? sim?.focusMessageId;

  const desktop = DESKTOP_PRESETS.find((d) => d.id === p.desktopPreset) ?? DESKTOP_PRESETS[1];
  const mobile = MOBILE_PRESETS.find((d) => d.id === p.mobilePreset) ?? MOBILE_PRESETS[0];
  const devW = p.device === 'desktop' ? p.desktopWidth ?? desktop.w : p.mobileWidth ?? mobile.w;
  const devH = p.device === 'desktop' ? desktop.h : mobile.h;
  const zoom = p.zoom ?? 'width';
  // "Fit width" keeps text as large as the panel allows (scroll for the rest of the screen);
  // "Whole screen" shows the full device viewport, so the fold is exactly the bottom edge.
  const fitW = (stage.w - 32) / devW;
  const fitH = (stage.h - 32) / devH;
  const scale = zoom === 'actual' ? 1 : Math.max(0.2, Math.min(1, zoom === 'screen' ? Math.min(fitW, fitH) : fitW));

  // Roboto is Gmail's fallback when Google Sans is unavailable; load it once for the simulator.
  useEffect(() => {
    if (document.getElementById('sequence-studio-roboto')) return;
    const link = document.createElement('link');
    link.id = 'sequence-studio-roboto';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap';
    document.head.appendChild(link);
  }, []);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, [expanded]);

  // Close the view-options menu on an outside click or Escape.
  useEffect(() => {
    if (!optsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (optsRef.current && !optsRef.current.contains(e.target as Node)) setOptsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOptsOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [optsOpen]);

  // Measure after every layout change: renders, expansion clicks, font loading, resizes.
  const runMeasure = useCallback(() => {
    if (rootRef.current) setMeasures(measurePreview(rootRef.current, scale));
  }, [scale]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(runMeasure);
    };
    schedule();
    const mo = new MutationObserver(schedule);
    mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    document.fonts?.ready.then(schedule).catch(() => undefined);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
    };
  }, [runMeasure, p, devW, devH, openThread?.id]);

  // Keep the edit in view. When the edited step, field or turn changes, scroll the preview to it;
  // while typing, keep the part of the message around the caret on screen. Measurements allow
  // for the Gmail scroll position, so scrolling does not change them.
  const editField = editFocus?.field ?? 'body';
  const editKey = [seq?.id, focusStepId, conv?.id, editField, editFocus?.turnId, editFocus?.subjectId, p.view, p.device, p.mode, expanded].join('|');
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const jump = lastEditKey.current !== editKey;
      lastEditKey.current = editKey;
      const root = rootRef.current;
      const stageEl = stageRef.current;
      const pane = root?.querySelector<HTMLElement>(`[data-pane="${p.view}"]`);
      const scroller = pane?.querySelector<HTMLElement>('[data-m="viewport"]');
      if (!stageEl || !pane || !scroller) return;
      let target: HTMLElement | null = null;
      if (p.view === 'inbox') target = pane.querySelector<HTMLElement>('[data-focus-row]');
      else if (editField === 'subject') target = pane.querySelector<HTMLElement>('[data-m="open-subject"]');
      else target = (focusId ? pane.querySelector<HTMLElement>(`[data-msg="${CSS.escape(focusId)}"]`) : null) ?? pane.querySelector<HTMLElement>('[data-m="body"]');
      if (!target) return;
      const sRect = scroller.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      // Unscaled pixels inside the Gmail scroller.
      const top = (tRect.top - sRect.top) / scale + scroller.scrollTop;
      const height = tRect.height / scale;
      const view = scroller.clientHeight;
      const active = document.activeElement;
      const frac = !jump && editField === 'body' && active instanceof HTMLTextAreaElement && active.value.length ? (active.selectionEnd ?? active.value.length) / active.value.length : 0;
      const anchor = top + frac * height;
      if (jump) {
        const fits = top >= scroller.scrollTop && top + Math.min(height, view) <= scroller.scrollTop + view;
        if (!fits) scroller.scrollTop = Math.max(0, editField === 'subject' || top < view / 2 ? 0 : top - 12);
      } else if (anchor < scroller.scrollTop + 24 || anchor > scroller.scrollTop + view - 24) {
        scroller.scrollTop = Math.max(0, anchor - view / 2);
      }
      // Then the stage: the device frame can be taller than the column.
      const stRect = stageEl.getBoundingClientRect();
      const y = sRect.top + (anchor - scroller.scrollTop) * scale;
      if (y < stRect.top + 24 || y > stRect.bottom - 24) {
        stageEl.scrollTo({ top: Math.max(0, stageEl.scrollTop + y - stRect.top - stRect.height / 3), behavior: jump ? 'smooth' : 'auto' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [editKey, savedLib, scale, p.view, editField, focusId]);

  if (!lib || !savedLib || !seq || !sim) return null;

  const focusMsg = [...sim.threads.flatMap((t) => t.messages), ...(draft ? [draft] : [])].find((m) => m.id === (draft?.id ?? focusId));
  const stoppedNote = sim.stopped.length
    ? `Simulator note: ${sim.stopped.length} automated step${sim.stopped.length === 1 ? '' : 's'} (${sim.stopped.map((s) => `Step ${s.index + 1}`).join(', ')}) not sent because the prospect replied. Change “Stop follow-ups when the prospect replies” in Settings.`
    : undefined;
  const meName = p.perspective === 'recipient' ? profile?.recipientName || 'Prospect' : lib.sender.name;
  const convs = lib.conversations.filter((c) => c.sequenceId === seq.id);

  // Is the preview showing a version other than the one this step sends?
  const savedStep = savedLib.sequences.find((s) => s.id === seq.id)?.steps.find((s) => s.id === step?.id);
  const shownVersion = step?.versions.find((v) => v.id === step.selectedVersionId);
  const sentVersion = savedStep?.versions.find((v) => v.id === savedStep.selectedVersionId);
  const previewingOther = p.mode !== 'conversation' && !!shownVersion && !!sentVersion && shownVersion.id !== sentVersion.id;
  const useShown = () =>
    edit((d) => {
      const st = d.sequences.find((s) => s.id === seq.id)?.steps.find((s) => s.id === step?.id);
      if (!st || !shownVersion) return;
      st.selectedVersionId = shownVersion.id;
      if (shownVersion.subjectId) st.selectedSubjectId = shownVersion.subjectId;
    });

  const onOpen = (id: string) => {
    setOpenPick({ focus: sim.focusThreadId, id, lib: savedLib, editFocus });
    setPreview({ view: 'opened' });
  };
  const onBack = () => setPreview({ view: 'inbox' });
  const goStep = (i: number) => {
    const st = seq.steps[i];
    if (st) setUi({ stepId: st.id });
  };

  const paneStyle = (on: boolean): React.CSSProperties => ({ position: 'absolute', inset: 0, visibility: on ? 'visible' : 'hidden', pointerEvents: on ? 'auto' : 'none', display: 'flex', flexDirection: 'column' });

  // Fit check summary.
  const subjClip = measures?.inbox?.subject;
  const snipClip = measures?.inbox?.snippet;
  const opened = measures?.opened;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* Controls: one row. Everything else lives in View options. */}
      <div className="flex-none border-b border-gray-200 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          {p.mode === 'conversation' ? (
            <Select aria-label="Reply branch" value={conv?.id ?? ''} onChange={(e) => setUi({ conversationId: e.target.value })} className="min-w-0 max-w-[260px] flex-1 py-1 text-xs">
              {!convs.length && <option value="">No replies on this sequence</option>}
              {seq.steps.map((st, i) => {
                const list = convs.filter((c) => c.afterStepId === st.id);
                return list.length ? (
                  <optgroup key={st.id} label={`After step ${i + 1} · ${st.name}`}>
                    {list.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </Select>
          ) : (
            step && (
              <div className="flex min-w-0 flex-1 items-center gap-0.5 text-xs text-gray-700">
                <IconBtn label="Previous step" disabled={stepIndex === 0} onClick={() => goStep(stepIndex - 1)} className="flex-none">
                  <ChevronLeft className="h-4 w-4" />
                </IconBtn>
                <span className="min-w-0 truncate" title={`${step.name}${shownVersion && step.versions.length > 1 ? ` · ${shownVersion.name}` : ''}`}>
                  <span className="font-medium text-gray-900">
                    Step {stepIndex + 1}/{seq.steps.length}
                  </span>{' '}
                  {step.name || 'Untitled step'}
                </span>
                <IconBtn label="Next step" disabled={stepIndex >= seq.steps.length - 1} onClick={() => goStep(stepIndex + 1)} className="flex-none">
                  <ChevronRight className="h-4 w-4" />
                </IconBtn>
              </div>
            )
          )}
          <div className="ml-auto flex flex-none items-center gap-1.5">
            <Seg
              label="Device"
              size="sm"
              value={p.device}
              onChange={(v) => setPreview({ device: v })}
              options={[
                { value: 'desktop', label: <Monitor className="h-3.5 w-3.5" />, title: 'Desktop Gmail' },
                { value: 'mobile', label: <Smartphone className="h-3.5 w-3.5" />, title: 'Gmail app on a phone' },
              ]}
            />
            <Seg
              label="View"
              size="sm"
              value={p.view}
              onChange={(v) => setPreview({ view: v })}
              options={[
                { value: 'inbox', label: 'Inbox', title: 'The row in the inbox: how much of the subject and snippet shows' },
                { value: 'opened', label: 'Opened', title: 'The email as the prospect reads it' },
              ]}
            />
            <div ref={optsRef} className="relative">
              <IconBtn label="View options: what to show, whose inbox, sample prospect, screen size, zoom" onClick={() => setOptsOpen((v) => !v)} className={cx(optsOpen && 'bg-indigo-50 text-indigo-700')}>
                <SlidersHorizontal className="h-4 w-4" />
              </IconBtn>
              {optsOpen && (
                <div className="absolute right-0 top-full z-30 mt-1 w-80 space-y-3 rounded-xl border border-gray-200 bg-white p-3 text-xs shadow-lg">
                  <Opt label="Show">
                    <Select aria-label="What to preview" value={p.mode} onChange={(e) => setPreview({ mode: e.target.value as PreviewState['mode'] })} className="w-full py-1 text-xs">
                      {MODE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Opt>
                  <Opt label="Whose inbox">
                    <Seg
                      size="sm"
                      label="Perspective"
                      value={p.perspective}
                      onChange={(v) => setPreview({ perspective: v })}
                      options={[
                        { value: 'recipient', label: 'The prospect’s', title: 'Our outreach arrives as incoming mail' },
                        { value: 'sender', label: 'Ours', title: 'The prospect’s replies arrive as incoming mail' },
                      ]}
                    />
                  </Opt>
                  <Opt label="Sample prospect">
                    <Select aria-label="Sample prospect" value={lib.activeProfileId} onChange={(e) => edit((d) => void (d.activeProfileId = e.target.value))} className="w-full py-1 text-xs">
                      {lib.profiles.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.label}
                        </option>
                      ))}
                    </Select>
                  </Opt>
                  <Opt label="Screen">
                    {p.device === 'desktop' ? (
                      <Select aria-label="Desktop size" value={p.desktopPreset} onChange={(e) => setPreview({ desktopPreset: e.target.value, desktopWidth: null })} className="w-full py-1 text-xs">
                        {DESKTOP_PRESETS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Select aria-label="Phone" value={p.mobilePreset} onChange={(e) => setPreview({ mobilePreset: e.target.value, mobileWidth: null })} className="w-full py-1 text-xs">
                        {MOBILE_PRESETS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </Select>
                    )}
                    <label className="mt-2 flex items-center gap-2 text-gray-600">
                      Width
                      <input
                        type="range"
                        min={p.device === 'desktop' ? 1024 : 320}
                        max={p.device === 'desktop' ? 2560 : 480}
                        value={devW}
                        onChange={(e) => setPreview(p.device === 'desktop' ? { desktopWidth: Number(e.target.value) } : { mobileWidth: Number(e.target.value) })}
                        aria-label="Device width in CSS pixels"
                        className="flex-1 accent-indigo-600"
                      />
                      <span className="w-12 text-right tabular-nums">{devW}px</span>
                    </label>
                  </Opt>
                  <Opt label="Zoom">
                    <Seg
                      size="sm"
                      label="Zoom"
                      value={zoom}
                      onChange={(v) => setPreview({ zoom: v })}
                      options={[
                        { value: 'width', label: 'Fit width', title: 'As large as the panel allows; scroll for the rest' },
                        { value: 'screen', label: 'Whole screen', title: 'The full device screen; the bottom edge is the fold' },
                        { value: 'actual', label: '100%', title: 'Actual size' },
                      ]}
                    />
                  </Opt>
                  <Opt label={p.device === 'desktop' ? 'Inbox density' : 'Inbox snippet'}>
                    {p.device === 'desktop' ? (
                      <Seg
                        size="sm"
                        label="Density"
                        value={p.density}
                        onChange={(v) => setPreview({ density: v })}
                        options={[
                          { value: 'default', label: 'Default' },
                          { value: 'comfortable', label: 'Comfortable' },
                          { value: 'compact', label: 'Compact' },
                        ]}
                      />
                    ) : (
                      <Seg size="sm" label="Snippet lines" value={String(p.snippetLines) as '1' | '2'} onChange={(v) => setPreview({ snippetLines: Number(v) as 1 | 2 })} options={[{ value: '1', label: '1 line' }, { value: '2', label: '2 lines' }]} />
                    )}
                  </Opt>
                  <div className="space-y-2 border-t border-gray-100 pt-3">
                    <span title="Adds a coloured edge to our rows. Not part of Gmail.">
                      <Toggle checked={p.markOurs} onChange={(v) => setPreview({ markOurs: v })} label="Highlight our emails in the inbox" />
                    </span>
                    {p.mode === 'conversation' && p.perspective === 'sender' && <Toggle checked={p.draftLastReply} onChange={(v) => setPreview({ draftLastReply: v })} label="Show our last reply as a draft" />}
                  </div>
                  <p className="text-[11px] leading-4 text-gray-500">
                    {p.device === 'desktop'
                      ? `Gmail web, default theme, Primary tab. ${desktop.note} ${DENSITY_NOTE[p.density]}`
                      : `${mobile.note} Material 3 app layout, 3-line rows.`}
                  </p>
                </div>
              )}
            </div>
            <IconBtn label={expanded ? 'Back to the editor (Esc)' : 'Expand the preview'} onClick={() => onExpand(!expanded)}>
              {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </IconBtn>
          </div>
        </div>
        {previewingOther && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
            <span className="min-w-0 flex-1">
              Showing <b>{shownVersion?.name}</b>, the version open in the editor. This step sends <b>{sentVersion?.name}</b>.
            </span>
            <button type="button" onClick={useShown} className="font-medium text-amber-900 underline hover:no-underline">
              Send this version instead
            </button>
          </div>
        )}
      </div>

      {/* Stage */}
      <div ref={stageRef} className="min-h-[300px] flex-1 overflow-auto bg-gray-100 p-4">
        <div className="mx-auto" style={{ width: devW * scale, height: devH * scale }}>
          <div
            ref={rootRef}
            className={cx(styles.root, 'shadow-sm', p.device === 'mobile' && 'rounded-[28px] ring-8 ring-gray-900')}
            style={{ width: devW, height: devH, transform: `scale(${scale})`, transformOrigin: 'top left', background: p.device === 'mobile' ? '#fff' : undefined }}
          >
            <div data-pane="inbox" style={paneStyle(p.view === 'inbox')} aria-hidden={p.view !== 'inbox'}>
              {p.device === 'desktop' ? (
                <DesktopInbox rows={rows} folder={folder} unreadCount={unreadCount} density={p.density} now={sim.now} meName={meName} markOurs={p.markOurs} onOpen={onOpen} />
              ) : (
                <MobileInbox rows={rows} folder={folder} now={sim.now} meName={meName} markOurs={p.markOurs} snippetLines={p.snippetLines} chrome={mobile.chrome} onOpen={onOpen} />
              )}
            </div>
            <div data-pane="opened" style={paneStyle(p.view === 'opened')} aria-hidden={p.view !== 'opened'}>
              {p.device === 'desktop' ? (
                <DesktopThread thread={openThread} focusId={focusId} perspective={p.perspective} now={sim.now} meName={meName} folder={folder} draft={openThread?.id === sim.focusThreadId ? draft : undefined} stoppedNote={stoppedNote} onBack={onBack} />
              ) : (
                <MobileThread thread={openThread} focusId={focusId} perspective={p.perspective} now={sim.now} folder={folder} draft={openThread?.id === sim.focusThreadId ? draft : undefined} stoppedNote={stoppedNote} chrome={mobile.chrome} onBack={onBack} />
              )}
            </div>
          </div>
        </div>
        {scale < 0.65 && !expanded && (
          <div className="mx-auto mt-3 flex max-w-md flex-col items-center gap-2 text-center text-xs text-gray-500">
            <span>
              {p.device === 'desktop' ? 'Desktop Gmail' : 'This screen'} is shown at {Math.round(scale * 100)}% to fit this column.
            </span>
            <div className="flex gap-2">
              <Btn size="sm" onClick={() => onExpand(true)}>
                <Maximize2 className="h-3.5 w-3.5" /> Expand to read it
              </Btn>
              {p.device === 'desktop' && (
                <Btn size="sm" tone="ghost" onClick={() => setPreview({ device: 'mobile' })}>
                  <Smartphone className="h-3.5 w-3.5" /> Phone view
                </Btn>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Fit check: one line, details on demand. */}
      <div className="flex-none border-t border-gray-200 bg-gray-50 text-xs">
        <div className="flex items-center gap-3 px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
            {subjClip && (
              <Check tone={subjClip.visible < subjClip.total ? 'warn' : 'ok'} title="Subject in the inbox row at this screen size">
                {subjClip.visible < subjClip.total ? `Subject cut at ${subjClip.visible}/${subjClip.total}` : 'Subject fits'}
              </Check>
            )}
            {opened && opened.lines.length > 0 && (
              <Check tone={opened.aboveCount < opened.lines.length ? 'warn' : 'ok'} title="Body lines visible without scrolling in the opened email">
                {opened.aboveCount < opened.lines.length ? `${opened.aboveCount}/${opened.lines.length} lines above fold` : 'Above the fold'}
              </Check>
            )}
            {sim.missing.length > 0 && (
              <Check tone="bad" title={`Missing ${sim.missing.map((m) => `{{${m}}}`).join(', ')}. These show as raw placeholders with this sample prospect. Add a sample value or fallback in Variables.`}>
                {sim.missing.length} missing
              </Check>
            )}
            {snipClip && (
              <Check tone="plain" title="Snippet characters visible in the inbox row (preview text, then body)">
                Snippet {snipClip.visible}/{snipClip.total}
              </Check>
            )}
            {focusMsg && <Check tone="plain">{countWords(focusMsg.bodyText)} words</Check>}
          </div>
          <button type="button" onClick={() => setShowDetails((v) => !v)} className="inline-flex flex-none items-center gap-0.5 font-medium text-indigo-700 hover:underline" aria-expanded={showDetails}>
            Details {showDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        </div>
        {showDetails && (
          <div className="max-h-[40vh] overflow-auto border-t border-gray-200 px-3 py-2.5">
            <MeasurePanel measures={measures} />
          </div>
        )}
      </div>
    </div>
  );
}

function MeasurePanel({ measures }: { measures: Measures | null }) {
  const [linesOpen, setLinesOpen] = useState(false);
  if (!measures) return <div className="text-gray-500">Measuring…</div>;
  const o = measures.opened;
  const subj = measures.inbox?.subject;
  const snip = measures.inbox?.snippet;
  const fontNote = measures.fonts.googleSans
    ? 'Google Sans is installed here, so widths match Gmail closely.'
    : `Google Sans is not installed in this browser; rows render in ${measures.fonts.roboto ? 'Roboto' : 'a fallback sans-serif'}, so expect a few % difference.`;
  const fitTone = (shown: number, total: number) => (shown < total ? 'warn' : 'ok');
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {subj && <Meter label="Subject" shown={subj.visible} total={subj.total} unit="chars" tone={fitTone(subj.visible, subj.total)} title={subj.text.slice(0, subj.visible)} />}
        {snip && <Meter label="Snippet" shown={snip.visible} total={snip.total} unit="chars" tone="plain" title={snip.text.slice(0, snip.visible)} />}
        {o && o.lines.length > 0 && (
          <Meter label="Opened" shown={o.aboveCount} total={o.lines.length} unit="lines" tone={fitTone(o.aboveCount, o.lines.length)} title={`Lines visible without scrolling. Body column ${o.bodyWidth}px.`}>
            <button type="button" className="inline-flex items-center gap-0.5 text-indigo-700 hover:underline" onClick={() => setLinesOpen((v) => !v)} aria-expanded={linesOpen}>
              Lines {linesOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
          </Meter>
        )}
      </div>
      {o && (
        <div>
          {linesOpen && (
            <ol className="mt-1 max-h-48 overflow-auto rounded border border-gray-200 bg-white font-mono text-[11px] leading-5">
              {o.lines.map((l, i) => (
                <li key={i} className={cx('flex gap-2 px-2', !l.above && 'bg-gray-50 text-gray-400', i === o.aboveCount && i > 0 && 'border-t-2 border-dashed border-violet-500')}>
                  <span className="w-6 flex-none text-right tabular-nums text-gray-400">{i + 1}</span>
                  <span className="whitespace-pre-wrap">{l.text || ' '}</span>
                  {i === o.aboveCount - 1 && o.aboveCount < o.lines.length && <span className="ml-auto flex-none text-violet-700">↑ fold</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <p className="text-[11px] text-gray-400" title={`Measured from this rendered preview, not fixed character limits. ${fontNote} Gmail varies with app version, device, zoom and settings.`}>
        Measured from this preview · approximate
      </p>
    </div>
  );
}
