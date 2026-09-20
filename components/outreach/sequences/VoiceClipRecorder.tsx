'use client';

// Item 25: one real recording per sender for a voice-note step. Record in the browser or upload a file (60 seconds at most),
// store it in the private `outreach-attachments` bucket and register it with the RPC save_voice_clip.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Mic, Play, Square, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from '@/lib/outreach/api';
import { TEXT_LIMITS } from '@/lib/outreach/nodes';
import type { Sender, VoiceClip } from '@/lib/outreach/types';
import { Avatar, Button, fmtDate } from '@/components/outreach/ui';
import { senderName } from './helpers';

const BUCKET = 'outreach-attachments';
const MAX_SECONDS = TEXT_LIMITS.voice_note_seconds;
const MAX_BYTES = 10 * 1024 * 1024;
/** Types the RPC accepts → file extension. */
const EXT: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
const RECORD_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

function baseMime(m: string): string { return m.split(';')[0].trim().toLowerCase(); }

function pickRecordType(): string | null {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return null;
  return RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

function fileDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return '';
  const n = Math.round(Number(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

interface Props {
  workspaceId: string;
  sequenceId: string;
  nodeId: string;
  /** The LinkedIn senders of the pool. */
  senders: Sender[];
  readOnly?: boolean;
}

export default function VoiceClipRecorder({ workspaceId, sequenceId, nodeId, senders, readOnly }: Props) {
  const qc = useQueryClient();
  const key = ['outreach', 'sequence', sequenceId, 'voice_clips', nodeId] as const;
  const clips = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_voice_clips').select('*').eq('sequence_id', sequenceId).eq('node_id', nodeId);
      if (error) throw parseError(error);
      return (data ?? []) as VoiceClip[];
    },
  });

  const [recording, setRecording] = useState<{ senderId: string; seconds: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState<{ senderId: string; url: string } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const canRecord = pickRecordType() != null && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const setError = (senderId: string, message: string | null) => setErrors((e) => { const n = { ...e }; if (message) n[senderId] = message; else delete n[senderId]; return n; });

  const cleanup = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
  }, []);
  useEffect(() => () => { try { recorder.current?.stop(); } catch { /* already stopped */ } cleanup(); }, [cleanup]);

  const save = useCallback(async (senderId: string, blob: Blob, mime: string, duration: number | null) => {
    const type = baseMime(mime);
    const ext = EXT[type];
    if (!ext) { setError(senderId, 'This audio type is not supported. Use M4A, MP3, OGG, WebM or WAV.'); return; }
    if (blob.size > MAX_BYTES) { setError(senderId, 'The file is larger than 10 MB. A 60 second voice note is far smaller than that.'); return; }
    if (duration != null && duration > MAX_SECONDS) { setError(senderId, `Voice notes are limited to ${MAX_SECONDS} seconds. This clip is ${Math.round(duration)} seconds.`); return; }
    setBusy(senderId); setError(senderId, null);
    try {
      const path = `${workspaceId}/voice/${sequenceId}/${nodeId}/${senderId}.${ext}`;
      const up = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: type, cacheControl: '0' });
      if (up.error) throw up.error;
      await rpc('save_voice_clip', { p_sequence: sequenceId, p_node_id: nodeId, p_sender: senderId, p_path: path, p_mime: type, p_duration: duration != null ? Math.round(duration * 10) / 10 : null, p_size: blob.size });
      setPlaying(null);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) { setError(senderId, parseError(e).message); }
    finally { setBusy(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, sequenceId, nodeId, qc]);

  const start = async (senderId: string) => {
    const type = pickRecordType();
    if (!type) return;
    setError(senderId, null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      const rec = new MediaRecorder(media, { mimeType: type });
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
      rec.onstop = () => {
        const seconds = Math.min(MAX_SECONDS, (Date.now() - startedAt.current) / 1000);
        cleanup();
        setRecording(null);
        if (seconds < 1 || chunks.length === 0) { setError(senderId, 'That was too short. Record at least a second.'); return; }
        void save(senderId, new Blob(chunks, { type: baseMime(type) }), type, seconds);
      };
      recorder.current = rec;
      startedAt.current = Date.now();
      rec.start();
      setRecording({ senderId, seconds: 0 });
      timer.current = setInterval(() => {
        const s = (Date.now() - startedAt.current) / 1000;
        if (s >= MAX_SECONDS) { try { rec.stop(); } catch { /* already stopped */ } return; }
        setRecording({ senderId, seconds: Math.floor(s) });
      }, 250);
    } catch (e) {
      cleanup(); setRecording(null);
      const name = (e as { name?: string })?.name;
      setError(senderId, name === 'NotAllowedError' ? 'The browser blocked the microphone. Allow microphone access for this site, or upload a file instead.' : name === 'NotFoundError' ? 'No microphone found. Upload a file instead.' : parseError(e).message);
    }
  };
  const stop = () => { try { recorder.current?.stop(); } catch { /* already stopped */ } };

  const onFile = async (senderId: string, file: File | undefined) => {
    if (!file) return;
    const type = baseMime(file.type || '');
    if (!EXT[type]) { setError(senderId, 'This audio type is not supported. Use M4A, MP3, OGG, WebM or WAV.'); return; }
    const duration = await fileDuration(file);
    if (duration == null) { setError(senderId, 'The browser could not read the length of this file, so the 60 second limit cannot be checked. Try an M4A or MP3 file.'); return; }
    await save(senderId, file, type, duration);
  };

  const play = async (clip: VoiceClip) => {
    if (playing?.senderId === clip.sender_id) { setPlaying(null); return; }
    setError(clip.sender_id, null);
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(clip.path, 300);
    if (error || !data?.signedUrl) { setError(clip.sender_id, error ? parseError(error).message : 'Could not open the clip.'); return; }
    setPlaying({ senderId: clip.sender_id, url: data.signedUrl });
  };

  if (senders.length === 0) return <p className="text-xs text-gray-500">Add a LinkedIn sender to the pool to record a clip for it.</p>;
  if (clips.isLoading) return <p className="text-xs text-gray-400">Loading clips…</p>;
  if (clips.error) return <p className="text-xs text-red-600" role="alert">{parseError(clips.error).message}</p>;

  const have = senders.filter((s) => clips.data?.some((c) => c.sender_id === s.id)).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-gray-700">Clips by sender</span>
        <span className={cn('tabular-nums', have === senders.length ? 'text-green-700' : 'text-amber-700')}>{have} of {senders.length} recorded</span>
      </div>
      <ul className="space-y-1.5">
        {senders.map((s) => {
          const clip = clips.data?.find((c) => c.sender_id === s.id) ?? null;
          const isRecording = recording?.senderId === s.id;
          const otherBusy = (recording != null && !isRecording) || (busy != null && busy !== s.id);
          return (
            <li key={s.id} className="rounded-lg border border-gray-200 p-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <Avatar src={s.picture_url} name={senderName(s)} size={6} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-gray-800 truncate">{senderName(s)}</div>
                  <div className={cn('text-[11px] flex items-center gap-1', clip ? 'text-green-700' : 'text-amber-700')}>
                    {clip ? <CheckCircle2 className="w-3 h-3" aria-hidden /> : <Circle className="w-3 h-3" aria-hidden />}
                    {clip ? `Clip ${fmtSeconds(clip.duration_s)} · saved ${fmtDate(clip.created_at)}` : 'No clip. This sender skips the step.'}
                  </div>
                </div>
                {clip && <button type="button" onClick={() => play(clip)} className="p-1.5 rounded text-gray-500 hover:bg-gray-100" aria-label={`${playing?.senderId === s.id ? 'Hide' : 'Play'} the clip of ${senderName(s)}`}><Play className="w-3.5 h-3.5" /></button>}
              </div>
              {playing?.senderId === s.id && <audio src={playing.url} controls autoPlay className="w-full h-8" />}
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {isRecording ? (
                    <Button type="button" size="sm" variant="danger" onClick={stop}><Square className="w-3 h-3" aria-hidden /> Stop · {fmtSeconds(recording.seconds)} / {fmtSeconds(MAX_SECONDS)}</Button>
                  ) : (
                    <Button type="button" size="sm" variant="secondary" disabled={!canRecord || otherBusy} loading={busy === s.id} onClick={() => start(s.id)} title={canRecord ? undefined : 'This browser cannot record audio. Upload a file instead.'}><Mic className="w-3 h-3" aria-hidden /> {clip ? 'Record again' : 'Record'}</Button>
                  )}
                  <input ref={(el) => { fileInputs.current[s.id] = el; }} type="file" accept="audio/mp4,audio/x-m4a,audio/m4a,audio/mpeg,audio/ogg,audio/webm,audio/wav,audio/x-wav,.m4a,.mp3,.ogg,.webm,.wav" className="sr-only" aria-label={`Upload a clip for ${senderName(s)}`} tabIndex={-1}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(s.id, f); }} />
                  <Button type="button" size="sm" variant="ghost" disabled={isRecording || otherBusy || busy === s.id} onClick={() => fileInputs.current[s.id]?.click()}><Upload className="w-3 h-3" aria-hidden /> Upload a file</Button>
                  {isRecording && <span className="text-[11px] text-red-600 flex items-center gap-1" aria-live="polite"><span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" /> Recording. Stops by itself at {MAX_SECONDS} seconds.</span>}
                </div>
              )}
              {errors[s.id] && <p className="text-xs text-red-600" role="alert">{errors[s.id]}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
