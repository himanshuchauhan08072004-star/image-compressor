import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetStore, sanitizeSettings, BUILTIN_PRESETS, STORAGE_KEY, NAME_MAX, PRESETS_MAX } from '../src/core/presets.js';
import { planLayout } from '../src/core/layout.js';

const mem = (init) => { const m = new Map(init ? [[STORAGE_KEY, init]] : []); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m }; };
const counter = () => { let n = 0; return () => 'id' + ++n; };
const S = (o = {}) => ({ paper: { key: 'A4' }, margin: 10, hGap: 3, vGap: 3, groups: [{ w: 35, h: 45, copies: 8 }], ...o });
const mk = (init) => { const st = mem(init); return { st, store: createPresetStore(st, { makeId: counter() }) }; };

test('built-in presets are valid and every one lays out on its own paper', () => {
  assert.ok(BUILTIN_PRESETS.length >= 4);
  for (const p of BUILTIN_PRESETS) { assert.ok(p.builtin && p.id.startsWith('builtin:')); const r = planLayout(p.settings); assert.ok(r.ok && r.exportable, p.name + ': ' + r.error); }
  assert.equal(new Set(BUILTIN_PRESETS.map((p) => p.name)).size, BUILTIN_PRESETS.length);
});
test('save, list, apply (get)', () => {
  const { store } = mk(), r = store.save('  My   sheet ', S({ paper: { key: 'CUSTOM', w: 4, h: 6, unit: 'in' }, groups: [{ w: 30, h: 40, copies: 2 }], guides: 'box' })); assert.ok(r.ok); assert.equal(r.preset.name, 'My sheet');
  const all = store.all(); assert.equal(all.presets.length, BUILTIN_PRESETS.length + 1); const got = store.get(r.preset.id); assert.deepEqual(got.settings.paper, { key: 'CUSTOM', w: 4, h: 6, unit: 'in' }); assert.equal(got.settings.guides, 'box'); assert.equal(got.settings.groups[0].copies, 2);
  assert.ok(planLayout(got.settings).ok);
});
test('survives a reload: a new store on the same storage sees the preset', () => {
  const { st, store } = mk(); store.save('A', S()); const again = createPresetStore(st); assert.equal(again.load().presets.length, 1); assert.equal(again.load().presets[0].name, 'A');
});
test('rename and delete; built-ins are protected', () => {
  const { store } = mk(); const a = store.save('One', S()).preset; store.save('Two', S());
  assert.equal(store.rename(a.id, 'Uno').ok, true); assert.equal(store.get(a.id).name, 'Uno');
  assert.match(store.rename(a.id, 'two').error, /already exists/); assert.match(store.rename(a.id, '   ').error, /name/); assert.equal(store.rename(a.id, 'Uno').ok, true);                 // same name as itself is fine
  assert.equal(store.rename(BUILTIN_PRESETS[0].id, 'Hacked').ok, false); assert.equal(store.remove(BUILTIN_PRESETS[0].id).ok, false); assert.equal(store.rename('nope', 'x').ok, false);
  assert.equal(store.remove(a.id).ok, true); assert.equal(store.get(a.id), null); assert.equal(store.load().presets.length, 1); assert.equal(store.remove(a.id).ok, false);
});
test('names: required, trimmed, unique (case-insensitive, also against built-ins), length-capped, control chars stripped', () => {
  const { store } = mk();
  assert.equal(store.save('', S()).ok, false); assert.equal(store.save('   ', S()).ok, false); assert.equal(store.save(null, S()).ok, false);
  assert.equal(store.save(BUILTIN_PRESETS[0].name.toUpperCase(), S()).ok, false);
  assert.ok(store.save('x'.repeat(100), S()).preset.name.length === NAME_MAX); assert.equal(store.save('a\u0000b\nc', S()).preset.name, 'a b c');
  store.save('Dup', S()); assert.equal(store.save('dup', S()).ok, false);
});
test('limit on the number of saved layouts', () => {
  const { store } = mk(); for (let i = 0; i < PRESETS_MAX; i++) assert.ok(store.save('p' + i, S()).ok); assert.match(store.save('one more', S()).error, /up to/);
});
test('invalid settings are refused on save and on apply', () => {
  const { store } = mk(); for (const bad of [null, 5, 'x', [], {}, S({ margin: -1 }), S({ margin: 999 }), S({ hGap: 99 }), S({ paper: { key: 'B9' } }), S({ paper: { key: 'CUSTOM', w: 0, h: 5 } }), S({ groups: [] }), S({ groups: [{ w: 0, h: 5, copies: 1 }] }), S({ groups: [{ w: 35, h: 45, copies: 0 }] }), S({ guides: 'x' }), S({ cols: -2 })]) {
    assert.equal(store.save('bad', bad).ok, false, JSON.stringify(bad)); assert.equal(sanitizeSettings(bad).ok, false);
  }
});
test('presets never carry pictures or file names', () => {
  const dirty = S({ groups: [{ w: 35, h: 45, copies: 2, source: 'x1', bitmap: 'DATA', dataUrl: 'data:image/png;base64,AAAA', name: 'me.jpg' }], image: 'data:image/png;base64,AAAA', manual: { 'g0:0': { x: 1, y: 2 } }, files: ['a.jpg'] });
  const { store, st } = mk(), r = store.save('clean', dirty); assert.ok(r.ok); const raw = st.m.get(STORAGE_KEY);
  assert.ok(!/data:image|DATA|me\.jpg|a\.jpg|bitmap|source|manual|files/.test(raw), raw); assert.deepEqual(Object.keys(r.preset.settings.groups[0]).sort(), ['copies', 'fit', 'h', 'w']);
});
test('outdated presets are upgraded: string paper, single gap, single size, missing fields', () => {
  const v0 = JSON.stringify([{ name: 'Old', paper: 'A5', margin: 8, gap: 4, photoW: 35, photoH: 45, copies: 6 }, { name: 'Older', settings: { margin: 10, gap: 3, groups: [{ w: 30, h: 40, copies: 2 }] } }]);
  const { store } = mk(v0), l = store.load(); assert.equal(l.dropped, 0); assert.equal(l.presets.length, 2);
  const o = l.presets[0].settings; assert.deepEqual([o.paper, o.hGap, o.vGap, o.cols, o.rows, o.guides, o.align, o.groups[0].fit, o.landscape], [{ key: 'A5' }, 4, 4, 0, 0, 'none', { h: 'left', v: 'top' }, 'cover', false]);
  assert.equal(l.presets[1].settings.paper.key, 'A4'); l.presets.forEach((p) => assert.ok(planLayout(p.settings).ok));
});
test('corrupted storage: bad JSON, wrong shape, junk entries, duplicate ids', () => {
  assert.deepEqual(mk('{not json').store.load(), { presets: [], dropped: 0, corrupt: true }); assert.equal(mk('"hello"').store.load().corrupt, true); assert.equal(mk('{"presets":5}').store.load().corrupt, true); assert.equal(mk('null').store.load().corrupt, true);
  assert.equal(mk('').store.load().corrupt, false);
  const mixed = JSON.stringify({ v: 1, presets: [{ id: 'same', name: 'ok', settings: S() }, { id: 'same', name: 'ok2', settings: S() }, { id: 'bad1', name: 'nomargin', settings: S({ margin: -5 }) }, { name: '', settings: S() }, 7, null, { id: 'builtin:x', name: 'sneaky', settings: S() }]});
  const l = mk(mixed).store.load(); assert.deepEqual(l.presets.map((p) => p.name), ['ok', 'ok2', 'sneaky']); assert.equal(l.dropped, 4); assert.equal(new Set(l.presets.map((p) => p.id)).size, 3); assert.ok(l.presets.every((p) => !p.id.startsWith('builtin:')));
  const { store, st } = mk('{oops'); assert.ok(store.save('fresh', S()).ok); assert.equal(store.load().corrupt, false); assert.equal(store.load().presets.length, 1); assert.doesNotThrow(() => JSON.parse(st.m.get(STORAGE_KEY)));       // saving replaces the damaged text
});
test('storage failures never throw', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } }, store = createPresetStore(broken);
  assert.deepEqual(store.load(), { presets: [], dropped: 0, corrupt: false, unavailable: true }); assert.equal(store.all().presets.length, BUILTIN_PRESETS.length); assert.match(store.save('x', S()).error, /not available/);
  const full = createPresetStore({ getItem: () => null, setItem() { throw new Error('QuotaExceededError'); } }); assert.match(full.save('x', S()).error, /full or turned off/);
  assert.equal(full.remove('a').ok, false);
});
