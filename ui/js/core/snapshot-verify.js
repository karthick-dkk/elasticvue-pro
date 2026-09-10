/**
 * Before a live index is deleted: is it in a snapshot, and did that snapshot succeed?
 *
 * "It is in a snapshot" is not enough. A snapshot in state PARTIAL or FAILED may hold a
 * broken copy, and a snapshot that is still IN_PROGRESS has not finished writing it. Only
 * SUCCESS counts, and the newest successful snapshot is the one reported so the operator
 * knows how recent the copy is.
 *
 * One listing per repository, with the index list attached to each snapshot — not one
 * call per snapshot, which on a repository with hundreds would take minutes.
 */

import { client, state } from './state.js';

const SNAPSHOT_LIST_SIZE = 1000;

/**
 * @returns {Promise<Map<string, {covered:boolean, best:object|null, all:Array, unverified:string[]}>>}
 *   keyed by index name. `unverified` names repositories that could not be read, so a
 *   missing copy is never reported as fact when the answer is really "unknown".
 */
export async function verifyIndicesInSnapshots(cluster, names) {
  const cl = client(cluster.id);
  const d = state.data.get(cluster.id) || {};
  const repos = (d.repos || []).map((r) => r.name);
  const wanted = new Set(names);

  // index -> every snapshot holding it, across every repository
  const holders = new Map();
  for (const n of names) holders.set(n, []);
  const unverified = [];

  for (const repo of repos) {
    let list;
    try {
      const j = await cl.snapshots(repo, SNAPSHOT_LIST_SIZE);
      list = j.snapshots || [];
    } catch (e) {
      unverified.push(`${repo}: ${e.message || e}`);
      continue;
    }
    for (const s of list) {
      for (const idx of s.indices || []) {
        if (!wanted.has(idx)) continue;
        holders.get(idx).push({
          repo,
          snapshot: s.snapshot,
          state: String(s.state || '').toUpperCase(),
          start: s.start_time_in_millis || (s.start_time ? Date.parse(s.start_time) : 0),
          end: s.end_time_in_millis || (s.end_time ? Date.parse(s.end_time) : 0),
          failedShards: (s.shards && s.shards.failed) || 0,
          failures: (s.failures || []).filter((f) => f.index === idx).length,
        });
      }
    }
  }

  const out = new Map();
  for (const n of names) {
    const all = holders.get(n).sort((a, b) => b.start - a.start);
    // A copy counts only when the whole snapshot succeeded AND had no failure on this index.
    const good = all.filter((s) => s.state === 'SUCCESS' && s.failures === 0);
    out.set(n, {
      covered: good.length > 0,
      best: good[0] || null,
      all,
      unverified,
      repos: repos.length,
    });
  }
  return out;
}

/** One-line verdict per index, for a table or a confirmation. */
export function coverageLabel(v) {
  if (!v) return { text: 'not checked', cls: 'grey' };
  if (v.covered) return { text: `in ${v.best.snapshot}`, cls: 'green' };
  if (v.unverified.length && !v.all.length) return { text: 'could not verify', cls: 'yellow' };
  if (v.all.length) {
    const st = v.all[0].state;
    return { text: `only in a ${st} snapshot`, cls: st === 'IN_PROGRESS' ? 'yellow' : 'red' };
  }
  if (!v.repos) return { text: 'no repository', cls: 'red' };
  return { text: 'NOT in any snapshot', cls: 'red' };
}

/**
 * Find an index by name across what is live and what is held in snapshots — the search
 * that answers "does this still exist anywhere" without opening two pages.
 */
export async function findIndexEverywhere(cluster, term, { max = 200 } = {}) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return { live: [], snapshotted: [], unverified: [] };

  const live = (state.indices.get(cluster.id) || [])
    .filter((r) => r.index.toLowerCase().includes(needle))
    .map((r) => ({ index: r.index, size: r.size, docs: r.docs, day: r.day, status: r.status, health: r.health }));

  const cl = client(cluster.id);
  const repos = ((state.data.get(cluster.id) || {}).repos || []).map((r) => r.name);
  const found = new Map();   // index -> { snapshots: [...] }
  const unverified = [];
  for (const repo of repos) {
    let list;
    try { list = (await cl.snapshots(repo, SNAPSHOT_LIST_SIZE)).snapshots || []; }
    catch (e) { unverified.push(`${repo}: ${e.message || e}`); continue; }
    for (const s of list) {
      for (const idx of s.indices || []) {
        if (!idx.toLowerCase().includes(needle)) continue;
        if (!found.has(idx)) found.set(idx, { index: idx, snapshots: [] });
        found.get(idx).snapshots.push({
          repo, snapshot: s.snapshot, state: String(s.state || '').toUpperCase(),
          start: s.start_time_in_millis || (s.start_time ? Date.parse(s.start_time) : 0),
        });
        if (found.size >= max) break;
      }
    }
  }
  const liveSet = new Set(live.map((r) => r.index));
  const snapshotted = [...found.values()].map((f) => ({
    ...f,
    snapshots: f.snapshots.sort((a, b) => b.start - a.start),
    alsoLive: liveSet.has(f.index),
    successful: f.snapshots.filter((s) => s.state === 'SUCCESS').length,
  }));
  return { live, snapshotted, unverified };
}
