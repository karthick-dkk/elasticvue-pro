/**
 * Index management — open, close, delete, move a shard, change replicas, maintenance.
 *
 * Every one of these changes the cluster, so each goes through `ensureWrites()` and each
 * request carries `allowWrites`. Nothing here happens on a timer or a page load: an
 * operator has to click it, and destructive actions name what they will affect first.
 */

import { h, mount, $ } from '../lib/dom.js';
import { bytes, num } from '../lib/fmt.js';
import { modal, confirmDialog, nameList, field, text, select, checkbox, val, checked } from './modal.js';
import { ensureWrites } from '../core/writes.js';
import { client, state } from '../core/state.js';

/** Run one action per index, collecting failures rather than stopping at the first. */
async function forEachIndex(cl, names, fn) {
  const failed = [];
  for (const n of names) {
    try { await fn(n); } catch (e) { failed.push(`${n}: ${e.message}`); }
  }
  return failed;
}

function listFor(names, max = 12) {
  return names.slice(0, max).join('\n') + (names.length > max ? `\n…and ${names.length - max} more` : '');
}

/* ------------------------------- open / close ------------------------------- */

export async function openIndices(cluster, names, { onChanged } = {}) {
  if (!names.length || !(await ensureWrites())) return false;
  const ok = await confirmDialog(
    `Open ${names.length === 1 ? names[0] : `${names.length} indices`}?`,
    h('div', h('div', `On ${cluster.name}. Opening restores the shards to memory and makes them searchable again.`),
      nameList(names)),
    { yes: 'open' });
  if (!ok) return false;
  const failed = await forEachIndex(client(cluster.id), names, (n) => client(cluster.id).openIndex(n));
  report('open', names.length, failed);
  if (onChanged) await onChanged();
  return true;
}

export async function closeIndices(cluster, names, { onChanged } = {}) {
  if (!names.length || !(await ensureWrites())) return false;
  const ok = await confirmDialog(
    `Close ${names.length === 1 ? names[0] : `${names.length} indices`}?`,
    h('div', h('div', `On ${cluster.name}. A closed index keeps its data on disk but cannot be searched ` +
                      'or written to. It can be reopened at any time.'),
      nameList(names)),
    { yes: 'close' });
  if (!ok) return false;
  const failed = await forEachIndex(client(cluster.id), names, (n) => client(cluster.id).closeIndex(n));
  report('close', names.length, failed);
  if (onChanged) await onChanged();
  return true;
}

/* ---------------------------------- delete ---------------------------------- */

/**
 * Deleting is the one action that cannot be undone, so it asks for the count to be
 * typed back when more than one index is going.
 */
export async function deleteIndices(cluster, names, { onChanged } = {}) {
  if (!names.length || !(await ensureWrites())) return false;

  const total = names.reduce((s, n) => {
    const row = (state.indices.get(cluster.id) || []).find((r) => r.index === n);
    return s + ((row && row.size) || 0);
  }, 0);

  const body = [
    h('div.banner.err', { style: { margin: '0 0 4px' } },
      h('div', h('div.ttl', 'This cannot be undone'),
        h('div', `The data is removed from ${cluster.name}. If it is held in a snapshot it can be restored ` +
                 'from there; otherwise it is gone.'))),
    h('div', { style: { fontSize: '12.5px' } },
      h('b', `${num(names.length)} index/indices`), total ? h('span.muted', ` · ${bytes(total)} on disk`) : null),
    h('div.mono', { style: { fontSize: '11.5px', maxHeight: '190px', overflow: 'auto',
                             border: '1px solid var(--border)', borderRadius: '6px', padding: '7px' } },
      names.map((n) => h('div', n))),
  ].filter(Boolean);

  const ok = await confirmDialog(
    `Delete ${names.length === 1 ? names[0] : `${names.length} indices`}?`,
    h('div', ...body),
    { yes: 'delete', danger: true, typeToConfirm: names.length > 1 ? String(names.length) : null });
  if (!ok) return false;

  const failed = await forEachIndex(client(cluster.id), names, (n) => client(cluster.id).deleteIndex(n));
  report('delete', names.length, failed);
  if (onChanged) await onChanged();
  return true;
}

/* ------------------------------ move a shard -------------------------------- */

/**
 * `_cluster/reroute` with a `move` command — the real "move an index to another node".
 * Elasticsearch moves shards, not indices, so the dialog picks the shard.
 */
export async function moveShardDialog(cluster, indexName, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);

  let shards = [];
  try {
    shards = (await cl.shardsOf(indexName)).filter((r) => r.state === 'STARTED');
  } catch (e) {
    alert(`Could not list the shards of ${indexName}: ${e.message}`);
    return false;
  }
  if (!shards.length) {
    alert(`${indexName} has no started shard to move. Only STARTED shards can be relocated.`);
    return false;
  }

  const d = state.data.get(cluster.id) || {};
  const nodes = (d.nodes || []).map((n) => n.name).filter(Boolean);
  const shardOpts = shards.map((r) => [
    `${r.shard}|${r.prirep}|${r.node}`,
    `shard ${r.shard} ${r.prirep === 'p' ? 'primary' : 'replica'} · on ${r.node} · ${bytes(Number(r.store) || 0)}`,
  ]);

  const targetHost = h('div');
  function drawTarget() {
    const cur = (val('ia-shard') || '').split('|')[2];
    const options = nodes.filter((n) => n !== cur);
    mount(targetHost, field('Move to node',
      options.length
        ? select('ia-tonode', options[0], options.map((n) => [n, n]))
        : h('div.muted', { style: { fontSize: '12px' } }, 'No other node is available to move this shard to.')));
  }

  const shardSel = select('ia-shard', shardOpts[0][0], shardOpts);
  shardSel.onchange = drawTarget;

  const body = [
    h('div.muted', { style: { fontSize: '12px' } },
      'Elasticsearch relocates shards, not whole indices. Moving copies the shard to the target node and ' +
      'removes it from the source once the copy is complete — the index stays available throughout.'),
    field('Index', text('ia-index', indexName, { mono: true, style: { pointerEvents: 'none', opacity: '.7' } })),
    field('Shard', shardSel),
    targetHost,
  ];
  drawTarget();

  const res = await modal(`Move a shard of ${indexName}`, cluster.name, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const [shard, , fromNode] = (val('ia-shard') || '').split('|');
        const toNode = val('ia-tonode');
        if (!toNode) throw new Error('There is no other node to move this shard to.');
        const go = await confirmDialog('Move this shard?',
          `${indexName} shard ${shard}\n\nfrom  ${fromNode}\nto    ${toNode}\n\n` +
          'The shard is copied to the target node and removed from the source once the copy ' +
          'completes. The index stays available, but the copy uses disk and network on both nodes.',
          { yes: 'move' });
        if (!go) return;
        await cl.reroute([{ move: { index: indexName, shard: Number(shard), from_node: fromNode, to_node: toNode } }]);
        ctx.done({ shard, fromNode, toNode });
      }) }, 'Move shard'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '580px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* ------------------------------ index settings ------------------------------ */

export async function indexSettingsDialog(cluster, names, { onChanged } = {}) {
  if (!names.length || !(await ensureWrites())) return false;
  const cl = client(cluster.id);
  const one = names.length === 1 ? names[0] : null;

  let current = {};
  if (one) {
    try {
      const j = await cl.indexSettings(one);
      current = (j[one] && j[one].settings) || {};
    } catch (_) { /* fall back to blank fields */ }
  }

  const body = [
    names.length > 1
      ? h('div.banner.warn', { style: { margin: '0 0 4px' } },
          h('div', h('div.ttl', `Applies to all ${names.length} selected indices`), h('div', listFor(names, 6))))
      : null,
    field('Number of replicas', text('ia-rep', current['index.number_of_replicas'] ?? '', { placeholder: '1' }),
      'Applied immediately. The shard count of an existing index cannot be changed — split or shrink it instead.'),
    field('Refresh interval', text('ia-refresh', current['index.refresh_interval'] ?? '', { placeholder: '1s, 30s, -1' }),
      '-1 disables refreshes, which speeds up heavy indexing.'),
    field('Total shards per node', text('ia-tspn', current['index.routing.allocation.total_shards_per_node'] ?? '', { placeholder: 'unset' })),
    h('div', { style: { display: 'grid', gap: '7px' } },
      checkbox('ia-ro', 'Read-only (index.blocks.write)', String(current['index.blocks.write']) === 'true',
        'Blocks writes but still allows deleting the index.')),
    h('div.muted', { style: { fontSize: '11.5px' } }, 'Leave a field empty to leave that setting untouched.'),
  ];

  const res = await modal(one ? `Settings for ${one}` : `Settings for ${names.length} indices`, cluster.name, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const settings = {};
        const rep = val('ia-rep').trim();
        const refresh = val('ia-refresh').trim();
        const tspn = val('ia-tspn').trim();
        if (rep !== '') {
          if (!/^\d+$/.test(rep)) throw new Error('Replicas must be a whole number.');
          settings['index.number_of_replicas'] = Number(rep);
        }
        if (refresh !== '') settings['index.refresh_interval'] = refresh;
        if (tspn !== '') {
          if (!/^-?\d+$/.test(tspn)) throw new Error('Total shards per node must be a whole number.');
          settings['index.routing.allocation.total_shards_per_node'] = Number(tspn);
        }
        settings['index.blocks.write'] = checked('ia-ro');
        if (!Object.keys(settings).length) throw new Error('Nothing to change.');
        const failed = await forEachIndex(cl, names, (n) => cl.updateIndexSettings(n, settings));
        if (failed.length) throw new Error(`${failed.length} failed — ${failed[0]}`);
        ctx.done(names.length);
      }) }, 'Apply'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '600px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* ------------------------------- maintenance -------------------------------- */

const MAINTENANCE = {
  refresh: { label: 'Refresh', verb: 'refresh', call: (cl, n) => cl.refreshIndex(n),
    note: 'Makes recent writes searchable. Cheap.' },
  flush: { label: 'Flush', verb: 'flush', call: (cl, n) => cl.flushIndex(n),
    note: 'Writes the transaction log to disk.' },
  clear: { label: 'Clear cache', verb: 'clear the cache of', call: (cl, n) => cl.clearIndexCache(n),
    note: 'Frees query and field-data cache. Later queries are slower until it warms up again.' },
  forcemerge: { label: 'Force merge', verb: 'force merge', call: (cl, n) => cl.forceMergeIndex(n, 1),
    note: 'Merges to one segment. Very expensive on a large index and should only be run on indices that are no longer written to. It starts in the background.' },
};

export async function maintenance(cluster, names, kind, { onChanged } = {}) {
  const spec = MAINTENANCE[kind];
  if (!spec || !names.length || !(await ensureWrites())) return false;
  const ok = await confirmDialog(`${spec.label} ${names.length === 1 ? names[0] : `${names.length} indices`}?`,
    h('div', h('div', `On ${cluster.name}. ${spec.note}`), nameList(names)),
    { yes: spec.label.toLowerCase() });
  if (!ok) return false;
  const cl = client(cluster.id);
  const failed = await forEachIndex(cl, names, (n) => spec.call(cl, n));
  report(spec.verb, names.length, failed);
  if (onChanged) await onChanged();
  return true;
}

export const MAINTENANCE_KINDS = Object.entries(MAINTENANCE).map(([k, v]) => [k, v.label]);

function report(what, total, failed) {
  if (!failed.length) return;
  alert(`${failed.length} of ${total} could not ${what}:\n\n${failed.slice(0, 8).join('\n')}` +
        (failed.length > 8 ? `\n…and ${failed.length - 8} more` : ''));
}
