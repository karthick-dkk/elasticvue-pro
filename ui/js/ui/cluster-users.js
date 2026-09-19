/**
 * The cluster's own accounts, and creating them across several clusters at once.
 *
 * Two different things are called "user" in this app and conflating them is the whole
 * reason this is a separate module. An ElasticVue account signs in to this app and its
 * role decides which pages it gets. An Elasticsearch account signs in to a cluster and
 * its roles decide which indices it can read. They live in different stores, and one
 * never implies the other.
 *
 * Creating is fanned out because that is how the drift happens: the same analyst is meant
 * to exist on eleven clusters, gets made by hand on nine of them, and the two that were
 * missed are found during an incident.
 */

import { h } from '../lib/dom.js';
import { client, clusters } from '../core/state.js';
import { modal, field, text, select, val, confirmDialog } from './modal.js';
import { toast } from './menu.js';
import { TASKS, taskById, missingFields, preview, runTask } from '../core/tasks.js';
import { ensureWrites } from '../core/writes.js';

/**
 * Read the native-realm accounts from one cluster.
 *
 * A cluster with security switched off refuses this outright, and one on LDAP or SAML
 * answers with only its built-ins. Both are reported as what they are: an empty list
 * would say "this cluster has no users", which is a different and untrue statement.
 */
export async function fetchClusterUsers(clusterId) {
  const cl = client(clusterId);
  if (!cl) return { users: null, error: 'not connected' };
  try {
    const res = await cl.securityUsers();
    const users = Object.values(res || {}).map((u) => ({
      name: u.username,
      roles: u.roles || [],
      enabled: u.enabled !== false,
      fullName: u.full_name || '',
      email: u.email || '',
      reserved: !!(u.metadata && u.metadata._reserved),
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { users, error: null };
  } catch (e) {
    const m = String(e.message || e);
    return {
      users: null,
      error: /security|400|404/i.test(m)
        ? 'Security is not enabled on this cluster, or the account cannot read the native realm.'
        : m,
    };
  }
}

/**
 * Create a user, a role or an API key on one or more clusters.
 *
 * Nothing is asked for until the kind is chosen: a role does not need a password and a key
 * does not need roles, and a form showing every field of all three is a form where most of
 * the boxes are wrong for whatever you are doing.
 */
export async function createDialog({ preselect = [], onDone } = {}) {
  const all = clusters();
  if (!all.length) { toast('No clusters configured', 'warn'); return; }

  let task = TASKS[0];
  const chosen = new Set(preselect.length ? preselect : all.map((c) => c.id));

  const fieldBox = h('div', { style: { display: 'grid', gap: '8px' } });
  const drawFields = () => {
    while (fieldBox.firstChild) fieldBox.removeChild(fieldBox.firstChild);
    for (const f of task.fields) {
      fieldBox.append(field(f.label,
        text(`cu-${f.name}`, '', {
          type: f.type === 'password' ? 'password' : 'text',
          placeholder: f.placeholder || '',
        }),
        f.hint));
    }
  };

  const kindSel = select('cu-kind', task.id, TASKS.map((t) => [t.id, t.title]));
  kindSel.onchange = () => { task = taskById(kindSel.value) || TASKS[0]; drawFields(); };
  drawFields();

  const clusterBox = h('div', { style: { display: 'grid', gap: '3px', maxHeight: '160px', overflowY: 'auto' } },
    ...all.map((c) => h('label', { style: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: chosen.has(c.id),
        onchange: (e) => { if (e.target.checked) chosen.add(c.id); else chosen.delete(c.id); } }),
      h('span', c.name),
      h('span.mono.muted', { style: { fontSize: '10.5px' } }, c.url))));

  const res = await modal('Create on a cluster', 'pick what to create — the fields follow from it', [
    field('Create', kindSel),
    fieldBox,
    field('Apply to', clusterBox),
  ], (ctx) => [
    h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
      const values = {};
      for (const f of task.fields) values[f.name] = val(`cu-${f.name}`);
      const missing = missingFields(task, values);
      if (missing.length) throw new Error(`Fill in ${missing.join(', ')}.`);
      const picked = all.filter((c) => chosen.has(c.id));
      if (!picked.length) throw new Error('Pick at least one cluster.');
      if (!(await ensureWrites())) return null;

      const shown = preview(task, values);
      const ok = await confirmDialog(`${task.title} on ${picked.length} cluster(s)?`,
        `${shown.method} ${shown.path}\n\n${picked.map((c) => `  ${c.name}`).join('\n')}\n\n`
        + 'Each cluster is done in turn; one refusing does not stop the rest.',
        { yes: `run on ${picked.length}`, danger: true });
      if (!ok) return null;

      const out = await runTask(task, values, picked.map((c) => c.id));
      // The password existed for the length of this call and no longer.
      for (const k of Object.keys(values)) values[k] = '';
      return { task, out };
    }) }, 'Create'),
    h('button.btn', { onclick: () => ctx.close(null) }, 'Cancel'),
  ], { width: '620px' });

  if (!res) return;
  const okN = res.out.filter((r) => r.ok).length;
  toast(`${res.task.title}: ${okN} applied, ${res.out.length - okN} failed`,
    okN === res.out.length ? 'ok' : 'err', 5000);
  await report(res.task, res.out);
  if (onDone) onDone();
}

/** What each cluster said. An API key is shown here because it is shown nowhere else. */
async function report(task, res) {
  const rows = res.map((r) => {
    const c = clusters().find((x) => x.id === r.clusterId);
    return h('div', { style: { display: 'flex', gap: '8px', fontSize: '12px', alignItems: 'baseline' } },
      h('span', { style: { width: '14px' } }, r.ok ? '✓' : '✗'),
      h('b', { style: { minWidth: '120px' } }, c ? c.name : r.clusterId),
      h('span.muted', r.message));
  });
  const keys = res.filter((r) => r.ok && r.kept && r.kept.encoded);
  await modal(`${task.title} — result`, `${res.filter((r) => r.ok).length} of ${res.length} applied`, [
    h('div', { style: { display: 'grid', gap: '4px' } }, ...rows),
    keys.length
      ? h('div', { style: { marginTop: '10px' } },
          h('div.banner.warn', { style: { margin: 0 } },
            h('div', h('div.ttl', 'Copy these keys now'),
              h('div', { style: { fontSize: '12px' } },
                'Elasticsearch will not show them again. Nothing here stores them.'))),
          ...keys.map((r) => {
            const c = clusters().find((x) => x.id === r.clusterId);
            return h('div', { style: { marginTop: '6px' } },
              h('div.muted', { style: { fontSize: '11px' } }, c ? c.name : r.clusterId),
              h('pre.mono', { style: { fontSize: '11px', margin: 0, padding: '8px', background: 'var(--surface-2)',
                                       borderRadius: '4px', overflowX: 'auto', userSelect: 'all' } }, r.kept.encoded));
          }))
      : null,
  ], (ctx) => [h('button.btn.primary', { onclick: () => ctx.close(true) }, 'Done')], { width: '640px' });
}

/** Remove one account from one cluster. */
export async function removeClusterUser(clusterId, name, { onDone } = {}) {
  const c = clusters().find((x) => x.id === clusterId);
  const ok = await confirmDialog(`Remove "${name}" from ${c ? c.name : clusterId}?`,
    'This deletes the account on that cluster only. Anything signing in with it stops working.',
    { yes: 'remove it', danger: true });
  if (!ok) return;
  if (!(await ensureWrites())) return;
  try {
    const r = await client(clusterId).deleteSecurityUser(name);
    if (!r.ok) throw new Error(r.message || r.kind || `HTTP ${r.status}`);
    toast(`Removed ${name} from ${c ? c.name : clusterId}`);
    if (onDone) onDone();
  } catch (e) {
    toast(`Could not remove ${name}: ${e.message}`, 'err', 5000);
  }
}
