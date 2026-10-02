'use client';

// A visitor's voice call with the website assistant, as a card in the thread at the point the call started
// (web-chat-voice-elevenlabs-PRD.md §7.4). The card is the call's `event` message; the server keeps it current: live
// while the call runs, then the length, how it ended, the summary and the recording once the provider confirmed it.
// The recording is streamed through our proxy on demand and never stored by us.
import { useEffect, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { ENDED_BY, fetchCallAudio, fmtCallLength, type CallCard } from '@/lib/outreach/voice';

export default function VoiceCallCard({ a, id }: { a: CallCard; id: string }) {
  const [audio, setAudio] = useState<{ url?: string; error?: string; loading?: boolean }>({});
  useEffect(() => () => { if (audio.url) URL.revokeObjectURL(audio.url); }, [audio.url]);
  const live = a.status === 'live';
  const load = async () => {
    setAudio({ loading: true });
    try { setAudio({ url: await fetchCallAudio(a.call_id) }); }
    catch (e) { const pe = parseError(e); setAudio({ error: pe.code === 'E_RECORDING_EXPIRED' ? 'Recording expired.' : pe.message }); }
  };
  const parts = [fmtCallLength(a.duration_s), a.ended_reason ? ENDED_BY[a.ended_reason] ?? a.ended_reason : null, a.successful === 'success' ? 'resolved' : a.successful === 'failure' ? 'not resolved' : null].filter(Boolean);
  return (
    <div className="flex justify-center" id={`msg-${id}`}>
      <div className={cn('w-full max-w-md rounded-xl border px-3.5 py-2.5 text-sm shadow-sm', live ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-white')}>
        <div className="flex items-center gap-2 text-gray-900">
          <span className={cn('flex h-6 w-6 items-center justify-center rounded-full', live ? 'bg-emerald-600 text-white' : 'bg-indigo-50 text-indigo-700')}><Mic className="h-3.5 w-3.5" /></span>
          <span className="font-medium">{live ? 'Voice call in progress' : a.status === 'failed' ? 'Voice call did not connect' : 'Voice call'}</span>
          {!live && parts.length > 0 && <span className="text-xs text-gray-500">· {parts.join(' · ')}</span>}
          <span className="ml-auto text-xs text-gray-400" title={new Date(a.started_at).toLocaleString()}>{new Date(a.started_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        </div>
        {a.title && <div className="mt-1 text-xs font-medium text-gray-700">{a.title}</div>}
        {a.summary && <p className="mt-1 text-xs leading-relaxed text-gray-600"><span className="font-medium text-gray-700">Summary:</span> {a.summary}</p>}
        {live && <p className="mt-1 text-xs text-emerald-800">The live transcript appears below as the visitor and the assistant speak. Reply here to take over: the call switches to chat.</p>}
        {!live && !a.confirmed && a.status !== 'failed' && <p className="mt-1 text-xs text-gray-500">The confirmed transcript and summary follow in a few minutes.</p>}
        {a.confirmed && a.has_audio && (
          <div className="mt-2">
            {audio.url ? <audio controls src={audio.url} className="h-8 w-full" autoPlay />
              : audio.error ? <span className="text-xs text-gray-500">{audio.error}</span>
              : <button type="button" onClick={load} disabled={audio.loading} className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">
                  {audio.loading ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />} {audio.loading ? 'Loading…' : 'Play recording'}
                </button>}
          </div>
        )}
      </div>
    </div>
  );
}
