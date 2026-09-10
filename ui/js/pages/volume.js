/** Page — capacity: what each cluster ingests per day, and whether its storage matches
 *  the retention it promises. Exportable for the whole fleet. */

import { h, mount, $ } from '../lib/dom.js';
import { bytes, num, ago, dt, toCsv, download } from '../lib/fmt.js';
import { state, clusters, activeClusters, client, refreshAll, fetchIndices } from '../core/state.js';
import { card, collapsible, pill, statTile, table, empty } from './common.js';
import { hbarList } from '../lib/charts.js';
import { volumeReport, reportRows, dailyVolume, bytesToGB, gb, days as fmtDays, yesNo } from '../core/volume.js';
import { navigateTo } from '../core/intent.js';

let host = null;
const ui = { measuring: new Set() };
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
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
        h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, '↻ Refresh'),
        h('button.btn.sm', { onclick: () => exportWide(reports) }, 'Export CSV (one row per cluster)'),
        h('button.btn.sm.primary', { onclick: () => exportTall(reports) }, 'Export CSV (report layout)'))),

    fleetTable(reports),

    h('div', { style: { marginTop: '10px' } },
      collapsible('Daily volume by cluster', 'the figure each report is built on',
        () => volumeChart(reports), { key: 'vol-chart', open: true })),

    ...reports.map((r) => h('div', { style: { marginTop: '10px' } }, clusterCard(r))));
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

function clusterCard(r) {
  const c = r.cluster;
  const rows = reportRows(r).map(([label, value, note]) => h('tr',
    h('td', { style: { width: '46%' } }, label),
    h('td', { style: { fontWeight: 620, fontVariantNumeric: 'tabular-nums' } }, String(value)),
    h('td.muted', { style: { fontSize: '11px' } }, note || '')));

  const measuring = ui.measuring.has(c.id);
  const repos = (state.data.get(c.id) || {}).repos || [];

  return card(`Volume resource report — ${c.name}`, c.url,
    h('div', { style: { display: 'grid', gap: '8px' } },
      r.vol.daysCovered === 0
        ? h('div.banner.warn', { style: { margin: 0 } },
            h('div', h('div.ttl', 'No dated indices'),
              h('div', 'Per-day volume is measured from indices whose name carries a date. This cluster has none ' +
                       'that match the pattern, so every figure derived from it is 0. Check indexNameRegex for this cluster.')))
        : null,
      h('div.tbl-wrap', h('table.tbl', h('tbody', ...rows)))),
    [
      h('button.btn.sm', {
        disabled: measuring || !repos.length,
        title: repos.length ? 'Sum the incremental bytes of every snapshot — one call per snapshot'
                            : 'No repository registered on this cluster',
        onclick: () => measureRepos(c),
      }, measuring ? 'Measuring…' : r.repoGB === null ? 'Measure repo size' : 'Re-measure'),
      h('button.btn.sm', { onclick: () => exportTall([r]) }, 'Export this cluster'),
      h('button.btn.sm.ghost', { onclick: () => navigateTo('indices') }, 'Indices'),
    ]);
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
  download(`volume-resource-report-${stamp}.csv`, toCsv(rows), 'text/csv');
}

/** One row per cluster — the shape a spreadsheet wants for sorting and charting. */
function exportWide(reports) {
  const rows = reports.map((r) => {
    const o = {};
    for (const [label, value] of reportRows(r)) o[label] = String(value ?? '');
    o['Per day volume basis'] = r.vol.basis;
    o['Days of data sampled'] = r.vol.daysCovered;
    o['Generated at'] = new Date().toISOString();
    return o;
  });
  const stamp = new Date().toISOString().slice(0, 10);
  download(`volume-resource-report-wide-${stamp}.csv`, toCsv(rows), 'text/csv');
}
