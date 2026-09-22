'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qk, useCrmInvalidate } from '@/lib/crm/queries';
import { parseError } from '@/lib/crm/api';
import { MAX_RECORDING_MB, deleteRecording, getRecordingUrl, uploadRecording } from '@/lib/crm/recordings';
import { Button, ErrorBox, Modal, Spinner } from './ui';
import { Trash2, Upload } from 'lucide-react';

// Call audio for a meeting. The file is in the studio's private Oracle bucket; this only ever holds a link that expires.

export const fmtBytes = (b: number | null | undefined) => (b == null ? '' : b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

export interface PlayerHandle { seek: (seconds: number) => void }

/** Native audio controls; `seek` lets the transcript jump to the moment a line was said, `onTime` follows playback (every frame while playing). */
export const RecordingPlayer = forwardRef<PlayerHandle, { meetingId: string; onTime?: (seconds: number, playing: boolean) => void }>(function RecordingPlayer({ meetingId, onTime }, ref) {
  const el = useRef<HTMLAudioElement>(null);
  const raf = useRef<number | null>(null);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  // the link is good for 6 hours; refetch well inside that, and never keep a stale one around
  const q = useQuery({ queryKey: qk.recordingUrl(meetingId), queryFn: () => getRecordingUrl(meetingId), staleTime: 60 * 60_000, gcTime: 0, retry: false });
  useImperativeHandle(ref, () => ({ seek: (s) => { const a = el.current; if (!a) return; a.currentTime = Math.max(0, s); void a.play().catch(() => {}); } }), []);

  const stopLoop = () => { if (raf.current != null) cancelAnimationFrame(raf.current); raf.current = null; };
  const report = () => { const a = el.current; if (a) onTimeRef.current?.(a.currentTime, !a.paused); };
  const startLoop = () => { stopLoop(); const tick = () => { report(); raf.current = requestAnimationFrame(tick); }; raf.current = requestAnimationFrame(tick); };
  useEffect(() => stopLoop, []);

  if (q.isLoading) return <div className="h-10 flex items-center text-xs text-gray-400">Loading audio…</div>;
  if (q.isError) return <ErrorBox message={`Could not load the audio: ${(q.error as Error).message}`} />;
  const r = q.data!.recording;
  return (
    <div>
      <audio ref={el} controls preload="metadata" src={q.data!.url} className="w-full h-10"
        onPlay={startLoop} onPause={() => { stopLoop(); report(); }} onEnded={() => { stopLoop(); report(); }} onSeeked={report} />
      <div className="text-[11px] text-gray-400 mt-0.5">{[r.original_name, fmtBytes(r.bytes), r.uploaded_by ? `uploaded by ${r.uploaded_by}` : null, r.uploaded_via === 'skill' ? 'via Claude' : null].filter(Boolean).join(' · ')}</div>
    </div>
  );
});

/** Pick an audio file and send it straight to storage (video is refused: only audio is kept). `replace` only changes the wording. */
export function UploadRecordingButton({ meetingId, replace, size = 'xs' }: { meetingId: string; replace?: boolean; size?: 'xs' | 'sm' }) {
  const input = useRef<HTMLInputElement>(null);
  const invalidate = useCrmInvalidate();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setProgress(0);
    try { await uploadRecording(meetingId, file, setProgress); await invalidate(); }
    catch (e) { setError(parseError(e).message); }
    finally { setProgress(null); if (input.current) input.current.value = ''; }
  };

  return (
    <>
      <input ref={input} type="file" accept="audio/*,.m4a,.mp3,.wav,.flac,.ogg,.opus,.aac" className="hidden" onChange={(e) => onPick(e.target.files?.[0])} />
      <Button size={size} variant="secondary" disabled={progress !== null} onClick={() => input.current?.click()} title={`Audio only (m4a, mp3, wav…), up to ${MAX_RECORDING_MB} MB — an hour is about 15 MB. Have a video? Give it to Claude; it keeps just the audio.`}>
        <Upload className="w-3 h-3" /> {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : replace ? 'Replace audio' : 'Add recording'}
      </Button>
      {error && <span className="text-xs text-red-600 basis-full">{error}</span>}
    </>
  );
}

export function DeleteRecordingButton({ meetingId, onDeleted }: { meetingId: string; onDeleted?: () => void }) {
  const invalidate = useCrmInvalidate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!window.confirm('Delete this call audio? The transcript and the capture stay.')) return;
    setBusy(true); setError(null);
    try { await deleteRecording(meetingId); await invalidate(); onDeleted?.(); } catch (e) { setError(parseError(e).message); } finally { setBusy(false); }
  };
  return <><Button size="xs" variant="ghost" loading={busy} onClick={run}><Trash2 className="w-3 h-3" /> Delete audio</Button>{error && <span className="text-xs text-red-600">{error}</span>}</>;
}

/** For a meeting that has audio but no transcript yet. (With a transcript, the player sits inside TranscriptModal.) */
export function RecordingModal({ meetingId, title, onClose }: { meetingId: string | null; title?: string; onClose: () => void }) {
  return (
    <Modal open={!!meetingId} onClose={onClose} size="lg" title={<>Recording{title ? ` · ${title}` : ''}</>}
      footer={meetingId ? <><DeleteRecordingButton meetingId={meetingId} onDeleted={onClose} /><UploadRecordingButton meetingId={meetingId} replace /></> : undefined}>
      {meetingId ? (
        <div className="space-y-2">
          <RecordingPlayer meetingId={meetingId} />
          <p className="text-xs text-gray-500">No transcript yet. In Claude, say “transcribe the recording for this meeting” — it fetches this audio, transcribes it and fills the capture.</p>
        </div>
      ) : <Spinner />}
    </Modal>
  );
}
