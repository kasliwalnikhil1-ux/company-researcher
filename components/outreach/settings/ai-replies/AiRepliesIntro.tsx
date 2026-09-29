'use client';

import { AlertTriangle, Sparkles } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { usePool } from '@/lib/outreach/aiReplies';
import { nextMonthStart } from './format';

/** Top of Settings → AI replies: what the two modes mean, the monthly AI allowance, and a read-only notice for members. */
export default function AiRepliesIntro({ ws }: { ws: string }) {
  const { isManager } = useWorkspace();
  const pool = usePool(ws);
  const p = pool.data;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
        <Sparkles className="w-4 h-4 text-indigo-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="text-sm text-gray-700 space-y-1">
          <p><strong className="text-gray-900">Draft</strong> — the AI writes a reply to each new message on LinkedIn and leaves it in the inbox composer; a person reads it and sends it.</p>
          <p><strong className="text-gray-900">Autopilot</strong> — the AI sends the reply itself after a short hold, and hands the chat to a person when your master prompt or the safety rules say so. It needs the sender owner&apos;s consent and a prompt that has passed graduation.</p>
        </div>
      </div>
      {p && !p.ok && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            This month&apos;s AI allowance is used up — drafts pause until {nextMonthStart(p.month)}.
            {p.limit != null && <> ({p.used.toLocaleString()} of {p.limit.toLocaleString()} used.)</>}
          </span>
        </div>
      )}
      {!isManager && (
        <p className="text-xs text-gray-500">You can view these settings. Owners and managers can change them.</p>
      )}
    </div>
  );
}
