/** Application state, refresh loop and auto-reconnect. */

import { EsClient, primeWorker, setBadge, requestStats } from './es.js';
// lib/fmt is a leaf: no cycle, and two alert sentences need to read like the rest of the UI.
import { bytes as bytesish, ago } from '../lib/fmt.js';
// Cyclic with field-volume.js, which needs client() from here. Safe because both sides
// only touch the other inside functions, never while the modules are evaluating.
import { fieldVolumeSpikes, clearFieldVolume } from './field-volume.js';
import { diskBalance, balanceHeadline, primaryAction } from './disk-balance.js';
import { DEFAULTS, authHeaderFor } from './config.js';
import { automationAlerts } from './automation.js';
import { loadAlertSettings, applySettings, effectiveDefaults } from './alert-rules.js';

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
  // Shipped defaults, then the file's, then whatever an admin retuned on the Config page.
  // Applied here so every reader of state.defaults — alerts, pages, charts — sees one
  // answer, rather than each of them remembering to consult the settings.
  state.defaults = effectiveDefaults({ ...DEFAULTS, ...config.defaults },
    loadAlertSettings(config.raw));
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

  // Total disk CAPACITY, and whether it changed since the last look.
  //
  // Not usage — the size of the disk itself. It should be a constant, so a change means
  // somebody added storage or a data path went away, and the second one is a fault that
  // looks like nothing else on this page.
  //
  // Guarded against the way it would otherwise cry wolf: disk.total is summed over the
  // nodes present in _cat/allocation RIGHT NOW, so a node restarting drops out of the
  // table and capacity appears to fall. A change is only believed when the node count is
  // the same at both readings; when nodes came or went, the new figure is adopted
  // silently as the baseline. A rolling restart should not page anybody.
  out.capacity = alloc.ok && out.disk
    ? capacityChange(prev.capacity, out.disk.total, (out.disk.nodes || []).length)
    : prev.capacity || null;

  // Who is master, and whether that changed since the last look.
  //
  // A master election is not a fault on its own, but it is never nothing: it means the
  // old master left, was partitioned off, or was restarted, and whatever else went wrong
  // in that window usually starts there. The previous holder is remembered so the alert
  // can say what it changed from — "master is node-3" is not news, "master moved from
  // node-1 to node-3" is.
  if (nodes.ok) {
    const now = (out.nodes.find((n) => String(n.master || '').trim() === '*') || {}).name || null;
    out.master = now;
    if (prev.master && now && prev.master !== now) {
      out.masterChangedFrom = prev.master;
      out.masterChangedAt = Date.now();
    } else {
      // Carried forward so the alert survives the refreshes after the election itself.
      out.masterChangedFrom = prev.masterChangedFrom || null;
      out.masterChangedAt = prev.masterChangedAt || null;
    }
  } else {
    out.master = prev.master || null;
    out.masterChangedFrom = prev.masterChangedFrom || null;
    out.masterChangedAt = prev.masterChangedAt || null;
  }
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

  // Reach for the cluster before interrogating it.
  //
  // These two decide reachability (see buildClusterData), so both are tried. The other
  // eleven are only worth sending to something that answered: against a cluster that is
  // down they are eleven more connection timeouts establishing a fact the first two
  // already established, and they are why an offline cluster reported twenty-six
  // requests in five minutes — thirteen per refresh, every refresh, none of them
  // arriving anywhere.
  const [root, health] = await Promise.all([settled(cl.root()), settled(cl.health())]);
  const answered = root.ok || health.ok;

  // The same shape settled() produces, so buildClusterData cannot tell a skipped call
  // from a failed one and needs no special case for this.
  const skipped = () => ({ ok: false, error: (root.error || health.error), skipped: true });

  const [alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths, ilmPolicies,
         ilmOfIndices, clusterSettings] = answered
    ? await Promise.all([
        settled(cl.allocation()), settled(cl.nodes()),
        settled(cl.repositories()), settled(cl.slmPolicies()), settled(cl.slmStatus()),
        settled(cl.ilmStatus()), settled(cl.ilmErrors()),
        settled(cl.json('GET', '/_nodes/settings?filter_path=nodes.*.settings.path.repo,nodes.*.name')),
        // What the cluster actually enforces, as opposed to what the config says it should.
        settled(cl.ilmPolicies()),
        settled(cl.ilmPolicyOfIndices(cl.c.logIndexPattern || '*')),
        // The real watermarks, so disk advice is not given against assumed thresholds.
        settled(cl.json('GET', '/_cluster/settings?include_defaults=true&flat_settings=true' +
          '&filter_path=**.disk.watermark**,**.allocation.enable,**.rebalance.enable')),
      ])
    : Array.from({ length: 11 }, skipped);

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

/**
 * Re-read the fleet, or just the part of it being looked at.
 *
 * `selected: true` follows the cluster picker — one cluster when one is chosen, the whole
 * fleet on "All clusters". That is what the Refresh button means: refresh what is on
 * screen, not eleven clusters because one of them is.
 *
 * Everything else still sweeps the fleet, deliberately. Auto-refresh feeds the alert list
 * and the tab badge, which cover every cluster whichever one is selected, and a fleet
 * that only updated the cluster in front of you would go quietly stale everywhere else —
 * the failure being watched for is usually on the cluster nobody is looking at.
 */
export async function refreshAll({ force = false, selected = false } = {}) {
  if (state.refreshing || !state.config) return;
  state.refreshing = true;
  bus.emit('refreshing', true);
  const targets = (selected ? activeClusters() : clusters()).filter((c) => {
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
/**
 * What ULM found the last time somebody pulled, per cluster.
 *
 * Published by the page rather than computed here, because the archive is only ever
 * listed by hand: alerts() runs on every refresh, and a rule that listed a bucket would
 * turn a monitoring dashboard into a recurring S3 bill. What alerts() does is surface
 * what the last manual pull already established.
 */
const archiveFindings = new Map();

export function setArchiveFindings(clusterId, findings) {
  if (findings && findings.length) archiveFindings.set(clusterId, findings);
  else archiveFindings.delete(clusterId);
  bus.emit('data');
}

export function archiveFindingsFor(clusterId) { return archiveFindings.get(clusterId) || []; }

export function alerts() {
  const out = [];
  const add = (...a) => out.push(...a.filter(Boolean));
  for (const c of clusters()) {
    const d = state.data.get(c.id);
    const cl = state.clients.get(c.id);
    if (!d || !d.reachable) {
      add({ key: `${c.id}:unreachable`, level: 'critical', cluster: c, title: `${c.name} unreachable`,
        detail: (cl && cl.lastError && cl.lastError.message) || 'No response', kind: cl && cl.state });
      continue;
    }
    // The archive gap. One alert per day found, because "three days are missing" and
    // "which three" are different facts and the second is the one somebody acts on.
    for (const f of archiveFindings.get(c.id) || []) {
      add({ key: `${c.id}:archive-missing:${f.tag}:${f.day}`, level: 'critical', cluster: c,
            title: `${c.name}: ${f.day} is not archived for ${f.tag}`, detail: f.reason });
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
    // Who holds the master role, and whether it just changed hands.
    if (d.master === null && d.nodes && d.nodes.length) {
      add({ key: `${c.id}:no-master`, level: 'critical', cluster: c,
        title: `${c.name}: no master node`,
        detail: `${d.nodes.length} node(s) answered but none holds the master role. The cluster `
              + 'cannot accept changes to its state until one is elected.' });
    } else if (d.masterChangedAt && Date.now() - d.masterChangedAt < MASTER_ALERT_HOURS * 3600 * 1000) {
      add({ key: `${c.id}:master-changed:${d.masterChangedFrom}->${d.master}`, level: 'critical', cluster: c,
        title: `${c.name}: master moved from ${d.masterChangedFrom} to ${d.master}`,
        detail: `Elected ${ago(d.masterChangedAt)}. The previous master left, was cut off or was `
              + 'restarted; anything else that went wrong around then probably started there.' });
    }

    // The disk itself getting bigger or smaller.
    if (d.capacity && d.capacity.changedAt
        && Date.now() - d.capacity.changedAt < CAPACITY_ALERT_HOURS * 3600 * 1000) {
      const from = d.capacity.changedFrom, to = d.capacity.total;
      const grew = to > from;
      add({
        key: `${c.id}:capacity:${from}->${to}`,
        level: grew ? 'warning' : 'critical',
        cluster: c,
        title: grew
          ? `${c.name}: disk capacity grew to ${bytesish(to)}`
          : `${c.name}: disk capacity FELL to ${bytesish(to)}`,
        detail: grew
          ? `Was ${bytesish(from)}, now ${bytesish(to)} — ${bytesish(to - from)} added ${ago(d.capacity.changedAt)}. `
            + 'Expected if you just extended the storage; worth confirming nobody else did it.'
          : `Was ${bytesish(from)}, now ${bytesish(to)} — ${bytesish(from - to)} gone ${ago(d.capacity.changedAt)}. `
            + 'A data path is missing or a mount was lost. The node count is unchanged, so this is not a node leaving.',
      });
    }

    // Disk Elasticsearch holds that no index accounts for.
    {
      const acct = diskAccounting(d, state.indices.get(c.id));
      if (acct.material) {
        const dang = danglingFor(c.id);
        const named = dang && dang.indices && dang.indices.length
          ? ` ${dang.indices.length} dangling index(es): ${dang.indices.slice(0, 3).map((x) => x.index_name).join(', ')}.`
          : dang ? ' No dangling indices, so it is orphaned shard data rather than a lost index.'
                 : ' Open Nodes & shards to check for dangling indices.';
        add({ key: `${c.id}:disk-unaccounted`, level: 'warning', cluster: c,
          title: `${c.name}: ${bytesish(acct.gap)} of disk is not accounted for by any index`,
          detail: `Elasticsearch holds ${bytesish(acct.held)} on its data path but the index list `
                + `totals ${bytesish(acct.accounted)}.${named}` });
      }
    }

    // Snapshots, per repository, over the last five runs and no further back.
    //
    // A repository that has been running for a year holds hundreds of snapshots, and
    // whether the one from March failed says nothing about whether backups work today.
    // Five is enough to tell a bad night from a broken schedule, and short enough that
    // the answer is about now.
    //
    // Per repository rather than per cluster: two repositories are two different places
    // the data is being written to, and one of them failing while the other succeeds is
    // exactly the case a merged view hides.
    for (const repo of d.repos || []) {
      add(...snapshotAlertsFor(c, repo, ((d.snapshots || {})[repo.name]) || []));
    }

    (d.slm || []).forEach((p) => {
      const lf = p.last_failure, ls = p.last_success;
      if (lf && (!ls || lf.time > ls.time)) add({ key: `${c.id}:slm-fail:${p.id}`, level: 'critical', cluster: c, title: `${c.name}/${p.id}: last SLM run failed`, detail: String(lf.details || '').slice(0, 160) });
      const staleMs = state.defaults.snapshotStaleHours * 3600 * 1000;
      if (ls && Date.now() - ls.time > staleMs) add({ key: `${c.id}:slm-stale:${p.id}`, level: 'warning', cluster: c, title: `${c.name}/${p.id}: no successful snapshot recently`, detail: `Last success ${new Date(ls.time).toISOString().replace('T', ' ').slice(0, 16)}` });
    });
  }
  // Automations the operator wrote, from the last automation run. Computed there because
  // evaluating a rule can need a snapshot listing and this function is synchronous.
  for (const a of automationAlerts((id) => clusters().find((c) => c.id === id))) add(a);

  // Rules an admin switched off are removed here rather than never raised, so the code
  // above stays one description of what is true and the registry decides what is shown.
  return applySettings(out, loadAlertSettings(state.config && state.config.raw));
}

/**
 * Whether the size of the disk changed, and whether that change is believable.
 *
 * Separated out because the guard is the whole point and it is the part that has to be
 * right. `disk.total` is summed over the nodes present in _cat/allocation at this
 * instant, so a node restarting drops out of the table and capacity appears to collapse.
 * A change is therefore only believed when the node count is identical at both readings;
 * when nodes came or went, the new figure becomes the baseline silently. A rolling
 * restart must not page anybody.
 */
export function capacityChange(prev, total, nodeCount) {
  const prevTotal = prev && prev.total;
  const sameFleet = prev && prev.nodeCount === nodeCount;
  const changed = !!(sameFleet && prevTotal && total && prevTotal !== total);
  return {
    total,
    nodeCount,
    changedFrom: changed ? prevTotal : (prev && prev.changedFrom) || null,
    changedAt: changed ? Date.now() : (prev && prev.changedAt) || null,
  };
}

/** How long a master election stays worth an alert. */
export const MASTER_ALERT_HOURS = 24;

/** And how long a change in the size of the disk does. */
export const CAPACITY_ALERT_HOURS = 48;

/**
 * Disk that Elasticsearch holds but no open or closed index accounts for.
 *
 * `_cat/allocation` reports what the data path occupies; `_cat/indices` reports what the
 * indices in the cluster state occupy. They should agree closely. When allocation is
 * materially larger, the difference is data on disk that the cluster state does not
 * account for — a dangling index left by a removed node, or shard directories orphaned by
 * a failed relocation. That is disk nobody is going to reclaim by deleting an index,
 * because there is no index to delete.
 *
 * Reported as unknown rather than zero when either figure is missing: a missing index
 * list would otherwise make the whole of allocation look unaccounted for.
 */
export const DISK_GAP_MIN_BYTES = 1024 ** 3;     // a gigabyte
export const DISK_GAP_MIN_RATIO = 0.05;          // and at least 5% of what ES holds

export function diskAccounting(d, indices) {
  const held = d && d.disk ? Number(d.disk.indicesBytes) || 0 : 0;
  if (!held || !Array.isArray(indices) || !indices.length) {
    return { known: false, held, accounted: 0, gap: 0, material: false };
  }
  const accounted = indices.reduce((sum, i) => sum + (Number(i.size) || 0), 0);
  const gap = held - accounted;
  const material = gap > DISK_GAP_MIN_BYTES && gap > held * DISK_GAP_MIN_RATIO;
  return { known: true, held, accounted, gap, material };
}

/** Dangling indices, per cluster — read by the Nodes & shards page, on demand. */
const dangling = new Map();
export function setDangling(clusterId, v) { dangling.set(clusterId, v); }
export function danglingFor(clusterId) { return dangling.get(clusterId) || null; }

/** Snapshot alerts look this far back, and no further. */
export const SNAPSHOT_WINDOW = 5;

const SNAP_BAD = new Set(['FAILED', 'PARTIAL']);
const snapDay = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : 'unknown');

/**
 * What the last five snapshots in one repository say about it.
 *
 * Returns the alerts for that repository — never more than one, because "it is failing"
 * and "it is stale" are the same problem seen twice and two rows for one repository is
 * how an alert list stops being read.
 *
 * When something is failing, the useful figure is not that it failed but since when. That
 * is the oldest run in the unbroken failing streak counting back from the newest: a repo
 * that failed last night and has failed every night since reads as one problem starting
 * then, not five. If the streak fills the whole window the start is older than we looked,
 * and the alert says so rather than naming the fifth-oldest run as the beginning.
 */
function snapshotAlertsFor(c, repo, all) {
  const key = `${c.id}:repo:${repo.name}`;
  if (repo.error) {
    return [{ key: `${key}:unreadable`, level: 'warning', cluster: c, repo: repo.name,
      title: `${c.name}/${repo.name}: repository could not be read`,
      detail: `${repo.error}. Snapshot coverage for this repository is unknown, not empty.` }];
  }

  const recent = all.slice(0, SNAPSHOT_WINDOW);   // fetchSnapshots sorts newest first
  if (!recent.length) {
    return [{ key: `${key}:none`, level: 'warning', cluster: c, repo: repo.name,
      title: `${c.name}/${repo.name}: no snapshots`,
      detail: 'The repository is registered but holds none.' }];
  }

  const latest = recent[0];
  const staleMs = state.defaults.snapshotStaleHours * 3600 * 1000;
  const isNew = Date.now() - latest.start <= staleMs;
  // Carried structurally as well as in the prose so the alerts table can show the date
  // and the new/old answer in their own column rather than making them be read out of a
  // sentence.
  const snapshot = {
    repo: repo.name, id: latest.id, at: latest.start,
    status: String(latest.status || '').toUpperCase(), isNew,
    windowChecked: recent.length, windowTotal: all.length,
  };

  let streak = 0;
  while (streak < recent.length && SNAP_BAD.has(String(recent[streak].status || '').toUpperCase())) streak++;

  if (streak) {
    const since = recent[streak - 1];
    const older = streak === recent.length && all.length > recent.length;
    return [{
      key: `${key}:failing`, level: 'critical', cluster: c, repo: repo.name, snapshot,
      failingSince: since.start,
      title: `${c.name}/${repo.name}: ${streak} of the last ${recent.length} snapshots failed`,
      detail: `Failing since ${snapDay(since.start)} (${since.id})`
            + `${older ? ' — or earlier; every run in the window failed' : ''}. `
            + `Newest ${latest.id} is ${snapshot.status} at ${snapDay(latest.start)}.`,
    }];
  }

  if (!isNew) {
    return [{
      key: `${key}:stale`, level: 'warning', cluster: c, repo: repo.name, snapshot,
      title: `${c.name}/${repo.name}: newest snapshot is not recent`,
      detail: `${latest.id} succeeded at ${snapDay(latest.start)}, which is older than the `
            + `${state.defaults.snapshotStaleHours}h this cluster allows. The last `
            + `${recent.length} runs all succeeded, so the schedule stopped rather than broke.`,
    }];
  }
  return [];
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

/**
 * Which JVM a cluster's nodes are running on.
 *
 * One definition because two screens want it: the fleet summary needs one line per
 * cluster, and a node listing needs the same words for the same thing. A cluster whose
 * nodes disagree is the interesting case — that is a half-finished upgrade, and it must
 * not be flattened to whichever node happened to answer first.
 *
 * Elasticsearch reports this only for nodes that answered. If none did, the answer is
 * "unknown", never a blank that reads as "none".
 *
 * @returns {{text: string, mixed: boolean, versions: string[], detail: string}}
 */
export function jvmSummary(nodes) {
  const seen = (nodes || [])
    .map((n) => String((n && n.jdk) || '').trim())
    .filter(Boolean);
  if (!seen.length) {
    return { text: 'unknown', mixed: false, versions: [], detail: 'no node reported a JVM version' };
  }
  const versions = [...new Set(seen)].sort();
  if (versions.length === 1) {
    return { text: versions[0], mixed: false, versions, detail: `every node runs JVM ${versions[0]}` };
  }
  const byVersion = versions.map((v) => `${v} (${seen.filter((x) => x === v).length})`);
  return {
    text: `mixed (${versions.length})`,
    mixed: true,
    versions,
    detail: `nodes disagree: ${byVersion.join(', ')}`,
  };
}
