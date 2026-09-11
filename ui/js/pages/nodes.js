/** Page 6 — nodes, shard allocation and unassigned-shard reasons. */

import { h, mount } from '../lib/dom.js';
import { bytes, num, pct, dur, toCsv, download } from '../lib/fmt.js';
import { state, client, activeClusters, fetchIndices } from '../core/state.js';
import { hbarList } from '../lib/charts.js';
import { card, collapsible, pill, statTile, table, empty } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { volumeReport, gb, days as fmtDays, yesNo } from '../core/volume.js';
import { diskBalance, balanceHeadline, primaryAction, SPREAD_WATCH } from '../core/disk-balance.js';
import { collapsible as fold } from './common.js';
import { navigateTo } from '../core/intent.js';

let host = null;
const cache = new Map();

export function render(el) {
  host = el;
  el.classList.add('dense');
  draw();
  loadShards();
  loadIndices();   // the capacity panel is derived from the dated indices
}

/** Per-day ingest comes from the index list, which this page does not otherwise need. */
async function loadIndices() {
  for (const c of activeClusters()) {
    if (state.indices.get(c.id)) continue;
    try { await fetchIndices(c.id, '*'); } catch (_) { /* the panel will say it has no data */ }
  }
  draw();
}
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

    h('div', { style: { marginBottom: '10px' } }, balanceCard(c, d)),

    h('div', { style: { marginBottom: '10px' } }, capacityCard(c, d)),

    h('div.grid.c2', { style: { marginBottom: '10px' } },
      collapsible('Heap used by node', 'JVM heap percentage', () => nodes.length
        ? hbarList(nodes.map((n) => ({ key: n.name, label: n.name, value: Number(n['heap.percent']) || 0,
            color: Number(n['heap.percent']) >= 85 ? 'var(--critical)' : Number(n['heap.percent']) >= 75 ? 'var(--warning)' : 'var(--series-1)' })),
            { format: (v) => `${v}%`, topN: 14, labelWidth: 150, showOther: false })
        : empty('No node data'), { key: 'nodes-heap' }),
      collapsible('Disk used by node', 'from _cat/nodes', () => (nodes.length
        ? hbarList(nodes.map((n) => ({ key: n.name, label: n.name, value: Number(n['disk.used']) || 0,
            sub: `of ${bytes(Number(n['disk.total']) || 0)}` })), { format: bytes, topN: 14, labelWidth: 150, showOther: false })
        : empty('No node data')), { key: 'nodes-disk' })),

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

/* --------------------------------- capacity ---------------------------------- */

/**
 * The sizing figures, on the page where someone is already looking at disks.
 *
 * Same arithmetic as the Volume report — the mean of the three heaviest of the last
 * seven complete days — so the two pages cannot disagree. The full report, and the
 * repository measurement, stay one click away.
 */
function capacityCard(c, d) {
  const r = volumeReport(c, d, state.indices.get(c.id) || [], null);
  const v = r.vol;

  const risk = (n) => (n === null ? 'inherit'
    : n < 7 ? 'var(--critical)' : n < 21 ? 'var(--warning)' : 'inherit');

  const rows = [
    ['Per day indices size', gb(r.perDayGB), v.basis],
    ['Per day + 30% buffer', gb(r.bufferedGB), 'the figure sizing is done against'],
    ['Live retention policy', r.liveRetention ? r.liveRetention.label : 'not set',
      r.liveRetention ? null : 'set liveRetention on the cluster to size against it'],
    ['Snapshot retention policy', r.snapshotRetention ? r.snapshotRetention.label : 'not set',
      r.snapshotRetention ? null : 'falls back to the SLM policy when set'],
    ['Live storage', `${gb(r.liveTotalGB)}`,
      r.livePct === null ? null : `${r.liveUsedGB.toFixed(0)} GB used · ${r.livePct.toFixed(1)}%`],
    ['Free space lasts', fmtDays(r.liveSufficientDays), 'at the current daily rate'],
    ['Required for the live policy', r.requiredLiveGB === null ? '–' : gb(r.requiredLiveGB),
      r.liveRetention ? `storage is ${yesNo(r.liveRetentionMet)}` : null],
    ['Required for 30 days', gb(r.required30GB)],
    ['Required for 90 days', gb(r.required90GB)],
    ['Live indices held', v.daysCovered ? `${v.daysCovered} days` : '–',
      v.oldestDay ? `${v.oldestDay} → ${v.newestDay}` : 'no dated indices'],
    // Live logs above is a span of data; keep the backup rows the same kind of thing, and
    // say separately when the snapshots ran so the two are not read as one.
    ['Indices backed up', r.snapshotDataDays ? `${r.snapshotDataDays} days` : '–',
      r.snapshotDataFrom ? `${r.snapshotDataFrom} → ${r.snapshotDataTo}`
        : r.snapshotCount ? 'indices in the snapshots are not named or not dated' : 'no snapshots'],
    ['Snapshots taken', r.snapshotsDays ? `${r.snapshotsDays} days` : '–',
      r.snapshotsFrom ? `${r.snapshotsFrom} → ${r.snapshotsTo} · ${r.snapshotCount} snapshots` : 'no snapshots'],
  ];

  const body = h('div', { style: { display: 'grid', gap: '8px' } },
    h('div.grid.c4',
      statTile('Per day', gb(r.perDayGB), v.daysCovered ? `top 3 of ${v.windowDays} days` : 'no dated indices'),
      statTile('+30% buffer', gb(r.bufferedGB), 'planning figure'),
      statTile('Free space lasts',
        h('span', { style: { color: risk(r.liveSufficientDays) } }, fmtDays(r.liveSufficientDays)),
        `${gb(r.liveFreeGB)} free`),
      statTile('Within live policy',
        r.liveRetentionMet === null ? '–' : yesNo(r.liveRetentionMet),
        r.liveRetention ? `${r.liveRetention.label} needs ${gb(r.requiredLiveGB)}` : 'no policy set')),
    h('div.tbl-wrap', h('table.tbl', h('tbody',
      ...rows.map(([k, val, note]) => h('tr',
        h('td', { style: { width: '34%' } }, k),
        h('td', { style: { fontWeight: 620, fontVariantNumeric: 'tabular-nums', width: '22%' } }, val),
        h('td.muted', { style: { fontSize: '11px' } }, note || '')))))));

  return card('Capacity', 'per-day ingest, retention and what the storage must hold', body,
    [h('button.btn.sm', { onclick: () => navigateTo('volume') }, 'Full volume report')]);
}

/* ------------------------------- disk balance -------------------------------- */

const VERDICT = {
  'single-node': { pill: 'grey',   title: 'Single data node', lead: 'Nothing to rebalance.' },
  ok:            { pill: 'green',  title: 'Evenly spread',    lead: 'No reallocation needed.' },
  watch:         { pill: 'yellow', title: 'Worth watching',   lead: 'Not urgent, but drifting apart.' },
  required:      { pill: 'orange', title: 'Action needed',    lead: 'Elasticsearch is constrained by disk.' },
  critical:      { pill: 'red',    title: 'Flood stage',      lead: 'Indices are read-only until this is cleared.' },
};

/**
 * Whether the data is spread evenly enough across nodes, and — the part that matters —
 * whether moving shards would actually fix it. A cluster where every node is full is a
 * capacity problem; saying "rebalance" there sends someone down the wrong path.
 */
function balanceCard(c, d) {
  const b = diskBalance(d, d.clusterSettings);
  const v = VERDICT[b.verdict] || VERDICT.ok;
  const wm = b.watermarks;

  if (!b.applicable) {
    return card('Disk balance', `${b.dataNodes} data node${b.dataNodes === 1 ? '' : 's'}`,
      h('div', { style: { display: 'flex', gap: '9px', alignItems: 'center' } },
        pill(v.title, v.pill),
        h('span.muted', { style: { fontSize: '12px' } }, b.reasons[0])));
  }

  const bar = (n) => {
    const cls = n.pct >= wm.flood ? 'var(--critical)' : n.pct >= wm.high ? 'var(--serious)'
      : n.pct >= wm.low ? 'var(--warning)' : 'var(--good)';
    return h('tr',
      h('td', h('div', { style: { fontWeight: 620 } }, n.name)),
      h('td', h('div', { style: { minWidth: '190px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' } },
          h('span', `${n.pct.toFixed(1)}%`),
          h('span.muted', `${bytes(n.used)} / ${bytes(n.total)}`)),
        h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, n.pct))}%`, background: cls } })))),
      h('td.num', bytes(n.avail)),
      h('td.num', num(n.shards)),
      h('td.num.muted', b.avgShards ? `${(n.shards - b.avgShards >= 0 ? '+' : '')}${Math.round(n.shards - b.avgShards)}` : '–'),
      h('td', n.pct >= wm.flood ? pill('flood', 'red') : n.pct >= wm.high ? pill('high', 'orange')
        : n.pct >= wm.low ? pill('low', 'yellow') : pill('ok', 'green')));
  };

  const body = h('div', { style: { display: 'grid', gap: '9px' } },
    h('div', { style: { display: 'flex', gap: '9px', alignItems: 'center', flexWrap: 'wrap' } },
      pill(v.title, v.pill),
      h('span', { style: { fontWeight: 620, fontSize: '12.5px' } }, balanceHeadline(b)),
      h('span.muted', { style: { fontSize: '11.5px', marginLeft: 'auto' } },
        `watermarks ${wm.low}/${wm.high}/${wm.flood}%${wm.assumed ? ' (assumed)' : ''}`)),

    // Current settings, read from the cluster — the first thing to check before advising
    // anyone to rebalance, because a switch left off makes everything else moot.
    h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '11.5px',
                        padding: '5px 9px', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)', background: 'var(--surface-1)' } },
      h('span', h('b', 'Current settings'), ' '),
      h('span', 'allocation ',
        h('span', { style: { fontWeight: 640, color: b.settings.allocationOn ? 'var(--good)' : 'var(--critical)' } },
          b.settings.allocation),
        h('span.muted', ` (${b.settings.allocationSource})`)),
      h('span', 'rebalance ',
        h('span', { style: { fontWeight: 640, color: b.settings.rebalanceOn ? 'var(--good)' : 'var(--critical)' } },
          b.settings.rebalance),
        h('span.muted', ` (${b.settings.rebalanceSource})`)),
      h('span.muted', `low ${wm.low}% · high ${wm.high}% · flood ${wm.flood}%` +
        (wm.assumed ? ' — assumed, the cluster did not report them' : '')),
      h('button.btn.sm.ghost', { style: { marginLeft: 'auto', padding: '0 6px' },
        title: 'Read these settings in the REST console',
        onclick: () => navigateTo('console', { method: 'GET',
          path: '/_cluster/settings?include_defaults=true&flat_settings=true&filter_path=**.disk.watermark**,**.allocation.enable,**.rebalance.enable',
          body: '' }) }, 'View')),

    h('div', { style: { display: 'grid', gap: '2px' } },
      ...b.reasons.map((r) => h('div', { style: { fontSize: '12px' } }, '• ', r))),

    // The question the page exists to answer, and the one thing to do about it.
    verdictStrip(c, b),

    table(['Node', 'Disk', { label: 'Free', num: true }, { label: 'Shards', num: true },
           { label: 'vs avg', num: true }, 'Watermark'],
      [...b.nodes].sort((x, y) => y.pct - x.pct).map(bar)),

    // The rest is context, folded away so the panel stays readable.
    b.suggestions.length > 1
      ? fold('Other requests worth running', `${b.suggestions.length - 1} more`,
          () => suggestionList(c, b.suggestions.filter((x) => x !== primaryAction(b))),
          { key: `nodes-suggest-${c.id}` })
      : null);

  return card('Disk balance', `${b.dataNodes} data nodes · ${b.spread ? b.spread.toFixed(1) + ' point spread' : ''}`, body);
}

/**
 * Is the usage uneven, and what is the one thing to do about it?
 *
 * A single recommended action rather than a list: a page that offers eight commands at
 * equal weight leaves the reader to work out which one comes first.
 */
function verdictStrip(c, b) {
  const act = primaryAction(b);
  const uneven = b.reallocationHelps;

  return h('div', { style: { display: 'grid', gap: '6px', padding: '8px 10px',
                             border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                             background: 'var(--surface-1)' } },
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      h('b', { style: { fontSize: '12.5px' } }, 'Disk usage across nodes'),
      uneven
        ? pill('uneven — reallocation would help', 'orange')
        : pill(b.allFull ? 'even, but every node is full' : 'even enough', b.allFull ? 'red' : 'green'),
      h('span.muted', { style: { fontSize: '11.5px' } },
        uneven
          ? `${b.fullest.name} at ${b.fullest.pct.toFixed(1)}% against ${b.emptiest.name} at ${b.emptiest.pct.toFixed(1)}% — ${b.spread.toFixed(1)} points apart`
          : b.allFull
          ? 'nowhere to move data to; this needs capacity, not reallocation'
          : `${b.spread.toFixed(1)} points between the fullest and emptiest node, under the ${SPREAD_WATCH}-point mark`)),
    act
      ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span.muted', { style: { fontSize: '11.5px' } }, 'Do this first:'),
          h('span', { style: { fontSize: '12.5px', fontWeight: 620 } }, act.title),
          act.write ? h('span.pill.yellow', { style: { fontSize: '10px' } }, 'changes the cluster') : null,
          h('span.muted', { style: { fontSize: '11px', flex: '1', minWidth: '160px' } }, act.why),
          h('button.btn.sm.primary', {
            onclick: () => navigateTo('console', { method: act.method, path: act.path, body: act.body || '' }),
          }, `Open ${act.method} →`))
      : null);
}

/**
 * The remaining requests, for when the first one was not the answer. Each opens in the
 * REST console prefilled rather than being run from here — these change cluster settings,
 * and they should be read before they are sent.
 */
function suggestionList(c, list) {
  return h('div', { style: { display: 'grid', gap: '5px' } },
    h('div.muted', { style: { fontSize: '11px' } },
      'Each opens in the REST console prefilled. Nothing is sent from here — read it first, ' +
      'and replace anything marked REPLACE.'),
    ...list.map((s) => h('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '4px 0',
                 borderTop: '1px solid var(--border)' },
      },
      h('span.mono', { style: { fontSize: '10.5px', fontWeight: 700, minWidth: '48px',
                                color: s.write ? 'var(--warning)' : 'var(--text-muted)' } }, s.method),
      h('div', { style: { flex: '1', minWidth: 0 } },
        h('div', { style: { fontSize: '12.5px', fontWeight: 600 } }, s.title,
          s.write ? h('span.pill.yellow', { style: { marginLeft: '6px', fontSize: '10px' } }, 'changes the cluster') : null),
        h('div.mono.muted', { style: { fontSize: '10.5px', wordBreak: 'break-all' } }, s.path),
        h('div.muted', { style: { fontSize: '11px' } }, s.why)),
      h('button.btn.sm', {
        title: 'Open in the REST console, prefilled',
        onclick: () => navigateTo('console', { method: s.method, path: s.path, body: s.body || '' }),
      }, 'Open →'))));
}
