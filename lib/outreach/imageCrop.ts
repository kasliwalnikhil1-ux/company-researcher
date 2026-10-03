import { centerCrop, makeAspectCrop, type Crop, type PixelCrop } from 'react-image-crop';

/** A centred crop covering 90% of the image at the given aspect ratio (width / height). */
export function centerAspectCrop(mediaWidth: number, mediaHeight: number, aspect: number): Crop {
  return centerCrop(makeAspectCrop({ unit: '%', width: 90 }, aspect, mediaWidth, mediaHeight), mediaWidth, mediaHeight);
}

/**
 * Cuts the selected area out of the image at its natural resolution and returns it as a File of the same type.
 * `type` forces the output type and `maxSide` scales the result down so its longer side is at most that many pixels.
 * The File's type is what the browser actually encoded (Safari cannot encode WebP and hands back PNG).
 */
export function cropToFile(img: HTMLImageElement, crop: PixelCrop, source: File, opts: { type?: 'image/png' | 'image/webp' | 'image/jpeg'; maxSide?: number } = {}): Promise<File> {
  const scaleX = img.naturalWidth / img.width;
  const scaleY = img.naturalHeight / img.height;
  const sw = Math.max(1, Math.round(crop.width * scaleX));
  const sh = Math.max(1, Math.round(crop.height * scaleY));
  const k = opts.maxSide ? Math.min(1, opts.maxSide / Math.max(sw, sh)) : 1;
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Your browser could not crop this image'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, Math.round(crop.x * scaleX), Math.round(crop.y * scaleY), sw, sh, 0, 0, w, h);
  const want = opts.type ?? (source.type === 'image/png' || source.type === 'image/webp' ? source.type : 'image/jpeg');
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('Your browser could not crop this image')); return; }
      const type = blob.type || want, ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      resolve(new File([blob], `${source.name.replace(/\.[^.]+$/, '')}-cropped.${ext}`, { type }));
    }, want, 0.95);
  });
}
