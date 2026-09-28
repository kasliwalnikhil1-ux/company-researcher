'use client';

// Crop step shown after choosing a photo or cover file, before anything is uploaded. Photo is a fixed square; cover is
// LinkedIn's 4:1 banner. The cropped pixels are what gets uploaded, so what you frame here is what LinkedIn receives.
import { useEffect, useRef, useState } from 'react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Check } from 'lucide-react';
import { Button, Modal } from '@/components/outreach/ui';
import { centerAspectCrop, cropToFile } from '@/lib/outreach/imageCrop';

export default function CropModal({ file, kind, onCancel, onConfirm }: {
  file: File | null; kind: 'photo' | 'cover'; onCancel: () => void; onConfirm: (cropped: File) => Promise<void> | void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [done, setDone] = useState<PixelCrop>();
  const [busy, setBusy] = useState(false);
  const aspect = kind === 'photo' ? 1 : 4;

  useEffect(() => {
    if (!file) { setSrc(null); setCrop(undefined); setDone(undefined); return; }
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function confirm() {
    if (!file || !imgRef.current || !done?.width || !done.height) return;
    setBusy(true);
    try { await onConfirm(await cropToFile(imgRef.current, done, file)); }
    finally { setBusy(false); }
  }

  return (
    <Modal
      open={!!file}
      onClose={busy ? () => {} : onCancel}
      title={kind === 'photo' ? 'Crop profile photo' : 'Crop cover image'}
      size="xl"
      footer={<>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={confirm} loading={busy} disabled={busy || !done?.width}><Check className="w-3.5 h-3.5" /> Confirm crop &amp; upload</Button>
      </>}
    >
      {src && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">{kind === 'photo' ? 'The circle shows how the photo appears on LinkedIn. Drag to frame it. The saved image stays square; LinkedIn does the rounding.' : 'Drag the box to frame the banner. It stays 4:1.'}</p>
          <div className="flex justify-center">
            <ReactCrop crop={crop} onChange={(_, pct) => setCrop(pct)} onComplete={(c) => setDone(c)} aspect={aspect} circularCrop={kind === 'photo'} keepSelection>
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
