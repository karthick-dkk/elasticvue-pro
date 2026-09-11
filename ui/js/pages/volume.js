/** Page — capacity: what each cluster ingests per day, and whether its storage matches
 *  the retention it promises. Exportable for the whole fleet. */

import { h, mount, $ } from '../lib/dom.js';
import { bytes, num, ago, dt, toCsv, download } from '../lib/fmt.js';
import { state, clusters, activeClusters, client, refreshAll, fetchIndices } from '../core/state.js';
import { card, collapsible, pill, statTile, table, empty } from './common.js';
import { hbarList, capacityChart, usageMeter } from '../lib/charts.js';
import { volumeReport, reportRows, SHEET_COLUMNS, sheetCell, gb, days as fmtDays, yesNo } from '../core/volume.js';
import { navigateTo } from '../core/intent.js';

let host = null;
const ui = { measuring: new Set(), view: 'sheet', sort: 'name', dir: 1 };
/** Measured repository sizes, per cluster. Elasticsearch does not report this cheaply. */
const repoBytes = new Map();

export function render(el) {
  host = el;
  el.classList.add('dense');
  ensureIndices();
  draw();
}
export function onData() { if (host && host.isConnected) draw(); }

/** The report needs the index list, which only the Indices page fetches otherwise. */
async function ensureIndices() {
  for (const c of activeClusters()) {
    if (state.indices.get(c.id)) continue;
    try { await fetchIndices(c.id, '*'); } catch (_) { /* the row will say it has no data */ }
  }
  draw();
}

function reportFor(c) {
  return volumeReport(c, state.data.get(c.id) || {}, state.indices.get(c.id) || [],
    repoBytes.has(c.id) ? repoBytes.get(c.id) : null);
}

function draw() {
  const list = activeClusters();
  if (!list.length) return mount(host, empty('No cluster selected'));
  const reports = list.map(reportFor);

  const totalPerDay = reports.reduce((s, r) => s + r.perDayGB, 0);
  const totalLive = reports.reduce((s, r) => s + r.liveTotalGB, 0);
  const shortest = reports.filter((r) => r.liveSufficientDays !== null)
    .sort((a, b) => a.liveSufficientDays - b.liveSufficientDays)[0];
  const failing = reports.filter((r) => r.liveRetentionMet === false).length;

  mount(host,
    h('div.grid.c4', { style: { marginBottom: '10px' } },
      statTile('Fleet ingest', `${totalPerDay.toFixed(1)} GB`, 'per day, all clusters'),
      statTile('Live storage', `${totalLive.toFixed(0)} GB`, `${num(list.length)} clusters`),
      statTile('Runs out first', shortest ? `${Math.floor(shortest.liveSufficientDays)} d` : '–',
        shortest ? shortest.cluster.name : 'no disk data'),
      statTile('Retention at risk', String(failing),
        failing ? 'cluster(s) cannot hold their policy' : 'all within policy')),

    h('div.toolbar',
      h('span.muted', { style: { fontSize: '11.5px' } },
        `updated ${ago(state.lastRefresh)} · per-day volume from the dated indices, today excluded`),
      h('label.field', 'View', (() => {
        const sel = h('select', { onchange: (e) => { ui.view = e.target.value; draw(); } },
          h('option', { value: 'sheet' }, 'Spreadsheet — one row per cluster'),
          h('option', { value: 'summary' }, 'Summary table'));
        sel.value = ui.view; return sel;
      })()),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
        h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, '↻ Refresh'),
        h('button.btn.sm.primary', {
          title: 'One row per cluster, every parameter as a column — the shape a spreadsheet wants',
          onclick: () => exportWide(reports),
        }, 'Export CSV'),
        h('button.btn.sm', {
          title: 'One row per parameter, a column per cluster — the report as it reads on screen',
          onclick: () => exportTall(reports),
        }, 'Export as report layout'))),

    ui.view === 'sheet' ? sheetView(reports) : fleetTable(reports),

    h('div.grid.c2', { style: { marginTop: '10px' } },
      collapsible('Daily volume by cluster', 'the figure every other number is built on',
        () => volumeChart(reports), { key: 'vol-chart', open: true }),
      collapsible('How long the free disk lasts', 'at each cluster\'s current daily rate',
        () => runwayChart(reports), { key: 'vol-runway', open: true })),

    h('div', { style: { marginTop: '10px' } },
      collapsible('Disk in use across the fleet', 'used against total, per cluster',
        () => usageList(reports), { key: 'vol-usage', open: true })),

    ...reports.map((r) => h('div', { style: { marginTop: '10px' } },
      collapsible(`Volume resource report — ${r.cluster.name}`, r.cluster.url,
        () => clusterCardBody(r), { key: `vol-detail-${r.cluster.id}`, open: reports.length === 1 }))));
}

/* ------------------------------- fleet overview ------------------------------- */

function fleetTable(reports) {
  const trs = reports.map((r) => {
    const risk = r.liveRetentionMet === false ? 'red'
      : r.liveSufficientDays !== null && r.liveSufficientDays < 14 ? 'yellow' : 'green';
    return h('tr',
      h('td', h('div', { style: { fontWeight: 640 } }, r.cluster.name),
        h('div.mono.muted', { style: { fontSize: '10.5px' } }, r.cluster.url)),
      h('td.num', gb(r.perDayGB)),
      h('td.num', gb(r.bufferedGB)),
      h('td.num', gb(r.liveTotalGB)),
      h('td.num', r.livePct === null ? '–' : `${r.livePct.toFixed(1)}%`),
      h('td.num', h('span', { style: { color: risk === 'red' ? 'var(--critical)' : risk === 'yellow' ? 'var(--warning)' : 'inherit' } },
        fmtDays(r.liveSufficientDays))),
      h('td', r.liveRetention ? r.liveRetention.label : h('span.muted', 'not set')),
      h('td', r.liveRetentionMet === null ? h('span.muted', 'unknown')
        : pill(yesNo(r.liveRetentionMet), r.liveRetentionMet ? 'green' : 'red')),
      h('td.num', r.repoGB === null ? h('span.muted', 'not measured') : gb(r.repoGB)),
      h('td', r.snapshotRetention ? r.snapshotRetention.label : h('span.muted', 'not set')));
  });
  return card('Capacity by cluster', `${reports.length} cluster${reports.length === 1 ? '' : 's'}`,
    table(['Cluster', 'Per day', '+30%', 'Live total', 'Used', 'Lasts', 'Live policy', 'Within policy', 'Repo size', 'Snapshot policy'],
      trs, { emptyText: 'No clusters' }));
}

/**
 * How long the free disk lasts, per cluster.
 *
 * The most actionable number on the page: it says which cluster needs attention first,
 * and roughly when. Coloured against the same thresholds the alerts use.
 */
function runwayChart(reports) {
  const items = reports
    .filter((r) => r.liveSufficientDays !== null && isFinite(r.liveSufficientDays))
    .map((r) => ({
      key: r.cluster.id, label: r.cluster.name, value: Math.floor(r.liveSufficientDays),
      color: r.liveSufficientDays < 14 ? 'var(--critical)'
        : r.liveSufficientDays < 45 ? 'var(--warning)' : 'var(--good)',
      sub: `${gb(r.liveFreeGB)} free at ${gb(r.perDayGB)}/day`,
    }));
  return items.length
    ? h('div', hbarList(items, { format: (v) => `${v} days`, topN: 20, labelWidth: 150, showOther: false }),
        legendFor([['var(--critical)', 'under 2 weeks'], ['var(--warning)', 'under 6 weeks'], ['var(--good)', 'comfortable']]))
    : empty('No disk figures yet — the clusters have not reported allocation.');
}

/** Used against total for every cluster, so a full one stands out without reading digits. */
function usageList(reports) {
  const withDisk = reports.filter((r) => r.liveTotalGB > 0);
  if (!withDisk.length) return empty('No disk figures yet.');
  return h('div', { style: { display: 'grid', gap: '10px' } },
    ...withDisk.map((r) => h('div', { style: { display: 'grid', gap: '3px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
        h('b', r.cluster.name),
        h('span.muted', `${gb(r.liveUsedGB)} of ${gb(r.liveTotalGB)} · ${gb(r.liveFreeGB)} free`)),
      usageMeter(r.liveUsedGB, r.liveTotalGB, { label: '', thick: true,
        warn: state.defaults.diskWarnPercent, crit: state.defaults.diskCritPercent }))));
}

function legendFor(pairs) {
  return h('div.legend', ...pairs.map(([color, label]) => h('span', h('i', { style: { background: color } }), label)));
}

/**
 * Everything the cluster's disk has to hold, against the disk it has. The capacity marker
 * is the total; a bar past it is the amount of disk that would have to be bought.
 */
function liveFitChart(r) {
  if (!(r.liveTotalGB > 0)) return empty('No allocation data for this cluster.');
  const needs = [
    { label: 'Used right now', value: r.liveUsedGB, sub: 'what the indices occupy today' },
    r.requiredLiveGB
      ? { label: `Retention policy (${r.liveRetention.label})`, value: r.requiredLiveGB,
          sub: 'the stated policy at the buffered daily rate' }
      : null,
    { label: '30 days of logs', value: r.required30GB, sub: 'at the buffered daily rate' },
    { label: '90 days of logs', value: r.required90GB, sub: 'at the buffered daily rate' },
  ].filter(Boolean);
  return capacityChart({ value: r.liveTotalGB, label: 'disk on this cluster' }, needs, { format: gb, labelWidth: 190 });
}

/**
 * The same question for the repository. Its size is only known once measured, so until
 * then the bars are drawn without a capacity line rather than against a guess.
 */
function backupFitChart(r) {
  const needs = [
    r.repoGB === null ? null : { label: 'Held in the repository now', value: r.repoGB, sub: 'sum of incremental snapshot bytes' },
    r.snapshotRetention
      ? { label: `Retention policy (${r.snapshotRetention.label})`, value: r.bufferedGB * r.snapshotRetention.days,
          sub: 'upper bound — snapshots are incremental and usually smaller' }
      : null,
    { label: '365 days of backups', value: r.required365GB, sub: 'upper bound — snapshots are incremental' },
  ].filter(Boolean);
  if (!needs.length) return empty('Nothing to compare yet.');
  return capacityChart(
    { value: r.repoGB || 0, label: 'held in the repository now' },
    needs,
    { format: gb, labelWidth: 190, capacityUnknown: r.repoGB === null });
}

function volumeChart(reports) {
  const items = reports.filter((r) => r.perDayGB > 0).map((r) => ({
    key: r.cluster.id, label: r.cluster.name, value: r.perDayGB,
    sub: `${r.vol.basis} · ${r.vol.daysCovered} days of data`,
  }));
  return items.length
    ? hbarList(items, { format: (v) => `${v.toFixed(1)} GB`, topN: 20, labelWidth: 160 })
    : empty('No dated indices found — the volume report needs indices with a date in the name.');
}

/* ------------------------------- per cluster ---------------------------------- */

function clusterCardBody(r) {
  const c = r.cluster;
  const rows = reportRows(r).map(([label, value, note]) => h('tr',
    h('td', { style: { width: '46%' } }, label),
    h('td', { style: { fontWeight: 620, fontVariantNumeric: 'tabular-nums' } }, String(value)),
    h('td.muted', { style: { fontSize: '11px' } }, note || '')));

  const measuring = ui.measuring.has(c.id);
  const repos = (state.data.get(c.id) || {}).repos || [];

  return h('div', { style: { display: 'grid', gap: '10px' } },
    r.vol.daysCovered === 0
      ? h('div.banner.warn', { style: { margin: 0 } },
          h('div', h('div.ttl', 'No dated indices'),
            h('div', 'Per-day volume is measured from indices whose name carries a date. This cluster has none ' +
                     'that match the pattern, so every figure derived from it is 0. Check indexNameRegex for this cluster.')))
      : null,

    // The comparison the table makes you do in your head, drawn.
    h('div.grid.c2',
      card('Will the logs fit on disk?', 'each requirement against the disk this cluster has',
        liveFitChart(r)),
      card('Will the backups fit?', r.repoGB === null ? 'repository size not measured yet' : 'against what the repository holds now',
        backupFitChart(r))),

    h('div.tbl-wrap', h('table.tbl', h('tbody', ...rows))),
    h('div', { style: { display: 'flex', gap: '6px', paddingTop: '4px' } },
      h('button.btn.sm', {
        disabled: measuring || !repos.length,
        title: repos.length ? 'Sum the incremental bytes of every snapshot — one call per snapshot'
                            : 'No repository registered on this cluster',
        onclick: () => measureRepos(c),
      }, measuring ? 'Measuring…' : r.repoGB === null ? 'Measure repo size' : 'Re-measure'),
      h('button.btn.sm', { onclick: () => exportWide([r]) }, 'Export this cluster'),
      h('button.btn.sm.ghost', { onclick: () => navigateTo('indices') }, 'Indices')));
}

/* ------------------------------ spreadsheet view ------------------------------ */

/**
 * One row per cluster, every parameter a column — read like a spreadsheet, with the
 * cluster column and the header pinned so a wide row stays identifiable while scrolling.
 * Column headers sort; YES/NO is coloured because that is what the eye goes to.
 */
function sheetView(reports) {
  const col = SHEET_COLUMNS;
  const sorted = [...reports].sort((a, b) => {
    const c = col.find((x) => x.label === ui.sort) || col[0];
    const av = c.get(a), bv = c.get(b);
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * ui.dir;
    return String(av).localeCompare(String(bv)) * ui.dir;
  });

  // A banded row above the header naming what each block of columns is about.
  const groups = [];
  for (const c of col) {
    const last = groups[groups.length - 1];
    if (last && last.name === c.group) last.span++;
    else groups.push({ name: c.group, span: 1 });
  }

  // The frozen column is the first COLUMN, but the first group spans three of them.
  // Pinning the whole group cell froze all three, so the band sat still while the
  // columns under it scrolled. The band is split: one pinned cell exactly as wide as
  // the frozen column, and the rest of that group scrolling with everything else.
  const groupCells = [];
  groups.forEach((g, gi) => {
    if (gi > 0) { groupCells.push(h('th', { colspan: g.span }, g.name)); return; }
    groupCells.push(h('th.stick', { colspan: 1 }, g.name));
    if (g.span > 1) groupCells.push(h('th', { colspan: g.span - 1 }));
  });

  const head = h('thead',
    h('tr.group-head', ...groupCells),
    h('tr', ...col.map((c, i) => h('th', {
      class: i === 0 ? 'stick' : '',
      style: { cursor: 'pointer' },
      title: 'Sort by this column',
      onclick: () => { ui.dir = ui.sort === c.label ? -ui.dir : 1; ui.sort = c.label; draw(); },
    }, c.label + (ui.sort === c.label ? (ui.dir === 1 ? ' ▲' : ' ▼') : ''),
       c.unit ? h('span.unit', c.unit) : null))));

  const body = h('tbody', ...sorted.map((r) => h('tr', ...col.map((c, i) => {
    const text = sheetCell(c, r);
    const cls = [i === 0 ? 'stick' : '', c.kind === 'num' ? 'num' : '',
                 c.kind === 'bool' ? (text === 'YES' ? 'yes' : text === 'NO' ? 'no' : 'unknown') : '']
      .filter(Boolean).join('.');
    // The explanation the card shows beside the value is the grid's hover text.
    const tip = (c.note && c.note(r)) || (text.length > 24 ? text : null);
    return h(cls ? `td.${cls}` : 'td', { title: tip }, text);
  }))));

  return card('Volume resource report', `${reports.length} cluster${reports.length === 1 ? '' : 's'} · one row each · click a header to sort`,
    h('div.sheet-wrap', h('table.sheet', head, body)),
    [h('button.btn.sm.primary', { onclick: () => exportWide(reports) }, 'Export CSV')]);
}

/**
 * Repository size is not a number Elasticsearch reports. The closest honest answer is the
 * sum of each snapshot's INCREMENTAL bytes, which is what the repository actually holds —
 * one _status call per snapshot, so it stays behind a button and is capped.
 */
async function measureRepos(c) {
  const cl = client(c.id);
  const d = state.data.get(c.id) || {};
  ui.measuring.add(c.id); draw();
  let total = 0, failed = 0, counted = 0;
  const CAP = 60;
  try {
    for (const repo of d.repos || []) {
      const snaps = ((d.snapshots || {})[repo.name] || []).slice(0, CAP);
      for (const s of snaps) {
        try {
          const st = await cl.snapshotStatus(repo.name, s.id);
          const one = (st.snapshots || [])[0];
          total += (one && one.stats && one.stats.incremental && one.stats.incremental.size_in_bytes) || 0;
          counted++;
        } catch (_) { failed++; }
      }
    }
    repoBytes.set(c.id, total);
  } finally {
    ui.measuring.delete(c.id);
    draw();
  }
  if (failed) {
    // Say so rather than presenting a short total as if it were complete.
    const el = $('#vol-msg');
    if (el) mount(el, h('div.banner.warn', `${c.name}: ${counted} snapshot(s) measured, ${failed} could not be read.`));
  }
}

/* ---------------------------------- export ------------------------------------ */

/** The report layout: one row per parameter, a column per cluster — what the table shows. */
function exportTall(reports) {
  const labels = reportRows(reports[0]).map(([l]) => l);
  const cols = reports.map((r) => {
    const m = new Map(reportRows(r).map(([l, v]) => [l, v]));
    return { name: r.cluster.name, get: (l) => m.get(l) };
  });
  const rows = labels.map((label) => {
    const out = { Parameter: label };
    for (const c of cols) out[c.name] = String(c.get(label) ?? '');
    return out;
  });
  const stamp = new Date().toISOString().slice(0, 10);
  download(`volume-resource-report-by-parameter-${stamp}.csv`, toCsv(rows), 'text/csv');
}

/**
 * One row per cluster, one column per parameter — sortable and chartable in a
 * spreadsheet, and the default export.
 */
function exportWide(reports) {
  // Same column definitions the grid uses, so the file and the screen cannot diverge.
  const rows = reports.map((r) => {
    const o = {};
    for (const c of SHEET_COLUMNS) {
      o[c.unit ? `${c.group} — ${c.label} (${c.unit})` : `${c.group} — ${c.label}`] = sheetCell(c, r);
    }
    o['Generated at'] = new Date().toISOString();
    return o;
  });
  const stamp = new Date().toISOString().slice(0, 10);
  download(`volume-resource-report-${stamp}.csv`, toCsv(rows), 'text/csv');
}
