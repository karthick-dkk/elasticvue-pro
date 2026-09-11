/** Application state, refresh loop and auto-reconnect. */

import { EsClient, primeWorker, setBadge, requestStats } from './es.js';
// Cyclic with field-volume.js, which needs client() from here. Safe because both sides
// only touch the other inside functions, never while the modules are evaluating.
import { fieldVolumeSpikes, clearFieldVolume } from './field-volume.js';
import { diskBalance, balanceHeadline, primaryAction } from './disk-balance.js';
import { DEFAULTS, authHeaderFor } from './config.js';

class Emitter {
  constructor() { this.map = new Map(); }
  on(ev, fn) { (this.map.get(ev) || this.map.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { const s = this.map.get(ev); if (s) s.delete(fn); }
  emit(ev, payload) { (this.map.get(ev) || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } }); }
}

export const bus = new Emitter();

export const state = {
  mode: 'live',        // 'live' | 'snapshot'
  snapshot: null,      // metadata when mode === 'snapshot'
  config: null,
  handle: null,
  defaults: { ...DEFAULTS },
  clients: new Map(),
  data: new Map(),
  indices: new Map(),
  selected: 'all',
  autoRefresh: false,   // opt-in; see DEFAULTS.autoRefresh and the top-bar toggle
  lastRefresh: 0,
  refreshing: false,
  timer: null,
  tick: null,
  nextRefreshAt: 0,
};

export function clusters() { return state.config ? state.config.clusters.filter((c) => c.enabled) : []; }
export function client(id) { return state.clients.get(id); }
export function activeClusters() {
  const all = clusters();
  return state.selected === 'all' ? all : all.filter((c) => c.id === state.selected);
}

/**
 * A credential typed into the app rather than read from the YAML.
 * Memory only: it is never written to disk unless you tick "remember in the OS vault".
 * It is re-applied after a config reload so editing the YAML does not log you out.
 */
let sessionCred = null;

export function hasSessionCredential() { return !!sessionCred; }
export function sessionCredentialLabel() {
  if (!sessionCred) return '';
  if (sessionCred.apiKey) return 'API key';
  if (sessionCred.bearer) return 'bearer token';
  return sessionCred.username || 'credential';
}

/** Clusters the config file did not supply a usable secret for. */
export function clustersNeedingCredential() {
  return clusters().filter((c) => c.needsCred && !c.anonymous);
}

/** Clusters whose credential was rejected by Elasticsearch. */
export function clustersWithAuthError() {
  return clusters().filter((c) => { const cl = state.clients.get(c.id); return cl && cl.state === 'auth_error'; });
}

/** A username the YAML already named, to prefill the prompt. */
export function suggestedUsername() {
  const c = clusters().find((x) => x.suggestedUsername);
  return c ? c.suggestedUsername : '';
}

function stampCredential(c, cred) {
  c.authHeader = authHeaderFor(cred);
  c.credSource = 'session';
  c.needsCred = false;
  c.anonymous = false;
  c.username = cred.username || (cred.apiKey ? '(api key)' : cred.bearer ? '(bearer)' : '');
}

/** Stamp an unlocked (decrypted) credential onto one cluster — file-sourced, not session. */
export function applyUnlockedCredential(clusterId, cred) {
  const c = state.config && state.config.clusters.find((x) => x.id === clusterId);
  if (!c) return;
  stampCredential(c, cred);
  c.credSource = c.hasOwnCred ? 'cluster' : 'shared';
}

/** Re-apply the typed credential after a config reload. */
export function applySessionCredential({ overrideAll = false } = {}) {
  if (!sessionCred || !state.config) return 0;
  let n = 0;
  for (const c of state.config.clusters) {
    if (c.needsCred || c.credSource === 'session' || overrideAll) { stampCredential(c, sessionCred); n++; }
  }
  return n;
}

/**
 * Store a credential typed by the user and push it to every cluster that needs one
 * (or to all clusters when overrideAll is set), then reconnect.
 */
export async function setSessionCredential(cred, { overrideAll = false } = {}) {
  sessionCred = cred;
  const n = applySessionCredential({ overrideAll });
  for (const c of state.config.clusters) {
    const cl = state.clients.get(c.id);
    if (cl) { cl.failures = 0; cl.nextRetryAt = 0; cl.state = 'unknown'; }
  }
  await reprime();
  bus.emit('config', state.config);
  return n;
}

/** Mark the clusters without a credential as deliberately anonymous. */
export async function continueAnonymously() {
  if (!state.config) return;
  for (const c of state.config.clusters) if (c.needsCred) c.anonymous = true;
  await reprime();
  bus.emit('config', state.config);
}

export async function clearSessionCredential() {
  sessionCred = null;
  if (state.config) {
    for (const c of state.config.clusters) {
      if (c.credSource === 'session') { c.authHeader = null; c.credSource = 'none'; c.needsCred = true; c.username = ''; c.anonymous = false; }
    }
  }
  await reprime();
  bus.emit('config', state.config);
}

export async function setConfig(config, handle) {
  state.config = config;
  state.handle = handle !== undefined ? handle : state.handle;   // the remembered path, or null for load-once
  state.defaults = { ...DEFAULTS, ...config.defaults };
  applySessionCredential();
  state.clients.clear();
  for (const c of config.clusters) {
    state.clients.set(c.id, new EsClient(c, state.defaults, reprime));
  }
  // Drop what we cached for clusters the file no longer names — otherwise a reload
  // that removed or renamed a cluster keeps rendering it from stale data.
  const live = new Set(config.clusters.map((c) => c.id));
  for (const m of [state.data, state.indices]) {
    for (const id of [...m.keys()]) if (!live.has(id)) m.delete(id);
  }
  clearFieldVolume();   // field analysis is tied to the config that produced it
  await reprime();
  bus.emit('config', config);
}

export function isReadOnly() { return state.defaults.readOnly !== false; }

export async function reprime() {
  if (!state.config) return;
  await primeWorker(state.config.clusters, isReadOnly(), state.config.jumpHosts || []);
}

/* ------------------------------- data fetching ------------------------------- */

function repoLocation(settings = {}) {
  if (settings.location) return settings.location;
  if (settings.bucket) return `${settings.bucket}${settings.base_path ? '/' + settings.base_path : ''}`;
  if (settings.container) return `${settings.container}${settings.base_path ? '/' + settings.base_path : ''}`;
  if (settings.url) return settings.url;
  if (settings.path) return settings.path;
  return '';
}

async function settled(p) {
  try { return { ok: true, value: await p }; } catch (e) { return { ok: false, error: e }; }
}

/**
 * Turn raw Elasticsearch responses into the shape every page renders from.
 * `raw` values are {ok, value} pairs, so a live fetch and a snapshot file take the
 * identical path through here — the pages cannot tell the two apart, and neither can
 * drift away from the other.
 */
export function buildClusterData(id, prev, raw) {
  const { root, health, alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths,
          ilmPolicies, ilmOfIndices, clusterSettings } = raw;
  const out = { ...prev, id, loading: false, updatedAt: raw.updatedAt || Date.now() };

  out.reachable = root.ok || health.ok;
  out.error = out.reachable ? null : (root.error && root.error.res) || { message: String(root.error && root.error.message) };
  out.info = root.ok ? root.value : prev.info || null;
  out.health = health.ok ? health.value : null;

  // disk usage aggregated from _cat/allocation (bytes)
  if (alloc.ok) {
    const rows = alloc.value.filter((r) => r.node && r.node !== 'UNASSIGNED');
    const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    out.disk = {
      used: sum('disk.used'), avail: sum('disk.avail'), total: sum('disk.total'),
      indicesBytes: sum('disk.indices'), shards: sum('shards'),
      percent: sum('disk.total') ? (sum('disk.used') / sum('disk.total')) * 100 : NaN,
      nodes: rows,
      unassignedShards: Number((alloc.value.find((r) => r.node === 'UNASSIGNED') || {}).shards || 0),
    };
  }
  out.nodes = nodes.ok ? nodes.value : [];
  out.ilm = ilm.ok ? ilm.value : null;
  out.ilmErrorCount = ilmErr.ok && ilmErr.value && ilmErr.value.indices ? Object.keys(ilmErr.value.indices).length : 0;
  out.ilmErrors = ilmErr.ok && ilmErr.value ? ilmErr.value.indices || {} : {};
  out.slmStatus = slmStatus.ok ? slmStatus.value : null;
  out.slm = slm.ok ? Object.entries(slm.value || {}).map(([pid, p]) => ({ id: pid, ...p })) : [];
  out.slmSupported = slm.ok;

  if (repoPaths.ok && repoPaths.value && repoPaths.value.nodes) {
    const set = new Set();
    Object.values(repoPaths.value.nodes).forEach((n) => {
      const r = n.settings && n.settings.path && n.settings.path.repo;
      (Array.isArray(r) ? r : r ? [r] : []).forEach((p) => set.add(p));
    });
    out.pathRepo = [...set];
  }

  if (repos.ok) {
    out.repos = Object.entries(repos.value || {}).map(([name, r]) => ({
      name, type: r.type, settings: r.settings || {}, location: repoLocation(r.settings || {}),
    }));
  } else out.repos = prev.repos || [];

  out.clusterSettings = clusterSettings && clusterSettings.ok ? clusterSettings.value : prev.clusterSettings || null;
  out.appliedIlm = appliedIlm(ilmPolicies, ilmOfIndices) || prev.appliedIlm || null;
  out.appliedSlm = appliedSlm(out.slm) || prev.appliedSlm || null;

  return out;
}

/**
 * The ILM policy the log indices are actually attached to, and the age at which it
 * deletes them — the cluster's real live retention, whatever the config claims.
 *
 * Which policy is in force is answered by the indices themselves rather than guessed:
 * a cluster can define a dozen policies and apply none of them.
 */
function appliedIlm(policiesRes, ofIndicesRes) {
  if (!policiesRes || !policiesRes.ok) return null;
  const policies = policiesRes.value || {};

  // Count how many indices name each policy; the commonest one governs the logs.
  const counts = new Map();
  if (ofIndicesRes && ofIndicesRes.ok) {
    for (const entry of Object.values(ofIndicesRes.value || {})) {
      const name = entry && entry.settings && entry.settings.index
        && entry.settings.index.lifecycle && entry.settings.index.lifecycle.name;
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  let name = null, indices = 0;
  for (const [n, c] of counts) if (c > indices) { name = n; indices = c; }
  // No index says so, but the cluster defines exactly one policy — that is the answer.
  if (!name) {
    const only = Object.keys(policies);
    if (only.length === 1) name = only[0];
  }
  if (!name || !policies[name]) return name ? { name, indices, deleteAfter: null, phases: [] } : null;

  const phases = (policies[name].policy && policies[name].policy.phases) || {};
  const order = ['hot', 'warm', 'cold', 'frozen', 'delete'];
  return {
    name,
    indices,
    deleteAfter: (phases.delete && phases.delete.min_age) || null,
    phases: order.filter((p) => phases[p]).map((p) => ({ phase: p, minAge: phases[p].min_age || '0ms' })),
    modifiedDate: policies[name].modified_date_string || null,
  };
}

/** The SLM policy actually configured, and the age at which it expires snapshots. */
function appliedSlm(slmList) {
  const list = slmList || [];
  if (!list.length) return null;
  // Prefer one that has actually run; a policy that never fired says little.
  const chosen = list.find((p) => p.last_success) || list[0];
  const pol = chosen.policy || {};
  const ret = pol.retention || {};
  return {
    name: chosen.id,
    repository: pol.repository || null,
    schedule: pol.schedule || null,
    expireAfter: ret.expire_after || null,
    minCount: ret.min_count ?? null,
    maxCount: ret.max_count ?? null,
    policies: list.length,
  };
}

export async function fetchOverview(id, { withSnapshots = true } = {}) {
  const cl = state.clients.get(id);
  if (!cl) return null;
  const prev = state.data.get(id) || {};

  const [root, health, alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths, ilmPolicies,
         ilmOfIndices, clusterSettings] =
    await Promise.all([
      settled(cl.root()), settled(cl.health()), settled(cl.allocation()), settled(cl.nodes()),
      settled(cl.repositories()), settled(cl.slmPolicies()), settled(cl.slmStatus()),
      settled(cl.ilmStatus()), settled(cl.ilmErrors()),
      settled(cl.json('GET', '/_nodes/settings?filter_path=nodes.*.settings.path.repo,nodes.*.name')),
      // What the cluster actually enforces, as opposed to what the config says it should.
      settled(cl.ilmPolicies()),
      settled(cl.ilmPolicyOfIndices(cl.c.logIndexPattern || '*')),
      // The real watermarks, so disk advice is not given against assumed thresholds.
      settled(cl.json('GET', '/_cluster/settings?include_defaults=true&flat_settings=true' +
        '&filter_path=**.disk.watermark**,**.allocation.enable,**.rebalance.enable')),
    ]);

  const out = buildClusterData(id, prev, {
    root, health, alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths, ilmPolicies,
    ilmOfIndices, clusterSettings,
  });
  state.data.set(id, out);
  bus.emit('data', id);

  if (withSnapshots && out.repos.length) await fetchSnapshots(id);
  return out;
}

/** Snapshot inventory per repo, via _cat/snapshots (compact) with a JSON fallback. */
export async function fetchSnapshots(id) {
  const cl = state.clients.get(id);
  const d = state.data.get(id);
  if (!cl || !d) return;
  d.snapshots = d.snapshots || {};
  for (const repo of d.repos) {
    try {
      // The verbose listing is one call per repository and carries the index names,
      // which is what makes "which days of logs are actually in here" answerable.
      // _cat/snapshots is cheaper but returns only a count, so it is the fallback.
      const j = await cl.snapshots(repo.name, 500);
      d.snapshots[repo.name] = (j.snapshots || []).map((s) => {
        const names = s.indices || [];
        return {
          id: s.snapshot, status: s.state,
          start: s.start_time_in_millis, end: s.end_time_in_millis,
          duration: s.duration_in_millis,
          indices: names.length,
          indexNames: names,
          ...coveredDays(names, cl.c.indexNameRegex),
          successful: (s.shards || {}).successful || 0, failed: (s.shards || {}).failed || 0,
          total: (s.shards || {}).total || 0,
        };
      }).sort((a, b) => b.start - a.start);
      repo.error = null;
    } catch (e) {
      try {
        const rows = await cl.snapshotsCat(repo.name);
        d.snapshots[repo.name] = rows.map((r) => ({
          id: r.id,
          status: r.status,
          start: Number(r.start_epoch) * 1000,
          end: Number(r.end_epoch) * 1000,
          duration: r.duration,
          indices: Number(r.indices) || 0,
          // _cat does not name the indices, so the covered range is unknown rather
          // than empty — the page says so instead of showing a misleading blank.
          indexNames: null,
          coverFrom: null, coverTo: null, coverDays: 0,
          successful: Number(r.successful_shards) || 0,
          failed: Number(r.failed_shards) || 0,
          total: Number(r.total_shards) || 0,
        })).sort((a, b) => b.start - a.start);
        repo.error = null;
      } catch (e2) {
        d.snapshots[repo.name] = [];
        repo.error = e2.message;
      }
    }
  }
  state.data.set(id, d);
  bus.emit('data', id);
}

/**
 * Which days of data a snapshot actually holds, read from the dates in its index names.
 *
 * This is not the same question as when the snapshot ran: a snapshot taken this morning
 * can contain ninety days of daily indices, and it is the span of those that says how
 * far back the backup reaches.
 */
function coveredDays(names, reSrc) {
  let from = null, to = null, dated = 0;
  for (const n of names || []) {
    const day = parseIndexName(n, reSrc).day;
    if (!day) continue;
    dated++;
    if (from === null || day < from) from = day;
    if (to === null || day > to) to = day;
  }
  const span = from && to
    ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1
    : 0;
  return { coverFrom: from, coverTo: to, coverDays: span, datedIndices: dated };
}

export async function fetchIndices(id, pattern = '*') {
  const cl = state.clients.get(id);
  if (!cl) return [];
  const rows = await cl.indices(pattern);
  const parsed = rows.map((r) => parseIndexName(r.index, cl.c.indexNameRegex, r));
  state.indices.set(id, parsed);
  bus.emit('indices', id);
  return parsed;
}

let cachedRe = { src: null, re: null };
export function parseIndexName(name, reSrc, row = {}) {
  if (cachedRe.src !== reSrc) {
    try { cachedRe = { src: reSrc, re: new RegExp(reSrc) }; }
    catch { cachedRe = { src: reSrc, re: null }; }
  }
  const m = cachedRe.re ? cachedRe.re.exec(name) : null;
  const g = (m && m.groups) || {};
  return {
    index: name,
    // The named group is `source`; `client` is still accepted because configs written
    // before the rename use it, and "client" means a whole cluster in this app.
    source: g.source || g.client || null,
    day: g.date ? g.date.replace(/[.\-]/g, '-') : null,
    health: row.health, status: row.status,
    pri: Number(row.pri) || 0, rep: Number(row.rep) || 0,
    docs: Number(row['docs.count']) || 0,
    deleted: Number(row['docs.deleted']) || 0,
    size: Number(row['store.size']) || 0,
    priSize: Number(row['pri.store.size']) || 0,
    created: Number(row['creation.date']) || 0,
    uuid: row.uuid,
  };
}

/* --------------------------------- refreshing -------------------------------- */

export async function refreshAll({ force = false } = {}) {
  if (state.refreshing || !state.config) return;
  state.refreshing = true;
  bus.emit('refreshing', true);
  const targets = clusters().filter((c) => {
    const cl = state.clients.get(c.id);
    return force || !cl || cl.state === 'online' || cl.state === 'unknown' || cl.canTryNow;
  });
  await Promise.all(targets.map((c) => fetchOverview(c.id).catch(() => {})));
  await refreshRequestLoad();
  state.lastRefresh = Date.now();
  state.nextRefreshAt = state.lastRefresh + state.defaults.refreshIntervalSec * 1000;
  state.refreshing = false;
  bus.emit('refreshing', false);
  bus.emit('refreshed');
  updateBadge();
  publishPopupSummary();
}

export function startAutoRefresh() {
  stopAutoRefresh();
  state.nextRefreshAt = Date.now() + state.defaults.refreshIntervalSec * 1000;
  state.timer = setInterval(() => {
    if (!state.autoRefresh) { state.nextRefreshAt = Date.now() + state.defaults.refreshIntervalSec * 1000; return; }
    if (document.hidden) return;
    if (Date.now() >= state.nextRefreshAt) refreshAll();
  }, 1000);
  state.tick = setInterval(() => bus.emit('tick'), 1000);
}
export function stopAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  if (state.tick) clearInterval(state.tick);
  state.timer = state.tick = null;
}

/* ---------------------------------- alerts ----------------------------------- */

/**
 * Everything currently wrong across the fleet.
 *
 * Each alert carries a `key` that identifies the PROBLEM rather than its current value —
 * `<cluster>:disk`, not "disk 87.3%". An acknowledgement is stored against that key, so
 * it survives the number moving and only disappears when the problem itself clears.
 */
export function alerts() {
  const out = [];
  const add = (a) => out.push(a);
  for (const c of clusters()) {
    const d = state.data.get(c.id);
    const cl = state.clients.get(c.id);
    if (!d || !d.reachable) {
      add({ key: `${c.id}:unreachable`, level: 'critical', cluster: c, title: `${c.name} unreachable`,
        detail: (cl && cl.lastError && cl.lastError.message) || 'No response', kind: cl && cl.state });
      continue;
    }
    if (d.health && d.health.status === 'red') add({ key: `${c.id}:health`, level: 'critical', cluster: c, title: `${c.name} health is RED`, detail: `${d.health.unassigned_shards} unassigned shards` });
    else if (d.health && d.health.status === 'yellow') add({ key: `${c.id}:health`, level: 'warning', cluster: c, title: `${c.name} health is YELLOW`, detail: `${d.health.unassigned_shards} unassigned shards` });
    if (d.disk && isFinite(d.disk.percent)) {
      if (d.disk.percent >= state.defaults.diskCritPercent) add({ key: `${c.id}:disk`, level: 'critical', cluster: c, title: `${c.name} disk ${d.disk.percent.toFixed(1)}%`, detail: 'Above critical threshold' });
      else if (d.disk.percent >= state.defaults.diskWarnPercent) add({ key: `${c.id}:disk`, level: 'warning', cluster: c, title: `${c.name} disk ${d.disk.percent.toFixed(1)}%`, detail: 'Above warning threshold' });
    }
    if (d.ilmErrorCount) add({ key: `${c.id}:ilm`, level: 'warning', cluster: c, title: `${c.name}: ${d.ilmErrorCount} index(es) in ILM error step`, detail: Object.keys(d.ilmErrors).slice(0, 3).join(', ') });
    if (d.slmStatus && d.slmStatus.operation_mode && d.slmStatus.operation_mode !== 'RUNNING') add({ key: `${c.id}:slm-mode`, level: 'warning', cluster: c, title: `${c.name}: SLM is ${d.slmStatus.operation_mode}`, detail: 'Snapshot lifecycle is not running' });
    // Disk balance across data nodes — only meaningful with more than one.
    const bal = diskBalance(d, d.clusterSettings);
    if (bal.applicable && (bal.verdict === 'critical' || bal.verdict === 'required' || bal.verdict === 'watch')) {
      const act = primaryAction(bal);
      add({ key: `${c.id}:disk-balance`,
        level: bal.verdict === 'critical' ? 'critical' : 'warning',
        cluster: c,
        title: `${c.name}: ${balanceHeadline(bal)}`,
        // One suggestion, named — an alert that only states a problem leaves the reader
        // to work out the next step for themselves.
        detail: bal.reasons[0] + (act ? `  Suggested: ${act.title} (${act.method} ${act.path}).` : '') });
    }

    // Field-volume spikes, when the Indices page has run an analysis for this cluster.
    for (const sp of spikesFor(c.id)) {
      add({ key: `${c.id}:volume:${sp.field}:${sp.term}`, level: 'warning', cluster: c,
        title: `${c.name}: ${sp.field} "${sp.term}" volume up ${Math.round(sp.changePct)}%`,
        detail: `${sp.latest.docs.toLocaleString()} documents on ${sp.latestDay} against a ` +
                `${Math.round(sp.baseline).toLocaleString()} average over the previous ${sp.baselineDays} days` });
    }
    (d.slm || []).forEach((p) => {
      const lf = p.last_failure, ls = p.last_success;
      if (lf && (!ls || lf.time > ls.time)) add({ key: `${c.id}:slm-fail:${p.id}`, level: 'critical', cluster: c, title: `${c.name}/${p.id}: last SLM run failed`, detail: String(lf.details || '').slice(0, 160) });
      const staleMs = state.defaults.snapshotStaleHours * 3600 * 1000;
      if (ls && Date.now() - ls.time > staleMs) add({ key: `${c.id}:slm-stale:${p.id}`, level: 'warning', cluster: c, title: `${c.name}/${p.id}: no successful snapshot recently`, detail: `Last success ${new Date(ls.time).toISOString().replace('T', ' ').slice(0, 16)}` });
    });
  }
  return out;
}

/** Spikes the Indices page found for this cluster, if it has been asked to look. */
function spikesFor(clusterId) {
  try { return fieldVolumeSpikes().filter((s) => s.clusterId === clusterId); }
  catch (_) { return []; }
}

/**
 * Our own load on each cluster: requests sent in the last five minutes, per cluster.
 * Refreshed alongside the data so the number on screen is never older than the data
 * beside it. The core keeps the log; this is only the latest reading.
 */
export const requestLoad = { at: 0, windowSec: 300, clusters: {} };

export async function refreshRequestLoad() {
  try {
    const r = await requestStats();
    if (r && r.ok && r.requests) {
      requestLoad.at = Date.now();
      requestLoad.windowSec = r.requests.windowSec || 300;
      requestLoad.clusters = r.requests.clusters || {};
    }
  } catch (_) { /* the previous reading stands */ }
  return requestLoad;
}

export function requestsFor(clusterId) {
  return requestLoad.clusters[clusterId] || { last5m: 0, perMinute: 0, perSecond: 0 };
}

export function worstHealth() {
  let worst = 'grey';
  const rank = { grey: 0, green: 1, yellow: 2, red: 3 };
  for (const c of clusters()) {
    const d = state.data.get(c.id);
    const s = !d || !d.reachable ? 'red' : (d.health && d.health.status) || 'grey';
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

function updateBadge() {
  const a = alerts();
  const crit = a.filter((x) => x.level === 'critical').length;
  const warn = a.length - crit;
  const w = worstHealth();
  const color = crit ? '#d03b3b' : warn ? '#fab219' : w === 'green' ? '#0ca30c' : '#64748b';
  setBadge(a.length ? String(a.length) : '', color,
    a.length ? `ElasticVue Pro — ${crit} critical, ${warn} warning` : 'ElasticVue Pro — all clusters healthy');
}

/** Small, credential-free summary so the toolbar popup can render instantly. */
function publishPopupSummary() {
  try {
    const rows = clusters().map((c) => {
      const d = state.data.get(c.id) || {};
      return {
        id: c.id, name: c.name, host: c.origin,
        status: !d.reachable ? 'offline' : (d.health && d.health.status) || 'grey',
        nodes: (d.health && d.health.number_of_nodes) || 0,
        diskPct: d.disk && isFinite(d.disk.percent) ? Math.round(d.disk.percent) : null,
        version: (d.info && d.info.version && d.info.version.number) || '',
      };
    });
    if (globalThis.chrome && chrome.storage && chrome.storage.session) chrome.storage.session.set({ summary: { at: Date.now(), rows, alerts: alerts().length } });
  } catch (_) { /* storage.session unavailable */ }
}
