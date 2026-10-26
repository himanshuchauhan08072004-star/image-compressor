import { ImageError } from './errors.js';
import { baseCrop } from './passport.js';
import { planOutput } from './geometry.js';
import { renderPlan, releaseCanvas, assertCanvasBacked } from './render.js';
import { encodeCanvas, supportsEncode } from './encode.js';
import { assertEncodedAs } from './verify.js';
import { stampWatermark } from './watermark-render.js';
import { normalizeWatermark } from './watermark.js';
import { keepMime } from './heic.js';
import { outputName, extFor } from './batch.js';
import { MAX_OUTPUT_PIXELS } from './limits.js';
import { planLayout } from './layout.js';
import { renderGroupJpeg } from './sheet-images.js';
import { exportSheetPdf } from './sheet-export.js';
import { formatBytes } from './format.js';

/**
 * Real pixel work for workflow.js, built from the same services the single tools use (planOutput + renderPlan for
 * crop/resize, stampWatermark for the watermark, encodeCanvas + assertEncodedAs for the file, layout + PDF writer for the
 * sheet). Nothing here re-implements an image algorithm. Each step produces a NEW working bitmap; inputs are never touched.
 */
const nextTask = () => new Promise((r) => setTimeout(r, 0));          // let the UI paint progress between heavy steps

async function fromCanvas(canvas, item) {
  try { const bitmap = await createImageBitmap(canvas); return { ...item, bitmap, width: canvas.width, height: canvas.height, owned: true }; }
  finally { releaseCanvas(canvas); }
}
const planOrThrow = (w, h, recipe) => { const p = planOutput(w, h, recipe); if (!p.ok) throw new ImageError(p.error.code || 'plan', p.error.message); return p.plan; };

export function createWorkflowExec() {
  return {
    async image(op, item, ctx) {
      await nextTask();
      const p = op.params;
      if (op.type === 'convert') return { ...item, target: { mime: p.mime, quality: p.quality } };            // encoded once, at the end
      if (op.type === 'crop') {
        const b = baseCrop(item.width, item.height, p.aw / p.ah), w = Math.max(1, Math.round(b.w)), h = Math.max(1, Math.round(b.h));
        const crop = { x: Math.floor((item.width - w) / 2), y: Math.floor((item.height - h) / 2), w, h };
        return fromCanvas(renderPlan(item.bitmap, planOrThrow(item.width, item.height, { crop })), item);
      }
      if (op.type === 'resize') {
        let resize;
        if (p.fit === 'inside') {
          let k = Math.min(p.width / item.width, p.height / item.height); if (k > 1 && !p.allowUpscale) k = 1;
          resize = { mode: 'scale', width: Math.max(1, Math.round(item.width * k)), height: Math.max(1, Math.round(item.height * k)), allowUpscale: !!p.allowUpscale };
          if (resize.width === item.width && resize.height === item.height) return { ...item };                  // nothing to change: share the picture
        } else resize = { mode: 'exact', fit: p.fit, width: p.width, height: p.height, allowUpscale: !!p.allowUpscale };
        return fromCanvas(renderPlan(item.bitmap, planOrThrow(item.width, item.height, { resize }), { flatten: false }), item);
      }
      if (op.type === 'watermark') {
        const W = item.width, H = item.height;
        if (W * H > MAX_OUTPUT_PIXELS) throw new ImageError('too-large', 'This image is ' + Math.round((W * H) / 1e6) + ' MP. Watermarking handles up to ' + MAX_OUTPUT_PIXELS / 1e6 + ' MP. Add a Resize step before it.');
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const ctx2 = canvas.getContext('2d'); if (!ctx2) throw new ImageError('canvas', 'This image is too large for your browser to process.');
        try {
          assertCanvasBacked(canvas, ctx2); ctx2.drawImage(item.bitmap, 0, 0);
          const res = stampWatermark(ctx2, W, H, normalizeWatermark({ ...p, type: 'text' }), null);
          if (res.error) throw new ImageError(res.error.code || 'watermark', res.error.message);
          if (res.empty) throw new ImageError('empty', 'Type the watermark text first.');
        } catch (e) { releaseCanvas(canvas); throw e; }
        return fromCanvas(canvas, item);
      }
      throw new ImageError('step', 'Unknown step.');
    },

    async finalize(item) {
      await nextTask();
      const mime = item.target ? item.target.mime : keepMime(item.kind), quality = (item.target ? item.target.quality : 92) / 100;
      if (!(await supportsEncode(mime))) throw new ImageError('format-unsupported', mime.replace('image/', '').toUpperCase() + ' export is not supported by this browser.');
      if (item.width * item.height > MAX_OUTPUT_PIXELS) throw new ImageError('too-large', item.name + ' is ' + Math.round((item.width * item.height) / 1e6) + ' MP, over the ' + MAX_OUTPUT_PIXELS / 1e6 + ' MP output limit. Add a Resize step.');
      const canvas = document.createElement('canvas'); canvas.width = item.width; canvas.height = item.height;
      const c = canvas.getContext('2d'); if (!c) throw new ImageError('canvas', 'This image is too large for your browser to process.');
      try {
        assertCanvasBacked(canvas, c);
        if (mime === 'image/jpeg') { c.fillStyle = '#ffffff'; c.fillRect(0, 0, item.width, item.height); }       // JPG cannot store transparency
        c.drawImage(item.bitmap, 0, 0);
        const blob = await encodeCanvas(canvas, { mime, quality });
        await assertEncodedAs(blob, mime);
        return { name: outputName(item.name, mime, 'workflow'), blob, mime, width: item.width, height: item.height, ext: extFor(mime) };
      } finally { releaseCanvas(canvas); }
    },

    async sheet(op, items, ctx) {
      const p = op.params, groups = items.map((it, i) => ({ id: 'w' + i, w: p.photoW, h: p.photoH, copies: p.copies, fit: 'cover' }));
      const layout = planLayout({ paper: p.paper, landscape: p.landscape, margin: p.margin, hGap: p.gap, vGap: p.gap, guides: p.guides, groups });
      if (!layout.ok) throw new ImageError('layout', layout.error);
      const images = [], notes = [];
      for (let i = 0; i < items.length; i++) {
        await nextTask();
        if (ctx.isCancelled()) throw new ImageError('cancelled', 'Cancelled.');
        const im = await renderGroupJpeg(items[i].bitmap, groups[i], { dpi: p.dpi });
        images.push(im);
        const aspectOff = Math.abs(items[i].width / items[i].height / (p.photoW / p.photoH) - 1) > 0.01;
        if (aspectOff) notes.push(items[i].name + ' does not have the photo shape, so a centred crop was used. Add a Crop step to choose the shape yourself.');
        if (im.effectiveDpi < p.dpi * 0.9) notes.push(items[i].name + ' has about ' + im.effectiveDpi + ' DPI at this size (not enlarged).');
      }
      const { blob, check } = await exportSheetPdf({ layout, images, title: 'Shrinkit workflow sheet' });
      return { blob, notes, info: { pages: check.pages, photos: check.photos, size: formatBytes(blob.size), page: layout.page } };
    },

    release(item) { if (item.bitmap && typeof item.bitmap.close === 'function') item.bitmap.close(); },
  };
}
