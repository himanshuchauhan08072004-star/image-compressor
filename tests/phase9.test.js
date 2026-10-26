import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, readyTools, GROUPS } from '../src/app/registry.js';
import { searchTools } from '../src/app/tool-search.js';
import { resolveTheme, nextTheme } from '../src/app/theme-logic.js';
import { hasIcon } from '../src/app/icons.js';

const tools = readyTools();

test('[unit] every ready tool has a known group, an existing icon, a short blurb and keywords', () => {
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const t of tools) {
    assert.ok(ids.has(t.group), t.id + ' group');
    assert.ok(hasIcon(t.icon), t.id + ' icon');
    assert.ok(t.short && t.short.length <= 80, t.id + ' short blurb');
    assert.ok(t.keywords, t.id + ' keywords');
  }
});

test('[unit] every group has at least one tool and groups cover all ready tools exactly once', () => {
  for (const g of GROUPS) assert.ok(tools.some((t) => t.group === g.id), g.id + ' empty');
  assert.equal(GROUPS.flatMap((g) => tools.filter((t) => t.group === g.id)).length, tools.length);
});

test('[unit] planned tools are never returned by search (they are not routable)', () => {
  const planned = TOOLS.filter((t) => t.status === 'planned').map((t) => t.id);
  for (const q of ['privacy', 'pdf', 'image to pdf']) for (const t of searchTools(tools, q)) assert.ok(!planned.includes(t.id));
});

test('[unit] search finds tools by title, keyword and format; ranks title matches first', () => {
  assert.equal(searchTools(tools, 'compress')[0].id, 'compress');
  assert.equal(searchTools(tools, 'heic').some((t) => t.id === 'convert'), true);
  assert.equal(searchTools(tools, 'gps')[0].id, 'metadata');
  assert.equal(searchTools(tools, 'passport')[0].id, 'passport');
  assert.equal(searchTools(tools, 'a4').some((t) => t.id === 'print'), true);
});

test('[unit] search: empty query returns all, group filter narrows, no match returns [], every word must match', () => {
  assert.equal(searchTools(tools, '').length, tools.length);
  assert.equal(searchTools(tools, '   ').length, tools.length);
  assert.deepEqual(searchTools(tools, '', 'privacy').map((t) => t.id).sort(), ['blur', 'metadata']);
  assert.equal(searchTools(tools, 'zzzqqq').length, 0);
  assert.equal(searchTools(tools, 'compress zzzqqq').length, 0);
  assert.equal(searchTools(tools, 'blur', 'image').length, 0);
});

test('[unit] search ignores case, accents and punctuation and does not throw on odd input', () => {
  assert.equal(searchTools(tools, 'RÉSIZE')[0].id, 'resize');
  assert.doesNotThrow(() => searchTools(tools, '((['));
  assert.doesNotThrow(() => searchTools(tools, null));
  assert.doesNotThrow(() => searchTools(tools, '<script>'));
});

test('[unit] theme: stored choice wins, otherwise follow the system; toggle flips', () => {
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme(null, true), 'light');
  assert.equal(resolveTheme(null, false), 'dark');
  assert.equal(resolveTheme('garbage', true), 'light');
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), 'dark');
});
