import { h } from '../dom.js';
import { formatBytes } from '../../core/format.js';
import { inspectImage, decodeImage } from '../../core/decode.js';
import { buildZip } from '../../core/zip.js';
import { MAX_ZIP_BYTES } from '../../core/limits.js';
import { keepMime } from '../../core/heic.js';
import { checkLimits, createRunner, safeBase, uniqueName, extFor } from '../../core/batch.js';
import { DEFAULTS, PRESETS, FONTS, POSITIONS, POSITION_LABELS, RANGES, MAX_TEXT, normalizeWatermark, hasContent } from '../../core/watermark.js';
import { previewBase, paintPreview, prepareLogo, watermarkBitmap } from '../../core/watermark-render.js';
import { releaseCanvas } from '../../core/render.js';

const SLIDERS = [['size', 'Size', '% of the image width', '%'], ['opacity', 'Opacity', '100 = solid, lower = see-through', '%'], ['rotation', 'Rotation', 'Turns the mark. Tiled marks turn together.', '°']];
const FORMATS = [['keep', 'Keep format'], ['jpeg', 'JPG'], ['png', 'PNG'], ['webp', 'WEBP']];
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const KIND = { jpeg: 'JPG', png: 'PNG', webp: 'WEBP', heic: 'HEIC' };
const STATUS = { queued: 'Queued', processing: 'Processing…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const ACCEPT = 'image/jpeg,image/png,image/webp';
const ACCEPT_PHOTO = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';

export default {
  mount(el, { session }) {
    const s0 = session.getState(), { bitmap, width: sw, height: sh } = s0.decoded, file = s0.file;
    let base;
    try { base = previewBase(bitmap); }
    catch (err) { el.append(h('p', { class: 'dz-error', role: 'alert' }, err.userMessage || 'This image could not be prepared. Try a smaller picture.'), h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => session.clear() }, 'Choose another image')); return () => {}; }
    const st = { wm: normalizeWatermark(), preset: 'corner', view: 'after', compare: 50, format: 'keep', quality: 92 };
    Object.assign(st.wm, PRESETS[0].values);
    let alive = true, logo = null, frame = 0, runner = null, running = false, seq = 0, extras = [], saveUrl = null, saveTimer = 0;
    const outCanvas = h('canvas', { class: 'sig-layer', width: base.width, height: base.height, role: 'img', 'aria-label': 'Watermarked preview' });
    base.className = 'sig-layer'; base.setAttribute('role', 'img'); base.setAttribute('aria-label', 'Original picture');

    const seg = (label, items, onPick) => {
      const btns = items.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': 'false', 'data-v': v, onClick: () => onPick(v) }, t));
      return { btns, el: h('div', { class: 'seg', role: 'group', 'aria-label': label }, btns) };
    };
    const set = (k, v) => { st.wm[k] = v; st.preset = 'custom'; changed(); };

    // ---------- 1. picture
    const fileInput = h('input', { type: 'file', accept: ACCEPT_PHOTO, class: 'hidden', 'aria-hidden': 'true', tabindex: '-1' });
    const fileErr = h('p', { class: 'dz-error sig-left', role: 'alert', hidden: true });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0]; fileInput.value = ''; if (!f) return; fileErr.hidden = true;
      try { await session.loadFile(f); } catch (err) { if (alive) { fileErr.textContent = err.userMessage || 'Could not read this image.'; fileErr.hidden = false; } }
    });
    // ---------- 2. preview
    const divider = h('div', { class: 'sig-divider hidden' });
    const view = h('div', { class: 'sig-view checker' }, base, outCanvas, divider);
    const stage = h('div', { class: 'sig-stage' }, view); stage.style.setProperty('--ar', String(sw / sh));
    const viewSeg = seg('Preview', [['after', 'Watermarked'], ['before', 'Original'], ['compare', 'Compare']], (v) => { st.view = v; sync(); });
    const compare = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '50', class: 'sig-compare hidden', 'aria-label': 'Before and after divider' });
    compare.addEventListener('input', () => { st.compare = Number(compare.value); applyView(); });
    const notesEl = h('div', { class: 'notice-list', id: 'wm-notes', role: 'status' });
    const emptyHint = h('p', { class: 'tool-hint sig-tip hidden', id: 'wm-empty' });

    // ---------- 3. content
    const typeSeg = seg('Watermark type', [['text', 'Text'], ['logo', 'Logo']], (v) => set('type', v));
    const textIn = h('input', { type: 'text', id: 'wm-text', maxlength: String(MAX_TEXT), class: 'wm-text', 'aria-label': 'Watermark text', autocomplete: 'off' });
    textIn.addEventListener('input', () => { st.wm.text = textIn.value; st.preset = 'custom'; changed(); });
    const fontSeg = seg('Font', Object.entries(FONTS).map(([k, f]) => [k, f.label]), (v) => set('font', v));
    const boldIn = h('input', { type: 'checkbox', id: 'wm-bold' }), outIn = h('input', { type: 'checkbox', id: 'wm-outline' });
    boldIn.addEventListener('change', () => set('bold', boldIn.checked)); outIn.addEventListener('change', () => set('outline', outIn.checked));
    const colorIn = h('input', { type: 'color', id: 'wm-color', 'aria-label': 'Text colour' }); colorIn.addEventListener('input', () => set('color', colorIn.value));
    const textGroup = h('div', { class: 'wm-text-group' },
      h('div', { class: 'tool-row' }, h('label', { for: 'wm-text', class: 'sig-lbl' }, 'Text'), textIn),
      h('div', { class: 'tool-row' }, fontSeg.el, h('label', { class: 'check' }, boldIn, 'Bold'), h('label', { class: 'check' }, outIn, 'Outline for contrast'), h('div', { class: 'ctrl-group' }, h('label', { for: 'wm-color' }, 'Colour'), colorIn)));
    const logoInput = h('input', { type: 'file', accept: ACCEPT, class: 'hidden', 'aria-hidden': 'true', tabindex: '-1', id: 'wm-logo-input' });
    const logoName = h('span', { class: 'readout', id: 'wm-logo-name' }, 'No logo chosen');
    const logoErr = h('p', { class: 'dz-error sig-left', role: 'alert', hidden: true, id: 'wm-logo-err' });
    logoInput.addEventListener('change', async () => {
      const f = logoInput.files[0]; logoInput.value = ''; if (!f) return; logoErr.hidden = true;
      let dec = null;
      try {
        dec = await decodeImage(f);
        const next = prepareLogo(dec.bitmap, f.name || 'logo');
        if (logo) releaseCanvas(logo.canvas);
        logo = next; logoName.textContent = logo.name + ' · ' + dec.width + ' × ' + dec.height + ' px';
        if (st.wm.type !== 'logo') { st.wm.type = 'logo'; st.preset = 'custom'; }
        changed();
      } catch (err) { if (alive) { logoErr.textContent = err.userMessage || 'Could not read this logo.'; logoErr.hidden = false; } }
      finally { if (dec) dec.bitmap.close(); }
    });
    const logoGroup = h('div', { class: 'wm-logo-group' }, h('div', { class: 'tool-row' }, h('button', { type: 'button', class: 'btn btn-ghost', id: 'wm-logo-btn', onClick: () => logoInput.click() }, 'Choose logo'), logoName, logoInput),
      h('p', { class: 'tool-hint' }, 'JPG, PNG or WEBP. A PNG with a transparent background works best. The logo never leaves this device.'), logoErr);

    // ---------- 4. style
    const sliders = {};
    const sliderRows = SLIDERS.map(([key, label, hint, unit]) => {
      const input = h('input', { type: 'range', id: 'wm-' + key, min: String(RANGES[key][0]), max: String(RANGES[key][1]), step: '1', 'aria-describedby': 'wm-' + key + '-hint' });
      const out = h('span', { class: 'readout', 'aria-hidden': 'true' });
      input.addEventListener('input', () => set(key, Number(input.value)));
      sliders[key] = { input, out, unit };
      return h('div', { class: 'sig-slider' }, h('div', { class: 'sig-slider-top' }, h('label', { for: 'wm-' + key }, label), out), input, h('p', { class: 'tool-hint', id: 'wm-' + key + '-hint' }, hint));
    });
    // ---------- 5. layout
    const modeSeg = seg('Layout', [['single', 'Single mark'], ['tile', 'Repeated (tiled)']], (v) => set('mode', v));
    const posBtns = POSITIONS.map((p) => h('button', { type: 'button', class: 'wm-pos', 'data-v': p, 'aria-pressed': 'false', 'aria-label': POSITION_LABELS[p], title: POSITION_LABELS[p], onClick: () => set('position', p) }, h('span', { class: 'wm-dot' })));
    const posGrid = h('div', { class: 'wm-grid', role: 'group', 'aria-label': 'Position' }, posBtns);
    const mkSlider = (key, label, hint, unit) => {
      const input = h('input', { type: 'range', id: 'wm-' + key, min: String(RANGES[key][0]), max: String(RANGES[key][1]), step: '1', 'aria-describedby': 'wm-' + key + '-hint' });
      const out = h('span', { class: 'readout', 'aria-hidden': 'true' }); input.addEventListener('input', () => set(key, Number(input.value))); sliders[key] = { input, out, unit };
      return h('div', { class: 'sig-slider' }, h('div', { class: 'sig-slider-top' }, h('label', { for: 'wm-' + key }, label), out), input, h('p', { class: 'tool-hint', id: 'wm-' + key + '-hint' }, hint));
    };
    const marginRow = mkSlider('margin', 'Margin from the edge', '% of the shorter side', '%'), gapRow = mkSlider('gap', 'Spacing between copies', '% of the mark size', '%');
    const staggerIn = h('input', { type: 'checkbox', id: 'wm-stagger' }); staggerIn.addEventListener('change', () => set('stagger', staggerIn.checked));
    const staggerRow = h('label', { class: 'check' }, staggerIn, 'Offset every other row');
    const singleGroup = h('div', { class: 'wm-single' }, h('div', { class: 'tool-row' }, h('span', { class: 'sig-lbl' }, 'Position'), posGrid), marginRow);
    const tileGroup = h('div', { class: 'wm-tile' }, gapRow, staggerRow);
    const presetBtns = PRESETS.map((p) => h('button', { type: 'button', class: 'chip', 'data-key': p.key, 'aria-pressed': 'false', title: p.hint, onClick: () => { Object.assign(st.wm, p.values); st.preset = p.key; changed(); } }, p.label));

    // ---------- 6. output
    const fmtSeg = seg('Output format', FORMATS, (v) => { st.format = v; sync(); });
    const qIn = h('input', { type: 'range', id: 'wm-quality', min: '60', max: '100', step: '1' }), qOut = h('span', { class: 'readout' });
    qIn.addEventListener('input', () => { st.quality = Number(qIn.value); qOut.textContent = st.quality + '%'; });
    const qGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'wm-quality' }, 'Quality'), qIn, qOut);
    const status = h('p', { class: 'tool-hint', id: 'wm-status', role: 'status' });
    const dlBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'wm-download', onClick: downloadOne }, 'Download watermarked image');
    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'wm-reset', onClick: () => { st.wm = normalizeWatermark(); Object.assign(st.wm, PRESETS[0].values); st.preset = 'corner'; st.view = 'after'; st.format = 'keep'; st.quality = 92; changed(); } }, 'Reset');

    // ---------- 7. batch
    const batchInput = h('input', { type: 'file', multiple: true, accept: ACCEPT_PHOTO, class: 'hidden', 'aria-hidden': 'true', tabindex: '-1', id: 'wm-batch-input' });
    batchInput.addEventListener('change', () => { const fs = [...batchInput.files]; batchInput.value = ''; addExtras(fs); });
    const batchMsg = h('p', { class: 'dz-error sig-left', role: 'alert', hidden: true, id: 'wm-batch-msg' });
    const list = h('ul', { class: 'wm-list', 'aria-label': 'Images for the batch', id: 'wm-list' });
    const zipBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'wm-zip', onClick: runBatch }, 'Watermark all and download ZIP');
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost hidden', id: 'wm-cancel', onClick: () => { if (runner) runner.cancel(); } }, 'Cancel pending');
    const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'wm-clear', onClick: () => { if (!running) { extras = []; renderList(); } } }, 'Remove added images');
    const batchStatus = h('p', { class: 'tool-hint', id: 'wm-batch-status', role: 'status' });

    el.append(
      h('h2', { class: 'tool-title' }, '1 · Your picture'),
      h('div', { class: 'tool-row sig-top' }, h('div', { class: 'sig-file' }, h('p', { class: 'sig-file-name' }, file.name || 'image'), h('p', { class: 'sig-file-meta' }, sw + ' × ' + sh + ' px · ' + formatBytes(file.size) + ' · ' + (KIND[s0.decoded.kind.type] || ''))),
        h('div', { class: 'spacer' }), h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => fileInput.click() }, 'Replace image'), h('button', { type: 'button', class: 'btn btn-ghost', id: 'wm-remove', onClick: () => session.clear() }, 'Remove image'), fileInput),
      fileErr,
      h('h2', { class: 'tool-title' }, '2 · Preview'),
      h('div', { class: 'tool-row' }, viewSeg.el, compare), stage, emptyHint, notesEl,
      h('h2', { class: 'tool-title' }, '3 · Watermark'),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Presets' }, presetBtns),
      h('div', { class: 'tool-row' }, typeSeg.el), textGroup, logoGroup,
      h('h2', { class: 'tool-title' }, '4 · Size, opacity and rotation'), h('div', { class: 'sig-sliders' }, sliderRows),
      h('h2', { class: 'tool-title' }, '5 · Placement'), h('div', { class: 'tool-row' }, modeSeg.el), singleGroup, tileGroup,
      h('h2', { class: 'tool-title' }, '6 · Save this image'),
      h('div', { class: 'tool-row' }, fmtSeg.el, qGroup),
      h('p', { class: 'tool-hint' }, 'The watermark is drawn into the pixels at the original size. Saving re-encodes the image, which removes camera and location data.'),
      h('div', { class: 'tool-row' }, dlBtn, resetBtn), status,
      h('h2', { class: 'tool-title' }, '7 · Many images at once'),
      h('p', { class: 'tool-hint' }, 'Applies the same watermark to this image and every image you add, and gives you one ZIP. Size and margin are relative, so they fit each image.'),
      h('div', { class: 'tool-row' }, h('button', { type: 'button', class: 'btn btn-ghost', id: 'wm-add', onClick: () => batchInput.click() }, 'Add images'), clearBtn, batchInput),
      batchMsg, list, h('div', { class: 'tool-row' }, zipBtn, cancelBtn), batchStatus);

    // ---------- state -> UI
    function applyView() {
      const v = st.view, cmp = v === 'compare';
      base.classList.toggle('hidden', v === 'after'); outCanvas.classList.toggle('hidden', v === 'before');
      base.style.clipPath = cmp ? 'inset(0 ' + (100 - st.compare) + '% 0 0)' : ''; outCanvas.style.clipPath = cmp ? 'inset(0 0 0 ' + st.compare + '%)' : '';
      divider.classList.toggle('hidden', !cmp); divider.style.left = st.compare + '%'; compare.classList.toggle('hidden', !cmp);
    }
    function sync() {
      const w = st.wm;
      for (const [k, { input, out, unit }] of Object.entries(sliders)) { if (document.activeElement !== input) input.value = String(w[k]); out.textContent = w[k] + unit; }
      if (document.activeElement !== textIn) textIn.value = w.text;
      boldIn.checked = w.bold; outIn.checked = w.outline; staggerIn.checked = w.stagger; colorIn.value = w.color; qIn.value = String(st.quality); qOut.textContent = st.quality + '%';
      typeSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === w.type))); fontSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === w.font)));
      modeSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === w.mode))); viewSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.view)));
      fmtSeg.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.format))); posBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === w.position)));
      presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === st.preset)));
      textGroup.classList.toggle('hidden', w.type !== 'text'); logoGroup.classList.toggle('hidden', w.type !== 'logo');
      singleGroup.classList.toggle('hidden', w.mode !== 'single'); tileGroup.classList.toggle('hidden', w.mode !== 'tile');
      qGroup.classList.toggle('hidden', !(st.format === 'jpeg' || st.format === 'webp' || (st.format === 'keep' && keepMime(s0.decoded.kind) !== 'image/png')));
      compare.value = String(st.compare); applyView();
    }
    function changed() { sync(); if (!frame) frame = requestAnimationFrame(render); }
    function render() {
      frame = 0; if (!alive) return;
      const res = paintPreview(outCanvas, base, st.wm, logo), msgs = [...res.notes];
      emptyHint.classList.toggle('hidden', !(res.empty || res.error));
      emptyHint.textContent = res.empty ? (st.wm.type === 'logo' ? 'Choose a logo to see it here.' : 'Type some text to see the watermark.') : res.error ? res.error.message : '';
      notesEl.replaceChildren(...msgs.map((m) => h('p', { class: 'notice' }, m)));
      dlBtn.disabled = zipBtn.disabled = !!(res.empty || res.error) || running;
    }

    // ---------- save one
    const mimeFor = (kind) => (st.format === 'keep' ? keepMime(kind) : MIME[st.format]);
    const outFile = (name, mime) => safeBase(name) + '-watermarked.' + extFor(mime);
    function save(blob, name) {
      const url = URL.createObjectURL(blob), a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
      clearTimeout(saveTimer); if (saveUrl) URL.revokeObjectURL(saveUrl); saveUrl = url; saveTimer = setTimeout(() => { URL.revokeObjectURL(url); if (saveUrl === url) saveUrl = null; }, 4000);
    }
    async function downloadOne() {
      if (running) return; status.textContent = 'Preparing the image…'; dlBtn.disabled = true;
      try {
        const mime = mimeFor(s0.decoded.kind), r = await watermarkBitmap(bitmap, normalizeWatermark(st.wm), logo, { mime, quality: st.quality / 100 }); if (!alive) return;
        const name = outFile(file.name, mime); save(r.blob, name);
        status.textContent = 'Saved ' + name + ' · ' + r.width + ' × ' + r.height + ' px · ' + formatBytes(r.blob.size) + (r.count > 1 ? ' · ' + r.count + ' copies of the watermark' : '') + '.';
      } catch (err) { if (alive) status.textContent = err.userMessage || 'Could not create the image.'; }
      if (alive) render();
    }

    // ---------- batch
    async function addExtras(files) {
      batchMsg.hidden = true; const problems = [];
      for (const f of files) {
        const lim = checkLimits({ count: extras.length + 1, bytes: extras.reduce((n, i) => n + i.file.size, file.size) }, f);
        if (!lim.ok) { problems.push(lim.message); break; }
        try { const info = await inspectImage(f); if (!alive) return; extras.push({ id: 'x' + ++seq, file: f, info, pixels: info.width * info.height, status: 'queued' }); }
        catch (err) { problems.push((f.name || 'file') + ': ' + (err.userMessage || 'could not be read.')); }
      }
      if (problems.length) { batchMsg.textContent = problems.join(' '); batchMsg.hidden = false; }
      renderList();
    }
    function renderList() {
      const row = (name, meta, state, onRemove) => h('li', { class: 'wm-item' }, h('span', { class: 'wm-item-name' }, name), h('span', { class: 'wm-item-meta' }, meta), h('span', { class: 'wm-item-state', 'data-state': state.key }, state.text), onRemove ? h('button', { type: 'button', class: 'btn btn-ghost wm-x', 'aria-label': 'Remove ' + name, disabled: running, onClick: onRemove }, '×') : null);
      list.replaceChildren(row(file.name || 'image', sw + ' × ' + sh + ' · this image', cur, null), ...extras.map((i) => row(i.file.name || 'image', i.info.width + ' × ' + i.info.height + ' · ' + formatBytes(i.file.size), { key: i.status, text: i.error || STATUS[i.status] }, () => { extras = extras.filter((x) => x !== i); renderList(); })));
      zipBtn.textContent = extras.length ? 'Watermark all ' + (extras.length + 1) + ' and download ZIP' : 'Watermark and download as ZIP (1 image)';
    }
    const cur = { key: 'queued', text: 'Queued' };
    async function runBatch() {
      if (running) return;
      const wm = normalizeWatermark(st.wm); running = true; cancelBtn.classList.remove('hidden'); zipBtn.disabled = dlBtn.disabled = true; batchMsg.hidden = true;
      const used = new Set(), results = new Map(), jobs = [{ id: 'cur', pixels: sw * sh, file, kind: s0.decoded.kind, current: true }, ...extras.map((i) => ({ id: i.id, pixels: i.pixels, file: i.file, kind: i.info.kind }))];
      jobs.forEach((j) => { j.mime = mimeFor(j.kind); j.outName = uniqueName(outFile(j.file.name, j.mime), used); });
      extras.forEach((i) => { i.status = 'queued'; i.error = ''; }); cur.key = 'queued'; cur.text = 'Queued'; renderList();
      const setState = (job, key, text) => { if (job.current) { cur.key = key; cur.text = text; } else { const it = extras.find((x) => x.id === job.id); if (it) { it.status = key; it.error = key === 'failed' ? text : ''; } } if (alive) renderList(); };
      let done = 0;
      runner = createRunner({
        run: async (job, isCancelled) => {
          const dec = job.current ? null : await decodeImage(job.file);
          try { if (isCancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true }); return await watermarkBitmap(dec ? dec.bitmap : bitmap, wm, logo, { mime: job.mime, quality: st.quality / 100 }); }
          finally { if (dec) dec.bitmap.close(); }
        },
        onEvent: (e) => {
          if (!alive) return;
          if (e.type === 'start') setState(e.job, 'processing', STATUS.processing);
          else if (e.type === 'done') { results.set(e.job.id, e.result); done++; setState(e.job, 'done', STATUS.done); }
          else if (e.type === 'fail') setState(e.job, 'failed', e.error.userMessage || 'Could not process this image.');
          else if (e.type === 'cancelled') setState(e.job, 'cancelled', STATUS.cancelled);
          batchStatus.textContent = done + ' of ' + jobs.length + ' done.';
        },
      });
      await runner.start(jobs); runner = null;
      try {
        if (!alive) return;
        const entries = jobs.filter((j) => results.has(j.id)).map((j) => ({ name: j.outName, data: results.get(j.id).blob }));
        if (!entries.length) batchMsg.textContent = 'No image could be watermarked, so there is nothing to download.';
        else if (entries.reduce((n, e) => n + e.data.size, 0) > MAX_ZIP_BYTES) batchMsg.textContent = 'The finished images add up to more than a ZIP can hold in the browser. Process fewer images at a time.';
        else { save(await buildZip(entries, { isCancelled: () => !alive }), 'watermarked-images.zip'); batchStatus.textContent = 'ZIP saved with ' + entries.length + ' of ' + jobs.length + ' images.' + (entries.length < jobs.length ? ' Some images failed: see the list.' : ''); }
        batchMsg.hidden = !batchMsg.textContent || !!entries.length && entries.length === jobs.length ? true : batchMsg.hidden;
        if (!entries.length || entries.reduce((n, e) => n + e.data.size, 0) > MAX_ZIP_BYTES) batchMsg.hidden = false;
      } catch (err) { if (alive) { batchMsg.textContent = err.userMessage || 'Could not build the ZIP.'; batchMsg.hidden = false; } }
      results.clear(); running = false; if (alive) { cancelBtn.classList.add('hidden'); render(); renderList(); }
    }

    sync(); renderList(); render();
    return () => {
      alive = false; if (frame) cancelAnimationFrame(frame); if (runner) runner.cancel(); clearTimeout(saveTimer); if (saveUrl) URL.revokeObjectURL(saveUrl);
      releaseCanvas(base); releaseCanvas(outCanvas); if (logo) releaseCanvas(logo.canvas);
    };
  },
};
