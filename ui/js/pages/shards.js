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

let host = null;
const ui = { index: '', node: 'all', state: 'all', limit: 300 };
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

    nodesCard(c, d),
    accountingCard(c, d),
    shardsCard(c, d, all, raw, started));
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
  if (!acct.known || !acct.material) return null;
  const dang = danglingFor(c.id);
  const rows = (dang && dang.indices) || [];

  return card('Disk not accounted for', `${bytes(acct.gap)} more on disk than the index list explains`,
    h('div', { style: { display: 'grid', gap: '8px' } },
      h('div.banner.warn', { style: { margin: 0 } },
        h('div',
          h('div.ttl', `Elasticsearch holds ${bytes(acct.held)}; the indices total ${bytes(acct.accounted)}`),
          h('div', { style: { fontSize: '12px' } },
            'Data on the data path that the cluster state does not account for. Usually a dangling '
            + 'index left by a node that was removed, or shard directories orphaned by a failed '
            + 'relocation — disk that deleting an index will not reclaim, because there is no '
            + 'index to delete.'))),
      dang === null
        ? h('div.muted', { style: { fontSize: '12px' } }, 'Checking for dangling indices…')
        : rows.length
          ? table(['Dangling index', 'UUID', 'Since'], rows.map((r) => h('tr',
              h('td.mono', r.index_name),
              h('td.mono.muted', { style: { fontSize: '10.5px' } }, r.index_uuid),
              h('td.muted', { style: { fontSize: '11.5px' } }, r.creation_date_millis
                ? new Date(r.creation_date_millis).toISOString().slice(0, 10) : ''))))
          : h('div.muted', { style: { fontSize: '12px' } },
              'No dangling indices, so the gap is orphaned shard data rather than a lost index. '
              + 'A rolling restart of the affected node clears directories it no longer owns.')));
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
  const shown = filtered.slice(0, ui.limit);

  const trs = shown.map((s) => h('tr',
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

  const sub = `${num(filtered.length)} of ${num(all.length)} shard(s)`
    + (shown.length < filtered.length ? ` · showing the first ${num(shown.length)}` : '');

  return card(`Shards — ${c.name}`, why || sub,
    h('div', controls,
      why ? h('div', { style: { padding: '14px' } }, empty(why)) : null,
      table(['Index', { label: 'Shard', num: true }, 'Type', 'State', 'Node',
             { label: 'Store', num: true }, { label: 'Docs', num: true }, 'Unassigned reason', ''],
        trs, { emptyText: all.length ? 'No shard matches the filter' : 'No shards reported' }),
      shown.length < filtered.length
        ? h('div', { style: { padding: '10px', textAlign: 'center' } },
            h('button.btn.sm', { onclick: () => { ui.limit += 300; draw(); } },
              `Show more (${num(filtered.length - shown.length)} hidden)`))
        : null));
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
