import { releaseCanvas } from './render.js';

/** Canvas transform that displays an EXIF-oriented image. m = [a,b,c,d,e,f] for ctx.setTransform. */
export function orientationTransform(o, w, h) {
  switch (o) {
    case 2: return { width: w, height: h, m: [-1, 0, 0, 1, w, 0] };
    case 3: return { width: w, height: h, m: [-1, 0, 0, -1, w, h] };
    case 4: return { width: w, height: h, m: [1, 0, 0, -1, 0, h] };
    case 5: return { width: h, height: w, m: [0, 1, 1, 0, 0, 0] };
    case 6: return { width: h, height: w, m: [0, 1, -1, 0, h, 0] };
    case 7: return { width: h, height: w, m: [0, -1, -1, 0, h, w] };
    case 8: return { width: h, height: w, m: [0, -1, 1, 0, 0, w] };
    default: return { width: w, height: h, m: [1, 0, 0, 1, 0, 0] };
  }
}

/** Fallback for engines that decode without applying EXIF orientation. Closes the input bitmap. */
export async function applyOrientation(bitmap, o) {
  const t = orientationTransform(o, bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = t.width; canvas.height = t.height;
  let out;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.setTransform(...t.m);
    ctx.drawImage(bitmap, 0, 0);
    out = await createImageBitmap(canvas);
  } finally { releaseCanvas(canvas); }                 // freed on success and on failure
  bitmap.close();
  return out;
}
