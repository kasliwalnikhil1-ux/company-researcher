#!/usr/bin/env node
// Builds the four reply-alert sounds (reply-notifications-PRD.md §4.2: Ping, Chime, Pop, Knock — under 1 s and 30 KB each)
// into public/sounds/alerts/*.wav. Synthesised, so they are ours to ship and reproducible:
//   node scripts/outreach-alert-sounds.mjs
// 16 kHz mono 16-bit PCM WAV: every browser plays it, and the tones sit well below the 8 kHz Nyquist limit.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 16000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds', 'alerts');

function render(seconds, fn) {
  const n = Math.round(seconds * RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / RATE);
  // 4 ms fade-out so the end never clicks; normalise the peak to 0.85 (the app scales by the person's volume)
  const fade = Math.round(0.004 * RATE);
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] = (out[i] / (peak || 1)) * 0.85;
  return out;
}

const env = (t, attack, tau) => (t < attack ? t / attack : Math.exp(-(t - attack) / tau));
const sine = (f, t) => Math.sin(2 * Math.PI * f * t);
// a small bell: inharmonic partials that die away faster the higher they are
const bell = (f, t, tau) => env(t, 0.003, tau) * (sine(f, t) + 0.35 * sine(f * 2.0, t) * Math.exp(-t / (tau * 0.6)) + 0.12 * sine(f * 2.76, t) * Math.exp(-t / (tau * 0.35)));

let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };

const SOUNDS = {
  // one clear high note
  ping: render(0.5, (t) => env(t, 0.004, 0.11) * (sine(1568, t) + 0.25 * sine(3136, t) * Math.exp(-t / 0.05))),
  // two rising bell notes
  chime: render(0.8, (t) => bell(1046.5, t, 0.22) + (t >= 0.13 ? 0.9 * bell(1318.5, t - 0.13, 0.28) : 0)),
  // a short bubble: falling pitch, quick decay
  pop: render(0.16, (t) => {
    // instantaneous frequency 280 + 620·e^(−t/25 ms): the phase is its integral
    const phase = 2 * Math.PI * (280 * t + 620 * 0.025 * (1 - Math.exp(-t / 0.025)));
    return env(t, 0.002, 0.035) * Math.sin(phase);
  }),
  // two soft knocks on wood
  knock: (() => {
    const hit = (t) => {
      if (t < 0) return 0;
      const body = env(t, 0.001, 0.028) * (sine(190, t) + 0.6 * sine(310, t) + 0.3 * sine(520, t));
      return body + 0.25 * env(t, 0.0005, 0.006) * noise();
    };
    return render(0.36, (t) => hit(t) + 0.85 * hit(t - 0.15));
  })(),
};

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, samples] of Object.entries(SOUNDS)) {
  const buf = wav(samples);
  if (buf.length > 30 * 1024) throw new Error(`${name}.wav is ${buf.length} bytes (limit 30 KB)`);
  if (samples.length / RATE >= 1) throw new Error(`${name}.wav is not under 1 s`);
  writeFileSync(join(OUT, `${name}.wav`), buf);
  console.log(`${name}.wav  ${(samples.length / RATE).toFixed(2)} s  ${(buf.length / 1024).toFixed(1)} KB`);
}
