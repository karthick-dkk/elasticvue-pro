/** Application state, refresh loop and auto-reconnect. */

import { EsClient, primeWorker, setBadge } from './es.js';
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
  const { root, health, alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths } = raw;
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

  return out;
}

export async function fetchOverview(id, { withSnapshots = true } = {}) {
  const cl = state.clients.get(id);
  if (!cl) return null;
  const prev = state.data.get(id) || {};

  const [root, health, alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths] = await Promise.all([
    settled(cl.root()), settled(cl.health()), settled(cl.allocation()), settled(cl.nodes()),
    settled(cl.repositories()), settled(cl.slmPolicies()), settled(cl.slmStatus()),
    settled(cl.ilmStatus()), settled(cl.ilmErrors()),
    settled(cl.json('GET', '/_nodes/settings?filter_path=nodes.*.settings.path.repo,nodes.*.name')),
  ]);

  const out = buildClusterData(id, prev, { root, health, alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths });
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
      const rows = await cl.snapshotsCat(repo.name);
      d.snapshots[repo.name] = rows.map((r) => ({
        id: r.id,
        status: r.status,
        start: Number(r.start_epoch) * 1000,
        end: Number(r.end_epoch) * 1000,
        duration: r.duration,
        indices: Number(r.indices) || 0,
        successful: Number(r.successful_shards) || 0,
        failed: Number(r.failed_shards) || 0,
        total: Number(r.total_shards) || 0,
      })).sort((a, b) => b.start - a.start);
      repo.error = null;
    } catch (e) {
      try {
        const j = await cl.snapshots(repo.name, 500);
        d.snapshots[repo.name] = (j.snapshots || []).map((s) => ({
          id: s.snapshot, status: s.state,
          start: s.start_time_in_millis, end: s.end_time_in_millis,
          duration: s.duration_in_millis, indices: (s.indices || []).length,
          successful: (s.shards || {}).successful || 0, failed: (s.shards || {}).failed || 0,
          total: (s.shards || {}).total || 0,
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
    client: g.client || null,
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
    (d.slm || []).forEach((p) => {
      const lf = p.last_failure, ls = p.last_success;
      if (lf && (!ls || lf.time > ls.time)) add({ key: `${c.id}:slm-fail:${p.id}`, level: 'critical', cluster: c, title: `${c.name}/${p.id}: last SLM run failed`, detail: String(lf.details || '').slice(0, 160) });
      const staleMs = state.defaults.snapshotStaleHours * 3600 * 1000;
      if (ls && Date.now() - ls.time > staleMs) add({ key: `${c.id}:slm-stale:${p.id}`, level: 'warning', cluster: c, title: `${c.name}/${p.id}: no successful snapshot recently`, detail: `Last success ${new Date(ls.time).toISOString().replace('T', ' ').slice(0, 16)}` });
    });
  }
  return out;
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
