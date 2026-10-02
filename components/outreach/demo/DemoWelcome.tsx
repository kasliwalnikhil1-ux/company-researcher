'use client';

/** The welcome card on the tour's first screen (the Dashboard), once per session. */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/outreach/ui';
import { usePathname } from '@/lib/outreach/nav';
import { kv } from '@/lib/outreach/storage';
import { useDemo } from './DemoProvider';
import { readTourState } from './tour';

const KEY = 'welcome';

export default function DemoWelcome() {
  const pathname = usePathname();
  const { tour } = useDemo();
  // read once: the card shows on the first visit to the Dashboard in this session (client-only component)
  const [seen, setSeen] = useState(() => { try { return kv.getItem(KEY) === 'seen' || readTourState().kind !== 'idle'; } catch { return false; } });
  if (seen || pathname !== '/outreach') return null;
  const close = () => { setSeen(true); try { kv.setItem(KEY, 'seen'); } catch { /* storage blocked */ } };
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="gxdemo-welcome-title">
      <div className="absolute inset-0 bg-gray-900/50" onClick={close} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-4"><Sparkles className="w-5 h-5" /></div>
        <h2 id="gxdemo-welcome-title" className="text-lg font-semibold text-gray-900">Explore GrowthxAI with sample data</h2>
        <p className="text-sm text-gray-600 mt-2">Everything here is fictional. No messages are sent and nothing is saved to an account.</p>
        <div className="mt-6 flex flex-col sm:flex-row gap-2">
          <Button onClick={() => { close(); tour.start(); }} data-demo-start-tour>Take the 1-minute tour</Button>
          <Button variant="ghost" onClick={close} data-demo-explore>Explore on my own</Button>
        </div>
      </div>
    </div>
  );
}
