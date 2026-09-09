#!/usr/bin/env node
/**
 * Render every UI page against a running dev bridge and fail on the first exception.
 *
 * `check-ui.mjs` resolves imports statically, which cannot see a reference to something
 * that was never imported at all — a stale `workerStatus()` left behind by a refactor
 * looks fine until the page is actually drawn and the operator gets a blank screen.
 * This draws all of them.
 *
 *   cargo run -p espro-core --features bridge --bin espro-bridge -- ui 8765 &
 *   node tools/render-check.mjs --config path/to/config_cluster.json
 *
 * Needs jsdom (`npm i jsdom`); it exits 0 with a notice when jsdom is absent, so it can
 * sit in CI without making Node a build dependency of the app itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

// jsdom is resolved from the repo, the working directory, or $RENDER_CHECK_MODULES, so it
// can live outside the project and Node stays out of the app's own build.
let JSDOM;
{
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const req = createRequire(import.meta.url);
  const paths = [ROOT, process.cwd(), process.env.RENDER_CHECK_MODULES].filter(Boolean);
  let entry = null;
  for (const base of paths) {
    try { entry = req.resolve('jsdom', { paths: [base] }); break; } catch { /* try the next one */ }
  }
  if (!entry) {
    console.log('render-check: jsdom not found — skipping.');
    console.log(`  install it in one of: ${paths.join(', ')}  (npm i jsdom)`);
    process.exit(0);
  }
  ({ JSDOM } = await import(pathToFileURL(entry).href));
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const bridgeUrl = arg('--bridge', 'http://127.0.0.1:8765');
const configPath = arg('--config', '');

try {
  const ping = await fetch(`${bridgeUrl}/bridge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"PING"}',
  });
  if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
} catch (e) {
  console.error(`render-check: no dev bridge at ${bridgeUrl} (${e.message})`);
  console.error('  start one with: cargo run -p espro-core --features bridge --bin espro-bridge -- ui 8765');
  process.exit(1);
}

/* ------------------------------- a browser-ish global scope ------------------------------- */

const dom = new JSDOM(fs.readFileSync(path.join(UI, 'index.html'), 'utf8'), {
  url: `${bridgeUrl}/`, pretendToBeVisual: true, runScripts: 'outside-only',
});
const { window } = dom;

const errors = [];
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {};
window.alert = () => {};
window.confirm = () => false;          // never take a destructive branch while probing
window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));

// The pages persist console history and preferences in IndexedDB; a stub keeps them
// on their real code path without needing a database.
const memory = new Map();
window.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex() {} }),
        transaction: () => ({
          objectStore: () => ({
            get: (k) => settle({ result: memory.get(k) }),
            getAll: () => settle({ result: [...memory.values()] }),
            put: (v, k) => settle({ result: (memory.set(k ?? v.id ?? v.key, v), true) }),
            delete: (k) => settle({ result: (memory.delete(k), true) }),
            clear: () => settle({ result: (memory.clear(), true) }),
            index: () => ({ getAll: () => settle({ result: [...memory.values()] }) }),
          }),
          oncomplete: null,
        }),
        close() {},
      };
      if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  },
};
function settle(o) {
  const r = { ...o };
  setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
  return r;
}

for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'Event', 'CustomEvent',
                 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
                 'alert', 'confirm', 'scrollTo', 'localStorage', 'DOMParser', 'Element',
                 'SVGElement', 'indexedDB', 'IDBKeyRange']) {
  try { globalThis[k] = window[k]; } catch { /* read-only in this runtime; node's own will do */ }
}

// `transport.js` posts to the relative path /bridge, which Node's fetch cannot resolve.
// Resolving it against the bridge URL is what makes the pages see real cluster data
// rather than rendering their "unreachable" branch.
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' && input.startsWith('/') ? bridgeUrl + input : input;
  return nodeFetch(url, init);
};

const realError = console.error;
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').split('\n')[0]); };

/* ------------------------------------- drive the app -------------------------------------- */

const load = (p) => import(path.join(UI, 'js', p));
const state = await load('core/state.js');

if (configPath) {
  const cfgMod = await load('core/config.js');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = cfgMod.normalize(raw, path.basename(configPath));
  config.fileMeta = { name: path.basename(configPath), path: configPath, size: 1, lastModified: Date.now() };
  await state.setConfig(config, configPath);
  await state.refreshAll({ force: true });
  for (const c of config.clusters) await state.fetchIndices(c.id, '*').catch(() => {});
}

const PAGES = ['overview', 'alerts', 'indices', 'console', 'logs', 'snapshots', 'nodes', 'settings'];
const view = window.document.createElement('div');
window.document.body.append(view);

for (const name of PAGES) {
  const before = errors.length;
  try {
    const mod = await load(`pages/${name}.js`);
    while (view.firstChild) view.removeChild(view.firstChild);
    mod.render(view);
    await new Promise((r) => setTimeout(r, 350));
    if (mod.onData) mod.onData();
    await new Promise((r) => setTimeout(r, 150));
    const nodes = view.querySelectorAll('*').length;
    const failed = errors.length > before;
    if (!failed && nodes < 3) errors.push(`${name}: rendered only ${nodes} node(s) — the page is effectively blank`);
    console.log(`${errors.length > before ? '✗' : '✓'} ${name.padEnd(10)} ${String(nodes).padStart(5)} nodes`);
  } catch (e) {
    console.log(`✗ ${name.padEnd(10)} THREW: ${e.message}`);
    errors.push(`${name}: ${e.message}`);
  }
}

console.error = realError;
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`\nok: all ${PAGES.length} pages rendered without error`);
