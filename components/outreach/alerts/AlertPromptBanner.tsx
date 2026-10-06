'use client';

// The app's own prompt at the top of the inbox (reply-notifications-PRD.md §5.1, D3). The browser's permission prompt
// appears only from a click on **Turn on**. "Not now" comes back once, 7 days later; after the second it never returns
// (Settings → Notifications is the way in). Not shown when the browser already allowed or blocked notifications, cannot
// show them, or in the product tour.
import { useState } from 'react';
import { Bell, BellOff, X } from 'lucide-react';
import { Button } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { shouldShowPrompt, turnOnAlerts, useAlertSaver, useAlertSettings, useBrowserAlertState } from '@/lib/outreach/alerts';

export const BLOCKED_STEPS = 'Click the icon to the left of the address bar → Notifications → Allow, then reload the page.';

export default function AlertPromptBanner({ ws, userId, className }: { ws: string; userId: string | null; className?: string }) {
  const settings = useAlertSettings(ws);
  const browser = useBrowserAlertState(userId);
  const save = useAlertSaver(ws);
  const [withSound, setWithSound] = useState(true);
  const [state, setState] = useState<'idle' | 'busy' | 'blocked' | 'closed'>('idle');

  if (state === 'closed' || !userId) return null;
  if (state === 'blocked') {
    return (
      <div role="status" className={cn('mb-3 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3', className)}>
        <BellOff className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium text-amber-900">Notifications are blocked for this site in your browser.</div>
          <div className="text-amber-800 mt-0.5">{BLOCKED_STEPS}{withSound ? ' Sounds are on: they need no permission.' : ''}</div>
        </div>
        <button type="button" onClick={() => setState('closed')} className="p-0.5 text-amber-700 hover:text-amber-900" aria-label="Close"><X className="w-4 h-4" /></button>
      </div>
    );
  }
  if (!shouldShowPrompt(settings.data, browser)) return null;

  const turnOn = async () => {
    // the browser's prompt must come from this click: nothing is awaited before it
    setState('busy');
    const r = await turnOnAlerts({ userId, withSound, save });
    setState(r === 'denied' ? 'blocked' : 'closed');
  };
  const notNow = () => { setState('closed'); save({ prompt: 'dismissed' }).catch(() => undefined); };

  return (
    <div role="region" aria-label="Reply notifications" className={cn('mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-3', className)}>
      <Bell className="w-5 h-5 text-indigo-600 flex-shrink-0" />
      <div className="min-w-0 flex-[1_1_16rem]">
        <div className="text-sm font-medium text-gray-900">Know the moment someone replies</div>
        <div className="text-xs text-gray-600">Get a desktop notification and a sound when a prospect answers.</div>
      </div>
      <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
        <input type="checkbox" checked={withSound} onChange={(e) => setWithSound(e.target.checked)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
        Also play a sound
      </label>
      <div className="flex items-center gap-2 ml-auto">
        <Button size="sm" onClick={turnOn} loading={state === 'busy'}>Turn on</Button>
        <Button size="sm" variant="ghost" onClick={notNow} disabled={state === 'busy'}>Not now</Button>
      </div>
    </div>
  );
}
