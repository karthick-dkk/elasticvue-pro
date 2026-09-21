/**
 * Config layer.
 *
 * The whole configuration - including the single shared credential - lives in an
 * external YAML file on disk. The desktop app remembers the file's PATH; the file's
 * CONTENTS (and therefore the password / API key) are read into memory on every start
 * and never written anywhere else.
 */

import { pickConfigPath, readConfigText, savedConfigPath, rememberConfigPath } from './platform.js';

export const CONFIG_FILE_TYPES = [
  { description: 'YAML config', accept: { 'application/yaml': ['.yaml', '.yml'], 'text/yaml': ['.yaml', '.yml'] } },
];

export const DEFAULTS = {
  // Safety default: the extension only ever sends GET/HEAD plus search-family POSTs.
  // Set `readOnly: false` under `defaults:` in clusters.yaml to allow writes.
  readOnly: true,
  // Off by default: the dashboard loads once and then stays put until you ask it to
  // refresh. Set autoRefresh: true here, or use the toggle in the top bar (which is
  // remembered), to have it poll every refreshIntervalSec.
  autoRefresh: false,
  refreshIntervalSec: 30,
  requestTimeoutMs: 15000,
  logIndexPattern: 'logstash-*',
  // Named groups <source> and <date> drive the source picker on the Indices page.
  // <client> is still honoured for configs written before the rename.
  indexNameRegex: '^(?<prefix>[a-z0-9_.-]*?logstash)-(?<source>.+)-(?<date>\\d{4}[.\\-]\\d{2}[.\\-]\\d{2})$',
  timeField: '@timestamp',
  diskWarnPercent: 80,
  diskCritPercent: 90,
  // Capacity planning defaults, overridable per cluster. Empty means "not stated" —
  // the volume report then says so rather than assuming a number.
  liveRetention: '',
  snapshotRetention: '',
  // Total size of the snapshot repository. Elasticsearch has no API for it — a repository
  // is a bucket or a mount point, and only the operator knows how big it is. "2TB",
  // "500 GB" or a bare number of GB. Empty means the report says "not set" rather than
  // guessing.
  backupCapacity: '',
  // ECS fields the Indices page breaks daily volume down by, and watches for spikes.
  // Each must be aggregatable; a `.keyword` sub-field is tried automatically.
  // Offered in the Volume analysis picker when a cluster names none of its own. They are
  // only candidates: the aggregation runs on demand, one field at a time, and a name
  // this cluster does not have reports that rather than costing anything.
  volumeFields: ['tag1', 'fwd_tag', 'fwdtag', 'src_hostname'],
  // Offered in the Live logs field picker. Searching one named field is the common case —
  // "which host", "which tag" — and spelling it as Lucene every time is a way to mistype
  // a field name and get zero hits that look like zero data.
  logSearchFields: ['tag1', 'fwd_tag', 'fwdtag', 'src_ip', 'src_hostname', 'message'],

  // Log delay: which field names the analysis needs on a cluster.
  //
  // `device` is what delay is grouped by, `eventTime` are the candidates for "when the
  // event actually happened" tried in order, and `metadata` are carried through for
  // context. They are per-cluster because two clusters can parse the same logs into
  // different shapes — one estate ships Filebeat ECS, another a custom parser — and a
  // single hard-coded set would silently analyse neither.
  delayFields: {
    device: 'src_hostname',
    eventTime: ['ingested_time', 'event_created', 'event.created'],
    metadata: ['parser_tag', 'fwdtag', 'src_ip', 'tag1', 'ClientID', 'branch', 'log_type'],
  },
  snapshotStaleHours: 26,
  maxLogRows: 200,
  // Certificate policy: auto (OS store, else trust-on-first-use with a prompt), system (strict), insecure.
  tls: 'auto',
};

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'cluster';
}

export function b64(s) {
  // btoa is latin1-only; encode UTF-8 first so non-ASCII passwords survive.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

export function authHeaderFor(cred) {
  if (!cred) return null;
  if (cred.apiKey) {
    // Accept both the raw "id:api_key" pair and an already-base64 encoded value.
    const v = cred.apiKey.includes(':') ? b64(cred.apiKey) : cred.apiKey;
    return `ApiKey ${v}`;
  }
  if (cred.bearer) return `Bearer ${cred.bearer}`;
  if (cred.username) return `Basic ${b64(`${cred.username}:${cred.password || ''}`)}`;
  return null;
}

class ConfigError extends Error {}

function requireYaml() {
  const y = globalThis.jsyaml;
  if (!y) throw new ConfigError('YAML parser not loaded (vendor/js-yaml.min.js missing).');
  return y;
}

/** Turn the raw YAML object into the shape the app uses. */
export function normalize(raw, sourceName = 'clusters.yaml') {
  if (!raw || typeof raw !== 'object') throw new ConfigError('Config file is empty or not a YAML mapping.');

  const defaults = { ...DEFAULTS, ...(raw.defaults || {}) };
  const globalCred = raw.credentials || raw.credential || null;
  let anySealed = false;

  const list = raw.clusters || raw.hosts || [];
  if (!Array.isArray(list)) throw new ConfigError('`clusters:` must be a list.');

  // jump_hosts: { jumpwin: { host, port, user, keyFile } }  (a list of {id,...} is accepted too)
  const jhRaw = raw.jump_hosts || raw.jumpHosts || raw.jumps || {};
  const jumpHosts = (Array.isArray(jhRaw) ? jhRaw.map((j, i) => ({ id: j.id || j.name || `jump${i + 1}`, ...j }))
    : Object.entries(jhRaw).map(([id, j]) => ({ id, ...(j || {}) })))
    .map((j) => {
      if (!j.host) throw new ConfigError(`jump_hosts.${j.id} is missing \`host:\``);
      if (!j.user) throw new ConfigError(`jump_hosts.${j.id} is missing \`user:\``);
      if (j.passphrase || j.password) throw new ConfigError(`jump_hosts.${j.id}: passphrase/password must not be in the file — the app asks for them.`);
      return { id: String(j.id), host: String(j.host), port: Number(j.port) || 22, user: String(j.user),
               keyFile: j.keyFile || j.key_file || j.key || '', note: j.note || '' };
    });
  const jumpIds = new Set(jumpHosts.map((j) => j.id));

  const seen = new Set();
  const clusters = list.map((c, i) => {
    if (!c || !c.url) throw new ConfigError(`clusters[${i}] is missing a \`url:\``);
    const name = c.name || new URL(c.url).host;
    let id = slug(name);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);

    // Rule 3: one credential drives every URL, unless a cluster explicitly overrides it.
    const hasOwn = c.username || c.apiKey || c.bearer;
    const cred = hasOwn
      ? { username: c.username, password: c.password, apiKey: c.apiKey, bearer: c.bearer }
      : globalCred;

    // A credential is only usable if the file actually carries a secret. A file that
    // names a username but no password is a deliberate pattern - we prompt for the
    // password and prefill the username. A secret stored encrypted (enc:v1:…) is not
    // usable until the master password unlocks it.
    const sealed = !!(cred && [cred.password, cred.apiKey, cred.bearer].some((v) => isSealed(v)));
    if (sealed) anySealed = true;
    const hasSecret = !sealed && !!(cred && (cred.apiKey || cred.bearer || (cred.username && cred.password)));

    const via = c.via || c.jump || c.jumpHost || c.jump_host || '';
    if (via && !jumpIds.has(String(via))) throw new ConfigError(`clusters[${i}] (${name}): via: ${via} is not defined under jump_hosts:`);

    return {
      id,
      name,
      via: via ? String(via) : '',
      tls: String(c.tls || defaults.tls || 'auto'),
      url: String(c.url).replace(/\/+$/, ''),
      origin: (() => { try { return new URL(c.url).origin; } catch { return c.url; } })(),
      tags: c.tags || [],
      note: c.note || '',
      credSource: hasSecret ? (hasOwn ? 'cluster' : 'shared') : 'none',
      needsCred: !hasSecret,
      sealedCred: sealed ? { ...cred } : null,
      hasOwnCred: !!hasOwn,
      suggestedUsername: (cred && cred.username) || '',
      authHeader: hasSecret ? authHeaderFor(cred) : null,
      username: hasSecret ? ((cred && cred.username) || (cred && cred.apiKey ? '(api key)' : '')) : '',
      logIndexPattern: c.logIndexPattern || defaults.logIndexPattern,
      indexNameRegex: c.indexNameRegex || defaults.indexNameRegex,
      timeField: c.timeField || defaults.timeField,
      snapshotRepos: c.snapshotRepos || null,
      // Capacity planning: how long logs are meant to stay on the cluster and in the
      // repository. "30d", "90 days", "3M", "6 months", "1y" or a bare number of days.
      volumeFields: normFields(c.volumeFields || c.volume_fields || defaults.volumeFields),
      logSearchFields: normFields(c.logSearchFields || c.log_search_fields || defaults.logSearchFields),
      delayFields: normDelayFields(c.delayFields || c.delay_fields, defaults.delayFields),
      s3: normS3(c.s3),
      liveRetention: c.liveRetention || c.live_retention || defaults.liveRetention || '',
      snapshotRetention: c.snapshotRetention || c.snapshot_retention || defaults.snapshotRetention || '',
      backupCapacity: c.backupCapacity || c.backup_capacity || defaults.backupCapacity || '',
      enabled: c.enabled !== false,
    };
  });

  return { defaults, clusters, jumpHosts, sourceName, loadedAt: Date.now(), raw, sealed: anySealed };
}

/** `tag1, src_hostname` or a YAML list — either way, a clean array of field names. */
/**
 * The archive bucket for one client, or null.
 *
 * Per cluster because the buckets are per client — one account per customer is the usual
 * shape, and a single set of keys for the fleet would be the wrong grant even where it
 * worked. Absent means this client has no archive, which is a normal state and not a
 * misconfiguration: ULM simply has nothing to say about them.
 *
 * `useRole` and explicit keys are not exclusive. Keys win when both are present, because
 * somebody wrote them down for this bucket on purpose; the role is the fallback.
 */
function normS3(v) {
  if (!v || typeof v !== 'object') return null;
  const bucket = String(v.bucket || '').trim();
  if (!bucket) return null;
  const auth = (v.auth && typeof v.auth === 'object') ? v.auth : v;
  return {
    bucket,
    region: String(v.region || 'us-east-1').trim(),
    endpoint: String(v.endpoint || '').trim() || null,
    // Where the two log copies live. Defaults match the layout ULM was specified
    // against; a bucket that arranges them differently says so here rather than in code.
    rawPrefix: String(v.rawPrefix || v.raw_prefix || 'rawlog').replace(/^\/+|\/+$/g, ''),
    enrichedPrefix: String(v.enrichedPrefix || v.enriched_prefix || 'enrichedlog').replace(/^\/+|\/+$/g, ''),
    auth: {
      accessKeyId: String(auth.accessKeyId || auth.access_key_id || '').trim() || null,
      secretAccessKey: String(auth.secretAccessKey || auth.secret_access_key || '').trim() || null,
      sessionToken: String(auth.sessionToken || auth.session_token || '').trim() || null,
      useRole: auth.useRole ?? auth.use_role ?? !(auth.accessKeyId || auth.access_key_id),
    },
  };
}

/** A partial delayFields block overrides only the parts it names. */
function normDelayFields(v, defaults) {
  const d = v && typeof v === 'object' ? v : {};
  return {
    device: String(d.device || defaults.device),
    eventTime: normFields(d.eventTime || d.event_time || defaults.eventTime),
    metadata: normFields(d.metadata || defaults.metadata),
  };
}

function normFields(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

export function isSealed(v) { return typeof v === 'string' && v.startsWith('enc:v1:'); }

/** YAML or JSON — decided by content, not by extension. */
export function parseConfigText(text, sourceName) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  let raw, format;
  if (/^\s*\{/.test(t)) {
    try { raw = JSON.parse(t); format = 'json'; }
    catch (e) { throw new ConfigError(`JSON parse error: ${e.message}`); }
  } else {
    const y = requireYaml();
    try { raw = y.load(t, { schema: y.JSON_SCHEMA }); format = 'yaml'; }
    catch (e) { throw new ConfigError(`YAML parse error: ${e.message}`); }
  }
  const cfg = normalize(raw, sourceName);
  cfg.format = format;
  return cfg;
}
export const parseYamlText = parseConfigText;

/** The file the app writes: JSON, stable key order, 2-space indent. */
export function serializeConfig(raw) {
  const ordered = {};
  for (const k of ['version', 'credentials', 'defaults', 'jump_hosts', 'clusters']) if (raw[k] !== undefined) ordered[k] = raw[k];
  for (const k of Object.keys(raw)) if (!(k in ordered)) ordered[k] = raw[k];
  ordered.version = 2;
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** Skeleton for a config created in the UI. */
export function newRawConfig() {
  return {
    version: 2,
    defaults: { readOnly: true, autoRefresh: false, refreshIntervalSec: 30, logIndexPattern: 'logstash-*', tls: 'auto' },
    jump_hosts: {},
    clusters: [],
  };
}

/* ------------------------------ file plumbing ------------------------------ */

export const fsSupported = true;

function basename(p) { return String(p).split(/[\\/]/).pop() || p; }

/** Read + parse the YAML at `path` through the core. */
export async function readPath(path) {
  const r = await readConfigText(path);
  if (!r || !r.ok) {
    const e = new ConfigError((r && r.message) || `Could not read ${path}`);
    // Carried through so the caller can tell "no config here yet" from "this config is
    // broken" without reading the message.
    e.kind = (r && r.kind) || 'io_error';
    throw e;
  }
  const cfg = parseConfigText(r.text, basename(path));
  cfg.fileMeta = { name: basename(path), path, size: r.size || r.text.length, lastModified: r.lastModified || 0 };
  return cfg;
}

/** Native file dialog → remembered path. Returns '' when cancelled. */
export async function pickConfigFile() {
  const p = await pickConfigPath();
  if (p) rememberConfigPath(p);
  return p;
}

export function savedPath() { return savedConfigPath(); }
export async function forgetHandle() { rememberConfigPath(''); }

/** Load config on startup from the remembered path. */
export async function loadConfig() {
  const path = savedConfigPath();
  if (!path) return { status: 'no_file' };
  try {
    return { status: 'ok', path, config: await readPath(path) };
  } catch (e) {
    return { status: 'error', path, error: e.message };
  }
}

export { ConfigError };
