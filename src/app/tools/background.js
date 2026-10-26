import { h } from '../dom.js';
import { formatBytes } from '../../core/format.js';
import { RANGES, PRESETS, normalizeBackground, hexToRgb } from '../../core/background.js';
import { previewBase, paintCutout, pixelAt, cutOutBitmap } from '../../core/background-render.js';
import { safeBase } from '../../core/batch.js';
import { releaseCanvas } from '../../core/render.js';

const SLIDERS = [['tolerance', 'Tolerance', 'How different from the background a pixel may be and still be removed'], ['feather', 'Edge softness', 'Softens the cut line'], ['specks', 'Remove specks', 'Deletes small leftover bits away from the main subject']];
const FORMATS = [['png', 'PNG (transparent)'], ['webp', 'WEBP (transparent)'], ['jpeg', 'JPG (needs a fill)']];
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const KIND = { jpeg: 'JPG', png: 'PNG', webp: 'WEBP', heic: 'HEIC' };
const hex2 = (n) => n.toString(16).padStart(2, '0');
const toHex = (c) => '#' + c.map(hex2).join('');

export default {
  mount(el, { session }) {
    const s0 = session.getState(), { bitmap, width: sw, height: sh } = s0.decoded, file = s0.file;
    let base;
    try { base = previewBase(bitmap); }
    catch (err) { el.append(h('p', { class: 'dz-error', role: 'alert' }, err.userMessage || 'This image could not be prepared. Try a smaller picture.'), h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => session.clear() }, 'Choose another image')); return () => {}; }
    const st = { p: normalizeBackground(), preset: 'studio', view: 'after', compare: 50, format: 'png', quality: 92, bg: null };
    Object.assign(st.p, normalizeBackground(PRESETS[0].values));
    let alive = true, frame = 0, saveUrl = null, saveTimer = 0, busy = false;
    const outCanvas = h('canvas', { class: 'sig-layer', width: base.width, height: base.height, role: 'img', 'aria-label': 'Background removed preview' });
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
    const view = h('div', { class: 'sig-view checker bg-pick' }, base, outCanvas, divider);
    view.addEventListener('click', (e) => {
      const r = view.getBoundingClientRect(); if (!r.width) return;
      const c = pixelAt(base, Math.floor(((e.clientX - r.left) / r.width) * base.width), Math.floor(((e.clientY - r.top) / r.height) * base.height)); if (!c) return;
      st.bg = c; st.preset = 'custom'; changed();
    });
    const stage = h('div', { class: 'sig-stage' }, view); stage.style.setProperty('--ar', String(sw / sh));
    const viewSeg = seg('Preview', [['after', 'Cut-out'], ['before', 'Original'], ['compare', 'Compare']], (v) => { st.view = v; sync(); });
    const compare = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '50', class: 'sig-compare hidden', 'aria-label': 'Before and after divider' });
    compare.addEventListener('input', () => { st.compare = Number(compare.value); applyView(); });
    const notesEl = h('div', { class: 'notice-list', id: 'bg-notes', role: 'status' });

    const presetBtns = PRESETS.map((p) => h('button', { type: 'button', class: 'chip', 'data-key': p.key, 'aria-pressed': 'false', title: p.hint, onClick: () => { Object.assign(st.p, normalizeBackground({ ...st.p, ...p.values })); st.preset = p.key; changed(); } }, p.label));
    const sliders = {};
    const rows = SLIDERS.map(([key, label, hint]) => {
      const input = h('input', { type: 'range', id: 'bg-' + key, min: String(RANGES[key][0]), max: String(RANGES[key][1]), step: '1', 'aria-describedby': 'bg-' + key + '-hint' }), out = h('span', { class: 'readout', 'aria-hidden': 'true' });
      input.addEventListener('input', () => set(key, Number(input.value))); sliders[key] = { input, out };
      return h('div', { class: 'sig-slider' }, h('div', { class: 'sig-slider-top' }, h('label', { for: 'bg-' + key }, label), out), input, h('p', { class: 'tool-hint', id: 'bg-' + key + '-hint' }, hint));
    });
    const modeSeg = seg('Where to remove', [['edge', 'Only outside the subject'], ['all', 'Everywhere (also inside holes)']], (v) => set('mode', v));
    const bgIn = h('input', { type: 'color', id: 'bg-color-in', 'aria-label': 'Background colour to remove' }); bgIn.addEventListener('input', () => { st.bg = hexToRgb(bgIn.value); st.preset = 'custom'; changed(); });
    const bgAuto = h('button', { type: 'button', class: 'btn btn-ghost', id: 'bg-auto', onClick: () => { st.bg = null; changed(); } }, 'Auto-detect');
    const bgState = h('span', { class: 'readout', id: 'bg-state' });
    const fillSeg = seg('Replace with', [['transparent', 'Transparent'], ['white', 'White'], ['color', 'Colour']], (v) => set('fill', v));
    const fillIn = h('input', { type: 'color', id: 'bg-fill-color', 'aria-label': 'Fill colour' }); fillIn.addEventListener('input', () => set('fillColor', fillIn.value));
    const fmtSeg = seg('Output format', FORMATS, (v) => { st.format = v; sync(); });
    const qIn = h('input', { type: 'range', id: 'bg-quality', min: '60', max: '100', step: '1' }), qOut = h('span', { class: 'readout' });
    qIn.addEventListener('input', () => { st.quality = Number(qIn.value); qOut.textContent = st.quality + '%'; });
    const qGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'bg-quality' }, 'Quality'), qIn, qOut);
    const status = h('p', { class: 'tool-hint', id: 'bg-status', role: 'status' });
    const dlBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'bg-download', onClick: downloadOne }, 'Download result');
    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'bg-reset', onClick: () => { st.p = normalizeBackground(PRESETS[0].values); st.preset = 'studio'; st.bg = null; st.view = 'after'; changed(); } }, 'Reset all');

    el.append(
      h('h2', { class: 'tool-title' }, '1 · Your picture'),
      h('div', { class: 'tool-row sig-top' }, h('div', { class: 'sig-file' }, h('p', { class: 'sig-file-name' }, file.name || 'image'), h('p', { class: 'sig-file-meta' }, sw + ' × ' + sh + ' px · ' + formatBytes(file.size) + ' · ' + (KIND[s0.decoded.kind.type] || ''))),
        h('div', { class: 'spacer' }), h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => fileInput.click() }, 'Replace image'), h('button', { type: 'button', class: 'btn btn-ghost', id: 'bg-remove', onClick: () => session.clear() }, 'Remove image'), fileInput),
      fileErr,
      h('p', { class: 'tool-hint' }, 'This tool uses colour, not AI. It works on plain or evenly lit backgrounds (a wall, a sheet of paper, a product on white). It cannot cut a person out of a busy street.'),
      h('h2', { class: 'tool-title' }, '2 · Preview'), h('div', { class: 'tool-row' }, viewSeg.el, compare), stage,
      h('p', { class: 'tool-hint sig-tip' }, 'Wrong result? Click the background in the picture to tell the tool which colour to remove.'), notesEl,
      h('h2', { class: 'tool-title' }, '3 · Quick settings'), h('div', { class: 'chips', role: 'group', 'aria-label': 'Presets' }, presetBtns),
      h('div', { class: 'tool-row' }, modeSeg.el),
      h('div', { class: 'tool-row' }, h('label', { for: 'bg-color-in', class: 'sig-lbl' }, 'Background colour'), bgIn, bgAuto, bgState),
      h('h2', { class: 'tool-title' }, '4 · Fine tune'), h('div', { class: 'sig-sliders' }, rows),
      h('h2', { class: 'tool-title' }, '5 · Replace the background'), h('div', { class: 'tool-row' }, fillSeg.el, h('div', { class: 'ctrl-group' }, h('label', { for: 'bg-fill-color' }, 'Colour'), fillIn)),
      h('h2', { class: 'tool-title' }, '6 · Save'), h('div', { class: 'tool-row' }, fmtSeg.el, qGroup),
      h('p', { class: 'tool-hint' }, 'The result is saved at the original size (pictures over 12 MP are reduced to 12 MP first) and re-encoded, which removes camera and location data. JPG cannot be transparent, so it gets a white fill unless you pick a colour.'),
      h('div', { class: 'tool-row' }, dlBtn, resetBtn), status);

    function applyView() {
      const v = st.view, cmp = v === 'compare';
      base.classList.toggle('hidden', v === 'after'); outCanvas.classList.toggle('hidden', v === 'before');
      base.style.clipPath = cmp ? 'inset(0 ' + (100 - st.compare) + '% 0 0)' : ''; outCanvas.style.clipPath = cmp ? 'inset(0 0 0 ' + st.compare + '%)' : '';
      divider.classList.toggle('hidden', !cmp); divider.style.left = st.compare + '%'; compare.classList.toggle('hidden', !cmp);
    }
    function sync() {
      for (const [k, { input, out }] of Object.entries(sliders)) { if (document.activeElement !== input) input.value = String(st.p[k]); out.textContent = st.p[k]; }
      qIn.value = String(st.quality); qOut.textContent = st.quality + '%'; fillIn.value = st.p.fillColor; if (st.bg) bgIn.value = toHex(st.bg);
      bgState.textContent = st.bg ? 'picked ' + toHex(st.bg) : 'automatic (from the picture edges)';
      viewSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.view))); fmtSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.format)));
      modeSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.p.mode))); fillSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.p.fill)));
      presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === st.preset)));
      qGroup.classList.toggle('hidden', st.format === 'png'); fillIn.disabled = st.p.fill !== 'color';
      view.classList.toggle('checker', st.p.fill === 'transparent'); compare.value = String(st.compare); applyView();
    }
    function changed() { sync(); if (!frame) frame = requestAnimationFrame(render); }
    function render() {
      frame = 0; if (!alive) return;
      const res = paintCutout(outCanvas, base, st.p, st.bg);
      notesEl.replaceChildren(...res.notes.map((m) => h('p', { class: 'notice' }, m))); notesEl.dataset.ms = String(res.ms); notesEl.dataset.removed = res.removed.toFixed(3); if (!st.bg && res.colors[0]) { bgIn.value = toHex(res.colors[0].map(Math.round)); bgState.textContent = 'automatic: ' + bgIn.value; } dlBtn.disabled = busy;
    }
    function save(blob, name) {
      const url = URL.createObjectURL(blob), a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
      clearTimeout(saveTimer); if (saveUrl) URL.revokeObjectURL(saveUrl); saveUrl = url; saveTimer = setTimeout(() => { URL.revokeObjectURL(url); if (saveUrl === url) saveUrl = null; }, 4000);
    }
    async function downloadOne() {
      if (busy) return; busy = true; status.textContent = 'Preparing the image…'; dlBtn.disabled = true;
      try {
        const r = await cutOutBitmap(bitmap, st.p, st.bg, { mime: MIME[st.format], quality: st.quality / 100 }); if (!alive) return;
        const name = safeBase(file.name) + '-no-background.' + EXT[st.format]; save(r.blob, name);
        status.textContent = 'Saved ' + name + ' · ' + r.width + ' × ' + r.height + ' px · ' + formatBytes(r.blob.size) + (r.transparent ? ' · transparent background' : ' · filled background') + (r.reduced ? ' · reduced from ' + r.from[0] + ' × ' + r.from[1] + ' to keep it fast' : '') + '.';
      } catch (err) { if (alive) status.textContent = err.userMessage || 'Could not create the image.'; }
      busy = false; if (alive) render();
    }

    sync(); render();
    return () => { alive = false; if (frame) cancelAnimationFrame(frame); clearTimeout(saveTimer); if (saveUrl) URL.revokeObjectURL(saveUrl); releaseCanvas(base); releaseCanvas(outCanvas); };
  },
};
