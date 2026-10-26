import { decodeImage } from '../core/decode.js';
import { previewBlobFor } from '../core/heic-preview.js';

const IDLE = { status: 'idle' };
const initial = () => ({
  file: null, decoded: null, beforeUrl: null,
  recipe: { crop: null, resize: null, strip: null, regions: [], output: { mime: 'image/jpeg', mode: 'quality', quality: 70, targetKB: 100 } },
  result: IDLE, notice: '', suffix: '', suspended: false,
});

/**
 * One loaded image + one recipe, shared by every tool. Dependencies are injectable so the
 * ordering rules (stale loads, cleanup) can be unit-tested without a browser.
 */
export function createSession({
  decode = decodeImage,
  makePreview = previewBlobFor,
  makeUrl = (x) => URL.createObjectURL(x),
  revokeUrl = (u) => URL.revokeObjectURL(u),
} = {}) {
  let state = initial();
  let loadSeq = 0;
  const subs = new Set();
  const emit = () => subs.forEach((fn) => fn(state));

  function releaseImage() {
    if (state.decoded) state.decoded.bitmap.close();
    if (state.beforeUrl) revokeUrl(state.beforeUrl);
    if (state.result.url) revokeUrl(state.result.url);
  }

  return {
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    /**
     * Throws ImageError (with userMessage) if the file is unusable.
     * Only the most recent call wins: a slower, older decode is discarded and its bitmap freed.
     */
    async loadFile(file) {
      const mine = ++loadSeq;
      let decoded;
      try { decoded = await decode(file); }
      catch (err) { if (mine !== loadSeq) return false; throw err; }
      let preview = null;
      try { preview = await makePreview(decoded); } catch (e) { preview = null; }
      if (mine !== loadSeq) { decoded.bitmap.close(); return false; }
      releaseImage();
      const prev = state.recipe.output;
      state = {
        ...initial(), file, decoded, beforeUrl: makeUrl(preview || file),
        recipe: { crop: null, resize: null, strip: null, regions: [],
          output: { mime: decoded.kind.type === 'png' ? 'image/png' : 'image/jpeg', mode: 'quality', quality: 70, targetKB: prev.targetKB } },
      };
      emit();
      return true;
    },

    /** Change the recipe. Pass a notice to explain automatic adjustments. */
    setRecipe(patch, notice = '') {
      const recipe = { ...state.recipe, ...patch };
      if (patch.output) recipe.output = { ...state.recipe.output, ...patch.output };
      state = { ...state, recipe, notice };
      emit();
    },

    /** Results never change the recipe, so they never trigger a new run. */
    setResult(result) { state = { ...state, result }; emit(); },

    /** Tools with their own preview (Signature Cleaner) pause the shared compress pipeline so it does not burn CPU for nothing. */
    setSuspended(flag) { if (state.suspended === !!flag) return; state = { ...state, suspended: !!flag }; emit(); },

    /** Download-name suffix owned by the active tool. Not part of the recipe, so it never triggers a re-run. */
    setSuffix(suffix) { state = { ...state, suffix }; },

    clear() { loadSeq++; releaseImage(); state = initial(); emit(); },
  };
}

export const session = createSession();
