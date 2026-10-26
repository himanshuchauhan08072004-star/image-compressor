import { h } from '../dom.js';
import { formatBytes } from '../../core/format.js';
import { moveRect, resizeRect } from '../../core/geometry.js';
import { MIN_CROP } from '../../core/limits.js';
import { DEFAULTS, PRESETS, PAD_MAX, RANGES, normalizeParams, inkBounds, scaleRectOut, inkOutsideCrop, planExport } from '../../core/signature.js';
import { buildPreviewSource, cleanPreview, paintClean, exportSignature, isCancelled } from '../../core/signature-render.js';
import { releaseCanvas } from '../../core/render.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SLIDERS = [
  ['brightness', 'Brightness', 'Lighten or darken the whole picture.'],
  ['contrast', 'Contrast', 'Pull the ink and the paper further apart.'],
  ['threshold', 'Ink threshold', 'Higher keeps fainter marks. Lower removes more background.'],
  ['ink', 'Ink darkness', 'Make strokes darker and bolder.'],
  ['whiten', 'Background whitening', 'Even out shadows and tint on the paper.'],
  ['noise', 'Noise reduction', 'Removes small faint specks. Strokes and dots are kept.'],
];
const FORMATS = [['transparent', 'Transparent PNG'], ['white-png', 'White PNG'], ['white-jpg', 'White JPG']];
const SIZES = [['original', 'Original size'], ['width', 'Set width'], ['box', 'Fit in a box']];
const INKS = [['auto', 'Detected'], ['black', 'Black'], ['blue', 'Blue'], ['custom', 'Custom']];
const FORMAT_LABEL = { transparent: 'PNG · transparent', 'white-png': 'PNG · white background', 'white-jpg': 'JPG · white background' };
const KIND = { jpeg: 'JPG', png: 'PNG', webp: 'WEBP', heic: 'HEIC' };
const BUILD_DELAY = 600;
const r1 = (n) => Math.round(n * 10) / 10;

export default {
  mount(el, { session }) {
    const s0 = session.getState(), { bitmap, width: sw, height: sh } = s0.decoded, file = s0.file;
    let src;
    try { src = buildPreviewSource(bitmap); }
    catch (err) { el.append(h('p', { class: 'dz-error', role: 'alert' }, err.userMessage || 'This image could not be prepared for cleaning. Try a smaller picture.'), startOver(session)); return () => {}; }
    const { w: pw, h: ph } = src, fx = pw / sw, fy = ph / sh;

    const st = { params: normalizeParams(), preset: 'balanced', view: 'cleaned', compare: 50, crop: null, pad: 12, format: 'transparent', sizeMode: 'original', width: 800, height: 300, keepAspect: true, allowUpscale: false };
    let alive = true, drag = null, clean = null, final = null, buildSeq = 0, buildTimer = null, buildPromise = Promise.resolve(), dirty = true, previewFrame = 0;
    const urls = new Set();

    // ---------- 1. the picture
    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif', class: 'hidden', 'aria-hidden': 'true', tabindex: '-1' });
    const fileErr = h('p', { class: 'dz-error sig-left', role: 'alert', hidden: true });
    const replaceBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => fileInput.click() }, 'Replace image');
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0]; fileInput.value = ''; if (!f) return;
      fileErr.hidden = true;
      try { await session.loadFile(f); } catch (err) { if (alive) { fileErr.textContent = err.userMessage || 'Could not read this image.'; fileErr.hidden = false; } }
    });
    const info = h('div', { class: 'sig-file' },
      h('p', { class: 'sig-file-name' }, file.name || 'signature'),
      h('p', { class: 'sig-file-meta' }, sw + ' × ' + sh + ' px · ' + formatBytes(file.size) + ' · ' + (KIND[s0.decoded.kind.type] || '')));

    // ---------- 2. preview stage
    const cleanCanvas = h('canvas', { class: 'sig-layer', width: pw, height: ph, role: 'img', 'aria-label': 'Cleaned signature' });
    src.canvas.className = 'sig-layer'; src.canvas.setAttribute('role', 'img'); src.canvas.setAttribute('aria-label', 'Original picture');
    const divider = h('div', { class: 'sig-divider hidden' });
    const view = h('div', { class: 'sig-view checker' }, src.canvas, cleanCanvas, divider);
    const shade = h('div', { class: 'crop-shade' });
    const box = h('div', { class: 'crop-box', tabindex: '0', role: 'group', 'aria-label': 'Crop area. Arrow keys move it. Shift plus arrow keys resize it.' }, HANDLES.map((k) => h('div', { class: 'crop-h crop-h-' + k, 'data-h': k })));
    const stage = h('div', { class: 'sig-stage' }, view, h('div', { class: 'crop-clip' }, shade), box);
    stage.style.setProperty('--ar', String(sw / sh));
    const seg = (label, items, key, onPick) => {
      const btns = items.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': 'false', 'data-v': v, onClick: () => onPick(v) }, t));
      return { btns, el: h('div', { class: 'seg', role: 'group', 'aria-label': label }, btns) };
    };
    const viewSeg = seg('Preview', [['cleaned', 'Cleaned'], ['original', 'Original'], ['compare', 'Compare']], 'view', (v) => { st.view = v; sync(); });
    const compare = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '50', class: 'sig-compare hidden', 'aria-label': 'Before and after divider' });
    compare.addEventListener('input', () => { st.compare = Number(compare.value); applyView(); });
    const stageHint = h('p', { class: 'tool-hint', id: 'sig-stage-hint' });
    const tip = h('p', { class: 'tool-hint sig-tip hidden', id: 'sig-tip' });

    // ---------- 3. adjustments
    const presetBtns = [...PRESETS, { key: 'manual', label: 'Manual Adjustment', hint: 'Your own settings.' }].map((p) =>
      h('button', { type: 'button', class: 'chip', 'data-key': p.key, 'aria-pressed': 'false', title: p.hint, onClick: () => pickPreset(p) }, p.label));
    const presetHint = h('p', { class: 'tool-hint', id: 'sig-preset-hint' });
    const sliders = {};
    const sliderRows = SLIDERS.map(([key, label, hint]) => {
      const input = h('input', { type: 'range', id: 'sig-' + key, min: String(RANGES[key][0]), max: String(RANGES[key][1]), step: '1', value: String(st.params[key]), 'aria-describedby': 'sig-' + key + '-hint' });
      const out = h('span', { class: 'readout', 'aria-hidden': 'true' });
      input.addEventListener('input', () => { st.params[key] = Number(input.value); st.preset = 'manual'; changed(); });
      sliders[key] = { input, out };
      return h('div', { class: 'sig-slider' }, h('div', { class: 'sig-slider-top' }, h('label', { for: 'sig-' + key }, label), out), input, h('p', { class: 'tool-hint', id: 'sig-' + key + '-hint' }, hint));
    });
    const inkSeg = seg('Ink colour', INKS, 'inkColor', (v) => { st.params.inkColor = v; changed(); });
    const colorIn = h('input', { type: 'color', id: 'sig-color', value: st.params.customColor, 'aria-label': 'Custom ink colour' });
    colorIn.addEventListener('input', () => { st.params.customColor = colorIn.value; st.params.inkColor = 'custom'; changed(); });
    const resetAdj = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sig-reset-adj', onClick: () => { st.params = normalizeParams(); st.preset = 'balanced'; changed(); } }, 'Reset adjustments');

    // ---------- 4. crop and padding
    const trimBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sig-trim', onClick: autoTrim }, 'Auto-trim to signature');
    const resetCrop = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sig-reset-crop', onClick: () => setCrop({ x: 0, y: 0, w: sw, h: sh }) }, 'Reset crop');
    const cropInfo = h('p', { class: 'tool-hint', id: 'sig-crop-info', role: 'status' });
    const cropWarn = h('p', { class: 'tool-hint sig-warn hidden', id: 'sig-crop-warn', role: 'status' });
    const padIn = h('input', { type: 'number', id: 'sig-pad', min: '0', max: String(PAD_MAX), step: '1', inputmode: 'numeric', value: String(st.pad), 'aria-label': 'Padding in pixels' });
    padIn.addEventListener('input', () => { st.pad = padIn.value === '' ? NaN : Number(padIn.value); scheduleBuild(); });

    // ---------- 5. output
    const fmtSeg = seg('Output format', FORMATS, 'format', (v) => { st.format = v; changed(); });
    const sizeSeg = seg('Output size', SIZES, 'sizeMode', (v) => pickSize(v));
    const numIn = (id, label, key) => { const i = h('input', { type: 'number', id, min: '1', step: '1', inputmode: 'numeric', 'aria-label': label }); i.addEventListener('input', () => { st[key] = i.value === '' ? NaN : Number(i.value); scheduleBuild(); }); return i; };
    const wIn = numIn('sig-w', 'Output width in pixels', 'width'), hIn = numIn('sig-h', 'Output height in pixels', 'height');
    const keepIn = h('input', { type: 'checkbox', id: 'sig-keep', checked: true }), upIn = h('input', { type: 'checkbox', id: 'sig-up' });
    keepIn.addEventListener('change', () => { st.keepAspect = keepIn.checked; scheduleBuild(); });
    upIn.addEventListener('change', () => { st.allowUpscale = upIn.checked; scheduleBuild(); });
    const wGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'sig-w' }, 'Width'), wIn, h('span', { class: 'readout' }, 'px'));
    const hGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'sig-h' }, 'Height'), hIn, h('span', { class: 'readout' }, 'px'));
    const keepLbl = h('label', { class: 'check' }, keepIn, 'Keep aspect ratio');
    const planErr = h('p', { class: 'dz-error sig-left', role: 'alert', hidden: true, id: 'sig-plan-error' });
    const planInfo = h('p', { class: 'tool-hint sig-plan', id: 'sig-plan', role: 'status' });

    // ---------- 6. result
    const finalImg = h('img', { class: 'sig-final-img', id: 'sig-final-img', alt: 'Final signature preview' });
    const finalBox = h('div', { class: 'sig-final checker' }, finalImg);
    const stat = (k, id) => h('div', { class: 'panel-cell sig-cell' }, h('p', { class: 'k' }, k), h('p', { class: 'v', id }, '—'));
    const stats = h('div', { class: 'panel-grid sig-stats' }, stat('Final size', 'sig-st-dims'), stat('File size', 'sig-st-bytes'), stat('Format', 'sig-st-fmt'), stat('Transparency', 'sig-st-alpha'));
    const status = h('p', { class: 'tool-hint', id: 'sig-status', role: 'status' });
    const notes = h('div', { class: 'notice-list', id: 'sig-notes' });
    const dlBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'sig-download', disabled: true, onClick: download }, 'Download');
    const startBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sig-reset-all', onClick: resetAll }, 'Reset everything');

    el.append(
      h('h2', { class: 'tool-title' }, '1 · Your picture'),
      h('div', { class: 'tool-row sig-top' }, info, h('div', { class: 'spacer' }), replaceBtn, h('button', { type: 'button', class: 'btn btn-ghost', id: 'sig-remove', onClick: () => session.clear() }, 'Remove image'), fileInput),
      fileErr,
      h('h2', { class: 'tool-title' }, '2 · Preview'),
      h('div', { class: 'tool-row' }, viewSeg.el, compare),
      stage, stageHint, tip,
      h('h2', { class: 'tool-title' }, '3 · Clean up'),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Presets' }, presetBtns), presetHint,
      h('div', { class: 'sig-sliders' }, sliderRows),
      h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('span', { class: 'sig-lbl' }, 'Ink colour'), inkSeg.el, colorIn), resetAdj),
      h('p', { class: 'tool-hint' }, 'Works best for dark ink on light paper. Everything runs in your browser; the picture is never uploaded.'),
      h('h2', { class: 'tool-title' }, '4 · Crop and padding'),
      h('p', { class: 'tool-hint' }, 'Drag the frame or its handles on the preview. Keyboard: arrow keys move, Shift plus arrow keys resize.'),
      h('div', { class: 'tool-row' }, trimBtn, resetCrop, h('div', { class: 'ctrl-group' }, h('label', { for: 'sig-pad' }, 'Padding'), padIn, h('span', { class: 'readout' }, 'px'))),
      cropInfo, cropWarn,
      h('h2', { class: 'tool-title' }, '5 · Output'),
      h('div', { class: 'tool-row' }, fmtSeg.el),
      h('div', { class: 'tool-row' }, sizeSeg.el, wGroup, hGroup, keepLbl, h('label', { class: 'check' }, upIn, 'Allow enlarging')),
      planErr, planInfo,
      h('h2', { class: 'tool-title' }, '6 · Result'),
      finalBox, stats, status, notes,
      h('div', { class: 'tool-row' }, dlBtn, startBtn));

    // ---------- crop (same geometry helpers as the Crop tool)
    const full = (r) => r.x === 0 && r.y === 0 && r.w === sw && r.h === sh;
    const rect = () => st.crop || { x: 0, y: 0, w: sw, h: sh };
    function setCrop(r) { st.crop = full(r) ? null : r; renderCrop(); scheduleBuild(); }
    stage.addEventListener('pointerdown', (e) => {
      const handle = e.target.dataset && e.target.dataset.h ? e.target.dataset.h : (e.target === box ? 'move' : null);
      if (!handle) return;
      e.preventDefault(); e.target.setPointerCapture(e.pointerId);
      drag = { handle, x: e.clientX, y: e.clientY, rect: rect(), k: sw / stage.getBoundingClientRect().width };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) * drag.k, dy = (e.clientY - drag.y) * drag.k, b = { w: sw, h: sh };
      setCrop(drag.handle === 'move' ? moveRect(drag.rect, dx, dy, b) : resizeRect(drag.rect, drag.handle, dx, dy, b, null, MIN_CROP));
    });
    const endDrag = () => { drag = null; };
    stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
    box.addEventListener('keydown', (e) => {
      const step = Math.max(1, Math.round(sw * 0.01)), d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      setCrop(e.shiftKey ? resizeRect(rect(), 'se', d[0], d[1], { w: sw, h: sh }, null, MIN_CROP) : moveRect(rect(), d[0], d[1], { w: sw, h: sh }));
    });
    function autoTrim() {
      const b = clean && inkBounds(clean.alpha, pw, ph);
      if (!b) { status.textContent = 'No signature found to trim to. Try a higher ink threshold.'; return; }
      const r = scaleRectOut(b, sw / pw, sh / ph, Math.max(2, Math.ceil(1.5 / fx)), sw, sh);
      setCrop(r);
    }

    // ---------- preview
    function applyView() {
      const v = st.view, cmp = v === 'compare';
      src.canvas.classList.toggle('hidden', v === 'cleaned');
      cleanCanvas.classList.toggle('hidden', v === 'original');
      src.canvas.style.clipPath = cmp ? 'inset(0 ' + (100 - st.compare) + '% 0 0)' : '';
      cleanCanvas.style.clipPath = cmp ? 'inset(0 0 0 ' + st.compare + '%)' : '';
      view.classList.toggle('checker', v !== 'original' || true);
      divider.classList.toggle('hidden', !cmp); divider.style.left = st.compare + '%';
      compare.classList.toggle('hidden', !cmp);
      stageHint.textContent = v === 'original' ? 'Original picture.' : (st.format === 'transparent' ? 'The checkerboard shows what will be transparent.' : 'This is the cleaned signature on white.') + (cmp ? ' Left: original. Right: cleaned.' : '');
    }
    function renderPreview() {
      previewFrame = 0; if (!alive) return;
      clean = cleanPreview(src, st.params);
      paintClean(cleanCanvas, clean.alpha, clean.ink, st.format === 'transparent' ? 'transparent' : 'white');
      const b = inkBounds(clean.alpha, pw, ph), share = b ? (b.w * b.h) / (pw * ph) : 0;
      clean.hasInk = !!b;
      tip.classList.toggle('hidden', !(b && !st.crop && share < 0.6));
      tip.textContent = b ? 'The signature takes up about ' + Math.round(share * 100) + '% of the picture. Use “Auto-trim to signature” to remove the empty space.' : '';
      if (!b) { tip.classList.remove('hidden'); tip.textContent = 'No ink found with these settings. Raise the ink threshold or choose “Faint Signature”.'; }
      renderCrop();
    }
    function renderCrop() {
      const r = rect();
      for (const n of [box, shade]) { n.style.left = (r.x / sw) * 100 + '%'; n.style.top = (r.y / sh) * 100 + '%'; n.style.width = (r.w / sw) * 100 + '%'; n.style.height = (r.h / sh) * 100 + '%'; }
      box.classList.toggle('whole', full(r));
      cropInfo.textContent = full(r) ? 'Whole picture (' + sw + ' × ' + sh + ' px). Drag the frame or use Auto-trim.' : 'Crop: ' + r.w + ' × ' + r.h + ' px';
      let warn = '';
      if (clean && st.crop) {
        const o = inkOutsideCrop(clean.alpha, pw, ph, scaleRectOut(r, fx, fy, 0, pw, ph));
        if (o.total && o.outside >= 3) warn = 'About ' + Math.max(1, Math.round((o.outside / o.total) * 100)) + '% of the strokes lie outside the crop and will be cut off. Enlarge the frame or use Auto-trim.';
      }
      cropWarn.textContent = warn; cropWarn.classList.toggle('hidden', !warn);
    }

    // ---------- controls <-> state
    function pickPreset(p) {
      st.preset = p.key;
      if (p.values) Object.assign(st.params, p.values);
      changed();
    }
    function pickSize(mode) {
      if (mode !== 'original' && st.sizeMode === 'original') {            // start from the current size so the first value is always valid
        const o = planExport(cropDims(), { pad: st.pad, size: { mode: 'original' } });
        if (o.ok) { st.width = o.plan.W; st.height = o.plan.H; }
      }
      st.sizeMode = mode; sync(); scheduleBuild();
    }
    const cropDims = () => { const r = rect(); return { w: r.w, h: r.h }; };
    const sizeOpts = () => ({ mode: st.sizeMode, width: st.width, height: st.height, keepAspect: st.keepAspect, allowUpscale: st.allowUpscale });
    const outputOpts = () => ({ format: st.format, pad: st.pad, size: sizeOpts() });

    function sync() {                                                      // state -> every control
      const p = st.params;
      for (const [key, { input, out }] of Object.entries(sliders)) { if (document.activeElement !== input) input.value = String(p[key]); out.textContent = String(p[key]); }
      presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === st.preset)));
      const cur = PRESETS.find((x) => x.key === st.preset); presetHint.textContent = cur ? cur.hint : 'Your own settings. Pick a preset to start over from a known point.';
      inkSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === p.inkColor))); colorIn.value = p.customColor;
      viewSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.view)));
      fmtSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.format)));
      sizeSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.sizeMode)));
      wGroup.classList.toggle('hidden', st.sizeMode === 'original'); hGroup.classList.toggle('hidden', st.sizeMode !== 'box'); keepLbl.classList.toggle('hidden', st.sizeMode !== 'box');
      if (document.activeElement !== wIn) wIn.value = Number.isFinite(st.width) ? String(st.width) : ''; if (document.activeElement !== hIn) hIn.value = Number.isFinite(st.height) ? String(st.height) : '';
      if (document.activeElement !== padIn) padIn.value = Number.isFinite(st.pad) ? String(st.pad) : '';
      keepIn.checked = st.keepAspect; upIn.checked = st.allowUpscale; compare.value = String(st.compare);
      applyView();
    }
    function changed() {                                                   // a cleaning setting moved
      sync();
      if (!previewFrame) previewFrame = requestAnimationFrame(renderPreview);
      scheduleBuild();
    }
    function resetAll() {
      st.params = normalizeParams(); st.preset = 'balanced'; st.view = 'cleaned'; st.compare = 50; st.crop = null; st.pad = 12; st.format = 'transparent'; st.sizeMode = 'original'; st.keepAspect = true; st.allowUpscale = false;
      changed(); renderCrop();
    }

    // ---------- final image
    function validate() {
      const planned = planExport(cropDims(), { pad: st.pad, size: sizeOpts() });
      planErr.hidden = planned.ok; planErr.textContent = planned.ok ? '' : planned.error.message;
      planInfo.textContent = planned.ok ? 'Final size: ' + planned.plan.W + ' × ' + planned.plan.H + ' px' + (planned.plan.scale < 1 ? ' (scaled to ' + Math.round(planned.plan.scale * 100) + '%)' : '') + (st.pad ? ', with ' + st.pad + ' px padding.' : '.') : '';
      return planned.ok;
    }
    function scheduleBuild() {
      dirty = true; clearTimeout(buildTimer); buildSeq++;
      const ok = validate();
      dlBtn.disabled = !ok;
      if (!ok) { status.textContent = 'Fix the size above to update the result.'; return; }
      status.textContent = 'Updating the result…';
      buildTimer = setTimeout(() => { buildPromise = build(); }, BUILD_DELAY);
    }
    async function build() {
      const id = ++buildSeq;
      if (!clean) renderPreview();
      try {
        const res = await exportSignature({ bitmap, bg: src.bg, params: st.params, ink: clean.ink, crop: st.crop, output: outputOpts(), stale: () => id !== buildSeq || !alive });
        if (id !== buildSeq || !alive) return;
        if (final) { URL.revokeObjectURL(final.url); urls.delete(final.url); }
        final = { ...res, url: URL.createObjectURL(res.blob), name: fileName(res.mime) }; urls.add(final.url); dirty = false;
        showFinal();
      } catch (err) {
        if (isCancelled(err) || id !== buildSeq || !alive) return;
        status.textContent = err.userMessage || 'Could not build the final image.'; dlBtn.disabled = true;
      }
    }
    function showFinal() {
      const { report: rp, blob } = final, a = rp.alpha;
      finalImg.src = final.url;
      finalBox.classList.toggle('checker', st.format === 'transparent');
      const t = (id, v) => { stats.querySelector('#' + id).textContent = v; };
      t('sig-st-dims', final.width + ' × ' + final.height + ' px'); t('sig-st-bytes', formatBytes(blob.size)); t('sig-st-fmt', FORMAT_LABEL[st.format]);
      t('sig-st-alpha', !clean.hasInk ? 'No ink found' : st.format !== 'transparent' ? 'No · opaque white' : a && a.hasTransparency ? 'Yes · alpha channel' : 'None found');
      const n = [];
      if (!clean.hasInk) n.push('No signature was found with these settings, so the result is empty. Raise the ink threshold or pick “Faint Signature”.');
      if (st.format === 'transparent' && clean.hasInk) {
        if (a && a.hasTransparency) n.push('Checked in the finished file: it has an alpha channel and about ' + Math.round(a.clearPct) + '% of its pixels are fully transparent (sampled).');
        else n.push('This file has no transparent pixels, so it is not a transparent signature. Lower the ink threshold or crop closer.');
      }
      if (rp.region.reduced) n.push('The crop was larger than ' + Math.round(12) + ' MP, so it was reduced to ' + rp.region.processedW + ' × ' + rp.region.processedH + ' px before cleaning to keep memory in check.');
      if (rp.plan.upscaled) n.push('The signature was enlarged. Enlarging does not add detail.');
      if (final.mime === 'image/jpeg') n.push('JPG cannot be transparent and is lossy. Use PNG when you need the sharpest edges.');
      notes.replaceChildren(...n.map((x) => h('p', { class: 'notice' }, x)));
      status.textContent = (clean.hasInk ? 'Ready. ' : 'Empty result. ') + final.width + ' × ' + final.height + ' px, ' + formatBytes(blob.size) + '.';
      dlBtn.disabled = !clean.hasInk;
    }
    const fileName = (mime) => (((file.name || 'signature').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) || 'signature') + '-signature' + (mime === 'image/jpeg' ? '.jpg' : '.png');
    async function download() {
      if (dirty || !final) { clearTimeout(buildTimer); status.textContent = 'Preparing the file…'; buildPromise = build(); await buildPromise; }
      if (!final || !alive || dirty) return;
      const a = h('a', { href: final.url, download: final.name }); document.body.append(a); a.click(); a.remove();
      status.textContent = 'Downloaded ' + final.name + ' (' + final.width + ' × ' + final.height + ' px, ' + formatBytes(final.blob.size) + ').';
    }

    sync(); renderPreview(); scheduleBuild();

    return () => {
      alive = false; buildSeq++; clearTimeout(buildTimer); if (previewFrame) cancelAnimationFrame(previewFrame);
      urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); final = null;
      releaseCanvas(src.canvas); releaseCanvas(cleanCanvas); finalImg.removeAttribute('src');
    };
  },
};

function startOver(session) { return h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => session.clear() }, 'Choose another image'); }
