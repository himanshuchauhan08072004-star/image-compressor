import { releaseCanvas } from './render.js';

/** HEIC cannot be shown by <img> in most browsers: make a small JPG/PNG preview from the decoded bitmap. Null for other formats. */
export async function previewBlobFor(decoded, max = 2048) {
  if (!decoded || !decoded.kind || decoded.kind.type !== 'heic') return null;
  const k = Math.min(1, max / Math.max(decoded.width, decoded.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(decoded.width * k)); c.height = Math.max(1, Math.round(decoded.height * k));
  try {
    c.getContext('2d').drawImage(decoded.bitmap, 0, 0, c.width, c.height);
    const mime = decoded.hasAlpha ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((res) => c.toBlob(res, mime, 0.92));
    return blob || null;
  } finally { releaseCanvas(c); }
}
