/**
 * Page — live indices, with a source picker driven by the index naming pattern.
 *
 * "Source" is the tenant inside an index name (logstash-<source>-YYYY.MM.DD). It is NOT
 * a client: in this app a client is a whole cluster with its own Elasticsearch URL, and
 * one cluster holds many sources.
 */

import { h, mount, $, clear } from '../lib/dom.js';
import { bytes, num, compact, dt, ago, toCsv, download } from '../lib/fmt.js';
import { state, client, fetchIndices, activeClusters } from '../core/state.js';
import { hbarList } from '../lib/charts.js';
import { card, collapsible, pill, statTile, table, empty, connectionBanner } from './common.js';
import { navigateTo } from '../core/intent.js';
import { syncWrites, writeToggle } from '../core/writes.js';
import {
  openIndices, closeIndices, deleteIndices, moveShardDialog, indexSettingsDialog,
  maintenance, MAINTENANCE_KINDS,
} from '../ui/index-actions.js';
import { rowMenu, ICON, closeMenus } from '../ui/menu.js';
import { fetchFieldVolume, storeFieldVolume, fieldVolumeFor, SPIKE_WINDOW_DAYS, SPIKE_THRESHOLD }
  from '../core/field-volume.js';
import { timeHistogram } from '../lib/charts.js';

let host = null;
const ui = { sourceFilter: 'all', text: '', status: 'all', sort: 'size', dir: -1, limit: 300, from: '', to: '', loading: false, error: null };
/** Index names ticked in the table, for the bulk actions. Cleared when the data reloads. */
const selected = new Set();
/** Volume-analysis UI state: which field, how far back, and whether a run is in flight. */
const va = { field: null, days: 14, topN: 12, running: false, error: null, byTerm: null, selectedTerm: null };

export function render(el) {
  host = el;
  el.classList.add('dense');   // long tables: fit more on one screen
  selected.clear();
  syncWrites().then(draw).catch(() => {});
  draw();
  load();
}
export function onData() { if (host && host.isConnected) draw(); }

function cluster() { return activeClusters()[0] || null; }

async function load(force) {
  const c = cluster();
  if (!c) return;
  if (!force && state.indices.get(c.id)) { draw(); return; }
  ui.loading = true; ui.error = null; draw();
  try { await fetchIndices(c.id, '*'); selected.clear(); }
  catch (e) { ui.error = e.message; }
  ui.loading = false; draw();
}

function rowsFor(c) {
  let rows = state.indices.get(c.id) || [];
  if (ui.sourceFilter === '__none') rows = rows.filter((r) => !r.source);
  else if (ui.sourceFilter !== 'all') rows = rows.filter((r) => r.source === ui.sourceFilter);
  if (ui.status !== 'all') rows = rows.filter((r) => (ui.status === 'open' || ui.status === 'close') ? r.status === ui.status : r.health === ui.status);
  if (ui.from) rows = rows.filter((r) => !r.day || r.day >= ui.from);
  if (ui.to) rows = rows.filter((r) => !r.day || r.day <= ui.to);
  if (ui.text.trim()) {
    const t = ui.text.trim().toLowerCase();
    rows = rows.filter((r) => r.index.toLowerCase().includes(t));
  }
  const key = ui.sort;
  rows = [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * ui.dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * ui.dir;
  });
  return rows;
}

function draw() {
  const c = cluster();
  if (!c) return mount(host, empty('No cluster selected'));
  const all = state.indices.get(c.id) || [];
  const rows = rowsFor(c);

  const sourcesMap = new Map();
  all.forEach((r) => {
    const k = r.source || '__none';
    const cur = sourcesMap.get(k) || { key: k, indices: 0, docs: 0, size: 0 };
    cur.indices++; cur.docs += r.docs; cur.size += r.size;
    sourcesMap.set(k, cur);
  });
  const sourceList = [...sourcesMap.values()].sort((a, b) => b.size - a.size);

  const totals = rows.reduce((s, r) => ({ docs: s.docs + r.docs, size: s.size + r.size, pri: s.pri + r.pri, shards: s.shards + r.pri * (1 + r.rep) }),
    { docs: 0, size: 0, pri: 0, shards: 0 });

  mount(host,
    sourceBar(c, sourceList, all.length),
    ui.error ? h('div.banner.err', h('div', h('div.ttl', 'Could not list indices'), h('div.mono', ui.error))) : null,
    h('div.grid.c4', { style: { marginBottom: '14px' } },
      statTile('Indices shown', `${num(rows.length)}`, `of ${num(all.length)} on ${c.name}`),
      statTile('Documents', compact(totals.docs), num(totals.docs) + ' docs'),
      statTile('Store size', bytes(totals.size), `${num(totals.shards)} shards`),
      statTile('Sources detected', String(sourceList.filter((x) => x.key !== '__none').length), 'parsed from index names')),

    // Folded by default: useful, but tall enough to push the table off the screen.
    h('div.grid.c2', { style: { marginBottom: '10px' } },
      collapsible('Store size by source', 'click a bar to filter the table', () =>
        sourceList.length
          ? hbarList(sourceList.map((x) => ({ key: x.key, label: x.key === '__none' ? '(unparsed)' : x.key, value: x.size,
              sub: `${num(x.indices)} indices · ${compact(x.docs)} docs` })),
              { format: bytes, topN: 12, labelWidth: 150, onSelect: (r) => { ui.sourceFilter = r.key; draw(); } })
          : empty('No indices'), { key: 'idx-by-source' }),
      collapsible('Indices per day', 'daily indices detected from the naming pattern',
        () => perDay(rows), { key: 'idx-per-day' })),

    h('div', { style: { marginBottom: '10px' } }, volumeAnalysisCard(c)),

    tableCard(c, rows, all));
}

/* ----------------------------- volume analysis ------------------------------ */

/**
 * Daily volume split by an ECS field — tag1, src_hostname — rather than by index.
 *
 * The index list answers "how much did this cluster take yesterday". This answers "which
 * device or tag was responsible", which is the question asked when the first number moves.
 * It costs one aggregation per field, so it runs on demand rather than on every render.
 */
function volumeAnalysisCard(c) {
  const fields = c.volumeFields && c.volumeFields.length ? c.volumeFields : [];
  if (!fields.length) {
    return card('Volume analysis', 'not configured',
      empty('Set volumeFields on this cluster — for example tag1, src_hostname — to break daily volume down by field.'));
  }
  if (!va.field || !fields.includes(va.field)) va.field = fields[0];

  const stored = fieldVolumeFor(c.id);
  const analysis = stored && stored.byField[va.field];
  const spikes = analysis ? (analysis.terms || []).filter((t) => t.spiked) : [];

  const controls = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '8px' } },
    h('label.field', 'Field', (() => {
      const sel = h('select', { onchange: (e) => { va.field = e.target.value; va.selectedTerm = null; runAnalysis(c); } },
        ...fields.map((f) => h('option', { value: f }, f)));
      sel.value = va.field; return sel;
    })()),
    h('label.field', 'Window', (() => {
      const sel = h('select', { onchange: (e) => { va.days = Number(e.target.value); runAnalysis(c); } },
        ...[7, 14, 30, 60].map((n) => h('option', { value: String(n) }, `${n} days`)));
      sel.value = String(va.days); return sel;
    })()),
    h('label.field', 'Top', (() => {
      const sel = h('select', { onchange: (e) => { va.topN = Number(e.target.value); runAnalysis(c); } },
        ...[5, 12, 25, 50].map((n) => h('option', { value: String(n) }, String(n))));
      sel.value = String(va.topN); return sel;
    })()),
    h('button.btn.sm.primary', { disabled: va.running, onclick: () => runAnalysis(c) },
      va.running ? 'Analysing…' : analysis ? '↻ Re-run' : 'Analyse'),
    analysis ? h('button.btn.sm', { onclick: () => exportAnalysis(c, analysis) }, 'Export CSV') : null,
    h('span.muted', { style: { fontSize: '11px', marginLeft: 'auto' } },
      analysis ? `${analysis.resolvedField} · ${analysis.terms.length} values` : 'one aggregation per run'));

  const body = h('div', { style: { display: 'grid', gap: '9px' } },
    controls,
    va.error ? h('div.banner.err', { style: { margin: 0 } }, h('div', h('div.ttl', 'Analysis failed'), h('div.mono', va.error))) : null,
    spikes.length ? spikeBanner(c, spikes) : null,
    analysis ? analysisBody(c, analysis) : va.running ? null
      : empty(`Press Analyse to break the last ${va.days} days down by ${va.field}.`));

  return card('Volume analysis', `daily volume by ${va.field}`, body,
    spikes.length ? [pill(`${spikes.length} spiking`, 'red')] : null);
}

function spikeBanner(c, spikes) {
  return h('div.banner.err', { style: { margin: 0 } },
    h('div', { style: { minWidth: 0 } },
      h('div.ttl', `${spikes.length} ${va.field} value${spikes.length === 1 ? '' : 's'} above the ${SPIKE_WINDOW_DAYS}-day average by more than ${Math.round((SPIKE_THRESHOLD - 1) * 100)}%`),
      h('div', { style: { display: 'grid', gap: '2px', marginTop: '3px' } },
        ...spikes.slice(0, 6).map((t) => h('div', { style: { fontSize: '12px' } },
          h('b.mono', t.term), ' — ',
          `${num(t.latest.docs)} docs on ${t.latestDay} against a ${Math.round(t.baseline).toLocaleString()} average`,
          h('span', { style: { color: 'var(--critical)', fontWeight: 640 } }, `  +${Math.round(t.changePct)}%`))),
        spikes.length > 6 ? h('div.muted', { style: { fontSize: '11.5px' } }, `…and ${spikes.length - 6} more`) : null)));
}

function analysisBody(c, a) {
  const term = va.selectedTerm && a.terms.find((t) => t.term === va.selectedTerm);
  const chartFor = term || null;

  // Daily totals for the chosen term, or the whole field when nothing is picked.
  const series = chartFor
    ? chartFor.series
    : a.days.map((day) => ({ day, docs: a.terms.reduce((s, t) => s + ((t.series.find((p) => p.day === day) || {}).docs || 0), 0),
                             bytes: a.terms.reduce((s, t) => s + ((t.series.find((p) => p.day === day) || {}).bytes || 0), 0) }));

  const buckets = series.map((p) => ({ t: new Date(`${p.day}T00:00:00Z`).getTime(), v: p.docs }));

  const trs = a.terms.map((t) => h('tr', {
      style: { cursor: 'pointer', background: va.selectedTerm === t.term ? 'var(--accent-soft)' : '' },
      onclick: () => { va.selectedTerm = va.selectedTerm === t.term ? null : t.term; draw(); },
    },
    h('td.mono', { style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: t.term }, t.term),
    h('td.num', compact(t.docs)),
    h('td.num', t.latest ? compact(t.latest.docs) : '–'),
    h('td.num.muted', t.baseline ? compact(Math.round(t.baseline)) : '–'),
    h('td.num', t.changePct === null ? h('span.muted', '–')
      : h('span', { style: { color: t.spiked ? 'var(--critical)' : t.changePct < -25 ? 'var(--warning)' : 'inherit',
                             fontWeight: t.spiked ? 640 : 400 } },
          `${t.changePct >= 0 ? '+' : ''}${Math.round(t.changePct)}%`)),
    h('td.num.muted', { title: 'Estimated from this value’s share of the day’s documents' },
      t.latest ? bytes(t.latest.bytes) : '–'),
    h('td', t.spiked ? pill('spike', 'red') : t.changePct !== null && t.changePct < -50 ? pill('dropped', 'yellow') : pill('steady', 'grey'))));

  return h('div', { style: { display: 'grid', gap: '9px' } },
    h('div',
      h('div', { style: { fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '3px' } },
        chartFor ? `Daily documents for ${chartFor.term} — click the row again to show every value`
                 : `Daily documents across the top ${a.terms.length} ${va.field} values — click a row to isolate one`),
      timeHistogram(buckets, { height: 130, yLabel: 'Docs' })),
    table(['Value', { label: 'Docs in window', num: true }, { label: 'Latest day', num: true },
           { label: `${SPIKE_WINDOW_DAYS}-day avg`, num: true }, { label: 'Change', num: true },
           { label: 'Est. size', num: true }, 'State'],
      trs, { emptyText: 'No values returned — check that the field exists and is aggregatable.' }),
    h('div.muted', { style: { fontSize: '11px' } },
      'Document counts are exact. Size is an estimate: Elasticsearch reports store size per index, ' +
      'never per field value, so a value’s share of the day’s documents is applied to that day’s index size.'));
}

async function runAnalysis(c) {
  va.running = true; va.error = null; draw();
  try {
    const a = await fetchFieldVolume(c, { field: va.field, days: va.days, topN: va.topN });
    if (a.error) va.error = a.error;
    storeFieldVolume(c.id, va.field, a);
  } catch (e) {
    va.error = e.message || String(e);
  }
  va.running = false;
  draw();
}

function exportAnalysis(c, a) {
  const rows = [];
  for (const t of a.terms) {
    for (const p of t.series) {
      rows.push({
        cluster: c.name, field: a.resolvedField, value: t.term, day: p.day,
        docs: p.docs, estimated_bytes: p.bytes,
        latest_day: t.latestDay || '', latest_docs: t.latest ? t.latest.docs : '',
        baseline_avg_docs: t.baseline === null || t.baseline === undefined ? '' : Math.round(t.baseline),
        change_pct: t.changePct === null ? '' : Math.round(t.changePct),
        spiked: t.spiked ? 'YES' : 'NO',
      });
    }
  }
  download(`volume-by-${a.resolvedField}-${c.id}-${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(rows), 'text/csv');
}

function sourceBar(c, sourceList, total) {
  const sel = h('select', { onchange: (e) => { ui.sourceFilter = e.target.value; draw(); } },
    h('option', { value: 'all' }, `All sources (${total} indices)`),
    ...sourceList.filter((x) => x.key !== '__none').map((x) => h('option', { value: x.key }, `${x.key} — ${x.indices} idx · ${bytes(x.size)}`)),
    sourceList.some((x) => x.key === '__none') ? h('option', { value: '__none' }, '(indices without a source)') : null);
  sel.value = ui.sourceFilter;

  return h('div.toolbar',
    h('label.field', 'Source', sel),
    h('label.field', 'Search index', h('input#idx-search', { type: 'search', placeholder: 'substring…', value: ui.text, style: { minWidth: '200px' },
      oninput: (e) => { ui.text = e.target.value; syncSearchBoxes(e.target); redrawTable(); } })),
    h('label.field', 'From day', h('input', { type: 'date', value: ui.from, onchange: (e) => { ui.from = e.target.value; draw(); } })),
    h('label.field', 'To day', h('input', { type: 'date', value: ui.to, onchange: (e) => { ui.to = e.target.value; draw(); } })),
    h('label.field', 'Status', (() => {
      const s = h('select', { onchange: (e) => { ui.status = e.target.value; draw(); } },
        h('option', { value: 'all' }, 'Any'), h('option', { value: 'green' }, 'green'),
        h('option', { value: 'yellow' }, 'yellow'), h('option', { value: 'red' }, 'red'),
        h('option', { value: 'open' }, 'open'), h('option', { value: 'close' }, 'closed'));
      s.value = ui.status; return s;
    })()),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'flex-end' } },
      ui.loading ? h('span.muted', h('span.spin'), ' loading…') : h('span.muted', { style: { fontSize: '11.5px' } }, `updated ${ago(state.lastRefresh)}`),
      writeToggle(draw),
      h('button.btn.sm', { onclick: () => { ui.sourceFilter = 'all'; ui.text = ''; ui.status = 'all'; ui.from = ''; ui.to = ''; draw(); } }, 'Clear'),
      h('button.btn.sm', { onclick: () => load(true) }, '↻ Reload')));
}

function perDay(rows) {
  const byDay = new Map();
  rows.forEach((r) => { if (!r.day) return; const v = byDay.get(r.day) || { n: 0, size: 0 }; v.n++; v.size += r.size; byDay.set(r.day, v); });
  const days = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 14);
  if (!days.length) return empty('No date-suffixed indices in the current filter');
  return hbarList(days.map(([d, v]) => ({ key: d, label: d, value: v.size, sub: `${v.n} indices` })),
    { format: bytes, topN: 14, labelWidth: 100, showOther: false, sort: false, onSelect: (r) => { ui.from = r.key; ui.to = r.key; draw(); } });
}

function th(label, key, numeric) {
  return h('th', { class: `${numeric ? 'num ' : ''}sortable`, onclick: () => { ui.dir = ui.sort === key ? -ui.dir : -1; ui.sort = key; redrawTable(); } },
    label + (ui.sort === key ? (ui.dir === 1 ? ' ▲' : ' ▼') : ''));
}

function redrawTable() {
  const c = cluster(); if (!c) return;
  const holder = $('#idx-table');
  if (!holder) return draw();
  const rows = rowsFor(c);
  const meta = $('#idx-meta');
  if (meta) meta.textContent = `${num(rows.length)} shown · limit ${ui.limit}`;
  mount(holder, buildTable(c, rows));
}

/** Reload after an action changed the cluster, keeping the operator's filters. */
async function afterChange(c) {
  selected.clear();
  await load(true);
}

/** The bar that appears once indices are ticked. Everything on it is an operator action. */
function bulkBar(c, rows) {
  const names = [...selected];
  const chosen = rows.filter((r) => selected.has(r.index));
  const size = chosen.reduce((s, r) => s + (r.size || 0), 0);
  const anyClosed = chosen.some((r) => r.status !== 'open');
  const anyOpen = chosen.some((r) => r.status === 'open');
  const refresh = { onChanged: () => afterChange(c) };

  if (!names.length) {
    return h('div.muted', { style: { fontSize: '11.5px' } },
      'Tick indices to open, close, delete or reconfigure them.');
  }

  return h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
    h('span', { style: { fontWeight: 640, fontSize: '12px' } },
      `${num(names.length)} selected`, size ? h('span.muted', { style: { fontWeight: 400 } }, ` · ${bytes(size)}`) : null),
    h('button.btn.sm', { disabled: !anyClosed, title: anyClosed ? 'Open the selected indices' : 'All selected indices are already open',
      onclick: () => openIndices(c, chosen.filter((r) => r.status !== 'open').map((r) => r.index), refresh) }, 'Open'),
    h('button.btn.sm', { disabled: !anyOpen, title: anyOpen ? 'Close the selected indices' : 'All selected indices are already closed',
      onclick: () => closeIndices(c, chosen.filter((r) => r.status === 'open').map((r) => r.index), refresh) }, 'Close'),
    rowMenu([
      { label: 'Settings…', icon: ICON.settings, onClick: () => indexSettingsDialog(c, names, refresh) },
      { sep: true },
      ...MAINTENANCE_KINDS.map(([k, label]) => ({
        label, icon: ICON.refresh, onClick: () => maintenance(c, names, k, refresh),
      })),
      { sep: true },
      { label: `Delete ${num(names.length)} indices…`, icon: ICON.delete, danger: true,
        onClick: () => deleteIndices(c, names, refresh) },
    ], { label: '⋮ Actions', title: 'Actions for the selection' }),
    h('button.btn.sm.ghost', { onclick: () => { selected.clear(); redrawTable(); } }, 'Clear selection'));
}

function buildTable(c, rows) {
  const shown = rows.slice(0, ui.limit);
  const refresh = { onChanged: () => afterChange(c) };
  const allShownTicked = shown.length > 0 && shown.every((r) => selected.has(r.index));

  const tick = (r) => h('input', {
    type: 'checkbox', checked: selected.has(r.index), style: { cursor: 'pointer' },
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { if (e.target.checked) selected.add(r.index); else selected.delete(r.index); redrawBulk(c); },
  });

  const trs = shown.map((r) => h('tr',
    h('td', tick(r)),
    h('td', pill(r.health || '?', r.health)),
    h('td.mono', { style: { maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: r.index }, r.index),
    h('td', r.source ? h('button.btn.sm.ghost', { onclick: () => { ui.sourceFilter = r.source; draw(); } }, r.source) : h('span.muted', '–')),
    h('td.mono', r.day || '–'),
    h('td', r.status === 'open' ? h('span.pill.green', h('i.dot'), 'open') : h('span.pill.grey', h('i.dot'), r.status || '?')),
    h('td.num', `${r.pri}/${r.rep}`),
    h('td.num', { title: num(r.docs) }, compact(r.docs)),
    h('td.num.muted', compact(r.deleted)),
    h('td.num', bytes(r.size)),
    h('td.num.muted', bytes(r.priSize)),
    h('td.muted', { style: { fontSize: '11.5px' } }, r.created ? dt(r.created).slice(0, 12) : '–'),
    h('td', h('div', { style: { display: 'flex', gap: '3px', justifyContent: 'flex-end' } },
      // Only the reversible action stays in the row; the rest need the menu.
      r.status === 'open'
        ? h('button.btn.sm', { title: 'Close this index — the data stays on disk', onclick: () => closeIndices(c, [r.index], refresh) }, 'Close')
        : h('button.btn.sm', { title: 'Open this index again', onclick: () => openIndices(c, [r.index], refresh) }, 'Open'),
      rowMenu([
        { label: 'Open in REST console', icon: ICON.console,
          onClick: () => navigateTo('console', { method: 'GET', path: `/${r.index}/_settings`, body: '' }) },
        { label: 'Settings…', icon: ICON.settings, title: 'Replicas, refresh interval, allocation',
          onClick: () => indexSettingsDialog(c, [r.index], refresh) },
        { label: 'Move a shard…', icon: ICON.move, disabled: r.status !== 'open',
          title: r.status === 'open' ? 'Relocate a shard to another node' : 'The index must be open to move a shard',
          onClick: () => moveShardDialog(c, r.index, refresh) },
        { sep: true },
        ...MAINTENANCE_KINDS.map(([k, label]) => ({
          label, icon: ICON.refresh, onClick: () => maintenance(c, [r.index], k, refresh),
        })),
        { sep: true },
        { label: 'Delete index…', icon: ICON.delete, danger: true,
          onClick: () => deleteIndices(c, [r.index], refresh) },
      ], { title: `Actions for ${r.index}` })))));

  const selectAll = h('input', {
    type: 'checkbox', checked: allShownTicked, style: { cursor: 'pointer' },
    title: 'Select every index shown',
    onchange: (e) => {
      shown.forEach((r) => { if (e.target.checked) selected.add(r.index); else selected.delete(r.index); });
      redrawTable();
    },
  });

  const t = h('div.tbl-wrap', h('table.tbl',
    h('thead', h('tr',
      h('th', { style: { width: '28px' } }, selectAll),
      th('H', 'health'), th('Index', 'index'), th('Source', 'source'), th('Day', 'day'), th('State', 'status'),
      th('P/R', 'pri', true), th('Docs', 'docs', true), th('Deleted', 'deleted', true),
      th('Size', 'size', true), th('Primary', 'priSize', true), th('Created', 'created'), h('th', ''))),
    h('tbody', ...(trs.length ? trs : [h('tr', h('td', { colspan: 13 }, empty('No indices match the filter')))]))));

  return h('div',
    // The toolbar search sits above the charts; with them folded away it is still a
    // scroll from the table, so the filter is repeated where the rows actually are.
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '0 0 8px', flexWrap: 'wrap' } },
      h('input#idx-search2', { type: 'search', value: ui.text, placeholder: 'filter these indices…',
        style: { flex: '1', minWidth: '220px' },
        oninput: (e) => { ui.text = e.target.value; syncSearchBoxes(e.target); redrawTable(); } }),
      h('span.muted', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } },
        `${num(rows.length)} of ${num((state.indices.get(c.id) || []).length)} indices`),
      ui.text || ui.sourceFilter !== 'all' || ui.status !== 'all' || ui.from || ui.to
        ? h('button.btn.sm.ghost', { onclick: () => {
            ui.text = ''; ui.sourceFilter = 'all'; ui.status = 'all'; ui.from = ''; ui.to = ''; draw();
          } }, 'Clear filters')
        : null),
    h('div#idx-bulk', { style: { padding: '0 0 9px' } }, bulkBar(c, rows)),
    t,
    rows.length > ui.limit
      ? h('div', { style: { padding: '10px', textAlign: 'center' } },
          h('button.btn.sm', { onclick: () => { ui.limit += 500; redrawTable(); } }, `Show more (${num(rows.length - ui.limit)} hidden)`))
      : null);
}

/** The toolbar and the over-table search are the same filter; keep them in step. */
function syncSearchBoxes(source) {
  for (const el of [$('#idx-search'), $('#idx-search2')]) {
    if (el && el !== source && el.value !== ui.text) el.value = ui.text;
  }
}

function redrawBulk(c) {
  const el = $('#idx-bulk');
  if (el) mount(el, bulkBar(c, rowsFor(c)));
}

function tableCard(c, rows, all) {
  return card(`Indices on ${c.name}`, '',
    h('div#idx-table', buildTable(c, rows)),
    [h('span#idx-meta.muted', { style: { fontSize: '11.5px' } }, `${num(rows.length)} shown · limit ${ui.limit}`),
     h('button.btn.sm', { onclick: () => download(`indices-${c.id}-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(rows.map((r) => ({ index: r.index, source: r.source || '', day: r.day || '', health: r.health, status: r.status,
          pri: r.pri, rep: r.rep, docs: r.docs, deleted: r.deleted, size_bytes: r.size, primary_bytes: r.priSize,
          created: r.created ? new Date(r.created).toISOString() : '' }))), 'text/csv') }, 'Export CSV')]);
}
