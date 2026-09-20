'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranscript } from '@/lib/crm/queries';
import type { SpeakerRole, TranscriptSpeaker } from '@/lib/crm/types';
import { Badge, Button, ErrorBox, Input, Modal, Select, Spinner, fmtDate, type Tone } from './ui';
import { useWrite } from './forms';
import { DeleteRecordingButton, RecordingPlayer, UploadRecordingButton, type PlayerHandle } from './recording';
import { Check, Copy, Pencil, Search } from 'lucide-react';
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

export function TranscriptModal({ meetingId, onClose }: { meetingId: string | null; onClose: () => void }) {
  const q = useTranscript(meetingId);
  const t = q.data;
  const [find, setFind] = useState('');
  const [prospectOnly, setProspectOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const player = useRef<PlayerHandle>(null);

  const needle = find.trim().toLowerCase();
  const turns = useMemo(() => (t?.turns ?? []).filter((x) => (!prospectOnly || x.role === 'prospect') && (!needle || x.text.toLowerCase().includes(needle))), [t, prospectOnly, needle]);
  const hasProspect = (t?.speakers ?? []).some((s) => s.role === 'prospect');

  const copy = async () => {
    if (!t) return;
    await navigator.clipboard.writeText(turns.map((x) => `[${clock(x.start)}] ${x.label}: ${x.text}`).join('\n\n'));
    setCopied(true); setTimeout(() => setCopied(false), 1500);
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
              <div className="flex-1 min-w-0"><RecordingPlayer ref={player} meetingId={t.meeting_id} /></div>
              <DeleteRecordingButton meetingId={t.meeting_id} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">No audio stored for this call. <UploadRecordingButton meetingId={t.meeting_id} /></div>
          )}

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
            <span className="text-xs text-gray-400 tabular-nums">{turns.length} of {t.turns.length}</span>
            <Button size="xs" variant="secondary" onClick={copy}>{copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {copied ? 'Copied' : 'Copy'}</Button>
          </div>

          <ol className="space-y-2">
            {turns.length === 0 && <li className="text-sm text-gray-400 py-4 text-center">Nothing matches.</li>}
            {turns.map((x) => (
              <li key={x.i} className={cn('text-sm flex gap-3 rounded-md px-2 py-1.5', x.role === 'prospect' ? 'bg-green-50/60' : 'bg-transparent')}>
                {t.has_recording && x.start != null
                  ? <button onClick={() => player.current?.seek(x.start!)} title="Play from here" className="text-[11px] text-indigo-500 hover:text-indigo-700 hover:underline tabular-nums w-12 shrink-0 pt-0.5 text-right">{clock(x.start)}</button>
                  : <span className="text-[11px] text-gray-400 tabular-nums w-12 shrink-0 pt-0.5 text-right">{clock(x.start)}</span>}
                <div className="min-w-0">
                  <span className={cn('font-medium mr-1.5', x.role === 'prospect' ? 'text-green-800' : x.role === 'team' ? 'text-indigo-700' : 'text-gray-700')}>{x.label}</span>
                  <span className="text-gray-800 whitespace-pre-wrap"><Highlight text={x.text} q={find.trim()} /></span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
