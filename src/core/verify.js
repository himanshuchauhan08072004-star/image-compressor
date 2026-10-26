import { ImageError } from './errors.js';
import { sniffImage } from './sniff.js';

const name = (mime) => (mime === 'image/jpeg' ? 'JPG' : mime.replace('image/', '').toUpperCase());

/**
 * Prove the encoder produced the format we asked for by reading the file's own magic bytes.
 * (blob.type alone is just what the browser says; some engines say one thing and emit another.)
 */
export async function assertEncodedAs(blob, mime) {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const kind = sniffImage(head);
  if (blob.type !== mime || !kind || kind.mime !== mime) {
    throw new ImageError('format-unsupported', name(mime) + ' export is not supported by this browser (it produced a different file type).');
  }
}
