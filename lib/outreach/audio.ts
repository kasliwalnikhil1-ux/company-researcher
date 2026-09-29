'use client';

// Browser-side audio conversion for voice notes. WhatsApp plays MP3 / M4A voice notes reliably, while browsers record WebM or
// Opus-in-MP4, so clips for WhatsApp senders are re-encoded to MP3 before upload. The edge functions cannot transcode.

/** Mono MP3 at voice quality. The encoder is loaded only when a clip is converted. */
export async function toMp3(input: Blob, kbps = 64): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let audio: AudioBuffer;
  try { audio = await ctx.decodeAudioData(await input.arrayBuffer()); }
  finally { void ctx.close(); }

  // down-mix to mono and convert float samples to 16-bit PCM
  const n = audio.length;
  const pcm = new Int16Array(n);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of channels) s += c[i];
    s = Math.max(-1, Math.min(1, s / channels.length));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const enc = new Mp3Encoder(1, audio.sampleRate, kbps);
  const parts: BlobPart[] = [];
  const FRAME = 1152;
  for (let i = 0; i < n; i += FRAME) {
    const out = enc.encodeBuffer(pcm.subarray(i, i + FRAME));
    if (out.length) parts.push(new Uint8Array(out));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return new Blob(parts, { type: 'audio/mpeg' });
}
