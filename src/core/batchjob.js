import { ImageError } from './errors.js';
import { decodeImage } from './decode.js';
import { runPipeline } from './pipeline.js';
import { Cancelled } from './solve.js';
import { summarize } from './summary.js';
import { buildRecipe } from './batch.js';

/**
 * Process ONE file with the existing single-image services: decodeImage + runPipeline (same validation, limits,
 * verification as the other tools). Resolves { blob, mime, width, height, label, notes, report } or throws.
 */
export async function processFile(file, settings, { isCancelled = () => false } = {}) {
  const decoded = await decodeImage(file);
  try {
    if (isCancelled()) throw new Cancelled();
    const { recipe, strategy, notes } = buildRecipe(settings, decoded);
    if (strategy === 'copy') {
      return { blob: file, mime: decoded.kind.mime, width: decoded.width, height: decoded.height, label: 'unchanged', report: { mode: 'copy' },
        notes: [...notes, 'Nothing to change for this image, so the original was copied.'] };
    }
    const opts = { isCancelled, hintBytes: file.size, file };
    let out = await runPipeline(decoded, recipe, opts);
    if (out.blocked && out.blocked.code === 'orientation' && recipe.strip) {   // PNG/WEBP rotation flag: lossless would lose it
      notes.push('This file has a rotation flag, so the image was rebuilt instead of cleaned losslessly.');
      out = await runPipeline(decoded, { ...recipe, strip: { method: 'reencode', keepIcc: false } }, opts);
    }
    if (out.blocked) throw new ImageError(out.blocked.code || 'blocked', out.blocked.message);
    const sum = summarize({ fileSize: file.size, blob: out.blob, width: out.width, height: out.height, mime: out.mime, report: out.report, hasGeometryEdits: !!recipe.resize });
    return { blob: out.blob, mime: out.mime, width: out.width, height: out.height, label: sum.label, report: out.report, notes: [...notes, ...sum.notes] };
  } finally { decoded.bitmap.close(); }
}
