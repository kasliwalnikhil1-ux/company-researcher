'use client';

import Link from 'next/link';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { usePoolV2 } from '@/lib/outreach/aiRepliesSequence';
import { nextMonthStart } from './format';

/** Top of Settings → AI replies: what the modes mean, where they are set, the monthly AI allowance, and a read-only notice for members. */
export default function AiRepliesIntro({ ws }: { ws: string }) {
  const { isManager } = useWorkspace();
  const pool = usePoolV2(ws);
  const p = pool.data;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
        <Sparkles className="w-4 h-4 text-indigo-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="text-sm text-gray-700 space-y-1">
          <p>AI Auto Replies are set per sequence: open a sequence and use its <strong className="text-gray-900">AI Auto Replies</strong> tab for the mode, the prompt, scenarios, knowledge and limits. <Link href="/outreach/sequences" className="text-indigo-700 underline underline-offset-2">Go to sequences</Link>.</p>
          <p><strong className="text-gray-900">Draft</strong> leaves an AI reply in the inbox for a person to send. <strong className="text-gray-900">Auto</strong> sends it after a short hold and hands over when a meeting is on the table; it needs the sender owner&apos;s approval, once per account.</p>
          <p>This page holds what is shared across sequences: the per-sender daily cap, library prompts, approvals, the activity log and reports.</p>
        </div>
      </div>
      {p && !p.ok && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            This month&apos;s AI allowance is used up. Drafts pause until {nextMonthStart(p.month)}.
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
