'use client';

// "Frame the clip": the whole clip plays with a box the shape of the bubble over it. Dragging and resizing the box sets
// the bubble's focus and zoom, the same three settings the sliders in the Bubble card edit, so the widget needs nothing new.
//
// The bubble draws the clip with object-fit: cover, object-position fx% fy% and scale(z) around that same point. In the
// clip's own coordinates that shows a window c0/z wide (c0 = the share of the clip that cover keeps, per axis) whose
// left edge sits at fx · (1 − c0/z): exactly a crop box sliding over the clip, which is what the box here is.
import { useState } from 'react';
import ReactCrop, { type PercentCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Modal } from '@/components/outreach/ui';
import { mediaUrl, type VideoBubbleSettings } from '@/lib/outreach/webchat';

export type Framing = Pick<VideoBubbleSettings, 'zoom' | 'focus_x' | 'focus_y'>;
const ZOOM_MIN = 100, ZOOM_MAX = 300;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Width : height of the bubble (a circle is always 1:1). */
export function bubbleAspect(v: Pick<VideoBubbleSettings, 'shape' | 'ratio'>): number {
  if (v.shape === 'circle') return 1;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(v.ratio ?? '');
  return m && +m[1] && +m[2] ? +m[1] / +m[2] : 1;
}

/** Share of the clip's width and height that object-fit: cover keeps in a bubble of aspect `r`, at zoom 100%. */
function coverShare(clipAspect: number, r: number) {
  return clipAspect > r ? { w: r / clipAspect, h: 1 } : { w: 1, h: clipAspect / r };
}
function toCrop(f: Framing, c0: { w: number; h: number }): PercentCrop {
  const z = clamp(f.zoom, ZOOM_MIN, ZOOM_MAX) / 100, w = c0.w / z, h = c0.h / z;
  return { unit: '%', width: w * 100, height: h * 100, x: (f.focus_x / 100) * (1 - w) * 100, y: (f.focus_y / 100) * (1 - h) * 100 };
}
function toFraming(c: PercentCrop, c0: { w: number; h: number }): Framing {
  const w = c.width / 100, h = c.height / 100;
  const focus = (pos: number, size: number) => (size < 0.999 ? Math.round(clamp(pos / 100 / (1 - size), 0, 1) * 100) : 50);
  return { zoom: Math.round(clamp((c0.w / w) * 100, ZOOM_MIN, ZOOM_MAX)), focus_x: focus(c.x, w), focus_y: focus(c.y, h) };
}

/** Mounted only while open (the parent renders it conditionally), so every opening starts from the current framing. */
export default function ClipFramer({ clip, bubble, onCancel, onConfirm }: {
  clip: { url: string; kind: 'video' | 'image' }; bubble: VideoBubbleSettings; onCancel: () => void; onConfirm: (f: Framing) => void;
}) {
  const src = mediaUrl(clip.url);
  const r = bubbleAspect(bubble), circle = bubble.shape === 'circle';
  const [clipAspect, setClipAspect] = useState<number | null>(null);
  const [shownWidth, setShownWidth] = useState(0);
  const [crop, setCrop] = useState<PercentCrop>();
  const c0 = clipAspect ? coverShare(clipAspect, r) : null;
  const framing = crop && c0 ? toFraming(crop, c0) : { zoom: bubble.zoom, focus_x: bubble.focus_x, focus_y: bubble.focus_y };

  const onMedia = (w: number, h: number, el: HTMLElement) => {
    if (!w || !h) return;
    const a = w / h, share = coverShare(a, r);
    setClipAspect(a);
    setCrop(toCrop({ zoom: bubble.zoom, focus_x: bubble.focus_x, focus_y: bubble.focus_y }, share));
    requestAnimationFrame(() => setShownWidth(el.clientWidth));
  };
  // the slider zooms around the box's centre
  const setZoom = (zoom: number) => {
    if (!crop || !c0) return;
    const z = zoom / 100, w = (c0.w / z) * 100, h = (c0.h / z) * 100;
    const cx = crop.x + crop.width / 2, cy = crop.y + crop.height / 2;
    setCrop({ unit: '%', width: w, height: h, x: clamp(cx - w / 2, 0, 100 - w), y: clamp(cy - h / 2, 0, 100 - h) });
  };
  // the big one (measure = true) sizes the box; the small one is the bubble preview
  const media = (style: React.CSSProperties, measure = false) => clip.kind === 'image'
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={src ?? ''} alt="" style={style} onLoad={measure ? (e) => onMedia(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight, e.currentTarget) : undefined} />
    : <video src={src ?? ''} style={style} autoPlay muted loop playsInline onLoadedMetadata={measure ? (e) => onMedia(e.currentTarget.videoWidth, e.currentTarget.videoHeight, e.currentTarget) : undefined} />;
  const focusAt = `${framing.focus_x}% ${framing.focus_y}%`;

  return (
    <Modal open={!!src} onClose={onCancel} title="Frame the clip" size="xl"
      footer={<>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onConfirm(framing)} disabled={!crop}><Check className="w-3.5 h-3.5" /> Use this framing</Button>
      </>}>
      {src && (
        <div className="grid gap-4 md:grid-cols-[1fr_180px]">
          <div className="space-y-2 min-w-0">
            <p className="text-xs text-gray-500">The {circle ? 'circle' : 'box'} is what the bubble shows. Drag it onto the presenter, and pull a corner (or use the slider) to show more or less of the clip.</p>
            <div className="flex justify-center bg-gray-900 rounded-lg">
              <ReactCrop crop={crop} onChange={(_, pct) => setCrop(pct)} aspect={r} circularCrop={circle} keepSelection
                minWidth={c0 && shownWidth ? (c0.w * shownWidth * ZOOM_MIN) / ZOOM_MAX : undefined} maxWidth={c0 && shownWidth ? c0.w * shownWidth : undefined}>
                {media({ display: 'block', maxWidth: '100%', maxHeight: '55vh' }, true)}
              </ReactCrop>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-gray-700 w-12">Zoom</span>
              <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={5} value={framing.zoom} onChange={(e) => setZoom(Number(e.target.value))} disabled={!crop} className="flex-1 accent-indigo-600" aria-label="Zoom" />
              <span className="w-12 text-right text-xs tabular-nums text-gray-600">{framing.zoom}%</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium text-gray-700">How the bubble looks</div>
            <div className={cn('w-full overflow-hidden bg-gray-900 shadow-md', circle ? 'rounded-full' : bubble.shape === 'square' ? 'rounded-[10px]' : 'rounded-[22%]')} style={{ aspectRatio: String(r) }}>
              {media({ display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: focusAt, transform: `scale(${framing.zoom / 100})`, transformOrigin: focusAt })}
            </div>
            <p className="text-[11px] text-gray-500 tabular-nums">Zoom {framing.zoom}% · focus {framing.focus_x}% across, {framing.focus_y}% down</p>
          </div>
        </div>
      )}
    </Modal>
  );
}
