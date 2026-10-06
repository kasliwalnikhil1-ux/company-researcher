'use client';

import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Check, MessageSquarePlus, X } from 'lucide-react';
import { dismissQuestion, originsText } from '@/lib/outreach/aiHub';
import { Button, Textarea, timeAgo } from '@/components/outreach/ui';
import NeedCard from './NeedCard';
import { questionExamples, type CardProps } from './types';

const ANSWER_MAX = 2000;   // outreach_hub_question_answer: 2 to 2000 characters

/**
 * Question: something the AI could not answer, from AI replies or the Website agent, grouped. The question is the
 * trigger; the answer a manager writes becomes a Q&A pair in Knowledge, so both features can answer it next time.
 */
export default function QuestionCard({ row, hidden, api }: CardProps) {
  const [answer, setAnswer] = useState<string | undefined>(undefined);
  const answering = answer !== undefined;
  const examples = questionExamples(row);
  const question = (row.trigger_text ?? '').trim();
  const text = (answer ?? '').trim();
  const canAct = api.canWrite && api.isManager;
  const n = Number(row.meta?.count_total ?? 1);
  const asked = `Asked ${n === 1 ? 'once' : `${n.toLocaleString()} times`} · ${originsText(row.meta?.origins)}`;

  const save = () => {
    if (text.length < 2 || text.length > ANSWER_MAX) return;
    void api.act(row, () => api.answerQuestion(row.id, text), 'Answer saved to Knowledge.');
  };

  return (
    <NeedCard row={row} hidden={hidden}
      title={<span className="min-w-0 font-semibold text-gray-900 break-words [overflow-wrap:anywhere]">{question || 'A question without text'}</span>}
      ai={answering ? (
        <Textarea label="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} autoFocus className="min-h-[80px]"
          counter={{ max: ANSWER_MAX, value: (answer ?? '').length }}
          hint={'Saved to Knowledge as a Q&A pair. AI replies and the Website agent can both use it.'} />
      ) : undefined}
      extra={examples.length > 0 ? (
        <details className="text-xs text-gray-600">
          <summary className="w-fit cursor-pointer select-none text-gray-500 hover:text-gray-800 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{asked}</summary>
          <ul className="mt-1.5 space-y-0.5 border-l-2 border-gray-100 pl-3">
            {examples.map((e, i) => (
              <li key={i} className="flex items-baseline gap-2 min-w-0">
                <span className="truncate min-w-0" title={e.text}>“{e.text}”</span>
                {e.at && <span className="flex-shrink-0 text-gray-400">{timeAgo(e.at)}</span>}
                {e.chatId && <Link href={`/outreach/inbox/${e.chatId}`} className="flex-shrink-0 text-indigo-700 hover:underline">Open chat</Link>}
              </li>
            ))}
          </ul>
        </details>
      ) : <p className="text-xs text-gray-500">{asked}</p>}
      actions={canAct ? (
        answering ? (
          <>
            <Button size="sm" disabled={text.length < 2 || text.length > ANSWER_MAX} onClick={save}><Check className="w-3.5 h-3.5" /> Save answer</Button>
            <Button size="sm" variant="ghost" onClick={() => setAnswer(undefined)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={() => setAnswer('')}><MessageSquarePlus className="w-3.5 h-3.5" /> Add answer</Button>
            <Button size="sm" variant="ghost" onClick={() => api.defer(row, 'Question dismissed', () => dismissQuestion(row.id))} title="The question leaves the list without an answer"><X className="w-3.5 h-3.5" /> Dismiss</Button>
          </>
        )
      ) : undefined} />
  );
}
