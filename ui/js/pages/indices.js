/** Page 2 — live indices, with a client picker driven by the index naming pattern. */

import { h, mount, $, clear } from '../lib/dom.js';
import { bytes, num, compact, dt, ago, toCsv, download } from '../lib/fmt.js';
import { state, client, fetchIndices, activeClusters } from '../core/state.js';
import { hbarList } from '../lib/charts.js';
import { card, pill, statTile, table, empty, connectionBanner } from './common.js';
import { navigateTo } from '../core/intent.js';
import { syncWrites, writeToggle } from '../core/writes.js';
import {
  openIndices, closeIndices, deleteIndices, moveShardDialog, indexSettingsDialog,
  maintenance, MAINTENANCE_KINDS,
} from '../ui/index-actions.js';

let host = null;
const ui = { clientFilter: 'all', text: '', status: 'all', sort: 'size', dir: -1, limit: 300, from: '', to: '', loading: false, error: null };
/** Index names ticked in the table, for the bulk actions. Cleared when the data reloads. */
const selected = new Set();

export function render(el) {
  host = el;
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
  if (ui.clientFilter === '__none') rows = rows.filter((r) => !r.client);
  else if (ui.clientFilter !== 'all') rows = rows.filter((r) => r.client === ui.clientFilter);
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

  const clientsMap = new Map();
  all.forEach((r) => {
    const k = r.client || '__none';
    const cur = clientsMap.get(k) || { key: k, indices: 0, docs: 0, size: 0 };
    cur.indices++; cur.docs += r.docs; cur.size += r.size;
    clientsMap.set(k, cur);
  });
  const clientList = [...clientsMap.values()].sort((a, b) => b.size - a.size);

  const totals = rows.reduce((s, r) => ({ docs: s.docs + r.docs, size: s.size + r.size, pri: s.pri + r.pri, shards: s.shards + r.pri * (1 + r.rep) }),
    { docs: 0, size: 0, pri: 0, shards: 0 });

  mount(host,
    clientBar(c, clientList, all.length),
    ui.error ? h('div.banner.err', h('div', h('div.ttl', 'Could not list indices'), h('div.mono', ui.error))) : null,
    h('div.grid.c4', { style: { marginBottom: '14px' } },
      statTile('Indices shown', `${num(rows.length)}`, `of ${num(all.length)} on ${c.name}`),
      statTile('Documents', compact(totals.docs), num(totals.docs) + ' docs'),
      statTile('Store size', bytes(totals.size), `${num(totals.shards)} shards`),
      statTile('Clients detected', String(clientList.filter((x) => x.key !== '__none').length), 'parsed from index names')),

    h('div.grid.c2', { style: { marginBottom: '14px' } },
      card('Store size by client', 'click a bar to filter the table',
        clientList.length
          ? hbarList(clientList.map((x) => ({ key: x.key, label: x.key === '__none' ? '(unparsed)' : x.key, value: x.size,
              sub: `${num(x.indices)} indices · ${compact(x.docs)} docs` })),
              { format: bytes, topN: 12, labelWidth: 150, onSelect: (r) => { ui.clientFilter = r.key; draw(); } })
          : empty('No indices')),
      card('Indices per day', 'daily indices detected from the naming pattern', perDay(rows))),

    tableCard(c, rows, all));
}

function clientBar(c, clientList, total) {
  const sel = h('select', { onchange: (e) => { ui.clientFilter = e.target.value; draw(); } },
    h('option', { value: 'all' }, `All clients (${total} indices)`),
    ...clientList.filter((x) => x.key !== '__none').map((x) => h('option', { value: x.key }, `${x.key} — ${x.indices} idx · ${bytes(x.size)}`)),
    clientList.some((x) => x.key === '__none') ? h('option', { value: '__none' }, '(indices without a client)') : null);
  sel.value = ui.clientFilter;

  return h('div.toolbar',
    h('label.field', 'Client', sel),
    h('label.field', 'Search index', h('input', { type: 'search', placeholder: 'substring…', value: ui.text, style: { minWidth: '200px' },
      oninput: (e) => { ui.text = e.target.value; redrawTable(); } })),
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
      h('button.btn.sm', { onclick: () => { ui.clientFilter = 'all'; ui.text = ''; ui.status = 'all'; ui.from = ''; ui.to = ''; draw(); } }, 'Clear'),
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

  const maintSel = h('select', { style: { maxWidth: '150px' },
    onchange: async (e) => { const k = e.target.value; e.target.value = ''; if (k) await maintenance(c, names, k, refresh); } },
    h('option', { value: '' }, 'Maintenance…'),
    ...MAINTENANCE_KINDS.map(([k, label]) => h('option', { value: k }, label)));

  return h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
    h('span', { style: { fontWeight: 640, fontSize: '12px' } },
      `${num(names.length)} selected`, size ? h('span.muted', { style: { fontWeight: 400 } }, ` · ${bytes(size)}`) : null),
    h('button.btn.sm', { disabled: !anyClosed, title: anyClosed ? 'Open the selected indices' : 'All selected indices are already open',
      onclick: () => openIndices(c, chosen.filter((r) => r.status !== 'open').map((r) => r.index), refresh) }, 'Open'),
    h('button.btn.sm', { disabled: !anyOpen, title: anyOpen ? 'Close the selected indices' : 'All selected indices are already closed',
      onclick: () => closeIndices(c, chosen.filter((r) => r.status === 'open').map((r) => r.index), refresh) }, 'Close'),
    h('button.btn.sm', { onclick: () => indexSettingsDialog(c, names, refresh) }, 'Settings…'),
    maintSel,
    h('button.btn.sm.danger', { onclick: () => deleteIndices(c, names, refresh) }, 'Delete…'),
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
    h('td', r.client ? h('button.btn.sm.ghost', { onclick: () => { ui.clientFilter = r.client; draw(); } }, r.client) : h('span.muted', '–')),
    h('td.mono', r.day || '–'),
    h('td', r.status === 'open' ? h('span.pill.green', h('i.dot'), 'open') : h('span.pill.grey', h('i.dot'), r.status || '?')),
    h('td.num', `${r.pri}/${r.rep}`),
    h('td.num', { title: num(r.docs) }, compact(r.docs)),
    h('td.num.muted', compact(r.deleted)),
    h('td.num', bytes(r.size)),
    h('td.num.muted', bytes(r.priSize)),
    h('td.muted', { style: { fontSize: '11.5px' } }, r.created ? dt(r.created).slice(0, 12) : '–'),
    h('td', h('div', { style: { display: 'flex', gap: '3px', justifyContent: 'flex-end' } },
      r.status === 'open'
        ? h('button.btn.sm', { title: 'Close this index — data stays on disk', onclick: () => closeIndices(c, [r.index], refresh) }, 'Close')
        : h('button.btn.sm', { title: 'Open this index again', onclick: () => openIndices(c, [r.index], refresh) }, 'Open'),
      h('button.btn.sm', { disabled: r.status !== 'open', title: r.status === 'open' ? 'Relocate a shard to another node' : 'The index must be open to move a shard',
        onclick: () => moveShardDialog(c, r.index, refresh) }, 'Move'),
      h('button.btn.sm', { title: 'Replicas, refresh interval, allocation', onclick: () => indexSettingsDialog(c, [r.index], refresh) }, '⚙'),
      h('button.btn.sm.danger', { title: 'Delete this index', onclick: () => deleteIndices(c, [r.index], refresh) }, 'Delete'),
      h('button.btn.sm.ghost', { title: 'Open in REST console',
        onclick: () => navigateTo('console', { method: 'GET', path: `/${r.index}/_settings`, body: '' }) }, '↗')))));

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
      th('H', 'health'), th('Index', 'index'), th('Client', 'client'), th('Day', 'day'), th('State', 'status'),
      th('P/R', 'pri', true), th('Docs', 'docs', true), th('Deleted', 'deleted', true),
      th('Size', 'size', true), th('Primary', 'priSize', true), th('Created', 'created'), h('th', ''))),
    h('tbody', ...(trs.length ? trs : [h('tr', h('td', { colspan: 13 }, empty('No indices match the filter')))]))));

  return h('div',
    h('div#idx-bulk', { style: { padding: '0 0 9px' } }, bulkBar(c, rows)),
    t,
    rows.length > ui.limit
      ? h('div', { style: { padding: '10px', textAlign: 'center' } },
          h('button.btn.sm', { onclick: () => { ui.limit += 500; redrawTable(); } }, `Show more (${num(rows.length - ui.limit)} hidden)`))
      : null);
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
        toCsv(rows.map((r) => ({ index: r.index, client: r.client || '', day: r.day || '', health: r.health, status: r.status,
          pri: r.pri, rep: r.rep, docs: r.docs, deleted: r.deleted, size_bytes: r.size, primary_bytes: r.priSize,
          created: r.created ? new Date(r.created).toISOString() : '' }))), 'text/csv') }, 'Export CSV')]);
}
