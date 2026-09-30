'use client';

// "Pitch after [2] replies · At most [6] AI replies per conversation" and the stage strip with the open-conversation counts.
import { useState } from 'react';
import { ArrowRight, Info } from 'lucide-react';
import { useSetSequenceAiReplies, type SequenceAiSettings } from '@/lib/outreach/aiRepliesSequence';
import { cn } from '@/lib/utils';
import { errText } from './shared';

function NumberBox({ value, min, max, disabled, label, onCommit }: { value: number; min: number; max: number; disabled: boolean; label: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  // a saved value coming back from the server replaces what is typed
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setText(String(value)); }
  const commit = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n) || n < min || n > max) { setText(String(value)); return; }
    if (n !== value) onCommit(n);
  };
  return (
    <input type="number" inputMode="numeric" min={min} max={max} step={1} value={text} disabled={disabled} aria-label={label}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="w-16 px-2 py-1 text-sm text-center rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 tabular-nums" />
  );
}

export function NumbersRow({ sequenceId, s, canEdit, notify }: { sequenceId: string; s: SequenceAiSettings; canEdit: boolean; notify: (m: string, t?: 'success' | 'error') => void }) {
  const set = useSetSequenceAiReplies(sequenceId);
  const patch = (p: Parameters<typeof set.mutate>[0]['patch']) => set.mutate({ patch: p }, {
    onSuccess: (r) => notify(`Saved. Applies to the next reply in ${r.settings?.applies_to ?? s.open_conversations} open conversations.`),
    onError: (e) => notify(errText(e), 'error'),
  });
  const disabled = !canEdit || set.isPending;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-gray-800">
      <span>Pitch after</span>
      <NumberBox value={s.pitch_after_replies} min={0} max={5} disabled={disabled} label="Pitch after this many replies" onCommit={(v) => patch({ pitch_after_replies: v })} />
      <span>replies</span>
      <span className="text-gray-300 px-1" aria-hidden="true">·</span>
      <span>At most</span>
      <NumberBox value={s.max_ai_replies_per_chat} min={1} max={10} disabled={disabled} label="AI replies per conversation" onCommit={(v) => patch({ max_ai_replies_per_chat: v })} />
      <span>AI replies per conversation</span>
    </div>
  );
}

export function StageStrip({ s }: { s: SequenceAiSettings }) {
  const stages = s.prompt.settings?.stages ?? [];
  const counts = new Map((s.open_by_stage ?? []).map((x) => [x.stage, x]));
  const reengage = counts.get('re_engage');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        {stages.map((st, i) => (
          <span key={st.key} className="inline-flex items-center gap-1.5">
            <span className={cn('px-2 py-0.5 rounded-md border', st.pitch ? 'border-indigo-200 bg-indigo-50 text-indigo-900' : 'border-gray-200 bg-gray-50 text-gray-800')}>{st.label}</span>
            {i < stages.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-gray-400" aria-hidden="true" />}
          </span>
        ))}
        <span className="text-gray-500 ml-1">· AI stops here</span>
        <span className="inline-flex items-center text-gray-400 cursor-help ml-1" title={`Prospects who come back after ${s.dormant_after_days} days start again at "Re-engage": the AI acknowledges the gap, recaps in one line and asks what changed.`}>
          <Info className="w-3.5 h-3.5" aria-hidden="true" /><span className="sr-only">About Re-engage</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
        <span className="text-gray-500">Open conversations by stage:</span>
        {stages.length === 0 && !reengage && <span>none</span>}
        {stages.map((st) => {
          const c = counts.get(st.key);
          return <span key={st.key} className={cn('px-2 py-0.5 rounded-full border', c ? 'border-gray-300 bg-white text-gray-800' : 'border-gray-100 text-gray-400')}>{st.label} {c?.n ?? 0}</span>;
        })}
        {reengage && <span className="px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-900">Re-engage {reengage.n}</span>}
        <span className="text-gray-300 px-1" aria-hidden="true">·</span>
        <span>Handed off (7 d): <span className="font-medium text-gray-800 tabular-nums">{s.handed_off_7d}</span></span>
        {s.drafts_waiting > 0 && <><span className="text-gray-300 px-1" aria-hidden="true">·</span><span>Drafts waiting: <span className="font-medium text-gray-800 tabular-nums">{s.drafts_waiting}</span></span></>}
      </div>
    </div>
  );
}
