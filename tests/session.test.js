import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/app/session.js';

function harness() {
  const urls = { made: [], revoked: [] };
  const pending = new Map();
  const closed = [];
  const decode = (file) => new Promise((resolve, reject) => pending.set(file.name, { resolve: () => resolve({ bitmap: { close: () => closed.push(file.name) }, width: 1, height: 1, kind: { type: 'jpeg' } }), reject }));
  const s = createSession({ decode, makeUrl: (f) => { urls.made.push(f.name); return 'blob:' + f.name; }, revokeUrl: (u) => urls.revoked.push(u) });
  return { s, urls, pending, closed };
}

test('stale slower decode never replaces the newer choice (and is freed)', async () => {
  const { s, pending, closed, urls } = harness();
  const a = s.loadFile({ name: 'big' }), b = s.loadFile({ name: 'small' });
  pending.get('small').resolve(); assert.equal(await b, true);
  pending.get('big').resolve(); assert.equal(await a, false);
  assert.equal(s.getState().file.name, 'small');
  assert.deepEqual(closed, ['big']);
  assert.deepEqual(urls.made, ['small']);
});

test('stale failure is swallowed; current failure is thrown', async () => {
  const { s, pending } = harness();
  const a = s.loadFile({ name: 'old' }), b = s.loadFile({ name: 'new' });
  pending.get('old').reject(new Error('old failed')); assert.equal(await a, false);
  pending.get('new').reject(Object.assign(new Error('x'), { userMessage: 'bad file' }));
  await assert.rejects(b, { userMessage: 'bad file' });
});

test('clear() during an in-flight decode discards it', async () => {
  const { s, pending, closed } = harness();
  const a = s.loadFile({ name: 'late' }); s.clear();
  pending.get('late').resolve(); assert.equal(await a, false);
  assert.equal(s.getState().decoded, null); assert.deepEqual(closed, ['late']);
});

test('replacing an image frees the old bitmap and revokes both old URLs', async () => {
  const { s, pending, closed, urls } = harness();
  let p = s.loadFile({ name: 'one' }); pending.get('one').resolve(); await p;
  s.setResult({ status: 'ready', url: 'blob:result-one' });
  p = s.loadFile({ name: 'two' }); pending.get('two').resolve(); await p;
  assert.deepEqual(closed, ['one']);
  assert.deepEqual(urls.revoked.sort(), ['blob:one', 'blob:result-one']);
  assert.equal(s.getState().result.status, 'idle');
});

test('recipe changes merge output and keep target preference across images', async () => {
  const { s, pending } = harness();
  let p = s.loadFile({ name: 'one' }); pending.get('one').resolve(); await p;
  s.setRecipe({ output: { targetKB: 250 } });
  assert.equal(s.getState().recipe.output.quality, 70);
  p = s.loadFile({ name: 'two' }); pending.get('two').resolve(); await p;
  assert.equal(s.getState().recipe.output.targetKB, 250);
});
