import { ImageError } from './errors.js';
import { MAX_FILE_BYTES } from './limits.js';

/** Cheap checks before any decoding. Accepts anything with a numeric `size`. */
export function validateFile(file) {
  if (!file || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) throw new ImageError('invalid', 'No file received.');   // NaN / Infinity / negative sizes are not files
  if (file.size === 0) throw new ImageError('empty', 'This file is empty.');
  if (file.size > MAX_FILE_BYTES) {
    throw new ImageError('file-too-big', 'This file is over ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB. Try a smaller image.');
  }
}
