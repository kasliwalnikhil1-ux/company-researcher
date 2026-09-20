'use client';

// Forms for the steps added by the product plan: refresh profile, follow, find email, call task, voice note, A/B split.
import { useEffect } from 'react';
import Link from 'next/link';
import { Plus, Trash2 } from 'lucide-react';
import { normalizeNode } from '@/lib/outreach/graph';
import { syncNodeBranches } from '@/lib/outreach/nodes';
import type { AbBranch } from '@/lib/outreach/types';
import { Button, Input, Toggle } from '@/components/outreach/ui';
import TemplateField from './TemplateField';
import VariantResults from './VariantResults';
import VoiceClipRecorder from './VoiceClipRecorder';
import { normalisedPercents } from './VariantEditor';
import { Callout, Note } from './FormsShared';
import { useBuilder } from './context';
import type { FormProps } from './FormsOutreach';

export function RefreshProfileForm({ cfg, set }: FormProps) {
  const days = Number(cfg.only_if_stale_days ?? 90) || 90;
  return (
    <div className="space-y-3">
      <Input type="number" min={1} max={730} label="Only if the stored profile is older than (days)" value={days} onChange={(e) => set('only_if_stale_days', Math.min(730, Math.max(1, Math.round(Number(e.target.value)) || 90)))} hint="90 days is a good default. Use 1 to refresh every lead." />
      <Note>Reads the full profile again (about, experience, education, skills, languages) and stores it for conditions, variables and AI lines. Leads refreshed in the last {days} day{days === 1 ? '' : 's'} are skipped at no cost. A lead that was never read is always refreshed.</Note>
      <Note>The visit is silent and counts as one profile view in the sender&apos;s daily budget.</Note>
    </div>
  );
}

export function FollowProfileForm() {
  return (
    <div className="space-y-2">
      <Note>Follows the lead from the sender&apos;s LinkedIn account. A light touch before an invitation: the lead gets a notification, and the sender starts seeing their posts.</Note>
      <Note>Follows have their own daily budget and warm-up. Leads the sender already follows are skipped.</Note>
    </div>
  );
}

export function FindEmailForm() {
  return (
    <div className="space-y-2">
      <Note>Looks up a work email and saves it on the lead. It uses your own provider keys, tried in order, and stops at the first hit. We do not resell data.</Note>
      <Callout>Add one or two finder keys and a verifier under <Link href="/outreach/settings/ai" className="underline font-medium">Settings → AI &amp; data</Link>. Without a key, every lead takes the not found exit.</Callout>
      <ul className="text-xs text-gray-600 space-y-1 list-disc pl-4">
        <li><span className="font-medium">Found</span>: an email was saved. Put your email step here.</li>
        <li><span className="font-medium">Not found</span>: no provider had one, or the lead has no company to search by. Continue on LinkedIn.</li>
      </ul>
      <Note>Leads that already have a verified email go straight to found, so no lookup is spent on them. No LinkedIn activity is involved.</Note>
    </div>
  );
}

export function CallTaskForm({ node, cfg, set, update }: FormProps) {
  // The engine reads the fallback from node.next and treats an empty outcome key as "end here": keep the node in that shape.
  const { readOnly } = useBuilder();
  useEffect(() => {
    if (readOnly) return;
    const fixed = normalizeNode(node);
    if (fixed !== node) update(fixed);
  }, [node, update, readOnly]);
  return (
    <div className="space-y-3">
      <TemplateField label="Task title" value={cfg.title ?? ''} onChange={(v) => set('title', v)} multiline={false} max={200} placeholder="Call {{first_name}} at {{company}}" plain />
      <TemplateField label="Call script" value={cfg.script ?? ''} onChange={(v) => set('script', v)} rows={6} placeholder={'Hi {{first_name|there}}, this is {{sender.first_name}}. I sent you a note on LinkedIn about…'} hint="Shown to the teammate who makes the call, with the phone number on file." />
      <Note>Creates a call task. The lead waits until a teammate picks an outcome: connected, voicemail, no answer or wrong number.</Note>
      <Note>Each outcome is an exit on the canvas. An outcome with nothing connected follows the <span className="font-medium">any other outcome</span> exit. Outcomes can also be used later in a condition (“Last call outcome”).</Note>
      <Callout>Add a condition on “Has phone number” before this step if some leads have no number on file.</Callout>
    </div>
  );
}

export function SendVoiceNoteForm({ node, cfg, set }: FormProps) {
  const { workspaceId, sequenceId, poolSenders, readOnly } = useBuilder();
  const linkedin = poolSenders.filter((s) => s.provider === 'LINKEDIN');
  return (
    <div className="space-y-3">
      <Note>Sends a recorded voice message on LinkedIn. It needs a 1st-degree connection and counts against the message budget.</Note>
      <VoiceClipRecorder workspaceId={workspaceId} sequenceId={sequenceId} nodeId={node.id} senders={linkedin} readOnly={readOnly} />
      <Callout tone="warn">Senders without a clip skip this step. Each sender records in their own voice, up to 60 seconds.</Callout>
      <Note>There is no AI voice cloning, on purpose: a cloned voice puts the account and your reputation at risk. One real recording per sender is the feature. The same clip goes to every lead, so keep it general (“Hi, thanks for connecting…”).</Note>
      <Toggle checked={!!cfg.send_always} onChange={(v) => set('send_always', v)} label="Send even after the lead replied" />
    </div>
  );
}

const BRANCH_IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const MAX_BRANCHES = 5;

export function AbSplitForm({ node, cfg, update }: FormProps) {
  const branches: AbBranch[] = Array.isArray(cfg.branches) ? cfg.branches : [];
  const percents = normalisedPercents(branches.map((b) => Math.max(0, Number(b.weight) || 0)));
  const commit = (next: AbBranch[]) => update(syncNodeBranches({ ...node, config: { ...cfg, branches: next } }));
  const setBranch = (i: number, p: Partial<AbBranch>) => commit(branches.map((b, idx) => (idx === i ? { ...b, ...p } : b)));
  const add = () => {
    const id = BRANCH_IDS.find((x) => !branches.some((b) => b.id === x)) ?? `b${Date.now().toString(36)}`;
    commit([...branches, { id, label: id.toUpperCase(), weight: Math.max(1, Math.round(branches.reduce((s, b) => s + (Number(b.weight) || 0), 0) / Math.max(1, branches.length))) }]);
  };
  const splitEvenly = () => { const base = Math.floor(100 / branches.length); commit(branches.map((b, i) => ({ ...b, weight: base + (i < 100 - base * branches.length ? 1 : 0) }))); };

  return (
    <div className="space-y-3">
      <Note>Tests whole paths against each other, for example an invitation with a note against one without. Each branch is an exit on the canvas.</Note>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_72px_44px_28px] gap-1.5 text-[11px] text-gray-500 px-0.5"><span>Branch</span><span>Weight</span><span className="text-right">Share</span><span /></div>
        {branches.map((b, i) => (
          <div key={b.id} className="grid grid-cols-[1fr_72px_44px_28px] gap-1.5 items-center">
            <input value={b.label ?? ''} onChange={(e) => setBranch(i, { label: e.target.value })} maxLength={40} aria-label={`Name of branch ${i + 1}`} className="min-w-0 px-2 py-1 text-xs rounded border border-gray-300" />
            <input type="number" min={0} max={100} value={b.weight ?? 1} onChange={(e) => setBranch(i, { weight: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} aria-label={`Weight of ${b.label || b.id}`} className="px-2 py-1 text-xs rounded border border-gray-300 tabular-nums" />
            <span className="text-xs text-gray-600 tabular-nums text-right">{percents[i]}%</span>
            <button type="button" onClick={() => commit(branches.filter((_, idx) => idx !== i))} disabled={branches.length <= 2} className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400" aria-label={`Remove branch ${b.label || b.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={add} disabled={branches.length >= MAX_BRANCHES}><Plus className="w-3.5 h-3.5" aria-hidden /> Add branch</Button>
        <button type="button" onClick={splitEvenly} className="text-xs text-gray-500 underline hover:text-gray-800">Split evenly</button>
      </div>
      {branches.length < 2 && <Callout tone="warn">A split needs at least two branches.</Callout>}
      {percents.every((p) => p === 0) && branches.length > 0 && <Callout tone="warn">Every branch has weight 0. Give at least one branch a weight.</Callout>}
      <Note>Weights are shares, so they do not have to add up to 100. Each lead always takes the same branch. Removing a branch disconnects its exit. No winner is declared under 100 leads per branch.</Note>
      <VariantResults nodeId={node.id} />
    </div>
  );
}
