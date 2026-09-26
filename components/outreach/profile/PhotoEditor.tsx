'use client';

// Photo / cover tools (PRD §8.1): upload to the private bucket, pick one of the seven filters with a live preview,
// brightness / contrast / saturation / vignette sliders, crop corners. Nothing here touches LinkedIn: the result is a
// storage path in assets and picture_settings in the payload, applied only when the change is submitted and scheduled.
import { useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/outreach/ui';
import { FILTER_CSS, IMAGE_RULES, PICTURE_FILTERS, signedAssetUrl, uploadProfileAsset, type PictureFilter, type PictureSettings } from '@/lib/outreach/profile';
import { cn } from '@/lib/utils';

type Notify = (message: string, type?: 'success' | 'error') => void;

export default function PhotoEditor({ kind, ws, senderId, currentUrl, assetPath, settings, onAsset, onSettings, onPreviewUrl, disabled, notify }: {
  kind: 'photo' | 'cover'; ws: string; senderId: string; currentUrl: string | null; assetPath: string | undefined; settings: PictureSettings | undefined;
  onAsset: (path: string | undefined) => void; onSettings: (s: PictureSettings | undefined) => void; onPreviewUrl: (url: string | null) => void; disabled?: boolean; notify: Notify;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const shown = localUrl ?? currentUrl;
  const s = settings ?? {};
  const patch = (p: Partial<PictureSettings>) => { const next = { ...s, ...p }; for (const k of Object.keys(next) as Array<keyof PictureSettings>) if (next[k] === undefined) delete next[k]; onSettings(Object.keys(next).length ? next : undefined); };

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const r = await uploadProfileAsset(ws, senderId, f, kind);
      onAsset(r.path);
      const url = (await signedAssetUrl(r.path)) ?? URL.createObjectURL(f);
      setLocalUrl(url); onPreviewUrl(url);
      notify(`${kind === 'photo' ? 'Photo' : 'Cover'} uploaded (${r.width}×${r.height}). It reaches LinkedIn only when you submit the change.`);
    } catch (err) { notify((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  function clear() { onAsset(undefined); setLocalUrl(null); onPreviewUrl(null); }

  const filterCss = (f: PictureFilter) => [FILTER_CSS[f], typeof s.brightness === 'number' ? `brightness(${1 + s.brightness / 100})` : '', typeof s.contrast === 'number' ? `contrast(${1 + s.contrast / 100})` : '', typeof s.saturation === 'number' ? `saturate(${1 + s.saturation / 100})` : ''].filter(Boolean).join(' ');

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <div className={cn('bg-gray-100 overflow-hidden flex-shrink-0 border border-gray-200', kind === 'photo' ? 'w-24 h-24 rounded-full' : 'w-48 h-12 rounded-lg')}>
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="" className="w-full h-full object-cover" style={{ filter: filterCss(s.filter ?? 'ORIGINAL') || undefined }} />
          ) : <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">none</div>}
        </div>
        <div className="text-xs text-gray-600 space-y-2">
          <div>{IMAGE_RULES[kind].hint}</div>
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={pick} />
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={busy} disabled={disabled || busy}><ImagePlus className="w-3.5 h-3.5" /> {assetPath ? 'Replace' : 'Upload'} {kind === 'photo' ? 'photo' : 'cover'}</Button>
            {assetPath && <Button size="sm" variant="ghost" onClick={clear} disabled={disabled}><Trash2 className="w-3.5 h-3.5" /> Remove upload</Button>}
          </div>
          {assetPath && <div className="text-[11px] text-green-700">Uploaded and kept, so a rollback can restore this exact image.</div>}
        </div>
      </div>

      {kind === 'photo' && (
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1.5">Filter</div>
          <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
            {PICTURE_FILTERS.map((f) => (
              <button key={f} type="button" disabled={disabled} onClick={() => patch({ filter: f === 'ORIGINAL' ? undefined : f })} className={cn('rounded-lg border p-1 text-[10px] text-gray-700', (s.filter ?? 'ORIGINAL') === f ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-gray-200')} aria-pressed={(s.filter ?? 'ORIGINAL') === f}>
                <div className="w-full aspect-square rounded-md bg-gray-100 overflow-hidden mb-1">
                  {shown ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={shown} alt="" className="w-full h-full object-cover" style={{ filter: FILTER_CSS[f] || undefined }} />
                  ) : <div className="w-full h-full" style={{ filter: FILTER_CSS[f] || undefined, background: 'linear-gradient(135deg,#f59e0b,#3b82f6)' }} />}
                </div>
                {f.charAt(0) + f.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">The preview approximates the filters. LinkedIn renders the final result.</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {(['brightness', 'contrast', 'saturation', 'vignette'] as const).map((k) => (
          <label key={k} className="block text-xs text-gray-600">
            <div className="flex justify-between"><span className="capitalize">{k}</span><span className="tabular-nums text-gray-900">{s[k] ?? 0}</span></div>
            <input type="range" min={k === 'vignette' ? 0 : -100} max={100} step={1} value={s[k] ?? 0} disabled={disabled} onChange={(e) => patch({ [k]: Number(e.target.value) === 0 ? undefined : Number(e.target.value) })} className="w-full accent-indigo-600" aria-label={`${k} for ${kind}`} />
          </label>
        ))}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-gray-600">Crop (corner coordinates, 0 to 1)</summary>
        <div className="grid grid-cols-4 gap-2 mt-2">
          {(['topLeft', 'bottomRight'] as const).map((corner) => (['x', 'y'] as const).map((axis) => (
            <label key={`${corner}-${axis}`} className="block text-[11px] text-gray-600">{corner === 'topLeft' ? 'Top-left' : 'Bottom-right'} {axis}
              <input type="number" min={0} max={1} step={0.01} disabled={disabled} value={s.layout?.[corner]?.[axis] ?? ''} onChange={(e) => { const v = e.target.value === '' ? undefined : Math.max(0, Math.min(1, Number(e.target.value))); const layout = { ...(s.layout ?? {}) }; const c = { x: layout[corner]?.x ?? 0, y: layout[corner]?.y ?? 0, [axis]: v } as { x: number; y: number }; if (v === undefined) delete layout[corner]; else layout[corner] = c; patch({ layout: Object.keys(layout).length ? layout : undefined }); }} className="mt-0.5 w-full px-2 py-1 rounded-md border border-gray-300 text-sm" />
            </label>
          )))}
        </div>
        <div className="text-[11px] text-gray-500 mt-1">Leave empty to keep LinkedIn&apos;s crop.</div>
      </details>
    </div>
  );
}
