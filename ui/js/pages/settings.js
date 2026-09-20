/** Page 7 — configuration, security posture and diagnostics. */

import { h, mount, $ } from '../lib/dom.js';
import { bytes, dt, ago, download } from '../lib/fmt.js';
import * as cfg from '../core/config.js';
import { state, setConfig, refreshAll, clusters, client, hasSessionCredential,
         sessionCredentialLabel, clearSessionCredential, clustersNeedingCredential, isReadOnly } from '../core/state.js';
import { workerStatus, forgetWorker, tunnels as fetchTunnels, listPins, untrustCert, untrustHostKey, tunnelReconnect,
         delaySinkGet, delaySinkSet, delaySinkRun } from '../core/es.js';
import { showCredentialDialog, forgetVaultCredential } from '../ui/credential-dialog.js';
import { EXAMPLE_YAML } from '../core/example.js';
import { saveTextAs } from '../core/platform.js';
import { editCluster, editJumpHost, editCredentials, editDefaults, unlockSealed, saveRaw } from '../ui/config-editor.js';
import { card, pill, table, empty } from './common.js';
import { navigateTo } from '../core/intent.js';
import { ALERT_RULES, loadAlertSettings, isEnabled } from '../core/alert-rules.js';
import { toast } from '../ui/menu.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { applyLoadedConfig } from '../ui/load-config.js';
import { filePickerButton, canPickByPath, configHistory, readVersion } from '../ui/upload.js';
import { confirmDialog } from '../ui/modal.js';
import { rowMenu, ICON } from '../ui/menu.js';

let host = null;

let core = null;      // last PING
let trust = null;     // last PINS + TUNNELS
let sink = null;      // last DELAY_SINK_GET; null until asked, {supported:false} off hosted

/* ------------------------- uploading a config, and its history ------------------- */

let versions = [];
let historyOpen = false;

/**
 * A config the operator chose in their browser.
 *
 * Parsed before it is saved, so a file that is not a config is refused here rather than
 * after it has replaced the working one. Then it goes through applyLoadedConfig, the same
 * path every other way of loading a config uses — a second loader would be a second set
 * of rules about credentials and sealed secrets.
 */
async function uploadConfig(text, err, name) {
  const msg = $('#cfg-msg');
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? 'var(--critical-ink)' : ''; } };
  if (err) return say(err, true);
  try {
    const parsed = cfg.parseConfigText(text, name);
    parsed.fileMeta = { name, size: text.length, lastModified: Date.now(), ephemeral: false };
    // The same two steps every other loader uses: make it the live config, then write it
    // where the core reads it. saveRaw() owns "where does a config get saved", including
    // falling back to the core's default path, so this does not get its own opinion.
    await applyLoadedConfig(parsed, null);
    const path = await saveRaw();
    say(`Loaded ${name} and saved to ${path}. The version it replaced is in the history.`);
    await loadHistory();
  } catch (e) {
    say(`${name} is not a usable config: ${e.message || e}`, true);
  }
}

async function loadHistory() {
  try { versions = await configHistory(); } catch { versions = []; }
  const el = $('#cfg-history');
  if (el) mount(el, historyBody());
}

function historyBlock() {
  // Fetched lazily: it is one more round trip and most visits to this page are not
  // looking for it.
  if (!versions.length && !historyOpen) loadHistory().then(() => { historyOpen = true; });
  return h('div#cfg-history', { style: { marginTop: '10px' } }, historyBody());
}

function historyBody() {
  if (!versions.length) {
    return h('div.muted', { style: { fontSize: '11.5px' } },
      'No earlier versions yet. One is kept each time the config is saved from here.');
  }
  return h('details.disc', { open: false },
    h('summary', `Earlier versions (${versions.length})`),
    h('div', { style: { paddingTop: '6px' } },
      table(['Saved', 'File', { label: 'Size', num: true }, ''],
        versions.map((v) => h('tr',
          h('td', { title: new Date(v.saved_at * 1000).toISOString() }, ago(v.saved_at * 1000)),
          h('td.mono', { style: { fontSize: '11.5px' } }, v.source),
          h('td.num', bytes(v.bytes)),
          h('td', { style: { textAlign: 'right' } },
            h('button.btn.sm', { onclick: () => restore(v) }, 'Load this')))),
        { emptyText: 'None' })),
    h('div.muted', { style: { fontSize: '11px', paddingTop: '6px' } },
      'Loading an older version does not discard the current one — that is saved as a '
      + 'version first, so this goes both ways.'));
}

async function restore(v) {
  const msg = $('#cfg-msg');
  try {
    const text = await readVersion(v.id);
    await uploadConfig(text, null, v.source);
  } catch (e) {
    if (msg) { msg.textContent = e.message || String(e); msg.style.color = 'var(--critical-ink)'; }
  }
}

export function render(el) {
  host = el;
  // draw() asks for whatever the open section needs. loadSink is the exception: its
  // answer decides whether the Scheduled log delay tab exists at all, so it has to be
  // asked before the bar can be drawn correctly — and it redraws when it lands.
  draw();
  loadSink();
}

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
          onclick: async () => {
            if (await confirmDialog(`Forget the pinned host key of ${j.id}?`,
              'The next connection treats this jump host as unknown and asks you to confirm its ' +
              'fingerprint again. Do this after a deliberate reinstall or rekey.',
              { yes: 'forget it', danger: true })) { await untrustHostKey(j.id); loadTrust(); }
          } }, 'Untrust') : null)));
  });
  const cRows = Object.entries(certs).sort().map(([hostport, pin]) => h('tr',
    h('td.mono', { style: { fontSize: '11.5px' } }, hostport),
    h('td', { style: { fontSize: '11.5px' } }, pin.subject || '–'),
    h('td.mono', { style: { fontSize: '11px', wordBreak: 'break-all' } }, pin.sha256),
    h('td.muted', { style: { fontSize: '11px' } }, pin.since ? dt(Date.parse(pin.since)) : '–'),
    h('td', h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, rowMenu([
      { label: 'Forget this pin…', icon: ICON.delete, danger: true,
        title: 'The certificate is offered for trust again on the next connection',
        onClick: async () => {
          if (await confirmDialog(`Forget the certificate pinned for ${hostport}?`,
            'The next connection treats this certificate as unknown and offers it for trust ' +
            'again. Do this after a deliberate rotation.',
            { yes: 'forget it', danger: true })) {
            await untrustCert(hostport); await refreshAll({ force: true }); loadTrust();
          }
        } },
    ], { title: `Actions for ${hostport}` })))));
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
    // The reassurance is worth saying; the path it is kept at is not. Naming a file on
    // the server tells a reader nothing they can act on from a browser, and tells anyone
    // else where to look. Config paths elsewhere on this page are a different matter —
    // that file is the operator's own, and they are expected to go and edit it.
    h('div.muted', { style: { fontSize: '11.5px' } },
      'Trust decisions record fingerprints only — never a key, a password or a certificate.'));
}
export function onData() { if (host && host.isConnected) draw(); }

/* ------------------------------ alert triggers ------------------------------ */

/**
 * Every alert this app can raise, with a switch and its thresholds.
 *
 * The list is the registry, so a rule cannot exist in the code and be missing here.
 * Switching one off stops it being shown; it does not stop it being computed, and it does
 * not touch anything anybody acknowledged — the identity of an alert is unchanged by
 * being disabled, which is what makes retuning safe.
 *
 * Writing a genuinely new rule is the Automation page's job. There is one rule editor in
 * this product and this is not a second one.
 */
function alertRulesCard() {
  const raw = state.config && state.config.raw;
  const settings = loadAlertSettings(raw);
  const admin = !!raw;
  const off = ALERT_RULES.filter((r) => !isEnabled(settings, r.id)).length;

  const save = async (mutate) => {
    if (!raw) { toast('No config loaded', 'warn'); return; }
    if (!raw.alertRules || typeof raw.alertRules !== 'object') raw.alertRules = {};
    mutate(raw.alertRules);
    try {
      await saveRaw(raw);
      await setConfig(await cfg.normalize(raw, (state.config.fileMeta || {}).name || 'config'), state.handle);
      toast('Alert settings saved');
    } catch (e) {
      toast(`Could not save: ${e.message}`, 'err', 5000);
    }
    draw();
  };

  const trs = ALERT_RULES.map((r) => {
    const on = isEnabled(settings, r.id);
    const s = settings[r.id] || {};
    return h('tr', { style: on ? null : { opacity: '.55' } },
      h('td', h('input', { type: 'checkbox', checked: on, disabled: !admin,
        title: on ? `Stop showing ${r.label}` : `Show ${r.label} again`,
        onchange: (e) => {
          const want = e.target.checked;
          save((a) => { a[r.id] = { ...(a[r.id] || {}), enabled: want }; });
        } })),
      h('td', h('div', { style: { fontWeight: 620 } }, r.label),
        h('div.muted', { style: { fontSize: '11px' } }, r.why)),
      h('td', pill(r.level, r.level === 'critical' ? 'red' : 'yellow')),
      h('td', (r.thresholds || []).length
        ? h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
            ...r.thresholds.map((t) => h('label', {
              style: { display: 'inline-flex', gap: '4px', alignItems: 'center', fontSize: '11.5px' },
            },
              h('span.muted', t.label),
              h('input', {
                type: 'number', min: String(t.min), max: String(t.max), disabled: !admin,
                value: String((s.thresholds && s.thresholds[t.key]) ?? state.defaults[t.key] ?? ''),
                style: { width: '68px' },
                title: `${t.min}–${t.max}${t.unit}`,
                onchange: (e) => {
                  const v = Number(e.target.value);
                  if (!isFinite(v) || v < t.min || v > t.max) {
                    toast(`${t.label} must be between ${t.min} and ${t.max}${t.unit}`, 'warn');
                    draw(); return;
                  }
                  save((a) => {
                    a[r.id] = { ...(a[r.id] || {}) };
                    a[r.id].thresholds = { ...(a[r.id].thresholds || {}), [t.key]: v };
                  });
                },
              }),
              h('span.muted', t.unit))))
        : h('span.muted', { style: { fontSize: '11.5px' } }, '\u2014')),
      h('td.mono.muted', { style: { fontSize: '10.5px' } }, r.id));
  });

  return card('Alert triggers',
    `${ALERT_RULES.length} rule(s)${off ? ` \u00b7 ${off} switched off` : ' \u00b7 all on'}`,
    h('div', { style: { display: 'grid', gap: '8px' } },
      h('div.muted', { style: { fontSize: '12px' } },
        'Switching a rule off stops it appearing on the Alerts page. Anything already '
        + 'acknowledged keeps its history \u2014 disabling a rule does not change what its '
        + 'alerts are called. To write a rule of your own, use ',
        h('button.btn.sm.ghost', { onclick: () => navigateTo('automation') }, 'Automation'),
        '.'),
      !admin ? h('div.muted', { style: { fontSize: '11.5px' } }, 'Read-only \u2014 no config is loaded.') : null,
      table(['', 'Alert', 'Level', 'Thresholds', 'id'], trs)));
}

/* ----------------------- the scheduled log-delay measurement ----------------------- */

/**
 * The one thing in this product that acts without somebody present.
 *
 * It exists only in the hosted edition, so on a desktop build this card is absent rather
 * than disabled — an option you cannot ever use is worse than no option. Everything the
 * card shows about the last run comes from the core, which is the only thing that knows:
 * the page is not running the timer and must not pretend to.
 *
 * Measurements are shipped raw. Whether 41 minutes counts as delayed is decided on the
 * Log delay page, by the same thresholds that apply to a live run, which is why nothing
 * here asks for one.
 */
async function loadSink() {
  try {
    sink = await delaySinkGet();
  } catch (_) {
    // A core too old to know the message, or an edition that does not schedule. Either
    // way there is nothing to offer.
    sink = null;
  }
  if (host && host.isConnected) draw();
}

function sinkField(label, key, opts = {}) {
  const c = (sink && sink.config) || {};
  return h('label', { style: { display: 'grid', gap: '3px', fontSize: '11.5px' } },
    h('span.muted', label),
    h('input', {
      id: `sink-${key}`, type: opts.type || 'text',
      value: String(c[key] ?? ''),
      min: opts.min == null ? null : String(opts.min),
      max: opts.max == null ? null : String(opts.max),
      style: { width: opts.width || '100%' },
      title: opts.title || '',
    }));
}

function delaySinkCard() {
  if (!sink || !sink.supported) return null;
  const c = sink.config || {};
  const st = sink.state || {};
  const list = clusters();
  const picked = new Set((c.clusters || []).length ? c.clusters : list.map((x) => x.id).filter((id) => id !== c.sinkClusterId));

  const read = () => {
    const v = (key) => { const el = $(`#sink-${key}`); return el ? el.value.trim() : ''; };
    const chosen = list.map((x) => x.id).filter((id) => { const el = $(`#sink-pick-${id}`); return el && el.checked; });
    return {
      enabled: !!($('#sink-enabled') || {}).checked,
      sinkClusterId: (($('#sink-target') || {}).value || '').trim(),
      clusters: chosen,
      everyHours: Number(v('everyHours')) || 2,
      indexPrefix: v('indexPrefix'),
      indexPattern: v('indexPattern'),
      deviceField: v('deviceField'),
      arrivalField: v('arrivalField'),
      eventTimeFields: v('eventTimeFields').split(',').map((f) => f.trim()).filter(Boolean),
      maxDevices: Number(v('maxDevices')) || 2000,
    };
  };

  const save = async () => {
    const next = read();
    // Empty means "every cluster" to the core, which is right for a hand-edited file and
    // wrong for a screen where somebody has just unticked the last box.
    if (next.enabled && !next.clusters.length) { toast('Pick at least one cluster to measure', 'warn'); return; }
    if (next.enabled && next.clusters.length === 1 && next.clusters[0] === next.sinkClusterId) {
      toast('The only cluster picked is the one being written to', 'warn'); return;
    }
    try {
      const res = await delaySinkSet(next);
      if (!res || !res.ok) { toast(`Not saved: ${(res && res.message) || 'refused'}`, 'err', 6000); return; }
      sink = { ...res, supported: true };
      toast(next.enabled ? 'Scheduled measurement armed' : 'Scheduled measurement switched off');
      draw();
    } catch (e) {
      toast(`Could not save: ${e.message}`, 'err', 5000);
    }
  };

  const runNow = async () => {
    toast('Measuring…');
    try {
      const res = await delaySinkRun();
      if (res && res.skipped) toast(`Nothing was measured: ${res.skipped}`, 'warn', 8000);
      else if (res && res.ok) toast(`Measured ${res.measured} device(s) across ${res.clusters} cluster(s) into ${res.index}`, 'ok', 8000);
      else toast(`Run failed: ${(res && res.error) || 'unknown'}`, 'err', 8000);
    } catch (e) {
      toast(`Run failed: ${e.message}`, 'err', 6000);
    }
    loadSink();
  };

  const status = st.lastSkipped
    ? pill('skipped', 'yellow')
    : !st.runs ? pill('never run', 'grey')
    : st.lastOk ? pill('ok', 'green') : pill('failed', 'red');

  return card('Scheduled log delay',
    c.enabled ? `every ${c.everyHours}h \u2192 ${c.sinkClusterId || 'nowhere'}` : 'switched off',
    h('div', { style: { display: 'grid', gap: '10px' } },
      h('div.muted', { style: { fontSize: '12px' } },
        'The bridge measures each cluster\u2019s log delay on a timer and writes the raw '
        + 'figures to the cluster you name below. Only the hosted edition does this \u2014 a '
        + 'desktop app is not running when nobody is looking at it. Nothing is classified '
        + 'on the way in: the ',
        h('button.btn.sm.ghost', { onclick: () => navigateTo('logs') }, 'Log delay'),
        ' page applies the thresholds when the data is read back.'),
      sink.blocked
        ? h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } }, 'Cannot run right now: ', sink.blocked)
        : null,
      h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'end' } },
        h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12px' } },
          h('input#sink-enabled', { type: 'checkbox', checked: !!c.enabled }), 'Run on a timer'),
        h('label', { style: { display: 'grid', gap: '3px', fontSize: '11.5px' } },
          h('span.muted', 'Write measurements to'),
          h('select#sink-target', {},
            h('option', { value: '' }, '\u2014 pick a cluster \u2014'),
            ...list.map((x) => h('option', { value: x.id, selected: x.id === c.sinkClusterId }, x.name)))),
        sinkField('Every (hours)', 'everyHours', { type: 'number', min: 1, max: 24, width: '80px' }),
        sinkField('Index prefix', 'indexPrefix', { title: 'Indices are <prefix>-YYYY.MM' }),
        sinkField('Max devices per run', 'maxDevices', { type: 'number', min: 1, max: 10000, width: '110px' })),
      h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'end' } },
        sinkField('Indices to measure', 'indexPattern'),
        sinkField('Device field', 'deviceField'),
        sinkField('Arrival time field', 'arrivalField'),
        sinkField('Event time fields', 'eventTimeFields',
          { title: 'Comma separated, tried in order \u2014 the first one present is used' })),
      h('div', { style: { display: 'grid', gap: '4px' } },
        h('span.muted', { style: { fontSize: '11.5px' } }, 'Clusters to measure'),
        h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
          ...list.map((x) => h('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '11.5px' } },
            h('input', { id: `sink-pick-${x.id}`, type: 'checkbox', checked: picked.has(x.id) }), x.name)))),
      table([], [
        kvRow('Status', status),
        kvRow('Last attempt', st.lastRunAt ? `${dt(st.lastRunAt)} (${ago(st.lastRunAt)})` : 'never'),
        kvRow('Last result', st.lastSkipped ? st.lastSkipped
          : st.runs ? `${st.lastMeasured} device(s) written, ${st.lastFailed} cluster(s) failed` : '\u2014'),
        kvRow('Last error', st.lastError || '\u2014'),
        kvRow('Next run', c.enabled && st.nextDueAt ? `${dt(st.nextDueAt)} (${ago(st.nextDueAt)})` : 'not scheduled'),
        kvRow('Runs since start', String(st.runs || 0)),
      ]),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button.btn.primary', { onclick: save }, 'Save'),
        h('button.btn', { onclick: runNow }, 'Run now'))));
}
/* ---------------------------------- sections ---------------------------------- */

/**
 * The Config page is eight unrelated jobs, and it used to be all eight at once: a single
 * scroll where "which certificate do we trust" sat under "what is the refresh interval"
 * and the thing you came for was somewhere in the middle. Nothing was hard to find
 * because it was hidden; it was hard to find because everything else was in the way.
 *
 * So they are tabs, in the same shape as the tabs at the top of the window. The bar is
 * the page's table of contents: you can see every job this page does without scrolling,
 * and you are only ever looking at one of them.
 *
 * A section may be absent — the schedule only exists on a build that can keep one — and
 * an absent section has no tab. An option you can never use is worse than no option.
 */
const SECTIONS = [
  { id: 'file',     label: 'Config file',  icon: '▤', build: fileCard },
  { id: 'creds',    label: 'Credentials',  icon: '◈', build: credentialsCard },
  { id: 'clusters', label: 'Clusters',     icon: '▦', build: clustersCard },
  { id: 'trust',    label: 'Jump hosts & trust', icon: '⇄', build: trustSection, load: loadTrust },
  { id: 'alerts',   label: 'Alert triggers', icon: '⚠', build: alertRulesCard },
  { id: 'schedule', label: 'Scheduled log delay', icon: '⏱', build: delaySinkCard,
    when: () => !!(sink && sink.supported) },
  { id: 'defaults', label: 'Defaults',     icon: '⚙', build: defaultsCard },
  { id: 'diag',     label: 'Diagnostics',  icon: '✚', build: diagnosticsCard, load: confirmCoreGuard },
];

/** Which section is open. Remembered across redraws so a save does not move you. */
let section = 'file';

function visibleSections() {
  return SECTIONS.filter((s) => !s.when || s.when());
}

function activeSection() {
  const shown = visibleSections();
  return shown.find((s) => s.id === section) || shown[0];
}

/**
 * The tab bar. Deliberately the same markup and the same `aria-current` as the window's
 * own tabs, so it reads as navigation rather than as a row of buttons that happen to be
 * next to each other — and so a screen reader calls it what it is.
 */
function sectionNav() {
  const active = activeSection();
  const nav = h('nav.subnav');
  visibleSections().forEach((s) => {
    nav.append(h('button', {
      'aria-current': active && active.id === s.id ? 'page' : null,
      title: s.label,
      onclick: () => { section = s.id; draw(); },
    }, h('span.ico', s.icon), h('span', s.label)));
  });
  return nav;
}

/* ------------------------------ the sections ------------------------------ */

function fileCard() {
  const meta = (state.config && state.config.fileMeta) || {};
  return card('Config file', meta.name || 'not loaded',
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
      h('div#cfg-msg'),
      historyBlock()),
    // The actions this section is for, in the card's own footer rather than loose in the
    // body — which is where the top of the page keeps its buttons, so they line up.
    [
      h('button.btn.sm.primary', { onclick: reload, disabled: !state.handle || isSnapshotMode() }, 'Reload from disk'),
      // "Pick another file" asks the core for a path, which is the right question on a
      // desktop and the wrong one on a server, where the file is on the operator's own
      // machine.
      canPickByPath()
        ? h('button.btn.sm', { onclick: repick }, 'Pick another file…')
        : filePickerButton('Upload a config…', {
            accept: '.json,.yaml,.yml',
            className: 'btn.sm',
            onText: (txt, err, name) => uploadConfig(txt, err, name),
          }),
      h('button.btn.sm.ghost', { onclick: () => saveTextAs('clusters.yaml', EXAMPLE_YAML) }, 'Save example YAML…'),
      h('button.btn.sm.danger', { onclick: forget }, 'Forget file & credentials'),
    ]);
}

function credentialsCard() {
  const needing = clustersNeedingCredential().length;
  return card('Credentials',
    hasSessionCredential() ? `session credential active — ${sessionCredentialLabel()}` : 'from the config file',
    h('div', { style: { display: 'grid', gap: '11px' } },
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
          ') and the app prompts once on start, then applies what you type to every cluster URL.'))),
    [
      h('button.btn.sm.primary', { onclick: () => showCredentialDialog('manual') },
        needing ? `Sign in to ${needing} cluster(s)` : 'Set one credential for all clusters'),
      h('button.btn.sm', {
        onclick: async () => { if (await editCredentials()) draw(); },
        title: 'Write it to config_cluster.json, encrypted with a master password',
      }, 'Store in config file (encrypted)…'),
      state.config && state.config.sealed && needing
        ? h('button.btn.sm', { onclick: async () => { if (await unlockSealed()) { await refreshAll({ force: true }); draw(); } } }, 'Unlock with master password…')
        : null,
      hasSessionCredential()
        ? h('button.btn.sm.danger', { onclick: async () => { await clearSessionCredential(); draw(); } }, 'Clear typed credential')
        : null,
    ].filter(Boolean));
}

function trustSection() {
  return card('Jump hosts & trust', 'SSH tunnels, pinned host keys, pinned certificates',
    h('div#trust-card', h('div.muted', 'loading…')));
}

function clustersCard() {
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

  return card('Clusters', `${clusters().length} enabled · ${disabledRows.length} disabled`,
    table(['Name', 'URL', 'Credential', 'User', 'Log index pattern', 'Connection', 'Last success', ''],
      [...clusterRows, ...disabledRows], { emptyText: 'No clusters yet — add one.' }),
    [h('button.btn.sm.primary', { onclick: async () => { if (await editCluster(null)) { draw(); loadTrust(); } } }, '+ Add cluster')]);
}

function defaultsCard() {
  const d = state.defaults;
  return card('Effective defaults', 'from the defaults block, with built-in fallbacks',
    table([], Object.entries(d).map(([k, v]) => kvRow(k, String(v)))),
    [h('button.btn.sm', { onclick: async () => { if (await editDefaults()) draw(); } }, 'Edit defaults…')]);
}

function diagnosticsCard() {
  const d = state.defaults;
  return card('Diagnostics & shortcuts', '',
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
        h('code.inline', 'r'), ' refresh · ', h('code.inline', 'Ctrl/⌘+Enter'), ' run request in the console')),
    [
      h('button.btn.sm', { onclick: () => saveTextAs('clusters.example.yaml', EXAMPLE_YAML) }, 'Save example YAML…'),
      isSnapshotMode() ? null : h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, 'Force refresh all'),
      h('button.btn.sm', { onclick: () => navigateTo('console') }, 'Open REST console'),
    ].filter(Boolean));
}

function draw() {
  const active = activeSection();
  mount(host, sectionNav(), h('div', { style: { marginTop: '12px' } }, active ? active.build() : null));
  // A section that needs a round trip asks for it here rather than on page entry, so
  // opening Config no longer fires every request the page could ever need.
  if (active && active.load) active.load();
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
    msg('Reading the file…', 'banner');
    const next = await cfg.readPath(state.handle);
    // applyLoadedConfig also reopens sealed secrets and re-applies a remembered
    // credential — without it a reload leaves every cluster without one.
    await applyLoadedConfig(next, state.handle);
    draw(); loadTrust();
    msg(`Reloaded ${next.fileMeta.name} — ${next.clusters.length} cluster(s).`);
  } catch (e) { msg(`Reload failed: ${e.message}`, 'banner err'); }
}

async function repick() {
  try {
    const path = await cfg.pickConfigFile();
    if (!path) return;
    const next = await cfg.readPath(path);
    await applyLoadedConfig(next, path);
    draw(); loadTrust();
    msg(`Loaded ${next.fileMeta.name}.`);
  } catch (e) {
    msg(`Could not load file: ${e.message}`, 'banner err');
  }
}

async function forget() {
  if (!(await confirmDialog('Forget this configuration?',
    'The remembered file path, the credentials held in memory and any credential kept in the OS ' +
    'vault are dropped, and the app restarts at the setup screen.\n\n' +
    'The config file on disk is not touched.', { yes: 'forget it', danger: true }))) return;
  await forgetVaultCredential();
  await cfg.forgetHandle();
  await forgetWorker();
  location.reload();
}
