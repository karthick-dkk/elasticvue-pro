/** Elasticsearch client. All network I/O is delegated to the Rust core: it owns the
 *  TLS decisions, the SSH tunnels and the read-only guard, so no page can route around them. */

import { bridge } from './transport.js';

const send = (msg) => bridge(msg);

export async function primeWorker(clusters, readOnly = true, jumpHosts = []) {
  return send({
    type: 'PRIME',
    readOnly,
    clusters: clusters.map((c) => ({ id: c.id, url: c.url, authHeader: c.authHeader, via: c.via || null, tls: c.tls || null })),
    jumpHosts: jumpHosts.map((j) => ({ id: j.id, host: j.host, port: j.port, user: j.user, keyFile: j.keyFile || null })),
  });
}

/* ---- desktop-only messages ---- */
export const tunnels = () => send({ type: 'TUNNELS' });
export const trustCert = (host, sha256) => send({ type: 'TRUST_CERT', host, sha256 });
export const untrustCert = (host) => send({ type: 'UNTRUST_CERT', host });
export const trustHostKey = (jumpId, fingerprint) => send({ type: 'TRUST_HOSTKEY', jumpId, fingerprint });
export const untrustHostKey = (jumpId) => send({ type: 'UNTRUST_HOSTKEY', jumpId });
export const tunnelSecret = (jumpId, secret) => send({ type: 'TUNNEL_SECRET', jumpId, ...secret });
export const tunnelReconnect = (jumpId) => send({ type: 'TUNNEL_RECONNECT', jumpId });
export const listPins = () => send({ type: 'PINS' });
/** Requests this app sent to each cluster in the last five minutes — our load on it. */
export const requestStats = () => send({ type: 'REQUEST_STATS' });
/** REST console write unlock. Session-only in the core: never persisted, gone on restart. */
export const writeUnlock = (on) => send({ type: 'WRITE_UNLOCK', on: !!on });
export const vaultGet = (scope) => send({ type: 'VAULT_GET', scope });
export const vaultSet = (scope, value) => send({ type: 'VAULT_SET', scope, value });
export const vaultDel = (scope) => send({ type: 'VAULT_DEL', scope });

/** Ask the worker what it is currently enforcing (source of truth, not the UI's copy). */
export async function workerStatus() { return send({ type: 'PING' }); }

/**
 * Turn on exact net:: error reporting. Needs the optional "webRequest" permission, which
 * Chrome will only grant from a user gesture — call this straight from a click handler.
 */
export async function enableNetErrors() { return { ok: true, always: true }; }

/** Raw probe against an arbitrary URL, used by connection diagnostics. */
export async function probeUrl(clusterId, url, timeoutMs = 8000) {
  return send({ type: 'ES', clusterId, url, path: '/', method: 'GET', timeoutMs });
}

export async function forgetWorker() { return send({ type: 'FORGET' }); }
export async function setBadge(text, color, title) { return send({ type: 'BADGE', text, color, title }); }
export async function openApp() { return send({ type: 'OPEN_APP' }); }

/** Connection state machine per cluster, with exponential backoff re-connect. */
export class EsClient {
  constructor(cluster, defaults, onPrimeNeeded) {
    this.c = cluster;
    this.defaults = defaults;
    this.onPrimeNeeded = onPrimeNeeded;
    this.state = 'unknown'; // unknown | connecting | online | offline | auth_error | tls_error | tunnel_error
    this.lastError = null;
    this.lastOkAt = 0;
    this.failures = 0;
    this.nextRetryAt = 0;
    this.info = null;
  }

  get backoffMs() {
    return Math.min(60000, 2000 * Math.pow(2, Math.min(this.failures, 5)));
  }

  get canTryNow() { return Date.now() >= this.nextRetryAt; }

  /**
   * `opts.allowWrites` is set by the REST console alone, for a request a person typed.
   * The core still refuses it unless the session has been unlocked, so leaving it off
   * everywhere else is what keeps polling and page loads read-only.
   */
  async request(method, path, body = null, opts = {}) {
    const msg = {
      type: 'ES',
      clusterId: this.c.id,
      url: this.c.url,
      method,
      path,
      body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
      timeoutMs: opts.timeoutMs || this.defaults.requestTimeoutMs,
      allowWrites: opts.allowWrites === true,
    };
    let res = await send(msg);
    if (res.kind === 'no_creds' && this.onPrimeNeeded) {
      await this.onPrimeNeeded();
      res = await send(msg);
    }
    this._track(res);
    return res;
  }

  _track(res) {
    if (res.ok) {
      this.state = 'online';
      this.failures = 0;
      this.nextRetryAt = 0;
      this.lastOkAt = Date.now();
      this.lastError = null;
      return;
    }
    this.lastError = res;
    if (res.status === 401 || res.status === 403) {
      this.state = 'auth_error';
      this.failures = Math.min(this.failures + 1, 3);
    } else if (res.kind === 'tls_or_network' || res.kind === 'tls_untrusted' || res.kind === 'tls_pin_mismatch' || res.kind === 'tls_error') {
      this.state = 'tls_error';
      this.failures += 1;
    } else if (res.kind === 'tunnel_error') {
      this.state = 'tunnel_error';
      this.failures += 1;
    } else if (res.status && res.status >= 400) {
      // A 4xx/5xx on one endpoint does not mean the cluster is down.
      if (this.state !== 'online') this.state = 'online';
    } else {
      this.state = 'offline';
      this.failures += 1;
    }
    this.nextRetryAt = Date.now() + this.backoffMs;
  }

  /** Convenience wrapper returning the JSON payload or throwing. */
  async json(method, path, body = null, opts = {}) {
    const res = await this.request(method, path, body, opts);
    if (!res.ok) {
      const e = new Error(res.message || `HTTP ${res.status}`);
      e.res = res;
      throw e;
    }
    return res.json;
  }

  /* ------------------------------ ES endpoints ------------------------------ */
  root() { return this.json('GET', '/'); }
  health() { return this.json('GET', '/_cluster/health'); }
  stats() { return this.json('GET', '/_cluster/stats?filter_path=indices.docs,indices.store,nodes.count,nodes.jvm.mem,nodes.os.mem,nodes.fs'); }
  allocation() { return this.json('GET', '/_cat/allocation?format=json&bytes=b'); }
  nodes() {
    const h = 'name,ip,version,node.role,master,heap.percent,heap.current,heap.max,ram.percent,cpu,load_1m,load_5m,disk.used,disk.avail,disk.total,disk.used_percent,uptime';
    return this.json('GET', `/_cat/nodes?format=json&bytes=b&h=${encodeURIComponent(h)}`);
  }
  indices(pattern = '*') {
    const h = 'health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size,creation.date';
    return this.json('GET', `/_cat/indices/${encodeURIComponent(pattern)}?format=json&bytes=b&expand_wildcards=open,closed&h=${encodeURIComponent(h)}`);
  }
  shardsUnassigned() {
    return this.json('GET', '/_cat/shards?format=json&h=index,shard,prirep,state,unassigned.reason,node&s=state');
  }
  repositories() { return this.json('GET', '/_snapshot?local=false'); }
  /** ES >= 7.14 supports sort/size/order on the get-snapshots API. */
  snapshots(repo, size = 500) {
    return this.json('GET', `/_snapshot/${encodeURIComponent(repo)}/_all?ignore_unavailable=true&verbose=true&sort=start_time&order=desc&size=${size}`);
  }
  snapshotsCat(repo) {
    return this.json('GET', `/_cat/snapshots/${encodeURIComponent(repo)}?format=json&s=end_epoch:desc&h=id,status,start_epoch,end_epoch,duration,indices,successful_shards,failed_shards,total_shards`);
  }
  snapshotStatus(repo, snap) {
    return this.json('GET', `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(snap)}/_status`, null, { timeoutMs: 120000 });
  }
  slmPolicies() { return this.json('GET', '/_slm/policy'); }
  /** Every ILM policy with its phases — the delete phase is the real live retention. */
  ilmPolicies() { return this.json('GET', '/_ilm/policy'); }
  /**
   * Which ILM policy the log indices are actually attached to. filter_path keeps the
   * response to one line per index instead of the whole settings block.
   */
  ilmPolicyOfIndices(pattern) {
    return this.json('GET',
      `/${encodeURIComponent(pattern)}/_settings?filter_path=*.settings.index.lifecycle.name` +
      '&expand_wildcards=open&ignore_unavailable=true&allow_no_indices=true');
  }
  slmStats() { return this.json('GET', '/_slm/stats'); }
  slmStatus() { return this.json('GET', '/_slm/status'); }
  ilmStatus() { return this.json('GET', '/_ilm/status'); }
  ilmErrors() { return this.json('GET', '/*/_ilm/explain?only_errors=true&only_managed=true'); }
  aliases() { return this.json('GET', '/_cat/aliases?format=json&h=alias,index,is_write_index'); }
  search(index, body, opts = {}) {
    const qs = opts.qs ? `?${opts.qs}` : '?ignore_unavailable=true&allow_no_indices=true';
    return this.json('POST', `/${encodeURIComponent(index)}/_search${qs}`, body, opts);
  }
  resolveIndex(pattern) { return this.json('GET', `/_resolve/index/${encodeURIComponent(pattern)}?expand_wildcards=open,closed`); }

  /* --------------------------- snapshot management ---------------------------
   * Everything below changes the cluster, so each call carries `allowWrites`. That
   * flag alone grants nothing: the core refuses it unless the operator has unlocked
   * writes for the session. See core/writes.js and the Rust guard.
   */

  /** Full detail for one snapshot — the index list, shard counts and any failures. */
  snapshotDetail(repo, snapshot) {
    return this.json('GET', `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(snapshot)}?ignore_unavailable=true`,
      null, { timeoutMs: 60000 });
  }

  /**
   * Start a snapshot. `wait_for_completion=false` returns as soon as it is accepted —
   * a large snapshot can run for hours, and the page polls for the result instead.
   */
  createSnapshot(repo, name, body) {
    return this.json('PUT', `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(name)}?wait_for_completion=false`,
      body, { allowWrites: true, timeoutMs: 60000 });
  }

  deleteSnapshot(repo, name) {
    return this.json('DELETE', `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(name)}`,
      null, { allowWrites: true, timeoutMs: 120000 });
  }

  restoreSnapshot(repo, name, body) {
    return this.json('POST', `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(name)}/_restore?wait_for_completion=false`,
      body, { allowWrites: true, timeoutMs: 60000 });
  }

  /* ------------------------------- repositories ------------------------------- */

  createRepository(name, body) {
    return this.json('PUT', `/_snapshot/${encodeURIComponent(name)}?verify=true`, body,
      { allowWrites: true, timeoutMs: 60000 });
  }

  deleteRepository(name) {
    return this.json('DELETE', `/_snapshot/${encodeURIComponent(name)}`, null, { allowWrites: true });
  }

  verifyRepository(name) {
    return this.json('POST', `/_snapshot/${encodeURIComponent(name)}/_verify`, null,
      { allowWrites: true, timeoutMs: 60000 });
  }

  /** Remove data in the repository no snapshot references any more. */
  cleanupRepository(name) {
    return this.json('POST', `/_snapshot/${encodeURIComponent(name)}/_cleanup`, null,
      { allowWrites: true, timeoutMs: 120000 });
  }

  /* ----------------------------------- SLM ----------------------------------- */

  executeSlmPolicy(id) {
    return this.json('POST', `/_slm/policy/${encodeURIComponent(id)}/_execute`, null, { allowWrites: true });
  }

  /* ---------------------------- index management -----------------------------
   * Operator actions from the Indices page. Same rule as the snapshot calls: the
   * `allowWrites` flag is necessary but not sufficient — the core refuses it unless
   * the session has been unlocked.
   */

  /**
   * Delete an index from the CLUSTER. The usual reason is that it is safely in a
   * snapshot and the disk is wanted back — the snapshot copy is not affected.
   */
  deleteIndex(name) {
    return this.json('DELETE', `/${encodeURIComponent(name)}`, null, { allowWrites: true, timeoutMs: 60000 });
  }

  /** A closed index keeps its data but uses almost no heap and cannot be searched. */
  openIndex(name) {
    return this.json('POST', `/${encodeURIComponent(name)}/_open?wait_for_active_shards=0`, null,
      { allowWrites: true, timeoutMs: 120000 });
  }

  closeIndex(name) {
    return this.json('POST', `/${encodeURIComponent(name)}/_close`, null, { allowWrites: true, timeoutMs: 120000 });
  }

  refreshIndex(name) {
    return this.json('POST', `/${encodeURIComponent(name)}/_refresh`, null, { allowWrites: true });
  }

  flushIndex(name) {
    return this.json('POST', `/${encodeURIComponent(name)}/_flush`, null, { allowWrites: true, timeoutMs: 60000 });
  }

  clearIndexCache(name) {
    return this.json('POST', `/${encodeURIComponent(name)}/_cache/clear`, null, { allowWrites: true, timeoutMs: 60000 });
  }

  /** Merges segments. Expensive, so it runs detached and the page does not wait. */
  forceMergeIndex(name, maxSegments = 1) {
    return this.json('POST',
      `/${encodeURIComponent(name)}/_forcemerge?max_num_segments=${Number(maxSegments) || 1}&wait_for_completion=false`,
      null, { allowWrites: true, timeoutMs: 60000 });
  }

  updateIndexSettings(name, settings) {
    return this.json('PUT', `/${encodeURIComponent(name)}/_settings`, settings, { allowWrites: true, timeoutMs: 60000 });
  }

  indexSettings(name) {
    return this.json('GET', `/${encodeURIComponent(name)}/_settings?flat_settings=true`);
  }

  /** Where each shard of an index currently sits — the input to a move. */
  shardsOf(name) {
    return this.json('GET',
      `/_cat/shards/${encodeURIComponent(name)}?format=json&bytes=b&h=index,shard,prirep,state,node,store,unassigned.reason`);
  }

  /** Move one shard between nodes, or retry allocations that gave up. */
  reroute(commands) {
    return this.json('POST', '/_cluster/reroute?metric=none', { commands }, { allowWrites: true, timeoutMs: 60000 });
  }

  retryFailedAllocation() {
    return this.json('POST', '/_cluster/reroute?retry_failed=true&metric=none', null,
      { allowWrites: true, timeoutMs: 60000 });
  }

  /** Indices, for choosing what a snapshot should contain. */
  indexNames(pattern = '*') {
    return this.json('GET',
      `/_cat/indices/${encodeURIComponent(pattern)}?format=json&bytes=b&expand_wildcards=open,closed&h=index,health,status,store.size,docs.count`);
  }
}
