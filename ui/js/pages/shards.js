/**
 * Page — nodes and shards: what the cluster is made of, and moving pieces of it.
 *
 * Shards lead because they are the unit of work: an index is only as available as its
 * shards, a full disk is a placement problem, and a yellow cluster is a shard with
 * nowhere to go. The nodes are here in full underneath — roles, heap, load, disk — both
 * because choosing where to move a shard needs them and because "which node is master,
 * and is it struggling" is asked at the same moment as "where is this shard".
 */

import { h, mount } from '../lib/dom.js';
import { bytes, num, pct, compact } from '../lib/fmt.js';
import { state, clusters, activeClusters, client, refreshAll, fetchIndices,
         diskAccounting, setDangling, danglingFor } from '../core/state.js';
import { card, statTile, table, empty, pill, connectionBanner } from './common.js';
import { modal, field, select, val, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/menu.js';
import { ensureWrites, writeToggle, writesAllowed } from '../core/writes.js';
import { honeycomb, STATUS } from '../lib/charts.js';
import { parseRetention } from '../core/volume.js';

let host = null;
const ui = { index: '', node: 'all', state: 'all', limit: 300, sort: 'index', dir: 1 };
/** Shards ticked for a bulk move, keyed `index/shard/p|r`. */
const picked = new Map();
/** Tasks, thread pools and pending cluster tasks — one read each, with the shard list. */
const load2 = new Map();
/** Shard listings per cluster — one _cat call, on demand rather than every refresh. */
const shards = new Map();
const loading = new Set();

export function render(el) {
  host = el;
  el.classList.add('dense');
  draw();
  refresh();
}
export function onData() {
  if (!host || !host.isConnected) return;
  draw();
  refresh();
}

/**
 * Load anything not loaded yet.
 *
 * Re-checked on every visit and every data event, not only on the first render. The first
 * version cached the result — including a failure — for the life of the page module, so a
 * cluster that was still connecting when you first opened this page stayed blank until a
 * full reload, while every other page filled in. A failure is worth keeping only until
 * there is a reason to think it would go differently.
 */
function refresh() {
  for (const c of activeClusters()) {
    const got = shards.get(c.id);
    const worthRetrying = !got || (got.error && isReachable(c.id));
    if (worthRetrying && !loading.has(c.id)) load(c);
    // The index list is what the disk accounting is compared against; only the Indices
    // page fetches it otherwise.
    if (!state.indices.get(c.id)) fetchIndices(c.id, '*').catch(() => {});
  }
}

const isReachable = (id) => !!(state.data.get(id) || {}).reachable;

async function load(c) {
  const cl = client(c.id);
  if (!cl) return;
  loading.add(c.id); draw();
  try {
    shards.set(c.id, await cl.shardsAll());
  } catch (e) {
    shards.set(c.id, { error: e.message || String(e) });
  } finally {
    loading.delete(c.id); draw();
  }
  // What the cluster is busy doing. Separate from the shard read so one failing does not
  // take the other with it — an old cluster without _cat/tasks should still list shards.
  try {
    const [tasks, pools, pending] = await Promise.all([
      cl.tasks().catch(() => null),
      cl.threadPools().catch(() => null),
      cl.pendingTasks().catch(() => null),
    ]);
    load2.set(c.id, { tasks, pools, pending: pending && pending.tasks, at: Date.now() });
    draw();
  } catch (_) { /* the rest of the page does not depend on it */ }

  // Only worth asking when the figures disagree; the answer decides what the gap is.
  try {
    const acct = diskAccounting(state.data.get(c.id) || {}, state.indices.get(c.id));
    if (acct.material) {
      const res = await cl.danglingIndices();
      setDangling(c.id, { indices: (res && res.dangling_indices) || [], at: Date.now() });
      draw();
    }
  } catch (_) { /* the alert says to look here; it does not depend on this succeeding */ }
}

function draw() {
  if (!host || !host.isConnected) return;
  const list = activeClusters();
  if (!list.length) return mount(host, empty('No cluster selected'));
  mount(host, ...list.map((c) => h('div', { style: { marginBottom: '14px' } }, block(c))));
}

/* --------------------------------- one cluster --------------------------------- */

function block(c) {
  const d = state.data.get(c.id) || {};
  if (!d.reachable) return connectionBanner(c, () => refreshAll({ force: true, selected: true }));

  const raw = shards.get(c.id);
  const all = Array.isArray(raw) ? raw.map(normalise) : [];

  const started = all.filter((s) => s.state === 'STARTED');
  const moving = all.filter((s) => s.state === 'RELOCATING' || s.state === 'INITIALIZING');
  const unassigned = all.filter((s) => s.state === 'UNASSIGNED');
  const nodes = d.nodes || [];

  return h('div', { style: { display: 'grid', gap: '10px' } },
    h('div.grid.c4',
      statTile('Nodes', num(nodes.length), d.master ? `master ${d.master}` : 'no master elected'),
      statTile('Shards', num(all.length), c.name),
      statTile('Unassigned', num(unassigned.length),
        unassigned.length ? 'not placed on any node' : 'every shard is placed'),
      statTile('Moving', num(moving.length), moving.length ? 'relocating or initialising' : 'nothing in flight')),

    combCard(c, all),
    nodesCard(c, d),
    loadCard(c),
    accountingCard(c, d),
    shardsCard(c, d, all, raw, started));
}

/**
 * Every shard as one cell, coloured by state.
 *
 * The table below is the right tool once you know which shard you want. This is for
 * before that: a few hundred rows is a scroll nobody does, and "are any of them unhappy,
 * and is it one index or all of them" is answered here in a glance. Clicking a cell
 * filters the table to that index, so the two halves work as one.
 */
function combCard(c, all) {
  if (all.length < 2) return null;
  const colour = (st) => (st === 'STARTED' ? STATUS.good
    : st === 'RELOCATING' || st === 'INITIALIZING' ? STATUS.warning
    : st === 'UNASSIGNED' ? STATUS.critical : 'var(--surface-3)');

  // Unhealthy first, so a handful of bad cells among hundreds are together and visible
  // rather than scattered through the grid in index order.
  const counts = all.reduce((m, s) => { m[s.state] = (m[s.state] || 0) + 1; return m; }, {});
  const rank = (s) => (s.state === 'UNASSIGNED' ? 0 : s.state === 'STARTED' ? 2 : 1);
  const items = [...all].sort((a, b) => rank(a) - rank(b) || a.index.localeCompare(b.index))
    .map((s) => ({
      key: `${s.index}/${s.shard}/${s.primary ? 'p' : 'r'}`,
      label: `${s.index}[${s.shard}] ${s.primary ? 'primary' : 'replica'}`,
      state: s.state.toLowerCase(),
      color: colour(s.state),
      detail: s.node ? `on ${s.node}${s.store ? ` · ${bytes(s.store)}` : ''}`
                     : (s.reason ? s.reason.replace(/_/g, ' ').toLowerCase() : 'not placed'),
    }));

  const sub = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${num(v)} ${k.toLowerCase()}`).join(' · ');

  return card('Shard states', sub,
    honeycomb(items, {
      legendFor: [
        { label: 'started', color: STATUS.good, count: counts.STARTED || 0 },
        { label: 'moving', color: STATUS.warning,
          count: (counts.RELOCATING || 0) + (counts.INITIALIZING || 0) },
        { label: 'unassigned', color: STATUS.critical, count: counts.UNASSIGNED || 0 },
      ],
      onSelect: (it) => { ui.index = String(it.key).split('/')[0]; draw(); },
    }));
}

/** A task running longer than this is worth looking at rather than scrolling past. */
const SLOW_TASK_MS = 30000;

/**
 * What the cluster is doing right now, and whether it is coping.
 *
 * Three readings that answer different halves of "is it busy or is it struggling".
 * Active and queued work says busy. Rejected work says struggling — a thread pool only
 * rejects once its queue is full, so a non-zero number there is dropped work, not slow
 * work. Pending cluster tasks say the master is behind, which looks like everything
 * being slow for reasons nothing else explains.
 *
 * The long-running list excludes the perpetual ones. `geoip-downloader` and the monitor
 * tasks run for the life of the node; showing them as "slow queries" would bury the one
 * search that actually is.
 */
const PERPETUAL = /geoip-downloader|cluster:monitor\/tasks\/lists|health-node|persistent/i;

function loadCard(c) {
  const got = load2.get(c.id);
  if (!got) return null;
  // Arrays or nothing. A cluster that does not have one of these endpoints answers with
  // whatever its router does for an unknown path, and an object here reaches .filter as a
  // crash rather than as a missing card.
  const arr = (v) => (Array.isArray(v) ? v : []);
  const tasks = arr(got.tasks);
  const pools = arr(got.pools);
  const pending = arr(got.pending);
  if (!tasks.length && !pools.length && !pending.length) return null;

  const real = tasks.filter((t) => !PERPETUAL.test(`${t.action} ${t.type}`));
  const slow = real
    .map((t) => ({ ...t, ms: Number(t.running_time_ns || 0) / 1e6 }))
    .filter((t) => t.ms >= SLOW_TASK_MS)
    .sort((a, b) => b.ms - a.ms);

  const rejected = pools.reduce((n, p) => n + (Number(p.rejected) || 0), 0);
  const queued = pools.reduce((n, p) => n + (Number(p.queue) || 0), 0);
  const active = pools.reduce((n, p) => n + (Number(p.active) || 0), 0);

  const poolTrs = pools
    .filter((p) => Number(p.active) || Number(p.queue) || Number(p.rejected))
    .map((p) => h('tr',
      h('td', p.node_name), h('td.mono', p.name),
      h('td.num', num(Number(p.active) || 0)),
      h('td.num', num(Number(p.queue) || 0)),
      h('td.num', Number(p.rejected)
        ? h('b', { style: { color: 'var(--critical)' } }, num(Number(p.rejected)))
        : '0'),
      h('td.num.muted', num(Number(p.completed) || 0))));

  const health = rejected ? { label: 'rejecting work', cls: 'red' }
    : pending.length > 5 ? { label: 'master behind', cls: 'yellow' }
    : slow.length ? { label: 'slow work running', cls: 'yellow' }
    : queued ? { label: 'busy', cls: 'yellow' }
    : { label: 'idle', cls: 'green' };

  return card('Cluster load',
    `${num(real.length)} task(s) · ${num(active)} active · ${num(queued)} queued · `
    + `${num(rejected)} rejected · ${num(pending.length)} pending state change(s)`,
    h('div', { style: { display: 'grid', gap: '10px' } },
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        pill(health.label, health.cls),
        rejected
          ? h('span.muted', { style: { fontSize: '11.5px' } },
              'a thread pool only rejects once its queue is full — this is dropped work, not slow work')
          : null),

      slow.length
        ? h('div',
            h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' } },
              `running longer than ${Math.round(SLOW_TASK_MS / 1000)}s`),
            table(['Action', 'Node', { label: 'Running', num: true }, 'Detail'],
              slow.slice(0, 10).map((t) => h('tr',
                h('td.mono', { style: { fontSize: '11px' } }, t.action),
                h('td', t.node),
                h('td.num', h('b', { style: { color: t.ms > 300000 ? 'var(--critical)' : 'var(--warning)' } },
                  t.running_time)),
                h('td.muted', { style: { fontSize: '11px', maxWidth: '340px', wordBreak: 'break-word' } },
                  t.description || ''))),
              { emptyText: '' }))
        : h('div.muted', { style: { fontSize: '12px' } },
            real.length ? 'Nothing has been running long enough to be worth a look.'
                        : 'No tasks in flight.'),

      poolTrs.length
        ? h('div',
            h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' } }, 'thread pools with work'),
            table(['Node', 'Pool', { label: 'Active', num: true }, { label: 'Queued', num: true },
                   { label: 'Rejected', num: true }, { label: 'Completed', num: true }], poolTrs))
        : null,

      pending.length
        ? h('div.banner.warn', { style: { margin: 0 } },
            h('div', h('div.ttl', `${num(pending.length)} cluster-state change(s) waiting on the master`),
              h('div.mono', { style: { fontSize: '11px' } },
                pending.slice(0, 4).map((t) => `${t.source} (${t.time_in_queue || ''})`).join(' · '))))
        : null));
}

/** Everything _cat/nodes knows, which is what "is this node healthy" is answered from. */
function nodesCard(c, d) {
  const nodes = d.nodes || [];
  if (!nodes.length) return card('Nodes', 'none reported', empty('The cluster did not return a node list.'));
  const alloc = (d.disk && d.disk.nodes) || [];

  const trs = nodes.map((n) => {
    const a = alloc.find((x) => x.node === n.name) || {};
    const used = Number(n['disk.used']) || Number(a['disk.used']) || 0;
    const total = Number(n['disk.total']) || Number(a['disk.total']) || 0;
    const p = total ? (used / total) * 100 : NaN;
    const heap = Number(n['heap.percent']);
    const isMaster = String(n.master || '').trim() === '*';
    return h('tr',
      h('td', h('div', { style: { fontWeight: 620 } }, n.name,
        isMaster ? h('span', { style: { marginLeft: '6px' } }, pill('master', 'blue')) : null),
        h('div.mono.muted', { style: { fontSize: '10.5px' } }, n.ip || '')),
      h('td', h('span.mono', { style: { fontSize: '11px' }, title: roleTitle(n['node.role']) },
        n['node.role'] || '–')),
      h('td.muted', { style: { fontSize: '11.5px' } }, n.version || ''),
      h('td.num', isFinite(heap) ? heapCell(heap, n) : '–'),
      h('td.num', n['ram.percent'] ? `${n['ram.percent']}%` : '–'),
      h('td.num', n.cpu ? `${n.cpu}%` : '–'),
      h('td.num.muted', `${n.load_1m || '–'} / ${n.load_5m || '–'}`),
      h('td', diskBar(used, total, p, Number(a.shards) || null)),
      h('td.muted', { style: { fontSize: '11.5px' } }, n.uptime || ''));
  });

  return card('Nodes', `${nodes.length} node(s)${d.master ? ` · master ${d.master}` : ' · no master'}`,
    table(['Node', 'Roles', 'Version', { label: 'Heap', num: true }, { label: 'RAM', num: true },
           { label: 'CPU', num: true }, { label: 'Load 1m/5m', num: true }, 'Disk', 'Uptime'],
      trs, { emptyText: 'No nodes returned' }));
}

function heapCell(p, n) {
  const colour = p >= 85 ? 'var(--critical)' : p >= 75 ? 'var(--warning)' : 'inherit';
  const cur = Number(n['heap.current']), max = Number(n['heap.max']);
  return h('span', { style: { color: colour, fontWeight: p >= 75 ? 640 : 400 },
    title: isFinite(cur) && isFinite(max) ? `${bytes(cur)} of ${bytes(max)}` : '' }, `${p}%`);
}

function diskBar(used, total, p, shardCount) {
  if (!total) return h('span.muted', '–');
  const colour = p >= 90 ? 'var(--critical)' : p >= 80 ? 'var(--warning)' : 'var(--good)';
  return h('div', { style: { display: 'grid', gap: '3px', minWidth: '170px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' } },
      h('span', `${p.toFixed(1)}%`),
      h('span.muted', `${bytes(total - used)} free${shardCount !== null ? ` · ${num(shardCount)} shards` : ''}`)),
    h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, p))}%`, background: colour } })));
}

/**
 * The letters _cat/nodes uses for roles, spelled out.
 *
 * "cdfhilmrstw" is not readable, and the difference between a node that holds data and
 * one that only coordinates is the first thing you want when a shard will not place.
 */
const ROLE_LETTERS = {
  c: 'cold', d: 'data', f: 'frozen', h: 'hot', i: 'ingest', l: 'machine learning',
  m: 'master-eligible', r: 'remote cluster client', s: 'content', t: 'transform',
  v: 'voting only', w: 'warm', '-': 'coordinating only',
};
function roleTitle(letters) {
  return [...String(letters || '')].map((x) => ROLE_LETTERS[x] || x).join(', ');
}

/**
 * Disk Elasticsearch holds against disk any index accounts for.
 *
 * Shown only when they disagree materially. Agreeing is the normal case and a card saying
 * "these two numbers match" every time is a card nobody reads.
 */
function accountingCard(c, d) {
  const acct = diskAccounting(d, state.indices.get(c.id));
  const dang = danglingFor(c.id);
  const stale = staleIndices(c, state.indices.get(c.id));

  // The two figures are always worth showing — "how much do the indices hold against how
  // much is on disk" is asked whether or not they disagree. The explanation below only
  // appears when they do.
  const figures = h('div', { style: { display: 'flex', gap: '20px', flexWrap: 'wrap' } },
    figure('Indices hold', acct.known ? bytes(acct.accounted) : '–',
      acct.known ? `${num((state.indices.get(c.id) || []).length)} indices` : 'index list not read yet'),
    figure('Elasticsearch holds', d.disk ? bytes(d.disk.indicesBytes || 0) : '–', 'on the data path'),
    figure('Disk used', d.disk ? bytes(d.disk.used || 0) : '–',
      d.disk && isFinite(d.disk.percent) ? `${d.disk.percent.toFixed(1)}% of ${bytes(d.disk.total)}` : ''),
    figure('Unaccounted', acct.known ? bytes(Math.max(0, acct.gap)) : 'unknown',
      acct.known ? (acct.material ? 'worth a look' : 'within rounding') : 'needs the index list'));

  const body = [figures];

  if (acct.material) {
    body.push(h('div.banner.warn', { style: { margin: 0 } },
      h('div',
        h('div.ttl', `${bytes(acct.gap)} on disk that no index accounts for`),
        h('div', { style: { fontSize: '12px' } },
          'Data the cluster state does not know about — a dangling index left by a removed '
          + 'node, or shard directories orphaned by a failed relocation. Deleting an index '
          + 'will not reclaim it, because there is no index to delete.'))));
    body.push(dang === null
      ? h('div.muted', { style: { fontSize: '12px' } }, 'Checking for dangling indices…')
      : (dang.indices || []).length
        ? h('div',
            h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' } }, 'dangling'),
            table(['Index', 'UUID', 'Created'], dang.indices.map((r) => h('tr',
              h('td.mono', r.index_name),
              h('td.mono.muted', { style: { fontSize: '10.5px' } }, r.index_uuid),
              h('td.muted', { style: { fontSize: '11.5px' } }, r.creation_date_millis
                ? new Date(r.creation_date_millis).toISOString().slice(0, 10) : '')))))
        : h('div.muted', { style: { fontSize: '12px' } },
            'No dangling indices, so the gap is orphaned shard data rather than a lost index. '
            + 'A rolling restart of the affected node clears directories it no longer owns.'));
  }

  if (stale.list.length) {
    body.push(h('div',
      h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' } },
        `past the ${stale.policy} retention policy — ${bytes(stale.bytes)} across ${num(stale.list.length)} indices`),
      table([{ label: 'Index', sort: null }, 'Day', { label: 'Size', num: true }],
        stale.list.slice(0, 12).map((i) => h('tr',
          h('td.mono', i.index), h('td.muted', i.day), h('td.num', bytes(i.size || 0)))),
        { emptyText: '' }),
      stale.list.length > 12
        ? h('div.muted', { style: { fontSize: '11px' } }, `…and ${num(stale.list.length - 12)} more`)
        : null));
  }

  const sub = acct.material ? `${bytes(acct.gap)} unexplained`
    : stale.list.length ? `${num(stale.list.length)} indices past retention`
    : 'indices and disk agree';
  return card('Storage accounting', sub, h('div', { style: { display: 'grid', gap: '10px' } }, ...body));
}

function figure(label, value, sub) {
  return h('div', { style: { minWidth: '140px' } },
    h('div.muted', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.03em' } }, label),
    h('div', { style: { fontSize: '17px', fontWeight: 660 } }, value),
    sub ? h('div.muted', { style: { fontSize: '11px' } }, sub) : null);
}

/**
 * Indices whose data is older than the retention this cluster promises.
 *
 * "Stale" in the sense that matters when disk is short: still on disk, still costing,
 * and past the point the policy said they would be kept. Read from the date in the index
 * name, so a cluster whose indices are not dated reports none rather than guessing.
 */
function staleIndices(c, indices) {
  const ret = parseRetention(c.liveRetention);
  if (!ret || !Array.isArray(indices)) return { list: [], bytes: 0, policy: '' };
  const cutoff = new Date(Date.now() - ret.days * 86400000).toISOString().slice(0, 10);
  const list = indices.filter((i) => i.day && i.day < cutoff)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return { list, bytes: list.reduce((n, i) => n + (i.size || 0), 0), policy: ret.label };
}

/** _cat gives strings; everything downstream wants the numbers as numbers. */
function normalise(r) {
  return {
    index: r.index,
    shard: Number(r.shard),
    primary: r.prirep === 'p',
    state: String(r.state || '').toUpperCase(),
    node: r.node || '',
    store: Number(r.store) || 0,
    docs: Number(r.docs) || 0,
    reason: r['unassigned.reason'] || '',
  };
}

/**
 * The nodes, as somewhere to put a shard.
 *
 * Shard count and free disk together, because choosing a target needs both: the emptiest
 * node is the wrong answer if it is also the fullest, and Elasticsearch will refuse the
 * move at the high watermark anyway.
 */
function nodeStrip(c, d, all) {
  const rows = (d.disk && d.disk.nodes) || [];
  if (!rows.length) return null;
  const counted = new Map();
  all.forEach((s) => { if (s.node) counted.set(s.node, (counted.get(s.node) || 0) + 1); });

  const tiles = rows.map((n) => {
    const used = Number(n['disk.used']) || 0;
    const total = Number(n['disk.total']) || 0;
    const p = total ? (used / total) * 100 : 0;
    const colour = p >= 90 ? 'var(--critical)' : p >= 80 ? 'var(--warning)' : 'var(--good)';
    return h('div', { style: { display: 'grid', gap: '3px', minWidth: '160px', flex: '1 1 160px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11.5px' } },
        h('b', n.node),
        h('span.muted', `${num(counted.get(n.node) || Number(n.shards) || 0)} shards`)),
      h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, p))}%`, background: colour } })),
      h('div.muted', { style: { fontSize: '10.5px' } },
        `${bytes(Number(n['disk.avail']) || 0)} free of ${bytes(total)}`));
  });
  return card('Nodes', 'where a shard can go, and the disk left to put it on',
    h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } }, ...tiles));
}

function shardsCard(c, d, all, raw, started) {
  // Every reason the table can be empty, said out loud. "Nothing here" was indisputably
  // the worst of the states this page could be in: it looks the same whether the listing
  // failed, has not been asked for yet, or genuinely came back with no shards.
  const why = loading.has(c.id) ? 'Reading the shard table…'
    : raw && raw.error ? null
    : raw === undefined ? 'The shard table has not been read yet.'
    : !all.length ? 'Elasticsearch returned no shards for this cluster.'
    : null;
  if (raw && raw.error) {
    return card(`Shards — ${c.name}`, 'could not be read',
      h('div', { style: { display: 'grid', gap: '8px' } },
        h('div.banner.err', { style: { margin: 0 } },
          h('div', h('div.ttl', 'The shard listing failed'), h('div.mono', raw.error))),
        h('div', h('button.btn.sm', { onclick: () => load(c) }, '↻ Try again'))));
  }

  const nodeNames = [...new Set(all.map((s) => s.node).filter(Boolean))].sort();
  const states = [...new Set(all.map((s) => s.state))].sort();

  const filtered = all.filter((s) => {
    if (ui.index && !s.index.toLowerCase().includes(ui.index.toLowerCase())) return false;
    if (ui.node !== 'all' && s.node !== ui.node) return false;
    if (ui.state !== 'all' && s.state !== ui.state) return false;
    return true;
  });
  const SHARD_SORTS = {
    index: (x) => x.index, shard: (x) => x.shard, type: (x) => (x.primary ? 0 : 1),
    state: (x) => x.state, node: (x) => x.node || '\uffff', store: (x) => x.store, docs: (x) => x.docs,
  };
  const sortKey = SHARD_SORTS[ui.sort] || SHARD_SORTS.index;
  const sorted = [...filtered].sort((a, b) => {
    const av = sortKey(a), bv = sortKey(b);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * ui.dir;
    return String(av).localeCompare(String(bv)) * ui.dir;
  });
  const shown = sorted.slice(0, ui.limit);

  const key = (x) => `${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`;
  const trs = shown.map((s) => h('tr',
    h('td', { style: { width: '26px' } }, s.state === 'STARTED'
      ? h('input', { type: 'checkbox', checked: picked.has(key(s)),
          title: 'Include this shard in a bulk move',
          onchange: (e) => {
            if (e.target.checked) picked.set(key(s), { ...s, clusterId: c.id }); else picked.delete(key(s));
            draw();
          } })
      : null),
    h('td.mono', { style: { maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: s.index }, s.index),
    h('td.num', String(s.shard)),
    h('td', s.primary ? pill('primary', 'blue') : pill('replica', 'grey')),
    h('td', stateCell(s)),
    h('td', s.node || h('span.muted', '–')),
    h('td.num', s.store ? bytes(s.store) : '–'),
    h('td.num', s.docs ? compact(s.docs) : '–'),
    h('td.muted', { style: { fontSize: '11px', maxWidth: '200px', wordBreak: 'break-word' } },
      s.reason ? s.reason.replace(/_/g, ' ').toLowerCase() : ''),
    h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
      s.state === 'STARTED'
        ? h('button.btn.sm', {
            title: writesAllowed() ? 'Move this shard to another node' : 'Allow writes first',
            onclick: () => moveOne(c, d, s),
          }, 'Move…')
        : null))));

  const controls = h('div.toolbar',
    h('label.field', 'Index',
      h('input', { type: 'search', value: ui.index, placeholder: 'filter by name', style: { width: '200px' },
        oninput: (e) => { ui.index = e.target.value; draw(); } })),
    h('label.field', 'Node', (() => {
      const sel = h('select', { onchange: (e) => { ui.node = e.target.value; draw(); } },
        h('option', { value: 'all' }, 'any node'), ...nodeNames.map((n) => h('option', { value: n }, n)));
      sel.value = ui.node; return sel;
    })()),
    h('label.field', 'State', (() => {
      const sel = h('select', { onchange: (e) => { ui.state = e.target.value; draw(); } },
        h('option', { value: 'all' }, 'any state'), ...states.map((n) => h('option', { value: n }, n)));
      sel.value = ui.state; return sel;
    })()),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
      writeToggle(draw),
      h('button.btn.sm', {
        title: 'Ask Elasticsearch to try the allocations it gave up on. Safe: it retries, it does not force.',
        onclick: () => retry(c),
      }, 'Retry failed allocations'),
      h('button.btn.sm', { onclick: () => load(c) }, '↻ Reload shards')));

  const mine = [...picked.values()].filter((x) => x.clusterId === c.id);
  const bulkBar = mine.length
    ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 10px',
                          background: 'var(--accent-soft)', borderRadius: '4px', marginBottom: '6px' } },
        h('b', { style: { fontSize: '12px' } }, `${num(mine.length)} shard(s) ticked`),
        h('span.muted', { style: { fontSize: '11px' } },
          `${bytes(mine.reduce((n, x) => n + (x.store || 0), 0))} in total`),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
          h('button.btn.sm.primary', { onclick: () => moveMany(c, d, mine) }, 'Move them…'),
          h('button.btn.sm.ghost', { onclick: () => { mine.forEach((x) => picked.delete(`${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`)); draw(); } }, 'Clear')))
    : null;

  const sub = `${num(filtered.length)} of ${num(all.length)} shard(s)`
    + (shown.length < filtered.length ? ` · showing the first ${num(shown.length)}` : '');

  return card(`Shards — ${c.name}`, why || sub,
    h('div', controls, bulkBar,
      why ? h('div', { style: { padding: '14px' } }, empty(why)) : null,
      table([tickAll(shown.filter((x) => x.state === 'STARTED'), c),
           { label: 'Index', sort: 'index' }, { label: 'Shard', num: true, sort: 'shard' },
           { label: 'Type', sort: 'type' }, { label: 'State', sort: 'state' },
           { label: 'Node', sort: 'node' }, { label: 'Store', num: true, sort: 'store' },
           { label: 'Docs', num: true, sort: 'docs' }, 'Unassigned reason', ''],
        trs, { emptyText: all.length ? 'No shard matches the filter' : 'No shards reported' }),
      shown.length < filtered.length
        ? h('div', { style: { padding: '10px', textAlign: 'center' } },
            h('button.btn.sm', { onclick: () => { ui.limit += 300; draw(); } },
              `Show more (${num(filtered.length - shown.length)} hidden)`))
        : null));
}

/** The header tick: select every movable shard currently shown, or none of them. */
function tickAll(movable, c) {
  const allOn = movable.length > 0 && movable.every((x) => picked.has(`${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`));
  return {
    label: h('input', { type: 'checkbox', checked: allOn,
      title: allOn ? 'Clear the selection' : 'Tick every started shard shown',
      onchange: () => {
        movable.forEach((x) => {
          const k = `${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`;
          if (allOn) picked.delete(k); else picked.set(k, { ...x, clusterId: c.id });
        });
        draw();
      } }),
  };
}

/**
 * Move several shards to one node.
 *
 * Elasticsearch takes a list of reroute commands in a single call and applies them as one
 * decision, which is better than looping: it can refuse the batch as a whole if the
 * result would breach an allocation rule, rather than moving four shards and then
 * discovering the fifth was the one that mattered.
 */
async function moveMany(c, d, list) {
  if (!(await ensureWrites())) return;
  const cl = client(c.id);
  const rows = (d.disk && d.disk.nodes) || [];
  const froms = new Set(list.map((x) => x.node));
  const targets = rows.map((n) => n.node).filter(Boolean);
  if (targets.length < 2) { toast('There is only one node to place shards on', 'warn'); return; }

  const opts = targets.map((n) => {
    const row = rows.find((x) => x.node === n) || {};
    return [n, `${n} — ${bytes(Number(row['disk.avail']) || 0)} free, ${num(Number(row.shards) || 0)} shards`];
  });
  const total = list.reduce((n, x) => n + (x.store || 0), 0);

  const res = await modal(`Move ${list.length} shard(s)`, c.name, [
    h('div.muted', { style: { fontSize: '12px' } },
      `${bytes(total)} in total. Sent as one reroute, so Elasticsearch accepts or refuses the `
      + 'whole set rather than leaving it half done. Shards already on the target are skipped.'),
    field('From', h('span.mono', [...froms].join(', ') || '–')),
    field('To', select('sh-bulk-to', opts[0][0], opts)),
  ], (ctx) => [
    h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
      const to = val('sh-bulk-to');
      const moving = list.filter((x) => x.node !== to);
      if (!moving.length) throw new Error('Every ticked shard is already on that node.');
      const ok = await confirmDialog(`Move ${moving.length} shard(s) to ${to}?`,
        `${bytes(moving.reduce((n, x) => n + (x.store || 0), 0))} will be copied, then removed from `
        + 'the source. The indices stay available throughout.',
        { yes: `move ${moving.length}`, danger: true });
      if (!ok) return null;
      const r = await cl.reroute(moving.map((x) => ({
        move: { index: x.index, shard: x.shard, from_node: x.node, to_node: to },
      })));
      if (!r.ok) throw new Error(r.message || r.kind || `HTTP ${r.status}`);
      return { to, n: moving.length };
    }) }, 'Move'),
    h('button.btn', { onclick: () => ctx.close(null) }, 'Cancel'),
  ], { width: '600px' });

  if (res) {
    list.forEach((x) => picked.delete(`${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`));
    toast(`Moving ${res.n} shard(s) to ${res.to}`);
    await load(c);
  }
}

function stateCell(s) {
  const st = s.state;
  if (st === 'STARTED') return pill('started', 'green');
  if (st === 'RELOCATING') return pill('relocating', 'yellow');
  if (st === 'INITIALIZING') return pill('initialising', 'yellow');
  if (st === 'UNASSIGNED') return pill('unassigned', 'red');
  return pill(st.toLowerCase(), 'grey');
}

/* ---------------------------------- actions ---------------------------------- */

/**
 * Move one shard to another node.
 *
 * The reroute command is the same one the Indices page uses; only the way in differs.
 * Elasticsearch copies the shard and drops the source once the copy lands, so the index
 * stays readable throughout — which is worth saying, because "move" sounds like downtime.
 */
async function moveOne(c, d, s) {
  if (!(await ensureWrites())) return;
  const cl = client(c.id);
  const rows = (d.disk && d.disk.nodes) || [];
  const targets = rows.map((n) => n.node).filter((n) => n && n !== s.node);
  if (!targets.length) {
    toast('No other node to move this shard to', 'warn');
    return;
  }
  const opts = targets.map((n) => {
    const row = rows.find((x) => x.node === n) || {};
    const avail = Number(row['disk.avail']) || 0;
    return [n, `${n} — ${bytes(avail)} free, ${num(Number(row.shards) || 0)} shards`];
  });

  const res = await modal(`Move ${s.index}[${s.shard}]`, c.name, [
    h('div.muted', { style: { fontSize: '12px' } },
      'Elasticsearch copies the shard to the target and removes the source once the copy is '
      + 'complete. The index stays available throughout.'),
    field('Shard', h('span.mono', `${s.index}[${s.shard}] ${s.primary ? 'primary' : 'replica'} · ${bytes(s.store)}`)),
    field('From', h('span.mono', s.node)),
    field('To', select('sh-to', opts[0][0], opts)),
  ], (ctx) => [
    h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
      const to = val('sh-to');
      const ok = await confirmDialog('Move this shard?',
        `${s.index}[${s.shard}]  ${bytes(s.store)}\n\n  from  ${s.node}\n  to    ${to}\n\n`
        + 'The copy runs in the background; the shard shows as RELOCATING until it lands.',
        { yes: 'move it' });
      if (!ok) return null;
      const r = await cl.reroute([{ move: { index: s.index, shard: s.shard, from_node: s.node, to_node: to } }]);
      if (!r.ok) throw new Error(r.message || r.kind || `HTTP ${r.status}`);
      return to;
    }) }, 'Move'),
    h('button.btn', { onclick: () => ctx.close(null) }, 'Cancel'),
  ]);

  if (res) {
    toast(`Moving ${s.index}[${s.shard}] to ${res}`);
    await load(c);
  }
}

/** Retry the allocations Elasticsearch gave up on after repeated failures. */
async function retry(c) {
  if (!(await ensureWrites())) return;
  try {
    const r = await client(c.id).retryFailed();
    if (!r.ok) throw new Error(r.message || r.kind || `HTTP ${r.status}`);
    toast('Retrying failed allocations');
    await load(c);
  } catch (e) {
    toast(`Retry failed: ${e.message}`, 'err');
  }
}
