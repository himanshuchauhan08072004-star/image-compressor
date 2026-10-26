import { ImageError } from './errors.js';
import { planOutput, scalePlan } from './geometry.js';
import { renderPlan, releaseCanvas } from './render.js';
import { encodeCanvas, supportsEncode } from './encode.js';
import { fitToBytes, Cancelled } from './solve.js';
import { assertEncodedAs } from './verify.js';
import { normalizeHex } from './color.js';
import { readFileBytes } from './filebytes.js';
import { decodeImage } from './decode.js';
import { stripMetadata, verifyMetadata } from './metadata.js';
import { normalizeRegions, applyRegions } from './redact.js';

/**
 * decoded = { bitmap, width, height }.  recipe = { crop, resize, strip, regions, output }.
 * Resolves { blocked } for user-fixable problems, else { blob, width, height, mime, report }.
 * `file` is the original File (needed only by lossless metadata removal).
 */
const nextTask = () => new Promise((r) => setTimeout(r, 0));   // let the UI paint 'processing…' before heavy sync work
const TYPE_OF = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const hasEdits = (r) => !!(r.crop || r.resize || (r.regions && r.regions.length));

/** Re-read the produced bytes and record which metadata categories are still present. Never throws. */
async function withVerify(res, recipe) {
  if (!recipe.strip) return res;
  res.report.rebuilt = true;
  try {
    const bytes = new Uint8Array(await res.blob.arrayBuffer());
    res.report.verify = verifyMetadata(bytes, TYPE_OF[res.mime], { keepIcc: true })   // a colour profile is not personal data; it is reported, not counted as a leak;
  } catch (e) { res.report.verifyError = true; }
  return res;
}

/** Copy the picture data untouched, drop everything else. Output limits are the same as the canvas path. */
async function runLossless(decoded, recipe, file) {
  if (decoded.kind.type === 'heic') return { blocked: { code: 'strip-heic', message: 'HEIC files cannot be cleaned losslessly here. Use “Rebuild image”, which saves a JPG, PNG or WEBP from the pixels.' } };
  if (hasEdits(recipe)) {
    return { blocked: { code: 'strip-edits', message: 'Lossless removal cannot be combined with Crop, Resize or blur regions. Switch to “Rebuild image”, or remove those edits.' } };
  }
  const planned = planOutput(decoded.width, decoded.height, {});
  if (!planned.ok) return { blocked: planned.error };
  if (!file) throw new ImageError('strip', 'The original file is not available. Please load the image again.');
  const type = decoded.kind.type, mime = decoded.kind.mime;
  const keepIcc = recipe.strip.keepIcc !== false;
  const bytes = await readFileBytes(file);
  let s;
  try { s = stripMetadata(bytes, type, { keepIcc }); }
  catch (e) {
    if (e.code === 'orientation') return { blocked: { code: 'orientation', message: e.userMessage } };
    throw e;
  }
  const out = new Uint8Array(s.size);
  let at = 0;
  for (const p of s.parts) { out.set(p, at); at += p.length; }
  const blob = new Blob([out], { type: mime });
  await assertEncodedAs(blob, mime);
  const check = await decodeImage(blob);                       // the cleaned file must still open, at the same upright size
  check.bitmap.close();
  if (check.width !== decoded.width || check.height !== decoded.height) {
    throw new ImageError('strip-verify', 'The cleaned file did not open the same way as the original, so it was not used. Try “Rebuild image”.');
  }
  const verify = verifyMetadata(out, type, { keepIcc });
  return {
    blob, width: decoded.width, height: decoded.height, mime,
    report: { mode: 'strip', method: 'lossless', removed: s.removed, verify, keptRotationFlag: s.keptRotationFlag, keepIcc },
  };
}

export async function runPipeline(decoded, recipe, { isCancelled = () => false, hintBytes = 0, file = null } = {}) {
  if (recipe.strip && recipe.strip.method === 'lossless') return runLossless(decoded, recipe, file);

  const planned = planOutput(decoded.width, decoded.height, recipe);
  if (!planned.ok) return { blocked: planned.error };
  const { plan } = planned;
  const { mime, mode, quality, targetKB } = recipe.output;
  const flatten = mime === 'image/jpeg' || recipe.output.flatten === true;   // flatten: paint a solid fill under transparent pixels (JPEG always)
  const background = normalizeHex(recipe.output.background);
  const flattened = flatten && decoded.hasAlpha ? { color: background } : null;   // JPEG cannot store transparency
  const regions = normalizeRegions(recipe.regions, decoded.width, decoded.height);
  // Fail fast: a browser that cannot encode this type would otherwise burn every encode on PNG fallbacks.
  if (!(await supportsEncode(mime))) {
    throw new ImageError('format-unsupported', mime.replace('image/', '').toUpperCase() + ' export is not supported by this browser.');
  }

  const draw = (p) => {                                           // render + redact, so every encode sees the same pixels
    const c = renderPlan(decoded.bitmap, p, { flatten, background });
    try { applyRegions(c, p, regions); } catch (e) { releaseCanvas(c); throw e; }
    return c;
  };

  if (mode === 'target' && mime !== 'image/png') {
    const targetBytes = Math.round(targetKB * 1024);
    const r = await fitToBytes({
      render: async (s) => { await nextTask(); return draw(s === 1 ? plan : scalePlan(plan, s)); },
      encode: (c, q) => encodeCanvas(c, { mime, quality: q }),
      release: releaseCanvas,
      isCancelled, targetBytes, baseW: plan.outW, baseH: plan.outH, hintBytes,
    });
    await assertEncodedAs(r.blob, mime);
    return withVerify({
      blob: r.blob, width: r.width, height: r.height, mime,
      report: { mode: 'target', flattened, targetBytes, reached: r.reached, quality: r.quality, scale: r.scale, iterations: r.iterations, renders: r.renders, fullSizeEncodes: r.fullSizeEncodes, regions: regions.length },
    }, recipe);
  }

  await nextTask();
  const canvas = draw(plan);
  try {
    if (isCancelled()) throw new Cancelled();
    const blob = await encodeCanvas(canvas, { mime, quality: quality / 100 });
    await assertEncodedAs(blob, mime);
    return await withVerify({ blob, width: plan.outW, height: plan.outH, mime, report: { mode: 'quality', quality, flattened, regions: regions.length } }, recipe);
  } finally { releaseCanvas(canvas); }
}
