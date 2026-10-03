'use client';

/**
 * The bar above the product tour, on every screen: "Demo", simulated activity, restart tour
 * and the "Start your outreach" CTA. Fixed, 40 px, never dismissible.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, FastForward, Pause, Play, RotateCcw, SkipForward, Zap } from 'lucide-react';
import { useDemo } from './DemoProvider';

const MODES = [
  { key: 'on', label: 'On', icon: Play },
  { key: 'fast', label: 'Fast', icon: FastForward },
  { key: 'paused', label: 'Paused', icon: Pause },
] as const;

function Label() {
  return (
    <span className="flex items-center gap-2 font-medium whitespace-nowrap" data-demo-label>
      <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" /><span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" /></span>
      Demo
    </span>
  );
}

function Placeholder() {
  return <div className="fixed top-0 inset-x-0 z-[60] h-10 bg-gray-900 text-white text-sm flex items-center px-4"><Label /></div>;
}

function SimMenu() {
  const { mode, setMode, skipDay, day, tour } = useDemo();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  const current = MODES.find((m) => m.key === mode) ?? MODES[0];
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/10 whitespace-nowrap" title="The demo moves time forward and simulates sending and replies">
        <Zap className="w-3.5 h-3.5 text-amber-300" /> <span className="hidden sm:inline">Simulate activity:</span> {current.label}
        {day > 0 && <span className="hidden lg:inline text-gray-400">· day +{day}</span>}
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div role="menu" className="fixed top-11 inset-x-3 sm:absolute sm:top-full sm:inset-x-auto sm:left-0 sm:mt-1 sm:w-56 bg-white text-gray-800 rounded-lg shadow-xl border border-gray-200 py-1">
          <div className="sm:hidden px-3 pt-1.5 pb-1 text-xs font-medium text-gray-500">
            Simulate activity{day > 0 && <span className="text-gray-400"> · day +{day}</span>}
          </div>
          {MODES.map((m) => (
            <button key={m.key} role="menuitemradio" aria-checked={mode === m.key} type="button" onClick={() => { setMode(m.key); setOpen(false); }} className={`w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm hover:bg-gray-50 ${mode === m.key ? 'font-semibold text-indigo-700' : ''}`}>
              <m.icon className="w-4 h-4" /> {m.label}
              <span className="ml-auto text-xs text-gray-400 whitespace-nowrap">{m.key === 'on' ? '2 h every 4 s' : m.key === 'fast' ? '8 h every 4 s' : 'stopped'}</span>
            </button>
          ))}
          <div className="border-t border-gray-100 my-1" />
          <button role="menuitem" type="button" onClick={() => { skipDay(); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm hover:bg-gray-50">
            <SkipForward className="w-4 h-4" /> Skip a day
          </button>
          <div className="sm:hidden">
            <div className="border-t border-gray-100 my-1" />
            <button role="menuitem" type="button" onClick={() => { setOpen(false); tour.start(); }} className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-gray-50">
              <RotateCcw className="w-4 h-4" /> Restart tour
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DemoBar() {
  const { tour, cta, ctaLabel } = useDemo();
  return (
    <>
      <div className="fixed top-0 inset-x-0 z-[60] h-10 bg-gray-900 text-white text-sm flex items-center gap-1 sm:gap-3 px-3 sm:px-4" role="region" aria-label="Product tour">
        <Label />
        <div className="hidden md:block w-px h-5 bg-white/20" />
        <SimMenu />
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <button type="button" onClick={() => tour.start()} className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/10 whitespace-nowrap" data-demo-restart-tour>
            <RotateCcw className="w-3.5 h-3.5" /> Restart tour
          </button>
          <button type="button" onClick={cta} className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-indigo-500 hover:bg-indigo-400 font-semibold whitespace-nowrap" data-demo-cta>
            <span className="hidden sm:inline">{ctaLabel}</span><span className="sm:hidden">Start</span> <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </>
  );
}

DemoBar.Placeholder = Placeholder;
