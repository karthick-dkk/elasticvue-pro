/** Page — everything currently wrong across the fleet, in one place. */

import { h, mount, $ } from '../lib/dom.js';
import { ago, dt, toCsv, download, num } from '../lib/fmt.js';
import { state, bus, alerts, clusters, activeClusters, client, fetchOverview, refreshAll } from '../core/state.js';
import { card, collapsible, pill, statTile, table, empty, connectionBanner } from './common.js';
import { hbarList, legend } from '../lib/charts.js';
import { navigateTo } from '../core/intent.js';
import { rowMenu, ICON } from '../ui/menu.js';
import { confirmDialog } from '../ui/modal.js';
import {
  loadAcks, loadCurrentUser, currentUser, setCurrentUser, ackFor, isAcked, noteCount,
  acknowledge, unacknowledge, addNote, removeNote, pruneAcks,
} from '../core/acks.js';

let host = null;
const ui = { level: 'all', cluster: 'all', text: '', show: 'open', view: 'table', expanded: new Set() };

/**
 * What kind of problem this is, taken from the alert key rather than its wording — the
 * title carries live numbers, the key does not.
 */
const KIND_LABEL = {
  unreachable: 'Unreachable',
  health: 'Cluster health',
  disk: 'Disk usage',
  ilm: 'ILM errors',
  'slm-mode': 'SLM stopped',
  'slm-fail': 'SLM run failed',
  'slm-stale': 'Snapshot overdue',
};

function kindOf(a) {
  const rest = String(a.key || '').split(':').slice(1).join(':');
  const base = rest.split(':')[0] || 'other';
  const full = rest.startsWith('slm-fail') ? 'slm-fail' : rest.startsWith('slm-stale') ? 'slm-stale' : base;
  return KIND_LABEL[full] || full;
}

export function render(el) {
  host = el;
  el.classList.add('dense');
  // Acknowledgements live on this machine; load them before the first paint so rows do
  // not flicker from unacknowledged to acknowledged.
  Promise.all([loadAcks(), loadCurrentUser()])
    .then(() => { pruneAcks(alerts().map((a) => a.key)); draw(); })
    .catch(() => {});
  draw();
}
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
  if (ui.show === 'open') rows = rows.filter((a) => !isAcked(a.key));
  else if (ui.show === 'acked') rows = rows.filter((a) => isAcked(a.key));
  const t = ui.text.trim().toLowerCase();
  if (t) {
    rows = rows.filter((a) => {
      const notes = (ackFor(a.key).notes || []).map((n) => n.text).join(' ');
      return `${a.title} ${a.detail || ''} ${notes}`.toLowerCase().includes(t);
    });
  }
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
  const acked = all.filter((a) => isAcked(a.key));
  const open = all.filter((a) => !isAcked(a.key));
  const byCluster = new Map();
  all.forEach((a) => {
    const k = a.cluster ? a.cluster.id : '?';
    byCluster.set(k, (byCluster.get(k) || 0) + 1);
  });
  const list = clusters();

  mount(host,
    h('div.grid.c4', { style: { marginBottom: '10px' } },
      statTile('Open', num(open.length), open.length ? 'not yet acknowledged' : 'all acknowledged'),
      statTile('Critical', num(crit.filter((a) => !isAcked(a.key)).length), `${num(crit.length)} in total`),
      statTile('Acknowledged', num(acked.length), acked.length ? 'seen, still active' : 'none'),
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
      h('label.field', 'Show', (() => {
        const sel = h('select', { onchange: (e) => { ui.show = e.target.value; draw(); } },
          h('option', { value: 'open' }, `Open (${open.length})`),
          h('option', { value: 'acked' }, `Acknowledged (${acked.length})`),
          h('option', { value: 'all' }, `Everything (${all.length})`));
        sel.value = ui.show; return sel;
      })()),
      h('label.field', 'Search', h('input', { type: 'search', placeholder: 'title, detail or note…', value: ui.text,
        style: { minWidth: '220px' }, oninput: (e) => { ui.text = e.target.value; draw(); } })),
      h('label.field', 'View', (() => {
        const sel = h('select', { onchange: (e) => { ui.view = e.target.value; draw(); } },
          h('option', { value: 'table' }, 'Table'),
          h('option', { value: 'graph' }, 'Graph'),
          h('option', { value: 'both' }, 'Graph + table'));
        sel.value = ui.view; return sel;
      })()),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'flex-end' } },
        h('span.muted', { style: { fontSize: '11.5px' } }, `updated ${ago(state.lastRefresh)}`),
        h('button.btn.sm', { onclick: () => { ui.level = 'all'; ui.cluster = 'all'; ui.text = ''; ui.show = 'open'; draw(); } }, 'Clear'),
        h('button.btn.sm', { onclick: () => refreshAll({ force: true }) }, '↻ Refresh'))),

    ui.view !== 'table' && all.length
      ? h('div', { style: { marginTop: '10px' } }, graphView(rows, all))
      : null,

    all.length && ui.view !== 'graph'
      ? h('div', { style: { marginTop: '10px' } },
          card(`Alerts (${rows.length}${rows.length !== all.length ? ` of ${all.length}` : ''})`,
            `${crit.length} critical · ${warn.length} warning · ${acked.length} acknowledged`,
            alertTable(rows),
            [h('button.btn.sm', { onclick: () => exportAlerts(all) }, 'Export CSV')]))
      : null,

    h('div', { style: { marginTop: '10px' } },
      all.length ? null
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

/* ---------------------------------- graph view -------------------------------- */

/**
 * Alerts as bars, so a fleet is read at a glance instead of scrolled.
 *
 * Two cuts: one bar per cluster — which client is in trouble — and one per kind of
 * problem — whether it is the same fault everywhere. Both respect the filters above,
 * and a bar is clickable: it narrows the page to that cluster.
 */
function graphView(rows, all) {
  const worst = (list) => (list.some((a) => a.level === 'critical') ? 'var(--critical)' : 'var(--warning)');

  const byCluster = new Map();
  for (const a of rows) {
    const name = a.cluster ? a.cluster.name : 'unknown';
    if (!byCluster.has(name)) byCluster.set(name, { id: a.cluster && a.cluster.id, list: [] });
    byCluster.get(name).list.push(a);
  }

  const clusterItems = [...byCluster.entries()].map(([name, v]) => {
    const crit = v.list.filter((a) => a.level === 'critical').length;
    const ackd = v.list.filter((a) => isAcked(a.key)).length;
    return {
      key: v.id || name, label: name, value: v.list.length, color: worst(v.list),
      sub: [crit ? `${crit} critical` : null,
            v.list.length - crit ? `${v.list.length - crit} warning` : null,
            ackd ? `${ackd} acknowledged` : null].filter(Boolean).join(' · '),
    };
  });

  const byKind = new Map();
  for (const a of rows) {
    const k = kindOf(a);
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(a);
  }
  const kindItems = [...byKind.entries()].map(([label, list]) => ({
    key: label, label, value: list.length, color: worst(list),
    sub: [...new Set(list.map((a) => (a.cluster ? a.cluster.name : '?')))].slice(0, 4).join(', '),
  }));

  const scale = legend([
    { label: 'has a critical alert', color: 'var(--critical)' },
    { label: 'warnings only', color: 'var(--warning)' },
  ]);

  return h('div.grid.c2',
    card('Alerts by cluster', `${clusterItems.length} cluster${clusterItems.length === 1 ? '' : 's'} · click a bar to filter`,
      clusterItems.length
        ? h('div', hbarList(clusterItems, {
            format: (v) => String(v), topN: 24, labelWidth: 170, showOther: false,
            onSelect: (r) => { ui.cluster = ui.cluster === r.key ? 'all' : r.key; draw(); },
          }), scale)
        : empty('Nothing matches the filter')),
    card('Alerts by kind', 'the same fault across the fleet, or different ones',
      kindItems.length
        ? hbarList(kindItems, { format: (v) => String(v), topN: 16, labelWidth: 170, showOther: false })
        : empty('Nothing matches the filter')));
}

/** Ask who is acknowledging, once per machine. */
async function ensureUser() {
  if (currentUser()) return currentUser();
  const name = window.prompt(
    'Your name or initials, recorded against acknowledgements and notes on this machine:', '');
  if (name && name.trim()) await setCurrentUser(name);
  return currentUser();
}

async function doAck(a) {
  await ensureUser();
  await acknowledge(a.key);
  draw();
}

async function doUnack(a) {
  const ok = await confirmDialog(`Re-open ${a.title}?`,
    'The alert goes back to the open list. Notes written against it are kept.',
    { yes: 're-open' });
  if (!ok) return;
  await unacknowledge(a.key);
  draw();
}

/** The notes panel under an expanded row. */
function notesPanel(a) {
  const rec = ackFor(a.key);
  const input = h('input', {
    type: 'text', placeholder: 'Add a note — what was found, who is on it, ticket number…',
    style: { flex: '1', minWidth: '240px' },
    onkeydown: async (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      await ensureUser();
      await addNote(a.key, e.target.value);
      e.target.value = '';
      draw();
    },
  });

  return h('div', { style: { display: 'grid', gap: '7px', padding: '4px 0 8px' } },
    rec.acked
      ? h('div.muted', { style: { fontSize: '11.5px' } },
          `Acknowledged by ${rec.ackedBy || 'operator'} ${ago(rec.ackedAt)}`)
      : null,
    (rec.notes || []).length
      ? h('div', ...rec.notes.slice().sort((x, y) => x.ts - y.ts).map((n) =>
          h('div.note',
            h('b', n.by || 'operator'), h('span.when', { title: dt(n.ts) }, ago(n.ts)),
            h('div', n.text),
            h('button.btn.sm.ghost', {
              style: { padding: '0 5px', fontSize: '11px' },
              title: 'Remove this note',
              onclick: async () => {
                if (await confirmDialog('Remove this note?', n.text, { yes: 'remove', danger: true })) {
                  await removeNote(a.key, n.ts); draw();
                }
              },
            }, ICON.delete))))
      : h('div.muted', { style: { fontSize: '11.5px' } }, 'No notes yet.'),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
      input,
      h('button.btn.sm', {
        onclick: async (e) => {
          const box = e.target.previousSibling;
          if (!box.value.trim()) return;
          await ensureUser();
          await addNote(a.key, box.value);
          box.value = '';
          draw();
        },
      }, 'Add note')));
}

function alertTable(rows) {
  const trs = [];
  rows.forEach((a) => {
    const r = routeFor(a);
    const rec = ackFor(a.key);
    const acked = !!rec.acked;
    const notes = noteCount(a.key);
    const open = ui.expanded.has(a.key);

    trs.push(h(`tr${acked ? '.ack-row' : ''}`,
      h('td', pill(a.level === 'critical' ? 'critical' : 'warning', a.level === 'critical' ? 'red' : 'yellow')),
      h('td', h('div', { style: { fontWeight: 620 } }, a.cluster ? a.cluster.name : '–'),
        a.cluster ? h('div.mono.muted', { style: { fontSize: '11px' } }, a.cluster.url) : null),
      h('td', h('div', a.title),
        acked ? h('div.muted', { style: { fontSize: '10.5px' } },
          `ack ${rec.ackedBy || 'operator'} · ${ago(rec.ackedAt)}`) : null),
      h('td.muted', { style: { fontSize: '12px', maxWidth: '360px', wordBreak: 'break-word' } }, a.detail || ''),
      h('td', acked ? pill('acknowledged', 'grey') : pill('open', a.level === 'critical' ? 'red' : 'yellow')),
      h('td', h('button.btn.sm.ghost', {
        title: notes ? `${notes} note(s)` : 'Add a note',
        onclick: () => { open ? ui.expanded.delete(a.key) : ui.expanded.add(a.key); draw(); },
      }, `💬 ${notes || ''}`.trim())),
      h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
        acked
          ? h('button.btn.sm', { title: 'Put it back on the open list', onclick: () => doUnack(a) }, 'Re-open')
          : h('button.btn.sm.primary', { title: 'Mark as seen — it stays until the condition clears', onclick: () => doAck(a) }, 'ACK'),
        rowMenu([
          { label: open ? 'Hide notes' : 'Notes & comments…', icon: '💬',
            onClick: () => { open ? ui.expanded.delete(a.key) : ui.expanded.add(a.key); draw(); } },
          { label: `Go to ${r.label}`, icon: ICON.console, onClick: () => navigateTo(r.page) },
          { sep: true },
          { hint: `key: ${a.key}` },
        ], { title: `Actions for ${a.title}` })))));

    if (open) {
      trs.push(h('tr', h('td', { colspan: 7, style: { background: 'var(--surface-2)' } }, notesPanel(a))));
    }
  });
  return table(['Level', 'Cluster', 'Alert', 'Detail', 'State', 'Notes', ''], trs,
    { emptyText: ui.show === 'open' ? 'Nothing open — every alert here is acknowledged.' : 'No alert matches the filter' });
}

function exportAlerts(all) {
  download(`es-alerts-${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(all.map((a) => {
      const rec = ackFor(a.key);
      return {
        level: a.level,
        cluster: a.cluster ? a.cluster.name : '',
        url: a.cluster ? a.cluster.url : '',
        alert: a.title,
        detail: a.detail || '',
        state: rec.acked ? 'acknowledged' : 'open',
        acknowledged_by: rec.ackedBy || '',
        acknowledged_at: rec.ackedAt ? new Date(rec.ackedAt).toISOString() : '',
        notes: (rec.notes || []).map((n) => `[${new Date(n.ts).toISOString().slice(0, 16)} ${n.by}] ${n.text}`).join(' | '),
        key: a.key,
        observed_at: new Date(state.lastRefresh || Date.now()).toISOString(),
      };
    })), 'text/csv');
}
