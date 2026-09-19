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

const STRIP_HIDDEN = ['indices', 'console', 'logs', 'snapshots', 'shards', 'volume'];
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

// The shards page replaced Nodes & shards. It has no folding panels — everything on it
// is the working surface — so what is checked is that the surface is actually there.
await go('shards');
{
  const titles = [...doc.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.some((t) => t.startsWith('Shards —')), `shards: no shard table card, saw ${titles.join(' | ')}`);
  ok(titles.includes('Nodes'), `shards: no node strip, saw ${titles.join(' | ')}`);

  const heads = [...doc.querySelectorAll('table.tbl thead th')].map((x) => x.textContent.trim());
  for (const col of ['Index', 'Shard', 'Type', 'State', 'Node', 'Store', 'Unassigned reason']) {
    ok(heads.includes(col), `shards: the table has no "${col}" column, saw ${heads.join(', ')}`);
  }
  // The page renders every selected cluster, and the fixture points two of them at the
  // same mock — so the counts are per cluster, not absolute.
  const shown = [...doc.querySelectorAll('section.card header h2')]
    .filter((x) => x.textContent.startsWith('Shards —')).length;
  // Scoped to the shard tables: the page also carries a node table per cluster now, and
  // counting every row on the page conflates the two.
  const shardRows = [...doc.querySelectorAll('section.card')]
    .filter((sec) => (sec.querySelector('header h2') || {}).textContent?.startsWith('Shards —'))
    .reduce((n, sec) => n + sec.querySelectorAll('table.tbl tbody tr').length, 0);
  ok(shardRows === 3 * shown,
    `shards: expected 3 shards on each of ${shown} cluster(s), rendered ${shardRows} row(s)`);

  // The unassigned one is the row that matters, and it must read as unassigned rather
  // than as a shard sitting on a node called nothing.
  const text = doc.body.textContent;
  ok(/unassigned/i.test(text), 'shards: the unassigned shard is not marked as such');
  ok(/node left/i.test(text), 'shards: the unassigned reason is not shown');

  // A started shard can be moved; an unassigned one has nowhere to move from.
  const moves = [...doc.querySelectorAll('button')].filter((b) => b.textContent === 'Move…').length;
  ok(moves === 2 * shown,
    `shards: expected a Move button on each of the 2 started shards per cluster (${2 * shown}), found ${moves}`);

  // The node half, which this page lost when it stopped being "Nodes & shards".
  ok(titles.includes('Nodes'), `shards: no Nodes card, saw ${titles.join(' | ')}`);
  for (const col of ['Node', 'Roles', 'Version', 'Heap', 'RAM', 'CPU', 'Load 1m/5m', 'Disk', 'Uptime']) {
    ok(heads.includes(col), `shards: the node table has no "${col}" column, saw ${heads.join(', ')}`);
  }
  ok(/master/i.test(doc.body.textContent), 'shards: the master node is not marked');

  // The honeycomb: one cell per shard, which is the point — a table of several hundred
  // rows answers "what are the values", not "how many are wrong".
  ok(titles.includes('Shard states'), `shards: no honeycomb card, saw ${titles.join(' | ')}`);
  const cells = doc.querySelectorAll('polygon').length;
  ok(cells === shardRows, `shards: ${cells} honeycomb cells for ${shardRows} shards — should be one each`);
  const svgs = [...doc.querySelectorAll('svg')];
  ok(svgs.length >= 1 && /^0 0 \d/.test(svgs[0].getAttribute('viewBox') || ''),
    'shards: the honeycomb has no usable viewBox');
  // It shrinks to fit rather than running off the page.
  const vh = Number((svgs[0].getAttribute('viewBox') || '0 0 0 0').split(' ')[3]);
  ok(vh > 0 && vh <= 300, `shards: the honeycomb is ${vh}px tall — it should fit above the fold`);

  // Clicking a cell filters the table to that index, so the two halves are one tool.
  const shardRowsNow = () => [...doc.querySelectorAll('section.card')]
    .filter((sec) => (sec.querySelector('header h2') || {}).textContent?.startsWith('Shards —'))
    .reduce((n, sec) => n + sec.querySelectorAll('table.tbl tbody tr').length, 0);
  const before = shardRowsNow();
  doc.querySelector('polygon').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settleFor(250);
  const after = shardRowsNow();
  ok(after < before, `shards: clicking a honeycomb cell did not filter the table (${before} → ${after})`);

  // Storage accounting is shown whether or not the figures disagree — the two numbers are
  // asked for either way.
  ok(titles.includes('Storage accounting'), `shards: no storage accounting card, saw ${titles.join(' | ')}`);
  const acct = [...doc.querySelectorAll('section.card')]
    .find((sec) => /Storage accounting/.test((sec.querySelector('header h2') || {}).textContent || ''));
  for (const label of ['Indices hold', 'Elasticsearch holds', 'Disk used', 'Unaccounted']) {
    ok(acct && acct.textContent.includes(label), `shards: accounting is missing "${label}"`);
  }

  // Clear the filter the honeycomb click just applied — it landed on the unassigned
  // shard's index, which by definition has nothing movable on it.
  const idxFilter = [...doc.querySelectorAll('input[type=search]')]
    .find((x) => x.placeholder === 'filter by name');
  if (idxFilter) {
    idxFilter.value = '';
    idxFilter.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settleFor(250);
  }

  // Ticking a started shard offers a bulk move; ticking nothing offers nothing.
  ok(!/ticked/.test(doc.body.textContent), 'shards: the bulk bar is showing with nothing ticked');
  const tick = [...doc.querySelectorAll('input[type=checkbox]')].find((x) => x.title === 'Include this shard in a bulk move');
  ok(!!tick, 'shards: no per-row tick on a started shard');
  if (tick) {
    tick.checked = true;
    tick.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settleFor(250);
    ok(/1 shard\(s\) ticked/.test(doc.body.textContent), 'shards: ticking one did not open the bulk bar');
    ok([...doc.querySelectorAll('button')].some((b) => b.textContent === 'Move them…'),
      'shards: the bulk bar has no bulk move');
    const clear = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Clear');
    if (clear) { clear.click(); await settleFor(200); }
  }
}

/* ------------------- the overview sorts by any column that means something ------------------- */

await go('overview');
{
  const heads = [...doc.querySelectorAll('table.tbl thead th')];
  const sortable = heads.filter((th) => th.classList.contains('sortable')).map((th) => th.textContent.replace(/[▲▼]/g, '').trim());
  for (const col of ['Cluster', 'Version', 'Health', 'Disk usage', 'ILM', 'SLM', 'Last snapshot', 'Alerts']) {
    ok(sortable.includes(col), `overview: "${col}" is not sortable — sortable are ${sortable.join(', ')}`);
  }
  // Clicking the active column reverses it rather than re-sorting the same way.
  const first = heads.find((th) => th.textContent.includes('Version'));
  first.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settleFor(200);
  let v = [...doc.querySelectorAll('table.tbl thead th')].find((th) => th.textContent.includes('Version'));
  ok(/▲/.test(v.textContent), `overview: first click should sort ascending, header reads "${v.textContent}"`);
  v.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settleFor(200);
  v = [...doc.querySelectorAll('table.tbl thead th')].find((th) => th.textContent.includes('Version'));
  ok(/▼/.test(v.textContent), `overview: second click should reverse, header reads "${v.textContent}"`);
}

/* ---------------------------- alerts show their shape ---------------------------- */

await go('alerts');
{
  const titles = [...doc.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.includes('Alert statistics'), `alerts: no statistics card, saw ${titles.join(' | ')}`);
  // Two gauges, drawn as arcs rather than written as numbers.
  const paths = doc.querySelectorAll('section.card svg path').length;
  ok(paths >= 2, `alerts: expected gauge arcs, found ${paths} path(s)`);
  ok(/clusters alerting/.test(doc.body.textContent), 'alerts: the fleet gauge is unlabelled');
}

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
  const viewBtn = (label) => [...doc.querySelectorAll('button')].find((b) => b.textContent === label);
  // Three buttons, not a dropdown, and the summary is what the page opens on.
  for (const label of ['Summary', 'Full report', 'Client plan']) {
    ok(!!viewBtn(label), `volume: no "${label}" view button`);
  }
  ok(!!panel('Capacity by cluster'), 'volume: the page should open on the summary table');
  ok(![...doc.querySelectorAll('.stat')].some((x) => /FLEET INGEST/i.test(x.textContent)),
    'volume: the fleet stat tiles are back');

  viewBtn('Full report').click();
  await settleFor(220);
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

  {
    viewBtn('Client plan').click();
    await settleFor(220);

    const WANT = ['ClientName', 'ES Host', 'Current Per Day Volume', 'Daily Volume +30%',
      'Current Live Storage', 'Live Used', 'Current Live Storage Store Upto',
      'Required Live Storage for 30days', 'Required Live Storage for 90days',
      'Live Indices From', 'Live Indices To',
      'Current Backup Storage', 'Backup Storage Type',
      'Required Backup Storage for 365 days', 'Current Backup storage Store upto',
      'Snapshot Indices From', 'Snapshot Indices To'];
    h = sheetHeaders();
    ok(h.length === 17, `volume: the client plan should have 17 columns, has ${h.length}`);
    WANT.forEach((w, i) => ok(h[i] && h[i].startsWith(w),
      `volume: client column ${i} is "${h[i]}", expected "${w}"`));
    ok(JSON.stringify(groupBand()) === JSON.stringify(
      ['Client×1', '×1', 'Volume×2', 'Live storage×7', 'Backup storage×6']),
      `volume: the client plan's group band reads ${groupBand().join(' ')}`);

    const rows = doc.querySelectorAll('table.sheet tbody tr').length;
    ok(rows === config.clusters.length,
      `volume: the client plan has ${rows} rows for ${config.clusters.length} cluster(s)`);

    exportBtn().click();
    const cli = files.at(-1);
    ok(cli && /^client-storage-plan-\d{4}-\d{2}-\d{2}\.csv$/.test(cli.name),
      `volume: the client export is named "${cli && cli.name}"`);
    const hdr = cli ? cli.text.split('\n')[0].split(',') : [];
    ok(hdr.length === 18, `volume: the client CSV has ${hdr.length} headers, expected 17 + "Generated at"`);
    ok(hdr[0] === 'ClientName', `volume: the client CSV starts with "${hdr[0]}"`);
    ok(hdr[2] === 'Current Per Day Volume (GB)', `volume: client CSV column 2 is "${hdr[2]}"`);
    ok(hdr[14] === 'Current Backup storage Store upto (days)', `volume: client CSV column 14 is "${hdr[14]}"`);
    ok(hdr[16] === 'Snapshot Indices To', `volume: client CSV column 16 is "${hdr[16]}"`);
    ok(cli && cli.text.split('\n').length === config.clusters.length + 1,
      `volume: the client CSV has ${cli && cli.text.split('\n').length} lines`);

    viewBtn('Summary').click();
    await settleFor(200);
    ok(!!panel('Capacity by cluster'), 'volume: the summary view did not render');
  }
}

/* ------------------- log delay: can this cluster be analysed? ------------------- */

await go('logs');
{
  const ld = await load('core/log-delay.js');

  // The rule that makes a preflight worth having: the aggregation runs on .keyword, so
  // checking the base name would pass and the query that follows would return nothing.
  ok(ld.aggregatableName('src_hostname') === 'src_hostname.keyword', 'text field should gain .keyword');
  ok(ld.aggregatableName('tag1.keyword') === 'tag1.keyword', 'an already-keyword name must not be doubled');
  ok(ld.aggregatableName('src_ip') === 'src_ip', 'an ip-like field must not gain .keyword');
  ok(ld.aggregatableName('ClientID') === 'ClientID', 'ClientID is mapped keyword directly');
  ok(ld.aggregatableName('') === '', 'an empty field name stays empty');

  // decide() is the part with the rules in it, exercised without a cluster.
  const fields = ld.resolveFields({ timeField: '@timestamp' });
  const caps = (names) => ({ fields: Object.fromEntries(names.map((n) => [n, { keyword: {} }])) });

  let d = ld.decide(fields, caps(['src_hostname.keyword', 'ingested_time', '@timestamp']));
  ok(d.ok === true, `all three present should be analysable: ${JSON.stringify(d.missing)}`);
  ok(d.resolved.eventTime === 'ingested_time', `first available event-time wins: ${d.resolved.eventTime}`);

  d = ld.decide(fields, caps(['src_hostname.keyword', 'event_created', '@timestamp']));
  ok(d.ok === true && d.resolved.eventTime === 'event_created',
    'a later event-time candidate should be accepted');

  d = ld.decide(fields, caps(['ingested_time', '@timestamp']));
  ok(d.ok === false && d.missing.includes('src_hostname.keyword'),
    `a missing device field must refuse and name it: ${JSON.stringify(d.missing)}`);

  d = ld.decide(fields, caps(['src_hostname.keyword', '@timestamp']));
  ok(d.ok === false && d.missing.length === 3,
    `no event-time candidate should name all three: ${JSON.stringify(d.missing)}`);

  d = ld.decide(fields, caps([]));
  ok(d.ok === false, 'an empty cluster must never be analysable');
  ok(d.resolved.device === null && d.resolved.eventTime === null,
    'nothing resolved when nothing is present');

  // Metadata absence narrows the result; it must not refuse the analysis.
  const withMeta = ld.resolveFields({ delayFields: { device: 'src_hostname', eventTime: ['ingested_time'], metadata: ['tag1', 'parser_tag'] } });
  d = ld.decide(withMeta, caps(['src_hostname.keyword', 'ingested_time', '@timestamp', 'tag1.keyword']));
  ok(d.ok === true, 'a missing context field must not refuse the analysis');
  ok(d.metadataMissing.includes('parser_tag.keyword'), `absent context should be named: ${JSON.stringify(d.metadataMissing)}`);
  ok(d.resolved.metadata.includes('tag1.keyword'), 'present context should be resolved');

  // End to end against the mock, which maps a parsed-log shape.
  const st = await load('core/state.js');
  const target = config.clusters[0];
  const live = await ld.preflight(st.client(target.id), { ...target, logIndexPattern: 'logstash-*' });
  ok(live.unknown === false, `the mock should answer _field_caps: ${live.error}`);
  ok(live.ok === true, `the mock should be analysable, missing: ${JSON.stringify(live.missing)}`);
  ok(live.resolved.device === 'src_hostname.keyword', `resolved device: ${live.resolved.device}`);

  // A cluster that cannot be asked is unknown, never "no fields". Two ways to fail to
  // ask, and both must land on unknown: no client at all, and a client that throws.
  const dead = await ld.preflight(null, target);
  ok(dead.unknown === true && dead.ok === false, 'no client should be unknown, not a refusal');

  // End to end: switch to the delay view, press Fetch, read the table.
  {
    const pane = doc.getElementById('view');
    const toDelay = [...pane.querySelectorAll('button')].find((b) => b.textContent === 'Log delay');
    ok(!!toDelay, 'logs: no "Log delay" view button');
    toDelay.click();
    await settleFor(700);

    const fetchBtn = [...pane.querySelectorAll('button')].find((b) => b.textContent === 'Fetch latest details');
    ok(!!fetchBtn, `logs: no Fetch button — preflight said: ${pane.textContent.slice(0, 120)}`);
    if (fetchBtn) {
      fetchBtn.click();
      await settleFor(1400);
      const trs = [...pane.querySelectorAll('table.tbl tbody tr')];
      ok(trs.length === 6, `delay table: ${trs.length} rows, the fixture has 6 devices`);

      const byDevice = Object.fromEntries(trs.map((tr) => {
        const c = [...tr.children].map((td) => td.textContent.trim());
        return [c[0], { status: c[1], delay: c[2], pattern: c[3], means: c[6] }];
      }));
      ok(byDevice['fw-edge-01'] && byDevice['fw-edge-01'].status === 'ok', `2 min should be ok: ${JSON.stringify(byDevice['fw-edge-01'])}`);
      ok(byDevice['fw-core-02'] && byDevice['fw-core-02'].status === 'delayed', '41 min should be delayed');
      ok(byDevice['proxy-03'] && byDevice['proxy-03'].status === 'critical', '95 min should be critical');
      ok(byDevice['vpn-04'] && byDevice['vpn-04'].status === 'clock ahead',
        `-37 min must be clock ahead, not critical: ${JSON.stringify(byDevice['vpn-04'])}`);
      ok(byDevice['vpn-04'] && byDevice['vpn-04'].delay.startsWith('-'), 'a negative delay must render negative');

      // The discrimination that justifies the pattern code at all.
      ok(byDevice['router-06'] && byDevice['router-06'].pattern === 'timezone',
        `exactly 5h should read as a timezone offset: ${JSON.stringify(byDevice['router-06'])}`);
      ok(byDevice['switch-05'] && byDevice['switch-05'].pattern !== 'timezone',
        `5h30 is a queue, not an offset: ${JSON.stringify(byDevice['switch-05'])}`);

      // Worst first — a critical device at the bottom of the list is a device nobody sees.
      const first = [...trs[0].children][1].textContent.trim();
      ok(first === 'critical', `the first row should be the worst, was "${first}"`);

      // Filtering to unhealthy drops the healthy one and keeps the clock-ahead one.
      const showSel = [...pane.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'unhealthy'));
      ok(!!showSel, 'delay view: no unhealthy filter');
      if (showSel) {
        showSel.value = 'unhealthy';
        showSel.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settleFor(250);
        const after = [...pane.querySelectorAll('table.tbl tbody tr')].map((tr) => tr.children[0].textContent.trim());
        ok(!after.includes('fw-edge-01'), `the healthy device should be filtered out: ${after.join(', ')}`);
        ok(after.includes('vpn-04'), 'a clock-ahead device counts as unhealthy');
        showSel.value = 'all';
        showSel.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settleFor(200);
      }
    }
  }

  const refusing = { fieldCaps: async () => {
    const e = new Error('HTTP 503 Service Unavailable');
    e.res = { status: 503, json: { error: { reason: 'all shards failed' } } };
    throw e;
  } };
  const thrown = await ld.preflight(refusing, target);
  ok(thrown.unknown === true, 'a cluster that refuses the call is unknown, not "no fields"');
  ok(thrown.ok === false, 'unknown is never analysable');
  ok(/all shards failed/.test(thrown.error || ''),
    `the cluster's own reason should survive, got "${thrown.error}"`);
  ok(thrown.missing.length === 0,
    'an unasked cluster must not claim fields are missing — it does not know');
}

/* ------------- an alert hands over the cluster, not just the page ------------- */

{
  const { navigateTo } = await load('core/intent.js');
  const state = (await load('core/state.js')).state;
  const target = config.clusters[config.clusters.length - 1];

  await go('overview');
  state.selected = 'all';
  navigateTo('shards', null, { cluster: target.id });
  await settleFor(350);
  ok(state.selected === target.id,
    `hand-off: selected is "${state.selected}", expected "${target.id}" — the page opened on the wrong cluster`);
  ok((window.location.hash || '').includes('shards'),
    `hand-off: landed on "${window.location.hash}", expected the shards page`);

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

/* -------------------- tasks: one request, applied to many clusters -------------------- */

// Last of the crafted-state sections, and after the snapshot one, because it replaces the
// clients with stubs that answer without a network.
{
  const st = await load('core/state.js');
  const tasks = await load('core/tasks.js');
  const { DEFAULTS } = await load('core/config.js');

  const role = tasks.taskById('security-role');
  const user = tasks.taskById('security-user');
  ok(!!role && !!user, 'the role and user tasks should both exist');

  // What goes on the wire.
  const r = role.build({ name: 'log reader', cluster_privileges: 'monitor, read_ilm',
                         index_patterns: 'logstash-*, app-*', index_privileges: 'read' });
  ok(r.method === 'PUT' && r.path === '/_security/role/log%20reader',
    `role path should be escaped: ${r.method} ${r.path}`);
  ok(JSON.stringify(r.body.cluster) === JSON.stringify(['monitor', 'read_ilm']),
    `cluster privileges should split on commas: ${JSON.stringify(r.body.cluster)}`);
  ok(r.body.indices && r.body.indices[0].names.length === 2 && r.body.indices[0].privileges[0] === 'read',
    `index block: ${JSON.stringify(r.body.indices)}`);
  // An indices block with patterns but no privileges is refused by Elasticsearch, so it
  // must not be sent at all rather than sent empty.
  const noPriv = role.build({ name: 'x', index_patterns: 'a-*', index_privileges: '' });
  ok(!('indices' in noPriv.body), `an indices block with no privileges must be omitted: ${JSON.stringify(noPriv.body)}`);

  const u = user.build({ name: 'analyst', password: 'hunter2-hunter2', roles: 'log-reader, monitoring_user' });
  ok(u.path === '/_security/user/analyst' && u.body.password === 'hunter2-hunter2',
    'the user request should carry the password it was given');
  ok(u.body.roles.length === 2, `roles should split: ${JSON.stringify(u.body.roles)}`);
  ok(!('full_name' in u.body), 'an empty optional field should be left out entirely');

  // The credential never reaches anything that displays.
  const shown = tasks.preview(user, { name: 'analyst', password: 'hunter2-hunter2', roles: 'r' });
  ok(shown.body.password === '••••••••', `preview must redact the password, got "${shown.body.password}"`);
  ok(!JSON.stringify(shown).includes('hunter2'), `the password leaked into the preview: ${JSON.stringify(shown)}`);

  ok(tasks.missingFields(user, { name: 'a' }).length === 2,
    'a user with no password and no roles is missing two required fields');
  ok(tasks.missingFields(role, { name: 'a' }).length === 0, 'a role only requires a name');

  // Running it. Stub clients, so nothing reaches a cluster.
  const sent = [];
  const stub = (id, behaviour) => [id, {
    request: async (method, path, body, opts) => {
      sent.push({ id, method, path, body, allowWrites: opts && opts.allowWrites });
      if (behaviour === 'throw') throw new Error('connection reset');
      if (behaviour === 'refuse') return { ok: false, status: 403, message: 'action not permitted' };
      return { ok: true, status: 200 };
    },
  }];
  st.state.defaults = { ...DEFAULTS, readOnly: true };
  st.state.config = { clusters: [] };
  st.state.clients = new Map([stub('a', 'ok'), stub('b', 'refuse'), stub('c', 'throw'), stub('d', 'ok')]);

  // The pages rendered above may have left the session unlocked, which would make the
  // next assertion pass for the wrong reason. Put the switch back and check it landed.
  const writes = await load('core/writes.js');
  await writes.setWritesUnlocked(false, { confirmFirst: false });
  ok(writes.writesAllowed() === false,
    'the premise of the next check is a locked session, and it is not locked');

  // Locked means locked: nothing is sent at all.
  let threw = null;
  try { await tasks.runTask(role, { name: 'x' }, ['a']); } catch (e) { threw = e; }
  ok(threw && /locked/.test(threw.message), `a locked session must refuse before sending: ${threw && threw.message}`);
  ok(sent.length === 0, `nothing should have been sent while locked, ${sent.length} was`);

  st.state.defaults = { ...DEFAULTS, readOnly: false };   // config allows writes
  const res = await tasks.runTask(role, { name: 'log-reader', cluster_privileges: 'monitor' },
    ['a', 'b', 'c', 'd']);
  ok(res.length === 4, `every cluster should get a result, got ${res.length}`);
  ok(res[0].ok === true && res[3].ok === true,
    'a cluster refusing must not stop the ones after it');
  ok(res[1].ok === false && /not permitted/.test(res[1].message), `refusal: ${JSON.stringify(res[1])}`);
  ok(res[2].ok === false && /connection reset/.test(res[2].message), `thrown error: ${JSON.stringify(res[2])}`);
  ok(sent.length === 4 && sent.every((x) => x.allowWrites === true),
    'every task request must carry allowWrites');

  // A missing field is refused before anything is sent, not halfway through.
  sent.length = 0;
  threw = null;
  try { await tasks.runTask(user, { name: 'a' }, ['a', 'd']); } catch (e) { threw = e; }
  ok(threw && /fill in/.test(threw.message), `incomplete task: ${threw && threw.message}`);
  ok(sent.length === 0, `an incomplete task must send nothing, sent ${sent.length}`);
}

/* ------------------------ new alerts announce themselves ------------------------ */

// After the snapshot section, which leaves crafted state behind that this one reuses.
{
  const notify = await load('core/notify.js');
  const st = await load('core/state.js');
  const { DEFAULTS } = await load('core/config.js');
  const said = [];
  const spy = (msg, kind) => said.push({ msg, kind });

  // Its own state: the task section above emptied state.config to run against stubs, and
  // alerts() walks the configured clusters — with none, there is nothing to announce and
  // this would pass by having nothing to say.
  st.state.defaults = { ...DEFAULTS };
  st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
  st.state.selected = 'all';
  st.state.clients = new Map([['c1', { state: 'online' }]]);
  // Something is ALREADY wrong before the first pass. That is the whole point of the
  // baseline rule, and a clean start would let a notifier that announces everything it
  // sees pass this by having nothing to see.
  st.state.data = new Map([['c1', {
    reachable: true, health: { status: 'green' }, slm: [],
    repos: [{ name: 'already-broken', error: 'was broken before you opened the app' }],
    snapshots: { 'already-broken': [] },
  }]]);
  ok(st.alerts().length === 1,
    `the baseline needs exactly one pre-existing alert to be a real test, has ${st.alerts().length}`);

  // The first pass is a baseline: whatever is already wrong is a state, not news.
  notify.resetAnnounced();
  const first = notify.announceNewAlerts({ notify: spy });
  ok(first.length === 0 && said.length === 0,
    `the first pass must announce nothing even though an alert is open, announced ${said.length}`);

  // Nothing changed, so nothing is new — even though alerts() rebuilds the same list.
  notify.announceNewAlerts({ notify: spy });
  ok(said.length === 0, `an unchanged alert must not be announced again, got ${said.length}`);

  // Break a second repository: one NEW alert beside the one that was already there.
  const d = st.state.data.get('c1');
  d.repos = [{ name: 'already-broken', error: 'was broken before you opened the app' },
             { name: 'daily', error: 'connect timed out' }];
  d.snapshots = { 'already-broken': [], daily: [] };
  const fresh = notify.announceNewAlerts({ notify: spy });
  ok(fresh.length === 1, `a newly broken repository should announce once, announced ${fresh.length}`);
  ok(said.length === 1 && /daily/.test(said[0].msg), `announcement text: ${JSON.stringify(said)}`);

  said.length = 0;
  notify.announceNewAlerts({ notify: spy });
  ok(said.length === 0, 'the same alert must not be announced on the next refresh');

  // Many at once collapse to one line rather than burying the screen.
  d.repos = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: n, error: 'gone' }));
  d.snapshots = {};
  said.length = 0;
  notify.announceNewAlerts({ notify: spy });
  ok(said.length === 1 && /5 new alerts/.test(said[0].msg),
    `five at once should collapse to one summary, got ${JSON.stringify(said)}`);
}

/* -------------- accounts keeps the two kinds of user apart -------------- */

// Rendered directly rather than navigated to: the page is admin-only, and go() correctly
// refuses it for a session without that role — which would leave this checking Alerts.
{
  const accounts = await load('pages/accounts.js');
  const pane = doc.getElementById('view');
  while (pane.firstChild) pane.removeChild(pane.firstChild);
  accounts.render(pane);
  await settleFor(500);

  const titles = [...pane.querySelectorAll('section.card header h2')].map((x) => x.textContent);
  ok(titles.includes('ElasticVue users'),
    `accounts: no "ElasticVue users" card, saw ${titles.join(' | ')}`);
  ok(titles.includes('Cluster users'),
    `accounts: no "Cluster users" card, saw ${titles.join(' | ')}`);
  // The two must not be merged back into one "Accounts" table: an app login and a cluster
  // login are different credentials and one list implies they are not.
  ok(!titles.includes('Accounts'),
    'accounts: the generic "Accounts" card is back — the two kinds of user are merged again');
  ok([...pane.querySelectorAll('button')].some((b) => b.textContent === '+ Create'),
    'accounts: no "+ Create" button on the cluster users card');

  // The three are told apart by labelled bands: app credentials above, cluster ones below.
  const bands = [...pane.querySelectorAll('h3')].map((x) => x.textContent);
  ok(bands.includes('On this installation'), `accounts: no installation band, saw ${bands.join(' | ')}`);
  ok(bands.includes('On the clusters'), `accounts: no cluster band, saw ${bands.join(' | ')}`);
}

/* ------- a cluster with security off says so, not "HTTP 500" ------- */

{
  const cuMod = await load('ui/cluster-users.js');
  const st = await load('core/state.js');
  const err = (reason) => {
    const e = new Error('HTTP 500 Internal Server Error');
    e.res = { status: 500, json: { error: { reason } } };
    return e;
  };
  st.state.clients = new Map([['x', { securityUsers: async () => { throw err(
    'Security must be explicitly enabled when using a [basic] license. Enable security by '
    + 'setting [xpack.security.enabled] to [true] in the elasticsearch.yml file and restart the node.'); } }]]);
  let r = await cuMod.fetchClusterUsers('x');
  ok(/switched off/.test(r.error), `security-off should be named, got "${r.error}"`);
  ok(!/500/.test(r.error), `the status line must not be the message: "${r.error}"`);
  ok(/xpack\.security\.enabled/.test(r.fix || ''), `the fix should name the setting, got "${r.fix}"`);

  st.state.clients = new Map([['x', { securityUsers: async () => { throw err('no handler found for uri [/_security/user]'); } }]]);
  r = await cuMod.fetchClusterUsers('x');
  ok(/no security API/.test(r.error), `an OSS build should be named, got "${r.error}"`);

  st.state.clients = new Map([['x', { securityUsers: async () => { throw err('security_exception: action unauthorized'); } }]]);
  r = await cuMod.fetchClusterUsers('x');
  ok(/may not read/.test(r.error), `a privilege problem should be named, got "${r.error}"`);
}

/* ------------- the create dialog asks for what the kind needs ------------- */

{
  const tasks = await load('core/tasks.js');
  const byId = (id) => tasks.taskById(id);
  const names = (t) => t.fields.map((f) => f.name);

  ok(byId('security-api-key'), 'there should be an API key task');
  ok(!names(byId('security-role')).includes('password'),
    'a role must not ask for a password');
  ok(names(byId('security-user')).includes('password'),
    'a user must ask for a password');
  ok(!names(byId('security-api-key')).includes('password'),
    'an API key must not ask for a password');
  ok(names(byId('security-api-key')).includes('expiration'),
    'an API key should offer an expiry');

  // The screenshot bug: an untyped form previewed as PUT /_security/user/undefined.
  const shown = tasks.preview(byId('security-user'), {});
  ok(!/undefined/.test(shown.path), `an empty form still previews "undefined": ${shown.path}`);
  ok(shown.path.endsWith('…'), `an empty name should preview as a placeholder: ${shown.path}`);

  // An API key comes back in the response and nowhere else, so the runner keeps it.
  const key = byId('security-api-key');
  ok(typeof key.keep === 'function', 'the API key task must keep the key from the response');
  ok(key.keep({ value: { encoded: 'abc', id: '1' } }).encoded === 'abc',
    'keep() should lift the encoded key out of the response');
  ok(key.keep({ value: {} }) === null, 'keep() should return null when there is no key');
  const noRoles = key.build({ name: 'k' });
  ok(!('role_descriptors' in noRoles.body),
    `no roles means inherit the caller's, so the descriptor block is omitted: ${JSON.stringify(noRoles.body)}`);
}

/* --------------- the master and the disk that nothing accounts for --------------- */

{
  const st = await load('core/state.js');
  const { DEFAULTS } = await load('core/config.js');
  const base = (nodes, extra = {}) => {
    st.state.defaults = { ...DEFAULTS };
    st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
    st.state.selected = 'all';
    st.state.clients = new Map([['c1', { state: 'online' }]]);
    st.state.indices = new Map();
    st.state.data = new Map([['c1', {
      reachable: true, health: { status: 'green' }, slm: [], repos: [], snapshots: {},
      nodes, master: (nodes.find((n) => n.master === '*') || {}).name || null, ...extra,
    }]]);
  };
  const keys = () => st.alerts().map((a) => a.key);

  // No master at all is critical.
  base([{ name: 'n1', master: '-' }, { name: 'n2', master: '-' }]);
  ok(keys().includes('c1:no-master'), `a cluster with no master should be critical: ${keys().join(', ')}`);
  ok(st.alerts().find((a) => a.key === 'c1:no-master').level === 'critical', 'no-master must be critical');

  // A master that has always been this one is not news.
  base([{ name: 'n1', master: '*' }, { name: 'n2', master: '-' }]);
  ok(!keys().some((k) => k.startsWith('c1:master-changed')),
    `a steady master should raise nothing: ${keys().join(', ')}`);

  // One that just moved is.
  base([{ name: 'n2', master: '*' }, { name: 'n1', master: '-' }],
    { masterChangedFrom: 'n1', masterChangedAt: Date.now() - 60000 });
  const moved = st.alerts().find((a) => a.key.startsWith('c1:master-changed'));
  ok(!!moved && moved.level === 'critical', `a master election should be critical: ${keys().join(', ')}`);
  ok(moved && /from n1 to n2/.test(moved.title), `the alert should name both: ${moved && moved.title}`);

  // And one that moved a week ago is history, not an alert.
  base([{ name: 'n2', master: '*' }],
    { masterChangedFrom: 'n1', masterChangedAt: Date.now() - 8 * 86400000 });
  ok(!keys().some((k) => k.startsWith('c1:master-changed')),
    'an election from last week should have aged out');

  // Disk Elasticsearch holds against disk the indices explain.
  base([{ name: 'n1', master: '*' }], { disk: { indicesBytes: 100 * 1024 ** 3, nodes: [] } });
  st.state.indices.set('c1', [{ index: 'a', size: 30 * 1024 ** 3 }]);
  const gap = st.alerts().find((a) => a.key === 'c1:disk-unaccounted');
  ok(!!gap, `a 70 GB gap should be reported: ${keys().join(', ')}`);
  ok(gap && /not accounted for/.test(gap.title), `gap title: ${gap && gap.title}`);

  // Agreeing closely is the normal case and says nothing.
  st.state.indices.set('c1', [{ index: 'a', size: 99 * 1024 ** 3 }]);
  ok(!keys().includes('c1:disk-unaccounted'), 'a 1% difference is not worth an alert');

  // No index list means unknown, not "all of it is unaccounted for".
  st.state.indices = new Map();
  ok(!keys().includes('c1:disk-unaccounted'),
    'without an index list the gap is unknown and must not be reported as the whole of it');
}

/* ------------------------------------ verdict ------------------------------------ */

restoreConsole();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('ok: strip, console, shards, volume, hand-off, refresh, snapshots, tasks, toasts, accounts split and the log-delay preflight');
// The pages leave auto-refresh timers and a live tail running; nothing here waits on them.
process.exit(0);
