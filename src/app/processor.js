import { runPipeline } from '../core/pipeline.js';
import { Cancelled } from '../core/solve.js';

/** Watches the session; re-runs the pipeline (debounced, cancellable) when image or recipe change. */
export function startProcessor(session) {
  let lastRecipe = null, lastDecoded = null, lastSuspended = false, timer = null, runId = 0;

  const schedule = (delay) => { clearTimeout(timer); runId++; timer = setTimeout(run, delay); };

  async function run() {
    const s = session.getState();
    if (!s.decoded || s.suspended) return;
    const id = runId;
    session.setResult({ ...s.result, status: 'working' });
    try {
      const out = await runPipeline(s.decoded, s.recipe, { isCancelled: () => id !== runId, hintBytes: s.file.size, file: s.file });
      if (id !== runId) return;
      const old = session.getState().result.url;
      if (out.blocked) {
        session.setResult({ status: 'blocked', message: out.blocked.message, url: old });
      } else {
        session.setResult({ status: 'ready', url: URL.createObjectURL(out.blob), blob: out.blob,
          width: out.width, height: out.height, mime: out.mime, report: out.report });
        if (old) URL.revokeObjectURL(old);
      }
    } catch (err) {
      if (err instanceof Cancelled || id !== runId) return;
      if (err.code === 'format-unsupported' && s.recipe.output.mime !== 'image/jpeg') {
        const name = s.recipe.output.mime.replace('image/', '').toUpperCase();
        session.setRecipe({ output: { mime: 'image/jpeg' } }, name + ' export is not supported by this browser. Switched to JPG.');
        return;
      }
      session.setResult({ status: 'error', message: err.userMessage || 'Something went wrong while processing this image.', url: session.getState().result.url });
    }
  }

  session.subscribe((s) => {
    const resumed = lastSuspended && !s.suspended;
    lastSuspended = !!s.suspended;
    if (s.suspended) { runId++; clearTimeout(timer); lastDecoded = s.decoded; lastRecipe = s.recipe; return; }   // paused: no runs, nothing queued
    if (s.decoded !== lastDecoded || resumed) {
      lastDecoded = s.decoded; lastRecipe = s.recipe;
      if (s.decoded) schedule(0); else { runId++; clearTimeout(timer); }
    } else if (s.recipe !== lastRecipe) {
      lastRecipe = s.recipe; schedule(120);
    }
  });
}
