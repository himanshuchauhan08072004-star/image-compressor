import { resolvePaper, isUnit, CUSTOM, PAPERS } from './paper.js';
import { validateOptions, validateGroups, LAYOUT_LIMITS, DEFAULT_LAYOUT } from './layout.js';

/**
 * Layout presets: settings only (paper, margins, spacing, grid limits, alignment, guides, photo sizes and copy counts).
 * Never photographs, never file names, never manual positions (those belong to one particular set of images).
 * Storage is injectable (anything with getItem/setItem, i.e. localStorage); no backend.
 */
export const PRESET_VERSION = 1;
export const STORAGE_KEY = 'shrinkit.layoutPresets.v1';
export const NAME_MAX = 40, PRESETS_MAX = 30;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Anything in, a complete clean settings object out. Tolerates older / partial data: a string paper ('A4'), a single `gap`,
 * missing alignment or guides get defaults. Unknown fields (including any image data) are dropped. Returns
 * { ok:true, settings } or { ok:false, error }. It checks values, not whether the photos fit on the paper (the layout does that).
 */
export function sanitizeSettings(raw) {
  if (!isObj(raw)) return { ok: false, error: 'The layout is not valid.' };
  let paper = raw.paper ?? 'A4';
  if (typeof paper === 'string') paper = { key: paper };
  if (!isObj(paper)) return { ok: false, error: 'The paper size is not valid.' };
  const p = { key: paper.key };
  if (paper.key === CUSTOM) { p.w = paper.w; p.h = paper.h; p.unit = isUnit(paper.unit) ? paper.unit : 'mm'; }
  const rp = resolvePaper(p); if (!rp.ok) return { ok: false, error: rp.error };
  const gap = finite(raw.gap) ? raw.gap : DEFAULT_LAYOUT.hGap;
  const vo = validateOptions({
    margin: raw.margin ?? DEFAULT_LAYOUT.margin, hGap: raw.hGap ?? gap, vGap: raw.vGap ?? gap, cols: raw.cols ?? 0, rows: raw.rows ?? 0,
    align: isObj(raw.align) ? raw.align : undefined, guides: raw.guides, mode: 'auto', newRowPerGroup: raw.newRowPerGroup,
  });
  if (!vo.ok) return { ok: false, error: vo.error };
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : (finite(raw.photoW) && finite(raw.photoH) ? [{ w: raw.photoW, h: raw.photoH, copies: raw.copies ?? 1 }] : null);   // v0 saved one size
  if (!rawGroups) return { ok: false, error: 'The layout has no photo sizes.' };
  const vg = validateGroups(rawGroups.map((g) => (isObj(g) ? { w: g.w, h: g.h, copies: g.copies, fit: g.fit } : null)));
  if (!vg.ok) return { ok: false, error: vg.error };
  const { o } = vo;
  return {
    ok: true,
    settings: {
      paper: p.key === CUSTOM ? { key: CUSTOM, w: p.w, h: p.h, unit: p.unit } : { key: p.key },
      landscape: !!raw.landscape, margin: o.margin, hGap: o.hGap, vGap: o.vGap, cols: o.cols, rows: o.rows, align: o.align, guides: o.guides, newRowPerGroup: o.newRowPerGroup,
      groups: vg.groups.map((g) => ({ w: g.w, h: g.h, copies: g.copies, fit: g.fit })),
    },
  };
}

export function cleanName(name) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return n.slice(0, NAME_MAX);
}

const S = (o) => sanitizeSettings(o).settings;
export const BUILTIN_PRESETS = Object.freeze([
  { id: 'builtin:passport-a4', name: 'Passport 35 × 45 mm · A4', builtin: true, settings: S({ paper: { key: 'A4' }, margin: 10, gap: 3, groups: [{ w: 35, h: 45, copies: 8 }] }) },
  { id: 'builtin:passport-a5', name: 'Passport 35 × 45 mm · A5', builtin: true, settings: S({ paper: { key: 'A5' }, margin: 8, gap: 3, groups: [{ w: 35, h: 45, copies: 6 }] }) },
  { id: 'builtin:us-2x2-letter', name: 'US 2 × 2 in · Letter', builtin: true, settings: S({ paper: { key: 'LETTER' }, margin: 10, gap: 3, groups: [{ w: 50.8, h: 50.8, copies: 6 }] }) },
  { id: 'builtin:33x48-guides', name: '33 × 48 mm · A4 · cutting guides', builtin: true, settings: S({ paper: { key: 'A4' }, margin: 10, gap: 4, guides: 'box', groups: [{ w: 33, h: 48, copies: 10 }] }) },
  { id: 'builtin:mixed-a4', name: 'Mixed: 6 small + 1 large · A4', builtin: true, settings: S({ paper: { key: 'A4' }, margin: 10, gap: 3, groups: [{ w: 35, h: 45, copies: 6 }, { w: 50, h: 70, copies: 1 }] }) },
]);

const defaultId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/**
 * store: { getItem(key), setItem(key, value) }. All methods return plain results and never throw.
 * load() => { presets, dropped, corrupt }: damaged entries are skipped (counted in `dropped`); unreadable JSON gives
 * corrupt:true and an empty list (the damaged text is left in storage until the next successful save replaces it).
 */
export function createPresetStore(store, { makeId = defaultId } = {}) {
  function read() {
    let text;
    try { text = store.getItem(STORAGE_KEY); } catch (e) { return { presets: [], dropped: 0, corrupt: false, unavailable: true }; }
    if (text == null || text === '') return { presets: [], dropped: 0, corrupt: false };
    let data; try { data = JSON.parse(text); } catch (e) { return { presets: [], dropped: 0, corrupt: true }; }
    const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.presets) ? data.presets : null;       // a bare array is the oldest shape
    if (!list) return { presets: [], dropped: 0, corrupt: true };
    const presets = [], seen = new Set(); let dropped = 0;
    for (const item of list) {
      const name = isObj(item) ? cleanName(item.name) : '', s = isObj(item) ? sanitizeSettings(item.settings ?? item) : { ok: false };
      if (!name || !s.ok || presets.length >= PRESETS_MAX) { dropped++; continue; }
      let id = typeof item.id === 'string' && item.id && !item.id.startsWith('builtin:') && !seen.has(item.id) ? item.id : makeId();
      while (seen.has(id)) id = makeId(); seen.add(id);
      presets.push({ id, name, builtin: false, settings: s.settings });
    }
    return { presets, dropped, corrupt: false };
  }
  function write(presets) {
    try { store.setItem(STORAGE_KEY, JSON.stringify({ v: PRESET_VERSION, presets: presets.map((p) => ({ id: p.id, name: p.name, settings: p.settings })) })); return { ok: true }; }
    catch (e) { return { ok: false, error: 'Your browser did not allow saving layouts (storage is full or turned off).' }; }
  }
  const taken = (list, name, exceptId) => list.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase()) || BUILTIN_PRESETS.some((p) => p.name.toLowerCase() === name.toLowerCase());
  return {
    load: read,
    all() { const r = read(); return { ...r, presets: [...BUILTIN_PRESETS, ...r.presets] }; },
    get(id) { return [...BUILTIN_PRESETS, ...read().presets].find((p) => p.id === id) || null; },
    save(name, settings) {
      const n = cleanName(name); if (!n) return { ok: false, error: 'Give the layout a name.' };
      const s = sanitizeSettings(settings); if (!s.ok) return { ok: false, error: s.error };
      const r = read(); if (r.unavailable) return { ok: false, error: 'Saving is not available in this browser.' };
      if (taken(r.presets, n)) return { ok: false, error: 'A layout called “' + n + '” already exists. Choose another name.' };
      if (r.presets.length >= PRESETS_MAX) return { ok: false, error: 'You can keep up to ' + PRESETS_MAX + ' saved layouts. Delete one first.' };
      const preset = { id: makeId(), name: n, builtin: false, settings: s.settings }, w = write([...r.presets, preset]);
      return w.ok ? { ok: true, preset } : w;
    },
    rename(id, name) {
      const n = cleanName(name); if (!n) return { ok: false, error: 'Give the layout a name.' };
      const r = read(), at = r.presets.findIndex((p) => p.id === id); if (at < 0) return { ok: false, error: 'That layout cannot be renamed.' };
      if (taken(r.presets, n, id)) return { ok: false, error: 'A layout called “' + n + '” already exists. Choose another name.' };
      const next = r.presets.map((p, i) => (i === at ? { ...p, name: n } : p)), w = write(next);
      return w.ok ? { ok: true, preset: next[at] } : w;
    },
    remove(id) {
      const r = read(); if (!r.presets.some((p) => p.id === id)) return { ok: false, error: 'That layout cannot be deleted.' };
      return write(r.presets.filter((p) => p.id !== id));
    },
  };
}

export { LAYOUT_LIMITS, PAPERS };
