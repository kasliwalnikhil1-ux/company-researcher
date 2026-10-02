'use client';

// Questions the AI could not answer from the prompt or knowledge (changes doc §9.3), grouped, with "Add answer" and "Dismiss".
import { useState } from 'react';
import Link from 'next/link';
import { ExternalLink, MessageCircleQuestion } from 'lucide-react';
import { useUnanswered, useUnansweredAnswer, useUnansweredDismiss, type UnansweredGroup } from '@/lib/outreach/aiRepliesSequence';
import { hubHref } from '@/lib/outreach/aiHub';
import { Badge, Button, ErrorBox, Modal, Spinner, Textarea, timeAgo } from '@/components/outreach/ui';
import { Section, errText, shortDate } from './shared';

export default function UnansweredSection({ sequenceId, canEdit, notify }: { sequenceId: string; canEdit: boolean; notify: (m: string, t?: 'success' | 'error') => void }) {
  const [all, setAll] = useState(false);
  const q = useUnanswered(sequenceId, all ? 'all' : 'open');
  const answer = useUnansweredAnswer(sequenceId);
  const dismiss = useUnansweredDismiss(sequenceId);
  const [answering, setAnswering] = useState<UnansweredGroup | null>(null);
  const [dismissing, setDismissing] = useState<UnansweredGroup | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rows = q.data ?? [];

  async function doAnswer() {
    if (!answering || text.trim().length < 2) return;
    setError(null);
    try { await answer.mutateAsync({ groupId: answering.id, answer: text.trim() }); notify('Answer added to the Q&A. The next time it is asked, the AI answers from it.'); setAnswering(null); setText(''); }
    catch (e) { setError(errText(e)); }
  }
  async function doDismiss() {
    if (!dismissing) return;
    setError(null);
    try { await dismiss.mutateAsync({ groupId: dismissing.id, reason: text.trim() || null }); setDismissing(null); setText(''); }
    catch (e) { setError(errText(e)); }
  }

  return (
    <Section title="Unanswered questions"
      help={<>What prospects asked that the AI could not answer from the prompt or knowledge. Add the answer once and it is used from then on. <Link href={hubHref.needsYou({ type: 'question', where: sequenceId, mine: false })} className="text-indigo-600 hover:underline whitespace-nowrap">Answer them in AI → Needs you</Link></>}
      actions={(
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          <input type="checkbox" className="rounded border-gray-300" checked={all} onChange={(e) => setAll(e.target.checked)} />Show answered and dismissed
        </label>
      )}>
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorBox message={errText(q.error)} /> : rows.length === 0 ? (
        <p className="text-sm text-gray-500 flex items-center gap-2"><MessageCircleQuestion className="w-4 h-4 text-gray-400" aria-hidden="true" />{all ? 'Nothing recorded yet.' : 'No open questions. Everything asked so far was covered.'}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((g) => (
            <li key={g.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900">{g.canonical}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Asked {g.count_30d} {g.count_30d === 1 ? 'time' : 'times'} in 30 days ({g.count_total} in all) · last {timeAgo(g.last_seen_at)}
                    {g.status !== 'open' && <Badge tone={g.status === 'answered' ? 'green' : 'gray'} className="ml-2">{g.status === 'answered' ? 'Answered' : `Dismissed${g.dismissed_reason ? `: ${g.dismissed_reason}` : ''}`}</Badge>}
                  </div>
                </div>
                {canEdit && g.status === 'open' && (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" onClick={() => { setText(''); setError(null); setAnswering(g); }}>Add answer</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setText(''); setError(null); setDismissing(g); }}>Dismiss</Button>
                  </div>
                )}
              </div>
              {g.examples?.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {g.examples.slice(0, 3).map((ex, i) => (
                    <li key={`${ex.message_id ?? i}`} className="text-xs text-gray-600 flex items-start gap-1.5">
                      <span className="text-gray-400 flex-shrink-0">{shortDate(ex.at)}</span>
                      <span className="min-w-0 truncate">&ldquo;{ex.text}&rdquo;</span>
                      {ex.chat_id && <Link href={`/outreach/inbox/${ex.chat_id}`} className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline flex-shrink-0"><ExternalLink className="w-3 h-3" aria-hidden="true" />Open</Link>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!answering} onClose={() => setAnswering(null)} title="Add the answer" size="md"
        footer={<><Button variant="secondary" onClick={() => setAnswering(null)} disabled={answer.isPending}>Cancel</Button><Button onClick={doAnswer} loading={answer.isPending} disabled={text.trim().length < 2}>Save answer</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-900 font-medium">{answering?.canonical}</p>
          <Textarea label="Answer" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="What the AI should say when this comes up. Numbers and links here count as allowed facts." autoFocus />
          {error && <ErrorBox message={error} />}
        </div>
      </Modal>
      <Modal open={!!dismissing} onClose={() => setDismissing(null)} title="Dismiss this question" size="sm"
        footer={<><Button variant="secondary" onClick={() => setDismissing(null)} disabled={dismiss.isPending}>Cancel</Button><Button onClick={doDismiss} loading={dismiss.isPending}>Dismiss</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-700">&ldquo;{dismissing?.canonical}&rdquo; is hidden. It comes back if it keeps being asked.</p>
          <Textarea label="Reason (optional)" rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. A person should always answer this" className="min-h-0" />
          {error && <ErrorBox message={error} />}
        </div>
      </Modal>
    </Section>
  );
}
