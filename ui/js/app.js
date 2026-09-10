/** ElasticVue Pro - shell, router, setup flow. */

import { h, $, mount, clear } from './lib/dom.js';
import { ago, dur } from './lib/fmt.js';
import { idb } from './lib/idb.js';
import * as cfg from './core/config.js';
import { state, bus, setConfig, refreshAll, startAutoRefresh, clusters, alerts, worstHealth,
         clustersNeedingCredential, clustersWithAuthError, hasSessionCredential, isReadOnly } from './core/state.js';
import { showCredentialDialog } from './ui/credential-dialog.js';
import { loadSnapshotFile, isSnapshotMode } from './core/snapshot.js';
import { EXAMPLE_YAML } from './core/example.js';
import { workerStatus } from './core/es.js';
import { saveTextAs } from './core/platform.js';
import { tryVaultCredential } from './ui/credential-dialog.js';
import { createNewConfig, editCluster, unlockSealed } from './ui/config-editor.js';
import { applyLoadedConfig } from './ui/load-config.js';

let coreInfo = { version: '?' };
const saveExample = () => saveTextAs('clusters.yaml', EXAMPLE_YAML);

import * as pOverview from './pages/overview.js';
import * as pAlerts from './pages/alerts.js';
import * as pVolume from './pages/volume.js';
import * as pIndices from './pages/indices.js';
import * as pLogs from './pages/logs.js';
import * as pSnapshots from './pages/snapshots.js';
import * as pNodes from './pages/nodes.js';
import * as pConsole from './pages/console.js';
import * as pSettings from './pages/settings.js';

const PAGES = [
  { id: 'overview',  label: 'Clusters',       icon: '▦', mod: pOverview,  multi: true,  key: '1' },
  { id: 'alerts',    label: 'Alerts',         icon: '⚠', mod: pAlerts,    multi: true,  key: '2' },
  { id: 'indices',   label: 'Indices',        icon: '≡', mod: pIndices,   multi: false, key: '3' },
  { id: 'console',   label: 'REST console',   icon: '⌫', mod: pConsole,   multi: false, key: '4' },
  { id: 'logs',      label: 'Live logs',      icon: '▶', mod: pLogs,      multi: false, key: '5' },
  { id: 'snapshots', label: 'Snapshots & SLM',icon: '↻', mod: pSnapshots, multi: true,  key: '6' },
  { id: 'nodes',     label: 'Nodes & shards', icon: '☷', mod: pNodes,     multi: true,  key: '7' },
  { id: 'volume',    label: 'Volume report',  icon: '▤', mod: pVolume,    multi: true,  key: '8' },
  { id: 'settings',  label: 'Config',         icon: '⚙', mod: pSettings,  multi: true,  key: '9' },
];

const root = document.getElementById('root');
let currentPage = null;

/* --------------------------------- theming ---------------------------------- */
async function initTheme() {
  const t = (await idb.getKV('theme')) || 'system';
  applyTheme(t);
}
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  idb.setKV('theme', t);
}
function cycleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'system';
  applyTheme(cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system');
  renderTopbar();
}

/* -------------------------------- setup view -------------------------------- */

function securityNote() {
  return h('details.disc',
    h('summary', 'Where do my credentials live?'),
    h('div.sec', { style: { fontSize: '12px', padding: '6px 0 2px', lineHeight: '1.6' } },
      h('p', { style: { margin: '0 0 6px' } },
        'The username/password (or API key) is read from your YAML file each time the app starts and is kept in memory only. ',
        'What the app remembers on disk is the PATH of the file, your theme, the console history, and the certificates / jump-host keys you chose to trust (pins.json). ',
        'A credential is written to the Windows Credential Manager only if you tick "remember on this machine" in the sign-in dialog.'),
      h('p', { style: { margin: '0 0 6px' } },
        'Jump-host passphrases and passwords are never read from the file; the app asks for them and forgets them when it closes.'),
      h('p', { style: { margin: 0 } },
        'Keep the YAML file readable only by you (NTFS permissions, or ', h('code.inline', 'chmod 600 clusters.yaml'), ').')));
}

function renderSetup(res) {
  const box = h('div.setup',
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' } },
      h('img', { src: 'icons/icon48.png', width: 34, height: 34, alt: '' }),
      h('div', h('h2', 'ElasticVue Pro'),
        h('div.muted', { style: { fontSize: '12.5px' } }, 'Multi-cluster Elasticsearch dashboard — direct or through a jump host, configured from a YAML file on disk'))),

    res && res.status === 'error'
      ? h('div.banner.err', h('div', h('div.ttl', `Could not load ${res.path || 'the config file'}`), h('div', res.error),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
            h('button.btn.sm', { onclick: () => retryPath(res.path) }, 'Retry'),
            h('button.btn.sm.ghost', { onclick: async () => { await cfg.forgetHandle(); boot(); } }, 'Forget this file'))))
      : null,

    h('div.card', h('div.body',
      h('ol.steps',
        h('li', h('div', h('b', 'Create the config in the app'), h('div.sec', 'Add clusters, jump hosts and the shared credential from the Config page. Saved as ',
          h('code.inline', 'config_cluster.json'), '; passwords are encrypted with a master password you choose.'))),
        h('li', h('div', h('b', '…or open a file you already have'), h('div.sec', 'JSON or YAML (the extension\u2019s clusters.yaml works unchanged). ',
          h('button.btn.sm', { style: { marginLeft: '4px' }, onclick: saveExample }, 'Save YAML example…')))),
        h('li', h('div', h('b', 'Keep it private'), h('div.sec', 'The path is remembered; contents are re-read every start and never copied anywhere else.')))),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
        h('button.btn.primary', { onclick: createNew, title: 'Start an empty config_cluster.json and add clusters from the UI' }, '+ Create new config'),
        h('button.btn', { onclick: pick }, 'Open existing (.json / .yaml)…'),
        h('label.btn', { style: { position: 'relative', overflow: 'hidden' }, title: 'Parse a file in this window without remembering its path' }, 'Load once (not remembered)',
          h('input', { type: 'file', accept: '.yaml,.yml', style: { position: 'absolute', inset: '0', opacity: '0', cursor: 'pointer' },
            onchange: (e) => loadOnce(e.target.files[0]) })),
        h('button.btn.ghost', { onclick: saveExample }, 'Save example YAML')),
      h('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)' } },
        h('div', { style: { marginBottom: '6px' } }, h('b', 'Or open a snapshot')),
        h('div.sec', { style: { fontSize: '12px', marginBottom: '8px' } },
          'A JSON file written by ', h('code.inline', 'Collect-EsSnapshot.ps1'), ' or the esfleet collector. Every page renders from it; no network access at all.'),
        h('label.btn', { style: { position: 'relative', overflow: 'hidden' } }, 'Open snapshot (.json)…',
          h('input', { type: 'file', accept: '.json,application/json',
            style: { position: 'absolute', inset: '0', opacity: '0', cursor: 'pointer' },
            onchange: (e) => openSnapshot(e.target.files[0]) }))))),

    h('div', { style: { marginTop: '14px' } }, securityNote()),
    h('div.muted#core-line', { style: { marginTop: '12px', fontSize: '11px' } },
      coreInfo && coreInfo.desktop ? `core v${coreInfo.version} · ${coreInfo.vault ? 'OS vault available' : 'no OS vault'} · trust store: ${coreInfo.dataDir || 'memory'}`
        : 'core not reachable — is this the app or the dev bridge?')
  );
  mount(root, box);
}

async function pick() {
  try {
    const path = await cfg.pickConfigFile();
    if (!path) return;
    await retryPath(path);
  } catch (e) {
    renderSetup({ status: 'error', error: e.message });
  }
}

async function createNew() {
  try {
    const path = await createNewConfig();
    renderShell();
    go('settings');
    const added = await editCluster(null);
    if (!added) go('settings');
    await refreshAll({ force: true });
    startAutoRefresh();
    renderSideFoot();
  } catch (e) {
    renderSetup({ status: 'error', error: e.message });
  }
}

async function retryPath(path) {
  try {
    const config = await cfg.readPath(path);
    await start(config, path);
  } catch (e) {
    renderSetup({ status: 'error', error: e.message, path });
  }
}

async function openSnapshot(file) {
  if (!file) return;
  try {
    await loadSnapshotFile(file);
    renderShell();
    const wanted = (location.hash || '').replace('#/', '') || 'overview';
    go(PAGES.some((p) => p.id === wanted) ? wanted : 'overview');
  } catch (e) {
    renderSetup({ status: 'error', error: `Could not read that snapshot — ${e.message}` });
  }
}

async function loadOnce(file) {
  if (!file) return;
  try {
    const config = cfg.parseYamlText(await file.text(), file.name);
    config.fileMeta = { name: file.name, size: file.size, lastModified: file.lastModified, ephemeral: true };
    await start(config, null);
  } catch (e) {
    renderSetup({ status: 'error', error: e.message });
  }
}

/* ---------------------------------- shell ----------------------------------- */

function renderShell() {
  // Everything chrome-like lives across the top, so a wide table gets the whole window.
  const header = h('header.header',
    h('div.topbar#topbar'),
    h('nav.nav#nav'),
    h('div.status-strip#side-foot'));

  const main = h('main.main', h('div.page#view'));

  mount(root, h('div.app', header, main));
  renderNav();
  renderTopbar();
  renderSideFoot();
}

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  clear(nav);
  const a = alerts();
  const crit = a.filter((x) => x.level === 'critical').length;
  PAGES.forEach((p) => {
    if (p.id === 'settings') nav.append(h('div.nav-sep'));
    // The alert count belongs on the tab: it is the reason to go there.
    const badge = p.id === 'alerts' && a.length
      ? h('span.pill', { class: crit ? 'red' : 'yellow', style: { fontSize: '10px', padding: '0 5px' } }, String(a.length))
      : h('span.kbd', p.key);
    nav.append(h('button', {
      'aria-current': currentPage === p.id ? 'page' : null,
      onclick: () => go(p.id),
    }, h('span.ico', p.icon), h('span', p.label), badge));
  });
}

function renderTopbar() {
  const bar = $('#topbar');
  if (!bar) return;
  const page = PAGES.find((p) => p.id === currentPage) || PAGES[0];
  const a = alerts();
  const crit = a.filter((x) => x.level === 'critical').length;
  const theme = document.documentElement.getAttribute('data-theme') || 'system';

  const sel = h('select#cluster-select', { onchange: (e) => { state.selected = e.target.value; go(currentPage); } });
  if (page.multi) sel.append(h('option', { value: 'all' }, `All clusters (${clusters().length})`));
  clusters().forEach((c) => sel.append(h('option', { value: c.id }, c.name)));
  if (!page.multi && state.selected === 'all' && clusters()[0]) state.selected = clusters()[0].id;
  sel.value = state.selected;

  mount(bar,
    h('div.brand', h('img', { src: 'icons/icon48.png', alt: '' }),
      h('div', h('b', 'ElasticVue Pro'), h('span#cfg-name', ''))),
    h('h1', page.label),
    h('label.field', { style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } }, sel),
    h('div.spacer'),
    (() => {
      const need = clustersNeedingCredential().length;
      const bad = clustersWithAuthError().length;
      if (!need && !bad) return null;
      return h('button.btn.sm.primary', {
        onclick: () => showCredentialDialog(bad && !need ? 'auth_error' : 'startup'),
        title: 'One credential, applied to every cluster',
      }, need ? `Sign in (${need} cluster${need === 1 ? '' : 's'})` : `Re-enter credentials (${bad})`);
    })(),
    a.length
      ? h('button.btn.sm', { class: crit ? 'danger' : '', onclick: () => go('alerts'), title: 'Open the Alerts page' },
          `${a.length} alert${a.length > 1 ? 's' : ''}`)
      : h('span.pill.green', h('i.dot'), 'all healthy'),
    isSnapshotMode()
      ? h('span.pill.grey', { title: `Rendered from a file collected by PowerShell${state.snapshot && state.snapshot.host ? ' on ' + state.snapshot.host : ''}. The browser is making no network requests.` },
          h('i.dot'), 'snapshot')
      : isReadOnly()
      ? h('span.pill.grey', { title: 'Only GET/HEAD and search-family POSTs are sent. Enforced in the extension service worker, not just the UI. Set readOnly: false in clusters.yaml to allow writes.' },
          h('i.dot'), 'read-only')
      : h('span.pill.yellow', { title: 'clusters.yaml sets readOnly: false — PUT/POST/DELETE are permitted from the REST console and the SLM Run-now button.' },
          h('i.dot'), 'writes enabled'),
    h('span#refresh-status.muted', { style: { fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' } }, ''),
    h('button.btn.sm', {
      hidden: isSnapshotMode(),
      onclick: () => {
        state.autoRefresh = !state.autoRefresh;
        state.nextRefreshAt = Date.now() + state.defaults.refreshIntervalSec * 1000;
        idb.setKV('autoRefresh', state.autoRefresh);
        renderTopbar();
      },
      class: state.autoRefresh ? '' : 'ghost',
      title: state.autoRefresh
        ? `Auto-refresh is on (every ${state.defaults.refreshIntervalSec}s). Click to turn it off.`
        : 'Auto-refresh is off. Data only updates when you press Refresh. Click to turn it on.',
    }, state.autoRefresh ? `\u23F8 Auto ${state.defaults.refreshIntervalSec}s` : '\u25B6 Auto off'),
    isSnapshotMode()
      ? h('label.btn.sm', { style: { position: 'relative', overflow: 'hidden' }, title: 'Open a newer snapshot file' }, '↻ Load newer',
          h('input', { type: 'file', accept: '.json,application/json',
            style: { position: 'absolute', inset: '0', opacity: '0', cursor: 'pointer' },
            onchange: (e) => openSnapshot(e.target.files[0]) }))
      : h('button.btn.sm', { onclick: () => refreshAll({ force: true }), title: 'Refresh now (r)' }, '↻ Refresh'),
    h('button.btn.sm.ghost', { onclick: cycleTheme, title: `Theme: ${theme}` },
      theme === 'dark' ? '\u25D1 Dark' : theme === 'light' ? '\u25CB Light' : '\u25D2 System'));
  tickStatus();
}

function tickStatus() {
  const el = $('#refresh-status');
  if (!el) return;
  if (state.refreshing) { mount(el, h('span', h('span.spin'), ' refreshing…')); return; }
  const left = Math.max(0, state.nextRefreshAt - Date.now());
  if (isSnapshotMode()) {
    const gen = state.snapshot && state.snapshot.generatedAt;
    el.textContent = gen ? `collected ${ago(gen)}` : 'snapshot';
    el.title = gen ? new Date(gen).toString() : '';
    return;
  }
  el.textContent = state.lastRefresh
    ? `updated ${ago(state.lastRefresh)}${state.autoRefresh ? ` · next in ${dur(left)}` : ' · manual'}`
    : '';
}

/** The status the sidebar foot used to carry, now a strip under the tabs. */
function renderSideFoot() {
  const el = $('#side-foot');
  if (!el) return;
  const meta = state.config && state.config.fileMeta;
  const row = (label, value, opts = {}) => h('span.row', opts, h('b', label), value);

  mount(el,
    row('Config', h('span.trunc', { style: { maxWidth: '260px' } }, meta ? meta.name : '—'),
      { title: meta ? (meta.path || meta.name) : '' }),
    row('Clusters', String(clusters().length)),
    row('Health', worstHealth()),
    row('Build', h('span.mono', 'v' + (coreInfo.version || '?'))),
    // one per jump host: "jumpwin ● up"
    ...((coreInfo.tunnels || []).map((t) => {
      const st = (t.status && t.status.state) || 'idle';
      const color = st === 'up' ? 'var(--good)' : st === 'connecting' ? 'var(--warning)' : st === 'down' ? 'var(--critical)' : 'var(--text-muted)';
      return row(`Tunnel ${t.id}`,
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
          h('i', { style: { width: '7px', height: '7px', borderRadius: '50%', background: color, display: 'inline-block' } }), st),
        { title: st === 'down' && t.status.error ? t.status.error : `${t.user}@${t.host}:${t.port}` });
    })),
    isSnapshotMode()
      ? h('span.row', { style: { color: 'var(--accent)' } },
          'snapshot' + (state.snapshot && state.snapshot.host ? ' from ' + state.snapshot.host : ''))
      : null,
    meta && meta.ephemeral ? h('span.row', { style: { color: 'var(--warning)' } }, 'loaded once — not remembered') : null);
  const nm = $('#cfg-name');
  if (nm) nm.textContent = meta ? meta.name : '';
}

/* ---------------------------------- router ---------------------------------- */

export function go(id) {
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  currentPage = page.id;
  location.hash = `#/${page.id}`;
  if (!page.multi && state.selected === 'all' && clusters()[0]) state.selected = clusters()[0].id;
  renderNav();
  renderTopbar();
  const view = $('#view');
  if (!view) return;
  clear(view);
  try {
    page.mod.render(view);
  } catch (e) {
    console.error(e);
    mount(view, h('div.banner.err', h('div', h('div.ttl', 'Page failed to render'), h('div.mono', String(e && e.stack || e)))));
  }
}

/* ----------------------------------- boot ----------------------------------- */

async function start(config, handle) {
  await setConfig(config, handle);
  // Precedence: the user's own toggle (remembered) > defaults.autoRefresh in the YAML > off.
  const saved = await idb.getKV('autoRefresh');
  state.autoRefresh = (saved === true || saved === false) ? saved : (state.defaults.autoRefresh === true);
  renderShell();
  const wanted = (location.hash || '').replace('#/', '') || 'overview';
  go(PAGES.some((p) => p.id === wanted) ? wanted : 'overview');
  if (!isSnapshotMode() && clustersNeedingCredential().length) {
    // a credential remembered in the OS vault (opt-in) signs in without a prompt;
    // else an encrypted credential in the file asks for its master password;
    // else the plain sign-in dialog
    const fromVault = await tryVaultCredential();
    if (!fromVault && state.config.sealed) await unlockSealed();
    if (!fromVault && clustersNeedingCredential().length) showCredentialDialog('startup');
  }
  await refreshAll({ force: true });
  startAutoRefresh();
}

async function boot() {
  await initTheme();
  try { coreInfo = (await workerStatus()) || coreInfo; } catch (_) { /* dev bridge missing */ }
  let res = await cfg.loadConfig();
  if (res.status === 'no_file' && coreInfo.configHint) {
    // --config <path> / ELASTICVUE_CONFIG: pre-provisioned config, e.g. on the jump server
    try { res = { status: 'ok', path: coreInfo.configHint, config: await cfg.readPath(coreInfo.configHint) }; }
    catch (e) { res = { status: 'error', path: coreInfo.configHint, error: e.message }; }
  }
  if (res.status === 'ok') await start(res.config, res.path);
  else renderSetup(res);
}

// keep the side-foot tunnel line current
setInterval(async () => {
  if (!state.config || isSnapshotMode()) return;
  try { const st = await workerStatus(); if (st && st.ok) { coreInfo = st; renderSideFoot(); } } catch (_) { /* ignore */ }
}, 10000);

bus.on('refreshing', () => { tickStatus(); });
bus.on('refreshed', () => { maybeOfferAuthRecovery(); renderTopbar(); renderSideFoot(); renderNav(); const p = PAGES.find((x) => x.id === currentPage); if (p && p.mod.onData) p.mod.onData(); });
bus.on('tick', tickStatus);

let offeredAuthRecovery = false;
function maybeOfferAuthRecovery() {
  if (isSnapshotMode() || offeredAuthRecovery || hasSessionCredential()) return;
  if (clustersNeedingCredential().length) return;      // the startup prompt covers this
  if (!clustersWithAuthError().length) return;
  offeredAuthRecovery = true;
  showCredentialDialog('auth_error');
}
bus.on('data', () => { renderNav(); const p = PAGES.find((x) => x.id === currentPage); if (p && p.mod.onData) p.mod.onData(); });

window.addEventListener('evp:navigate', (e) => {
  const id = e.detail && e.detail.page;
  if (id && PAGES.some((p) => p.id === id)) go(id);
});

window.addEventListener('hashchange', () => {
  const wanted = (location.hash || '').replace('#/', '');
  if (wanted && wanted !== currentPage && PAGES.some((p) => p.id === wanted)) go(wanted);
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const p = PAGES.find((x) => x.key === e.key);
  if (p) { go(p.id); return; }
  if (e.key === 'r' && !isSnapshotMode()) refreshAll({ force: true });
  if (e.key === '?') alert(['Keyboard shortcuts', '', ...PAGES.map((x) => `${x.key}  ${x.label}`), 'r  refresh now'].join('\n'));
});

// Reload config from disk when the file changed and the window regains focus.
window.addEventListener('focus', async () => {
  if (isSnapshotMode()) return;
  if (!state.handle || !state.config || !state.config.fileMeta) return;
  try {
    const next = await cfg.readPath(state.handle);
    if (next.fileMeta.lastModified && next.fileMeta.lastModified !== state.config.fileMeta.lastModified) {
      // Same path as Reload from disk. `prompt: false` because this fires on window
      // focus — a dialog nobody asked for would be a surprise; the cached master
      // password still reopens sealed secrets silently.
      await applyLoadedConfig(next, state.handle, { prompt: false });
      renderSideFoot();
      renderTopbar();
      go(currentPage);
    }
  } catch (_) { /* file gone or unreadable right now; the user will see it on next action */ }
});

export { renderTopbar, renderSideFoot, boot, PAGES };
boot();
