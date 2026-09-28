import { centerCrop, makeAspectCrop, type Crop, type PixelCrop } from 'react-image-crop';

/** A centred crop covering 90% of the image at the given aspect ratio (width / height). */
export function centerAspectCrop(mediaWidth: number, mediaHeight: number, aspect: number): Crop {
  return centerCrop(makeAspectCrop({ unit: '%', width: 90 }, aspect, mediaWidth, mediaHeight), mediaWidth, mediaHeight);
}

/** Cuts the selected area out of the image at its natural resolution and returns it as a File of the same type. */
export function cropToFile(img: HTMLImageElement, crop: PixelCrop, source: File): Promise<File> {
  const scaleX = img.naturalWidth / img.width;
  const scaleY = img.naturalHeight / img.height;
  const w = Math.max(1, Math.round(crop.width * scaleX));
  const h = Math.max(1, Math.round(crop.height * scaleY));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Your browser could not crop this image'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, Math.round(crop.x * scaleX), Math.round(crop.y * scaleY), w, h, 0, 0, w, h);
  const type = source.type === 'image/png' || source.type === 'image/webp' ? source.type : 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('Your browser could not crop this image')); return; }
      resolve(new File([blob], `${source.name.replace(/\.[^.]+$/, '')}-cropped.${ext}`, { type }));
    }, type, 0.95);
  });
}
