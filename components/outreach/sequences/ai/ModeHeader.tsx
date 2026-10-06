'use client';

// "Mode  [ Off | Review | Auto ]" (under the tab's "AI replies" page heading) plus the notices that explain what will really happen (changes doc §4.1).
import { useState, type ReactNode } from 'react';
import Link from '@/lib/outreach/nav';
import { AlertTriangle, Clock, Info } from 'lucide-react';
import type { ReplyMode } from '@/lib/outreach/aiReplies';
import { MODES, MODE_LABEL_V2, useSetSequenceAiReplies, type AiRepliesSetResult, type SequenceAiSettings } from '@/lib/outreach/aiRepliesSequence';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { usePlanFeature } from '@/lib/outreach/billing';
import { Button, Modal, Textarea, fmtDate } from '@/components/outreach/ui';
import { UpgradeNote } from '@/components/outreach/PlanGate';
import { Note } from '@/components/outreach/settings/shared';
import { InfoTip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import { MODE_LINE, hubHref, useNeedsYouCount } from '@/lib/outreach/aiHub';
import { errText } from './shared';

// the same line per mode as everywhere else in the app (AI hub)
const MODE_HELP: Record<ReplyMode, string> = { off: MODE_LINE.reply.off, draft: MODE_LINE.reply.review, autopilot: MODE_LINE.reply.auto };

const WARMUP_TIP = 'Warm-up: when Auto is new on a sequence, each of the first 20 AI replies waits 30–40 minutes before it is sent. The assigned teammate can send it now, edit it or cancel it from the conversation in the Inbox.';

function statusReason(s: SequenceAiSettings): string | null {
  if (s.mode === 'off' || s.sequence_status === 'active') return null;
  if (s.sequence_status === 'paused') return 'AI replies are drafts while the sequence is paused.';
  if (s.sequence_status === 'archived') return 'AI replies are drafts while the sequence is archived.';
  return 'AI replies are drafts until the sequence is live.';
}

export default function ModeHeader({ sequenceId, s, canEdit, notify, actions }: {
  sequenceId: string; s: SequenceAiSettings; canEdit: boolean; notify: (m: string, t?: 'success' | 'error') => void;
  /** Buttons for the card's footer row (Test a conversation). */
  actions?: ReactNode;
}) {
  const set = useSetSequenceAiReplies(sequenceId);
  const { workspace } = useWorkspace();
  // Auto belongs to Scale (billing v2). Review and Off work on every plan.
  const auto = usePlanFeature(workspace?.id, 'ai_auto_reply');
  const locked = (m: ReplyMode) => m === 'autopilot' && !auto.enabled && s.mode !== 'autopilot';
  const [noteFor, setNoteFor] = useState<ReplyMode | null>(null);
  const [note, setNote] = useState('');

  async function apply(mode: ReplyMode, withNote: string | null) {
    try {
      const r: AiRepliesSetResult = await set.mutateAsync({ patch: { mode }, note: withNote });
      setNoteFor(null); setNote('');
      const applies = r.settings?.applies_to ?? s.open_conversations;
      notify(`${MODE_LABEL_V2[mode]} is on. Applies to the next reply in ${applies} open ${applies === 1 ? 'conversation' : 'conversations'}.`);
    } catch (e) { notify(errText(e), 'error'); }
  }

  const pick = (mode: ReplyMode) => {
    if (!canEdit || mode === s.mode || locked(mode)) return;
    if (mode === 'autopilot' && s.downgraded_at) { setNoteFor(mode); return; }
    void apply(mode, null);
  };

  const reason = statusReason(s);
  // "5 replies need you": the cards of this sequence in AI → Needs you
  const waiting = useNeedsYouCount(workspace?.id, 'reply', sequenceId).data ?? 0;

  return (
    <section className="bg-white border border-gray-200 rounded-xl">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        {/* the page heading above the card names the feature; the card opens with the switch and what the mode does */}
        <div className="min-w-0 flex-[1_1_18rem]">
          <h3 className="text-sm font-semibold text-gray-900">Mode</h3>
          <p className="text-xs text-gray-500 mt-0.5"><span className="font-medium text-gray-700">{MODE_LABEL_V2[s.mode]}:</span> {MODE_HELP[s.mode]}</p>
        </div>
        <div role="radiogroup" aria-label="AI replies mode" className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 flex-shrink-0">
          {MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={s.mode === m} disabled={!canEdit || set.isPending || locked(m)} onClick={() => pick(m)} title={MODE_HELP[m]}
              className={cn('px-3.5 py-1 text-sm rounded-md transition-colors', s.mode === m ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50', !canEdit && 'cursor-default', locked(m) && 'opacity-50 cursor-not-allowed hover:bg-transparent')}>
              {MODE_LABEL_V2[m]}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-gray-100 px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {waiting > 0 && <Link href={hubHref.needsYou({ type: 'reply', where: sequenceId, mine: false })} className="text-sm font-medium text-indigo-700 hover:underline whitespace-nowrap">{waiting.toLocaleString()} {waiting === 1 ? 'reply needs' : 'replies need'} you</Link>}
        {actions}
      </div>
      <UpgradeNote feature="ai_auto_reply" what="Auto mode" />

      {reason && (
        <Note tone="amber" className="flex items-start gap-2"><Info className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" /><span>{reason}</span></Note>
      )}
      {s.mode === 'autopilot' && s.warmup_remaining > 0 && (
        <Note tone="indigo" className="flex items-start gap-2"><Clock className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" /><span><InfoTip text={WARMUP_TIP}>First 20 replies wait 30 min so you can check them</InfoTip> ({s.warmup_remaining} left).</span></Note>
      )}
      {s.downgraded_at && s.downgrade_reason === 'plan' && (
        <Note tone="amber" className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>Auto was switched to Review because the plan no longer includes it; upgrading puts it back.</span>
        </Note>
      )}
      {s.downgraded_at && s.downgrade_reason !== 'plan' && (
        <Note tone="amber" className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>Auto was switched off on {fmtDate(s.downgraded_at, false)}{s.downgrade_reason ? `: ${s.downgrade_reason}` : ''}. Switching it back on asks for a note.</span>
        </Note>
      )}
      {!canEdit && <p className="text-xs text-gray-500">You can read these settings. Owners and managers can change them.</p>}
      </div>

      <Modal open={noteFor !== null} onClose={() => setNoteFor(null)} title="Switch Auto back on" size="sm"
        footer={<><Button variant="secondary" onClick={() => setNoteFor(null)} disabled={set.isPending}>Cancel</Button><Button loading={set.isPending} disabled={note.trim().length < 3} onClick={() => noteFor && apply(noteFor, note.trim())}>Turn Auto on</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-700">Auto was switched off automatically{s.downgrade_reason ? ` (${s.downgrade_reason})` : ''}. Say in a line why it can go back on. The note is kept in the audit log.</p>
          <Textarea label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Fixed the pricing facts, checked 10 drafts" className="min-h-0" />
        </div>
      </Modal>
    </section>
  );
}
