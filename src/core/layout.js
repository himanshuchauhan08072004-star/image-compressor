import { resolvePaper, pageSize, r2 } from './paper.js';

/**
 * Shared layout model for the print preview AND the PDF. Pure millimetre geometry; no canvas, no DOM.
 * One call, planLayout(), turns settings into a list of placed photos. The preview draws exactly these rectangles and
 * the PDF writer places exactly these rectangles; nothing else computes positions.
 *
 * Placement strategy (deterministic "shelf" packing): photos are taken in group order and placed left to right on a row
 * (shelf). A row ends when the next photo no longer fits the printable width (or the optional column limit is reached).
 * A new row starts below the tallest photo of the previous row. When no row fits the printable height (or the optional
 * row limit is reached) a new page starts. Alignment shifts rows / the content block inside the printable area.
 * Limits: no rotation of photos, no free-form packing; a different order of groups can give a different result.
 */
export const LAYOUT_LIMITS = { marginMax: 50, gapMax: 30, copiesMax: 100, pagesMax: 10, groupsMax: 8, itemsMax: 400, photoMin: 5, photoMax: 1200, gridMax: 50 };
export const ALIGN_H = ['left', 'center', 'right'], ALIGN_V = ['top', 'middle', 'bottom'];
export const GUIDES = ['none', 'box'];
export const MODES = ['auto', 'manual'];
const EPS = 1e-6;                                                   // mm; far below anything a printer can resolve
const OVERLAP_EPS = 1e-3;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export const DEFAULT_LAYOUT = Object.freeze({ margin: 10, hGap: 3, vGap: 3, cols: 0, rows: 0, align: { h: 'left', v: 'top' }, guides: 'none', mode: 'auto', newRowPerGroup: false, allowOverlap: false });

/** Key of the n-th copy of a group. Manual positions are stored under it. */
export const itemKey = (groupId, n) => groupId + ':' + n;

const fail = (error, code) => ({ ok: false, error, code });
const cap1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const say = (tag, t) => (tag ? tag + t : cap1(t));          // single group: no "Photo group 1:" prefix, sentence starts with a capital

/** Validate the settings that are not photo groups. Returns { ok:false, error } or { ok:true, o } with defaults filled in. */
export function validateOptions(raw = {}) {
  const o = {
    margin: raw.margin, hGap: raw.hGap ?? raw.gap, vGap: raw.vGap ?? raw.gap,
    cols: raw.cols ?? 0, rows: raw.rows ?? 0, align: { h: raw.align?.h ?? 'left', v: raw.align?.v ?? 'top' },
    guides: raw.guides ?? 'none', mode: raw.mode ?? 'auto', newRowPerGroup: !!raw.newRowPerGroup, allowOverlap: !!raw.allowOverlap,
  };
  if (!num(o.margin) || !num(o.hGap) || !num(o.vGap)) return fail('Enter numbers for margin and spacing.', 'number');
  if (o.margin < 0 || o.margin > LAYOUT_LIMITS.marginMax) return fail('Margin must be 0 to ' + LAYOUT_LIMITS.marginMax + ' mm.', 'margin');
  if (o.hGap < 0 || o.hGap > LAYOUT_LIMITS.gapMax || o.vGap < 0 || o.vGap > LAYOUT_LIMITS.gapMax) return fail('Spacing must be 0 to ' + LAYOUT_LIMITS.gapMax + ' mm.', 'gap');
  for (const k of ['cols', 'rows']) if (!Number.isInteger(o[k]) || o[k] < 0 || o[k] > LAYOUT_LIMITS.gridMax) return fail((k === 'cols' ? 'Columns' : 'Rows') + ' must be a whole number from 0 (automatic) to ' + LAYOUT_LIMITS.gridMax + '.', k);
  if (!ALIGN_H.includes(o.align.h) || !ALIGN_V.includes(o.align.v)) return fail('Unknown alignment.', 'align');
  if (!GUIDES.includes(o.guides)) return fail('Unknown cutting-guide style.', 'guides');
  if (!MODES.includes(o.mode)) return fail('Unknown layout mode.', 'mode');
  return { ok: true, o };
}

/** Normalise groups: stable ids, numbers checked. Returns { ok, groups } or { ok:false, error }. */
export function validateGroups(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return fail('Add at least one photo to place on the sheet.', 'empty');
  if (raw.length > LAYOUT_LIMITS.groupsMax) return fail('At most ' + LAYOUT_LIMITS.groupsMax + ' photo groups are supported.', 'groups');
  const many = raw.length > 1, ids = new Set(), groups = [];
  for (let i = 0; i < raw.length; i++) {
    const g = raw[i] || {}, tag = many ? 'Photo group ' + (i + 1) + ': ' : '';
    if (!num(g.w) || !num(g.h)) return fail(say(tag, 'the photo size is not set.'), 'size');
    if (g.w < LAYOUT_LIMITS.photoMin || g.h < LAYOUT_LIMITS.photoMin || g.w > LAYOUT_LIMITS.photoMax || g.h > LAYOUT_LIMITS.photoMax) return fail(say(tag, 'width and height must each be between ' + LAYOUT_LIMITS.photoMin + ' and ' + LAYOUT_LIMITS.photoMax + ' mm.'), 'size');
    if (!Number.isInteger(g.copies) || g.copies < 1 || g.copies > LAYOUT_LIMITS.copiesMax) return fail(say(tag, 'copies must be a whole number from 1 to ' + LAYOUT_LIMITS.copiesMax + '.'), 'copies');
    let id = typeof g.id === 'string' && g.id && !g.id.includes(':') ? g.id : 'g' + i; if (ids.has(id)) id = 'g' + i + '_' + ids.size; ids.add(id);
    groups.push({ id, w: g.w, h: g.h, copies: g.copies, source: g.source ?? null, fit: g.fit === 'contain' ? 'contain' : 'cover', label: typeof g.label === 'string' ? g.label : '' });
  }
  return { ok: true, groups };
}

/**
 * Problems that make a layout unsafe to print: a photo outside the printable area, or photos overlapping (unless the
 * user allowed overlap). Independent of how the positions were produced, so it also checks the packer's own output.
 * items: [{ key, page, x, y, w, h }]. Returns [{ type:'overflow'|'overlap', keys:[...], page, message }].
 */
export function checkItems(items, printable, { allowOverlap = false } = {}) {
  const problems = [], byPage = new Map();
  for (const it of items) {
    if (it.x < printable.x - EPS || it.y < printable.y - EPS || it.x + it.w > printable.x + printable.w + EPS || it.y + it.h > printable.y + printable.h + EPS) {
      problems.push({ type: 'overflow', keys: [it.key], page: it.page, message: 'A photo on page ' + (it.page + 1) + ' is outside the printable area.' });
    }
    if (!byPage.has(it.page)) byPage.set(it.page, []); byPage.get(it.page).push(it);
  }
  if (!allowOverlap) {
    for (const [page, list] of byPage) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > OVERLAP_EPS && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > OVERLAP_EPS) {
          problems.push({ type: 'overlap', keys: [a.key, b.key], page, message: 'Photos overlap on page ' + (page + 1) + '.' });
        }
      }
    }
  }
  return problems;
}

function pack(items, P, o) {
  const pages = []; let page = null, shelf = null;
  const startPage = () => { page = { shelves: [] }; pages.push(page); shelf = null; };
  for (const it of items) {
    if (!page) startPage();
    let placed = false;
    if (shelf && !(o.newRowPerGroup && it.first && it.group > 0)) {
      const w = shelf.w + o.hGap + it.w, h = Math.max(shelf.h, it.h);
      if (w <= P.w + EPS && (o.cols === 0 || shelf.items.length < o.cols) && shelf.y + h <= P.h + EPS) { shelf.items.push(it); shelf.w = w; shelf.h = h; placed = true; }
    }
    if (!placed) {
      let y = shelf ? shelf.y + shelf.h + o.vGap : 0;
      if (shelf && (y + it.h > P.h + EPS || (o.rows > 0 && page.shelves.length >= o.rows))) { startPage(); y = 0; }
      shelf = { y, h: it.h, w: it.w, items: [it] }; page.shelves.push(shelf);
    }
  }
  return pages;
}

/**
 * settings: { paper, landscape, margin, hGap, vGap (or gap), groups:[{id,w,h,copies,source,fit}], cols, rows, align:{h,v},
 *   guides, mode:'auto'|'manual', manual:{[key]:{x,y}}, newRowPerGroup, allowOverlap }.
 * Returns { ok:false, error, code } when no layout can be made (nothing is ever clipped to make it fit), or
 * { ok:true, page, printable, items, pages, cols, rows, perPage, total, groups, guides, mode, problems, warnings, exportable, stats }.
 * `problems` block export (overlap / overflow); `warnings` are informational (e.g. a manual position was pulled back inside).
 */
export function planLayout(s = {}) {
  const rp = resolvePaper(s.paper); if (!rp.ok) return fail(rp.error, 'paper');
  const vo = validateOptions(s); if (!vo.ok) return vo;
  const vg = validateGroups(s.groups); if (!vg.ok) return vg;
  const { o } = vo, { groups } = vg, page = pageSize(rp.paper, !!s.landscape);
  const printable = { x: o.margin, y: o.margin, w: page.w - 2 * o.margin, h: page.h - 2 * o.margin };
  if (printable.w < 1 || printable.h < 1) return fail('The margins leave no printable area on this ' + r2(page.w) + ' × ' + r2(page.h) + ' mm page. Reduce the margin.', 'margin');
  const total = groups.reduce((n, g) => n + g.copies, 0);
  if (total > LAYOUT_LIMITS.itemsMax) return fail('At most ' + LAYOUT_LIMITS.itemsMax + ' photos can be placed in one layout.', 'items');
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.w > printable.w + EPS || g.h > printable.h + EPS) {
      return fail((groups.length > 1 ? 'Photo group ' + (i + 1) + ': ' : '') + 'One ' + g.w + ' × ' + g.h + ' mm photo does not fit inside the printable area (' + r2(printable.w) + ' × ' + r2(printable.h) + ' mm). Reduce the margin or the photo size.', 'fit');
    }
  }
  const queue = [];
  groups.forEach((g, gi) => { for (let n = 0; n < g.copies; n++) queue.push({ key: itemKey(g.id, n), group: gi, index: n, first: n === 0, w: g.w, h: g.h }); });
  const packed = pack(queue, printable, o);
  if (packed.length > LAYOUT_LIMITS.pagesMax) {
    const per = groups.length === 1 ? ' (' + Math.ceil(total / packed.length) + ' fit on one)' : '';
    return fail(total + ' photos need ' + packed.length + ' pages' + per + '. The limit is ' + LAYOUT_LIMITS.pagesMax + ' pages.', 'pages');
  }

  const items = [], pageStats = [];
  packed.forEach((pg, pi) => {
    const last = pg.shelves[pg.shelves.length - 1], contentH = last.y + last.h, contentW = Math.max(...pg.shelves.map((sh) => sh.w));
    const offY = o.align.v === 'top' ? 0 : o.align.v === 'middle' ? (printable.h - contentH) / 2 : printable.h - contentH;
    let count = 0, used = 0;
    for (const sh of pg.shelves) {
      const offX = o.align.h === 'left' ? 0 : o.align.h === 'center' ? (printable.w - sh.w) / 2 : printable.w - sh.w;
      let acc = 0;
      for (const it of sh.items) {
        const adj = o.align.v === 'top' ? 0 : o.align.v === 'middle' ? (sh.h - it.h) / 2 : sh.h - it.h;
        items.push({ key: it.key, group: it.group, index: it.index, page: pi, x: r6(printable.x + offX + acc), y: r6(printable.y + offY + sh.y + adj), w: it.w, h: it.h, manual: false });
        acc += it.w + o.hGap; count++; used += it.w * it.h;
      }
    }
    pageStats.push({ count, rows: pg.shelves.length, cols: Math.max(...pg.shelves.map((sh) => sh.items.length)), contentW, contentH, freeRight: printable.w - contentW, freeBottom: printable.h - contentH, usedArea: used });
  });

  const warnings = [];
  if (o.mode === 'manual' && s.manual && typeof s.manual === 'object') {
    for (const it of items) {
      const m = s.manual[it.key]; if (!m || !num(m.x) || !num(m.y)) continue;
      const x = clamp(m.x, printable.x, printable.x + printable.w - it.w), y = clamp(m.y, printable.y, printable.y + printable.h - it.h);
      if (Math.abs(x - m.x) > EPS || Math.abs(y - m.y) > EPS) warnings.push('A photo on page ' + (it.page + 1) + ' was moved back inside the printable area.');
      it.x = r6(x); it.y = r6(y); it.manual = true;
    }
  }
  const problems = checkItems(items, printable, { allowOverlap: o.allowOverlap });
  const pages = pageStats.map((_, pi) => items.filter((it) => it.page === pi));

  // Grid capacity (single group = the classic "cols × rows per page"); mixed groups report the busiest page.
  let cols, rows;
  if (groups.length === 1) {
    const g = groups[0], c = Math.floor((printable.w + o.hGap + EPS) / (g.w + o.hGap)), r = Math.floor((printable.h + o.vGap + EPS) / (g.h + o.vGap));
    cols = o.cols ? Math.min(c, o.cols) : c; rows = o.rows ? Math.min(r, o.rows) : r;
  } else { cols = Math.max(...pageStats.map((p) => p.cols)); rows = Math.max(...pageStats.map((p) => p.rows)); }
  const perPage = groups.length === 1 ? cols * rows : Math.max(...pageStats.map((p) => p.count));
  const area = printable.w * printable.h, used = pageStats.reduce((n, p) => n + p.usedArea, 0);
  return {
    ok: true, page, printable, items, pages, cols, rows, perPage, total, groups, guides: o.guides, mode: o.mode, paper: rp.paper, landscape: !!s.landscape,
    problems, warnings, exportable: problems.length === 0,
    stats: { pageCount: pages.length, pages: pageStats, printableArea: area, usedArea: used, unusedArea: area * pages.length - used, unusedPct: area ? (1 - used / (area * pages.length)) * 100 : 0 },
  };
}

/** Try to put item `key` at (x, y) on its page: kept inside the printable area, and (unless allowed) never on top of another photo. */
export function moveItem(layout, key, x, y, { allowOverlap = false, snap = 0 } = {}) {
  const it = layout.items.find((i) => i.key === key); if (!it || !num(x) || !num(y)) return { ok: false, x: it ? it.x : 0, y: it ? it.y : 0, moved: false };
  const P = layout.printable, sn = (v) => (snap > 0 ? Math.round(v / snap) * snap : v);
  const fx = (v) => r6(clamp(sn(v), P.x, P.x + P.w - it.w)), fy = (v) => r6(clamp(sn(v), P.y, P.y + P.h - it.h));
  const others = layout.items.filter((i) => i.page === it.page && i.key !== key);
  const clear = (cx, cy) => allowOverlap || !others.some((b) => Math.min(cx + it.w, b.x + b.w) - Math.max(cx, b.x) > OVERLAP_EPS && Math.min(cy + it.h, b.y + b.h) - Math.max(cy, b.y) > OVERLAP_EPS);
  for (const [cx, cy] of [[fx(x), fy(y)], [fx(x), it.y], [it.x, fy(y)]]) {         // try the target, then slide along one axis
    if (clear(cx, cy)) return { ok: true, x: cx, y: cy, moved: Math.abs(cx - it.x) > EPS || Math.abs(cy - it.y) > EPS };
  }
  return { ok: true, x: it.x, y: it.y, moved: false, blocked: true };
}
