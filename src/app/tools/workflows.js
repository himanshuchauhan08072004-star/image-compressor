import { h } from '../dom.js';
import { decodeImage } from '../../core/decode.js';
import { buildZip, verifyZip } from '../../core/zip.js';
import { userMessageOf } from '../../core/errors.js';
import { formatBytes } from '../../core/format.js';
import { uniqueName } from '../../core/batch.js';
import { PAPERS } from '../../core/paper.js';
import { POSITIONS, POSITION_LABELS } from '../../core/watermark.js';
import { TEMPLATES, OP_INFO, OP_TYPES, MAX_IMAGES, MAX_OPS, MIMES, RESIZE_FITS, addOp, removeOp, moveOp, updateOp, validateWorkflow, runWorkflow } from '../../core/workflow.js';
import { createWorkflowExec } from '../../core/workflow-exec.js';

const MAX_PIXEL_BUDGET = 120_000_000;           // all decoded source pictures together (each one is also limited to 100 MP by decodeImage)
const FMT = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP' };
const STATUS = { pending: 'Waiting', running: 'Running…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const numOf = (el) => (el.value === '' ? NaN : Number(el.value));

/** Document Workflows: a short, ordered list of steps run on every picture. Pixel work is done by workflow-exec.js (existing tool code). */
export default {
  mount(root) {
    let ops = TEMPLATES[0].make(), inputs = [], seq = 0, alive = true, running = false, cancel = false, adding = false, result = null, runState = null;
    const urls = new Map();

    const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif', 'aria-label': 'Choose pictures', id: 'wf-files' });
    const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Choose pictures' }, h('p', { class: 'dz-title' }, 'Drop pictures here, or click to choose'), h('p', { class: 'dz-sub' }, 'Up to ' + MAX_IMAGES + ' pictures · JPG · PNG · WEBP · HEIC. Stays on this device. Your originals are never changed.'), fileInput);
    zone.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    ['dragover', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop') addFiles([...e.dataTransfer.files]); }));
    fileInput.addEventListener('change', () => { const f = [...fileInput.files]; fileInput.value = ''; addFiles(f); });

    const imgList = h('ul', { class: 'wf-images', id: 'wf-images' }), imgNote = h('p', { class: 'tool-hint', role: 'status', id: 'wf-img-note' });
    const tplBtns = TEMPLATES.map((t) => h('button', { type: 'button', class: 'chip', id: 'wf-tpl-' + t.id, title: t.blurb, onClick: () => { if (running) return; ops = t.make(); clearResult(); render(); } }, t.label));
    const opsBox = h('ol', { class: 'wf-steps', id: 'wf-steps' });
    const addSel = h('select', { id: 'wf-add-type', 'aria-label': 'Step to add' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'wf-add', onClick: () => { if (running || !addSel.value) return; ops = addOp(ops, addSel.value); clearResult(); render(); } }, 'Add step');
    const problems = h('ul', { class: 'wf-problems', id: 'wf-problems', role: 'status' });
    const runBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'wf-run', onClick: () => run() }, 'Run workflow');
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'wf-cancel', hidden: true, onClick: () => { cancel = true; } }, 'Cancel');
    const progress = h('ol', { class: 'wf-progress', id: 'wf-progress', 'aria-live': 'polite' }), out = h('div', { id: 'wf-result' }), err = h('p', { class: 'dz-error', role: 'alert', hidden: true, id: 'wf-error' });

    root.append(h('div', { class: 'tool-area wf-root' },
      h('p', { class: 'tool-title' }, '1. Pictures'), zone, imgNote, imgList,
      h('p', { class: 'tool-title' }, '2. Steps'), h('p', { class: 'tool-hint' }, 'Start from a ready-made workflow, then change, reorder or remove steps. Every picture goes through the steps from top to bottom.'),
      h('div', { class: 'tool-row' }, ...tplBtns), opsBox, h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'wf-add-type' }, 'Add a step'), addSel), addBtn), problems,
      h('p', { class: 'tool-title' }, '3. Run'), h('div', { class: 'tool-row' }, runBtn, cancelBtn), err, progress, out));

    // ---------- images
    const pixels = () => inputs.reduce((n, i) => n + i.width * i.height, 0);
    async function addFiles(files) {
      if (running || adding || !files.length) return;
      adding = true; imgNote.textContent = '';
      const skipped = [];
      for (const f of files) {
        if (inputs.length >= MAX_IMAGES) { skipped.push(f.name + ' (limit of ' + MAX_IMAGES + ' pictures)'); continue; }
        try {
          const d = await decodeImage(f);
          if (pixels() + d.width * d.height > MAX_PIXEL_BUDGET) { d.bitmap.close(); skipped.push(f.name + ' (too many pixels in total; the limit is ' + MAX_PIXEL_BUDGET / 1e6 + ' MP for all pictures together)'); continue; }
          if (!alive) { d.bitmap.close(); return; }
          inputs.push({ id: 'i' + ++seq, name: f.name, bitmap: d.bitmap, width: d.width, height: d.height, hasAlpha: d.hasAlpha, kind: d.kind });
        } catch (e) { skipped.push(f.name + ' (' + (e.userMessage || 'could not be opened') + ')'); }
      }
      adding = false; imgNote.textContent = skipped.length ? 'Not added: ' + skipped.join('; ') + '.' : '';
      clearResult(); render();
    }
    const removeInput = (id) => { if (running) return; const i = inputs.findIndex((x) => x.id === id); if (i < 0) return; inputs[i].bitmap.close(); inputs.splice(i, 1); clearResult(); render(); };

    // ---------- step editors
    const lab = (txt, ctl, idFor) => h('div', { class: 'ctrl-group' }, h('label', { for: idFor }, txt), ctl);
    function field(op, key, id, label, { min, max, step = 1, text = false } = {}) {
      const i = h('input', { type: text ? 'text' : 'number', id, value: String(op.params[key] ?? ''), 'aria-label': label, ...(text ? {} : { min: String(min), max: String(max), step: String(step), inputmode: 'decimal' }) });
      i.addEventListener('input', () => { ops = updateOp(ops, op.id, { [key]: text ? i.value : numOf(i) }); clearResult(); validateOnly(); });
      return lab(label, i, id);
    }
    function select(op, key, id, label, options) {
      const s = h('select', { id, 'aria-label': label }, options.map(([v, t]) => h('option', { value: v }, t))); s.value = String(op.params[key]);
      s.addEventListener('change', () => { ops = updateOp(ops, op.id, { [key]: s.value }); clearResult(); render(); }); return lab(label, s, id);
    }
    function check(op, key, id, label) {
      const c = h('input', { type: 'checkbox', id }); c.checked = !!op.params[key]; c.addEventListener('change', () => { ops = updateOp(ops, op.id, { [key]: c.checked }); clearResult(); validateOnly(); });
      return h('label', { class: 'check' }, c, label);
    }
    function paperSelect(op, id) {
      const s = h('select', { id, 'aria-label': 'Paper' }, Object.entries(PAPERS).map(([key, v]) => h('option', { value: key }, v.label))); s.value = op.params.paper.key;
      s.addEventListener('change', () => { ops = updateOp(ops, op.id, { paper: { key: s.value } }); clearResult(); validateOnly(); }); return lab('Paper', s, id);
    }
    function editor(op) {
      const p = op.params, k = op.id;
      switch (op.type) {
        case 'crop': return h('div', { class: 'tool-row' }, field(op, 'aw', k + '-aw', 'Shape width', { min: 1, max: 1000, step: 0.1 }), field(op, 'ah', k + '-ah', 'height', { min: 1, max: 1000, step: 0.1 }), h('span', { class: 'readout' }, 'e.g. 35 : 45 (millimetres or any units, only the ratio counts)'));
        case 'resize': return h('div', { class: 'tool-row' }, field(op, 'width', k + '-w', 'Width px', { min: 1, max: 20000 }), field(op, 'height', k + '-h', 'Height px', { min: 1, max: 20000 }),
          select(op, 'fit', k + '-fit', 'How it fits', [['inside', 'Fit inside (keep shape)'], ['fill', 'Fill exactly (crop edges)'], ['contain', 'Whole picture (white bars)']]), check(op, 'allowUpscale', k + '-up', 'Allow enlarging'));
        case 'watermark': return h('div', { class: 'tool-row' }, field(op, 'text', k + '-t', 'Text', { text: true }), field(op, 'size', k + '-s', 'Size % of width', { min: 1, max: 100 }), field(op, 'opacity', k + '-o', 'Opacity %', { min: 0, max: 100 }), select(op, 'position', k + '-pos', 'Position', POSITIONS.map((v) => [v, POSITION_LABELS[v]])));
        case 'convert': return h('div', { class: 'tool-row' }, select(op, 'mime', k + '-fmt', 'Format', MIMES.map((m) => [m, FMT[m]])), field(op, 'quality', k + '-q', 'Quality (JPG/WEBP)', { min: 1, max: 100 }));
        case 'sheet': return h('div', { class: 'tool-row' }, paperSelect(op, k + '-paper'), check(op, 'landscape', k + '-ls', 'Landscape'),
          field(op, 'photoW', k + '-pw', 'Photo width mm', { min: 5, max: 1200, step: 0.1 }), field(op, 'photoH', k + '-ph', 'Photo height mm', { min: 5, max: 1200, step: 0.1 }), field(op, 'copies', k + '-c', 'Copies of each picture', { min: 1, max: 100 }),
          field(op, 'margin', k + '-m', 'Margin mm', { min: 0, max: 50, step: 0.5 }), field(op, 'gap', k + '-g', 'Spacing mm', { min: 0, max: 30, step: 0.5 }), field(op, 'dpi', k + '-dpi', 'DPI', { min: 72, max: 1200 }),
          select(op, 'guides', k + '-guides', 'Cutting guides', [['none', 'None'], ['box', 'Outline']]));
        default: return null;
      }
    }

    function render() {
      opsBox.replaceChildren(...ops.map((op, i) => h('li', { class: 'wf-step', 'data-op': op.type, id: 'wf-step-' + op.id },
        h('div', { class: 'wf-step-head' }, h('strong', {}, (i + 1) + '. ' + OP_INFO[op.type].label), h('span', { class: 'readout' }, OP_INFO[op.type].blurb),
          h('div', { class: 'wf-step-btns' },
            h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Move ' + OP_INFO[op.type].label + ' up', disabled: i === 0 || running, onClick: () => { ops = moveOp(ops, op.id, -1); clearResult(); render(); } }, 'Up'),
            h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Move ' + OP_INFO[op.type].label + ' down', disabled: i === ops.length - 1 || running, onClick: () => { ops = moveOp(ops, op.id, 1); clearResult(); render(); } }, 'Down'),
            h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Remove ' + OP_INFO[op.type].label, disabled: running, onClick: () => { ops = removeOp(ops, op.id); clearResult(); render(); } }, 'Remove'))),
        editor(op))));
      const free = OP_TYPES.filter((t) => !ops.some((o) => o.type === t)); addSel.replaceChildren(...free.map((t) => h('option', { value: t }, OP_INFO[t].label)));
      addSel.disabled = addBtn.disabled = running || !free.length || ops.length >= MAX_OPS;
      imgList.replaceChildren(...inputs.map((it) => h('li', {}, it.name + ' · ' + it.width + ' × ' + it.height + ' px ', h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Remove ' + it.name, disabled: running, onClick: () => removeInput(it.id) }, 'Remove'))));
      validateOnly();
    }
    const effectiveOps = () => ops;
    function validateOnly() {
      const v = validateWorkflow(effectiveOps(), { imageCount: Math.max(inputs.length, 1) });
      problems.replaceChildren(...v.errors.map((e) => h('li', { class: 'dz-error' }, e.message)), ...v.warnings.map((w) => h('li', {}, w.message)));
      runBtn.disabled = running || !v.ok || inputs.length === 0;
      if (!inputs.length && v.ok) problems.append(h('li', {}, 'Add at least one picture to run the workflow.'));
    }

    // ---------- run
    function showProgress(steps) {
      progress.replaceChildren(...steps.map((s, i) => h('li', { class: 'wf-prog wf-' + s.status, 'data-status': s.status },
        h('strong', {}, s.type === 'output' ? 'Prepare download' : (i + 1) + '. ' + OP_INFO[s.type].label), ' — ' + STATUS[s.status] + (s.message ? ': ' + s.message : ''))));
    }
    function clearResult() { out.replaceChildren(); err.hidden = true; progress.replaceChildren(); result = null; urls.forEach((t, u) => { clearTimeout(t); URL.revokeObjectURL(u); }); urls.clear(); }
    function download(blob, name) { const u = URL.createObjectURL(blob), a = h('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); urls.set(u, setTimeout(() => { URL.revokeObjectURL(u); urls.delete(u); }, 4000)); }

    async function run() {
      if (running) return;
      const list = effectiveOps(), v = validateWorkflow(list, { imageCount: inputs.length });
      if (!v.ok) { err.hidden = false; err.textContent = v.errors[0].message; return; }
      clearResult(); running = true; cancel = false; cancelBtn.hidden = false; render();
      const steps0 = [...list.map((o) => ({ type: o.type, status: 'pending', message: '' })), { type: 'output', status: 'pending', message: '' }]; showProgress(steps0);
      let res;
      try {
        res = await runWorkflow(list, inputs, createWorkflowExec(), { isCancelled: () => cancel || !alive, onProgress: (p) => { if (!alive) return; steps0[p.step] = { type: p.type, status: p.status, message: p.message || '' }; showProgress(steps0); } });
      } catch (e) { res = { ok: false, error: userMessageOf(e, 'The workflow failed.'), steps: steps0 }; }
      running = false; cancelBtn.hidden = true; if (!alive) return;
      showProgress(res.steps.length ? res.steps : steps0);
      if (!res.ok) { err.hidden = false; err.textContent = res.cancelled ? 'The workflow was cancelled. Your pictures are unchanged.' : 'Stopped' + (res.image ? ' on ' + res.image : '') + ': ' + res.error + ' Your original pictures are unchanged, so you can fix the step and run again.'; render(); return; }
      result = res; showResult(res); render();
    }
    function showResult(res) {
      const notes = res.notes.length ? h('ul', { class: 'wf-notes' }, res.notes.map((n) => h('li', {}, n))) : null;
      if (res.kind === 'pdf') {
        out.replaceChildren(h('p', { class: 'tool-hint', id: 'wf-done' }, 'PDF ready: ' + res.info.pages + (res.info.pages === 1 ? ' page, ' : ' pages, ') + res.info.photos + ' photos, ' + res.info.size + '. It passed its own structure check.'), notes,
          h('button', { type: 'button', class: 'btn btn-primary', id: 'wf-download', onClick: () => download(res.pdf, 'workflow-sheet.pdf') }, 'Download PDF'));
      } else if (res.files.length === 1) {
        const f = res.files[0];
        out.replaceChildren(h('p', { class: 'tool-hint', id: 'wf-done' }, f.name + ' · ' + f.width + ' × ' + f.height + ' px · ' + formatBytes(f.blob.size)), notes, h('button', { type: 'button', class: 'btn btn-primary', id: 'wf-download', onClick: () => download(f.blob, f.name) }, 'Download'));
      } else {
        let zipBusy = false;
        const zipBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'wf-download', onClick: async () => {
          if (zipBusy) return;                                                   // no second ZIP while one is being built
          zipBusy = true; zipBtn.disabled = true; err.hidden = true;
          const used = new Set(), entries = res.files.map((f) => ({ name: uniqueName(f.name, used), data: f.blob }));
          try { const zip = await buildZip(entries, { isCancelled: () => !alive }); await verifyZip(zip, entries); if (alive) download(zip, 'workflow-results.zip'); }
          catch (e) { if (alive) { err.hidden = false; err.textContent = userMessageOf(e, 'Could not build the ZIP.'); } }
          finally { zipBusy = false; zipBtn.disabled = false; } } }, 'Download ZIP');
        out.replaceChildren(h('p', { class: 'tool-hint', id: 'wf-done' }, res.files.length + ' pictures ready (' + formatBytes(res.files.reduce((n, f) => n + f.blob.size, 0)) + ').'), notes, zipBtn);
      }
    }
    render();
    return () => { alive = false; cancel = true; clearResult(); inputs.forEach((i) => i.bitmap.close()); inputs = []; };
  },
};
