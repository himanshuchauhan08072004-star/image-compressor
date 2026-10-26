import { MAX_OUTPUT_PIXELS, MAX_SIDE } from './limits.js';
import { userMessageOf } from './errors.js';
import { normalizeWatermark, hasContent, PRESETS as WM_PRESETS } from './watermark.js';
import { planLayout } from './layout.js';
import { DPI_MIN, DPI_MAX } from './passport.js';

/**
 * Sequential document workflows: a short ordered list of operations that reuses the existing tools' logic.
 * This file is pure (no canvas, no DOM): operation definitions, validation, list editing and the runner. The runner takes
 * an `exec` object that does the real pixel work (see workflow-exec.js), so ordering, failure handling and ownership of
 * images can be unit-tested without a browser.
 *
 * Model: every selected image goes through each image operation in list order. The terminal operation `sheet` takes all
 * images at once and makes one PDF. `convert` only chooses the output format; the file is encoded ONCE at the end, so
 * steps after it do not cause a second lossy encode.
 */
export const MAX_OPS = 8, MAX_IMAGES = 6;
export const MIMES = ['image/jpeg', 'image/png', 'image/webp'];
export const RESIZE_FITS = ['inside', 'fill', 'contain'];
export const OP_INFO = {
  crop: { label: 'Crop', blurb: 'Centred crop to a shape (width : height). Nothing is stretched.' },
  resize: { label: 'Resize', blurb: 'Set the pixel size. Never enlarges unless you allow it.' },
  watermark: { label: 'Watermark', blurb: 'Stamp text on the picture.' },
  convert: { label: 'Convert', blurb: 'Choose the output format (JPG, PNG or WEBP).' },
  sheet: { label: 'Print sheet (PDF)', blurb: 'Arrange copies on paper and make a PDF. Always the last step.' },
};
export const OP_TYPES = Object.keys(OP_INFO);

export function defaultParams(type) {
  switch (type) {
    case 'crop': return { aw: 35, ah: 45 };
    case 'resize': return { width: 1080, height: 1080, fit: 'inside', allowUpscale: false };
    case 'watermark': return normalizeWatermark({ ...WM_PRESETS[0].values, text: '© Your name' });
    case 'convert': return { mime: 'image/jpeg', quality: 92 };
    case 'sheet': return { paper: { key: 'A4' }, landscape: false, margin: 10, gap: 3, photoW: 35, photoH: 45, copies: 8, dpi: 300, guides: 'none' };
    default: throw new Error('Unknown operation ' + type);
  }
}

let seq = 0;
export function makeOp(type, params) {
  if (!OP_TYPES.includes(type)) throw new Error('Unknown operation ' + type);
  return { id: 'op' + (++seq), type, params: { ...defaultParams(type), ...(params || {}) } };
}

/** Built-in starting points. Both are ordinary lists the user can edit. */
export const TEMPLATES = [
  { id: 'passport', label: 'Passport printing', blurb: 'Crop to the photo shape, size it, lay copies out on paper, export a PDF.',
    make: () => [makeOp('crop', { aw: 35, ah: 45 }), makeOp('resize', { width: 413, height: 531, fit: 'inside' }), makeOp('sheet')] },
  { id: 'prepare', label: 'Image preparation', blurb: 'Resize, convert, optionally watermark, then download.',
    make: () => [makeOp('resize'), makeOp('convert'), makeOp('watermark')] },
];

// ---- list editing (pure; never mutates the input list)
export const addOp = (ops, type, params) => [...ops, makeOp(type, params)];
export const removeOp = (ops, id) => ops.filter((o) => o.id !== id);
export function moveOp(ops, id, delta) {
  const i = ops.findIndex((o) => o.id === id), j = i + delta;
  if (i < 0 || j < 0 || j >= ops.length) return ops;
  const next = ops.slice(); [next[i], next[j]] = [next[j], next[i]]; return next;
}
export const updateOp = (ops, id, patch) => ops.map((o) => (o.id === id ? { ...o, params: { ...o.params, ...patch } } : o));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);

/** Settings check for one operation. Returns an error string or null. */
export function paramError(op) {
  const p = op.params || {};
  switch (op.type) {
    case 'crop':
      if (!isNum(p.aw) || !isNum(p.ah) || p.aw <= 0 || p.ah <= 0) return 'Crop shape: enter a width and a height greater than zero.';
      if (p.aw / p.ah > 20 || p.ah / p.aw > 20) return 'Crop shape: the ratio can be at most 20 : 1.';
      return null;
    case 'resize':
      if (!isInt(p.width) || !isInt(p.height) || p.width < 1 || p.height < 1) return 'Resize: width and height must be whole numbers of at least 1 px.';
      if (p.width > MAX_SIDE || p.height > MAX_SIDE) return 'Resize: one side may not exceed ' + MAX_SIDE + ' px.';
      if (p.width * p.height > MAX_OUTPUT_PIXELS) return 'Resize: that is over the ' + MAX_OUTPUT_PIXELS / 1e6 + ' megapixel output limit.';
      if (!RESIZE_FITS.includes(p.fit)) return 'Resize: choose how the picture fits the size.';
      return null;
    case 'watermark': { const w = normalizeWatermark({ ...p, type: 'text' }); return hasContent(w, false) ? null : 'Watermark: type the text first.'; }
    case 'convert':
      if (!MIMES.includes(p.mime)) return 'Convert: choose JPG, PNG or WEBP.';
      if (!isInt(p.quality) || p.quality < 1 || p.quality > 100) return 'Convert: quality must be a whole number from 1 to 100.';
      return null;
    case 'sheet': {
      if (!isInt(p.dpi) || p.dpi < DPI_MIN || p.dpi > DPI_MAX) return 'Print sheet: DPI must be a whole number from ' + DPI_MIN + ' to ' + DPI_MAX + '.';
      const r = planLayout({ paper: p.paper, landscape: p.landscape, margin: p.margin, hGap: p.gap, vGap: p.gap, guides: p.guides, groups: [{ w: p.photoW, h: p.photoH, copies: p.copies }] });
      return r.ok ? null : 'Print sheet: ' + r.error;
    }
    default: return 'Unknown step.';
  }
}

/**
 * Is this list runnable? { ok, errors:[{index, message}], warnings:[{index, message}] } (index -1 = the whole workflow).
 * Rules: 1..MAX_OPS known steps, each kind at most once, Print sheet last, Print sheet cannot be combined with Convert
 * (the PDF embeds its own JPEG), every step's settings valid, 1..MAX_IMAGES images.
 */
export function validateWorkflow(ops, { imageCount = 1 } = {}) {
  const errors = [], warnings = [], add = (arr, index, message) => arr.push({ index, message });
  if (!Array.isArray(ops) || ops.length === 0) add(errors, -1, 'Add at least one step.');
  else {
    if (ops.length > MAX_OPS) add(errors, -1, 'At most ' + MAX_OPS + ' steps.');
    const seen = new Set();
    ops.forEach((op, i) => {
      if (!op || !OP_TYPES.includes(op.type)) return add(errors, i, 'Step ' + (i + 1) + ' is not a known step.');
      if (seen.has(op.type)) add(errors, i, OP_INFO[op.type].label + ' appears more than once. Use it once per workflow.'); seen.add(op.type);
      const e = paramError(op); if (e) add(errors, i, e);
    });
    const sheetAt = ops.findIndex((o) => o && o.type === 'sheet');
    if (sheetAt >= 0 && sheetAt !== ops.length - 1) add(errors, sheetAt, 'Print sheet must be the last step. Move it to the end.');
    if (sheetAt >= 0 && ops.some((o) => o && o.type === 'convert')) add(errors, sheetAt, 'Print sheet cannot be combined with Convert: the PDF always embeds a JPEG. Remove Convert.');
    const r = ops.findIndex((o) => o && o.type === 'resize'), c = ops.findIndex((o) => o && o.type === 'crop');
    if (r >= 0 && c >= 0 && r < c) add(warnings, r, 'Resize runs before Crop, so the crop is taken from the already resized picture.');
  }
  if (!(imageCount >= 1)) add(errors, -1, 'Add at least one image.');
  else if (imageCount > MAX_IMAGES) add(errors, -1, 'At most ' + MAX_IMAGES + ' images per workflow.');
  return { ok: errors.length === 0, errors, warnings };
}

const messageOf = (e) => userMessageOf(e, 'Something went wrong.');   // never show raw browser/library text
const uniqueOwned = (items) => { const seen = new Set(), out = []; for (const it of items) if (it && it.owned && !seen.has(it.bitmap)) { seen.add(it.bitmap); out.push(it); } return out; };

/**
 * inputs: [{ name, bitmap, width, height, hasAlpha, kind }]. The runner never closes or changes an input; it only
 * releases working images it created (item.owned === true), including after a failure.
 * exec: { image(op, item, ctx) -> item, sheet(op, items, ctx) -> { blob, notes }, finalize(item) -> { name, blob, mime, width, height }, release(item) }.
 * Resolves { ok:true, kind:'pdf'|'images', pdf?, files?, notes, steps } or { ok:false, error, step, op, image, steps, cancelled? }.
 * A failed step stops the run and is reported; nothing is skipped silently.
 */
export async function runWorkflow(ops, inputs, exec, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const v = validateWorkflow(ops, { imageCount: inputs.length });
  if (!v.ok) return { ok: false, code: 'invalid', error: v.errors[0].message, errors: v.errors, steps: [] };
  const steps = [...ops.map((o) => ({ id: o.id, type: o.type, status: 'pending', message: '' })), { id: 'output', type: 'output', status: 'pending', message: '' }];
  let items = inputs.map((it) => ({ ...it, owned: false })), notes = [];
  const emit = (i, extra = {}) => onProgress({ step: i, total: steps.length, ...steps[i], ...extra });
  const dropAll = (...lists) => uniqueOwned(lists.flat()).forEach((it) => { try { exec.release(it); } catch (e) { /* releasing must not hide the real error */ } });
  const fail = (i, e, image, ...cleanup) => {
    if (e && e.code === 'cancelled') return cancelled(i, ...cleanup);   // a step that noticed the cancel itself is a cancel, not a failure
    dropAll(...cleanup); steps[i].status = 'failed'; steps[i].message = messageOf(e); emit(i, { image });
    return { ok: false, error: steps[i].message, step: i, op: steps[i].type, image: image || null, steps };
  };
  const cancelled = (i, ...cleanup) => { dropAll(...cleanup); steps[i].status = 'cancelled'; return { ok: false, cancelled: true, error: 'Cancelled.', step: i, op: steps[i].type, image: null, steps }; };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i], ctx = { isCancelled, step: i };
    steps[i].status = 'running'; emit(i);
    if (isCancelled()) return cancelled(i, items);
    if (op.type === 'sheet') {
      let res;
      try { res = await exec.sheet(op, items, ctx); } catch (e) { return fail(i, e, null, items); }
      dropAll(items); items = []; notes = notes.concat(res.notes || []);
      steps[i].status = 'done'; emit(i);
      steps[ops.length].status = 'done'; emit(ops.length);
      return { ok: true, kind: 'pdf', pdf: res.blob, info: res.info || null, notes, steps };
    }
    const next = [];
    for (const item of items) {
      if (isCancelled()) return cancelled(i, next, items);
      try { next.push(await exec.image(op, item, ctx)); } catch (e) { return fail(i, e, item.name, next, items); }
    }
    const keep = new Set(next.map((n) => n.bitmap));
    uniqueOwned(items).filter((old) => !keep.has(old.bitmap)).forEach((old) => exec.release(old));
    items = next; steps[i].status = 'done'; emit(i);
  }
  const out = ops.length, files = [];
  steps[out].status = 'running'; emit(out);
  for (let k = 0; k < items.length; k++) {
    if (isCancelled()) return cancelled(out, items);
    try { files.push(await exec.finalize(items[k])); } catch (e) { return fail(out, e, items[k].name, items); }
  }
  dropAll(items); steps[out].status = 'done'; emit(out);
  return { ok: true, kind: 'images', files, notes, steps };
}
