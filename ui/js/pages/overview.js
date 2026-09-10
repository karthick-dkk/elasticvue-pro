/** Page 1 — cluster overview: URL, name, disk, ILM/SLM, repositories and last snapshot. */

import { h, mount, clear } from '../lib/dom.js';
import { bytes, num, compact, pct, ago, dt, toCsv, download, healthClass } from '../lib/fmt.js';
import { state, bus, clusters, activeClusters, client, fetchOverview, refreshAll, alerts } from '../core/state.js';
import { hbarList, usageMeter } from '../lib/charts.js';
import { card, pill, statTile, table, connectionBanner, diskCell, lastSnapshotOf, snapshotPill, empty } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { navigateTo } from '../core/intent.js';

let host = null;
const expanded = new Set();

/** Sort keys, each pulling one comparable value out of a {c, d, cl} row. */
const SORTS = {
  name:     { label: 'Cluster name',  get: (r) => r.c.name.toLowerCase() },
  size:     { label: 'Cluster size',  get: (r) => clusterSize(r) },
  health:   { label: 'Health',        get: (r) => healthRank(r) },
  disk:     { label: 'Disk used %',   get: (r) => (r.d.disk && isFinite(r.d.disk.percent) ? r.d.disk.percent : -1) },
  diskFree: { label: 'Disk free',     get: (r) => (r.d.disk ? (r.d.disk.total || 0) - (r.d.disk.used || 0) : -1) },
  nodes:    { label: 'Nodes',         get: (r) => (r.d.health && r.d.health.number_of_nodes) || -1 },
  shards:   { label: 'Shards',        get: (r) => (r.d.health && r.d.health.active_shards) || -1 },
  unassign: { label: 'Unassigned',    get: (r) => (r.d.health && r.d.health.unassigned_shards) || 0 },
  version:  { label: 'Version',       get: (r) => versionKey(r) },
  snapshot: { label: 'Last snapshot', get: (r) => { const s = lastSnapshotOf(r.d); return s ? s.start : 0; } },
  alerts:   { label: 'Open alerts',   get: (r) => alertsByCluster().get(r.c.id) || 0 },
};

/**
 * How much data the cluster actually holds — the store size of its indices, which is
 * what "size" means to an operator. Disk usage is a different question (it counts
 * everything on the filesystem) and has its own sort.
 */
function clusterSize(r) {
  const d = r.d;
  if (d.disk && d.disk.indicesBytes) return d.disk.indicesBytes;
  // Before allocation data arrives, fall back to the index list if that page has run.
  const idx = state.indices.get(r.c.id);
  if (idx && idx.length) return idx.reduce((s, x) => s + (x.size || 0), 0);
  return -1;
}

// Sorted by cluster name, ascending, until the operator says otherwise.
const ui = { text: '', sort: 'name', dir: 1, only: 'all' };

/** offline worst, then red > yellow > green — so "sort by health" surfaces trouble. */
function healthRank(r) {
  if (!r.d.updatedAt) return 1;
  if (!r.d.reachable) return 4;
  return { red: 3, yellow: 2, green: 0 }[(r.d.health && r.d.health.status)] ?? 1;
}

/** "8.13.4" -> 8.000013.000004, so 8.9 sorts below 8.13. */
function versionKey(r) {
  const v = (r.d.info && r.d.info.version && r.d.info.version.number) || '';
  const p = v.split('.').map((x) => parseInt(x, 10) || 0);
  return (p[0] || 0) * 1e12 + (p[1] || 0) * 1e6 + (p[2] || 0);
}

function alertsByCluster() {
  const m = new Map();
  alerts().forEach((a) => { if (a.cluster) m.set(a.cluster.id, (m.get(a.cluster.id) || 0) + 1); });
  return m;
}

export function render(el) { host = el; draw(); }
export function onData() { if (host && host.isConnected) draw(); }

/** Search and sort are applied to the table and charts alike, so they stay in step. */
function visibleRows(all) {
  let rows = all;

  const t = ui.text.trim().toLowerCase();
  if (t) {
    rows = rows.filter(({ c, d }) => {
      const version = (d.info && d.info.version && d.info.version.number) || '';
      const repos = (d.repos || []).map((r) => r.name).join(' ');
      const hay = `${c.name} ${c.url} ${(c.tags || []).join(' ')} ${c.via || ''} ${version} ${repos}`;
      return hay.toLowerCase().includes(t);
    });
  }

  if (ui.only === 'problems') rows = rows.filter((r) => !r.d.reachable || (r.d.health && r.d.health.status !== 'green'));
  else if (ui.only === 'offline') rows = rows.filter((r) => r.d.updatedAt && !r.d.reachable);
  else if (ui.only === 'online') rows = rows.filter((r) => r.d.reachable);

  const get = (SORTS[ui.sort] || SORTS.name).get;
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * ui.dir;
    return String(av).localeCompare(String(bv)) * ui.dir;
  });
}

function toolbar(all, shown) {
  const sortSel = h('select', { onchange: (e) => { ui.sort = e.target.value; draw(); } },
    ...Object.entries(SORTS).map(([k, v]) => h('option', { value: k }, v.label)));
  sortSel.value = ui.sort;

  const onlySel = h('select', { onchange: (e) => { ui.only = e.target.value; draw(); } },
    h('option', { value: 'all' }, `All (${all.length})`),
    h('option', { value: 'problems' }, 'Needs attention'),
    h('option', { value: 'online' }, 'Reachable'),
    h('option', { value: 'offline' }, 'Unreachable'));
  onlySel.value = ui.only;

  return h('div.toolbar', { style: { marginBottom: '14px' } },
    h('label.field', 'Search clusters',
      h('input', { type: 'search', value: ui.text, style: { minWidth: '260px' },
        placeholder: 'name, URL, tag, jump host, version, repository…',
        oninput: (e) => { ui.text = e.target.value; draw(); } })),
    h('label.field', 'Sort by', sortSel),
    h('label.field', 'Direction',
      h('button.btn.sm', { style: { minWidth: '104px' },
        title: ui.dir === 1 ? 'Ascending — click for descending' : 'Descending — click for ascending',
        onclick: () => { ui.dir = -ui.dir; draw(); } }, ui.dir === 1 ? '▲ ascending' : '▼ descending')),
    h('label.field', 'Show', onlySel),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'flex-end' } },
      h('span.muted', { style: { fontSize: '11.5px' } },
        shown.length === all.length ? `${all.length} cluster${all.length === 1 ? '' : 's'}` : `${shown.length} of ${all.length} shown`),
      (ui.text || ui.only !== 'all' || ui.sort !== 'name' || ui.dir !== 1)
        ? h('button.btn.sm', { onclick: () => { ui.text = ''; ui.only = 'all'; ui.sort = 'name'; ui.dir = 1; draw(); } }, 'Clear')
        : null));
}

function draw() {
  const list = activeClusters();
  const all = list.map((c) => ({ c, d: state.data.get(c.id) || {}, cl: client(c.id) }));
  const rows = visibleRows(all);

  mount(host,
    alertsSummary(),
    tiles(all),
    toolbar(all, rows),
    summaryCard(rows, all),
    h('div.grid.c2', { style: { marginTop: '14px' } }, diskCard(rows), repoCard(rows)),
    h('div', { style: { marginTop: '14px' } }, ...rows.filter((r) => !r.d.reachable && r.d.updatedAt)
      .map((r) => connectionBanner(r.c, () => fetchOverview(r.c.id))))
  );
}

/**
 * A headline only — the full list, with its own filters and export, is the Alerts page.
 * The three most serious ones are shown so this page still says what is wrong.
 */
function alertsSummary() {
  const a = alerts();
  if (!a.length) return null;
  const crit = a.filter((x) => x.level === 'critical');
  const warn = a.filter((x) => x.level !== 'critical');
  const top = [...crit, ...warn].slice(0, 3);

  return h(`div.banner.${crit.length ? 'err' : 'warn'}`, { style: { marginBottom: '14px' } },
    h('div', { style: { minWidth: 0 } },
      h('div.ttl', `${a.length} open alert${a.length === 1 ? '' : 's'} — ${crit.length} critical, ${warn.length} warning`),
      h('div', { style: { display: 'grid', gap: '2px', marginTop: '3px' } },
        ...top.map((x) => h('div', { style: { fontSize: '12px' } },
          h('b', x.cluster ? `${x.cluster.name}: ` : ''), x.title,
          x.detail ? h('span.muted', ` — ${x.detail}`) : null)),
        a.length > top.length
          ? h('div.muted', { style: { fontSize: '11.5px' } }, `…and ${a.length - top.length} more`)
          : null)),
    h('div.acts', h('button.btn.sm.primary', { onclick: () => navigateTo('alerts') }, 'Open Alerts')));
}

function tiles(rows) {
  const online = rows.filter((r) => r.d.reachable).length;
  const disk = rows.reduce((s, r) => ({
    used: s.used + ((r.d.disk && r.d.disk.used) || 0),
    total: s.total + ((r.d.disk && r.d.disk.total) || 0),
  }), { used: 0, total: 0 });
  const docs = rows.reduce((s, r) => s + ((r.d.health && 0) || 0), 0);
  const idx = rows.reduce((s, r) => s + ((r.d.health && r.d.health.active_primary_shards) || 0), 0);
  const unassigned = rows.reduce((s, r) => s + ((r.d.health && r.d.health.unassigned_shards) || 0), 0);
  const repos = rows.reduce((s, r) => s + ((r.d.repos && r.d.repos.length) || 0), 0);

  return h('div.grid.c4',
    statTile('Clusters online', `${online} / ${rows.length}`, rows.length === online ? 'all reachable' : 'some unreachable'),
    statTile('Disk used', bytes(disk.used), `of ${bytes(disk.total)} · ${pct(disk.total ? (disk.used / disk.total) * 100 : NaN)}`),
    statTile('Primary shards', compact(idx), `${num(unassigned)} unassigned`),
    statTile('Snapshot repos', String(repos), `${rows.reduce((s, r) => s + (r.d.slm || []).length, 0)} SLM policies`));
}

function summaryCard(rows, all) {
  const headers = ['Cluster', 'Version', 'Health', 'Nodes', { label: 'Size', num: true }, 'Disk usage', 'ILM', 'SLM', 'Repository', 'Last snapshot', 'Alerts', ''];
  const byCluster = alertsByCluster();
  const trs = [];
  rows.forEach((r) => {
    const { c, d, cl } = r;
    const snap = lastSnapshotOf(d);
    const repoNames = (d.repos || []).map((x) => x.name);
    const stateLbl = !d.updatedAt ? 'loading' : d.reachable ? (d.health && d.health.status) || 'unknown'
      : cl && cl.state === 'auth_error' ? 'auth error' : cl && cl.state === 'tls_error' ? 'cert/TLS' : cl && cl.state === 'tunnel_error' ? 'jump host' : 'offline';

    trs.push(h('tr',
      h('td',
        h('div', { style: { fontWeight: 650 } }, c.name),
        h('a.mono.muted', { href: c.url + '/', target: '_blank', rel: 'noopener', style: { fontSize: '11px' } }, c.url),
        c.tags && c.tags.length ? h('div', { style: { marginTop: '3px', display: 'flex', gap: '4px' } },
          ...c.tags.map((t) => h('span.pill.grey', t))) : null),
      h('td.mono', (d.info && d.info.version && d.info.version.number) || '–'),
      h('td', pill(stateLbl, d.reachable ? healthClass(d.health && d.health.status) : 'red')),
      h('td.num', d.health ? `${d.health.number_of_nodes} (${d.health.number_of_data_nodes} data)` : '–'),
      h('td.num', { title: 'Store size of the indices on this cluster' },
        clusterSize({ c, d }) >= 0 ? bytes(clusterSize({ c, d })) : h('span.muted', '–')),
      h('td', diskCell(d.disk)),
      h('td', d.ilm ? pill(d.ilm.operation_mode, d.ilm.operation_mode === 'RUNNING' ? (d.ilmErrorCount ? 'yellow' : 'green') : 'yellow') : h('span.muted', '–'),
        d.ilmErrorCount ? h('div.muted', { style: { fontSize: '11px' } }, `${d.ilmErrorCount} in error`) : null),
      h('td', d.slmStatus ? pill(d.slmStatus.operation_mode, d.slmStatus.operation_mode === 'RUNNING' ? 'green' : 'yellow') : h('span.muted', d.slmSupported === false ? 'n/a' : '–'),
        (d.slm || []).length ? h('div.muted', { style: { fontSize: '11px' } }, `${d.slm.length} polic${d.slm.length > 1 ? 'ies' : 'y'}`) : null),
      h('td', repoNames.length
        ? h('div', { style: { display: 'grid', gap: '2px' } }, ...repoNames.slice(0, 3).map((n) => h('span.mono', { style: { fontSize: '11.5px' } }, n)),
            repoNames.length > 3 ? h('span.muted', { style: { fontSize: '11px' } }, `+${repoNames.length - 3} more`) : null)
        : h('span.muted', 'none')),
      h('td', snapshotPill(snap)),
      h('td', byCluster.get(c.id)
        ? h('button.btn.sm.ghost', { title: 'Show these on the Alerts page', onclick: () => navigateTo('alerts') },
            pill(String(byCluster.get(c.id)), 'yellow'))
        : h('span.muted', '–')),
      h('td', h('button.btn.sm.ghost', {
        onclick: () => { expanded.has(c.id) ? expanded.delete(c.id) : expanded.add(c.id); draw(); },
      }, expanded.has(c.id) ? 'Hide' : 'Details'))));

    if (expanded.has(c.id)) trs.push(h('tr', h('td', { colspan: headers.length, style: { background: 'var(--surface-2)' } }, detail(c, d))));
  });

  const total = (all || rows).length;
  const scope = rows.length === total
    ? `${total} cluster${total === 1 ? '' : 's'}`
    : `${rows.length} of ${total} clusters`;
  const sub = `${scope} · sorted by ${(SORTS[ui.sort] || SORTS.name).label.toLowerCase()} · ` +
    (isSnapshotMode() ? `collected ${ago(state.lastRefresh)}` : `updated ${ago(state.lastRefresh)}`);
  return card('Cluster summary', sub,
    table(headers, trs, { emptyText: total ? 'No cluster matches the search' : 'No clusters configured' }),
    [h('button.btn.sm', { onclick: () => exportSummary(rows) }, 'Export CSV'),
     isSnapshotMode() ? null : h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, 'Refresh')]);
}

function detail(c, d) {
  const repos = d.repos || [];
  const box = h('div', { style: { display: 'grid', gap: '12px', padding: '4px 0' } });

  box.append(h('div.grid.c3',
    kv('Cluster UUID', (d.info && d.info.cluster_uuid) || '–'),
    kv('Lucene', (d.info && d.info.version && d.info.version.lucene_version) || '–'),
    kv('Credential', c.credSource === 'shared' ? `shared (${c.username || 'api key'})` : c.credSource === 'cluster' ? `per-cluster (${c.username})` : 'none'),
    kv('path.repo', (d.pathRepo && d.pathRepo.join(', ')) || 'not configured'),
    kv('Active shards', d.health ? `${num(d.health.active_shards)} (${pct(d.health.active_shards_percent_as_number)})` : '–'),
    kv('Relocating / initializing', d.health ? `${d.health.relocating_shards} / ${d.health.initializing_shards}` : '–')));

  if (repos.length) {
    const trs = repos.map((rp) => {
      const snaps = (d.snapshots && d.snapshots[rp.name]) || [];
      const newest = snaps[0], oldest = snaps[snaps.length - 1];
      const failed = snaps.filter((s) => String(s.status).toUpperCase() !== 'SUCCESS').length;
      return h('tr',
        h('td.mono', rp.name),
        h('td', h('span.pill.grey', rp.type)),
        h('td.mono.trunc', { title: rp.location }, rp.location || '–'),
        h('td.mono', { style: { fontSize: '11px' } },
          [rp.settings.compress !== undefined ? `compress=${rp.settings.compress}` : null,
           rp.settings.chunk_size ? `chunk=${rp.settings.chunk_size}` : null,
           rp.settings.readonly ? 'readonly' : null,
           rp.settings.max_snapshot_bytes_per_sec ? `snap≤${rp.settings.max_snapshot_bytes_per_sec}` : null,
           rp.settings.max_restore_bytes_per_sec ? `restore≤${rp.settings.max_restore_bytes_per_sec}` : null,
          ].filter(Boolean).join(' · ') || '–'),
        h('td.num', num(snaps.length)),
        h('td', oldest ? h('span', { title: dt(oldest.start) }, dt(oldest.start).slice(0, 12)) : h('span.muted', '–')),
        h('td', newest ? h('span', { title: dt(newest.start) }, `${dt(newest.start).slice(0, 12)} (${ago(newest.start)})`) : h('span.muted', '–')),
        h('td.num', failed ? h('span.pill.yellow', h('i.dot'), String(failed)) : h('span.muted', '0')),
        h('td', h('button.btn.sm', { onclick: (e) => measureRepo(c, rp, snaps, e.target) }, 'Measure size')),
        h('td.mono', { id: `repo-size-${c.id}-${rp.name}`.replace(/[^a-z0-9-]/gi, '_') }, ''));
    });
    box.append(card('Snapshot repositories', 'size measurement is an on-demand, expensive call',
      table(['Repository', 'Type', 'Location / bucket', 'Settings', 'Snapshots', 'Oldest', 'Newest', 'Non-success', '', 'Measured size'], trs)));
  } else {
    box.append(card('Snapshot repositories', '', empty('No repositories registered on this cluster')));
  }

  if (d.nodes && d.nodes.length) {
    box.append(card('Nodes', `${d.nodes.length} node(s)`,
      hbarList(d.nodes.map((n) => ({ key: n.name, label: n.name, value: Number(n['disk.used']) || 0,
        sub: `${n['node.role'] || ''} · heap ${n['heap.percent']}% · cpu ${n.cpu}%` })),
        { format: bytes, topN: 12, labelWidth: 170 })));
  }
  return box;
}

function kv(k, v) {
  return h('div', h('div.k', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)' } }, k),
    h('div.mono', { style: { fontSize: '12px', wordBreak: 'break-all' } }, String(v)));
}

/**
 * Repository size is not exposed as a single number by Elasticsearch. The closest
 * honest answer is the sum of each snapshot's INCREMENTAL bytes, which is what the
 * repository actually holds. That needs one _status call per snapshot, so it stays
 * behind a button and is capped.
 */
async function measureRepo(c, repo, snaps, btn) {
  const cl = client(c.id);
  const out = document.getElementById(`repo-size-${c.id}-${repo.name}`.replace(/[^a-z0-9-]/gi, '_'));
  const cap = 60;
  const targets = snaps.slice(0, cap);
  if (!targets.length) { out.textContent = 'no snapshots'; return; }
  btn.disabled = true;
  let total = 0, done = 0, failed = 0, logical = 0;
  for (const s of targets) {
    try {
      const st = await cl.snapshotStatus(repo.name, s.id);
      const one = (st.snapshots || [])[0];
      if (one && one.stats) {
        total += (one.stats.incremental && one.stats.incremental.size_in_bytes) || 0;
        logical = Math.max(logical, (one.stats.total && one.stats.total.size_in_bytes) || 0);
      }
    } catch { failed++; }
    done++;
    out.textContent = `${bytes(total)} · ${done}/${targets.length}`;
  }
  btn.disabled = false;
  out.textContent = `${bytes(total)}${snaps.length > cap ? ` (last ${cap} of ${snaps.length})` : ''}`;
  out.title = `Sum of incremental snapshot bytes. Largest single snapshot (logical): ${bytes(logical)}. ${failed} call(s) failed.`;
}

function diskCard(rows) {
  const items = rows.filter((r) => r.d.disk).map((r) => ({
    key: r.c.id, label: r.c.name, value: r.d.disk.used,
    sub: `${pct(r.d.disk.percent)} of ${bytes(r.d.disk.total)}`,
    color: r.d.disk.percent >= state.defaults.diskCritPercent ? 'var(--critical)'
      : r.d.disk.percent >= state.defaults.diskWarnPercent ? 'var(--warning)' : 'var(--series-1)',
  }));
  const body = items.length
    ? h('div', hbarList(items, { format: bytes, topN: 14, labelWidth: 140 }),
        h('div.legend',
          h('span', h('i', { style: { background: 'var(--series-1)' } }), 'normal'),
          h('span', h('i', { style: { background: 'var(--warning)' } }), `≥ ${state.defaults.diskWarnPercent}% used`),
          h('span', h('i', { style: { background: 'var(--critical)' } }), `≥ ${state.defaults.diskCritPercent}% used`)))
    : empty('No allocation data');
  return card('Disk used by cluster', 'from _cat/allocation', body);
}

function repoCard(rows) {
  const items = [];
  rows.forEach((r) => (r.d.repos || []).forEach((rp) => {
    const snaps = (r.d.snapshots && r.d.snapshots[rp.name]) || [];
    items.push({ key: `${r.c.id}/${rp.name}`, label: `${r.c.name} / ${rp.name}`, value: snaps.length,
      sub: `${rp.type} · ${rp.location || 'n/a'}` });
  }));
  return card('Snapshots per repository', 'count of snapshots currently in each repository',
    items.length ? hbarList(items, { format: num, topN: 12, labelWidth: 190 }) : empty('No repositories'));
}

function exportSummary(rows) {
  const data = rows.map(({ c, d }) => {
    const s = lastSnapshotOf(d);
    return {
      cluster: c.name, url: c.url, version: (d.info && d.info.version && d.info.version.number) || '',
      health: (d.health && d.health.status) || 'offline',
      nodes: (d.health && d.health.number_of_nodes) || 0,
      cluster_size_bytes: Math.max(0, clusterSize({ c, d })),
      disk_used_bytes: (d.disk && d.disk.used) || 0,
      disk_total_bytes: (d.disk && d.disk.total) || 0,
      disk_percent: d.disk && isFinite(d.disk.percent) ? d.disk.percent.toFixed(2) : '',
      ilm: (d.ilm && d.ilm.operation_mode) || '',
      slm: (d.slmStatus && d.slmStatus.operation_mode) || '',
      repositories: (d.repos || []).map((r) => r.name).join('|'),
      repo_locations: (d.repos || []).map((r) => r.location).join('|'),
      last_snapshot: s ? s.id : '', last_snapshot_status: s ? s.status : '',
      last_snapshot_at: s ? new Date(s.start).toISOString() : '',
    };
  });
  download(`es-cluster-summary-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(data), 'text/csv');
}
