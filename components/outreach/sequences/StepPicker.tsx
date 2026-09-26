'use client';

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  ArrowLeftRight, ArrowRightCircle, AtSign, Award, Bot, Clock, ClipboardList, Eye, Flag, GitBranch, Heart, List, Mail, MessageCircle, MessageSquare, MessageSquareReply, Mic, Milestone,
  Phone, PhoneCall, Play, RefreshCw, RotateCw, Route, Search, ShieldCheck, Shuffle, Sparkles, Split, Tag, Tags, ThumbsUp, UserCheck, UserPlus, UserRoundMinus, UserRoundPlus, Users, UserX, Webhook,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GraphNode, NodeType } from '@/lib/outreach/types';
import { exitLabel, NODE_CATALOG, type NodeGroup } from '@/lib/outreach/nodes';
import { Drawer } from './Modals';
import { nodeTitle } from './helpers';

/** One icon per step type, shared by the picker and the canvas. */
export const STEP_ICONS: Record<NodeType, ComponentType<{ className?: string }>> = {
  start: Play, end: Flag,
  visit_profile: Eye, refresh_profile: RefreshCw, like_latest_post: ThumbsUp, comment_latest_post: MessageCircle, endorse_skills: Award, follow_profile: UserRoundPlus,
  send_invite: UserPlus, wait_connection: UserCheck, withdraw_invite: UserX, send_message: MessageSquare, send_voice_note: Mic, send_inmail: Mail, send_email: AtSign, find_email: Search,
  delay: Clock, condition: GitBranch, ab_split: Split, rotate_sender: RotateCw, change_sender: Users,
  add_tag: Tag, remove_tag: Tags, change_list: List, change_stage: Milestone,
  call_webhook: Webhook, call_api: Shuffle, send_to_sequence: ArrowRightCircle,
  manual_task: ClipboardList, call_task: Phone, ai_draft_approval: Sparkles, ai_route: Route,
  follow: UserRoundPlus, unfollow: UserRoundMinus, like_recent_posts: Heart, comment_post: MessageCircle, wait_follow_back: Users,
  check_identifier: PhoneCall, require_consent: ShieldCheck, wait_for_reply: MessageSquareReply, channel_switch: ArrowLeftRight,
};

// Soft tint for the icon box per step colour (bg-xxx-600 → text/border/bg of the same hue). Tailwind only ships classes it can see, so they are spelt out.
const TINTS: Record<string, string> = {
  gray: 'text-gray-600 border-gray-200 bg-gray-50', sky: 'text-sky-600 border-sky-200 bg-sky-50', pink: 'text-pink-600 border-pink-200 bg-pink-50',
  indigo: 'text-indigo-600 border-indigo-200 bg-indigo-50', blue: 'text-blue-600 border-blue-200 bg-blue-50', emerald: 'text-emerald-600 border-emerald-200 bg-emerald-50',
  amber: 'text-amber-600 border-amber-200 bg-amber-50', teal: 'text-teal-600 border-teal-200 bg-teal-50', purple: 'text-purple-600 border-purple-200 bg-purple-50',
  slate: 'text-slate-600 border-slate-200 bg-slate-50', fuchsia: 'text-fuchsia-600 border-fuchsia-200 bg-fuchsia-50',
  rose: 'text-rose-600 border-rose-200 bg-rose-50', green: 'text-green-600 border-green-200 bg-green-50',
};
export function stepTint(type: NodeType): string {
  const hue = NODE_CATALOG[type]?.color.replace(/^bg-/, '').replace(/-\d+$/, '') ?? 'gray';
  return TINTS[hue] ?? TINTS.gray;
}

export function StepIcon({ type, className }: { type: NodeType; className?: string }) {
  const Icon = STEP_ICONS[type] ?? Bot;
  return (
    <span className={cn('inline-flex items-center justify-center rounded-lg border flex-shrink-0', stepTint(type), className)}>
      <Icon className="w-[55%] h-[55%]" />
    </span>
  );
}

/** Plain-language names and order of the picker's categories (the catalogue groups underneath stay as they are). */
const CATEGORIES: Array<{ label: string; groups: NodeGroup[] }> = [
  { label: 'LinkedIn actions', groups: ['Outreach', 'Social'] },
  // shown even when the pool has no account of the channel: the steps are greyed out with the reason
  { label: 'Instagram actions', groups: ['Instagram'] },
  { label: 'WhatsApp actions', groups: ['WhatsApp'] },
  { label: 'Conditions and timing', groups: ['Logic'] },
  { label: 'Update the lead', groups: ['CRM'] },
  { label: 'Team and AI', groups: ['Flow', 'AI'] },
  { label: 'Connect other tools', groups: ['Integrations'] },
];

/** Plain one-liners for the picker (the catalogue's descriptions are terser). */
const BLURB: Partial<Record<NodeType, string>> = {
  end: 'Finish the sequence for this lead',
  visit_profile: 'Look at the lead’s profile so they see you were there',
  refresh_profile: 'Re-read the lead’s profile if what we have is old',
  like_latest_post: 'React to the lead’s most recent post',
  comment_latest_post: 'Leave a comment on the lead’s latest post',
  endorse_skills: 'Endorse a few of the lead’s skills',
  follow_profile: 'Follow the lead on LinkedIn',
  send_invite: 'Send a connection request, with or without a note',
  wait_connection: 'Wait to see whether the lead accepts. Branches on the answer',
  withdraw_invite: 'Take back a connection request that was not accepted',
  send_message: 'Send a direct message on LinkedIn, Instagram or WhatsApp',
  send_voice_note: 'Send a recorded voice message on LinkedIn or WhatsApp',
  send_inmail: 'Message a lead you are not connected with',
  send_email: 'Send an email from a connected mailbox',
  find_email: 'Look up the lead’s work email',
  follow: 'Follow the lead on Instagram. The usual first touch there',
  unfollow: 'Stop following the lead, for example after the conversation ended',
  like_recent_posts: 'Like one to three of the lead’s recent posts',
  comment_post: 'Leave a public comment on the lead’s latest post',
  wait_follow_back: 'Wait a few days to see whether the lead follows back. Branches on the answer',
  check_identifier: 'Check whether the lead’s number is on WhatsApp, without starting a chat',
  require_consent: 'Only continue with leads who agreed to hear from you on WhatsApp',
  delay: 'Pause for a while before the next step',
  wait_for_reply: 'Give the lead a few days to answer. Branches on whether they did',
  channel_switch: 'Carry on with the same lead on another channel, with the account that works it there',
  condition: 'Take a different path depending on the lead',
  ab_split: 'Send some leads one way and the rest another, to compare',
  rotate_sender: 'Start again from an earlier step with the next sender',
  change_sender: 'Carry on with a different sender',
  add_tag: 'Put a tag on the lead',
  remove_tag: 'Take a tag off the lead',
  change_list: 'Move the lead to another list',
  change_stage: 'Move the lead to another pipeline stage',
  call_webhook: 'Send the lead to a webhook you set up',
  call_api: 'Call any web address with the lead’s details',
  send_to_sequence: 'Hand the lead over to another sequence',
  manual_task: 'Create a to-do for a teammate and wait until it is done',
  call_task: 'Ask a teammate to call the lead. Branches on how it went',
  ai_draft_approval: 'Let AI write a draft that a teammate approves before it goes out',
  ai_route: 'Describe each path in plain words and let AI pick one per lead',
};

/** Where the new step will be wired in. */
export interface StepPickerTarget {
  source: string;
  handle: string;
  /** The step the exit already leads to, when inserting into an existing line. */
  target: string | null;
}

interface PanelProps {
  target: StepPickerTarget;
  nodes: Record<string, GraphNode>;
  /** From allowedNext(): null = fine here, otherwise why this step cannot come next. */
  allowed: Record<NodeType, string | null> | null;
  onPick: (type: NodeType) => void;
  onClose: () => void;
}

export default function StepPicker({ open, target, ...rest }: Omit<PanelProps, 'target'> & { open: boolean; target: StepPickerTarget | null }) {
  // the panel mounts fresh each time, so its search box starts empty
  if (!open || !target) return null;
  return <PickerPanel target={target} {...rest} />;
}

function PickerPanel({ target, nodes, allowed, onPick, onClose }: PanelProps) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => input.current?.focus(), 60); return () => clearTimeout(t); }, []);

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return CATEGORIES.map((c) => ({
      label: c.label,
      items: Object.values(NODE_CATALOG).filter((m) => c.groups.includes(m.group) && m.type !== 'start')
        .filter((m) => !needle || m.label.toLowerCase().includes(needle) || (BLURB[m.type] ?? m.description).toLowerCase().includes(needle) || m.type.includes(needle)),
    })).filter((c) => c.items.length > 0);
  }, [q]);

  const src = nodes[target.source];
  const tgt = target.target ? nodes[target.target] : null;
  const branch = src && src.type !== 'start' ? exitLabel(src, target.handle) : '';
  const showBranch = !!branch && branch !== 'next';
  const where = !src ? null
    : src.type === 'start' ? (tgt ? <>Before <b className="font-medium text-gray-800">{nodeTitle(tgt)}</b>, as the first step</> : <>The first step of the sequence</>)
    : tgt ? <>Between <b className="font-medium text-gray-800">{nodeTitle(src)}</b>{showBranch && <> ({branch})</>} and <b className="font-medium text-gray-800">{nodeTitle(tgt)}</b></>
    : <>After <b className="font-medium text-gray-800">{nodeTitle(src)}</b>{showBranch && <>, on the <b className="font-medium text-gray-800">{branch}</b> branch</>}</>;

  return (
    <Drawer open onClose={onClose} title="Add a step" subtitle={where} width="max-w-3xl">
      <div className="relative mb-4">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search steps" aria-label="Search steps" className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
      {sections.length === 0 && <p className="text-sm text-gray-500 py-6 text-center">No steps match “{q}”.</p>}
      <div className="space-y-6">
        {sections.map((c) => {
          const okCount = c.items.filter((m) => !allowed || !allowed[m.type]).length;
          return (
            <section key={c.label}>
              <h4 className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                {c.label}
                <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 rounded-md px-1.5 py-0.5 tabular-nums">{okCount}</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {c.items.map((m) => {
                  const reason = allowed?.[m.type] ?? null;
                  const blurb = BLURB[m.type] ?? m.description;
                  return (
                    <button
                      key={m.type}
                      type="button"
                      disabled={!!reason}
                      onClick={() => { if (!reason) onPick(m.type); }}
                      title={reason ?? blurb}
                      className={cn(
                        'group flex items-start gap-3 p-3 rounded-xl border text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-500',
                        reason ? 'border-gray-100 bg-gray-50/70 cursor-not-allowed' : 'border-gray-200 bg-white hover:border-indigo-400 hover:shadow-sm',
                      )}
                    >
                      <StepIcon type={m.type} className={cn('w-10 h-10', reason && 'opacity-40 grayscale')} />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-sm font-medium leading-5', reason ? 'text-gray-400' : 'text-gray-900')}>{m.label}</span>
                        <span className={cn('block text-xs leading-4', reason ? 'text-gray-400' : 'text-gray-500')}>{blurb}</span>
                        {reason && <span className="block text-[11px] leading-4 text-amber-700 mt-1">{reason}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <p className="mt-6 text-xs text-gray-500">The new step is connected for you{tgt ? ', and the line carries on to the step that followed' : ''}. Greyed-out steps do not fit at this point of the sequence.</p>
    </Drawer>
  );
}
