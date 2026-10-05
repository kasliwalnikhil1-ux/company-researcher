'use client';

/** The welcome card on the tour's first screen (the Dashboard), once per session. */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/outreach/ui';
import { usePathname } from '@/lib/outreach/nav';
import { kv } from '@/lib/outreach/storage';
import { useDemo } from './DemoProvider';
import GrowthxLogo from './GrowthxLogo';
import { readTourState, tourKey } from './tour';

const KEY = 'welcome';

export default function DemoWelcome() {
  const pathname = usePathname();
  const { tour } = useDemo();
  // read once: the card shows on the first visit to the Dashboard in this session (client-only component)
  const [seen, setSeen] = useState(() => { try { return kv.getItem(KEY) === 'seen' || readTourState().kind !== 'idle'; } catch { return false; } });
  const open = !seen && pathname === '/outreach';
  const close = useCallback(() => { setSeen(true); try { kv.setItem(KEY, 'seen'); } catch { /* storage blocked */ } }, []);
  const start = useCallback(() => { close(); tour.start(); }, [close, tour]);
  // → ↓ Enter start the tour, Esc explores
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const k = tourKey(e);
      if (k !== 'next' && k !== 'close') return;
      e.preventDefault();
      if (!e.repeat) (k === 'next' ? start : close)();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, start, close]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="gxdemo-welcome-title">
      <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm" onClick={close} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <GrowthxLogo className="mb-5" />
        <h2 id="gxdemo-welcome-title" className="text-lg font-semibold text-gray-900">Your AI SDR</h2>
        <p className="text-sm text-gray-600 mt-2">Talks to prospects on your behalf and books meetings for you.</p>
        <div className="mt-6 flex flex-col sm:flex-row gap-2">
          <Button onClick={start} data-demo-start-tour>See how it works (1 min)</Button>
          <Button variant="ghost" onClick={close} data-demo-explore>Explore on my own</Button>
        </div>
      </div>
    </div>
  );
}
