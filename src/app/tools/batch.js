import { h } from '../dom.js';
import { inspectImage } from '../../core/decode.js';
import { processFile } from '../../core/batchjob.js';
import { Cancelled } from '../../core/solve.js';
import { buildZip, verifyZip } from '../../core/zip.js';
import { userMessageOf } from '../../core/errors.js';
import { formatBytes, sizeDelta } from '../../core/format.js';
import { MAX_BATCH_FILES, MAX_BATCH_BYTES, MAX_FILE_BYTES, MAX_ZIP_BYTES } from '../../core/limits.js';
import { DEFAULT_SETTINGS, PRESETS, normalizeSettings, outputMime, outputName, suffixFor, uniqueName, safeBase, extFor, checkLimits, createRunner } from '../../core/batch.js';

const FMT = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP', 'image/heic': 'HEIC' };
const STATUS = { queued: 'Queued', processing: 'Processing…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const TARGETS = [['100 KB', 100], ['200 KB', 200], ['500 KB', 500], ['1 MB', 1024]];
const THUMB = 112, THUMB_MAX_PIXELS = 40_000_000;   // very large images get no thumbnail: decoding them just to preview is not worth the memory
const MB = (n) => Math.round(n / 1048576);

/** Batch Processing. Reuses decodeImage + runPipeline (via processFile) for every image; adds only queueing, naming and ZIP. */
export default {
  mount(el) {
    const ui = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));   // live (unvalidated) option values
    let items = [], seq = 0, running = false, adding = false, alive = true, runner = null, stale = false, zipBusy = false, runInfo = null, rejected = [];
    const rows = new Map(), urls = new Map();   // urls: object URL -> pending revoke timer
    const byId = (id) => items.find((i) => i.id === id);
    const totalBytes = () => items.reduce((n, i) => n + i.file.size, 0);

    // ------------------------------------------------------------ pieces
    const input = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif' });
    const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Choose images' },
      h('p', { class: 'dz-title' }, 'Drop images here, or click to choose several'),
      h('p', { class: 'dz-sub' }, 'JPG · PNG · WEBP · HEIC — stays on this device. HEIC files are saved as JPG unless you pick another format.'), input);
    const limitsNote = h('p', { class: 'tool-hint batch-limits' }, 'Limits: up to ' + MAX_BATCH_FILES + ' images, ' + MB(MAX_BATCH_BYTES) + ' MB in total, ' + MB(MAX_FILE_BYTES) + ' MB each. Each image also keeps the usual size limits (100 MP in, 40 MP out).');
    const rejectBox = h('div', { class: 'batch-rejected hidden', role: 'alert' });

    const seg = (label, group, opts, get, set) => {
      const btns = opts.map(([text, val]) => h('button', { type: 'button', 'aria-pressed': 'false', 'data-v': val, onClick: () => { set(val); changed(); } }, text));
      return { btns, get, node: h('div', { class: 'ctrl-group' }, h('label', {}, label), h('div', { class: 'seg', role: 'group', 'aria-label': group }, btns)) };
    };
    const segs = [
      seg('Resize', 'Batch resize', [['Off', 'off'], ['Width', 'width'], ['Height', 'height'], ['Fit box', 'box']], () => ui.resize.mode, (v) => { ui.resize.mode = v; }),
      seg('Format', 'Batch format', [['Keep', 'keep'], ['JPG', 'jpeg'], ['PNG', 'png'], ['WEBP', 'webp']], () => ui.format, (v) => { ui.format = v; }),
      seg('Compress', 'Batch compress', [['Off', 'off'], ['Quality', 'quality'], ['Target size', 'target']], () => ui.compress, (v) => { ui.compress = v; }),
    ];
    const [resizeSeg, formatSeg, compressSeg] = segs;
    const wIn = h('input', { type: 'number', id: 'bw', min: '1', inputmode: 'numeric', 'aria-label': 'Width in pixels' });
    const hIn = h('input', { type: 'number', id: 'bh', min: '1', inputmode: 'numeric', 'aria-label': 'Height in pixels' });
    const keep = h('input', { type: 'checkbox', id: 'bkeep' }), up = h('input', { type: 'checkbox', id: 'bup' });
    const keepRow = h('label', { class: 'check' }, keep, 'Keep aspect ratio');
    const wGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'bw' }, 'Width'), wIn, h('span', { class: 'readout' }, 'px'));
    const hGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'bh' }, 'Height'), hIn, h('span', { class: 'readout' }, 'px'));
    const presets = h('div', { class: 'chips', 'aria-label': 'Preset sizes' }, PRESETS.map(([label, w, hh]) => h('button', { type: 'button', class: 'chip', onClick: () => { ui.resize.mode = 'box'; ui.resize.width = w; ui.resize.height = hh; changed(); } }, label)));
    const resizeRow = h('div', { class: 'tool-row' }, wGroup, hGroup, keepRow, h('label', { class: 'check' }, up, 'Allow enlarging'), presets);
    const quality = h('input', { type: 'range', id: 'bquality', min: '10', max: '95', step: '5', value: '70', 'aria-label': 'Quality' }), qOut = h('span', { class: 'readout' }, '70%');
    const qGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'bquality' }, 'Quality'), quality, qOut);
    const target = h('input', { type: 'number', id: 'btarget', min: '1', max: '50000', inputmode: 'numeric', 'aria-label': 'Target size in KB' });
    const tChips = TARGETS.map(([label, kb]) => h('button', { type: 'button', class: 'chip', onClick: () => { ui.targetKB = kb; changed(); } }, label));
    const tGroup = h('div', { class: 'ctrl-group target-group' }, h('label', { for: 'btarget' }, 'Max size'), target, h('span', { class: 'readout' }, 'KB'), h('div', { class: 'chips' }, tChips));
    const strip = h('input', { type: 'checkbox', id: 'bstrip' });
    const stripRow = h('label', { class: 'check' }, strip, 'Remove metadata (location, camera, date…)');
    const targetHint = h('p', { class: 'tool-hint hidden' }, 'PNG is lossless, so target size only applies to JPG and WEBP outputs. PNG files are saved losslessly.');
    const settingsError = h('p', { class: 'dz-error', role: 'alert', hidden: true });
    const settingsEl = h('div', { class: 'tool-area batch-settings' },
      h('div', { class: 'tool-row' }, resizeSeg.node, formatSeg.node), resizeRow,
      h('div', { class: 'tool-row' }, compressSeg.node, qGroup, tGroup), targetHint, h('div', { class: 'tool-row' }, stripRow),
      h('p', { class: 'tool-hint' }, 'Width, Height and Fit box keep the proportions and never enlarge unless you tick “Allow enlarging”. Without “Keep aspect ratio”, Fit box makes every image exactly that size, which can stretch it. Images are never enlarged past the 40 MP output limit.'),
      settingsError);

    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => input.click() }, 'Add images');
    const processBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'bprocess', onClick: () => processAll() }, 'Process');
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost hidden', id: 'bcancel', onClick: () => { if (runner) runner.cancel(); } }, 'Cancel pending');
    const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'bclear', onClick: () => clearAll() }, 'Clear all');
    const totals = h('span', { class: 'readout', id: 'btotals' });
    const toolbar = h('div', { class: 'tool-row batch-toolbar' }, processBtn, cancelBtn, addBtn, clearBtn, h('div', { class: 'spacer' }), totals);
    const barFill = h('div', { class: 'bar-fill' }), barLabel = h('span', { 'aria-live': 'polite', id: 'bstatus', role: 'status' });
    const progress = h('div', { class: 'bar-row hidden' }, h('div', { class: 'bar-track' }, barFill), h('div', { class: 'bar-caption' }, barLabel));
    const cancelHint = h('p', { class: 'tool-hint hidden' }, 'Cancel stops images that have not started. An image already being processed may still finish.');
    const empty = h('p', { class: 'batch-empty' }, 'No images yet. Drop some above to build a batch.');
    const list = h('ul', { class: 'batch-list', 'aria-label': 'Images in this batch' });
    const failBox = h('div', { class: 'batch-fail hidden', role: 'status' });
    const zipBtn = h('button', { type: 'button', class: 'btn btn-primary hidden', id: 'bzip', onClick: () => downloadZip() }, 'Download ZIP');
    const origChk = h('input', { type: 'checkbox', id: 'borig' });
    const origRow = h('label', { class: 'check hidden' }, origChk, 'Also put the original files in the ZIP (in an originals folder)');
    const staleNote = h('p', { class: 'tool-hint hidden' }, 'Options changed since the last run. Press Process to apply them to every image again.');
    const zipMsg = h('p', { class: 'dz-error', role: 'alert', hidden: true });
    const zipRow = h('div', { class: 'tool-row batch-zip' }, zipBtn, origRow);
    el.append(limitsNote, h('div', { class: 'stage active' }, zone), rejectBox, settingsEl, toolbar, progress, cancelHint, empty, list, failBox, staleNote, zipRow, zipMsg);

    // ------------------------------------------------------------ adding files
    async function addFiles(fileList) {
      if (adding || running) return;
      const files = Array.from(fileList || []); if (!files.length) return;
      adding = true; render();
      const bad = [];
      for (const file of files) {
        if (!alive) return;
        try {
          const info = await inspectImage(file);                       // same independent validation as the single-image tools (checked first: an invalid file is reported as invalid)
          const lim = checkLimits({ count: items.length, bytes: totalBytes() }, file);
          if (!lim.ok) { bad.push([file.name, lim.message]); continue; }
          const item = { id: ++seq, file, info, pixels: info.width * info.height * (info.kind.type === 'heic' ? 3 : 1), thumb: null, thumbSkipped: false, status: 'queued', error: '', result: null, notes: [], outName: '' };
          items.push(item); queueThumb(item); render();
        } catch (err) { bad.push([file.name, err.userMessage || 'This file could not be read.']); }
      }
      adding = false; rejected = bad; stale = false; render();
    }
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
    input.addEventListener('change', () => { const f = Array.from(input.files); input.value = ''; addFiles(f); });

    // thumbnails: one at a time, canvases (no object URLs to leak)
    let thumbChain = Promise.resolve();
    const queueThumb = (item) => { thumbChain = thumbChain.then(() => makeThumb(item)).catch(() => {}); };
    async function makeThumb(item) {
      if (!alive || !items.includes(item)) return;
      if (item.pixels / (item.info.kind.type === 'heic' ? 3 : 1) > THUMB_MAX_PIXELS) { item.thumbSkipped = true; return render(); }
      if (item.info.kind.type === 'heic') { item.thumbSkipped = true; item.thumbNote = 'HEIC'; return render(); }   // a thumbnail would need a FULL wasm decode on the main thread (measured ~0.5-0.8 s at 12 MP) and the file is decoded again when processed: the thumbnail comes from the result instead
      let bm;
      try { bm = await createImageBitmap(item.file, { resizeWidth: THUMB, resizeQuality: 'low' }); }
      catch (e) { try { bm = await createImageBitmap(item.file); } catch (e2) { item.thumbSkipped = true; return render(); } }
      if (!alive || !items.includes(item)) { bm.close(); return; }
      try { item.thumb = thumbCanvas(bm); } catch (e) { item.thumbSkipped = true; } finally { bm.close(); }       // the bitmap is freed even if drawing fails
      render();
    }
    function thumbCanvas(bm) {
      const k = Math.min(1, THUMB / Math.max(bm.width, bm.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bm.width * k)); c.height = Math.max(1, Math.round(bm.height * k));
      try { c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height); return c; } catch (e) { c.width = 0; c.height = 0; throw e; }
    }
    // HEIC rows get their thumbnail from the processed file (an ordinary JPG/PNG/WEBP: cheap, no second wasm decode)
    const queueResultThumb = (item) => { thumbChain = thumbChain.then(async () => {
      if (!alive || !items.includes(item) || item.thumb || !item.result) return;
      let bm; try { bm = await createImageBitmap(item.result.blob, { resizeWidth: THUMB, resizeQuality: 'low' }); } catch (e) { return; }
      if (!alive || !items.includes(item)) { bm.close(); return; }
      try { item.thumb = thumbCanvas(bm); } catch (e) { /* keep the text placeholder */ } finally { bm.close(); }
      render();
    }).catch(() => {}); };
    function release(item) { if (item.thumb) { item.thumb.width = 0; item.thumb.height = 0; item.thumb = null; } item.result = null; }
    function removeItem(id) { const it = byId(id); if (!it || running) return; release(it); items = items.filter((i) => i !== it); stale = false; render(); }
    function clearAll() { if (running) return; items.forEach(release); items = []; rejected = []; runInfo = null; stale = false; zipMsg.hidden = true; render(); }

    // ------------------------------------------------------------ processing
    async function processAll() {
      const v = normalizeSettings(ui);
      if (!v.ok || !items.length || running || adding) return;
      await thumbChain;                                                  // never decode previews and process at the same time
      if (!alive) return;
      const settings = v.settings, suffix = suffixFor(settings), used = new Set();
      runInfo = { settings, total: items.length };
      for (const it of items) {                                          // names are fixed up front, in queue order, so ZIP and single downloads agree
        it.status = 'queued'; it.error = ''; it.result = null; it.notes = [];
        it.outName = uniqueName(outputName(it.file.name, outputMime(settings, it.info.kind), suffix), used);
      }
      running = true; stale = false; zipMsg.hidden = true; render();
      runner = createRunner({
        run: (job, isCancelled) => processFile(byId(job.id).file, settings, { isCancelled }),
        onEvent: (e) => {
          const it = byId(e.job.id); if (!it || !alive) return;
          if (e.type === 'start') it.status = 'processing';
          else if (e.type === 'done') { it.status = 'done'; it.result = e.result; it.notes = e.result.notes || []; if (it.info.kind.type === 'heic') queueResultThumb(it); }
          else if (e.type === 'cancelled') it.status = 'cancelled';
          else if (e.type === 'fail') {
            if (e.error instanceof Cancelled) it.status = 'cancelled';
            else { it.status = 'failed'; it.error = userMessageOf(e.error, 'Something went wrong while processing this image.'); }
          }
          render();
        },
      });
      await runner.start(items.map((i) => ({ id: i.id, pixels: i.pixels })));
      runner = null; running = false; if (alive) render();
    }

    // ------------------------------------------------------------ downloads
    function saveBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
      urls.set(url, setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 4000));
    }
    async function downloadZip() {
      const done = items.filter((i) => i.status === 'done' && i.result);
      if (!done.length || zipBusy || running) return;
      const withOrig = origChk.checked;
      const size = done.reduce((n, i) => n + i.result.blob.size + (withOrig ? i.file.size : 0), 0);
      zipMsg.hidden = true;
      if (size > MAX_ZIP_BYTES) { zipMsg.textContent = 'These files add up to ' + formatBytes(size) + ', too much to ZIP in the browser. Download them one by one, or process fewer images.'; zipMsg.hidden = false; return; }
      zipBusy = true; render();
      try {
        const entries = done.map((i) => ({ name: i.outName, data: i.result.blob }));
        if (withOrig) { const u = new Set(); done.forEach((i) => entries.push({ name: 'originals/' + uniqueName(safeBase(i.file.name) + '.' + extFor(i.info.kind.mime), u), data: i.file })); }
        const zip = await buildZip(entries, { isCancelled: () => !alive });
        await verifyZip(zip, entries);                                   // entry count, names, sizes, offsets: a ZIP that fails its own check is never offered
        if (alive) saveBlob(zip, 'shrinkit-batch.zip');
      } catch (err) { if (alive) { zipMsg.textContent = userMessageOf(err, 'Could not build the ZIP.'); zipMsg.hidden = false; } }
      zipBusy = false; if (alive) render();
    }

    // ------------------------------------------------------------ settings -> UI
    function changed() { if (runInfo && !running) stale = true; render(); }
    wIn.addEventListener('input', () => { ui.resize.width = wIn.value === '' ? NaN : Number(wIn.value); changed(); });
    hIn.addEventListener('input', () => { ui.resize.height = hIn.value === '' ? NaN : Number(hIn.value); changed(); });
    keep.addEventListener('change', () => { ui.resize.keepAspect = keep.checked; changed(); });
    up.addEventListener('change', () => { ui.resize.allowUpscale = up.checked; changed(); });
    quality.addEventListener('input', () => { ui.quality = Number(quality.value); changed(); });
    target.addEventListener('input', () => { ui.targetKB = target.value === '' ? NaN : Number(target.value); changed(); });
    strip.addEventListener('change', () => { ui.strip = strip.checked; changed(); });
    origChk.addEventListener('change', () => { ui.includeOriginals = origChk.checked; });

    // ------------------------------------------------------------ rendering
    function rowFor(item) {
      let r = rows.get(item.id);
      if (!r) {
        r = { li: h('li', { class: 'batch-item', 'data-id': item.id }) };
        r.thumb = h('div', { class: 'bi-thumb', 'aria-hidden': 'true' }); r.name = h('p', { class: 'bi-name' }); r.meta = h('p', { class: 'bi-meta' });
        r.result = h('p', { class: 'bi-result' }); r.error = h('p', { class: 'bi-error', role: 'alert' }); r.notes = h('details', { class: 'bi-notes' }, h('summary', {}, 'Details'));
        r.status = h('span', { class: 'bi-status' });
        r.dl = h('button', { type: 'button', class: 'btn btn-ghost bi-dl', onClick: () => { const it = byId(item.id); if (it && it.result) saveBlob(it.result.blob, it.outName); } }, 'Download');
        r.rm = h('button', { type: 'button', class: 'bi-rm', onClick: () => removeItem(item.id) }, '×');
        r.li.append(r.thumb, h('div', { class: 'bi-main' }, r.name, r.meta, r.result, r.error, r.notes), h('div', { class: 'bi-side' }, r.status, r.dl, r.rm));
        r.thumb.setAttribute('data-has', '0'); rows.set(item.id, r);
      }
      return r;
    }
    function paintRow(item) {
      const r = rowFor(item), res = item.result;
      r.li.dataset.status = item.status;
      r.name.textContent = item.file.name; r.name.title = item.file.name;
      const swap = item.info.orientation >= 5;   // show the size people will see (EXIF rotation applied)
      r.meta.textContent = FMT[item.info.kind.mime] + ' · ' + (swap ? item.info.height : item.info.width) + ' × ' + (swap ? item.info.width : item.info.height) + ' · ' + formatBytes(item.file.size);
      r.status.textContent = STATUS[item.status];
      if (item.thumb && r.thumb.firstChild !== item.thumb) { r.thumb.replaceChildren(item.thumb); r.thumb.setAttribute('data-has', '1'); }
      else if (!item.thumb && item.thumbSkipped) r.thumb.textContent = item.thumbNote || 'large';
      const done = item.status === 'done' && res;
      r.result.classList.toggle('hidden', !done); r.dl.classList.toggle('hidden', !done);
      if (done) {
        const d = sizeDelta(item.file.size, res.blob.size);
        r.result.textContent = '→ ' + FMT[res.mime] + ' · ' + res.width + ' × ' + res.height + ' · ' + formatBytes(res.blob.size) + ' · ' + (d.smaller ? '−' + d.magnitude + '%' : '+' + d.magnitude + '%') + ' · ' + item.outName;
        r.dl.setAttribute('aria-label', 'Download ' + item.outName);
      }
      r.error.classList.toggle('hidden', item.status !== 'failed'); r.error.textContent = item.status === 'failed' ? item.error : '';
      const notes = done ? item.notes : [];
      r.notes.classList.toggle('hidden', !notes.length);
      r.notes.replaceChildren(h('summary', {}, 'Details'), ...notes.map((n) => h('p', { class: 'notice' }, n)));
      r.rm.disabled = running; r.rm.setAttribute('aria-label', 'Remove ' + item.file.name);
    }

    function render() {
      if (!alive) return;
      // list reconcile
      for (const [id, r] of rows) if (!items.some((i) => i.id === id)) { r.li.remove(); rows.delete(id); }
      items.forEach((it) => { paintRow(it); const li = rows.get(it.id).li; if (li.parentNode !== list) list.append(li); });
      items.forEach((it, i) => { const li = rows.get(it.id).li; if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null); });
      empty.classList.toggle('hidden', items.length > 0); list.classList.toggle('hidden', !items.length);
      el.classList.toggle('batch-has', items.length > 0);
      totals.textContent = items.length ? items.length + ' of ' + MAX_BATCH_FILES + ' images · ' + formatBytes(totalBytes()) + ' of ' + MB(MAX_BATCH_BYTES) + ' MB' : '';

      // rejected files
      rejectBox.classList.toggle('hidden', !rejected.length);
      if (rejected.length) rejectBox.replaceChildren(h('p', {}, rejected.length + (rejected.length === 1 ? ' file was' : ' files were') + ' not added. The others are in the queue.'),
        h('ul', {}, rejected.slice(0, 8).map(([n, m]) => h('li', {}, n + ' — ' + m)), rejected.length > 8 ? h('li', {}, 'and ' + (rejected.length - 8) + ' more') : null),
        h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { rejected = []; render(); } }, 'Dismiss'));

      // settings
      const v = normalizeSettings(ui), m = ui.resize.mode;
      [resizeSeg, formatSeg, compressSeg].forEach((s) => s.btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s.get()))));
      resizeRow.classList.toggle('hidden', m === 'off');
      wGroup.classList.toggle('hidden', m === 'height' || m === 'off'); hGroup.classList.toggle('hidden', m === 'width' || m === 'off');
      keepRow.classList.toggle('hidden', m !== 'box'); presets.classList.toggle('hidden', m !== 'box');
      if (document.activeElement !== wIn) wIn.value = Number.isFinite(ui.resize.width) ? ui.resize.width : '';
      if (document.activeElement !== hIn) hIn.value = Number.isFinite(ui.resize.height) ? ui.resize.height : '';
      keep.checked = ui.resize.keepAspect; up.checked = ui.resize.allowUpscale; strip.checked = ui.strip;
      qGroup.classList.toggle('hidden', ui.compress !== 'quality'); tGroup.classList.toggle('hidden', ui.compress !== 'target');
      targetHint.classList.toggle('hidden', !(ui.compress === 'target' && (ui.format === 'png')));
      if (document.activeElement !== quality) quality.value = ui.quality; qOut.textContent = ui.quality + '%';
      if (document.activeElement !== target) target.value = Number.isFinite(ui.targetKB) ? ui.targetKB : '';
      settingsError.hidden = v.ok; settingsError.textContent = v.ok ? '' : v.error;
      settingsEl.querySelectorAll('input,button').forEach((c) => { c.disabled = running; });

      // actions
      const n = items.length;
      processBtn.textContent = running ? 'Processing…' : runInfo && !stale ? 'Process again' : 'Process' + (n ? ' ' + n + (n === 1 ? ' image' : ' images') : '');
      processBtn.disabled = running || adding || !n || !v.ok;
      cancelBtn.classList.toggle('hidden', !running); cancelHint.classList.toggle('hidden', !running);
      clearBtn.disabled = running || adding || !n; addBtn.disabled = running || adding;
      zone.setAttribute('aria-disabled', String(running || adding)); zone.classList.toggle('disabled', running || adding);

      // progress + outcome
      const count = (s) => items.filter((i) => i.status === s).length;
      const done = count('done'), failed = count('failed'), cancelled = count('cancelled'), finished = done + failed + cancelled;
      const started = runInfo && items.some((i) => i.status !== 'queued');
      progress.classList.toggle('hidden', !(running || started));
      if (running || started) {
        barFill.style.width = (items.length ? Math.max(3, Math.round((finished / items.length) * 100)) : 0) + '%';
        barLabel.textContent = running ? 'Processing: ' + finished + ' of ' + items.length + ' finished'
          : [done + ' of ' + items.length + ' processed', failed ? failed + ' failed' : '', cancelled ? cancelled + ' cancelled' : ''].filter(Boolean).join(' · ');
      } else barLabel.textContent = adding ? 'Reading files…' : '';
      const bad = items.filter((i) => i.status === 'failed');
      failBox.classList.toggle('hidden', running || !(bad.length || cancelled));
      if (!running && (bad.length || cancelled)) failBox.replaceChildren(
        h('p', {}, (done ? 'The ZIP and the individual downloads include only the ' + done + (done === 1 ? ' image that worked.' : ' images that worked.') : 'No image was processed successfully, so there is nothing to download.') +
          (bad.length ? ' ' + bad.length + (bad.length === 1 ? ' image failed:' : ' images failed:') : '') + (cancelled ? ' ' + cancelled + ' not processed because you cancelled.' : '')),
        bad.length ? h('ul', {}, bad.map((i) => h('li', {}, i.file.name + ' — ' + i.error))) : null);
      staleNote.classList.toggle('hidden', !(stale && !running && started));
      zipBtn.classList.toggle('hidden', running || !done); origRow.classList.toggle('hidden', running || !done);
      zipBtn.textContent = zipBusy ? 'Building ZIP…' : 'Download ZIP (' + done + (done === 1 ? ' file' : ' files') + ')'; zipBtn.disabled = zipBusy;
    }
    render();

    return () => {                                                       // leaving the tool: stop work, free everything
      alive = false; if (runner) runner.cancel();
      items.forEach(release); items = []; rows.clear();
      urls.forEach((timer, u) => { clearTimeout(timer); URL.revokeObjectURL(u); }); urls.clear();   // revoke now, exactly once
    };
  },
};
