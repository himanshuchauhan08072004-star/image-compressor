import { ImageError } from './errors.js';
import { sniffImage } from './sniff.js';

export function encodeCanvas(canvas, { mime, quality }) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob)
        : reject(new ImageError('encode', 'Could not process this image. It may be too large for your browser.')),
      mime,
      mime === 'image/png' ? undefined : quality
    );
  });
}

const support = new Map();

/** Can this browser really encode `mime`? (Some return PNG instead.) Cached; costs one 1x1 encode. */
export function supportsEncode(mime) {
  if (!support.has(mime)) {
    support.set(mime, new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      c.toBlob(async (b) => {
        if (!b || b.type !== mime) return resolve(false);
        const kind = sniffImage(new Uint8Array(await b.slice(0, 32).arrayBuffer()));   // trust the bytes, not the label
        resolve(!!kind && kind.mime === mime);
      }, mime, 0.8);
    }));
  }
  return support.get(mime);
}
