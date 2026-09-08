/** Page 7 — configuration, security posture and diagnostics. */

import { h, mount, $ } from '../lib/dom.js';
import { bytes, dt, ago, download } from '../lib/fmt.js';
import * as cfg from '../core/config.js';
import { state, setConfig, refreshAll, clusters, client, hasSessionCredential,
         sessionCredentialLabel, clearSessionCredential, clustersNeedingCredential, isReadOnly } from '../core/state.js';
import { workerStatus, forgetWorker, tunnels as fetchTunnels, listPins, untrustCert, untrustHostKey, tunnelReconnect } from '../core/es.js';
import { showCredentialDialog, forgetVaultCredential } from '../ui/credential-dialog.js';
import { EXAMPLE_YAML } from '../core/example.js';
import { saveTextAs } from '../core/platform.js';
import { editCluster, editJumpHost, editCredentials, editDefaults, unlockSealed } from '../ui/config-editor.js';
import { card, pill, table, empty } from './common.js';
import { navigateTo } from '../core/intent.js';
import { isSnapshotMode } from '../core/snapshot.js';

let host = null;

let core = null;      // last PING
let trust = null;     // last PINS + TUNNELS

export function render(el) { host = el; draw(); confirmCoreGuard(); loadTrust(); }

/** Read the guard back from the core itself rather than trusting the UI's copy. */
async function confirmCoreGuard() {
  const st = await workerStatus();
  core = st;
  const cell = [...document.querySelectorAll('#view td')]
    .find((td) => td.previousElementSibling && td.previousElementSibling.textContent === 'Enforced by the core');
  if (!cell) return;
  const agrees = !!st && st.readOnly === isReadOnly();
  cell.textContent = !st || st.readOnly === undefined ? 'core did not report'
    : `${st.readOnly ? 'yes — writes blocked' : 'no — writes allowed'}${agrees ? '' : ' (MISMATCH with config)'}`;
  const v = document.querySelector('#core-version');
  if (v && st) v.textContent = `v${st.version}`;
}

async function loadTrust() {
  const [t, p] = await Promise.all([fetchTunnels(), listPins()]);
  trust = { tunnels: (t && t.tunnels) || [], pins: (p && p.pins) || { certs: {}, hostkeys: {} } };
  const el = $('#trust-card');
  if (el) mount(el, trustCard());
}

function trustCard() {
  const jh = (state.config && state.config.jumpHosts) || [];
  const tun = (trust && trust.tunnels) || [];
  const certs = (trust && trust.pins && trust.pins.certs) || {};
  const hks = (trust && trust.pins && trust.pins.hostkeys) || {};
  const tRows = jh.map((j) => {
    const t = tun.find((x) => x.id === j.id) || {};
    const st = (t.status && t.status.state) || 'idle';
    return h('tr',
      h('td', h('div', { style: { fontWeight: 620 } }, j.id), h('div.mono.muted', { style: { fontSize: '11px' } }, `${j.user}@${j.host}:${j.port}`)),
      h('td.mono', { style: { fontSize: '11px', wordBreak: 'break-all' } }, j.keyFile || '(password)'),
      h('td', pill(st.replace('_', ' '), st === 'up' ? 'green' : st === 'connecting' ? 'yellow' : st === 'down' ? 'red' : 'grey'),
        t.status && t.status.error ? h('div.muted', { style: { fontSize: '11px', marginTop: '3px' } }, t.status.error) : null),
      h('td.mono', { style: { fontSize: '11px', wordBreak: 'break-all' } }, hks[j.id] ? hks[j.id].sha256 : h('span.muted', 'not pinned yet')),
      h('td', h('div', { style: { display: 'flex', gap: '6px' } },
        h('button.btn.sm', { onclick: async () => { if (await editJumpHost(j.id)) { draw(); loadTrust(); } } }, 'Edit'),
        h('button.btn.sm', { onclick: async () => { await tunnelReconnect(j.id); await refreshAll({ force: true }); loadTrust(); } }, 'Reconnect'),
        hks[j.id] ? h('button.btn.sm.danger', { title: 'Forget the pinned host key; the next connection asks again.',
          onclick: async () => { if (confirm(`Forget the pinned host key of ${j.id}?`)) { await untrustHostKey(j.id); loadTrust(); } } }, 'Untrust') : null)));
  });
  const cRows = Object.entries(certs).sort().map(([hostport, pin]) => h('tr',
    h('td.mono', { style: { fontSize: '11.5px' } }, hostport),
    h('td', { style: { fontSize: '11.5px' } }, pin.subject || '–'),
    h('td.mono', { style: { fontSize: '11px', wordBreak: 'break-all' } }, pin.sha256),
    h('td.muted', { style: { fontSize: '11px' } }, pin.since ? dt(Date.parse(pin.since)) : '–'),
    h('td', h('button.btn.sm.danger', { onclick: async () => { if (confirm(`Untrust the certificate pinned for ${hostport}?`)) { await untrustCert(hostport); await refreshAll({ force: true }); loadTrust(); } } }, 'Untrust'))));
  return h('div', { style: { display: 'grid', gap: '14px' } },
    h('div',
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '6px' } },
        h('span', { style: { fontWeight: 620 } }, `Jump hosts (${jh.length})`),
        h('button.btn.sm.primary', { style: { marginLeft: 'auto' }, onclick: async () => { if (await editJumpHost(null)) { draw(); loadTrust(); } } }, '+ Add jump host')),
      jh.length ? table(['Jump host', 'Key file', 'Tunnel', 'Pinned host key', ''], tRows)
        : h('div.muted', { style: { fontSize: '12px' } }, 'None yet. Add one, then set "via" on the clusters that need it.')),
    h('div',
      h('div', { style: { fontWeight: 620, marginBottom: '6px' } }, `Pinned certificates (${cRows.length})`),
      cRows.length ? table(['Address', 'Subject', 'SHA-256', 'Since', ''], cRows)
        : h('div.muted', { style: { fontSize: '12px' } }, 'None yet. A certificate the OS does not trust is shown on the Clusters page with a Trust button; the decision lands here.')),
    h('div.muted', { style: { fontSize: '11.5px' } }, 'Stored in ', h('code.inline', (core && core.dataDir) ? core.dataDir + '/pins.json' : 'pins.json'), ' — fingerprints only, no secrets.'));
}
export function onData() { if (host && host.isConnected) { draw(); loadTrust(); } }

function draw() {
  const meta = (state.config && state.config.fileMeta) || {};
  const d = state.defaults;

  const clusterRows = clusters().map((c) => {
    const cl = client(c.id);
    return h('tr',
      h('td', h('div', { style: { fontWeight: 620 } }, c.name),
        c.tags && c.tags.length ? h('div', { style: { display: 'flex', gap: '4px', marginTop: '3px' } }, ...c.tags.map((t) => h('span.pill.grey', t))) : null),
      h('td.mono', { style: { fontSize: '11.5px' } }, c.url),
      h('td', c.credSource === 'shared' ? pill('shared (from file)', 'green')
            : c.credSource === 'cluster' ? pill('per-cluster override', 'yellow')
            : c.credSource === 'session' ? pill('typed this session', 'green')
            : c.anonymous ? pill('anonymous', 'grey') : pill('missing', 'red')),
      h('td.mono', { style: { fontSize: '11.5px' } }, c.username || '–'),
      h('td.mono', { style: { fontSize: '11px' } }, c.logIndexPattern),
      h('td', cl ? pill(cl.state.replace('_', ' '), cl.state === 'online' ? 'green' : cl.state === 'auth_error' ? 'yellow' : cl.state === 'unknown' ? 'grey' : 'red') : pill('unknown', 'grey')),
      h('td.muted', { style: { fontSize: '11.5px' } }, cl && cl.lastOkAt ? ago(cl.lastOkAt) : '–'),
      h('td', h('button.btn.sm', { onclick: async () => { if (await editCluster(rawClusterOf(c))) { draw(); loadTrust(); } } }, 'Edit')));
  });
  // disabled clusters are not in clusters(); list them too so they can be re-enabled
  const disabledRows = ((state.config && state.config.clusters) || []).filter((c) => !c.enabled).map((c) => h('tr',
    h('td', h('div', { style: { fontWeight: 620, color: 'var(--text-muted)' } }, c.name)),
    h('td.mono', { style: { fontSize: '11.5px', color: 'var(--text-muted)' } }, c.url),
    h('td', { colspan: 4 }, pill('disabled', 'grey')),
    h('td', h('button.btn.sm', { onclick: async () => { if (await editCluster(rawClusterOf(c))) { draw(); loadTrust(); } } }, 'Edit'))));

  mount(host,
    h('div.grid.c2',
      card('Config file', meta.name || 'not loaded',
        h('div', { style: { display: 'grid', gap: '10px' } },
          table([], [
            kvRow('File', meta.name || '–'),
            kvRow('Size', meta.size ? bytes(meta.size) : '–'),
            kvRow('Last modified on disk', meta.lastModified ? dt(meta.lastModified) : '–'),
            kvRow('Loaded', state.config ? `${dt(state.config.loadedAt)} (${ago(state.config.loadedAt)})` : '–'),
            kvRow('Path', meta.path || (meta.ephemeral ? 'loaded once — not remembered' : '–')),
            kvRow('Format', state.config ? (state.config.format === 'json' ? 'JSON (config_cluster.json)' : 'YAML — edits from the UI are saved as config_cluster.json next to it') : '–'),
            kvRow('Secrets in file', state.config ? (state.config.sealed ? 'encrypted (AES-256-GCM, PBKDF2-SHA512 master password)' : (clusters().some((c) => c.credSource === 'shared' || c.credSource === 'cluster') ? 'PLAIN TEXT — use "Store in config file (encrypted)" to fix' : 'none')) : '–'),
            kvRow('Mode', isSnapshotMode()
              ? `snapshot — collected ${state.snapshot && state.snapshot.generatedAt ? dt(state.snapshot.generatedAt) : '?'}`
                + (state.snapshot && state.snapshot.host ? ` on ${state.snapshot.host}` : '')
              : 'live — the app connects to each cluster (directly or through a jump host)'),
          ]),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button.btn.primary', { onclick: reload, disabled: !state.handle || isSnapshotMode() }, 'Reload from disk'),
            h('button.btn', { onclick: repick }, 'Pick another file…'),
            h('button.btn.danger', { onclick: forget }, 'Forget file & credentials')),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button.btn.sm.ghost', { onclick: () => saveTextAs('clusters.yaml', EXAMPLE_YAML) }, 'Save example YAML…')),
          h('div#cfg-msg'))),

      card('Credentials', hasSessionCredential() ? `session credential active — ${sessionCredentialLabel()}` : 'from the config file',
        h('div', { style: { display: 'grid', gap: '11px' } },
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
            h('button.btn.primary', { onclick: () => showCredentialDialog('manual') },
              clustersNeedingCredential().length ? `Sign in to ${clustersNeedingCredential().length} cluster(s)` : 'Set one credential for all clusters'),
            h('button.btn', { onclick: async () => { if (await editCredentials()) draw(); }, title: 'Write it to config_cluster.json, encrypted with a master password' }, 'Store in config file (encrypted)…'),
            state.config && state.config.sealed && clustersNeedingCredential().length
              ? h('button.btn', { onclick: async () => { if (await unlockSealed()) { await refreshAll({ force: true }); draw(); } } }, 'Unlock with master password…') : null,
            hasSessionCredential()
              ? h('button.btn.danger', { onclick: async () => { await clearSessionCredential(); draw(); } }, 'Clear typed credential')
              : null),
          hasSessionCredential()
            ? h('div.banner', { style: { margin: 0 } },
                h('div', h('div.ttl', `Using a credential you typed (${sessionCredentialLabel()})`),
                  h('div.sec', { style: { fontSize: '12px' } },
                    'Held in memory for this tab only. Reloading the dashboard will ask again.')))
            : null,
        h('div', { style: { fontSize: '12.5px', lineHeight: '1.65', display: 'grid', gap: '8px' } },
          h('div', h('b', 'In memory. '),
            'The password / API key from your YAML is held in the app process and discarded when it closes. Tick "remember on this machine" in the sign-in dialog to keep it in the Windows Credential Manager instead of typing it each start.'),
          h('div', h('b', 'One credential, many clusters. '),
            'The top-level ', h('code.inline', 'credentials:'), ' block authenticates every cluster; add ',
            h('code.inline', 'username:'), '/', h('code.inline', 'apiKey:'), ' under a cluster only when it needs a different one.'),
          h('div', h('b', 'Jump hosts. '),
            'A cluster with ', h('code.inline', 'via: <jump>'), ' is reached through an SSH connection the app opens itself with your key file — no ssh.exe, no PuTTY, no SOCKS to configure. Passphrases are asked for, never read from the file.'),
          h('div', h('b', 'Certificates you decide about. '),
            'A certificate the OS does not trust is shown to you once — subject, issuer, SHA-256 — and pinned when you accept it. A different certificate at the same address is refused until you decide again. No CA import, no policy, no click-through.'),
          h('div', h('b', 'Read-only by default. '),
            'Monitoring uses GET only; the single POST it makes is ', h('code.inline', '_search'),
            ', which cannot modify anything. Writes are refused in the core, so no page, console ',
            'or future code path can reach a cluster with PUT/POST/DELETE while ', h('code.inline', 'readOnly'), ' is true.'),
          h('div', h('b', 'No credential in the file? '),
            'Leave ', h('code.inline', 'credentials:'), ' out entirely (or give only a ', h('code.inline', 'username:'),
            ') and the app prompts once on start, then applies what you type to every cluster URL.'))))),

    h('div', { style: { marginTop: '14px' } },
      card('Jump hosts & trust', 'SSH tunnels, pinned host keys, pinned certificates', h('div#trust-card', h('div.muted', 'loading…')))),

    h('div', { style: { marginTop: '14px' } },
      card('Clusters', `${clusters().length} enabled · ${disabledRows.length} disabled`,
        table(['Name', 'URL', 'Credential', 'User', 'Log index pattern', 'Connection', 'Last success', ''], [...clusterRows, ...disabledRows],
          { emptyText: 'No clusters yet — add one.' }),
        [h('button.btn.sm.primary', { onclick: async () => { if (await editCluster(null)) { draw(); loadTrust(); } } }, '+ Add cluster')])),

    h('div.grid.c2', { style: { marginTop: '14px' } },
      card('Effective defaults', 'from the defaults block, with built-in fallbacks',
        table([], Object.entries(d).map(([k, v]) => kvRow(k, String(v)))),
        [h('button.btn.sm', { onclick: async () => { if (await editDefaults()) draw(); } }, 'Edit defaults…')]),

      card('Diagnostics & shortcuts', '',
        h('div', { style: { display: 'grid', gap: '10px' } },
          table([], [
            kvRow('Write protection', isReadOnly() ? 'read-only — GET/HEAD + search POSTs only' : 'DISABLED — writes permitted (readOnly: false)'),
            kvRow('Enforced by the core', 'checking…'),
            kvRow('Routes', `${clusters().filter((c) => c.via).length} via jump host · ${clusters().filter((c) => !c.via).length} direct`),
            kvRow('App version', h('span#core-version', '…')),
            kvRow('Last refresh', state.lastRefresh ? ago(state.lastRefresh) : 'never'),
            kvRow('Auto-refresh', state.autoRefresh ? `every ${d.refreshIntervalSec}s` : 'paused'),
          ]),
          h('div', { style: { fontSize: '12px' } },
            h('b', 'Keyboard: '), h('code.inline', '1'), '–', h('code.inline', '7'), ' switch pages · ',
            h('code.inline', 'r'), ' refresh · ', h('code.inline', 'Ctrl/⌘+Enter'), ' run request in the console'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button.btn.sm', { onclick: () => saveTextAs('clusters.example.yaml', EXAMPLE_YAML) }, 'Save example YAML…'),
            isSnapshotMode() ? null : h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, 'Force refresh all'),
            h('button.btn.sm', { onclick: () => navigateTo('console') }, 'Open REST console')))))
  );
}

/** The raw file entry behind a normalised cluster (matched by name, then url). */
function rawClusterOf(c) {
  const raw = state.config && state.config.raw;
  const list = (raw && raw.clusters) || [];
  return list.find((x) => x.name === c.name) || list.find((x) => String(x.url || '').replace(/\/+$/, '') === c.url) || null;
}

function kvRow(k, v) {
  return h('tr', h('td', { style: { width: '46%', color: 'var(--text-muted)', fontSize: '11.5px' } }, k),
    h('td.mono', { style: { fontSize: '12px', wordBreak: 'break-all' } }, v));
}

function msg(text, cls = 'banner') {
  const el = $('#cfg-msg');
  if (el) mount(el, h(`div.${cls}`, { style: { margin: 0 } }, text));
}

async function reload() {
  try {
    if (!state.handle) return msg('This config was loaded once; pick it again to reload.', 'banner warn');
    const next = await cfg.readPath(state.handle);
    await setConfig(next, state.handle);
    await refreshAll({ force: true });
    draw(); loadTrust();
    msg(`Reloaded ${next.fileMeta.name} — ${next.clusters.length} cluster(s).`);
  } catch (e) { msg(`Reload failed: ${e.message}`, 'banner err'); }
}

async function repick() {
  try {
    const path = await cfg.pickConfigFile();
    if (!path) return;
    const next = await cfg.readPath(path);
    await setConfig(next, path);
    await refreshAll({ force: true });
    draw(); loadTrust();
    msg(`Loaded ${next.fileMeta.name}.`);
  } catch (e) {
    msg(`Could not load file: ${e.message}`, 'banner err');
  }
}

async function forget() {
  if (!confirm('Forget the config file path, drop the in-memory credentials and remove a remembered vault credential?\n\nThe YAML file on disk is not touched.')) return;
  await forgetVaultCredential();
  await cfg.forgetHandle();
  await forgetWorker();
  location.reload();
}
