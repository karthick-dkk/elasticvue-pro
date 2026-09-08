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

  async request(method, path, body = null, opts = {}) {
    const msg = {
      type: 'ES',
      clusterId: this.c.id,
      url: this.c.url,
      method,
      path,
      body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
      timeoutMs: opts.timeoutMs || this.defaults.requestTimeoutMs,
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
}
