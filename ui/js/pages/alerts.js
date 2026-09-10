/** Page — everything currently wrong across the fleet, in one place. */

import { h, mount, $ } from '../lib/dom.js';
import { ago, dt, toCsv, download, num } from '../lib/fmt.js';
import { state, bus, alerts, clusters, activeClusters, client, fetchOverview, refreshAll } from '../core/state.js';
import { card, pill, statTile, table, empty, connectionBanner } from './common.js';
import { navigateTo } from '../core/intent.js';

let host = null;
const ui = { level: 'all', cluster: 'all', text: '' };

export function render(el) { host = el; el.classList.add('dense'); draw(); }
export function onData() { if (host && host.isConnected) draw(); }

/** Which page answers this alert. */
function routeFor(a) {
  const t = `${a.title} ${a.detail || ''}`.toLowerCase();
  if (/snapshot|slm/.test(t)) return { page: 'snapshots', label: 'Snapshots & SLM' };
  if (/ilm/.test(t)) return { page: 'indices', label: 'Indices' };
  if (/shard/.test(t)) return { page: 'nodes', label: 'Nodes & shards' };
  if (/disk/.test(t)) return { page: 'nodes', label: 'Nodes & shards' };
  return { page: 'overview', label: 'Clusters' };
}

function filtered(all) {
  let rows = all;
  if (ui.level !== 'all') rows = rows.filter((a) => (ui.level === 'critical' ? a.level === 'critical' : a.level !== 'critical'));
  if (ui.cluster !== 'all') rows = rows.filter((a) => a.cluster && a.cluster.id === ui.cluster);
  const t = ui.text.trim().toLowerCase();
  if (t) rows = rows.filter((a) => `${a.title} ${a.detail || ''}`.toLowerCase().includes(t));
  // critical first, then by cluster name so a fleet reads consistently
  return [...rows].sort((a, b) => {
    if ((a.level === 'critical') !== (b.level === 'critical')) return a.level === 'critical' ? -1 : 1;
    return String(a.cluster && a.cluster.name).localeCompare(String(b.cluster && b.cluster.name));
  });
}

function draw() {
  const all = alerts();
  const rows = filtered(all);
  const crit = all.filter((a) => a.level === 'critical');
  const warn = all.filter((a) => a.level !== 'critical');
  const byCluster = new Map();
  all.forEach((a) => {
    const k = a.cluster ? a.cluster.id : '?';
    byCluster.set(k, (byCluster.get(k) || 0) + 1);
  });
  const list = clusters();

  mount(host,
    h('div.grid.c4', { style: { marginBottom: '14px' } },
      statTile('Open alerts', num(all.length), all.length ? 'across the fleet' : 'nothing to report'),
      statTile('Critical', num(crit.length), crit.length ? 'needs attention now' : 'none'),
      statTile('Warnings', num(warn.length), warn.length ? 'worth a look' : 'none'),
      statTile('Clusters affected', num(byCluster.size), `of ${num(list.length)} configured`)),

    h('div.toolbar',
      h('label.field', 'Level', (() => {
        const s = h('select', { onchange: (e) => { ui.level = e.target.value; draw(); } },
          h('option', { value: 'all' }, `Any (${all.length})`),
          h('option', { value: 'critical' }, `Critical (${crit.length})`),
          h('option', { value: 'warning' }, `Warning (${warn.length})`));
        s.value = ui.level; return s;
      })()),
      h('label.field', 'Cluster', (() => {
        const s = h('select', { onchange: (e) => { ui.cluster = e.target.value; draw(); } },
          h('option', { value: 'all' }, 'All clusters'),
          ...list.map((c) => h('option', { value: c.id }, `${c.name}${byCluster.get(c.id) ? ` (${byCluster.get(c.id)})` : ''}`)));
        s.value = ui.cluster; return s;
      })()),
      h('label.field', 'Search', h('input', { type: 'search', placeholder: 'title or detail…', value: ui.text,
        style: { minWidth: '240px' }, oninput: (e) => { ui.text = e.target.value; draw(); } })),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'flex-end' } },
        h('span.muted', { style: { fontSize: '11.5px' } }, `updated ${ago(state.lastRefresh)}`),
        h('button.btn.sm', { onclick: () => { ui.level = 'all'; ui.cluster = 'all'; ui.text = ''; draw(); } }, 'Clear'),
        h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, '↻ Refresh'))),

    h('div', { style: { marginTop: '14px' } },
      all.length
        ? card(`Alerts (${rows.length}${rows.length !== all.length ? ` of ${all.length}` : ''})`,
            `${crit.length} critical · ${warn.length} warning`,
            alertTable(rows),
            [h('button.btn.sm', { disabled: !all.length, onclick: () => exportAlerts(all) }, 'Export CSV')])
        : card('Alerts', 'nothing to report',
            h('div', { style: { padding: '26px 0', textAlign: 'center' } },
              h('div', { style: { fontSize: '26px', marginBottom: '6px' } }, '✓'),
              h('div', { style: { fontWeight: 640 } }, 'Every cluster is healthy'),
              h('div.muted', { style: { fontSize: '12.5px', marginTop: '3px' } },
                `No health, disk, ILM or snapshot problem across ${num(list.length)} cluster${list.length === 1 ? '' : 's'}.`)))),

    // The clusters that cannot be reached at all get their decision buttons here too.
    h('div', { style: { marginTop: '14px' } },
      ...activeClusters()
        .filter((c) => { const d = state.data.get(c.id); return d && !d.reachable && d.updatedAt; })
        .map((c) => connectionBanner(c, () => fetchOverview(c.id)))));
}

function alertTable(rows) {
  const trs = rows.map((a) => {
    const r = routeFor(a);
    return h('tr',
      h('td', pill(a.level === 'critical' ? 'critical' : 'warning', a.level === 'critical' ? 'red' : 'yellow')),
      h('td', h('div', { style: { fontWeight: 620 } }, a.cluster ? a.cluster.name : '–'),
        a.cluster ? h('div.mono.muted', { style: { fontSize: '11px' } }, a.cluster.url) : null),
      h('td', h('div', a.title)),
      h('td.muted', { style: { fontSize: '12px', maxWidth: '420px', wordBreak: 'break-word' } }, a.detail || ''),
      h('td', h('button.btn.sm', { onclick: () => navigateTo(r.page) }, r.label)));
  });
  return table(['Level', 'Cluster', 'Alert', 'Detail', ''], trs, { emptyText: 'No alert matches the filter' });
}

function exportAlerts(all) {
  download(`es-alerts-${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(all.map((a) => ({
      level: a.level,
      cluster: a.cluster ? a.cluster.name : '',
      url: a.cluster ? a.cluster.url : '',
      title: a.title,
      detail: a.detail || '',
      observed_at: new Date(state.lastRefresh || Date.now()).toISOString(),
    }))), 'text/csv');
}
