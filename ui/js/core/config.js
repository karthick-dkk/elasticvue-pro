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
  // ECS fields the Indices page breaks daily volume down by, and watches for spikes.
  // Each must be aggregatable; a `.keyword` sub-field is tried automatically.
  volumeFields: ['tag1', 'src_hostname'],
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
      liveRetention: c.liveRetention || c.live_retention || defaults.liveRetention || '',
      snapshotRetention: c.snapshotRetention || c.snapshot_retention || defaults.snapshotRetention || '',
      enabled: c.enabled !== false,
    };
  });

  return { defaults, clusters, jumpHosts, sourceName, loadedAt: Date.now(), raw, sealed: anySealed };
}

/** `tag1, src_hostname` or a YAML list — either way, a clean array of field names. */
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
  if (!r || !r.ok) throw new ConfigError((r && r.message) || `Could not read ${path}`);
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
