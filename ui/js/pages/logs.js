/** Page 4 — live log explorer over daily indices (logstash-<client>-YYYY.MM.DD). */

import { h, mount, $, clear } from '../lib/dom.js';
import { num, compact, dt, dur, ago, ymdDots, eachDay, download, toCsv, bytes } from '../lib/fmt.js';
import { state, client, activeClusters, fetchIndices } from '../core/state.js';
import { timeHistogram } from '../lib/charts.js';
import { card, empty, pill } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { jsonView } from '../lib/jsonview.js';

let host = null;
let tailTimer = null;

const ui = {
  clientFilter: 'all',
  from: '', to: '',
  query: '',
  size: 200,
  running: false,
  error: null,
  hits: [],
  total: 0,
  tookMs: 0,
  buckets: [],
  resolved: [],
  tail: false,
  expanded: new Set(),
};

function isoLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function render(el) {
  host = el;
  if (isSnapshotMode()) { mount(host, snapshotNotice('The log explorer')); return; }
  if (!ui.from) {
    const now = new Date();
    const back = new Date(now.getTime() - 60 * 60 * 1000);
    ui.from = isoLocal(back); ui.to = isoLocal(now);
  }
  draw();
  if (!ui.hits.length && !ui.running) search();
}
export function onData() {}
export function onLeave() { stopTail(); }

function cluster() { return activeClusters()[0] || null; }

/** Which concrete daily indices does the picked range touch? */
function targetIndices(c) {
  const known = state.indices.get(c.id) || [];
  const fromDay = ui.from.slice(0, 10), toDay = ui.to.slice(0, 10);
  const days = eachDay(fromDay, toDay).map((d) => ymdDots(d, '-'));
  const inRange = known.filter((r) => r.day && days.includes(r.day) &&
    (ui.clientFilter === 'all' || r.client === ui.clientFilter));
  if (inRange.length) return { list: inRange.map((r) => r.index), exact: true, days };
  // fall back to a wildcard the cluster resolves itself
  const pat = ui.clientFilter === 'all' ? c.logIndexPattern : c.logIndexPattern.replace('*', `${ui.clientFilter}-*`);
  return { list: [pat], exact: false, days };
}

function interval(ms) {
  const target = 60; // aim for ~60 buckets
  const step = ms / target;
  const table = [
    [1000, '1s'], [5000, '5s'], [10000, '10s'], [30000, '30s'], [60000, '1m'], [300000, '5m'],
    [600000, '10m'], [1800000, '30m'], [3600000, '1h'], [10800000, '3h'], [21600000, '6h'], [43200000, '12h'], [86400000, '1d'],
  ];
  for (const [msv, label] of table) if (step <= msv) return label;
  return '7d';
}

async function search({ silent = false } = {}) {
  const c = cluster();
  if (!c) return;
  const cl = client(c.id);
  if (!state.indices.get(c.id)) { try { await fetchIndices(c.id, '*'); } catch (_) {} }

  const t = targetIndices(c);
  ui.resolved = t;
  const gte = new Date(ui.from).toISOString();
  const lte = new Date(ui.to).toISOString();
  const span = new Date(ui.to) - new Date(ui.from);

  const filters = [{ range: { [c.timeField]: { gte, lte, format: 'strict_date_optional_time' } } }];
  const must = ui.query.trim() ? [{ query_string: { query: ui.query.trim(), analyze_wildcard: true, default_field: '*' } }] : [];

  const body = {
    size: Number(ui.size) || 100,
    track_total_hits: 10000,
    sort: [{ [c.timeField]: { order: 'desc', unmapped_type: 'date' } }],
    query: { bool: { filter: filters, must } },
    aggs: { over_time: { date_histogram: { field: c.timeField, fixed_interval: interval(span), min_doc_count: 0,
      extended_bounds: { min: gte, max: lte } } } },
  };

  ui.running = true; ui.error = null;
  if (!silent) draw();
  try {
    const idx = t.list.join(',').slice(0, 3500) || '*';
    const r = await cl.search(idx, body, { qs: 'ignore_unavailable=true&allow_no_indices=true&rest_total_hits_as_int=false', timeoutMs: 45000 });
    ui.hits = (r.hits && r.hits.hits) || [];
    ui.total = (r.hits && r.hits.total && (r.hits.total.value ?? r.hits.total)) || 0;
    ui.totalRelation = (r.hits && r.hits.total && r.hits.total.relation) || 'eq';
    ui.tookMs = r.took || 0;
    ui.buckets = ((r.aggregations && r.aggregations.over_time && r.aggregations.over_time.buckets) || [])
      .map((b) => ({ t: b.key, v: b.doc_count }));
  } catch (e) {
    ui.error = e.message; ui.hits = []; ui.buckets = []; ui.total = 0;
  }
  ui.running = false;
  draw();
}

function startTail() {
  stopTail();
  ui.tail = true;
  tailTimer = setInterval(() => {
    const now = new Date();
    const span = new Date(ui.to) - new Date(ui.from);
    ui.to = isoLocal(now);
    ui.from = isoLocal(new Date(now.getTime() - span));
    search({ silent: true });
  }, Math.max(5, state.defaults.refreshIntervalSec) * 1000);
  search();
}
function stopTail() { ui.tail = false; if (tailTimer) clearInterval(tailTimer); tailTimer = null; }

function quick(label, ms) {
  return h('button.btn.sm', { onclick: () => {
    const now = new Date();
    ui.to = isoLocal(now); ui.from = isoLocal(new Date(now.getTime() - ms));
    search();
  } }, label);
}

function draw() {
  const c = cluster();
  if (isSnapshotMode()) return mount(host, snapshotNotice('The log explorer'));
  if (!c) return mount(host, empty('No cluster selected'));
  const known = state.indices.get(c.id) || [];
  const clientNames = [...new Set(known.filter((r) => r.client).map((r) => r.client))].sort();

  const sel = h('select', { onchange: (e) => { ui.clientFilter = e.target.value; search(); } },
    h('option', { value: 'all' }, 'All clients'),
    ...clientNames.map((n) => h('option', { value: n }, n)));
  sel.value = ui.clientFilter;

  const bar = h('div.toolbar',
    h('label.field', 'Client', sel),
    h('label.field', 'From', h('input', { type: 'datetime-local', value: ui.from, onchange: (e) => { ui.from = e.target.value; } })),
    h('label.field', 'To', h('input', { type: 'datetime-local', value: ui.to, onchange: (e) => { ui.to = e.target.value; } })),
    h('label.field', 'Lucene query', h('input', { type: 'search', value: ui.query, placeholder: 'level:ERROR AND host:web*', style: { minWidth: '260px' },
      oninput: (e) => { ui.query = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') search(); } })),
    h('label.field', 'Rows', h('input', { type: 'number', min: '10', max: '2000', step: '10', value: String(ui.size), style: { width: '84px' },
      onchange: (e) => { ui.size = Number(e.target.value) || 200; } })),
    h('button.btn.primary', { onclick: () => search() }, ui.running ? 'Searching…' : 'Search'),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-end' } },
      quick('15m', 9e5), quick('1h', 36e5), quick('24h', 864e5), quick('7d', 6048e5)),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'flex-end' } },
      h('button.btn.sm', { onclick: () => (ui.tail ? (stopTail(), draw()) : startTail()),
        style: ui.tail ? { borderColor: 'var(--good)', color: 'var(--good)' } : null },
        ui.tail ? '■ Stop live tail' : '▶ Live tail'),
      h('button.btn.sm', { onclick: exportHits, disabled: !ui.hits.length }, 'Export CSV')));

  const resolvedNote = ui.resolved.list
    ? h('div.muted', { style: { fontSize: '11.5px', marginBottom: '10px' } },
        ui.resolved.exact
          ? `Searching ${ui.resolved.list.length} daily ${ui.resolved.list.length === 1 ? 'index' : 'indices'} across ${ui.resolved.days.length} day(s): `
          : `No matching daily indices cached — falling back to pattern `,
        h('code.inline', ui.resolved.list.slice(0, 4).join(', ') + (ui.resolved.list.length > 4 ? ` +${ui.resolved.list.length - 4} more` : '')))
    : null;

  mount(host, bar, resolvedNote,
    ui.error ? h('div.banner.err', h('div', h('div.ttl', 'Search failed'), h('div.mono', ui.error))) : null,
    card('Documents over time',
      `${num(ui.total)}${ui.totalRelation === 'gte' ? '+' : ''} matching · query took ${dur(ui.tookMs)}`,
      ui.running && !ui.buckets.length ? h('div.tbl-empty', h('span.spin'), ' searching…')
        : timeHistogram(ui.buckets, { height: 150, yLabel: 'Documents',
            formatX: (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            onSelect: (b) => { const w = ui.buckets.length > 1 ? ui.buckets[1].t - ui.buckets[0].t : 60000;
              ui.from = isoLocal(new Date(b.t)); ui.to = isoLocal(new Date(b.t + w)); search(); } })),
    h('div', { style: { marginTop: '14px' } }, hitsCardWrapper()));
}

const pick = (src, keys) => { for (const k of keys) { const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), src); if (v !== undefined && v !== null) return v; } return undefined; };

function hitRows() {
  const c = cluster();
  const rows = ui.hits.map((hit, i) => {
    const s = hit._source || {};
    const ts = pick(s, [c.timeField, '@timestamp', 'timestamp', 'time']);
    const lvl = pick(s, ['level', 'log.level', 'severity', 'loglevel', 'log_level']);
    const hostName = pick(s, ['host.name', 'host.hostname', 'agent.hostname', 'hostname', 'beat.hostname', 'host']);
    const msg = pick(s, ['message', 'log.message', 'msg', 'event.original', 'full_message']);
    const lvlCls = /err|crit|fatal|alert|emerg/i.test(String(lvl)) ? 'red'
      : /warn/i.test(String(lvl)) ? 'yellow' : /info|notice/i.test(String(lvl)) ? 'green' : 'grey';
    const open = ui.expanded.has(hit._id + i);
    return [
      h('tr', { style: { cursor: 'pointer' }, onclick: () => { const k = hit._id + i; ui.expanded.has(k) ? ui.expanded.delete(k) : ui.expanded.add(k); mount($('#log-rows'), ...hitRows()); } },
        h('td.mono.nowrap', { style: { fontSize: '11.5px' } }, ts ? dt(new Date(ts).getTime()) : '–'),
        h('td', lvl ? h(`span.pill.${lvlCls}`, h('i.dot'), String(lvl)) : h('span.muted', '–')),
        h('td.mono.trunc', { style: { fontSize: '11.5px', maxWidth: '160px' }, title: String(hostName ?? '') }, String(hostName ?? '–')),
        h('td.mono', { style: { fontSize: '11.5px', maxWidth: '780px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: open ? 'pre-wrap' : 'nowrap' } },
          typeof msg === 'string' ? msg : JSON.stringify(s).slice(0, 400)),
        h('td.mono.muted.trunc', { style: { fontSize: '10.5px', maxWidth: '210px' }, title: hit._index }, hit._index)),
      open ? h('tr', h('td', { colspan: 5, style: { background: 'var(--surface-2)' } }, jsonView(hit._source))) : null,
    ];
  }).flat().filter(Boolean);
  return rows;
}

function exportHits() {
  const c = cluster();
  const data = ui.hits.map((hit) => {
    const s = hit._source || {};
    return {
      time: pick(s, [c.timeField, '@timestamp']) || '',
      index: hit._index,
      level: pick(s, ['level', 'log.level', 'severity']) || '',
      host: pick(s, ['host.name', 'agent.hostname', 'hostname']) || '',
      message: typeof pick(s, ['message', 'log.message', 'msg']) === 'string' ? pick(s, ['message', 'log.message', 'msg']) : JSON.stringify(s),
    };
  });
  download(`logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`, toCsv(data), 'text/csv');
}

function hitsCardWrapper() {
  return card(`Log events`, `${ui.hits.length} shown${ui.tail ? ' · live tail on' : ''}`,
    h('div.tbl-wrap', h('table.tbl',
      h('thead', h('tr', h('th', 'Time'), h('th', 'Level'), h('th', 'Host'), h('th', 'Message'), h('th', 'Index'))),
      h('tbody#log-rows', ...(ui.hits.length ? hitRows() : [h('tr', h('td', { colspan: 5 }, empty(ui.running ? 'Searching…' : 'No documents in this range')))])))));
}

function snapshotNotice(what) {
  return h('div.banner.warn', { style: { margin: 0 } },
    h('div',
      h('div.ttl', `${what} needs a live connection`),
      h('div', 'You are viewing a snapshot file collected by PowerShell, so there is no cluster to query. ',
        'Everything that was collected — cluster health, disk, indices, nodes, snapshots and SLM — is on the other pages.'),
      h('div.sec', { style: { fontSize: '12px', marginTop: '5px' } },
        'To use this page, load clusters.yaml instead (Config → Pick another file) and connect directly.')));
}
