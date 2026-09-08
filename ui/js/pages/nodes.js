/** Page 6 — nodes, shard allocation and unassigned-shard reasons. */

import { h, mount } from '../lib/dom.js';
import { bytes, num, pct, dur, toCsv, download } from '../lib/fmt.js';
import { state, client, activeClusters } from '../core/state.js';
import { hbarList } from '../lib/charts.js';
import { card, pill, statTile, table, empty } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';

let host = null;
const cache = new Map();

export function render(el) { host = el; draw(); loadShards(); }
export function onData() { if (host && host.isConnected) draw(); }

async function loadShards() {
  if (isSnapshotMode()) {
    for (const c of activeClusters()) {
      const d = state.data.get(c.id) || {};
      cache.set(c.id, (d.shards || []).filter((r) => r.state !== 'STARTED'));
    }
    draw();
    return;
  }
  for (const c of activeClusters()) {
    try {
      const rows = await client(c.id).shardsUnassigned();
      cache.set(c.id, rows.filter((r) => r.state !== 'STARTED'));
    } catch (_) { cache.set(c.id, []); }
  }
  draw();
}

function draw() {
  const list = activeClusters();
  mount(host, ...list.map(block), list.length ? null : empty('No cluster selected'));
}

function block(c) {
  const d = state.data.get(c.id) || {};
  const nodes = d.nodes || [];
  const problem = cache.get(c.id) || [];

  const dataNodes = nodes.filter((n) => String(n['node.role'] || '').match(/[dhcws]/));
  const trs = nodes.map((n) => {
    const used = Number(n['disk.used']) || 0, total = Number(n['disk.total']) || 0;
    const p = total ? (used / total) * 100 : NaN;
    const cls = p >= state.defaults.diskCritPercent ? 'red' : p >= state.defaults.diskWarnPercent ? 'yellow' : 'green';
    const heap = Number(n['heap.percent']);
    return h('tr',
      h('td', h('div', { style: { fontWeight: 620 } }, n.name, n.master === '*' ? h('span.pill.grey', { style: { marginLeft: '6px' } }, 'master') : null),
        h('div.mono.muted', { style: { fontSize: '11px' } }, n.ip)),
      h('td.mono', { style: { fontSize: '11.5px' } }, n['node.role']),
      h('td.mono', { style: { fontSize: '11.5px' } }, n.version || '–'),
      h('td.num', h('span', { style: { color: heap >= 85 ? 'var(--critical)' : heap >= 75 ? 'var(--warning)' : 'inherit' } }, `${heap}%`)),
      h('td.num', `${n['ram.percent']}%`),
      h('td.num', `${n.cpu}%`),
      h('td.num', `${n['load_1m'] ?? '–'} / ${n['load_5m'] ?? '–'}`),
      h('td', h('div', { style: { minWidth: '150px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' } },
          h('span', isFinite(p) ? pct(p) : '–'), h('span.muted', `${bytes(used)} / ${bytes(total)}`)),
        h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, p || 0))}%`,
          background: cls === 'red' ? 'var(--critical)' : cls === 'yellow' ? 'var(--warning)' : 'var(--good)' } })))),
      h('td.mono.nowrap', { style: { fontSize: '11.5px' } }, n.uptime || '–'));
  });

  const shardTrs = problem.slice(0, 200).map((s) => h('tr',
    h('td.mono', { style: { fontSize: '11.5px' } }, s.index),
    h('td.num', s.shard),
    h('td', s.prirep === 'p' ? h('span.pill.grey', 'primary') : h('span.pill.grey', 'replica')),
    h('td', pill(s.state, s.state === 'UNASSIGNED' ? 'red' : 'yellow')),
    h('td.mono', { style: { fontSize: '11.5px' } }, s['unassigned.reason'] || '–'),
    h('td.mono.muted', { style: { fontSize: '11.5px' } }, s.node || '–')));

  return h('section', { style: { marginBottom: '22px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } },
      h('h2', { style: { fontSize: '14px', margin: 0 } }, c.name),
      h('span.mono.muted', { style: { fontSize: '11.5px' } }, c.url),
      d.health ? pill(d.health.status, d.health.status) : null),

    h('div.grid.c4', { style: { marginBottom: '14px' } },
      statTile('Nodes', String(nodes.length), `${dataNodes.length} data`),
      statTile('Active shards', d.health ? num(d.health.active_shards) : '–', d.health ? pct(d.health.active_shards_percent_as_number) : ''),
      statTile('Unassigned', d.health ? num(d.health.unassigned_shards) : '–', d.health ? `${d.health.relocating_shards} relocating` : ''),
      statTile('Pending tasks', d.health ? num(d.health.number_of_pending_tasks) : '–',
        d.health ? `max wait ${dur(d.health.task_max_waiting_in_queue_millis)}` : '')),

    h('div.grid.c2', { style: { marginBottom: '14px' } },
      card('Heap used by node', 'JVM heap percentage', nodes.length
        ? hbarList(nodes.map((n) => ({ key: n.name, label: n.name, value: Number(n['heap.percent']) || 0,
            color: Number(n['heap.percent']) >= 85 ? 'var(--critical)' : Number(n['heap.percent']) >= 75 ? 'var(--warning)' : 'var(--series-1)' })),
            { format: (v) => `${v}%`, topN: 14, labelWidth: 150, showOther: false })
        : empty('No node data')),
      card('Disk used by node', 'from _cat/nodes', nodes.length
        ? hbarList(nodes.map((n) => ({ key: n.name, label: n.name, value: Number(n['disk.used']) || 0,
            sub: `of ${bytes(Number(n['disk.total']) || 0)}` })), { format: bytes, topN: 14, labelWidth: 150, showOther: false })
        : empty('No node data'))),

    card('Nodes', `${nodes.length} node(s)`,
      table(['Node', 'Roles', 'Version', { label: 'Heap', num: true }, { label: 'RAM', num: true }, { label: 'CPU', num: true },
             { label: 'Load 1m/5m', num: true }, 'Disk', 'Uptime'], trs, { emptyText: 'No nodes returned' }),
      [h('button.btn.sm', { disabled: !nodes.length, onclick: () => download(`nodes-${c.id}.csv`, toCsv(nodes), 'text/csv') }, 'Export CSV')]),

    problem.length
      ? h('div', { style: { marginTop: '14px' } },
          card('Shards not started', `${problem.length} shard(s)`,
            table(['Index', { label: 'Shard', num: true }, 'Type', 'State', 'Reason', 'Node'], shardTrs)))
      : null);
}
