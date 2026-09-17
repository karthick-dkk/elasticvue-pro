/**
 * A browser-ish scope for the unbundled UI, shared by the checks that drive it.
 *
 * `render-check.mjs` draws every page; `behaviour-check.mjs` clicks through a few of
 * them. Both need the same thing underneath — jsdom found wherever it happens to live, an
 * IndexedDB that remembers without a database, and `/bridge` resolved against a real dev
 * bridge. Two copies of that scaffolding would mean one check passing against a scope the
 * other cannot reproduce, which is the kind of disagreement nobody reads carefully.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * jsdom, from the repo, the working directory, or $RENDER_CHECK_MODULES.
 *
 * Returns null rather than throwing: Node is a check dependency, not a build dependency
 * of the app, and a machine without jsdom should be told so rather than fail a build.
 */
export function findJsdom(extraPaths = []) {
  const req = createRequire(import.meta.url);
  const paths = [...extraPaths, process.env.RENDER_CHECK_MODULES].filter(Boolean);
  for (const base of paths) {
    try {
      return { entry: req.resolve('jsdom', { paths: [base] }), paths };
    } catch { /* try the next one */ }
  }
  return { entry: null, paths };
}

function settle(o) {
  const r = { ...o };
  setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
  return r;
}

/** An IndexedDB that keeps the pages on their real code path without a database. */
function memoryIndexedDb() {
  const memory = new Map();
  return {
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
}

const GLOBALS = ['window', 'document', 'location', 'HTMLElement', 'Node', 'Event', 'CustomEvent',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
  'alert', 'confirm', 'scrollTo', 'localStorage', 'DOMParser', 'Element',
  'SVGElement', 'indexedDB', 'IDBKeyRange', 'Blob', 'URL', 'HTMLAnchorElement'];

/**
 * Stand the app's scope up.
 *
 * `errors` collects what the page reported rather than what it returned: a window error
 * or a console.error is a failure even when the render itself finished.
 *
 * `files` collects what the page tried to download. An export is a real feature and the
 * only way to check one is to catch the blob on its way out — jsdom has no file system to
 * write it to, and a link it cannot follow would otherwise fail silently.
 */
export async function bootApp({ JSDOM, uiRoot, bridgeUrl }) {
  const dom = new JSDOM(fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8'), {
    url: `${bridgeUrl}/`, pretendToBeVisual: true, runScripts: 'outside-only',
  });
  const { window } = dom;
  const errors = [];

  window.matchMedia = window.matchMedia
    || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.scrollTo = () => {};
  window.alert = () => {};
  window.confirm = () => false;          // never take a destructive branch while probing
  window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
  window.indexedDB = memoryIndexedDb();

  const files = [];
  {
    let pending = null;
    const RealBlob = window.Blob;
    class CapturingBlob extends RealBlob {
      constructor(parts, opts) { super(parts, opts); pending = String(parts[0]); }
    }
    window.Blob = CapturingBlob;
    window.URL.createObjectURL = () => 'blob:captured';
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function capture() {
      if (this.download) files.push({ name: this.download, text: pending });
    };
  }

  for (const k of GLOBALS) {
    try { globalThis[k] = window[k]; } catch { /* read-only here; node's own will do */ }
  }

  // transport.js posts to the relative path /bridge, which Node's fetch cannot resolve.
  // Resolving it against the bridge URL is what makes the pages see real cluster data
  // rather than rendering their "unreachable" branch.
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? bridgeUrl + input : input;
    return nodeFetch(url, init);
  };

  const realError = console.error;
  console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').split('\n')[0]); };

  return {
    window,
    errors,
    files,
    load: (p) => import(path.join(uiRoot, 'js', p)),
    restoreConsole: () => { console.error = realError; },
  };
}

/** Wait for the app's own timers to settle, which is how the pages finish drawing. */
export const settleFor = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load a config the way the app does, so the pages see real clusters. */
export async function applyConfig({ load, configPath }) {
  const cfgMod = await load('core/config.js');
  const state = await load('core/state.js');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = cfgMod.normalize(raw, path.basename(configPath));
  config.fileMeta = {
    name: path.basename(configPath), path: configPath, size: 1, lastModified: Date.now(),
  };
  await state.setConfig(config, configPath);
  await state.refreshAll({ force: true });
  for (const c of config.clusters) await state.fetchIndices(c.id, '*').catch(() => {});
  return { state, config };
}
