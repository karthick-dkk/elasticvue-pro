#!/usr/bin/env node
/**
 * A stand-in Elasticsearch, just complete enough for every page to render with data.
 *
 * `render-check.mjs` against an empty config only ever draws "No cluster selected", which
 * exercises almost nothing. Pointing it at this instead makes the pages walk their real
 * paths — tables, charts, coverage strips, snapshot lists — which is where render bugs are.
 *
 *   node tools/mock-es.mjs [port]        # default 9299
 *
 * Read-only fixture: any write returns {"acknowledged": true} without changing anything.
 */

import http from 'node:http';

const port = Number(process.argv[2]) || 9299;
const DAY = 86400000;

const index = (name, size, status = 'open', health = 'green') => ({
  index: name, health, status, uuid: name, pri: '1', rep: '1',
  'docs.count': '1000', 'docs.deleted': '12',
  'store.size': String(size), 'pri.store.size': String(Math.round(size / 2)),
  'creation.date': String(Date.now() - DAY),
});

const INDICES = [
  index('logstash-acme-2026.09.09', 5e9),
  index('logstash-acme-2026.09.08', 4e9),
  index('logstash-acme-2026.09.07', 4.2e9, 'close'),
  index('logstash-beta-2026.09.09', 2e9, 'open', 'yellow'),
  index('metrics-2026.09', 9e8),
];

// Enough snapshots that the "latest 5 + show more" path has something to page through.
const SNAPSHOTS = Array.from({ length: 23 }, (_, i) => {
  const start = Math.floor((Date.now() - i * DAY) / 1000);
  return {
    id: `daily-${new Date((start * 1000)).toISOString().slice(0, 10).replace(/-/g, '.')}-${i}`,
    status: i === 3 ? 'PARTIAL' : 'SUCCESS',
    start_epoch: String(start), end_epoch: String(start + 300), duration: '5m',
    indices: '5', successful_shards: '10', failed_shards: i === 3 ? '1' : '0', total_shards: '10',
  };
});

const routes = [
  [(u) => u === '/', () => ({ cluster_name: 'mock', cluster_uuid: 'mock-uuid',
    version: { number: '8.13.4', lucene_version: '9.10.0' } })],
  [(u) => u.startsWith('/_cluster/health'), () => ({ status: 'yellow', number_of_nodes: 3,
    number_of_data_nodes: 3, active_shards: 40, active_primary_shards: 20, unassigned_shards: 2,
    relocating_shards: 0, initializing_shards: 0, active_shards_percent_as_number: 95 })],
  // Deliberately skewed: node-1 heavy, node-3 nearly idle, so the disk-balance panel
  // has a real case to describe rather than a flat one.
  [(u) => u.startsWith('/_cat/allocation'), () => ([
    { node: 'node-1', shards: '38', 'disk.used': '91000000000', 'disk.avail': '9000000000',
      'disk.total': '100000000000', 'disk.percent': '91', 'disk.indices': '86000000000' },
    { node: 'node-2', shards: '22', 'disk.used': '55000000000', 'disk.avail': '45000000000',
      'disk.total': '100000000000', 'disk.percent': '55', 'disk.indices': '50000000000' },
    { node: 'node-3', shards: '9', 'disk.used': '21000000000', 'disk.avail': '79000000000',
      'disk.total': '100000000000', 'disk.percent': '21', 'disk.indices': '18000000000' },
    { node: 'UNASSIGNED', shards: '2' },
  ])],
  [(u) => u.startsWith('/_cluster/settings'), () => ({
    persistent: {}, transient: {},
    defaults: {
      'cluster.routing.allocation.disk.watermark.low': '85%',
      'cluster.routing.allocation.disk.watermark.high': '90%',
      'cluster.routing.allocation.disk.watermark.flood_stage': '95%',
      'cluster.routing.allocation.enable': 'all',
      'cluster.routing.rebalance.enable': 'all',
      // flip either of these to 'none' to see the "left switched off" path
    },
  })],
  // Must agree with _cat/allocation above and with _cluster/health below: three nodes,
  // all data-bearing, and the same disk figures. They disagreed before — allocation said
  // three nodes at 91/55/21%, nodes said two at 80/70% — so the Nodes page contradicted
  // itself on one screen and every QA run had to re-establish that the fixture, not the
  // app, was wrong.
  [(u) => u.startsWith('/_cat/nodes'), () => ([
    { name: 'node-1', ip: '10.0.0.1', version: '8.13.4', 'node.role': 'dim', master: '*',
      'heap.percent': '61', 'ram.percent': '70', cpu: '12', load_1m: '1.2',
      'disk.used': '91000000000', 'disk.avail': '9000000000', 'disk.total': '100000000000',
      'disk.used_percent': '91', uptime: '10d' },
    { name: 'node-2', ip: '10.0.0.2', version: '8.13.4', 'node.role': 'dim', master: '-',
      'heap.percent': '55', 'ram.percent': '66', cpu: '9', load_1m: '0.8',
      'disk.used': '55000000000', 'disk.avail': '45000000000', 'disk.total': '100000000000',
      'disk.used_percent': '55', uptime: '10d' },
    { name: 'node-3', ip: '10.0.0.3', version: '8.13.4', 'node.role': 'dim', master: '-',
      'heap.percent': '38', 'ram.percent': '52', cpu: '4', load_1m: '0.3',
      'disk.used': '21000000000', 'disk.avail': '79000000000', 'disk.total': '100000000000',
      'disk.used_percent': '21', uptime: '10d' }])],
  [(u) => u.startsWith('/_cat/indices'), () => INDICES],
  [(u) => u.startsWith('/_cat/shards'), () => ([
    { index: 'logstash-acme-2026.09.09', shard: '0', prirep: 'p', state: 'STARTED', node: 'node-1', store: '2500000000' },
    { index: 'logstash-acme-2026.09.09', shard: '0', prirep: 'r', state: 'STARTED', node: 'node-2', store: '2500000000' },
    { index: 'logstash-beta-2026.09.09', shard: '0', prirep: 'r', state: 'UNASSIGNED',
      'unassigned.reason': 'NODE_LEFT', node: null, store: '0' }])],
  [(u) => u.startsWith('/_cat/snapshots'), () => SNAPSHOTS],
  [(u) => u.startsWith('/_cat/aliases'), () => ([{ alias: 'logstash', index: 'logstash-acme-2026.09.09', is_write_index: 'true' }])],
  [(u) => /^\/_snapshot\/[^/]+\//.test(u), () => ({ snapshots: [
    // A good copy of every logstash index — but NOT of metrics-2026.09, which is therefore
    // "not in any snapshot" and must be ticked on purpose before it can be deleted.
    { snapshot: 'daily-1', state: 'SUCCESS',
      indices: INDICES.map((i) => i.index).filter((n) => n.startsWith('logstash-')),
      shards: { total: 10, successful: 10, failed: 0 }, failures: [],
      start_time_in_millis: Date.now() - 3600000, end_time_in_millis: Date.now() - 3300000,
      start_time: new Date(Date.now() - 3600000).toISOString(), end_time: new Date(Date.now() - 3300000).toISOString(),
      duration_in_millis: 300000, version: '8.13.4', include_global_state: false },
    // A PARTIAL snapshot that does list metrics-2026.09 — which must NOT count as a copy.
    { snapshot: 'daily-0', state: 'PARTIAL',
      indices: ['metrics-2026.09', 'logstash-acme-2026.09.09'],
      shards: { total: 10, successful: 8, failed: 2 },
      failures: [{ index: 'metrics-2026.09', shard_id: 0, reason: 'node left' }],
      start_time_in_millis: Date.now() - 90000000, end_time_in_millis: Date.now() - 89700000,
      start_time: new Date(Date.now() - 90000000).toISOString(), end_time: new Date(Date.now() - 89700000).toISOString(),
      duration_in_millis: 300000, version: '8.13.4', include_global_state: false },
  ] })],
  [(u) => u === '/_snapshot' || u.startsWith('/_snapshot?'), () => ({
    daily: { type: 'fs', settings: { location: '/mnt/backups', compress: true } } })],
  [(u) => u.startsWith('/_slm/status'), () => ({ operation_mode: 'RUNNING' })],
  [(u) => u.startsWith('/_slm/stats'), () => ({ retention_runs: 3, retention_failed: 0 })],
  [(u) => u.startsWith('/_slm/policy'), () => ({ nightly: {
    policy: { name: '<daily-{now/d}>', schedule: '0 30 1 * * ?', repository: 'daily',
      config: { indices: ['logstash-*'] }, retention: { expire_after: '30d', min_count: 7, max_count: 60 } },
    last_success: { time: Date.now() - 7200000, snapshot_name: 'daily-1' },
    next_execution_millis: Date.now() + 3600000 } })],
  [(u) => u.startsWith('/_ilm/status'), () => ({ operation_mode: 'RUNNING' })],
  [(u) => u.startsWith('/_ilm/policy'), () => ({
    'logs-retention': {
      version: 3, modified_date_string: '2026-08-01T00:00:00Z',
      policy: { phases: {
        hot: { min_age: '0ms', actions: { rollover: { max_age: '1d' } } },
        warm: { min_age: '7d', actions: { forcemerge: { max_num_segments: 1 } } },
        delete: { min_age: '30d', actions: { delete: {} } },
      } },
    },
  })],
  [(u) => /_settings\?filter_path=\*\.settings\.index\.lifecycle\.name/.test(u), () =>
    Object.fromEntries(INDICES.map((i) => [i.index, { settings: { index: { lifecycle: { name: 'logs-retention' } } } }]))],
  [(u) => u.includes('_ilm/explain'), () => ({ indices: { 'logstash-beta-2026.09.09': { step: 'ERROR' } } })],
  [(u) => u.startsWith('/_nodes/settings'), () => ({ nodes: { n1: { name: 'node-1',
    settings: { path: { repo: ['/mnt/backups'] } } } } })],
  [(u) => u.startsWith('/_nodes/stats'), () => ({ nodes: {} })],
  [(u) => u.startsWith('/_cluster/stats'), () => ({ indices: { docs: { count: 5000 }, store: { size_in_bytes: 16e9 } },
    nodes: { count: { total: 3 } } })],
  [(u) => u.startsWith('/_resolve/index'), () => ({ indices: INDICES.map((i) => ({ name: i.index })) })],
  [(u) => u.includes('/_settings'), () => ({ 'logstash-acme-2026.09.09': {
    settings: { 'index.number_of_replicas': '1', 'index.refresh_interval': '1s' } } })],
  // Field-volume aggregation: terms split by day, plus the day totals. One value spikes
  // on the latest complete day so the 40% rule has something to catch.
  [(u) => u.includes('/_search'), (hit) => {
    let body = {};
    try { body = JSON.parse(hit.body || '{}'); } catch { /* fall through to the hit list */ }
    if (body.aggs && body.aggs.terms) {
      const DAYS = 14;
      // UTC midnight, as a real date_histogram buckets by default.
      const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
      const dayMs = (n) => midnight.getTime() - n * 86400000;
      // oldest -> newest, ending today
      const keys = Array.from({ length: DAYS + 1 }, (_, i) => dayMs(DAYS - i));
      const shape = { 'fw-edge-01': 1000, 'fw-core-02': 600, 'proxy-03': 300, 'vpn-04': 120 };
      const spikeOn = dayMs(1);          // yesterday: the latest complete day
      const buckets = Object.entries(shape).map(([key, base]) => ({
        key,
        doc_count: base * DAYS,
        per_day: { buckets: keys.map((k) => ({
          key: k,
          // fw-edge-01 triples yesterday; everything else stays flat.
          doc_count: k === spikeOn && key === 'fw-edge-01' ? base * 3
                   : k === midnight.getTime() ? Math.round(base / 4)   // today is partial
                   : base,
        })) },
      }));
      const totalPerDay = keys.map((k) => ({
        key: k,
        doc_count: buckets.reduce((s, b) => s + (b.per_day.buckets.find((x) => x.key === k) || {}).doc_count, 0),
      }));
      return { took: 5, timed_out: false, hits: { total: { value: 0 }, hits: [] },
               aggregations: { terms: { buckets }, per_day_total: { buckets: totalPerDay } } };
    }
    return { took: 3, hits: { total: { value: 2 }, hits: [
    { _index: 'logstash-acme-2026.09.09', _id: '1', _source: { '@timestamp': new Date().toISOString(), message: 'hello' } },
    { _index: 'logstash-acme-2026.09.09', _id: '2', _source: { '@timestamp': new Date().toISOString(), message: 'world' } },
  ] }, aggregations: { over_time: { buckets: [] } } };
  }],
];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const url = req.url;
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !url.includes('_search')) {
      return res.end(JSON.stringify({ acknowledged: true }));   // fixture: writes are no-ops
    }
    const hit = routes.find(([match]) => match(url));
    res.end(JSON.stringify(hit ? hit[1]({ body, url }) : { acknowledged: true, url }));
  });
}).listen(port, '127.0.0.1', () => console.log(`mock elasticsearch on http://127.0.0.1:${port}`));
