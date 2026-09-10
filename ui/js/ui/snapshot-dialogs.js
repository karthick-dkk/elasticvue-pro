/**
 * Snapshot, restore and repository dialogs.
 *
 * Every action here changes the cluster, so each one goes through `ensureWrites()` first:
 * the operator must have unlocked writes for the session, and each request carries
 * `allowWrites`. The core refuses it otherwise — see core/writes.js and the Rust guard.
 */

import { h, mount, $ } from '../lib/dom.js';
import { bytes, num, dt, dur, ago } from '../lib/fmt.js';
import { modal, confirmDialog, nameList, field, text, select, checkbox, val, checked } from './modal.js';
import { ensureWrites } from '../core/writes.js';
import { client } from '../core/state.js';

/** `manual-2026.09.09-141530` — sortable, and obviously not an SLM snapshot. */
export function suggestedSnapshotName(prefix = 'manual') {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${prefix}-${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------ index picker ------------------------------- */

/**
 * "All indices" or an explicit list. Returns a node plus `value()`, which gives the
 * string Elasticsearch wants (`*`, or a comma-separated list).
 */
function indexPicker(names, { allLabel = 'All indices (*)' } = {}) {
  const state = { mode: 'all', chosen: new Set(), filter: '' };
  const listBox = h('div', {
    style: { maxHeight: '210px', overflow: 'auto', border: '1px solid var(--border)',
             borderRadius: '6px', padding: '6px', display: 'none' },
  });
  const count = h('span.muted', { style: { fontSize: '11px' } }, '');

  function visible() {
    const f = state.filter.trim().toLowerCase();
    return f ? names.filter((n) => n.toLowerCase().includes(f)) : names;
  }
  function drawList() {
    const rows = visible().slice(0, 500).map((n) =>
      h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', padding: '1px 0', cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: state.chosen.has(n), style: { cursor: 'pointer' },
          onchange: (e) => { if (e.target.checked) state.chosen.add(n); else state.chosen.delete(n); drawCount(); } }),
        h('span.mono', { style: { wordBreak: 'break-all' } }, n)));
    mount(listBox, rows.length ? h('div', ...rows) : h('div.muted', { style: { fontSize: '12px', padding: '6px' } }, 'No index matches'),
      visible().length > 500
        ? h('div.muted', { style: { fontSize: '11px', padding: '4px' } }, `…and ${visible().length - 500} more — narrow the filter`)
        : null);
    drawCount();
  }
  function drawCount() {
    mount(count, state.mode === 'all'
      ? `every index in the cluster (${num(names.length)})`
      : `${num(state.chosen.size)} of ${num(names.length)} selected`);
  }

  const filterRow = h('div', { style: { display: 'none', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
    h('input', { type: 'search', placeholder: 'filter indices…', style: { flex: '1' },
      oninput: (e) => { state.filter = e.target.value; drawList(); } }),
    h('button.btn.sm', { type: 'button', onclick: () => { visible().forEach((n) => state.chosen.add(n)); drawList(); } }, 'Select shown'),
    h('button.btn.sm.ghost', { type: 'button', onclick: () => { state.chosen.clear(); drawList(); } }, 'Clear'));

  const modeSel = select('sd-index-mode', 'all', [['all', allLabel], ['pick', 'Choose indices…']]);
  modeSel.onchange = (e) => {
    state.mode = e.target.value;
    const showing = state.mode === 'pick';
    listBox.style.display = showing ? 'block' : 'none';
    filterRow.style.display = showing ? 'flex' : 'none';
    if (showing) drawList(); else drawCount();
  };

  drawList();
  drawCount();

  return {
    node: h('div', { style: { display: 'grid', gap: '6px' } },
      field('Indices', modeSel), filterRow, listBox, count),
    value() { return state.mode === 'all' ? '*' : [...state.chosen].join(','); },
    isEmpty() { return state.mode === 'pick' && state.chosen.size === 0; },
  };
}

/* ----------------------------- create snapshot ----------------------------- */

export async function createSnapshotDialog(cluster, repos, preselectedRepo) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);

  let names = [];
  try {
    names = (await cl.indexNames('*')).map((r) => r.index).filter(Boolean).sort();
  } catch (_) { /* the picker still offers "all indices" */ }

  const picker = indexPicker(names);
  const body = [
    field('Repository', select('sd-repo', preselectedRepo || (repos[0] && repos[0].name) || '',
      repos.map((r) => [r.name, `${r.name} (${r.type})`]))),
    field('Snapshot name', text('sd-name', suggestedSnapshotName(), { mono: true }),
      'Lower case, no spaces. Must not already exist in the repository.'),
    picker.node,
    h('div', { style: { display: 'grid', gap: '7px', marginTop: '2px' } },
      checkbox('sd-ignore', 'Ignore unavailable indices', true,
        'Skip indices that are missing or closed instead of failing the whole snapshot.'),
      checkbox('sd-global', 'Include global state', false,
        'Cluster settings, templates and ILM/SLM policies. Off keeps the snapshot to data only.'),
      checkbox('sd-partial', 'Allow partial snapshot', false,
        'Continue even when some shards are unavailable. The result is marked PARTIAL.')),
  ];

  return modal(`Create a snapshot on ${cluster.name}`, 'Runs in the background — the list refreshes when it is accepted.', body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const repo = val('sd-repo');
        const name = val('sd-name').trim();
        if (!repo) throw new Error('Pick a repository.');
        if (!name) throw new Error('Give the snapshot a name.');
        if (name !== name.toLowerCase()) throw new Error('Elasticsearch requires a lower-case snapshot name.');
        if (picker.isEmpty()) throw new Error('Choose at least one index, or switch back to "All indices".');
        await cl.createSnapshot(repo, name, {
          indices: picker.value(),
          ignore_unavailable: checked('sd-ignore'),
          include_global_state: checked('sd-global'),
          partial: checked('sd-partial'),
        });
        ctx.done({ repo, name });
      }) }, 'Create snapshot'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '620px' });
}

/* ---------------------------- snapshot details ----------------------------- */

export async function snapshotDetailsDialog(cluster, repo, snapshotId, { onChanged } = {}) {
  const cl = client(cluster.id);
  const bodyHost = h('div', h('div.muted', { style: { fontSize: '12.5px' } }, 'Loading…'));

  const p = modal(`${snapshotId}`, `in ${repo} · ${cluster.name}`, [bodyHost],
    (ctx) => [
      h('button.btn.primary', { onclick: async () => { ctx.done('restore'); } }, 'Restore…'),
      h('button.btn.danger', { onclick: async () => { ctx.done('delete'); } }, 'Delete snapshot…'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Close'),
    ], { width: '760px' });

  try {
    const j = await cl.snapshotDetail(repo, snapshotId);
    const s = (j.snapshots || [])[0] || {};
    const shards = s.shards || {};
    const indices = s.indices || [];
    const failures = s.failures || [];
    mount(bodyHost,
      h('div', { style: { display: 'grid', gap: '10px' } },
        h('div.grid.c4',
          tile('State', s.state || '?'),
          tile('Indices', num(indices.length)),
          tile('Shards', `${num(shards.successful || 0)}/${num(shards.total || 0)}`),
          tile('Duration', s.duration_in_millis != null ? dur(s.duration_in_millis) : '–')),
        kvRow('Started', s.start_time ? `${dt(new Date(s.start_time).getTime())} (${ago(new Date(s.start_time).getTime())})` : '–'),
        kvRow('Ended', s.end_time ? dt(new Date(s.end_time).getTime()) : '–'),
        kvRow('Version', s.version || '–'),
        kvRow('Global state', s.include_global_state === true ? 'included' : 'not included'),
        failures.length
          ? h('div.banner.err', { style: { margin: 0 } },
              h('div', h('div.ttl', `${failures.length} shard failure(s)`),
                h('div.mono', { style: { fontSize: '11px', maxHeight: '90px', overflow: 'auto' } },
                  failures.slice(0, 20).map((f) => h('div', `${f.index || ''}[${f.shard_id ?? '?'}] ${f.reason || ''}`)))))
          : null,
        h('div',
          h('div', { style: { fontWeight: 640, fontSize: '12.5px', marginBottom: '5px' } }, `Indices in this snapshot (${num(indices.length)})`),
          h('div.mono', { style: { fontSize: '11.5px', maxHeight: '180px', overflow: 'auto',
                                   border: '1px solid var(--border)', borderRadius: '6px', padding: '7px' } },
            indices.length ? indices.map((n) => h('div', n)) : h('span.muted', 'none')))));
  } catch (e) {
    mount(bodyHost, h('div.banner.err', { style: { margin: 0 } }, h('div', `Could not read the snapshot: ${e.message}`)));
  }

  const choice = await p;
  if (choice === 'restore') return restoreSnapshotDialog(cluster, repo, snapshotId, { onChanged });
  if (choice === 'delete') return deleteSnapshot(cluster, repo, snapshotId, { onChanged });
  return false;
}

function tile(k, v) { return h('div.stat', h('div.k', k), h('div.v', { style: { fontSize: '15px' } }, v)); }
function kvRow(k, v) {
  return h('div', { style: { display: 'flex', gap: '10px', fontSize: '12px' } },
    h('span.muted', { style: { width: '110px', flex: 'none' } }, k), h('span', String(v)));
}

/* ---------------------------- restore snapshot ----------------------------- */

export async function restoreSnapshotDialog(cluster, repo, snapshotId, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);

  let names = [];
  try {
    const j = await cl.snapshotDetail(repo, snapshotId);
    names = (((j.snapshots || [])[0] || {}).indices || []).slice().sort();
  } catch (_) { /* fall back to "all indices in the snapshot" */ }

  const picker = indexPicker(names, { allLabel: 'Every index in the snapshot (*)' });
  const body = [
    h('div.banner.warn', { style: { margin: '0 0 4px' } },
      h('div', h('div.ttl', 'Restoring writes to the cluster'),
        h('div', 'An index that already exists must be closed first, or renamed below. Restoring under a new name is the safe default.'))),
    picker.node,
    field('Rename pattern', text('sd-rpat', '(.+)', { mono: true }), 'Regular expression matched against each index name.'),
    field('Rename replacement', text('sd-rrep', 'restored-$1', { mono: true }),
      'Leave both empty to restore under the original names (the index must not already exist and be open).'),
    h('div', { style: { display: 'grid', gap: '7px' } },
      checkbox('sd-rignore', 'Ignore unavailable indices', true),
      checkbox('sd-raliases', 'Include aliases', true),
      checkbox('sd-rglobal', 'Include global state', false,
        'Overwrites cluster settings, templates and policies with the snapshot’s. Rarely what you want.')),
  ];

  const res = await modal(`Restore ${snapshotId}`, `from ${repo} · ${cluster.name}`, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        if (picker.isEmpty()) throw new Error('Choose at least one index, or switch back to every index.');
        const pat = val('sd-rpat').trim();
        const rep = val('sd-rrep').trim();
        if (!!pat !== !!rep) throw new Error('Give both a rename pattern and a replacement, or neither.');
        const b = {
          indices: picker.value(),
          ignore_unavailable: checked('sd-rignore'),
          include_aliases: checked('sd-raliases'),
          include_global_state: checked('sd-rglobal'),
        };
        if (pat) { b.rename_pattern = pat; b.rename_replacement = rep; }
        await cl.restoreSnapshot(repo, snapshotId, b);
        ctx.done(true);
      }) }, 'Restore'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '620px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* ----------------------------- delete snapshot ----------------------------- */

export async function deleteSnapshot(cluster, repo, snapshotId, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const ok = await confirmDialog(`Delete snapshot ${snapshotId}?`,
    `From repository "${repo}" on ${cluster.name}.\n\n` +
    'The snapshot, and the data only it holds, are removed from the repository. Indices in ' +
    'the cluster are not touched. This cannot be undone.',
    { yes: 'delete', danger: true });
  if (!ok) return false;
  try {
    await client(cluster.id).deleteSnapshot(repo, snapshotId);
    if (onChanged) await onChanged();
    return true;
  } catch (e) {
    alert(`Could not delete the snapshot: ${e.message}`);
    return false;
  }
}

/* --------------------------- delete a live index --------------------------- */

/**
 * Delete indices from the CLUSTER — the usual "it is safely in a snapshot, reclaim the
 * disk" step. The snapshot copy is untouched; this only removes the live index.
 */
export async function deleteIndicesDialog(cluster, repo, snapshotId, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);

  let inSnapshot = [];
  try {
    const j = await cl.snapshotDetail(repo, snapshotId);
    inSnapshot = (((j.snapshots || [])[0] || {}).indices || []).slice().sort();
  } catch (e) {
    alert(`Could not read the snapshot's index list: ${e.message}`);
    return false;
  }

  // Only offer indices that still exist in the cluster, with their size.
  let live = new Map();
  try {
    for (const r of await cl.indexNames('*')) live.set(r.index, r);
  } catch (_) { /* sizes are a nicety, not a requirement */ }

  const present = inSnapshot.filter((n) => live.size === 0 || live.has(n));
  const gone = inSnapshot.length - present.length;
  const chosen = new Set();
  const totalEl = h('div.muted', { style: { fontSize: '11.5px' } }, '');

  function refreshTotal() {
    let b = 0;
    chosen.forEach((n) => { const r = live.get(n); if (r) b += Number(r['store.size']) || 0; });
    mount(totalEl, chosen.size
      ? `${num(chosen.size)} index/indices selected${b ? ` · ${bytes(b)} reclaimed` : ''}`
      : 'nothing selected');
  }

  const rows = present.map((n) => {
    const r = live.get(n) || {};
    return h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', padding: '2px 0', cursor: 'pointer' } },
      h('input', { type: 'checkbox', style: { cursor: 'pointer' },
        onchange: (e) => { if (e.target.checked) chosen.add(n); else chosen.delete(n); refreshTotal(); } }),
      h('span.mono', { style: { flex: '1', wordBreak: 'break-all' } }, n),
      r['store.size'] ? h('span.muted', { style: { fontSize: '11px' } }, bytes(Number(r['store.size']))) : null);
  });
  refreshTotal();

  const body = [
    h('div.banner.warn', { style: { margin: '0 0 4px' } },
      h('div', h('div.ttl', 'This deletes indices from the cluster, not from the snapshot'),
        h('div', `Everything listed is held in "${snapshotId}", so it can be restored from ${repo} later. ` +
                 'Deleting frees the disk the live index uses. This cannot be undone.'))),
    gone ? h('div.muted', { style: { fontSize: '11.5px' } },
      `${num(gone)} index/indices in the snapshot no longer exist in the cluster and are not listed.`) : null,
    h('div', { style: { display: 'flex', gap: '6px', marginBottom: '4px' } },
      h('button.btn.sm', { type: 'button', onclick: (e) => {
        e.target.closest('.modal-body').querySelectorAll('input[type=checkbox]').forEach((cb) => {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
        });
      } }, 'Select all'),
      h('button.btn.sm.ghost', { type: 'button', onclick: (e) => {
        e.target.closest('.modal-body').querySelectorAll('input[type=checkbox]').forEach((cb) => {
          if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
        });
      } }, 'Clear')),
    h('div', { style: { maxHeight: '230px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px', padding: '7px' } },
      rows.length ? rows : h('div.muted', { style: { fontSize: '12px' } }, 'No index from this snapshot is still in the cluster.')),
    totalEl,
  ];

  const res = await modal(`Delete indices held in ${snapshotId}`, `${cluster.name} · snapshot stays in ${repo}`, body,
    (ctx) => [
      h('button.btn.danger', { onclick: (e) => ctx.run(e.target, async () => {
        if (!chosen.size) throw new Error('Select at least one index.');
        const list = [...chosen];
        const go = await confirmDialog(`Delete ${list.length} index/indices from ${cluster.name}?`,
          h('div', h('div', `They remain in snapshot "${snapshotId}" and can be restored from ${repo}. ` +
                            'Removing them from the cluster cannot be undone.'), nameList(list)),
          { yes: 'delete', danger: true, typeToConfirm: list.length > 1 ? String(list.length) : null });
        if (!go) return;
        const failed = [];
        for (const n of list) {
          try { await cl.deleteIndex(n); } catch (err) { failed.push(`${n}: ${err.message}`); }
        }
        if (failed.length) throw new Error(`${failed.length} failed — ${failed[0]}`);
        ctx.done(list.length);
      }) }, 'Delete selected indices'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '640px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* ------------------------------- repositories ------------------------------ */

const REPO_TYPES = [
  ['fs', 'Shared file system (fs)'],
  ['s3', 'AWS S3 (s3)'],
  ['azure', 'Azure (azure)'],
  ['gcs', 'Google Cloud Storage (gcs)'],
  ['url', 'Read-only URL (url)'],
];

export async function createRepositoryDialog(cluster, pathRepo = []) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);
  const settingsHost = h('div', { style: { display: 'grid', gap: '10px' } });

  function drawSettings(type) {
    if (type === 'fs') {
      mount(settingsHost,
        field('Location', text('sd-loc', pathRepo[0] || '', { mono: true, placeholder: '/mnt/es-backups' }),
          pathRepo.length
            ? `Must sit inside path.repo on every node: ${pathRepo.join(', ')}`
            : 'Must sit inside a path.repo directory registered in elasticsearch.yml on every node.'),
        checkbox('sd-compress', 'Compress metadata', true));
    } else if (type === 'url') {
      mount(settingsHost, field('URL', text('sd-loc', '', { mono: true, placeholder: 'file:/mnt/es-backups' }),
        'Read-only. The URL must be listed in repositories.url.allowed_urls.'));
    } else if (type === 's3') {
      mount(settingsHost,
        field('Bucket', text('sd-loc', '', { mono: true, placeholder: 'my-es-backups' })),
        field('Base path', text('sd-base', '', { mono: true, placeholder: 'prod/cluster-a' }), 'Optional prefix inside the bucket.'),
        field('Client', text('sd-client', 'default', { mono: true }), 'The s3.client.<name> credentials in the keystore.'),
        checkbox('sd-compress', 'Compress metadata', true));
    } else if (type === 'azure') {
      mount(settingsHost,
        field('Container', text('sd-loc', '', { mono: true })),
        field('Base path', text('sd-base', '', { mono: true })),
        field('Client', text('sd-client', 'default', { mono: true })),
        checkbox('sd-compress', 'Compress metadata', true));
    } else {
      mount(settingsHost,
        field('Bucket', text('sd-loc', '', { mono: true })),
        field('Base path', text('sd-base', '', { mono: true })),
        field('Client', text('sd-client', 'default', { mono: true })),
        checkbox('sd-compress', 'Compress metadata', true));
    }
  }

  const typeSel = select('sd-type', 'fs', REPO_TYPES);
  typeSel.onchange = (e) => drawSettings(e.target.value);
  drawSettings('fs');

  const body = [
    field('Name', text('sd-rname', '', { mono: true, placeholder: 'daily-backups' })),
    field('Type', typeSel),
    settingsHost,
    h('div.muted', { style: { fontSize: '11.5px' } },
      'The plugin for the chosen type must already be installed, and the repository is verified on every node when it is registered.'),
  ];

  return modal(`Add a snapshot repository to ${cluster.name}`, null, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const name = val('sd-rname').trim();
        const type = val('sd-type');
        const loc = val('sd-loc').trim();
        if (!name) throw new Error('Give the repository a name.');
        if (!loc) throw new Error(type === 'fs' ? 'Give the location on disk.' : 'Give the bucket, container or URL.');
        const settings = {};
        if (type === 'fs') settings.location = loc;
        else if (type === 'url') settings.url = loc;
        else if (type === 'azure') settings.container = loc;
        else settings.bucket = loc;
        const base = val('sd-base');
        const cli = val('sd-client');
        if (base && base.trim()) settings.base_path = base.trim();
        if (cli && cli.trim() && type !== 'fs' && type !== 'url') settings.client = cli.trim();
        if ($('#sd-compress')) settings.compress = checked('sd-compress');
        await cl.createRepository(name, { type, settings });
        ctx.done({ name });
      }) }, 'Add repository'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '620px' });
}

export async function deleteRepository(cluster, name, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const ok = await confirmDialog(`Remove repository ${name}?`,
    `From ${cluster.name}.\n\n` +
    'Elasticsearch stops using it, and every snapshot in it disappears from this app. The files ' +
    'on disk or in the bucket are left alone, so the repository can be registered again later — ' +
    'but any SLM policy writing to it will start failing.',
    { yes: 'remove', danger: true, typeToConfirm: name });
  if (!ok) return false;
  try {
    await client(cluster.id).deleteRepository(name);
    if (onChanged) await onChanged();
    return true;
  } catch (e) {
    alert(`Could not remove the repository: ${e.message}`);
    return false;
  }
}

export async function verifyRepository(cluster, name) {
  if (!(await ensureWrites())) return;
  try {
    const r = await client(cluster.id).verifyRepository(name);
    const nodes = Object.keys(r.nodes || {}).length;
    alert(`Repository "${name}" verified on ${nodes || 0} node(s).`);
  } catch (e) {
    alert(`Verification failed: ${e.message}`);
  }
}

export async function cleanupRepository(cluster, name, { onChanged } = {}) {
  if (!(await ensureWrites())) return;
  const ok = await confirmDialog(`Clean up repository ${name}?`,
    'Removes data in the repository that no snapshot references any more. Existing snapshots are ' +
    'not affected. On a large repository this can run for a long time.',
    { yes: 'clean up' });
  if (!ok) return;
  try {
    const r = await client(cluster.id).cleanupRepository(name);
    const res = r.results || {};
    alert(`Cleanup finished — ${num(res.deleted_blobs || 0)} blob(s), ${bytes(res.deleted_bytes || 0)} freed.`);
    if (onChanged) await onChanged();
  } catch (e) {
    alert(`Cleanup failed: ${e.message}`);
  }
}
