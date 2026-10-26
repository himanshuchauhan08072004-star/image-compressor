import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, readyTools, toolByPath } from '../src/app/registry.js';
import { normalizePath } from '../src/app/router.js';

test('registry: unique ids and paths, ready tools loadable, planned not routable', () => {
  assert.equal(new Set(TOOLS.map((t) => t.id)).size, TOOLS.length);
  assert.equal(new Set(TOOLS.map((t) => t.path)).size, TOOLS.length);
  for (const t of TOOLS) {
    assert.ok(t.path.startsWith('/') && t.title);
    if (t.status === 'ready') assert.equal(typeof t.load, 'function', t.id);
  }
  assert.deepEqual(readyTools().map((t) => t.id), ['compress', 'resize', 'crop', 'convert', 'metadata', 'blur', 'batch', 'passport', 'signature', 'watermark', 'enhance', 'background', 'print', 'workflows']);
  assert.equal(toolByPath('/passport'), null);
  assert.equal(toolByPath('/signature').id, 'signature'); assert.equal(toolByPath('/signature').ownView, true);
  assert.equal(toolByPath('/privacy'), null);
  assert.equal(toolByPath('/crop').id, 'crop');
  assert.equal(toolByPath('/remove-metadata').id, 'metadata');
  assert.equal(toolByPath('/blur').id, 'blur');
});

test('normalizePath', () => {
  assert.equal(normalizePath('/'), '/'); assert.equal(normalizePath(''), '/');
  assert.equal(normalizePath('/resize/'), '/resize'); assert.equal(normalizePath('/crop?x=1#y'), '/crop');
});
