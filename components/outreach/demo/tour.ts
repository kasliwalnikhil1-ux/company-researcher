/**
 * The product-tour walkthrough (Driver.js): eight steps across pages. The controller navigates to a step's page, waits
 * up to 4 s for its `[data-tour="…"]` target and highlights it; a target that never appears (a narrow screen) gets a
 * centred popover instead. Skippable at every step (Close, Esc, a click on the overlay), with Back.
 *
 * State: `gxdemo:tour` = `step:<n>` | `done` | `skipped`. The tour starts only from the welcome card or "Restart tour",
 * never by itself on a later visit. After it ends the whole product stays open.
 */
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { DEMO_TOUR_SEQUENCE_ID } from '@/lib/outreach/demoIds';
import { kv } from '@/lib/outreach/storage';

/**
 * `canvas`: zoom the sequence canvas first: onto the top of the flow (`top`) or onto the topmost step of that type.
 * `side`: where the popover sits (default below the target).
 */
export interface TourStep { route: string; element: string; title: string; text: string; canvas?: 'top' | 'send_message'; side?: 'right' | 'bottom' }

export const TOUR_STEPS: TourStep[] = [
  { route: '/outreach', element: '[data-tour="dashboard-stats"]', title: 'A live workspace', text: "This is a live workspace with sample data. Here's the whole flow in a minute." },
  { route: '/outreach/senders', element: '[data-tour="sender-channels"]', title: 'Senders', text: 'Connect LinkedIn, email, WhatsApp or Instagram accounts. Each one has its own safe daily limits.' },
  { route: '/outreach/leads', element: '[data-tour="leads-table"]', title: 'Leads', text: 'Bring in prospects from a CSV, a LinkedIn search or by hand.' },
  { route: `/outreach/sequences/${DEMO_TOUR_SEQUENCE_ID}`, element: '[data-tour="builder-canvas"]', title: 'Sequences', text: 'Build the steps: visit, connect, message, follow up, branch on replies.', canvas: 'top' },
  { route: `/outreach/sequences/${DEMO_TOUR_SEQUENCE_ID}`, element: '[data-tour="builder-message-step"]', title: 'Personalisation', text: 'Personalise every message with variables and AI lines.', canvas: 'send_message' },
  { route: `/outreach/sequences/${DEMO_TOUR_SEQUENCE_ID}`, element: '[data-tour="sequence-start"]', title: 'Start it', text: 'Start it and leads move through on their own. In this demo the activity is simulated.' },
  { route: '/outreach/inbox', element: '[data-tour="inbox-list"]', title: 'One inbox', side: 'right', text: 'Replies from every channel land here. Answer them, or let AI draft.' },
  { route: '/outreach/reports?tab=funnel', element: '[data-tour="reports-funnel"]', title: 'Reports', text: 'See what works: accepted, replied, interested, meetings.' },
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

export interface TourController {
  start(): void;
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

  const destroy = () => { if (drv) { swapping = true; drv.destroy(); swapping = false; drv = null; } };

  const end = (state: 'done' | 'skipped') => {
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
    const step = TOUR_STEPS[i];
    writeTourState(`step:${i}`);
    if (o.currentPath() !== step.route.split('?')[0] || step.route.includes('?')) o.navigate(step.route);
    let el = await waitFor(step.element, 4000);
    if (my !== token || !running) return;
    // the canvas listens once its steps are on screen
    if (step.canvas && await waitFor('.react-flow__node', 4000)) {
      const id = await focusCanvas(step.canvas);
      if (my !== token || !running) return;
      if (id && step.canvas !== 'top') el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] ${step.element}`) ?? el;
    }
    destroy();
    const last = i === TOUR_STEPS.length - 1;
    drv = driver({
      allowClose: true,
      overlayClickBehavior: 'close',
      showProgress: true,
      smoothScroll: true,
      stagePadding: 6,
      popoverClass: 'gxdemo-tour',
      onDestroyStarted: () => { if (swapping) { drv?.destroy(); return; } end('skipped'); },
      onNextClick: () => { if (last) end('done'); else void show(i + 1); },
      onPrevClick: () => { void show(i - 1); },
      steps: [{
        element: el ?? undefined,
        popover: {
          title: step.title,
          description: step.text,
          progressText: `${i + 1} of ${TOUR_STEPS.length}`,
          showButtons: i === 0 ? ['next', 'close'] : ['previous', 'next', 'close'],
          nextBtnText: last ? 'Keep exploring' : 'Next',
          prevBtnText: 'Back',
          side: step.side ?? 'bottom',
          align: 'start',
        },
      }],
    });
    drv.drive();
  }

  return {
    start() { running = true; o.onChange?.(); void show(0); },
    stop() { if (running) end('skipped'); },
    get running() { return running; },
  };
}
