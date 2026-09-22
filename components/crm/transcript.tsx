'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCoaching, useTranscript } from '@/lib/crm/queries';
import type { SpeakerRole, TranscriptSpeaker, TranscriptTurn } from '@/lib/crm/types';
import { Badge, Button, ErrorBox, Input, Modal, Select, Spinner, fmtDate, type Tone } from './ui';
import { useWrite } from './forms';
import { DeleteRecordingButton, RecordingPlayer, UploadRecordingButton, type PlayerHandle } from './recording';
import { CoachingReport, NoCoaching } from './coaching';
import { Check, Copy, FileText, GraduationCap, Pencil, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

// A saved call recording, as speaker-labelled turns. Written by the crm skill (get-transcript → save_transcript.py);
// here it is read, searched, and the speakers can be renamed — diarization knows voices differ, not who they are.

const ROLE_TONE: Record<SpeakerRole, Tone> = { prospect: 'green', team: 'indigo', unknown: 'gray' };
const ROLE_LABEL: Record<SpeakerRole, string> = { prospect: 'Prospect', team: 'Us', unknown: 'Unknown' };

export const fmtDuration = (s: number | null | undefined) => (s == null ? '—' : s < 90 ? `${Math.round(s)} sec` : `${Math.round(s / 60)} min`);
const clock = (s: number | undefined) => { if (s == null) return ''; const t = Math.floor(s); const h = Math.floor(t / 3600); const mm = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0'); return `${h ? `${h}:` : ''}${mm}:${String(t % 60).padStart(2, '0')}`; };

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="bg-amber-200 rounded-sm px-0.5">{p}</mark> : p))}</>;
}

// Clicking a word plays from a little before it, so the sentence is heard coming in.
const WORD_LEAD_S = 2;

// Word timings. Transcripts saved by the crm skill carry the transcriber's own time for every word (turn.w, one
// [start, end] per whitespace token). Older ones only have the turn's start/end, so each word gets a share of that span
// by length (+1 for the gap after it) — close enough to follow along, and the click lead-in covers the drift.
interface TimedWord { from: number; to: number; start: number }
interface TimedTurn { i: number; start: number; end: number; words: TimedWord[] }

function timeTurns(turns: TranscriptTurn[]): TimedTurn[] {
  const out: TimedTurn[] = [];
  turns.forEach((x, k) => {
    if (x.start == null) return;
    const tokens = [...x.text.matchAll(/\S+/g)];
    if (x.w && x.w.length === tokens.length && tokens.length > 0) {
      const words = tokens.map((m, j) => ({ from: m.index!, to: m.index! + m[0].length, start: x.w![j][0] }));
      out.push({ i: x.i, start: Math.min(x.start, x.w[0][0]), end: Math.max(x.end ?? 0, x.w[x.w.length - 1][1]), words });
      return;
    }
    const next = turns.slice(k + 1).find((n) => n.start != null)?.start;
    const end = x.end != null && x.end > x.start ? x.end : next != null && next > x.start ? next : x.start + Math.max(1, tokens.length * 0.35);
    const total = tokens.reduce((n, m) => n + m[0].length + 1, 0) || 1;
    let acc = 0;
    const words = tokens.map((m) => { const w = { from: m.index!, to: m.index! + m[0].length, start: x.start! + ((end - x.start!) * acc) / total }; acc += m[0].length + 1; return w; });
    out.push({ i: x.i, start: x.start, end, words });
  });
  return out.sort((a, b) => a.start - b.start);
}

/** The turn and word being said at `s`, or null in a gap between turns. */
function wordAt(timed: TimedTurn[], s: number): { turn: number; word: number } | null {
  let lo = 0, hi = timed.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (timed[mid].start <= s) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k < 0 || s > timed[k].end + 0.5) return null;
  const ws = timed[k].words;
  let w = 0;
  while (w + 1 < ws.length && ws[w + 1].start <= s) w++;
  return { turn: timed[k].i, word: w };
}

/** text[a, b) with the search matches marked. */
function marked(text: string, a: number, b: number, ranges: Array<[number, number]>) {
  const nodes: ReactNode[] = [];
  let at = a;
  for (const [ra, rb] of ranges) {
    if (rb <= at || ra >= b) continue;
    const s = Math.max(ra, at), e = Math.min(rb, b);
    if (s > at) nodes.push(text.slice(at, s));
    nodes.push(<mark key={s} className="bg-amber-200 rounded-sm">{text.slice(s, e)}</mark>);
    at = e;
  }
  if (at < b) nodes.push(text.slice(at, b));
  return nodes;
}

const TurnRow = memo(function TurnRow({ x, timed, activeWord, follow, needle, onSeek, onWord }: {
  x: TranscriptTurn; timed?: TimedTurn; activeWord: number | null; follow: boolean; needle: string;
  onSeek?: (s: number) => void; onWord?: (s: number) => void;
}) {
  const li = useRef<HTMLLIElement>(null);
  const isActive = activeWord != null;
  useEffect(() => { if (isActive && follow) li.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [isActive, follow]);

  const ranges = useMemo(() => {
    if (!needle) return [];
    const r: Array<[number, number]> = []; const low = x.text.toLowerCase();
    for (let at = low.indexOf(needle); at >= 0; at = low.indexOf(needle, at + needle.length)) r.push([at, at + needle.length]);
    return r;
  }, [x.text, needle]);

  let body: ReactNode;
  if (timed && onWord) {
    const nodes: ReactNode[] = [];
    let at = 0;
    timed.words.forEach((w, k) => {
      if (w.from > at) nodes.push(...marked(x.text, at, w.from, ranges));
      nodes.push(
        <span key={`w${k}`} onClick={() => onWord(w.start)} title={`Play from ${clock(Math.max(0, w.start - WORD_LEAD_S))}`}
          className={cn('cursor-pointer rounded-sm transition-colors', k === activeWord ? 'bg-indigo-600 text-white' : 'hover:bg-indigo-100')}>
          {marked(x.text, w.from, w.to, ranges)}
        </span>,
      );
      at = w.to;
    });
    if (at < x.text.length) nodes.push(...marked(x.text, at, x.text.length, ranges));
    body = nodes;
  } else body = <Highlight text={x.text} q={needle} />;

  return (
    <li ref={li} className={cn('text-sm flex gap-3 rounded-md px-2 py-1.5 scroll-mt-14 scroll-mb-4', isActive ? 'ring-1 ring-indigo-200 bg-indigo-50/40' : x.role === 'prospect' ? 'bg-green-50/60' : 'bg-transparent')}>
      {onSeek && x.start != null
        ? <button onClick={() => onSeek(x.start!)} title="Play from here" className="text-[11px] text-indigo-500 hover:text-indigo-700 hover:underline tabular-nums w-12 shrink-0 pt-0.5 text-right">{clock(x.start)}</button>
        : <span className="text-[11px] text-gray-400 tabular-nums w-12 shrink-0 pt-0.5 text-right">{clock(x.start)}</span>}
      <div className="min-w-0">
        <span className={cn('font-medium mr-1.5', x.role === 'prospect' ? 'text-green-800' : x.role === 'team' ? 'text-indigo-700' : 'text-gray-700')}>{x.label}</span>
        <span className="text-gray-800 whitespace-pre-wrap">{body}</span>
      </div>
    </li>
  );
});

function SpeakerChip({ meetingId, s }: { meetingId: string; s: TranscriptSpeaker }) {
  const { write, busy, error } = useWrite();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(s.label);
  const [role, setRole] = useState<SpeakerRole>(s.role);
  const save = async () => { if (await write('set_transcript_speakers', { p_meeting_id: meetingId, p_speakers: [{ speaker: s.speaker, label: label.trim() || s.label, role }] })) setEditing(false); };

  if (!editing) {
    return (
      <button onClick={() => { setLabel(s.label); setRole(s.role); setEditing(true); }} title="Rename, or change which side they are on" className="group inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs hover:border-indigo-300">
        <span className="font-medium text-gray-900">{s.label}</span>
        <Badge tone={ROLE_TONE[s.role]}>{ROLE_LABEL[s.role]}</Badge>
        {s.share_of_words != null && <span className="text-gray-400 tabular-nums">{Math.round(s.share_of_words * 100)}%</span>}
        <Pencil className="w-3 h-3 text-gray-300 group-hover:text-indigo-500" />
      </button>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50/50 px-1.5 py-1">
      <Input value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} className="h-7 w-36 py-0 text-xs" autoFocus />
      <Select value={role} onChange={(e) => setRole(e.target.value as SpeakerRole)} className="h-7 w-28 py-0 text-xs">
        <option value="prospect">Prospect</option><option value="team">Us</option><option value="unknown">Unknown</option>
      </Select>
      <Button size="xs" onClick={save} loading={busy}><Check className="w-3 h-3" /></Button>
      <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

export type TranscriptTab = 'transcript' | 'coach';

export function TranscriptModal({ meetingId, onClose, initialTab = 'transcript' }: { meetingId: string | null; onClose: () => void; initialTab?: TranscriptTab }) {
  const q = useTranscript(meetingId);
  const t = q.data;
  const [tab, setTab] = useState<TranscriptTab>(initialTab);
  // The coaching report is only fetched once the transcript says one exists (has_coaching) — no 404 round trip otherwise.
  const cq = useCoaching(meetingId, !!t?.has_coaching);
  const [find, setFind] = useState('');
  const [prospectOnly, setProspectOnly] = useState(false);
  const [copied, setCopied] = useState<'full' | 'text' | null>(null);
  const [follow, setFollow] = useState(true);
  const [active, setActive] = useState<{ turn: number; word: number } | null>(null);
  const player = useRef<PlayerHandle>(null);

  const needle = find.trim().toLowerCase();
  const turns = useMemo(() => (t?.turns ?? []).filter((x) => (!prospectOnly || x.role === 'prospect') && (!needle || x.text.toLowerCase().includes(needle))), [t, prospectOnly, needle]);
  const hasProspect = (t?.speakers ?? []).some((s) => s.role === 'prospect');
  const filtered = turns.length !== (t?.turns.length ?? 0);

  const timed = useMemo(() => timeTurns(t?.turns ?? []), [t]);
  const timedByTurn = useMemo(() => new Map(timed.map((x) => [x.i, x])), [timed]);
  const onTime = useCallback((s: number) => {
    const at = wordAt(timed, s);
    setActive((prev) => (prev?.turn === at?.turn && prev?.word === at?.word ? prev : at));
  }, [timed]);
  const seek = useCallback((s: number) => player.current?.seek(s), []);
  const playWord = useCallback((s: number) => player.current?.seek(Math.max(0, s - WORD_LEAD_S)), []);
  useEffect(() => { setActive(null); setTab(initialTab); }, [meetingId, initialTab]);

  const copy = async (kind: 'full' | 'text') => {
    if (!t) return;
    await navigator.clipboard.writeText(kind === 'full'
      ? turns.map((x) => `[${clock(x.start)}] ${x.label}: ${x.text}`).join('\n\n')
      : turns.map((x) => x.text).join('\n\n'));
    setCopied(kind); setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Modal open={!!meetingId} onClose={onClose} size="xl" title={t ? <>Transcript · {t.company}{t.contact ? ` · ${t.contact}` : ''} <span className="font-normal text-gray-400">· {fmtDate(t.scheduled_at)}</span></> : 'Transcript'}>
      {q.isLoading && <Spinner />}
      {q.isError && <ErrorBox message={(q.error as Error).message} />}
      {t && (
        <div className="space-y-3">
          <div className="text-xs text-gray-500">
            {fmtDuration(t.duration_seconds)} · {t.word_count?.toLocaleString() ?? '—'} words{t.language ? ` · ${t.language}` : ''}{t.avg_confidence != null ? ` · ${Math.round(t.avg_confidence * 100)}% transcription confidence` : ''}{t.source ? ` · ${t.source}` : ''}{t.saved_by ? ` · saved by ${t.saved_by}` : ''}
          </div>

          {t.has_recording ? (
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0"><RecordingPlayer ref={player} meetingId={t.meeting_id} onTime={onTime} /></div>
              <DeleteRecordingButton meetingId={t.meeting_id} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">No audio stored for this call. <UploadRecordingButton meetingId={t.meeting_id} /></div>
          )}

          <div className="flex items-center gap-1 border-b border-gray-200">
            {(['transcript', 'coach'] as const).map((k) => (
              <button key={k} onClick={() => setTab(k)} className={cn('flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium -mb-px border-b-2', tab === k ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>
                {k === 'transcript' ? <><FileText className="w-3.5 h-3.5" /> Transcript</> : <><GraduationCap className="w-3.5 h-3.5" /> Sales coach{t.has_coaching ? cq.data?.execution_score != null && <span className="ml-0.5 text-[11px] tabular-nums rounded-full bg-indigo-100 text-indigo-800 px-1.5">{cq.data.execution_score}</span> : <span className="ml-0.5 text-[10px] text-gray-400 font-normal">none yet</span>}</>}
              </button>
            ))}
          </div>

          {tab === 'coach' ? (
            !t.has_coaching ? <NoCoaching company={t.company} />
              : cq.isLoading ? <Spinner />
              : cq.isError ? <ErrorBox message={(cq.error as Error).message} />
              : cq.data ? <CoachingReport c={cq.data} onSeek={t.has_recording ? playWord : undefined} /> : null
          ) : (<>
          {t.summary && <p className="text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">{t.summary}</p>}
          {t.topics.length > 0 && <div className="flex flex-wrap gap-1">{t.topics.map((x) => <Badge key={x} tone="purple">{x}</Badge>)}</div>}

          {t.speakers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {t.speakers.map((s) => <SpeakerChip key={`${s.speaker}-${s.label}-${s.role}`} meetingId={t.meeting_id} s={s} />)}
              {!hasProspect && <span className="text-xs text-amber-700">Nobody is marked as the prospect yet — click a speaker to set it.</span>}
            </div>
          )}

          {t.low_confidence.length > 0 && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-3 py-2">
              <span className="font-medium">Double-check these words</span> — the transcriber was unsure, and prices and names are the usual casualties:{' '}
              {t.low_confidence.slice(0, 12).map((w, i) => <button key={i} onClick={() => setFind(w.word.replace(/[^\p{L}\p{N}]+/gu, ' ').trim())} className="underline decoration-dotted mr-2 hover:text-amber-950">{w.word}{w.start != null ? ` (${clock(w.start)})` : ''}</button>)}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 sticky top-0 bg-white py-1 z-10">
            <div className="relative flex-1 min-w-[12rem]">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find in this call — pricing, compliance, a name…" className="pl-8" />
            </div>
            <label className={cn('flex items-center gap-1.5 text-xs', hasProspect ? 'text-gray-700' : 'text-gray-300')}>
              <input type="checkbox" checked={prospectOnly} disabled={!hasProspect} onChange={(e) => setProspectOnly(e.target.checked)} /> Prospect only
            </label>
            {t.has_recording && (
              <label className="flex items-center gap-1.5 text-xs text-gray-700" title="Scroll the transcript along with the audio">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow audio
              </label>
            )}
            <span className="text-xs text-gray-400 tabular-nums">{turns.length} of {t.turns.length}</span>
            <Button size="xs" variant="secondary" onClick={() => copy('full')} title={`Speaker names and timestamps${filtered ? ' — only the lines shown' : ''}`}>
              {copied === 'full' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {copied === 'full' ? 'Copied' : filtered ? 'Copy shown' : 'Copy transcript'}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => copy('text')} title={`Just the words, no names or timestamps${filtered ? ' — only the lines shown' : ''}`}>
              {copied === 'text' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {copied === 'text' ? 'Copied' : 'Text only'}
            </Button>
          </div>
          {t.has_recording && timed.length > 0 && <p className="text-[11px] text-gray-400 -mt-2">Click any word to play from {WORD_LEAD_S} seconds before it.</p>}

          <ol className="space-y-2">
            {turns.length === 0 && <li className="text-sm text-gray-400 py-4 text-center">Nothing matches.</li>}
            {turns.map((x) => (
              <TurnRow key={x.i} x={x} timed={timedByTurn.get(x.i)} activeWord={active?.turn === x.i ? active.word : null} follow={follow} needle={needle}
                onSeek={t.has_recording ? seek : undefined} onWord={t.has_recording ? playWord : undefined} />
            ))}
          </ol>
          </>)}
        </div>
      )}
    </Modal>
  );
}
