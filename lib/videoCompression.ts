/**
 * In-browser video compression (mediabunny), ported from outfit-maker-lab's src/lib/videoCompression.ts.
 *
 * The bitrate maths is deliberately conservative: it estimates the real on-disk bitrate of the source, scales it by
 * the resolution reduction, and never re-encodes above the source rate. If the re-encode still comes out bigger than
 * the input, the original file is handed back untouched.
 *
 * Differences from the outfit-maker-lab copy: the MP4 is always written with Fast Start (metadata first, so a <video>
 * can start playing before the whole file has downloaded), a re-encode that would silently drop the audio track
 * (a browser that cannot encode AAC) throws instead, and compressVideoForWeb() is the one-call preset for clips that
 * load on web pages. Load this module with a dynamic import(): mediabunny is only needed while a clip is uploading.
 */
import {
  Input as MediaInput,
  ALL_FORMATS,
  BlobSource,
  Conversion,
  BufferTarget,
  Output,
  Mp4OutputFormat,
} from 'mediabunny';

export type VideoQualityPreset = 'low' | 'medium' | 'high' | 'custom';
export type VideoSizePreset = '480p' | '720p' | '1080p' | '1440p' | '2160p' | 'original' | 'custom';

export interface VideoCompressionSettings {
  quality: VideoQualityPreset;
  /** Absolute target in kbps, used when `quality` is "custom" */
  customBitrate?: number;
  size: VideoSizePreset;
  customWidth?: number;
  customHeight?: number;
  removeAudio: boolean;
}

/** Compression ratios relative to the original bitrate (lower = smaller file) */
export const VIDEO_QUALITY_PRESETS: Record<VideoQualityPreset, number> = {
  low: 0.4, // 40% of original bitrate (aggressive compression)
  medium: 0.6, // 60% of original bitrate (balanced)
  high: 0.8, // 80% of original bitrate (light compression, higher quality)
  custom: 0, // user-specified absolute bitrate
};

export const VIDEO_SIZE_PRESETS: Record<VideoSizePreset, { width?: number; height?: number }> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
  original: {},
  custom: {},
};

export interface CompressVideoResult {
  file: File;
  size: number;
  /** True when re-encoding would have produced a larger file, so the input was kept as-is. */
  keptOriginal: boolean;
}

// H.264 and most codecs require even pixel dimensions; clamp to a sane minimum
// and round to the nearest even number to avoid encoder errors.
const makeEven = (n: number) => Math.max(2, Math.round(n / 2) * 2);

const MIN_VIDEO_BITRATE = 50_000; // 50 kbps

/** True when this browser has the WebCodecs encoder the re-encode needs. */
export function canCompressVideo(): boolean {
  return typeof window !== 'undefined' && typeof (window as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined';
}

export async function compressVideoFile(
  file: File,
  settings: VideoCompressionSettings,
  onProgress?: (percent: number) => void,
): Promise<CompressVideoResult> {
  const report = (percent: number) => onProgress?.(Math.round(percent));

  report(10);

  // Set up the input to inspect dimensions, duration and tracks.
  const input = new MediaInput({ source: new BlobSource(file), formats: ALL_FORMATS });

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('File has no video track');

  const originalWidth = videoTrack.displayWidth;
  const originalHeight = videoTrack.displayHeight;

  // Determine target dimensions (never upscale beyond the original).
  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (settings.size === 'custom') {
    targetWidth = Math.min(settings.customWidth || originalWidth, originalWidth);
    targetHeight = Math.min(settings.customHeight || originalHeight, originalHeight);
  } else if (settings.size !== 'original') {
    const preset = VIDEO_SIZE_PRESETS[settings.size];
    if (preset.width && preset.height) {
      if (originalWidth <= preset.width && originalHeight <= preset.height) {
        // Source is already smaller than the preset, keep its size.
        targetWidth = originalWidth;
        targetHeight = originalHeight;
      } else {
        const aspectRatio = originalWidth / originalHeight;
        if (preset.width / preset.height > aspectRatio) {
          targetHeight = preset.height;
          targetWidth = Math.round(preset.height * aspectRatio);
        } else {
          targetWidth = preset.width;
          targetHeight = Math.round(preset.width / aspectRatio);
        }
      }
    }
  }

  targetWidth = makeEven(targetWidth);
  targetHeight = makeEven(targetHeight);

  // --- Robust source-bitrate estimation ---
  // The most reliable reference for "don't make the file bigger" is the real
  // on-disk bitrate: total bytes over the full duration. This captures video,
  // audio and container overhead, and is O(1) (no full scan needed).
  let durationSec = 0;
  try {
    durationSec = await input.computeDuration();
  } catch {
    durationSec = 0;
  }
  const sourceTotalBitrate = durationSec > 0 ? (file.size * 8) / durationSec : 0;

  // Does the source actually contain an audio track?
  const audioTrack = await input.getPrimaryAudioTrack().catch(() => null);
  const hasAudio = !!audioTrack;
  const keepAudio = hasAudio && !settings.removeAudio;

  // Sample the source audio bitrate so we can (a) subtract it from the total to
  // isolate the video portion and (b) avoid re-encoding audio louder than it
  // already is.
  let sourceAudioBitrate = 0;
  if (hasAudio && audioTrack) {
    try {
      const audioStats = await audioTrack.computePacketStats(100);
      if (audioStats.averageBitrate > 0) sourceAudioBitrate = audioStats.averageBitrate;
    } catch {
      sourceAudioBitrate = 128_000; // reasonable fallback
    }
  }

  // Isolate the source video bitrate; fall back to a packet sample, then a sane
  // default, so we always have a positive reference value.
  let sourceVideoBitrate = Math.max(0, sourceTotalBitrate - sourceAudioBitrate);
  if (sourceVideoBitrate <= 0) {
    try {
      const stats = await videoTrack.computePacketStats(100);
      sourceVideoBitrate = stats.averageBitrate || 0;
    } catch {
      sourceVideoBitrate = 0;
    }
  }
  if (!(sourceVideoBitrate > 0)) sourceVideoBitrate = 2_000_000; // 2 Mbps fallback

  // Scale the reference bitrate by the resolution reduction so that choosing a
  // smaller size actually yields a smaller file.
  const sourcePixels = originalWidth * originalHeight;
  const targetPixels = targetWidth * targetHeight;
  const resolutionScale = sourcePixels > 0 ? Math.min(1, targetPixels / sourcePixels) : 1;
  const scaledSourceVideoBitrate = sourceVideoBitrate * resolutionScale;

  // Compute the desired video bitrate.
  let videoBitrate: number;
  if (settings.quality === 'custom') {
    // Explicit absolute request (kbps -> bps), capped at the source video
    // bitrate so we never re-encode at a higher rate than the original.
    const requested = (settings.customBitrate || 1500) * 1000;
    videoBitrate = Math.min(requested, sourceVideoBitrate);
  } else {
    videoBitrate = scaledSourceVideoBitrate * VIDEO_QUALITY_PRESETS[settings.quality];
  }

  // mediabunny requires a positive integer bitrate; enforce a practical floor
  // and coerce to an integer.
  videoBitrate = Math.max(MIN_VIDEO_BITRATE, Math.round(videoBitrate));

  // Target audio bitrate: 96 or 128 kbps, the lower one for a lighter source. Only these steps: the Windows AAC
  // encoder Chrome uses takes 96/128/160/192 kbps and refuses anything in between (the track is then dropped).
  const audioBitrate = keepAudio && (sourceAudioBitrate <= 0 || sourceAudioBitrate > 112_000) ? 128_000 : 96_000;

  report(30);

  // AAC sound at a sane rate is copied as it is: no audio encoder needed, no quality lost, and it is a small part of
  // the file. Anything else is transcoded to AAC.
  const copyAudio = keepAudio && audioTrack?.codec === 'aac' && sourceAudioBitrate <= 192_000;

  // In-memory MP4 with the metadata first, so playback can start while the rest downloads.
  let bufferTarget = new BufferTarget();
  const init = () => {
    bufferTarget = new BufferTarget();
    return Conversion.init({
      input,
      output: new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: bufferTarget }),
      video: { codec: 'avc', bitrate: videoBitrate, width: targetWidth, height: targetHeight, fit: 'contain' },
      // Explicitly discard audio when stripping (omitting the key would COPY the
      // track, not drop it); otherwise copy AAC or transcode to AAC at the capped bitrate.
      // AAC is forced because mediabunny otherwise defaults to Opus, which is
      // valid in MP4 but won't play in Windows Media Player, QuickTime, and many
      // other players (VLC handles it).
      audio: !keepAudio ? { discard: true } : copyAudio ? {} : { codec: 'aac', bitrate: audioBitrate },
    });
  };
  // A browser that cannot encode AAC drops the audio track and still calls the conversion valid. Chrome's first
  // encoder check after start-up can come back negative, so ask once more before giving up.
  const lostAudio = (c: Conversion) => keepAudio && c.discardedTracks.some((d) => d.track === audioTrack);
  let conversion = await init();
  if (conversion.isValid && lostAudio(conversion)) {
    await new Promise((r) => setTimeout(r, 300));
    conversion = await init();
  }

  if (!conversion.isValid) {
    console.error('Conversion invalid, discarded tracks:', { discardedTracks: conversion.discardedTracks });
    throw new Error('Video conversion is not valid for this file.');
  }
  if (lostAudio(conversion)) throw new Error('This browser cannot keep the sound of this video.');

  conversion.onProgress = (p: number) => {
    report(Math.min(30 + p * 60, 90)); // 30 to 90
  };

  report(40);

  await conversion.execute();

  report(90);

  const buffer = bufferTarget.buffer;
  if (!buffer) throw new Error('Failed to retrieve converted video buffer');

  // Guarantee we never hand back a larger file: if re-encoding didn't shrink
  // it, keep the original untouched.
  if (buffer.byteLength >= file.size) {
    report(100);
    return { file, size: file.size, keptOriginal: true };
  }

  const compressedFile = new File([buffer], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' });

  report(100);

  return { file: compressedFile, size: compressedFile.size, keptOriginal: false };
}

/**
 * The preset for clips that load on web pages: the short side at most `maxShortSide` (portrait and landscape alike),
 * H.264 at a bitrate scaled from `maxBitrate` (bps at 1280×720) by the output's pixel count, AAC sound, Fast Start.
 * Hands back the original when the re-encode saves less than `minSaving` (0.1 = 10%), so a clip that is already
 * light is not re-encoded for nothing.
 */
export async function compressVideoForWeb(
  file: File,
  opts: { maxShortSide?: number; maxBitrate?: number; minSaving?: number } = {},
  onProgress?: (percent: number) => void,
): Promise<CompressVideoResult> {
  const { maxShortSide = 720, maxBitrate = 1_500_000, minSaving = 0.1 } = opts;
  const probe = new MediaInput({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await probe.getPrimaryVideoTrack();
  if (!track) throw new Error('File has no video track');
  const w = track.displayWidth, h = track.displayHeight;
  const scale = Math.min(1, maxShortSide / Math.max(1, Math.min(w, h)));
  const width = makeEven(w * scale), height = makeEven(h * scale);
  const kbps = Math.max(300, Math.round((maxBitrate * (width * height)) / (1280 * 720) / 1000));
  const r = await compressVideoFile(file, { quality: 'custom', customBitrate: kbps, size: 'custom', customWidth: width, customHeight: height, removeAudio: false }, onProgress);
  return !r.keptOriginal && r.size > file.size * (1 - minSaving) ? { file, size: file.size, keptOriginal: true } : r;
}
