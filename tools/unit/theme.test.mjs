/**
 * Theme completeness.
 *
 * A theme is a set of tokens, and the failure mode is silent: miss one and that single
 * value falls back to the light palette, so a dark screen gets one white card, or one
 * unreadable pill, and it is found by somebody using the app rather than by a test.
 * Comparing token sets catches it before it ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const css = fs.readFileSync(path.join(ROOT, 'ui/css/app.css'), 'utf8');

/** The custom properties declared in one selector's block. */
function tokensIn(selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `no ${selector} block in app.css`);
  const j = css.indexOf('}', i);
  return new Set([...css.slice(i, j).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/**
 * Deliberately not themed: geometry, font stacks, and the status FILL colours, which are
 * the colour of the thing itself and are tuned to read on either ground.
 */
const UNTHEMED = ['--radius', '--radius-sm', '--mono', '--sans',
                  '--good', '--warning', '--serious', '--critical'];

const root = tokensIn(':root {');
const DARK_THEMES = [':root[data-theme="dark"] {', ':root[data-theme="dark-blue"] {'];

test('the light palette defines the untheme-able tokens too', () => {
  for (const t of UNTHEMED) assert.ok(root.has(t), `:root is missing ${t}`);
});

for (const sel of DARK_THEMES) {
  test(`${sel.trim()} themes every token that needs theming`, () => {
    const theme = tokensIn(sel);
    const needed = [...root].filter((t) => !UNTHEMED.includes(t));
    const missing = needed.filter((t) => !theme.has(t));
    assert.deepEqual(missing, [],
      `${sel} falls back to the light value for: ${missing.join(', ')}`);
  });

  test(`${sel.trim()} invents no token the rest of the app does not know`, () => {
    const extra = [...tokensIn(sel)].filter((t) => !root.has(t));
    assert.deepEqual(extra, [], `${sel} declares ${extra.join(', ')}, which nothing reads`);
  });

  test(`${sel.trim()} declares its colour-scheme so form controls follow`, () => {
    const i = css.indexOf(sel);
    const body = css.slice(i, css.indexOf('}', i));
    assert.match(body, /color-scheme:\s*dark/, `${sel} must tell the browser it is dark`);
  });
}

test('every theme the button offers has a stylesheet block', () => {
  const app = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
  const block = app.slice(app.indexOf('const THEMES = ['), app.indexOf('];', app.indexOf('const THEMES = [')));
  const ids = [...block.matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 4, `only found ${ids.length} themes in the cycle`);
  assert.ok(ids.includes('system'), 'system must stay in the cycle');
  for (const id of ids) {
    if (id === 'system') continue;   // system stamps no attribute; it is the OS default
    if (id === 'light') { assert.ok(css.includes(':root {'), 'light lives on bare :root'); continue; }
    assert.ok(css.includes(`:root[data-theme="${id}"]`),
      `the button offers "${id}" but app.css has no block for it`);
  }
});
