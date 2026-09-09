/** Page 5 — snapshots, SLM policies and repositories: what exists, and managing it. */

import { h, mount, $ } from '../lib/dom.js';
import { num, dt, dur, ago, bytes, eachDay, ymdDots, toCsv, download } from '../lib/fmt.js';
import { state, client, activeClusters, fetchSnapshots, fetchOverview } from '../core/state.js';
import { coverageStrip } from '../lib/charts.js';
import { card, pill, statTile, table, empty } from './common.js';
import { writesAllowed, syncWrites, writeToggle, ensureWrites } from '../core/writes.js';
import {
  createSnapshotDialog, snapshotDetailsDialog, restoreSnapshotDialog, deleteSnapshot,
  deleteIndicesDialog, createRepositoryDialog, deleteRepository, verifyRepository, cleanupRepository,
} from '../ui/snapshot-dialogs.js';

/** Default to the handful an operator actually looks at; "Show more" widens it. */
const DEFAULT_LIMIT = 5;
const MORE_STEP = 20;

let host = null;
const ui = { repo: {}, days: 60, limit: DEFAULT_LIMIT };

export function render(el) {
  host = el;
  syncWrites().then(draw).catch(() => {});
  draw();
}
export function onData() { if (host && host.isConnected) draw(); }

function draw() {
  const list = activeClusters();
  mount(host, ...list.map(clusterBlock), list.length ? null : empty('No cluster selected'));
}

/** Re-read repositories and snapshots after something changed them. */
async function reload(c) {
  await fetchOverview(c.id);
  draw();
}

function clusterBlock(c) {
  const d = state.data.get(c.id) || {};
  const repos = d.repos || [];
  const policies = d.slm || [];
  const selected = ui.repo[c.id] || (repos[0] && repos[0].name);
  const snaps = (d.snapshots && d.snapshots[selected]) || [];

  const cov = coverage(snaps, ui.days);
  const oldest = snaps.length ? snaps[snaps.length - 1] : null;
  const newest = snaps.length ? snaps[0] : null;

  return h('section', { style: { marginBottom: '22px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' } },
      h('h2', { style: { fontSize: '14px', margin: 0 } }, c.name),
      h('span.mono.muted', { style: { fontSize: '11.5px' } }, c.url),
      d.slmStatus ? pill(`SLM ${d.slmStatus.operation_mode}`, d.slmStatus.operation_mode === 'RUNNING' ? 'green' : 'yellow') : null,
      d.ilm ? pill(`ILM ${d.ilm.operation_mode}`, d.ilm.operation_mode === 'RUNNING' ? 'green' : 'yellow') : null,
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'center' } },
        writeToggle(draw),
        h('button.btn.sm', { onclick: () => fetchSnapshots(c.id) }, '↻ Reload snapshots'))),

    h('div.grid.c4', { style: { marginBottom: '14px' } },
      statTile('Snapshots available', num(snaps.length), selected ? `in ${selected}` : 'no repository'),
      statTile('Oldest snapshot', oldest ? dt(oldest.start).slice(0, 12) : '–', oldest ? ago(oldest.start) : ''),
      statTile('Newest snapshot', newest ? dt(newest.start).slice(0, 12) : '–', newest ? ago(newest.start) : ''),
      statTile('Retention window', oldest && newest ? `${Math.max(1, Math.round((newest.start - oldest.start) / 86400000))} days` : '–',
        cov.missing.length ? `${cov.missing.length} day(s) with no snapshot` : 'no gaps in the window')),

    card('Repositories', repos.length ? `${repos.length} registered` : '',
      repoTable(c, d, repos),
      [h('button.btn.sm.primary', {
        onclick: async () => { if (await createRepositoryDialog(c, d.pathRepo || [])) await reload(c); },
      }, '+ Add repository')]),

    h('div', { style: { marginTop: '14px' } },
      card('SLM policies', policies.length ? `${policies.length} configured` : '',
        policies.length ? slmTable(c, policies) : empty(d.slmSupported === false ? 'SLM API not available on this cluster' : 'No SLM policies configured'))),

    h('div', { style: { marginTop: '14px' } },
      card('Snapshot availability', `last ${ui.days} days in ${selected || '—'}`,
        h('div', { style: { display: 'grid', gap: '10px' } },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' } },
            h('label.field', 'Repository', (() => {
              const s = h('select', { onchange: (e) => { ui.repo[c.id] = e.target.value; ui.limit = DEFAULT_LIMIT; draw(); } },
                ...repos.map((r) => h('option', { value: r.name }, `${r.name} (${r.type})`)));
              s.value = selected || ''; return s;
            })()),
            h('label.field', 'Window', (() => {
              const s = h('select', { onchange: (e) => { ui.days = Number(e.target.value); draw(); } },
                ...[14, 30, 60, 90, 180, 365].map((n) => h('option', { value: String(n) }, `${n} days`)));
              s.value = String(ui.days); return s;
            })())),
          repos.length ? coverageStrip(cov.days, { perRow: 62 }) : empty('No repositories'),
          cov.missing.length
            ? h('div.banner.warn', h('div', h('div.ttl', `${cov.missing.length} day(s) without a successful snapshot`),
                h('div.mono', { style: { fontSize: '11.5px' } }, cov.missing.slice(0, 12).join(', ') + (cov.missing.length > 12 ? ` … +${cov.missing.length - 12}` : ''))))
            : repos.length ? h('div.sec', { style: { fontSize: '12px' } }, `Every day in the window has at least one successful snapshot.`) : null))),

    h('div', { style: { marginTop: '14px' } },
      card(`Snapshots in ${selected || '—'}`,
        snaps.length ? `${num(snaps.length)} total · showing the latest ${Math.min(ui.limit, snaps.length)}` : '',
        h('div', snapTable(c, selected, snaps),
          snaps.length > ui.limit
            ? h('div', { style: { padding: '10px', textAlign: 'center', display: 'flex', gap: '8px', justifyContent: 'center' } },
                h('button.btn.sm', { onclick: () => { ui.limit += MORE_STEP; draw(); } },
                  `Show ${Math.min(MORE_STEP, snaps.length - ui.limit)} more (${num(snaps.length - ui.limit)} hidden)`),
                h('button.btn.sm.ghost', { onclick: () => { ui.limit = snaps.length; draw(); } }, 'Show all'))
            : ui.limit > DEFAULT_LIMIT
              ? h('div', { style: { padding: '10px', textAlign: 'center' } },
                  h('button.btn.sm.ghost', { onclick: () => { ui.limit = DEFAULT_LIMIT; draw(); } }, `Show only the latest ${DEFAULT_LIMIT}`))
              : null),
        [
          h('button.btn.sm.primary', {
            disabled: !repos.length,
            title: repos.length ? 'Start a snapshot now' : 'Register a repository first',
            onclick: async () => {
              const made = await createSnapshotDialog(c, repos, selected);
              if (made) { await reload(c); setTimeout(() => fetchSnapshots(c.id), 4000); }
            },
          }, '+ Create snapshot'),
          h('button.btn.sm', { disabled: !snaps.length, onclick: () => download(`snapshots-${c.id}-${selected}.csv`,
            toCsv(snaps.map((s) => ({ snapshot: s.id, status: s.status, start: new Date(s.start).toISOString(),
              end: new Date(s.end).toISOString(), duration: s.duration, indices: s.indices,
              successful_shards: s.successful, failed_shards: s.failed, total_shards: s.total }))), 'text/csv') }, 'Export CSV'),
        ])));
}

/* --------------------------------- repositories -------------------------------- */

function repoTable(c, d, repos) {
  const can = writesAllowed();
  const trs = repos.map((r) => {
    const count = ((d.snapshots || {})[r.name] || []).length;
    return h('tr',
      h('td', h('div', { style: { fontWeight: 640 } }, r.name), r.error
        ? h('div.muted', { style: { fontSize: '11px', color: 'var(--critical)' }, title: r.error }, 'unreadable') : null),
      h('td', pill(r.type || '?', 'grey')),
      h('td.mono.trunc', { style: { fontSize: '11px', maxWidth: '320px' }, title: r.location || '' }, r.location || '–'),
      h('td.num', num(count)),
      h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
        h('button.btn.sm', { title: 'Check that every node can reach this repository',
          onclick: () => verifyRepository(c, r.name) }, 'Verify'),
        h('button.btn.sm', { title: 'Delete repository data no snapshot references any more',
          onclick: () => cleanupRepository(c, r.name, { onChanged: () => reload(c) }) }, 'Clean up'),
        h('button.btn.sm.danger', { title: can ? 'Unregister this repository' : 'Allow writes first',
          onclick: () => deleteRepository(c, r.name, { onChanged: () => reload(c) }) }, 'Remove'))));
  });
  return table(['Repository', 'Type', 'Location', 'Snapshots', ''], trs,
    { emptyText: 'No snapshot repository registered on this cluster' });
}

/* ------------------------------------ coverage ---------------------------------- */

function coverage(snaps, days) {
  const today = new Date();
  const start = new Date(today.getTime() - (days - 1) * 86400000);
  const byDay = new Map();
  snaps.forEach((s) => {
    if (!s.start) return;
    const k = ymdDots(new Date(s.start), '-');
    const v = byDay.get(k) || { count: 0, ok: 0, bad: 0 };
    v.count++;
    if (String(s.status).toUpperCase() === 'SUCCESS') v.ok++; else v.bad++;
    byDay.set(k, v);
  });
  const out = [], missing = [];
  eachDay(ymdDots(start, '-'), ymdDots(today, '-')).forEach((d) => {
    const k = ymdDots(d, '-');
    const v = byDay.get(k);
    const ok = !!(v && v.ok);
    if (!ok) missing.push(k);
    out.push({ date: k, ok: !!v, partial: !!(v && !v.ok), count: v ? v.count : 0,
      detail: v ? `${v.ok} success, ${v.bad} other` : 'no snapshot' });
  });
  return { days: out, missing };
}

/* -------------------------------------- SLM ------------------------------------- */

function slmTable(c, policies) {
  const trs = policies.map((p) => {
    const pol = p.policy || {};
    const ls = p.last_success, lf = p.last_failure;
    const failedLast = lf && (!ls || lf.time > ls.time);
    return h('tr',
      h('td', h('div', { style: { fontWeight: 640 } }, p.id),
        h('div.mono.muted', { style: { fontSize: '11px' } }, pol.name || '')),
      h('td.mono', { style: { fontSize: '11.5px' } }, pol.schedule || '–'),
      h('td.mono', { style: { fontSize: '11.5px' } }, pol.repository || '–'),
      h('td.mono.trunc', { style: { fontSize: '11px', maxWidth: '180px' },
        title: JSON.stringify((pol.config && pol.config.indices) || '') }, ((pol.config && pol.config.indices) || ['*']).toString()),
      h('td.mono', { style: { fontSize: '11px' } }, pol.retention
        ? [pol.retention.expire_after ? `expire ${pol.retention.expire_after}` : null,
           pol.retention.min_count !== undefined ? `min ${pol.retention.min_count}` : null,
           pol.retention.max_count !== undefined ? `max ${pol.retention.max_count}` : null].filter(Boolean).join(' · ')
        : 'none'),
      h('td', ls ? h('div', pill('success', 'green'), h('div.muted', { style: { fontSize: '11px' }, title: dt(ls.time) }, ago(ls.time)))
              : h('span.muted', 'never')),
      h('td', failedLast ? h('div', pill('failed', 'red'), h('div.muted.trunc', { style: { fontSize: '11px', maxWidth: '200px' }, title: String(lf.details || '') }, ago(lf.time)))
              : lf ? h('div.muted', { style: { fontSize: '11px' }, title: String(lf.details || '') }, `older: ${ago(lf.time)}`)
              : h('span.muted', 'none')),
      h('td.nowrap', { style: { fontSize: '11.5px' } }, p.next_execution_millis ? dt(p.next_execution_millis) : '–'),
      h('td', h('button.btn.sm', { onclick: () => execute(c, p.id) }, 'Run now')));
  });
  return table(['Policy', 'Schedule', 'Repository', 'Indices', 'Retention', 'Last success', 'Last failure', 'Next run', ''], trs);
}

async function execute(c, id) {
  if (!(await ensureWrites())) return;
  if (!confirm(`Trigger SLM policy "${id}" on ${c.name} now?\n\nThis starts a real snapshot.`)) return;
  try {
    const r = await client(c.id).executeSlmPolicy(id);
    alert(`Snapshot started: ${(r && r.snapshot_name) || 'ok'}`);
    setTimeout(() => fetchSnapshots(c.id), 3000);
  } catch (e) {
    alert(`Failed to execute policy: ${e.message}`);
  }
}

/* ----------------------------------- snapshots ---------------------------------- */

function snapTable(c, repo, snaps) {
  const refresh = { onChanged: () => reload(c) };
  const trs = snaps.slice(0, ui.limit).map((s) => {
    const st = String(s.status || '').toUpperCase();
    const cls = st === 'SUCCESS' ? 'green' : st === 'PARTIAL' || st === 'IN_PROGRESS' ? 'yellow' : st === 'FAILED' ? 'red' : 'grey';
    const running = st === 'IN_PROGRESS';
    return h('tr',
      h('td.mono', { style: { fontSize: '11.5px' } },
        h('a', { href: '#', style: { color: 'var(--accent)', textDecoration: 'none' },
          onclick: (e) => { e.preventDefault(); snapshotDetailsDialog(c, repo, s.id, refresh).then((changed) => { if (changed) reload(c); }); } }, s.id)),
      h('td', pill(st || '?', cls)),
      h('td.nowrap', { style: { fontSize: '11.5px' } }, dt(s.start)),
      h('td.nowrap.muted', { style: { fontSize: '11.5px' } }, s.end ? dt(s.end) : '–'),
      h('td.num', typeof s.duration === 'string' ? s.duration : dur(s.duration)),
      h('td.num', num(s.indices)),
      h('td.num', `${num(s.successful)}/${num(s.total)}`),
      h('td.num', s.failed ? h('span.pill.red', h('i.dot'), num(s.failed)) : h('span.muted', '0')),
      h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
        h('button.btn.sm', { title: 'Indices, shards and failures in this snapshot',
          onclick: () => snapshotDetailsDialog(c, repo, s.id, refresh).then((changed) => { if (changed) reload(c); }) }, 'Details'),
        h('button.btn.sm', { disabled: running, title: running ? 'Still running' : 'Restore indices from this snapshot',
          onclick: () => restoreSnapshotDialog(c, repo, s.id, refresh) }, 'Restore'),
        h('button.btn.sm', { disabled: running,
          title: 'Delete the live indices this snapshot holds — the snapshot itself is kept',
          onclick: () => deleteIndicesDialog(c, repo, s.id, refresh) }, 'Free indices'),
        h('button.btn.sm.danger', { disabled: running, title: running ? 'Still running' : 'Delete this snapshot',
          onclick: () => deleteSnapshot(c, repo, s.id, refresh) }, 'Delete'))));
  });
  return table(['Snapshot', 'Status', 'Started', 'Ended', 'Duration', 'Indices', 'Shards ok', 'Failed', ''], trs,
    { emptyText: 'No snapshots in this repository' });
}
