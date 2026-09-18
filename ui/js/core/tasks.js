/**
 * Tasks: one named request, applied to the clusters you pick.
 *
 * The rules in automation.js watch and propose; a human runs what they suggest, one
 * cluster at a time. That is the right shape for "something here looks wrong" and the
 * wrong shape for "this role should exist on all eleven clusters", which is not a finding
 * at all — it is the same deliberate change repeated, and repeating it by hand in the
 * REST console is where fleets drift apart.
 *
 * A task is therefore a definition, not a feature: a title, the fields it needs, and a
 * function turning those into one request. Adding index templates or ILM policies later
 * is an entry in TASKS, not another page.
 *
 * Three things are deliberate about how they run:
 *
 * Nothing here decides it may write. Every request carries `allowWrites`, which the core
 * refuses unless the session has been unlocked by hand — the same two gates as deleting
 * an index. A task runs because somebody pressed Run, never on a timer or a page load.
 *
 * Clusters are done one at a time, and a failure stops nothing. Eleven clusters where the
 * fourth rejects the request should leave the other ten done and say which one failed;
 * a fan-out that aborts halfway leaves the fleet in a state nobody chose.
 *
 * Secrets never leave this module. A password is typed once, sent, and dropped. It is not
 * stored, not logged, and `preview()` redacts it — a task that prints the request it is
 * about to send must not print the credential inside it.
 */

import { client } from './state.js';
import { writesAllowed } from './writes.js';

/** Fields whose value is a credential: redacted everywhere, kept nowhere. */
const SECRET = new Set(['password']);

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const TASKS = [
  {
    id: 'security-role',
    title: 'Create or update a role',
    why: 'A role defines what an account may do. Applying the same definition to every '
       + 'cluster is what keeps "read-only analyst" meaning the same thing on all of them.',
    danger: 'normal',
    docs: 'PUT /_security/role/<name>',
    fields: [
      { name: 'name', label: 'Role name', required: true, placeholder: 'log-reader' },
      { name: 'cluster_privileges', label: 'Cluster privileges', placeholder: 'monitor, read_ilm',
        hint: 'comma separated; leave empty for none' },
      { name: 'index_patterns', label: 'Index patterns', placeholder: 'logstash-*, app-*',
        hint: 'which indices the privileges below apply to' },
      { name: 'index_privileges', label: 'Index privileges', placeholder: 'read, view_index_metadata',
        hint: 'comma separated' },
    ],
    build(v) {
      const body = { cluster: csv(v.cluster_privileges) };
      const names = csv(v.index_patterns);
      const privs = csv(v.index_privileges);
      // An indices block with no privileges is rejected by Elasticsearch rather than
      // ignored, so it is left out entirely instead of sent empty.
      if (names.length && privs.length) body.indices = [{ names, privileges: privs }];
      return { method: 'PUT', path: `/_security/role/${encodeURIComponent(v.name)}`, body };
    },
    summarise: (v) => `role "${v.name}"`,
  },
  {
    id: 'security-user',
    title: 'Create or update a user',
    why: 'The account itself, and the roles it holds. One password, typed once, applied to '
       + 'every cluster you pick — so the same person signs in the same way everywhere.',
    danger: 'credential',
    docs: 'PUT /_security/user/<name>',
    fields: [
      { name: 'name', label: 'Username', required: true, placeholder: 'analyst' },
      { name: 'password', label: 'Password', required: true, type: 'password',
        hint: 'sent to every selected cluster, then dropped — never written to disk or logged' },
      { name: 'roles', label: 'Roles', required: true, placeholder: 'log-reader, monitoring_user',
        hint: 'comma separated; they must already exist on the cluster' },
      { name: 'full_name', label: 'Full name', placeholder: 'optional' },
      { name: 'email', label: 'Email', placeholder: 'optional' },
    ],
    build(v) {
      const body = { password: v.password, roles: csv(v.roles) };
      if (v.full_name) body.full_name = v.full_name;
      if (v.email) body.email = v.email;
      return { method: 'PUT', path: `/_security/user/${encodeURIComponent(v.name)}`, body };
    },
    summarise: (v) => `user "${v.name}" with ${csv(v.roles).length} role(s)`,
  },
];

export function taskById(id) { return TASKS.find((t) => t.id === id) || null; }

/** What is missing before this task can run. Empty means it is ready. */
export function missingFields(task, values) {
  return task.fields
    .filter((f) => f.required && !String(values[f.name] || '').trim())
    .map((f) => f.label);
}

/**
 * The request this task would send, with any credential replaced.
 *
 * Shown before running, and used for the per-cluster record afterwards. Redaction happens
 * here rather than at the call site so a new task cannot forget it.
 */
export function preview(task, values) {
  const { method, path, body } = task.build(values);
  const safe = body && typeof body === 'object' ? { ...body } : body;
  if (safe && typeof safe === 'object') {
    for (const k of Object.keys(safe)) if (SECRET.has(k)) safe[k] = '••••••••';
  }
  return { method, path, body: safe };
}

/**
 * Run one task against the given clusters, one at a time.
 *
 * Resolves to a result per cluster in the order given: `{ clusterId, ok, status, message }`.
 * Never throws for a cluster that refused — a refusal is a result, and the point of the
 * report is which clusters took it and which did not.
 */
export async function runTask(task, values, clusterIds, { onProgress } = {}) {
  if (!writesAllowed()) {
    throw new Error('writes are locked — allow writes before running a task');
  }
  const missing = missingFields(task, values);
  if (missing.length) throw new Error(`fill in ${missing.join(', ')}`);

  const { method, path, body } = task.build(values);
  const out = [];
  for (const id of clusterIds) {
    const cl = client(id);
    if (!cl) {
      out.push({ clusterId: id, ok: false, status: 0, message: 'no client for this cluster' });
      if (onProgress) onProgress(out);
      continue;
    }
    try {
      const res = await cl.request(method, path, body, { allowWrites: true, timeoutMs: 30000 });
      out.push({
        clusterId: id,
        ok: res.ok === true,
        status: res.status || 0,
        // The core's own refusal reads better than the HTTP status it did not reach.
        message: res.ok ? 'applied' : (res.message || res.kind || `HTTP ${res.status}`),
      });
    } catch (e) {
      out.push({ clusterId: id, ok: false, status: 0, message: e.message || String(e) });
    }
    if (onProgress) onProgress(out);
  }
  return out;
}
