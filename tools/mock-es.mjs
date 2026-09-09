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
    number_of_data_nodes: 2, active_shards: 40, active_primary_shards: 20, unassigned_shards: 2,
    relocating_shards: 0, initializing_shards: 0, active_shards_percent_as_number: 95 })],
  [(u) => u.startsWith('/_cat/allocation'), () => ([{ node: 'node-1', shards: '20',
    'disk.used': '80000000000', 'disk.avail': '20000000000', 'disk.total': '100000000000', 'disk.percent': '80' }])],
  [(u) => u.startsWith('/_cat/nodes'), () => ([
    { name: 'node-1', ip: '10.0.0.1', version: '8.13.4', 'node.role': 'dim', master: '*',
      'heap.percent': '61', 'ram.percent': '70', cpu: '12', load_1m: '1.2',
      'disk.used': '80000000000', 'disk.avail': '20000000000', 'disk.total': '100000000000',
      'disk.used_percent': '80', uptime: '10d' },
    { name: 'node-2', ip: '10.0.0.2', version: '8.13.4', 'node.role': 'dim', master: '-',
      'heap.percent': '55', 'ram.percent': '66', cpu: '9', load_1m: '0.8',
      'disk.used': '70000000000', 'disk.avail': '30000000000', 'disk.total': '100000000000',
      'disk.used_percent': '70', uptime: '10d' }])],
  [(u) => u.startsWith('/_cat/indices'), () => INDICES],
  [(u) => u.startsWith('/_cat/shards'), () => ([
    { index: 'logstash-acme-2026.09.09', shard: '0', prirep: 'p', state: 'STARTED', node: 'node-1', store: '2500000000' },
    { index: 'logstash-acme-2026.09.09', shard: '0', prirep: 'r', state: 'STARTED', node: 'node-2', store: '2500000000' },
    { index: 'logstash-beta-2026.09.09', shard: '0', prirep: 'r', state: 'UNASSIGNED',
      'unassigned.reason': 'NODE_LEFT', node: null, store: '0' }])],
  [(u) => u.startsWith('/_cat/snapshots'), () => SNAPSHOTS],
  [(u) => u.startsWith('/_cat/aliases'), () => ([{ alias: 'logstash', index: 'logstash-acme-2026.09.09', is_write_index: 'true' }])],
  [(u) => /^\/_snapshot\/[^/]+\//.test(u), () => ({ snapshots: [{ snapshot: 'daily-1', state: 'SUCCESS',
    indices: INDICES.map((i) => i.index), shards: { total: 10, successful: 10, failed: 0 }, failures: [],
    start_time: new Date(Date.now() - 3600000).toISOString(), end_time: new Date().toISOString(),
    duration_in_millis: 300000, version: '8.13.4', include_global_state: false }] })],
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
  [(u) => u.includes('_ilm/explain'), () => ({ indices: { 'logstash-beta-2026.09.09': { step: 'ERROR' } } })],
  [(u) => u.startsWith('/_nodes/settings'), () => ({ nodes: { n1: { name: 'node-1',
    settings: { path: { repo: ['/mnt/backups'] } } } } })],
  [(u) => u.startsWith('/_nodes/stats'), () => ({ nodes: {} })],
  [(u) => u.startsWith('/_cluster/stats'), () => ({ indices: { docs: { count: 5000 }, store: { size_in_bytes: 16e9 } },
    nodes: { count: { total: 3 } } })],
  [(u) => u.startsWith('/_resolve/index'), () => ({ indices: INDICES.map((i) => ({ name: i.index })) })],
  [(u) => u.includes('/_settings'), () => ({ 'logstash-acme-2026.09.09': {
    settings: { 'index.number_of_replicas': '1', 'index.refresh_interval': '1s' } } })],
  [(u) => u.includes('/_search'), () => ({ took: 3, hits: { total: { value: 2 }, hits: [
    { _index: 'logstash-acme-2026.09.09', _id: '1', _source: { '@timestamp': new Date().toISOString(), message: 'hello' } },
    { _index: 'logstash-acme-2026.09.09', _id: '2', _source: { '@timestamp': new Date().toISOString(), message: 'world' } },
  ] }, aggregations: { over_time: { buckets: [] } } })],
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
    res.end(JSON.stringify(hit ? hit[1]() : { acknowledged: true, url }));
  });
}).listen(port, '127.0.0.1', () => console.log(`mock elasticsearch on http://127.0.0.1:${port}`));
