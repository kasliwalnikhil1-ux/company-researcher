'use client';

/**
 * The product-tour shell: loads the demo backend (data, handlers, simulator) before any outreach screen renders,
 * hosts the demo bar, the welcome card, the fake external steps (connect, checkout, consent), the toasts and the
 * walkthrough. Rendered by app/outreach/layout.tsx only when `IS_DEMO` (the URL is /product-tour…).
 */
import './guard';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname as useBrowserPathname } from 'next/navigation';
import type { DemoRuntime } from '@/lib/outreach/backend/demo';
import { loadDemoBackend } from '@/lib/outreach/backend';
import { setDemoUi, type DemoDialog } from '@/lib/outreach/demoUi';
import { DEMO_PREFIX, leaveDemo } from '@/lib/outreach/mode';
import { usePathname, useRouter } from '@/lib/outreach/nav';
import { useAuth } from '@/contexts/AuthContext';
import { PageLoader } from '@/components/outreach/ui';
import DemoBar from './DemoBar';
import DemoWelcome from './DemoWelcome';
import DemoDialogs from './DemoDialogs';
import { createTour, type TourController } from './tour';
import type { SimMode } from '@/lib/outreach/backend/demo/sim/clock';

interface DemoCtx {
  runtime: DemoRuntime;
  mode: SimMode;
  day: number;
  setMode(m: SimMode): void;
  skipDay(): void;
  tour: TourController;
  tourRunning: boolean;
  reset(): void;
  /** "Start your outreach" (or "Back to my workspace" for a signed-in visitor): a full page load into /outreach. */
  cta(): void;
  ctaLabel: string;
}

const Ctx = createContext<DemoCtx | null>(null);
export function useDemo(): DemoCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDemo must be used inside DemoProvider');
  return c;
}

type Toast = { id: number; text: string; tone: 'info' | 'success' | 'error' };
type Pending = { d: DemoDialog; resolve: (ok: boolean) => void };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export default function DemoProvider({ children }: { children: React.ReactNode }) {
  const [runtime, setRuntime] = useState<DemoRuntime | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // what the bar shows of the simulator, refreshed on every tick or mode change
  const [simView, setSimView] = useState<{ mode: SimMode; day: number }>({ mode: 'on', day: 0 });
  const [tourRunning, setTourRunning] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const browserPath = useBrowserPathname();
  const { user } = useAuth();
  // the tour controller lives outside React: it reads the current router, path and CTA through refs
  const pathRef = useRef(pathname);
  const routerRef = useRef(router);
  const ctaRef = useRef<() => void>(() => {});
  useEffect(() => { pathRef.current = pathname; routerRef.current = router; }, [pathname, router]);

  // The demo and the product never share a page: if the URL left /product-tour without a full load, reload so the
  // provider in use always matches the URL.
  useEffect(() => {
    if (browserPath && !browserPath.startsWith(DEMO_PREFIX)) window.location.reload();
  }, [browserPath]);

  // UI bridge for the handlers: toasts and the fake external steps.
  useEffect(() => {
    let n = 0;
    setDemoUi({
      toast: (text, tone = 'info') => {
        const id = ++n;
        setToasts((t) => [...t.filter((x) => x.text !== text), { id, text, tone }].slice(-3));
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
      },
      dialog: (d) => new Promise<boolean>((resolve) => setPending({ d, resolve })),
    });
    return () => setDemoUi(null);
  }, []);

  useEffect(() => {
    let alive = true;
    loadDemoBackend()
      .then(() => import('@/lib/outreach/backend/demo'))
      .then((m) => {
        if (!alive) return;
        const rt = m.demoRuntime();
        rt.sim.start();
        setSimView({ mode: rt.sim.mode, day: rt.sim.day });
        // for the demo check (scripts/outreach-demo-check.mjs) and curious visitors: fictional data only
        (window as unknown as { __gxdemo?: unknown }).__gxdemo = { runtime: rt, backend: m.createDemoBackend(), notYet: m.notYetCalls };
        setRuntime(rt);
      })
      .catch((e) => { console.error(e); if (alive) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // The simulator moved time: refresh what is computed from it (the realtime channels already refresh the rest).
  useEffect(() => {
    if (!runtime) return;
    return runtime.sim.onTick(() => {
      setSimView({ mode: runtime.sim.mode, day: runtime.sim.day });
      qc.invalidateQueries({ predicate: (q) => {
        const k = q.queryKey as unknown[];
        return k[0] === 'outreach' && (k.includes('dashboard') || k.includes('reports') || k.includes('report') || k.includes('needs-you') || k.includes('senders') || k.includes('tasks'));
      } });
    });
  }, [runtime, qc]);

  // Changes the product has no realtime binding for (a lead finishing enrichment in the background): refresh the lead
  // screens, at most once a second. Demo only: in the product these come back on the next fetch.
  useEffect(() => {
    if (!runtime) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const leads = new Set<string>();
    const off = runtime.store.subscribe((e) => {
      if (e.table !== 'outreach_leads' || e.eventType !== 'UPDATE' || !e.new?.id) return;
      leads.add(String(e.new.id));
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const id of leads) qc.invalidateQueries({ queryKey: ['outreach', 'lead', id] });
        leads.clear();
        qc.invalidateQueries({ queryKey: ['outreach', runtime.ctx.ws, 'leads'] });
      }, 1000);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [runtime, qc]);

  const signedIn = !!user;
  const cta = useCallback(() => leaveDemo(signedIn ? '/outreach' : '/outreach?from=product-tour'), [signedIn]);
  useEffect(() => { ctaRef.current = cta; }, [cta]);

  // The refs are read only inside the controller's callbacks (navigation, clicks), never while rendering.
  // eslint-disable-next-line react-hooks/refs
  const [tour] = useState<TourController>(() => {
    const t: TourController = createTour({
      navigate: (p) => routerRef.current.push(p),
      currentPath: () => pathRef.current,
      onCta: () => ctaRef.current(),
      onChange: () => setTourRunning(t.running),
    });
    return t;
  });

  const reset = useCallback(() => {
    if (!runtime) return;
    tour.stop();
    runtime.reset();
    // stay on the page when what it shows still exists, else the dashboard
    const ids = window.location.pathname.match(UUID) ?? [];
    const exists = (id: string) => Object.values(runtime.store.state.tables).some((rows) => rows.some((r) => r.id === id));
    const target = ids.every(exists) ? window.location.pathname + window.location.search : DEMO_PREFIX;
    window.location.replace(target);
  }, [runtime, tour]);

  const value = useMemo<DemoCtx | null>(() => runtime && {
    runtime,
    mode: simView.mode,
    day: simView.day,
    setMode: (m) => { runtime.sim.setMode(m); setSimView({ mode: runtime.sim.mode, day: runtime.sim.day }); },
    skipDay: () => { runtime.sim.skipDay(); runtime.ctx.ui.toast('Skipped ahead one day.', 'success'); },
    tour,
    tourRunning,
    reset,
    cta,
    ctaLabel: signedIn ? 'Back to my workspace' : 'Start your outreach',
  }, [runtime, reset, cta, signedIn, simView, tour, tourRunning]);

  if (failed) {
    return <div className="p-8 text-sm text-red-700">The demo could not start: {failed}</div>;
  }
  if (!value) {
    return (
      <>
        <DemoBar.Placeholder />
        <PageLoader className="min-h-screen" />
      </>
    );
  }
  return (
    <Ctx.Provider value={value}>
      <DemoBar />
      {children}
      <DemoWelcome />
      <DemoDialogs pending={pending} onDone={(ok) => { pending?.resolve(ok); setPending(null); }} />
      <div className="fixed bottom-4 left-4 z-[70] flex flex-col gap-2 pointer-events-none" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto px-3.5 py-2.5 rounded-lg shadow-lg text-sm max-w-sm ${t.tone === 'error' ? 'bg-red-600 text-white' : t.tone === 'success' ? 'bg-emerald-600 text-white' : 'bg-gray-900 text-white'}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
