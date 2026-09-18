#!/usr/bin/env node
/**
 * Drive the pages, rather than only draw them.
 *
 *   cargo run -p espro-core --features bridge --bin espro-bridge -- ui 8765 &
 *   node tools/mock-es.mjs 9299 &
 *   node tools/behaviour-check.mjs
 *
 * `check-ui.mjs` resolves imports and `render-check.mjs` draws every page, but a page can
 * draw perfectly and still be wrong the moment somebody uses it: a view behind a select
 * that nothing ever selects, an export nothing ever clicks, a panel whose folded state is
 * only decided on the second render. Two shipped bugs came out of exactly that gap — a
 * dialog that threw on open because its import was never added, and a jump-host button
 * that did nothing until you pressed refresh — and neither check could have caught
 * either, because neither one ever pressed anything.
 *
 * So this presses things. It needs the mock cluster, because behaviour without data is a
 * different code path from the one people use.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findJsdom, bootApp, applyConfig, settleFor } from './lib/jsdom-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const bridgeUrl = arg('--bridge', 'http://127.0.0.1:8765');
const configPath = arg('--config', path.join(ROOT, 'tools/render-fixture.json'));

let JSDOM;
{
  const { entry, paths } = findJsdom([ROOT, process.cwd()]);
  if (!entry) {
    console.log('behaviour-check: jsdom not found — skipping.');
    console.log(`  install it in one of: ${paths.join(', ')}  (npm i jsdom)`);
    process.exit(0);
  }
  ({ JSDOM } = await import(pathToFileURL(entry).href));
}

try {
  const ping = await fetch(`${bridgeUrl}/bridge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"PING"}',
  });
  if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
} catch (e) {
  console.error(`behaviour-check: no dev bridge at ${bridgeUrl} (${e.message})`);
  console.error('  start one with: cargo run -p espro-core --features bridge --bin espro-bridge -- ui 8765');
  process.exit(1);
}

const { window, files, load, restoreConsole } = await bootApp({ JSDOM, uiRoot: UI, bridgeUrl });
const { config } = await applyConfig({ load, configPath });
if (!config.clusters.length) {
  console.error('behaviour-check: the config has no clusters — there would be nothing to drive');
  process.exit(1);
}

const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };
const doc = window.document;

/* ----------------------------- the app's own shell ----------------------------- */

const app = await load('app.js');
{
  // Built here rather than through boot(), which would pull in the auth gate and config
  // loading — neither is what any of this is about.
  const mk = (tag, cls, id) => { const e = doc.createElement(tag); e.className = cls; e.id = id; return e; };
  const header = doc.createElement('header');
  header.append(mk('div', 'topbar', 'topbar'), mk('nav', 'nav', 'nav'), mk('div', 'status-strip', 'side-foot'));
  const main = doc.createElement('main');
  main.append(mk('div', 'page', 'view'));
  doc.body.append(header, main);
}

const panel = (title) => [...doc.querySelectorAll('section.card')]
  .find((s) => s.querySelector('header h2') && s.querySelector('header h2').textContent === title);
const shown = (title) => {
  const p = panel(title);
  return !!(p && p.querySelector('.body') && !p.querySelector('.body').hidden);
};
const sheetHeaders = () => [...doc.querySelectorAll('table.sheet thead tr:last-child th')]
  .map((th) => th.textContent.replace(/[▲▼]/g, '').replace(/i$/, '').trim());
const groupBand = () => [...doc.querySelectorAll('table.sheet thead tr.group-head th')]
  .map((th) => `${th.textContent.trim()}×${th.getAttribute('colspan') || 1}`);

async function go(id) { app.go(id); await settleFor(350); }

/* ------------- the status strip stays off the pages people work in ------------- */

const STRIP_HIDDEN = ['indices', 'console', 'logs', 'snapshots', 'nodes', 'volume'];
const STRIP_SHOWN = ['overview', 'alerts'];

for (const id of [...STRIP_HIDDEN, ...STRIP_SHOWN]) {
  await go(id);
  const strip = doc.getElementById('side-foot');
  if (!strip) { problems.push(`${id}: the shell has no #side-foot at all`); continue; }
  const want = STRIP_HIDDEN.includes(id);
  ok(strip.hidden === want, `${id}: status strip hidden=${strip.hidden}, expected ${want}`);
}

// A refresh rebuilds the strip from an event that fires whatever page is open. Deciding
// its visibility anywhere but in that rebuild means it reappears on the next tick.
await go('indices');
app.renderSideFoot();
await settleFor(80);
ok(doc.getElementById('side-foot').hidden === true,
  'indices: the status strip came back when the strip was rebuilt');

/* ------------------------ the REST console names its target ------------------------ */

await go('console');
{
  const target = doc.getElementById('c-target');
  const run = doc.getElementById('c-run');
  ok(!!target, 'console: no #c-target line naming the address');
  ok(!!run, 'console: no Run button');
  if (target && run) {
    ok(!!(target.compareDocumentPosition(run) & window.Node.DOCUMENT_POSITION_FOLLOWING),
      'console: the address is not above the Run button, where it is read before pressing it');
  }
  const base = config.clusters[0].url.replace(/\/+$/, '');
  ok(target && target.textContent.startsWith(base),
    `console: the address line reads "${target && target.textContent}", expected to start with ${base}`);

  const pathInput = doc.getElementById('c-path');
  ok(!!pathInput, 'console: no path input');
  if (pathInput && target) {
    for (const [typed, want] of [['/_cat/indices', `${base}/_cat/indices`],
                                 ['_cluster/health', `${base}/_cluster/health`]]) {
      pathInput.value = typed;
      pathInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      await settleFor(50);
      ok(target.textContent === want,
        `console: typing "${typed}" gave "${target.textContent}", expected "${want}"`);
    }
  }

  const body = doc.getElementById('c-body');
  ok(!!body, 'console: no query textarea');
  ok(body && !body.getAttribute('placeholder'),
    `console: the query box still carries a placeholder — "${body && body.getAttribute('placeholder')}"`);
}

/* ---------------------------- charts start unfolded ---------------------------- */

await go('nodes');
ok(shown('Heap used by node'), 'nodes: "Heap used by node" starts folded');
ok(shown('Disk used by node'), 'nodes: "Disk used by node" starts folded');

await go('indices');
ok(shown('Store size by source'), 'indices: "Store size by source" starts folded');
ok(shown('Indices per day'), 'indices: "Indices per day" starts folded');

await go('snapshots');
ok(shown('Snapshot availability'), 'snapshots: "Snapshot availability" starts folded');
ok(panel('Repositories') && panel('Repositories').querySelector('.body').hidden,
  'snapshots: "Repositories" is a table and should still start folded');

/* --------------------- the volume report and its two sheets --------------------- */

await go('volume');
{
  let h = sheetHeaders();
  ok(h.some((x) => x.startsWith('Current live storage store upto')),
    `volume: the renamed column is missing — got ${h.slice(5, 10).join(' | ')}`);
  ok(!h.some((x) => x.includes('Free disk lasts')), 'volume: the old "Free disk lasts" label is still here');
  ok(h.length === 36, `volume: the full sheet should have 36 columns, has ${h.length}`);

  const exportBtn = () => [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Export CSV');
  ok(!!exportBtn(), 'volume: no Export CSV button');
  exportBtn().click();
  const full = files.at(-1);
  ok(full && /^volume-resource-report-\d{4}-\d{2}-\d{2}\.csv$/.test(full.name),
    `volume: the full export is named "${full && full.name}"`);
  ok(full && full.text.split('\n')[0].split(',').length === 37,
    `volume: the full CSV has ${full && full.text.split('\n')[0].split(',').length} headers, expected 36 + "Generated at"`);
  ok(full && full.text.includes('Current live storage store upto (days)'),
    'volume: the renamed column did not reach the CSV');

  const sel = [...doc.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'client'));
  ok(!!sel, 'volume: the View select does not offer the client storage plan');
  if (sel) {
    sel.value = 'client';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settleFor(220);

    const WANT = ['ClientName', 'ES Host', 'Current Per Day Volume', 'Daily Volume +30%',
      'Current Live Storage', 'Live Used', 'Current Live Storage Store Upto',
      'Required Live Storage for 30days', 'Required Live Storage for 90days',
      'Current Backup Storage', 'Backup Storage Type',
      'Required Backup Storage for 365 days', 'Current Backup storage Store upto'];
    h = sheetHeaders();
    ok(h.length === 13, `volume: the client plan should have 13 columns, has ${h.length}`);
    WANT.forEach((w, i) => ok(h[i] && h[i].startsWith(w),
      `volume: client column ${i} is "${h[i]}", expected "${w}"`));
    ok(JSON.stringify(groupBand()) === JSON.stringify(
      ['Client×1', '×1', 'Volume×2', 'Live storage×5', 'Backup storage×4']),
      `volume: the client plan's group band reads ${groupBand().join(' ')}`);

    const rows = doc.querySelectorAll('table.sheet tbody tr').length;
    ok(rows === config.clusters.length,
      `volume: the client plan has ${rows} rows for ${config.clusters.length} cluster(s)`);

    exportBtn().click();
    const cli = files.at(-1);
    ok(cli && /^client-storage-plan-\d{4}-\d{2}-\d{2}\.csv$/.test(cli.name),
      `volume: the client export is named "${cli && cli.name}"`);
    const hdr = cli ? cli.text.split('\n')[0].split(',') : [];
    ok(hdr.length === 14, `volume: the client CSV has ${hdr.length} headers, expected 13 + "Generated at"`);
    ok(hdr[0] === 'ClientName', `volume: the client CSV starts with "${hdr[0]}"`);
    ok(hdr[2] === 'Current Per Day Volume (GB)', `volume: client CSV column 2 is "${hdr[2]}"`);
    ok(hdr[12] === 'Current Backup storage Store upto (days)', `volume: client CSV column 12 is "${hdr[12]}"`);
    ok(cli && cli.text.split('\n').length === config.clusters.length + 1,
      `volume: the client CSV has ${cli && cli.text.split('\n').length} lines`);

    sel.value = 'summary';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settleFor(200);
    ok(!!panel('Capacity by cluster'), 'volume: the summary view did not render');
  }
}

/* ------------- an alert hands over the cluster, not just the page ------------- */

{
  const { navigateTo } = await load('core/intent.js');
  const state = (await load('core/state.js')).state;
  const target = config.clusters[config.clusters.length - 1];

  await go('overview');
  state.selected = 'all';
  navigateTo('nodes', null, { cluster: target.id });
  await settleFor(350);
  ok(state.selected === target.id,
    `hand-off: selected is "${state.selected}", expected "${target.id}" — the page opened on the wrong cluster`);
  ok((window.location.hash || '').includes('nodes'),
    `hand-off: landed on "${window.location.hash}", expected the nodes page`);

  // A page that can show the whole fleet must keep the named cluster too, or the fleet
  // preference quietly puts "All clusters" back and the hand-off does nothing.
  state.selected = 'all';
  navigateTo('snapshots', null, { cluster: target.id });
  await settleFor(350);
  ok(state.selected === target.id,
    `hand-off to a fleet page: selected is "${state.selected}", expected "${target.id}"`);

  // No cluster named means no opinion about the selection.
  state.selected = 'all';
  navigateTo('overview');
  await settleFor(300);
  ok(state.selected === 'all', `plain navigation should not change the selection, got "${state.selected}"`);
}

/* ------------------ refresh follows the cluster picker ------------------ */

if (config.clusters.length >= 2) {
  const st = await load('core/state.js');
  const [a, b] = config.clusters;
  const seen = () => [st.state.data.get(a.id), st.state.data.get(b.id)];

  // fetchOverview replaces the whole data object, so identity is how "was this one
  // refreshed" is answered without instrumenting the fetch.
  st.state.selected = a.id;
  let [a0, b0] = seen();
  await st.refreshAll({ force: true, selected: true });
  let [a1, b1] = seen();
  ok(a1 !== a0, 'refresh with one cluster selected did not refresh that cluster');
  ok(b1 === b0, 'refresh with one cluster selected also refreshed the other one');

  st.state.selected = 'all';
  [a0, b0] = seen();
  await st.refreshAll({ force: true, selected: true });
  [a1, b1] = seen();
  ok(a1 !== a0 && b1 !== b0, 'refresh on "All clusters" should refresh every cluster');
}

/* ----------- the last five snapshots, per repository, with crafted state ----------- */

// Last, and deliberately: this replaces state.config and state.data wholesale, so every
// section above has to have had its turn with the real fixture first.
{
  const st = await load('core/state.js');
  const { DEFAULTS } = await load('core/config.js');
  const DAY = 86400000;
  const now = Date.now();
  const snap = (id, status, ageDays) => ({
    id, status, start: now - ageDays * DAY, end: now - ageDays * DAY, failed: 0,
  });
  const setup = (repos, snapshots) => {
    st.state.defaults = { ...DEFAULTS };
    st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
    st.state.selected = 'all';
    st.state.clients = new Map([['c1', { state: 'online' }]]);
    st.state.data = new Map([['c1', { reachable: true, health: { status: 'green' }, repos, snapshots, slm: [] }]]);
  };
  const snapAlerts = () => st.alerts().filter((x) => x.key.includes(':repo:'));

  ok(st.SNAPSHOT_WINDOW === 5, `the snapshot window should be 5, is ${st.SNAPSHOT_WINDOW}`);

  // Two repositories are two answers. One broken, one fine.
  setup([{ name: 'daily', error: null }, { name: 'weekly', error: null }], {
    daily: [snap('d3', 'SUCCESS', 0.2), snap('d2', 'SUCCESS', 1.2), snap('d1', 'SUCCESS', 2.2)],
    weekly: [snap('w5', 'FAILED', 0.3), snap('w4', 'FAILED', 1.3), snap('w3', 'FAILED', 2.3),
             snap('w2', 'SUCCESS', 3.3), snap('w1', 'SUCCESS', 4.3)],
  });
  let al = snapAlerts();
  ok(al.length === 1, `two repos with one broken should raise one alert, raised ${al.length}`);
  ok(al[0] && al[0].repo === 'weekly', `the alert should name the broken repository, named "${al[0] && al[0].repo}"`);
  ok(al[0] && al[0].level === 'critical', `a failing repository is critical, got "${al[0] && al[0].level}"`);
  ok(al[0] && Math.round((now - al[0].failingSince) / DAY) === 2,
    'failing-since should be the oldest run of the failing streak, not the newest');
  ok(al[0] && al[0].snapshot && al[0].snapshot.isNew === true,
    'the newest run is recent, so isNew is true even though it failed');
  ok(al[0] && !/unknown/.test(al[0].detail), `the detail printed "unknown" for a date it has: ${al[0] && al[0].detail}`);

  // A failure older than the window is not this week's problem.
  setup([{ name: 'daily', error: null }], {
    daily: [snap('s6', 'SUCCESS', 0.2), snap('s5', 'SUCCESS', 1.2), snap('s4', 'SUCCESS', 2.2),
            snap('s3', 'SUCCESS', 3.2), snap('s2', 'SUCCESS', 4.2), snap('s1', 'FAILED', 5.2)],
  });
  ok(snapAlerts().length === 0, 'a failure older than the five-run window must not raise an alert');

  // A window that is entirely failures started before we looked, and says so.
  setup([{ name: 'daily', error: null }], {
    daily: [snap('f5', 'FAILED', 0.2), snap('f4', 'FAILED', 1.2), snap('f3', 'FAILED', 2.2),
            snap('f2', 'FAILED', 3.2), snap('f1', 'FAILED', 4.2), snap('f0', 'FAILED', 5.2)],
  });
  al = snapAlerts();
  ok(al.length === 1 && /or earlier/.test(al[0].detail),
    `a full window of failures should say the start may be older: ${al[0] && al[0].detail}`);

  // Successful but old is a stopped schedule, not a broken one.
  setup([{ name: 'daily', error: null }], { daily: [snap('old', 'SUCCESS', 4)] });
  al = snapAlerts();
  ok(al.length === 1 && al[0].level === 'warning', 'a stale-but-successful repository is a warning');
  ok(al[0] && al[0].snapshot.isNew === false, 'a four-day-old snapshot is not new');
  ok(al[0] && /succeeded at 20/.test(al[0].detail), `the stale detail should date the run: ${al[0] && al[0].detail}`);

  setup([{ name: 'daily', error: null }], { daily: [snap('good', 'SUCCESS', 0.1)] });
  ok(snapAlerts().length === 0, 'a healthy recent repository should raise nothing');

  setup([{ name: 'daily', error: null }], { daily: [snap('p', 'PARTIAL', 0.1), snap('ok', 'SUCCESS', 1.1)] });
  ok(snapAlerts().length === 1, 'PARTIAL is a failed run');

  setup([{ name: 'broken', error: 'connect timed out' }], { broken: [] });
  al = snapAlerts();
  ok(al.length === 1 && /unknown, not empty/.test(al[0].detail),
    `an unreadable repository is unknown, not empty: ${al[0] && al[0].detail}`);
}

/* ------------------------------------ verdict ------------------------------------ */

restoreConsole();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('ok: strip, console target, folding, both volume sheets, alert hand-off, scoped refresh and the snapshot window');
// The pages leave auto-refresh timers and a live tail running; nothing here waits on them.
process.exit(0);
