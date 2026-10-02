'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Undo2, User } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { SimTurn } from './simModel';
import TurnResult from './TurnResult';

const US_ORIGIN: Record<string, string> = { teammate: 'Teammate', ai: 'Earlier AI reply', us: 'Us' };

export default function SimChat({ turns, stageLabel, busy, canRun, error, nextScripted, onProspect, onUs, onReply, onUndo }: {
  turns: SimTurn[];
  stageLabel: (k: string | null | undefined) => string;
  busy: boolean;
  canRun: boolean;
  error: { message: string; setup: boolean } | null;
  /** The next line of the chosen example prospect, offered as a one-click fill. */
  nextScripted: string | null;
  onProspect: (text: string, reply: boolean) => void;
  onUs: (text: string) => void;
  onReply: () => void;
  onUndo: () => void;
}) {
  const [text, setText] = useState('');
  const [autoReply, setAutoReply] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const hasProspect = turns.some((t) => t.from === 'prospect');

  // keep the newest line in view inside the chat box (never scrolls the page)
  useEffect(() => { const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; }, [turns.length, busy]);

  const sendProspect = () => { const t = text.trim(); if (!t) return; onProspect(t, autoReply && canRun); setText(''); };
  const sendUs = () => { const t = text.trim(); if (!t) return; onUs(t); setText(''); };

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 flex flex-col">
      <div ref={boxRef} className="max-h-[520px] min-h-[220px] overflow-y-auto p-4 space-y-3" aria-live="polite" aria-label="Simulated conversation">
        {turns.length === 0 && <p className="text-sm text-gray-500 text-center py-10">Pick an example prospect above, or write the first message as the prospect.</p>}
        {turns.map((t) => t.from === 'ai' ? (
          <TurnResult key={t.id} r={t.result} stageLabel={stageLabel} />
        ) : t.from === 'prospect' ? (
          <div key={t.id} className="flex gap-2">
            <div className="w-7 h-7 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center flex-shrink-0 mt-0.5" aria-hidden="true"><User className="w-4 h-4" /></div>
            <div className="max-w-[80%]">
              <div className="text-[11px] text-gray-500 mb-0.5">Prospect</div>
              <div className="rounded-2xl rounded-bl-sm bg-white border border-gray-200 px-3.5 py-2 text-sm text-gray-900 whitespace-pre-wrap break-words">{t.text}</div>
            </div>
          </div>
        ) : (
          <div key={t.id} className="flex justify-end">
            <div className="max-w-[80%]">
              <div className="text-[11px] text-gray-500 mb-0.5 text-right">{US_ORIGIN[t.origin ?? 'us']} (fixed)</div>
              <div className="rounded-2xl rounded-br-sm bg-indigo-100 text-indigo-950 px-3.5 py-2 text-sm whitespace-pre-wrap break-words">{t.text}</div>
            </div>
          </div>
        ))}
        {busy && <div className="flex items-center justify-end gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" />The AI is reading and deciding…</div>}
      </div>

      {error && (
        <div role="alert" className="mx-4 mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          {error.message}{error.setup && <> <Link href="/outreach/ai/setup/general" className="underline underline-offset-2 font-medium">Open AI → Setup → General</Link></>}
        </div>
      )}

      <div className="border-t border-gray-200 bg-white rounded-b-xl p-3 space-y-2">
        {nextScripted && (
          <button type="button" onClick={() => setText(nextScripted)} className="text-left text-xs rounded-lg border border-dashed border-indigo-300 bg-indigo-50/50 px-2.5 py-1.5 text-indigo-900 hover:bg-indigo-50 w-full">
            <span className="font-medium">Next line from the example:</span> {nextScripted}
          </button>
        )}
        <label className="block">
          <span className="sr-only">Message</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} disabled={busy} placeholder="Write as the prospect…"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendProspect(); } }}
            className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={sendProspect} disabled={busy || !text.trim()}>Send as prospect</Button>
          <Button size="sm" variant="secondary" onClick={sendUs} disabled={busy || !text.trim()} title="Add a line as if your team sent it. The AI treats it as already sent.">Add as our message</Button>
          <Button size="sm" variant="secondary" onClick={onReply} disabled={busy || !canRun || !hasProspect}>Get AI reply</Button>
          <label className={cn('flex items-center gap-1.5 text-xs text-gray-600', !canRun && 'opacity-50')}>
            <input type="checkbox" className="rounded border-gray-300" checked={autoReply && canRun} disabled={!canRun} onChange={(e) => setAutoReply(e.target.checked)} />
            AI answers each prospect message
          </label>
          <button type="button" onClick={onUndo} disabled={busy || !turns.length} className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 disabled:opacity-40">
            <Undo2 className="w-3.5 h-3.5" />Undo last
          </button>
        </div>
      </div>
    </div>
  );
}
