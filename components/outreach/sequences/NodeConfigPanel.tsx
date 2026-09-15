'use client';

import { Copy, Trash2, X, AlertTriangle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Input, Toggle } from '@/components/outreach/ui';
import type { GraphIssue } from '@/lib/outreach/graph';
import { EXECUTABLE_TYPES, NODE_CATALOG } from '@/lib/outreach/nodes';
import type { GraphNode } from '@/lib/outreach/types';
import {
  AiDraftApprovalForm, CommentForm, EndForm, EndorseForm, LikeForm, ManualTaskForm, SendEmailForm, SendInmailForm, SendInviteForm, SendMessageForm,
  VisitProfileForm, WaitConnectionForm, WithdrawForm, type FormProps,
} from './FormsOutreach';
import { CallApiForm, CallWebhookForm, ChangeListForm, ChangeSenderForm, ChangeStageForm, ConditionForm, DelayEditor, DelayForm, RotateSenderForm, SendToSequenceForm, TagForm } from './FormsLogic';

function TypeForm(props: FormProps) {
  switch (props.node.type) {
    case 'start': return <p className="text-xs text-gray-500">Every enrollment begins here. Connect the exit to the first step.</p>;
    case 'end': return <EndForm {...props} />;
    case 'send_invite': return <SendInviteForm {...props} />;
    case 'send_message': return <SendMessageForm {...props} />;
    case 'send_inmail': return <SendInmailForm {...props} />;
    case 'comment_latest_post': return <CommentForm {...props} />;
    case 'like_latest_post': return <LikeForm {...props} />;
    case 'endorse_skills': return <EndorseForm {...props} />;
    case 'visit_profile': return <VisitProfileForm {...props} />;
    case 'wait_connection': return <WaitConnectionForm {...props} />;
    case 'withdraw_invite': return <WithdrawForm />;
    case 'send_email': return <SendEmailForm {...props} />;
    case 'delay': return <DelayForm {...props} />;
    case 'condition': return <ConditionForm {...props} />;
    case 'rotate_sender': return <RotateSenderForm {...props} />;
    case 'change_sender': return <ChangeSenderForm {...props} />;
    case 'add_tag': return <TagForm {...props} verb="add" />;
    case 'remove_tag': return <TagForm {...props} verb="remove" />;
    case 'change_list': return <ChangeListForm {...props} />;
    case 'change_stage': return <ChangeStageForm {...props} />;
    case 'call_webhook': return <CallWebhookForm {...props} />;
    case 'call_api': return <CallApiForm {...props} />;
    case 'send_to_sequence': return <SendToSequenceForm {...props} />;
    case 'manual_task': return <ManualTaskForm {...props} />;
    case 'ai_draft_approval': return <AiDraftApprovalForm {...props} />;
    default: return null;
  }
}

interface Props {
  node: GraphNode;
  issues: GraphIssue[];
  readOnly: boolean;
  onChange: (next: GraphNode) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onClose: () => void;
  className?: string;
}

export default function NodeConfigPanel({ node, issues, readOnly, onChange, onDelete, onDuplicate, onClose, className }: Props) {
  const meta = NODE_CATALOG[node.type];
  const cfg = node.config ?? {};
  const set = (key: string, value: unknown) => {
    const next = { ...cfg };
    if (value === undefined) delete next[key]; else next[key] = value;
    onChange({ ...node, config: next });
  };
  const executable = EXECUTABLE_TYPES.includes(node.type);
  const canPreDelay = !['start', 'end', 'delay'].includes(node.type);
  const errors = issues.filter((i) => i.code.startsWith('E_'));
  const warnings = issues.filter((i) => !i.code.startsWith('E_'));

  return (
    <aside className={cn('flex flex-col bg-white border-l border-gray-200 h-full', className)} aria-label="Step settings">
      <div className={cn('flex items-center gap-2 px-3 py-2 text-white', meta.color)}>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold truncate">{meta.label}</div>
          <div className="text-[10px] opacity-80 font-mono truncate">{node.id}</div>
        </div>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-white/20" aria-label="Close panel"><X className="w-4 h-4" /></button>
      </div>
      <fieldset disabled={readOnly} className="flex-1 overflow-y-auto p-3 space-y-4 min-w-0">
        {(errors.length > 0 || warnings.length > 0) && (
          <div className="space-y-1">
            {errors.map((i, idx) => <div key={`e${idx}`} className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50 rounded-md px-2 py-1.5"><XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{i.message}</div>)}
            {warnings.map((i, idx) => <div key={`w${idx}`} className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 rounded-md px-2 py-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{i.message}</div>)}
          </div>
        )}
        <Input label="Label" value={node.label ?? ''} onChange={(e) => onChange({ ...node, label: e.target.value })} placeholder={meta.label} />
        {executable && (
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Execution mode</div>
            <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs">
              {(['auto', 'manual'] as const).map((m) => (
                <button key={m} type="button" onClick={() => onChange({ ...node, mode: m === 'auto' ? undefined : m })} className={cn('px-3 py-1.5 capitalize', (node.mode ?? 'auto') === m ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}>{m}</button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1">{node.mode === 'manual' ? 'Creates a task; the action runs when a teammate completes it.' : 'Runs automatically inside the sender schedule and budgets.'}</p>
          </div>
        )}
        {canPreDelay && (
          <div className="rounded-lg border border-gray-200 p-2.5 space-y-2">
            <Toggle checked={!!node.delay} onChange={(v) => onChange({ ...node, delay: v ? { amount: 1, unit: 'days', jitter_pct: 20 } : undefined })} label="Wait before this step" />
            {node.delay && <DelayEditor value={node.delay} onChange={(d) => onChange({ ...node, delay: d })} />}
          </div>
        )}
        <div className="border-t border-gray-100 pt-3">
          <TypeForm key={node.id} node={node} cfg={cfg} set={set} />
        </div>
      </fieldset>
      {!readOnly && (
        <div className="border-t border-gray-100 p-2 flex items-center gap-2">
          {node.type !== 'start' && <Button variant="secondary" size="sm" onClick={() => onDuplicate(node.id)} title="Duplicate step"><Copy className="w-3.5 h-3.5" /> Duplicate</Button>}
          {node.type !== 'start' && <Button variant="danger" size="sm" className="ml-auto" onClick={() => onDelete(node.id)} title="Delete step (Delete key)"><Trash2 className="w-3.5 h-3.5" /> Delete</Button>}
          {node.type === 'start' && <span className="text-xs text-gray-500">The start step cannot be deleted.</span>}
        </div>
      )}
    </aside>
  );
}
