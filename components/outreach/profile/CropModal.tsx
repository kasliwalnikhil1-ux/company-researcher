'use client';

// Crop step shown after choosing a photo or cover file, before anything is uploaded. Photo is a fixed square; cover is
// LinkedIn's 4:1 banner. The cropped pixels are what gets uploaded, so what you frame here is what LinkedIn receives.
// Logo / avatar / popup are the web chat header logo, bot avatar and popup image: a square shown in a circle, saved as a small WebP.
import { useEffect, useRef, useState } from 'react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Check } from 'lucide-react';
import { Button, Modal } from '@/components/outreach/ui';
import { centerAspectCrop, cropToFile } from '@/lib/outreach/imageCrop';

const COPY = {
  photo: { title: 'Crop profile photo', hint: 'The circle shows how the photo appears on LinkedIn. Drag to frame it. The saved image stays square; LinkedIn does the rounding.' },
  cover: { title: 'Crop cover image', hint: 'Drag the box to frame the banner. It stays 4:1.' },
  logo: { title: 'Crop logo', hint: 'The circle shows how the logo appears in the chat header. Drag and resize to frame it.' },
  avatar: { title: 'Crop bot avatar', hint: 'The circle shows how the avatar appears next to the assistant\'s messages and on voice calls. Drag and resize to frame it.' },
  popup: { title: 'Crop popup image', hint: 'The circle shows how the image appears next to the popup message. Drag and resize to frame it.' },
};

export default function CropModal({ file, kind, onCancel, onConfirm }: {
  file: File | null; kind: keyof typeof COPY; onCancel: () => void; onConfirm: (cropped: File) => Promise<void> | void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [done, setDone] = useState<PixelCrop>();
  const [busy, setBusy] = useState(false);
  const aspect = kind === 'cover' ? 4 : 1, round = kind !== 'cover';

  useEffect(() => {
    if (!file) { setSrc(null); setCrop(undefined); setDone(undefined); return; }
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function confirm() {
    if (!file || !imgRef.current || !done?.width || !done.height) return;
    setBusy(true);
    try { await onConfirm(await cropToFile(imgRef.current, done, file, kind === 'logo' || kind === 'avatar' || kind === 'popup' ? { type: 'image/webp', maxSide: 512 } : {})); }
    finally { setBusy(false); }
  }

  return (
    <Modal
      open={!!file}
      onClose={busy ? () => {} : onCancel}
      title={COPY[kind].title}
      size="xl"
      footer={<>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={confirm} loading={busy} disabled={busy || !done?.width}><Check className="w-3.5 h-3.5" /> Confirm crop &amp; upload</Button>
      </>}
    >
      {src && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">{COPY[kind].hint}</p>
          <div className="flex justify-center">
            <ReactCrop crop={crop} onChange={(_, pct) => setCrop(pct)} onComplete={(c) => setDone(c)} aspect={aspect} circularCrop={round} keepSelection>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img ref={imgRef} src={src} alt="Crop preview" style={{ maxWidth: '100%', maxHeight: '60vh' }} onLoad={(e) => {
                const { width, height } = e.currentTarget;
                const c = centerAspectCrop(width, height, aspect);
                setCrop(c);
                setDone({ unit: 'px', x: (c.x! / 100) * width, y: (c.y! / 100) * height, width: (c.width! / 100) * width, height: (c.height! / 100) * height });
              }} />
            </ReactCrop>
          </div>
        </div>
      )}
    </Modal>
  );
}
