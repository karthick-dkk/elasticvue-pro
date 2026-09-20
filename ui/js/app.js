/** ElasticVue Pro - shell, router, setup flow. */

import { h, $, mount, clear } from './lib/dom.js';
import { ago, dur } from './lib/fmt.js';
import { idb } from './lib/idb.js';
import * as cfg from './core/config.js';
import { state, bus, setConfig, refreshAll, startAutoRefresh, clusters, alerts, worstHealth, requestLoad,
         clustersNeedingCredential, clustersWithAuthError, hasSessionCredential, isReadOnly } from './core/state.js';
import { showCredentialDialog } from './ui/credential-dialog.js';
import { loadSnapshotFile, isSnapshotMode } from './core/snapshot.js';
import { EXAMPLE_YAML } from './core/example.js';
import { workerStatus } from './core/es.js';
import { saveTextAs } from './core/platform.js';
import { tryVaultCredential } from './ui/credential-dialog.js';
import { createNewConfig, editCluster, unlockSealed } from './ui/config-editor.js';
import { applyLoadedConfig } from './ui/load-config.js';
import { authState, loginScreen, signOut } from './ui/login.js';
import { aboutMini } from './ui/about.js';
import { announceNewAlerts, resetAnnounced } from './core/notify.js';
import { onSessionLost } from './core/transport.js';

let coreInfo = { version: '?' };

/**
 * Who is signed in, or null where accounts do not apply.
 *
 * The portable build always leaves this null and every page stays visible, which is the
 * behaviour it has always had. Everywhere else the core is the authority — this is only
 * what the shell uses to avoid offering a page whose every request would be refused.
 */
let me = null;
const ROLE_RANK = { guest: 0, user: 1, admin: 2 };
function may(minRole) {
  if (!me) return true;                       // no accounts on this build
  return (ROLE_RANK[me.role] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}
const saveExample = () => saveTextAs('clusters.yaml', EXAMPLE_YAML);

import * as pOverview from './pages/overview.js';
import * as pAlerts from './pages/alerts.js';
import * as pVolume from './pages/volume.js';
import * as pIndices from './pages/indices.js';
import * as pLogs from './pages/logs.js';
import * as pSnapshots from './pages/snapshots.js';
import * as pShards from './pages/shards.js';
import * as pConsole from './pages/console.js';
import * as pSettings from './pages/settings.js';
import * as pAutomation from './pages/automation.js';
import * as pAccounts from './pages/accounts.js';

/**
 * `minRole` is the lowest role the tab is offered to.
 *
 * It hides a tab; it does not protect anything. The core refuses the requests either way
 * — see `authorize()` in crates/espro-core/src/auth.rs — and this only avoids showing
 * someone a page on which every request would fail. Guest gets the dashboard alone,
 * because every other page names indices, and index names here carry customer names.
 */
const PAGES = [
  // Order is the order of a shift: what is wrong, then what it is wrong on, then the
  // things you reach for to fix it, then the things you only change deliberately.
  { id: 'alerts',    label: 'Alerts',         icon: '⚠', mod: pAlerts,    multi: true,  minRole: 'user' },
  { id: 'overview',  label: 'Clusters',       icon: '▦', mod: pOverview,  multi: true,  minRole: 'guest' },
  { id: 'indices',   label: 'Indices',        icon: '≡', mod: pIndices,   multi: false, minRole: 'user' },
  { id: 'shards',    label: 'Nodes & shards', icon: '☷', mod: pShards,    multi: true,  minRole: 'user' },
  // multi: the Log delay view asks every selected cluster at once. The live tail is
  // still one cluster — it picks which, and says so, rather than the page silently
  // collapsing the fleet selection on the way in.
  { id: 'logs',      label: 'Live logs & Log delay', icon: '▶', mod: pLogs, multi: true,  minRole: 'user' },
  { id: 'console',   label: 'REST console',   icon: '⌫', mod: pConsole,   multi: false, minRole: 'user' },
  { id: 'snapshots', label: 'Snapshots & SLM',icon: '↻', mod: pSnapshots, multi: true,  minRole: 'user' },
  { id: 'volume',    label: 'Volume report',  icon: '▤', mod: pVolume,    multi: true,  minRole: 'user' },
  { id: 'automation', label: 'Automation',    icon: '⟳', mod: pAutomation, multi: true, minRole: 'user' },
  { id: 'accounts',  label: 'Accounts',       icon: '☺', mod: pAccounts,  multi: true,  minRole: 'admin', accountsOnly: true },
  { id: 'settings',  label: 'Config',         icon: '⚙', mod: pSettings,  multi: true,  minRole: 'admin' },
];

/** The tabs this session may actually use. */
function visiblePages() {
  return PAGES.filter((p) => may(p.minRole) && (!p.accountsOnly || !!me));
}

const root = document.getElementById('root');
let currentPage = null;

/**
 * Pages the status strip stays out of the way on.
 *
 * The strip is ambient state — config name, fleet health, how hard we are hitting the
 * clusters — which is worth a glance from a dashboard and is a band of text in the way
 * when you are reading a wide table, typing a request or watching a live tail. It stays
 * on the overview, alerts, automation and the admin pages, where glancing is the point.
 */
const STRIP_HIDDEN = new Set(['indices', 'console', 'logs', 'snapshots', 'shards', 'volume']);

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
/**
 * The themes, in the order the button walks through them.
 *
 * One list, so the button's label, its cycle and the stylesheet cannot disagree about
 * what exists — adding a fourth theme used to mean editing three places and finding the
 * third one later.
 */
const THEMES = [
  { id: 'system',    label: '\u25D2 System' },
  { id: 'light',     label: '\u25CB Light' },
  { id: 'dark',      label: '\u25D1 Dark' },
  { id: 'dark-blue', label: '\u25D5 Dark blue' },
];

function themeLabel(id) {
  return (THEMES.find((t) => t.id === id) || THEMES[0]).label;
}

function cycleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'system';
  const i = THEMES.findIndex((t) => t.id === cur);
  applyTheme(THEMES[(i + 1) % THEMES.length].id);
  renderTopbar();
}

/* -------------------------------- setup view -------------------------------- */

function securityNote() {
  return h('details.disc',
    h('summary', 'Where do my credentials live?'),
    h('div.sec', { style: { fontSize: '12px', padding: '6px 0 2px', lineHeight: '1.6' } },
      h('p', { style: { margin: '0 0 6px' } },
        'The username/password (or API key) is read from your YAML file each time the app starts and is kept in memory only. ',
        'What the app remembers on disk is the PATH of the file, your theme, the console history, and the certificates and jump-host keys you chose to trust. ',
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
        : 'core not reachable — is this the app or the dev bridge?'),
    // The setup screen is where somebody lands before there is any config, so it is also
    // where they are most likely to want the repository or a way to ask for help.
    h('div.credits', { style: { marginTop: '6px', fontSize: '11px' } }, aboutMini(coreInfo.version))
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
  const shown = visiblePages();
  shown.forEach((p) => {
    if (p.id === 'accounts' || (p.id === 'settings' && !shown.some((x) => x.id === 'accounts'))) {
      nav.append(h('div.nav-sep'));
    }
    // The alert count belongs on the tab: it is the reason to go there. Nothing else
    // gets a badge — the tabs used to show a shortcut number that no longer exists.
    const badge = p.id === 'alerts' && a.length
      ? h('span.pill', { class: crit ? 'red' : 'yellow', style: { fontSize: '10px', padding: '0 5px' } }, String(a.length))
      : null;
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

  const sel = h('select#cluster-select', { onchange: (e) => {
    // An explicit choice replaces any remembered fleet-wide view, including one this
    // page borrowed from it.
    state.selected = e.target.value;
    fleetView = e.target.value === 'all';
    go(currentPage);
  } });
  if (page.multi) sel.append(h('option', { value: 'all' }, `All clusters (${clusters().length})`));
  clusters().forEach((c) => sel.append(h('option', { value: c.id }, c.name)));
  resolveSelection(page);
  sel.value = state.selected;

  mount(bar,
    // The product name, and nothing else. The config filename used to sit under it, which
    // made the brand block report an implementation detail — and the same filename is
    // already on the status strip, where ambient state belongs.
    h('div.brand', h('img', { src: 'icons/icon48.png', alt: '' }),
      h('div', h('b', 'ElasticVue Pro'))),
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
    // The read-only / writes-enabled pill used to sit here. Every page that can write
    // now carries its own "Allow writes" toggle, which says the same thing where it
    // matters; a second copy in the title bar was noise.
    isSnapshotMode()
      ? h('span.pill.grey', { title: `Rendered from a file collected by PowerShell${state.snapshot && state.snapshot.host ? ' on ' + state.snapshot.host : ''}. The browser is making no network requests.` },
          h('i.dot'), 'snapshot')
      : null,
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
      : h('button.btn.sm', {
          onclick: () => refreshAll({ force: true, selected: true }),
          title: 'Refresh the selected cluster now, or all of them on "All clusters" (r)',
        }, '↻ Refresh'),
    h('button.btn.sm.ghost', { onclick: cycleTheme, title: `Theme: ${theme} — click for the next one` },
      themeLabel(theme)),
    // Only where accounts exist. The portable build has nobody to sign out.
    me
      ? h('button.btn.sm.ghost', {
          title: `Signed in as ${me.name} (${me.role}) \u2014 sign out`,
          onclick: async () => { await signOut(); me = null; location.reload(); },
        }, `\u23FB ${me.name}`)
      : null);
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
  // Decided here rather than at navigation: the strip is rebuilt from refresh events that
  // fire whatever page is open, so a decision made anywhere else comes undone on the next
  // tick. Hidden, not unbuilt — the content is cheap and stays correct for the way back.
  el.hidden = STRIP_HIDDEN.has(currentPage);
  const meta = state.config && state.config.fileMeta;
  const row = (label, value, opts = {}) => h('span.row', opts, h('b', label), value);

  mount(el,
    row('Config', h('span.trunc', { style: { maxWidth: '260px' } }, meta ? meta.name : '—'),
      { title: meta ? (meta.path || meta.name) : '' }),
    row('Clusters', String(clusters().length)),
    row('Health', worstHealth()),
    row('Build', h('span.mono', 'v' + (coreInfo.version || '?'))),
    // Our own load on the fleet, so "are we stressing Elasticsearch" has a number.
    (() => {
      const total = Object.values(requestLoad.clusters).reduce((n, r) => n + (r.last5m || 0), 0);
      const perMin = Object.values(requestLoad.clusters).reduce((n, r) => n + (r.perMinute || 0), 0);
      return row('Requests', h('span', { title: 'Requests this app sent to every cluster in the last 5 minutes; see the Clusters page for each one' },
        `${total} in 5m · ${perMin.toFixed(1)}/min`));
    })(),
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
    meta && meta.ephemeral ? h('span.row', { style: { color: 'var(--warning)' } }, 'loaded once — not remembered') : null,
    // Pushed to the far end: the strip's left side is live state someone is watching, and
    // the credits must not sit among it competing for the same glance.
    h('span.strip-spacer'),
    aboutMini(coreInfo.version));

}

/* ---------------------------------- router ---------------------------------- */

/**
 * Single-cluster pages need one cluster; fleet pages should not lose "All clusters".
 *
 * Indices, the REST console and Live logs cannot show a fleet, so they pick a cluster.
 * They used to do that by overwriting state.selected, which quietly threw away the
 * user's fleet-wide view: glance at Indices, go back to Clusters, and you are looking
 * at one cluster with no idea why. The fleet view is remembered and restored instead.
 */
let fleetView = true;

function resolveSelection(page) {
  if (!page.multi) {
    if (state.selected === 'all' && clusters()[0]) state.selected = clusters()[0].id;
  } else if (fleetView && state.selected !== 'all') {
    state.selected = 'all';
  }
}

export function go(id) {
  // A hash typed by hand, or one left in the address bar by a previous session under a
  // different account, must not land on a tab this role does not have.
  const allowed = visiblePages();
  const page = allowed.find((p) => p.id === id) || allowed[0] || PAGES[0];
  currentPage = page.id;
  location.hash = `#/${page.id}`;
  resolveSelection(page);
  renderNav();
  renderTopbar();
  renderSideFoot();
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
  // A different config is a different fleet. Whatever is wrong in it is the state you are
  // arriving at, not something that just happened, so the baseline starts again here.
  resetAnnounced();
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

/**
 * Sign in first, where this build has accounts.
 *
 * Resolves once there is a session, or immediately on the portable build, which has no
 * accounts and never shows this. Everything after it — reading the config, priming the
 * clusters — is a request the core will authorise, so none of it can usefully run first.
 */
async function gateOnAuth() {
  let st;
  try { st = await authState(); } catch (_) { return; }
  if (!st.required) { me = null; return; }
  // A live session that is still on the shipped password goes to the change screen, not
  // to a dashboard the core will refuse to fill.
  if (st.caller && !st.caller.mustChange) { me = st.caller; return; }
  me = st.caller && st.caller.mustChange
    ? await loginScreen(root, { mode: 'change', hint: st.caller })
    : await loginScreen(root, { bootstrap: st.bootstrap });
}

async function boot() {
  await initTheme();
  await gateOnAuth();
  try { coreInfo = (await workerStatus()) || coreInfo; } catch (_) { /* dev bridge missing */ }
  let res = await cfg.loadConfig();
  if (res.status === 'no_file' && coreInfo.configHint) {
    // --config <path> / ELASTICVUE_CONFIG: pre-provisioned config, e.g. on the jump server
    try {
      res = { status: 'ok', path: coreInfo.configHint, config: await cfg.readPath(coreInfo.configHint) };
    } catch (e) {
      // A hinted path that does not exist is a fresh install, not a fault. The hosted
      // stack sets ELASTICVUE_CONFIG unconditionally and the config file is gitignored
      // because it holds credentials, so the very first start always lands here — and
      // "Could not load /app/config/config_cluster.json" is a bad first screen for a
      // deployment that is working perfectly. Fall through to setup, which offers to
      // make one. A file that exists but will not parse is still an error.
      res = e.kind === 'not_found'
        ? { status: 'no_file' }
        : { status: 'error', path: coreInfo.configHint, error: e.message };
    }
  }
  if (res.status === 'ok') await start(res.config, res.path);
  else renderSetup(res);
}

// keep the side-foot tunnel line current
setInterval(async () => {
  if (!state.config || isSnapshotMode()) return;
  try { const st = await workerStatus(); if (st && st.ok) { coreInfo = st; renderSideFoot(); } } catch (_) { /* ignore */ }
}, 10000);

// An expired or revoked session: back to the gate rather than a screen of stale numbers
// that quietly stopped updating.
onSessionLost(() => {
  if (!me) return;
  me = null;
  location.reload();
});

bus.on('refreshing', () => { tickStatus(); });
bus.on('refreshed', () => {
  maybeOfferAuthRecovery(); renderTopbar(); renderSideFoot(); renderNav();
  // After the nav, so the tab badge and the toast agree about what is open.
  announceNewAlerts();
  const p = PAGES.find((x) => x.id === currentPage); if (p && p.mod.onData) p.mod.onData();
});
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
  if (!id || !PAGES.some((p) => p.id === id)) return;
  // Arriving with a cluster named means arriving AT that cluster. The fleet preference
  // has to give way or resolveSelection puts "All clusters" straight back on a page that
  // can show one, and the hand-off silently does nothing.
  const wanted = e.detail && e.detail.cluster;
  if (wanted && clusters().some((c) => c.id === wanted)) {
    state.selected = wanted;
    fleetView = false;
  }
  go(id);
});

window.addEventListener('hashchange', () => {
  const wanted = (location.hash || '').replace('#/', '');
  if (wanted && wanted !== currentPage && PAGES.some((p) => p.id === wanted)) go(wanted);
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // Number keys used to jump between pages. They are gone: a stray digit moving the
  // page out from under someone is worse than the shortcut was worth.
  if (e.key === 'r' && !isSnapshotMode()) refreshAll({ force: true, selected: true });
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
