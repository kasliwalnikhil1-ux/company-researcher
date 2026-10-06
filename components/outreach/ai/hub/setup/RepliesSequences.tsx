'use client';

// AI → Setup → AI replies → Sequences: every sequence with its AI replies mode, switchable inline.
// The switch does what the mode header of a sequence's AI tab does (components/outreach/sequences/ai/ModeHeader.tsx):
// the same call, the plan gate on Auto, the note after an automatic switch-off and the consent requests that come back.
import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock, GitBranch, Info, type LucideIcon } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { usePlanFeature } from '@/lib/outreach/billing';
import { useSetSequenceAiReplies, type AiRepliesSetResult } from '@/lib/outreach/aiRepliesSequence';
import {
  HUB_MODE_LABEL, MODE_LINE, hk, hubHref, hubToReplyMode, replyToHubMode, useHubSetup, useInvalidateHub,
  type HubMode, type HubSetup, type HubSetupSequence,
} from '@/lib/outreach/aiHub';
import ModeSwitch from '@/components/outreach/ai/hub/ModeSwitch';
import { UpgradeNote } from '@/components/outreach/PlanGate';
import { STATUS_TONE } from '@/components/outreach/sequences/helpers';
import { errText } from '@/components/outreach/sequences/ai/shared';
import { Badge, Button, EmptyState, ErrorBox, Modal, Spinner, Table, Td, Textarea, Th, fmtDate } from '@/components/outreach/ui';
import { LinkButton, ModeLegend, NeedsYouLink, plural } from './parts';

type Notify = (m: string, t?: 'success' | 'error') => void;

/** Auto only really sends on a live sequence. */
function statusNote(s: HubSetupSequence): string | null {
  if (s.mode !== 'autopilot' || s.status === 'active') return null;
  if (s.status === 'paused') return 'Works as Review while the sequence is paused.';
  if (s.status === 'archived') return 'Works as Review while the sequence is archived.';
  return 'Works as Review until the sequence is live.';
}

function RowNote({ icon: Icon, tone = 'gray', children }: { icon: LucideIcon; tone?: 'gray' | 'amber' | 'indigo'; children: React.ReactNode }) {
  const tones = { gray: 'text-gray-500', amber: 'text-amber-700', indigo: 'text-indigo-700' };
  return <p className={`flex items-start gap-1 text-xs mt-1 max-w-xs ${tones[tone]}`}><Icon className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden="true" /><span>{children}</span></p>;
}

/** One sequence. A row of its own so each has its own mutation (and its own busy state). */
function SequenceRow({ ws, s, canEdit, autoLock, notify }: { ws: string; s: HubSetupSequence; canEdit: boolean; autoLock: string | null; notify: Notify }) {
  const set = useSetSequenceAiReplies(s.id);
  const qc = useQueryClient();
  const invalidate = useInvalidateHub(ws);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const mode = replyToHubMode(s.mode);
  const warmup = s.warmup_remaining ?? 0;

  async function apply(next: HubMode, withNote: string | null) {
    try {
      const r: AiRepliesSetResult = await set.mutateAsync({ patch: { mode: hubToReplyMode(next) }, note: withNote });
      setNoteOpen(false); setNote('');
      const st = r?.settings;
      // show the new mode at once; the refetch brings the rest (counts, other screens)
      qc.setQueryData<HubSetup>(hk.setup(ws), (old) => (old ? {
        ...old,
        sequences: (old.sequences ?? []).map((x) => (x.id !== s.id ? x : {
          ...x, mode: st?.mode ?? hubToReplyMode(next), warmup_remaining: st?.warmup_remaining ?? x.warmup_remaining,
          downgraded_at: st ? st.downgraded_at ?? null : x.downgraded_at, downgrade_reason: st ? st.downgrade_reason ?? null : x.downgrade_reason,
        })),
      } : old));
      invalidate();

      const applies = st?.applies_to ?? st?.open_conversations;
      // one toast: several in a row would replace each other
      notify([
        next === 'off' ? `AI replies are off for ${s.name}.` : `${s.name} is on ${HUB_MODE_LABEL[next]}.`,
        applies != null ? `It applies to the next reply in ${applies} open ${plural(applies, 'conversation')}.` : '',
      ].filter(Boolean).join(' '));
    } catch (e) { notify(errText(e), 'error'); }
  }

  const pick = (next: HubMode) => {
    if (!canEdit || next === mode || (next === 'auto' && autoLock)) return;
    // Auto was switched off by the app: going back needs a line saying why (kept in the audit log)
    if (next === 'auto' && s.downgraded_at) { setNote(''); setNoteOpen(true); return; }
    void apply(next, null);
  };

  const status = statusNote(s);
  return (
    <tr>
      <Td className="max-w-[280px] align-top">
        <Link href={`/outreach/sequences/${s.id}?tab=ai`} title="Open the sequence's AI tab: prompt and limits" className="block truncate font-medium text-gray-900 hover:text-indigo-700 hover:underline">{s.name}</Link>
      </Td>
      <Td className="align-top"><Badge tone={STATUS_TONE[s.status] ?? 'gray'} className="capitalize">{s.status}</Badge></Td>
      <Td className="align-top">
        <ModeSwitch compact value={mode} onChange={pick} lines={MODE_LINE.reply} locked={autoLock ? { auto: autoLock } : undefined}
          disabled={!canEdit} busy={set.isPending} label={`AI replies mode for ${s.name}`} />
        {mode === 'auto' && warmup > 0 && <RowNote icon={Clock} tone="indigo">Warm-up: the first replies wait 30 min so you can check them ({warmup} left).</RowNote>}
        {status && <RowNote icon={Info}>{status}</RowNote>}
        {s.downgraded_at && (s.downgrade_reason === 'plan'
          ? <RowNote icon={AlertTriangle} tone="amber">Auto was switched to Review because the plan no longer includes it. Upgrading puts it back.</RowNote>
          : <RowNote icon={AlertTriangle} tone="amber">Auto was switched off on {fmtDate(s.downgraded_at, false)}{s.downgrade_reason ? `: ${s.downgrade_reason}` : ''}. Switching it back on asks for a note.</RowNote>)}

        <Modal open={noteOpen} onClose={() => setNoteOpen(false)} title="Switch Auto back on" size="sm"
          footer={<><Button variant="secondary" onClick={() => setNoteOpen(false)} disabled={set.isPending}>Cancel</Button><Button loading={set.isPending} disabled={note.trim().length < 3} onClick={() => apply('auto', note.trim())}>Turn Auto on</Button></>}>
          <div className="space-y-3">
            <p className="text-sm text-gray-700">Auto was switched off automatically for {s.name}{s.downgrade_reason ? ` (${s.downgrade_reason})` : ''}. Say in a line why it can go back on. The note is kept in the audit log.</p>
            <Textarea label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Fixed the pricing facts, checked 10 drafts" className="min-h-0" />
          </div>
        </Modal>
      </Td>
      <Td className="align-top"><NeedsYouLink n={s.waiting} href={hubHref.needsYou({ type: 'reply', where: s.id, mine: false })} /></Td>
    </tr>
  );
}

export default function RepliesSequences({ ws, notify }: { ws: string; notify: Notify }) {
  const { isManager, canWrite } = useWorkspace();
  const q = useHubSetup(ws);
  // Auto belongs to a higher plan (billing v2). Review and Off work on every plan.
  const auto = usePlanFeature(ws, 'ai_auto_reply');
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={parseError(q.error).message} />;

  const rows = q.data?.sequences ?? [];
  if (rows.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl">
        <EmptyState icon={<GitBranch className="w-6 h-6" />} title="No sequences yet"
          description="AI replies are switched on per sequence. Create a sequence first, then pick its mode here or on its AI tab."
          action={<LinkButton href="/outreach/sequences">Open sequences</LinkButton>} />
      </div>
    );
  }

  const canEdit = isManager && canWrite;
  const autoLock = auto.enabled ? null : `Auto is available on ${auto.minPlanLabel || 'a higher plan'}.`;
  return (
    <div className="space-y-3">
      <UpgradeNote feature="ai_auto_reply" what="Auto mode" />
      <Table>
        <thead><tr><Th>Sequence</Th><Th>Status</Th><Th>Mode</Th><Th>Needs you</Th></tr></thead>
        <tbody>{rows.map((s) => <SequenceRow key={s.id} ws={ws} s={s} canEdit={canEdit} autoLock={autoLock} notify={notify} />)}</tbody>
      </Table>
      <ModeLegend lines={MODE_LINE.reply} />
      {!canEdit && <p className="text-xs text-gray-500">{isManager ? 'This workspace is read-only, so the modes cannot be changed right now.' : 'You can read these settings. Owners and managers can change them.'}</p>}
    </div>
  );
}
