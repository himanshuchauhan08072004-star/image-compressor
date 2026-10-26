import { h } from '../dom.js';
import { formatBytes } from '../../core/format.js';
import { RANGES, PRESETS, normalizeEnhance } from '../../core/enhance.js';
import { previewBase, paintEnhance, enhanceBitmap } from '../../core/enhance-render.js';
import { keepMime } from '../../core/heic.js';
import { safeBase, extFor } from '../../core/batch.js';
import { releaseCanvas } from '../../core/render.js';

const SLIDERS = [
  ['brightness', 'Brightness', 'Lighter or darker overall'], ['contrast', 'Contrast', 'Gap between light and dark'], ['saturation', 'Colour', 'Vividness. Minus 100 = black and white'],
  ['warmth', 'Warmth', 'Plus = warmer (yellow), minus = cooler (blue)'], ['sharpen', 'Sharpness', 'Crisper edges. High values add halos'], ['denoise', 'Noise reduction', 'Smooths grain and keeps edges. High values look plastic'],
];
const FORMATS = [['keep', 'Keep format'], ['jpeg', 'JPG'], ['png', 'PNG'], ['webp', 'WEBP']];
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const KIND = { jpeg: 'JPG', png: 'PNG', webp: 'WEBP', heic: 'HEIC' };

export default {
  mount(el, { session }) {
    const s0 = session.getState(), { bitmap, width: sw, height: sh } = s0.decoded, file = s0.file;
    let base;
    try { base = previewBase(bitmap); }
    catch (err) { el.append(h('p', { class: 'dz-error', role: 'alert' }, err.userMessage || 'This image could not be prepared. Try a smaller picture.'), h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => session.clear() }, 'Choose another image')); return () => {}; }
    const st = { p: normalizeEnhance(), preset: '', view: 'after', compare: 50, format: 'keep', quality: 92 };
    let alive = true, frame = 0, saveUrl = null, saveTimer = 0, busy = false;
    const outCanvas = h('canvas', { class: 'sig-layer', width: base.width, height: base.height, role: 'img', 'aria-label': 'Enhanced preview' });
    base.className = 'sig-layer'; base.setAttribute('role', 'img'); base.setAttribute('aria-label', 'Original picture');
    const seg = (label, items, onPick) => { const btns = items.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': 'false', 'data-v': v, onClick: () => onPick(v) }, t)); return { btns, el: h('div', { class: 'seg', role: 'group', 'aria-label': label }, btns) }; };
    const set = (k, v) => { st.p[k] = v; st.preset = 'custom'; changed(); };

    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif', class: 'hidden', 'aria-hidden': 'true', tabindex: '-1' });
    const fileErr = h('p', { class: 'dz-error sig-left', role: 'alert', hidden: true });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0]; fileInput.value = ''; if (!f) return; fileErr.hidden = true;
      try { await session.loadFile(f); } catch (err) { if (alive) { fileErr.textContent = err.userMessage || 'Could not read this image.'; fileErr.hidden = false; } }
    });
    const divider = h('div', { class: 'sig-divider hidden' });
    const view = h('div', { class: 'sig-view checker' }, base, outCanvas, divider);
    const stage = h('div', { class: 'sig-stage' }, view); stage.style.setProperty('--ar', String(sw / sh));
    const viewSeg = seg('Preview', [['after', 'Enhanced'], ['before', 'Original'], ['compare', 'Compare']], (v) => { st.view = v; sync(); });
    const compare = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '50', class: 'sig-compare hidden', 'aria-label': 'Before and after divider' });
    compare.addEventListener('input', () => { st.compare = Number(compare.value); applyView(); });
    const notesEl = h('div', { class: 'notice-list', id: 'en-notes', role: 'status' });

    const presetBtns = PRESETS.map((p) => h('button', { type: 'button', class: 'chip', 'data-key': p.key, 'aria-pressed': 'false', title: p.hint, onClick: () => { st.p = normalizeEnhance(p.values); st.preset = p.key; changed(); } }, p.label));
    const sliders = {};
    const rows = SLIDERS.map(([key, label, hint]) => {
      const input = h('input', { type: 'range', id: 'en-' + key, min: String(RANGES[key][0]), max: String(RANGES[key][1]), step: '1', 'aria-describedby': 'en-' + key + '-hint' }), out = h('span', { class: 'readout', 'aria-hidden': 'true' });
      input.addEventListener('input', () => set(key, Number(input.value))); sliders[key] = { input, out };
      return h('div', { class: 'sig-slider' }, h('div', { class: 'sig-slider-top' }, h('label', { for: 'en-' + key }, label), out), input, h('p', { class: 'tool-hint', id: 'en-' + key + '-hint' }, hint));
    });
    const autoIn = h('input', { type: 'checkbox', id: 'en-auto' }); autoIn.addEventListener('change', () => set('auto', autoIn.checked));
    const fmtSeg = seg('Output format', FORMATS, (v) => { st.format = v; sync(); });
    const qIn = h('input', { type: 'range', id: 'en-quality', min: '60', max: '100', step: '1' }), qOut = h('span', { class: 'readout' });
    qIn.addEventListener('input', () => { st.quality = Number(qIn.value); qOut.textContent = st.quality + '%'; });
    const qGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'en-quality' }, 'Quality'), qIn, qOut);
    const status = h('p', { class: 'tool-hint', id: 'en-status', role: 'status' });
    const dlBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'en-download', onClick: downloadOne }, 'Download enhanced image');
    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'en-reset', onClick: () => { st.p = normalizeEnhance(); st.preset = ''; st.view = 'after'; changed(); } }, 'Reset all');

    el.append(
      h('h2', { class: 'tool-title' }, '1 · Your picture'),
      h('div', { class: 'tool-row sig-top' }, h('div', { class: 'sig-file' }, h('p', { class: 'sig-file-name' }, file.name || 'image'), h('p', { class: 'sig-file-meta' }, sw + ' × ' + sh + ' px · ' + formatBytes(file.size) + ' · ' + (KIND[s0.decoded.kind.type] || ''))),
        h('div', { class: 'spacer' }), h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => fileInput.click() }, 'Replace image'), h('button', { type: 'button', class: 'btn btn-ghost', id: 'en-remove', onClick: () => session.clear() }, 'Remove image'), fileInput),
      fileErr,
      h('h2', { class: 'tool-title' }, '2 · Preview'), h('div', { class: 'tool-row' }, viewSeg.el, compare), stage, notesEl,
      h('h2', { class: 'tool-title' }, '3 · Quick fixes'), h('div', { class: 'chips', role: 'group', 'aria-label': 'Presets' }, presetBtns),
      h('div', { class: 'tool-row' }, h('label', { class: 'check' }, autoIn, 'Auto levels (set black and white points from the picture)')),
      h('h2', { class: 'tool-title' }, '4 · Fine tune'), h('div', { class: 'sig-sliders' }, rows),
      h('h2', { class: 'tool-title' }, '5 · Save'), h('div', { class: 'tool-row' }, fmtSeg.el, qGroup),
      h('p', { class: 'tool-hint' }, 'Plain filters, no AI. The result is saved at the original size and re-encoded, which removes camera and location data.'),
      h('div', { class: 'tool-row' }, dlBtn, resetBtn), status);

    function applyView() {
      const v = st.view, cmp = v === 'compare';
      base.classList.toggle('hidden', v === 'after'); outCanvas.classList.toggle('hidden', v === 'before');
      base.style.clipPath = cmp ? 'inset(0 ' + (100 - st.compare) + '% 0 0)' : ''; outCanvas.style.clipPath = cmp ? 'inset(0 0 0 ' + st.compare + '%)' : '';
      divider.classList.toggle('hidden', !cmp); divider.style.left = st.compare + '%'; compare.classList.toggle('hidden', !cmp);
    }
    function sync() {
      for (const [k, { input, out }] of Object.entries(sliders)) { if (document.activeElement !== input) input.value = String(st.p[k]); out.textContent = st.p[k]; }
      autoIn.checked = st.p.auto; qIn.value = String(st.quality); qOut.textContent = st.quality + '%';
      viewSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.view))); fmtSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.format)));
      presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === st.preset)));
      qGroup.classList.toggle('hidden', !(st.format === 'jpeg' || st.format === 'webp' || (st.format === 'keep' && keepMime(s0.decoded.kind) !== 'image/png')));
      compare.value = String(st.compare); applyView();
    }
    function changed() { sync(); if (!frame) frame = requestAnimationFrame(render); }
    function render() {
      frame = 0; if (!alive) return;
      const res = paintEnhance(outCanvas, base, st.p);
      notesEl.replaceChildren(...res.notes.map((m) => h('p', { class: 'notice' }, m)));
      notesEl.dataset.ms = String(res.ms); dlBtn.disabled = busy;
    }
    function save(blob, name) {
      const url = URL.createObjectURL(blob), a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
      clearTimeout(saveTimer); if (saveUrl) URL.revokeObjectURL(saveUrl); saveUrl = url; saveTimer = setTimeout(() => { URL.revokeObjectURL(url); if (saveUrl === url) saveUrl = null; }, 4000);
    }
    async function downloadOne() {
      if (busy) return; busy = true; status.textContent = 'Preparing the image…'; dlBtn.disabled = true;
      try {
        const mime = st.format === 'keep' ? keepMime(s0.decoded.kind) : MIME[st.format], r = await enhanceBitmap(bitmap, st.p, { mime, quality: st.quality / 100 }); if (!alive) return;
        const name = safeBase(file.name) + '-enhanced.' + extFor(mime); save(r.blob, name);
        status.textContent = 'Saved ' + name + ' · ' + r.width + ' × ' + r.height + ' px · ' + formatBytes(r.blob.size) + '.';
      } catch (err) { if (alive) status.textContent = err.userMessage || 'Could not create the image.'; }
      busy = false; if (alive) render();
    }

    sync(); render();
    return () => { alive = false; if (frame) cancelAnimationFrame(frame); clearTimeout(saveTimer); if (saveUrl) URL.revokeObjectURL(saveUrl); releaseCanvas(base); releaseCanvas(outCanvas); };
  },
};
