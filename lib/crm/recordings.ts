'use client';

import { supabase } from '@/utils/supabase/client';
import { CrmError } from './api';

// Call audio lives in the studio's private Oracle bucket. The browser never holds the bucket key: crm-mcp hands out a
// short-lived presigned URL, and the file goes straight from here to Oracle (the same routes the crm skill's script uses).

const BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/crm-mcp/recording`;
export const MAX_RECORDING_MB = 300;

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new CrmError('Please sign in again', 'E_UNAUTHORIZED');
  const r = await fetch(`${BASE}/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new CrmError(j.message ?? `Request failed (${r.status})`, j.code ?? 'E_UNKNOWN');
  return j as T;
}

/** Length of an audio file, read locally before upload. Best effort: undefined when the browser cannot decode it. */
function mediaDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const el = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const done = (v?: number) => { URL.revokeObjectURL(url); resolve(v && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined); };
    el.preload = 'metadata'; el.onloadedmetadata = () => done(el.duration); el.onerror = () => done();
    setTimeout(() => done(), 8000);
    el.src = url;
  });
}

export const MAX_VIDEO_MB = 2048;
export type UploadPhase = 'uploading' | 'transcribing';

function put(url: string, file: File, contentType: string, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();   // fetch() has no upload progress
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new CrmError(`Storage refused the upload (${xhr.status})`, 'E_STORAGE')));
    xhr.onerror = () => reject(new CrmError('The upload was interrupted — check the connection and try again', 'E_STORAGE'));
    xhr.send(file);
  });
}

/** Transcribe on the server (Deepgram, speakers separated) and save it as the meeting's transcript. No key = the stored audio. */
export const transcribeRecording = (meetingId: string, key?: string, filename?: string) =>
  call<{ transcript: { turn_count: number; duration_seconds?: number; speakers: number } }>('transcribe', { meeting_id: meetingId, key, filename });

/**
 * Audio: upload-url → PUT straight to storage (with progress) → confirm → transcribe.
 * Video: only the audio is ever kept, so a video goes to a temporary key, is transcribed on the server, and is deleted —
 * the meeting gets a transcript but no playable audio.
 * The upload counts even if transcription fails: that error comes back in `transcriptError`, not as a throw.
 */
export async function uploadRecording(meetingId: string, file: File, onProgress?: (fraction: number) => void, onPhase?: (phase: UploadPhase) => void): Promise<{ kept: boolean; transcriptError?: string }> {
  // some browsers (Windows especially) give an .m4a / .flac / .opus file no type at all — fall back to the extension
  const byExt: Record<string, string> = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', aac: 'audio/aac', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', m4v: 'video/mp4', avi: 'video/x-msvideo' };
  const contentType = file.type || byExt[file.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
  const isVideo = contentType.startsWith('video/');
  const limit = isVideo ? MAX_VIDEO_MB : MAX_RECORDING_MB;
  if (file.size > limit * 1024 * 1024) throw new CrmError(`That file is ${Math.round(file.size / 1048576)} MB; the limit is ${limit} MB.${isVideo ? '' : ' Export the audio only — an hour of call audio is about 15 MB.'}`, 'E_TOO_LARGE');
  onPhase?.('uploading');

  if (isVideo) {
    const grant = await call<{ put_url: string; key: string }>('upload-url', { meeting_id: meetingId, content_type: contentType, filename: file.name, bytes: file.size, purpose: 'transcribe' });
    await put(grant.put_url, file, contentType, onProgress);
    onPhase?.('transcribing');
    await transcribeRecording(meetingId, grant.key, file.name);   // a video that cannot be transcribed has nothing to keep: let it throw
    return { kept: false };
  }

  const [grant, duration] = await Promise.all([
    call<{ put_url: string; key: string }>('upload-url', { meeting_id: meetingId, content_type: contentType, filename: file.name, bytes: file.size }),
    mediaDuration(file),
  ]);
  await put(grant.put_url, file, contentType, onProgress);
  await call('confirm', { meeting_id: meetingId, key: grant.key, content_type: contentType, filename: file.name, duration_seconds: duration });
  onPhase?.('transcribing');
  try { await transcribeRecording(meetingId); return { kept: true }; }
  catch (e) { return { kept: true, transcriptError: e instanceof Error ? e.message : String(e) }; }
}

export interface RecordingInfo { bytes?: number; content_type?: string; duration_seconds?: number; original_name?: string; uploaded_via?: 'app' | 'skill'; uploaded_by?: string; created_at: string }

/** A private link that works for a few hours — fetch it when the player opens, never store it. */
export const getRecordingUrl = (meetingId: string) => call<{ url: string; expires_in: number; recording: RecordingInfo }>('play-url', { meeting_id: meetingId });

export const deleteRecording = (meetingId: string) => call<{ deleted: boolean }>('delete', { meeting_id: meetingId });
