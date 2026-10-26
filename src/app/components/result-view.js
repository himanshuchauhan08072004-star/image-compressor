import { h } from '../dom.js';
import { formatBytes } from '../../core/format.js';
import { summarize } from '../../core/summary.js';

const ORIGINAL_NAME = { jpeg: 'JPG', png: 'PNG', webp: 'WEBP', heic: 'HEIC' };

/** Before/after, size bar, notes, stats. Pure view of session state. */
export function mountResult(stageEl, panelEl, session) {
  stageEl.innerHTML =
    '<div class="slides">' +
    '<div class="slide"><span class="slide-tag">Before</span><img data-r="imgBefore" alt="Original image" />' +
    '<div class="slide-stamp"><span class="size" data-r="sizeBefore"></span><span class="dims" data-r="dimsBefore"></span></div></div>' +
    '<div class="slide"><span class="slide-tag">After</span><img data-r="imgAfter" alt="Processed result" />' +
    '<div class="slide-stamp"><span class="size after" data-r="sizeAfter">—</span><span class="dims" data-r="dimsAfter"></span></div></div>' +
    '</div>' +
    '<div class="bar-row"><div class="bar-track"><div class="bar-fill" data-r="barFill"></div></div>' +
    '<div class="bar-caption"><span data-r="barLabel" aria-live="polite">processing…</span><span class="saved" data-r="barSaved"></span></div></div>' +
    '<div class="notice-list" data-r="notices" role="status"></div>';
  panelEl.innerHTML =
    '<p class="panel-title">What just happened</p><div class="panel-grid">' +
    '<div class="panel-cell"><p class="k">Original size</p><p class="v" data-r="statOriginal">—</p></div>' +
    '<div class="panel-cell"><p class="k">New size</p><p class="v green" data-r="statNew">—</p></div>' +
    '<div class="panel-cell"><p class="k">Reduced by</p><p class="v accent" data-r="statSaved">—</p></div>' +
    '<div class="panel-cell"><p class="k">Output</p><p class="v" data-r="statOutput">—</p></div>' +
    '<div class="panel-cell"><p class="k">Format</p><p class="v" data-r="statFormat">—</p></div></div>';

  const r = {};
  [stageEl, panelEl].forEach((root) => root.querySelectorAll('[data-r]').forEach((n) => { r[n.dataset.r] = n; }));
  let beforeUrl = null;

  function render(s) {
    if (!s.decoded) return;
    if (s.beforeUrl !== beforeUrl) { beforeUrl = s.beforeUrl; r.imgBefore.src = beforeUrl; }
    r.imgBefore.parentElement.classList.toggle('checker', !!s.decoded.hasAlpha);   // checkerboard only when transparency is real
    r.sizeBefore.textContent = formatBytes(s.file.size);
    r.dimsBefore.textContent = s.decoded.width + ' × ' + s.decoded.height;
    r.statOriginal.textContent = formatBytes(s.file.size);

    const res = s.result;
    const notes = s.notice ? [s.notice] : [];
    if (res.url && r.imgAfter.getAttribute('src') !== res.url) r.imgAfter.src = res.url;
    r.imgAfter.parentElement.classList.toggle('checker', !!(s.decoded.hasAlpha && res.mime && res.mime !== 'image/jpeg'));

    if (res.status === 'ready') {
      const sum = summarize({
        fileSize: s.file.size, blob: res.blob, width: res.width, height: res.height, mime: res.mime, report: res.report,
        hasGeometryEdits: !!(s.recipe.crop || s.recipe.resize || s.recipe.regions.length),
      });
      r.sizeAfter.textContent = formatBytes(res.blob.size);
      r.sizeAfter.classList.add('after');
      r.dimsAfter.textContent = sum.dims;
      r.barFill.style.width = Math.min(100, Math.max(4, Math.max(0, sum.delta.pct))) + '%';
      r.barLabel.textContent = sum.label;
      r.barSaved.textContent = sum.savedText;
      r.statNew.textContent = formatBytes(res.blob.size);
      r.statSaved.textContent = sum.statSaved;
      r.statOutput.textContent = sum.format + ' · ' + sum.dims;
      r.statFormat.textContent = ORIGINAL_NAME[s.decoded.kind.type] + ' → ' + sum.format;
      notes.push(...sum.notes);
    } else if (res.status === 'working' || res.status === 'idle') {
      r.barLabel.textContent = 'processing…';
      r.barFill.style.width = '15%';
      r.barSaved.textContent = '';
    } else {
      // blocked (fixable input) or error
      r.sizeAfter.textContent = '—';
      r.dimsAfter.textContent = '';
      r.barFill.style.width = '0%';
      r.barLabel.textContent = res.status === 'blocked' ? 'no output yet' : 'could not process this image';
      r.barSaved.textContent = '';
      r.statNew.textContent = '—'; r.statSaved.textContent = '—'; r.statOutput.textContent = '—'; r.statFormat.textContent = '—';
      if (res.message) notes.push(res.message);
    }
    r.notices.replaceChildren(...notes.map((n) => h('p', { class: 'notice' }, n)));
  }
  render(session.getState());
  return session.subscribe(render);
}
