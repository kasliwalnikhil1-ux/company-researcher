/**
 * The product-tour walkthrough (Driver.js): ten steps across pages, then the finish card (DemoFinish). The controller navigates to a step's page, waits
 * up to 4 s for its `[data-tour="…"]` target and highlights it; a target that never appears (a narrow screen) gets a
 * centred popover instead. Skippable at every step (Close, Esc, a click on the overlay), with Back.
 *
 * State: `gxdemo:tour` = `step:<n>` | `done` | `skipped`. The tour starts only from the welcome card or "Restart tour",
 * never by itself on a later visit. After it ends the whole product stays open.
 */
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { DEMO_TOUR_AI_CHAT_ID, DEMO_TOUR_SEQUENCE_ID, DEMO_TOUR_WEBSITE_ID, DEMO_WS_ID } from '@/lib/outreach/demoIds';
import { filtersKey } from '@/lib/outreach/persistedFilters';
import { kv } from '@/lib/outreach/storage';

/**
 * `canvas`: zoom the sequence canvas first: onto the top of the flow (`top`) or onto the topmost step of that type.
 * `side`: where the popover sits (default below the target).
 * `click`: clicked first (once it is on screen), e.g. to pick a tab the step talks about.
 * `top`: keep the page at the top (a target taller than the window would otherwise be scrolled to its top edge).
 */
export interface TourStep { route: string; element: string; title: string; text: string; canvas?: 'top' | 'send_message'; side?: 'top' | 'left' | 'right' | 'bottom'; click?: string; top?: boolean }

/** Written for a buyer: what each part gets them, in the order the work happens (people → accounts → outreach → replies → website → meetings). */
export const TOUR_STEPS: TourStep[] = [
  { route: '/outreach/leads/import', click: '#import-tab-search_url', element: '#import-tab-search_url', title: 'Find the right people', side: 'right', top: true, text: 'Pull prospects from a Sales Navigator search, people who liked or commented on a LinkedIn post, your target companies or a spreadsheet. Duplicates are removed for you.' },
  { route: '/outreach/senders', element: '[data-tour="sender-channels"]', title: "Connect your team's accounts", text: "Add each person's LinkedIn, email, WhatsApp and Instagram. Outreach goes out from their own accounts, within safe daily limits." },
  { route: `/outreach/sequences/${DEMO_TOUR_SEQUENCE_ID}`, element: '[data-tour="builder-canvas"]', title: 'Reach them on every channel', text: 'Set the steps once: view their profile, connect, message, then follow up by email or WhatsApp. It stops on its own when someone replies.', canvas: 'top' },
  { route: `/outreach/sequences/${DEMO_TOUR_SEQUENCE_ID}`, element: '[data-tour="builder-message-step"]', title: 'Every message feels personal', text: 'AI writes a line for each person from their profile and company, so no two messages read the same.', canvas: 'send_message' },
  { route: `/outreach/sequences/${DEMO_TOUR_SEQUENCE_ID}`, element: '[data-tour="sequence-start"]', title: 'Press start, it runs every day', text: 'Leads move through the steps on their own, every working day. You only step in when someone wants to talk.' },
  { route: `/outreach/inbox/${DEMO_TOUR_AI_CHAT_ID}`, element: '[data-tour="inbox-thread"]', title: 'AI talks to your prospects', side: 'left', text: 'When someone replies, AI answers their questions and sends your calendar link. Here it handled the whole conversation and the prospect booked a call.' },
  { route: `/outreach/inbox/${DEMO_TOUR_AI_CHAT_ID}`, element: '[data-tour="inbox-list"]', title: 'Every reply in one place', side: 'right', text: 'LinkedIn, email, WhatsApp, Instagram and your website chat all land in one inbox. Step in whenever you want.' },
  { route: `/outreach/websites/${DEMO_TOUR_WEBSITE_ID}?tab=design`, click: '[data-preview-view="chat"]', element: '[data-tour="widget-preview"]', title: 'Your website answers visitors', side: 'left', text: 'Add a chat to your website with one line of code, in your own colours and logo. AI answers visitors from your own pages and recommends the right products.' },
  { route: `/outreach/websites/${DEMO_TOUR_WEBSITE_ID}?tab=design`, click: '[data-preview-view="voice"]', element: '[data-tour="widget-preview"]', title: 'Visitors can talk to it too', side: 'left', text: 'One tap and a visitor speaks with an AI voice agent on your site, in their own language. Every call lands in your inbox with a summary and the recording.' },
  { route: '/outreach/reports?tab=funnel', element: '[data-tour="funnel-path"]', side: 'top', title: 'See the meetings it books', text: 'Track who accepted, replied, showed interest and booked a meeting, for every campaign.' },
];

export type TourState = { kind: 'idle' } | { kind: 'step'; index: number } | { kind: 'done' } | { kind: 'skipped' };

const KEY = 'tour';

export function readTourState(): TourState {
  try {
    const v = kv.getItem(KEY);
    if (v === 'done') return { kind: 'done' };
    if (v === 'skipped') return { kind: 'skipped' };
    const m = v ? /^step:(\d+)$/.exec(v) : null;
    if (m) return { kind: 'step', index: Number(m[1]) };
  } catch { /* storage blocked */ }
  return { kind: 'idle' };
}
function writeTourState(v: string) { try { kv.setItem(KEY, v); } catch { /* storage blocked */ } }

function until(ok: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => (ok() || Date.now() - started > ms ? resolve() : setTimeout(look, 100));
    look();
  });
}

function waitFor(selector: string, ms: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const el = document.querySelector(selector);
      if (el && (el as HTMLElement).getClientRects().length > 0) return resolve(el);
      if (Date.now() - started > ms) return resolve(null);
      setTimeout(look, 100);
    };
    look();
  });
}

/** Ask the canvas (Canvas.tsx) to zoom; resolves with the focused step's id once it has settled (null: no answer). */
function focusCanvas(type: TourStep['canvas']): Promise<string | null> {
  return new Promise((resolve) => {
    let timer = 0;
    const done = (e?: Event) => {
      window.clearTimeout(timer);
      window.removeEventListener('outreach:canvas-focused', done);
      resolve((e as CustomEvent<{ id: string | null }> | undefined)?.detail?.id ?? null);
    };
    window.addEventListener('outreach:canvas-focused', done);
    timer = window.setTimeout(done, 4000);
    window.dispatchEvent(new CustomEvent('outreach:canvas-focus', { detail: { type: type === 'top' ? undefined : type } }));
  });
}

/**
 * Put the target on screen before Driver measures it. Driver's own smooth scroll moves the app's inner scroll area
 * after it has placed the popover, which leaves the popover over the highlight. A popover above the target needs
 * room above it, so that target goes to the bottom of the window.
 */
function bringIntoView(el: HTMLElement, side: TourStep['side']) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  if (r.height > vh) return;
  const ROOM = 240; // popover height + arrow + gap
  if (side === 'top') {
    if (r.top >= ROOM && r.bottom <= vh) return;
    el.style.scrollMarginBottom = '16px';
    el.scrollIntoView({ block: 'end', behavior: 'instant' });
  } else {
    if (r.top >= 0 && r.bottom <= vh) return;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
}

/** A key typed into a field (a search box, the composer) is the visitor's, not the tour's. */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || el.closest?.('.driver-popover')) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** Next: → ↓ Enter. Back: ← ↑ Backspace (and the keyboard's Back key). Esc skips. Alt/Ctrl/Cmd combinations stay the browser's. */
export function tourKey(e: KeyboardEvent): 'next' | 'back' | 'close' | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return null;
  if (e.key === 'Escape') return 'close';
  if (typing(e.target)) return null;
  if (e.key === 'Enter') {
    // Driver focuses the popover's first button (Close), so Enter there means Next; a tabbed-to Back means Back.
    // A focused button anywhere else (the welcome and finish cards) does its own thing.
    const btn = (e.target as HTMLElement | null)?.closest?.('button');
    if (btn && !btn.closest('.driver-popover')) return null;
    return btn?.classList.contains('driver-popover-prev-btn') ? 'back' : 'next';
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return 'next';
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'Backspace' || e.key === 'BrowserBack') return 'back';
  return null;
}

export interface TourController {
  /** From the first step, or from step `at` (the finish card's Back). */
  start(at?: number): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * `navigate` gets an `/outreach…` path (the caller maps it into the tour), `currentPath` returns the current path in
 * the same `/outreach…` form. `onFinish` runs when the last step is completed.
 */
export function createTour(o: { navigate: (path: string) => void; currentPath: () => string; onFinish?: () => void; onChange?: () => void }): TourController {
  let drv: Driver | null = null;
  let running = false;
  let swapping = false;
  let token = 0;
  let index = 0;

  const destroy = () => { if (drv) { swapping = true; drv.destroy(); swapping = false; drv = null; } };

  const next = () => { if (index === TOUR_STEPS.length - 1) end('done'); else void show(index + 1); };
  const back = () => { if (index > 0) void show(index - 1); };

  // Driver's own keys are off (its ← has nowhere to go in a one-step Driver): these work while a step is still loading
  // too, and a held key does not race through the steps.
  const onKey = (e: KeyboardEvent) => {
    const k = tourKey(e);
    if (!k) return;
    e.preventDefault(); // no page scroll, and Enter on the focused popover button does not click it as well
    e.stopPropagation();
    if (e.repeat) return;
    if (k === 'close') end('skipped'); else if (k === 'next') next(); else back();
  };
  // The browser's Back button steps the tour back too: the tour pushed each step's page, so Back lands on the
  // previous step's page (on the first step it leaves the tour).
  const onPop = () => { if (index > 0) back(); else end('skipped'); };
  const listen = (on: boolean) => {
    const f = on ? window.addEventListener : window.removeEventListener;
    f('keydown', onKey as EventListener, true);
    f('popstate', onPop);
  };

  const end = (state: 'done' | 'skipped') => {
    if (running) listen(false);
    running = false;
    token++;
    writeTourState(state);
    destroy();
    if (state === 'done') o.onFinish?.();
    o.onChange?.();
  };

  async function show(i: number) {
    if (i < 0) i = 0;
    if (i >= TOUR_STEPS.length) { end('done'); return; }
    const my = ++token;
    index = i;
    const step = TOUR_STEPS[i];
    writeTourState(`step:${i}`);
    // the inbox remembers the visitor's filters (Unread, Mine, a channel…), which would leave only a few conversations
    // in the list: open it on All. The inbox reads them when it mounts, so this runs before navigating.
    if (step.route.startsWith('/outreach/inbox')) { try { kv.removeItem(filtersKey('inbox', DEMO_WS_ID)); } catch { /* storage blocked */ } }
    const path = step.route.split('?')[0];
    if (o.currentPath() !== path || step.route.includes('?')) o.navigate(step.route);
    // the target can also be on the page being left (the inbox list, a thread): wait for the new page first
    await until(() => o.currentPath() === path, 4000);
    if (my !== token || !running) return;
    if (step.click) {
      const target = await waitFor(step.click, 4000);
      if (my !== token || !running) return;
      (target as HTMLElement | null)?.click();
    }
    let el = await waitFor(step.element, 4000);
    if (my !== token || !running) return;
    // the canvas listens once its steps are on screen
    if (step.canvas && await waitFor('.react-flow__node', 4000)) {
      const id = await focusCanvas(step.canvas);
      if (my !== token || !running) return;
      if (id && step.canvas !== 'top') el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] ${step.element}`) ?? el;
    }
    if (el && !step.top && !step.canvas) bringIntoView(el as HTMLElement, step.side);
    destroy();
    const last = i === TOUR_STEPS.length - 1;
    drv = driver({
      allowClose: true,
      allowKeyboardControl: false,
      overlayClickBehavior: 'close',
      showProgress: true,
      smoothScroll: !step.top,
      stagePadding: 6,
      popoverClass: 'gxdemo-tour',
      onDestroyStarted: () => { if (swapping) { drv?.destroy(); return; } end('skipped'); },
      onNextClick: next,
      onPrevClick: back,
      steps: [{
        element: el ?? undefined,
        popover: {
          title: step.title,
          description: step.text,
          progressText: `${i + 1} of ${TOUR_STEPS.length}`,
          showButtons: i === 0 ? ['next', 'close'] : ['previous', 'next', 'close'],
          // each step is its own one-step Driver, which would grey out Back as having nowhere to go
          disableButtons: [],
          nextBtnText: last ? 'Finish' : 'Next',
          prevBtnText: 'Back',
          side: step.side ?? 'bottom',
          align: 'start',
        },
      }],
    });
    drv.drive();
    if (step.top && el) {
      // Driver scrolled the tall target to its top edge: put the page (and any scrolling parent) back at the top
      for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) if (p.scrollTop) p.scrollTop = 0;
      window.scrollTo(0, 0);
      requestAnimationFrame(() => drv?.refresh());
    }
  }

  return {
    start(at = 0) { if (!running) listen(true); running = true; o.onChange?.(); void show(at); },
    stop() { if (running) end('skipped'); },
    get running() { return running; },
  };
}
