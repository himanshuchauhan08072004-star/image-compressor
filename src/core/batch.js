import { linkedSize } from './geometry.js';
import { MAX_SIDE, MAX_BATCH_FILES, MAX_BATCH_BYTES, BATCH_PARALLEL, BATCH_PIXEL_BUDGET } from './limits.js';
import { formatBytes } from './format.js';
import { keepMime, isHeic } from './heic.js';

/** Pure batch logic: settings, per-image recipe, file names, limits, bounded scheduler. No DOM, no canvas. */
export const RESIZE_MODES = ['off', 'width', 'height', 'box'];
export const FORMATS = ['keep', 'jpeg', 'png', 'webp'];
export const COMPRESS_MODES = ['off', 'quality', 'target'];
export const PRESETS = [['1080 × 1080', 1080, 1080], ['1920 × 1080', 1920, 1080], ['1280 × 720', 1280, 720], ['800 × 800', 800, 800]];
export const REENCODE_QUALITY = 92;      // used when the batch must re-save but the user did not ask to compress

export const DEFAULT_SETTINGS = {
  resize: { mode: 'off', width: 1280, height: 720, keepAspect: true, allowUpscale: false },
  format: 'keep', compress: 'quality', quality: 70, targetKB: 200, strip: false, includeOriginals: false,
};

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
export const extFor = (mime) => EXT[mime] || 'bin';
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Validate user options. Returns { ok:true, settings } or { ok:false, error }. Never trusts the UI. */
export function normalizeSettings(raw = {}) {
  const r = { ...DEFAULT_SETTINGS.resize, ...(raw.resize || {}) };
  const s = {
    resize: { mode: RESIZE_MODES.includes(r.mode) ? r.mode : 'off', width: int(r.width), height: int(r.height), keepAspect: r.keepAspect !== false, allowUpscale: !!r.allowUpscale },
    format: FORMATS.includes(raw.format) ? raw.format : 'keep',
    compress: COMPRESS_MODES.includes(raw.compress) ? raw.compress : 'off',
    quality: Math.min(95, Math.max(10, int(raw.quality ?? DEFAULT_SETTINGS.quality) || DEFAULT_SETTINGS.quality)),
    targetKB: Number(raw.targetKB ?? DEFAULT_SETTINGS.targetKB),
    strip: !!raw.strip, includeOriginals: !!raw.includeOriginals,
  };
  const m = s.resize.mode;
  if ((m === 'width' || m === 'box') && !inRange(s.resize.width, 1, MAX_SIDE)) return { ok: false, error: 'Enter a width between 1 and ' + MAX_SIDE + ' px.' };
  if ((m === 'height' || m === 'box') && !inRange(s.resize.height, 1, MAX_SIDE)) return { ok: false, error: 'Enter a height between 1 and ' + MAX_SIDE + ' px.' };
  if (s.compress === 'target' && !(Number.isFinite(s.targetKB) && s.targetKB >= 1 && s.targetKB <= 50000)) return { ok: false, error: 'Enter a target size between 1 and 50000 KB.' };
  if (m === 'off' && s.format === 'keep' && s.compress === 'off' && !s.strip) return { ok: false, error: 'Choose at least one thing to do: resize, convert, compress or remove metadata.' };
  return { ok: true, settings: s };
}

/** Output MIME for a given source kind ({ mime }) under these settings. */
export const outputMime = (settings, kind) => (settings.format === 'keep' ? keepMime(kind) : MIME[settings.format]);

/** What happened, in a word, for the download-name suffix. */
export function suffixFor(settings) {
  const ops = [];
  if (settings.resize.mode !== 'off') ops.push('resized');
  if (settings.format !== 'keep') ops.push('converted');
  if (settings.compress !== 'off') ops.push('compressed');
  if (settings.strip) ops.push('clean');
  return ops.length === 1 ? ops[0] : 'edited';
}

/**
 * Turn batch settings + one decoded image ({ width, height, kind }) into a recipe for the existing pipeline.
 * strategy: 'canvas' | 'lossless' (metadata only, pixels untouched) | 'copy' (nothing to do for this image).
 * Never enlarges unless asked; an image already small enough keeps its size (and says so).
 */
export function buildRecipe(settings, decoded) {
  const { width: w, height: h } = decoded, rz = settings.resize, up = rz.allowUpscale, notes = [];
  let resize = null;
  const scaled = (tw, th) => ({ mode: 'scale', width: Math.max(1, tw), height: Math.max(1, th), fit: 'fill', allowUpscale: up, lock: true });
  if (rz.mode === 'width') {
    if (rz.width === w || (rz.width > w && !up)) notes.push('Already ' + w + ' px wide or less, so its size was kept.');
    else resize = scaled(rz.width, linkedSize('width', rz.width, w, h).height);
  } else if (rz.mode === 'height') {
    if (rz.height === h || (rz.height > h && !up)) notes.push('Already ' + h + ' px tall or less, so its size was kept.');
    else resize = scaled(linkedSize('height', rz.height, w, h).width, rz.height);
  } else if (rz.mode === 'box') {
    if (rz.keepAspect) {
      const k = Math.min(rz.width / w, rz.height / h);
      if (k === 1 || (k > 1 && !up)) notes.push('Already fits inside ' + rz.width + ' × ' + rz.height + ', so its size was kept.');
      else resize = scaled(Math.round(w * k), Math.round(h * k));
    } else if (!(rz.width === w && rz.height === h)) resize = scaled(rz.width, rz.height);    // exact size, may stretch; the pipeline refuses enlarging unless allowed
  }

  const mime = outputMime(settings, decoded.kind);
  const keepFormat = settings.format === 'keep';
  const heic = isHeic(decoded.kind);                      // browsers cannot write HEIC: it is always re-encoded (default JPG)
  if (heic && keepFormat) notes.push('HEIC cannot be saved by this browser, so this image was saved as JPG.');
  const lossless = !heic && settings.strip && keepFormat && settings.compress === 'off' && !resize;
  const nothing = !heic && !settings.strip && keepFormat && settings.compress === 'off' && !resize;
  const quality = settings.compress === 'quality' ? settings.quality : REENCODE_QUALITY;
  const output = { mime, mode: settings.compress === 'target' ? 'target' : 'quality', quality, targetKB: settings.targetKB, background: '#ffffff' };
  if (settings.compress === 'target' && mime === 'image/png') notes.push('PNG is lossless, so the target size could not be applied to this file.');
  const strip = !settings.strip ? null : lossless ? { method: 'lossless', keepIcc: true } : { method: 'reencode', keepIcc: false };
  return { recipe: { crop: null, resize, strip, regions: [], output }, strategy: nothing ? 'copy' : lossless ? 'lossless' : 'canvas', notes };
}

// ---------------------------------------------------------------- names

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** File name without extension, safe on Windows/macOS/Linux and inside a ZIP. */
export function safeBase(name) {
  let b = String(name || '').normalize('NFC').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  b = b.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');          // invisible / bidi-override characters can disguise a name
  b = b.replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
  if (b.length > 80) b = Array.from(b).slice(0, 80).join('').trim();                  // by code point: never cut an emoji (surrogate pair) in half
  if (!b) b = 'image';
  return RESERVED.test(b) ? '_' + b : b;
}
/** Add " (2)", " (3)"… until the (case-insensitive) name is unused, then reserve it. */
export function uniqueName(name, used) {
  const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let n = 1, candidate = name;
  while (used.has(candidate.toLowerCase())) { n++; candidate = base + ' (' + n + ')' + ext; }
  used.add(candidate.toLowerCase());
  return candidate;
}
export const outputName = (fileName, mime, suffix) => safeBase(fileName) + '-' + suffix + '.' + extFor(mime);

// ---------------------------------------------------------------- limits

/** Can one more file join the queue? state = { count, bytes } of what is already queued. */
export function checkLimits(state, file) {
  if (state.count >= MAX_BATCH_FILES) return { ok: false, message: 'Not added: a batch holds at most ' + MAX_BATCH_FILES + ' images.' };
  if (state.bytes + file.size > MAX_BATCH_BYTES) return { ok: false, message: 'Not added: the queue is limited to ' + formatBytes(MAX_BATCH_BYTES).replace('.00', '') + ' of originals in total.' };
  return { ok: true };
}

// ---------------------------------------------------------------- bounded scheduler

/**
 * Runs jobs ({ id, pixels }) in order with at most `maxParallel` in flight and at most `pixelBudget` source
 * pixels in flight (a single job larger than the budget still runs, alone). A failing job never stops the others.
 * onEvent receives { type: 'start' | 'done' | 'fail' | 'cancelled', job, result?, error? }.
 */
export function createRunner({ run, onEvent = () => {}, maxParallel = BATCH_PARALLEL, pixelBudget = BATCH_PIXEL_BUDGET }) {
  let pending = [], cancelled = false, inflight = 0, inPixels = 0, resolveAll = null, peak = 0;
  const emit = (e) => { try { onEvent(e); } catch (err) { /* a UI error must not stop the batch */ } };
  const idle = () => resolveAll && inflight === 0 && (cancelled || pending.length === 0) && (resolveAll(), (resolveAll = null));

  function pump() {
    while (!cancelled && pending.length && inflight < maxParallel && (inflight === 0 || inPixels + pending[0].pixels <= pixelBudget)) {
      const job = pending.shift();
      inflight++; inPixels += job.pixels; peak = Math.max(peak, inflight);
      emit({ type: 'start', job });
      Promise.resolve().then(() => run(job, () => cancelled))
        .then((result) => emit({ type: 'done', job, result }), (error) => emit({ type: 'fail', job, error }))
        .finally(() => { inflight--; inPixels -= job.pixels; pump(); idle(); });
    }
    idle();
  }
  return {
    /** Resolves when every job has finished or been cancelled. Resolves { peak } = most jobs ever in flight. */
    start(jobs) { pending = [...jobs]; cancelled = false; peak = 0; return new Promise((res) => { resolveAll = () => res({ peak }); pump(); }); },
    /** Jobs not yet started are dropped (reported as 'cancelled'); jobs already running are asked to stop via isCancelled(). */
    cancel() { cancelled = true; const dropped = pending; pending = []; dropped.forEach((job) => emit({ type: 'cancelled', job })); idle(); },
    get inFlight() { return inflight; },
  };
}
