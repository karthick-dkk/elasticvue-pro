/** Page — automation: rules that watch continuously and propose work for a human to run. */

import { h, mount } from '../lib/dom.js';
import { bytes, num, ago } from '../lib/fmt.js';
import { state, clusters, activeClusters, fetchIndices } from '../core/state.js';
import { card, collapsible, pill, statTile, empty, table } from './common.js';
import { activeRules, runAutomation, resultsFor, allProposals, allBlocked, isRunning, lastRunAt, canArm } from '../core/automation.js';
import { TASKS, taskById, missingFields, preview, runTask } from '../core/tasks.js';
import { writeToggle, writesAllowed } from '../core/writes.js';
import { deleteIndices, closeIndices } from '../ui/index-actions.js';
import { ruleBuilder } from '../ui/rule-builder.js';
import { putRule, removeRule, loadRules } from '../core/user-rules.js';
import { saveRaw } from '../ui/config-editor.js';
import { confirmDialog } from '../ui/modal.js';
import { navigateTo } from '../core/intent.js';

let host = null;
const ui = { showBlocked: true };

/**
 * The task form's state.
 *
 * `values` holds what has been typed, including the password while the form is open. It
 * is cleared the moment a run finishes — the credential exists for exactly as long as it
 * takes to send, and a page that keeps it around for a re-run is a page that keeps it
 * around.
 */
const taskUi = { id: TASKS[0].id, values: {}, targets: new Set(), running: false, results: null, ran: null };

export function render(el) {
  host = el;
  el.classList.add('dense');
  draw();
  if (!lastRunAt()) check();          // first visit: evaluate without being asked
}
export function onData() { if (host && host.isConnected) draw(); }

/** Rules read the index list; only the Indices page fetches it otherwise. */
async function check() {
  for (const c of activeClusters()) {
    if (!state.indices.get(c.id)) {
      try { await fetchIndices(c.id, '*'); } catch (_) { /* the rule will say it has no list */ }
    }
  }
  draw();
  await runAutomation({ onProgress: draw });
  draw();
}

function draw() {
  if (!host || !host.isConnected) return;
  const list = activeClusters();
  if (!clusters().length) return mount(host, empty('No clusters configured.'));

  const proposals = allProposals();
  const blocked = allBlocked();
  const freed = proposals.reduce((s, p) => s + (p.freed || 0), 0);
  const arm = canArm();

  mount(host,
    h('div.grid.c4', { style: { marginBottom: '10px' } },
      statTile('Proposed', String(proposals.length),
        proposals.length ? 'waiting for you to run them' : 'nothing to do right now'),
      statTile('Held back', String(blocked.length),
        blocked.length ? 'not safe to propose — see why below' : 'nothing was refused'),
      statTile('Would free', freed ? bytes(freed) : '–', 'if every proposal is run'),
      statTile('Last checked', lastRunAt() ? ago(lastRunAt()) : 'never',
        `${list.length} cluster${list.length === 1 ? '' : 's'}`)),

    h('div.toolbar',
      h('button.btn.sm.primary', { disabled: isRunning(), onclick: check },
        isRunning() ? 'Checking…' : '↻ Run checks'),
      h('button.btn.sm', { onclick: () => edit(null) }, '+ New automation'),
      h('label.field', { style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } },
        h('input#auto-blocked', { type: 'checkbox', checked: ui.showBlocked,
          onchange: (e) => { ui.showBlocked = e.target.checked; draw(); } }),
        'show what was held back'),
      h('div', { style: { marginLeft: 'auto' } },
        h('span.muted', { style: { fontSize: '11px' } },
          'rules never write — every action runs through its normal confirmation'))),

    // The arming seam, visible rather than hidden. It is the honest answer to "why doesn't
    // this just do it", and it names what has to land first.
    h('div.banner', { style: { marginTop: '10px' } },
      h('div',
        h('div.ttl', arm.ok ? 'Arming available' : 'These rules propose. They never act on their own.'),
        h('div', arm.reason))),

    h('div', { style: { marginTop: '10px' } }, taskCard()),

    ...activeRules().map((rule) => ruleCard(rule, list)));
}

/* ----------------------------------- tasks ----------------------------------- */

/**
 * A task, the clusters to apply it to, and what happened on each.
 *
 * The rules above answer "what is wrong here"; this answers "make this true everywhere",
 * which is the other half of running a fleet and the half that otherwise gets done by
 * hand in the REST console, eleven times, slightly differently.
 */
function taskCard() {
  const task = taskById(taskUi.id) || TASKS[0];
  const all = clusters();
  const chosen = all.filter((c) => taskUi.targets.has(c.id));
  const missing = missingFields(task, taskUi.values);
  const picker = h('select', {
    onchange: (e) => { taskUi.id = e.target.value; taskUi.values = {}; taskUi.results = null; draw(); },
  }, ...TASKS.map((t) => h('option', { value: t.id }, t.title)));
  picker.value = task.id;

  const fields = task.fields.map((f) => h('label.field', f.label,
    h('input', {
      type: f.type === 'password' ? 'password' : 'text',
      value: taskUi.values[f.name] || '',
      placeholder: f.placeholder || '',
      autocomplete: f.type === 'password' ? 'new-password' : 'off',
      spellcheck: false,
      // No redraw per keystroke: it would rebuild the inputs and lose the caret.
      oninput: (e) => { taskUi.values[f.name] = e.target.value; refreshTaskFoot(); },
    }),
    f.hint ? h('span.muted', { style: { fontSize: '10.5px' } }, f.hint) : null));

  const clusterList = h('div', { style: { display: 'grid', gap: '3px', maxHeight: '190px', overflowY: 'auto' } },
    ...all.map((c) => h('label', {
      style: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' },
    },
      h('input', { type: 'checkbox', checked: taskUi.targets.has(c.id),
        onchange: (e) => {
          if (e.target.checked) taskUi.targets.add(c.id); else taskUi.targets.delete(c.id);
          refreshTaskFoot();
        } }),
      h('span', c.name),
      h('span.mono.muted', { style: { fontSize: '10.5px' } }, c.url))));

  const shown = preview(task, taskUi.values);
  const body = h('div', { style: { display: 'grid', gap: '12px' } },
    h('div.sec', { style: { fontSize: '12.5px' } }, task.why),

    h('div.grid.c2', { style: { alignItems: 'start' } },
      h('div', { style: { display: 'grid', gap: '8px' } },
        h('label.field', 'Task', picker), ...fields),
      h('div', { style: { display: 'grid', gap: '6px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('b', { style: { fontSize: '12px' } }, 'Apply to'),
          h('button.btn.sm.ghost', { onclick: () => { all.forEach((c) => taskUi.targets.add(c.id)); draw(); } }, 'all'),
          h('button.btn.sm.ghost', { onclick: () => { taskUi.targets.clear(); draw(); } }, 'none')),
        clusterList)),

    // What will be sent, before it is sent. The password is replaced here, not at the
    // point of display — see preview().
    h('div', { style: { display: 'grid', gap: '4px' } },
      h('span.muted', { style: { fontSize: '11px' } }, 'the request each selected cluster will receive'),
      h('pre.mono', { style: { fontSize: '11px', margin: 0, padding: '8px', background: 'var(--surface-2)',
                               borderRadius: '4px', overflowX: 'auto' } },
        `${shown.method} ${shown.path}\n${JSON.stringify(shown.body, null, 2)}`)),

    h('div#task-foot', taskFoot(task, chosen, missing)),
    taskUi.results ? resultTable(all) : null);

  return card('Tasks', 'one request, applied to the clusters you pick', body,
    [writeToggle(draw)]);

  function refreshTaskFoot() { drawTaskFoot(task, chosenNow(), missingNow(task)); }
  function chosenNow() { return clusters().filter((c) => taskUi.targets.has(c.id)); }
  function missingNow(t) { return missingFields(t, taskUi.values); }
}

/** The run button and why it is disabled, re-rendered without rebuilding the inputs. */
function drawTaskFoot(task, chosen, missing) {
  const el = document.getElementById('task-foot');
  if (el) mount(el, taskFoot(task, chosen, missing));
}

function taskFoot(task, chosen, missing) {
  const allowed = writesAllowed();
  const ready = allowed && !missing.length && chosen.length > 0 && !taskUi.running;
  const why = taskUi.running ? 'running…'
    : !allowed ? 'writes are locked — allow them above'
    : missing.length ? `fill in ${missing.join(', ')}`
    : !chosen.length ? 'pick at least one cluster'
    : `${task.summarise(taskUi.values)} on ${chosen.length} cluster${chosen.length === 1 ? '' : 's'}`;
  return h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
    h('button.btn.primary', { disabled: !ready, onclick: () => execute(task, chosen) },
      taskUi.running ? 'Running…' : 'Run task'),
    h('span.muted', { style: { fontSize: '11.5px' } }, why));
}

function resultTable(all) {
  const byId = new Map(all.map((c) => [c.id, c]));
  const trs = taskUi.results.map((r) => {
    const c = byId.get(r.clusterId);
    return h('tr',
      h('td', c ? c.name : r.clusterId),
      h('td', r.ok ? pill('applied', 'green') : pill('failed', 'red')),
      h('td.muted', { style: { fontSize: '11.5px' } }, r.message));
  });
  const okN = taskUi.results.filter((r) => r.ok).length;
  return h('div', { style: { display: 'grid', gap: '4px' } },
    h('span.muted', { style: { fontSize: '11px' } },
      `${taskUi.ran} · ${okN} applied, ${taskUi.results.length - okN} failed`),
    table(['Cluster', 'Result', 'Detail'], trs, { emptyText: 'nothing ran' }));
}

async function execute(task, chosen) {
  const ok = await confirmDialog(
    `Run "${task.title}" on ${chosen.length} cluster${chosen.length === 1 ? '' : 's'}?`,
    `${task.summarise(taskUi.values)}\n\n`
    + `${chosen.map((c) => `  ${c.name}  ${c.url}`).join('\n')}\n\n`
    + 'Each cluster is done in turn. One refusing does not stop the rest, and the report '
    + 'below will say which took it.',
    { yes: `run on ${chosen.length}`, danger: true });
  if (!ok) return;

  taskUi.running = true;
  taskUi.results = null;
  draw();
  try {
    const res = await runTask(task, taskUi.values, chosen.map((c) => c.id));
    taskUi.results = res;
    taskUi.ran = `ran ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`;
  } catch (e) {
    taskUi.results = chosen.map((c) => ({ clusterId: c.id, ok: false, status: 0, message: e.message }));
    taskUi.ran = 'refused before sending';
  } finally {
    taskUi.running = false;
    // The credential goes the moment the run is over. The rest of the form stays, so a
    // near-identical task does not have to be retyped from scratch.
    for (const f of task.fields) if (f.type === 'password') delete taskUi.values[f.name];
    draw();
  }
}

function ruleCard(rule, list) {
  const perCluster = list.map((c) => {
    const r = resultsFor(c.id);
    const item = r && r.results.find((x) => x.rule.id === rule.id);
    return { cluster: c, item };
  }).filter((x) => x.item);

  const active = perCluster.filter((x) => x.item.proposal && x.item.proposal.targets.length);
  const held = perCluster.filter((x) => x.item.proposal && (x.item.proposal.blocked || []).length);
  const notes = perCluster.filter((x) => x.item.skipped || x.item.error);

  const n = active.reduce((s, x) => s + x.item.proposal.targets.length, 0);
  const nHeld = held.reduce((s, x) => s + x.item.proposal.blocked.length, 0);
  // The counts belong in the header; the explanation belongs inside, where there is room
  // for it. Jamming a full sentence into the sub-line makes every header two lines tall.
  const sub = [n ? `${n} proposed` : 'nothing to do',
               nHeld ? `${nHeld} held back` : null].filter(Boolean).join(' · ');

  return h('div', { style: { marginTop: '10px' } },
    collapsible(rule.title, sub,
      () => h('div', { style: { display: 'grid', gap: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
          h('div.muted', { style: { fontSize: '11.5px', lineHeight: '1.55', flex: '1' } }, rule.why),
          rule.user
            ? h('div', { style: { display: 'flex', gap: '6px' } },
                h('button.btn.sm', { onclick: () => edit(rule.user) }, 'Edit'),
                h('button.btn.sm.ghost', { title: 'Remove this automation', onclick: () => destroy(rule.user) }, '×'))
            : h('span.muted', { style: { fontSize: '10.5px' } }, 'built in')),
        ...active.map((x) => proposalBlock(rule, x.cluster, x.item.proposal)),
        ui.showBlocked ? h('div', ...held.map((x) => blockedBlock(x.cluster, x.item.proposal))) : null,
        ...notes.map((x) => h('div.muted', { style: { fontSize: '11.5px' } },
          h('b', x.cluster.name), ' — ', x.item.error ? `rule failed: ${x.item.error}` : x.item.skipped)),
        !active.length && !held.length && !notes.length
          ? empty('Nothing for this rule on any cluster.') : null),
      { key: `auto-${rule.id}`, open: active.length > 0 }));
}

/**
 * Create or edit an automation, then write it to the config.
 *
 * The hosted stack mounts ./config read-only, so this save can genuinely fail there. The
 * error is surfaced rather than swallowed, because a rule the operator believes is saved
 * and is not is worse than one that never saved at all.
 */
async function edit(existing) {
  const rule = await ruleBuilder(existing);
  if (!rule) return;
  try {
    putRule(rule);
    await saveRaw({ silent: true });
  } catch (e) {
    if (existing) putRule(existing); else removeRule(rule.id);
    alert(`Could not save the automation: ${e.message || e}\n\n`
        + 'If this is the hosted deployment, ./config is mounted read-only.');
    return;
  }
  await check();
}

async function destroy(u) {
  if (!(await confirmDialog(`Remove the automation "${u.name}"?`,
    'It is taken out of the config file. Nothing it proposed is undone.',
    { yes: 'remove', danger: true }))) return;
  const before = loadRules().find((r) => r.id === u.id);
  removeRule(u.id);
  try { await saveRaw({ silent: true }); }
  catch (e) { if (before) putRule(before); alert(`Could not save: ${e.message || e}`); return; }
  await check();
}

function proposalBlock(rule, cluster, p) {
  const rows = p.targets.map((t) => h('tr',
    h('td.mono', { style: { fontSize: '11.5px' } }, t.name),
    h('td.muted', { style: { fontSize: '11px' } }, t.detail || ''),
    h('td.num', t.size ? bytes(t.size) : '')));

  return h('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
      h('b', cluster.name),
      h('span.muted', { style: { fontSize: '11px' } }, p.note || p.evidence || ''),
      h('div', { style: { marginLeft: 'auto' } }, runButton(rule, cluster, p))),
    h('div.tbl-wrap', h('table.tbl', h('tbody', ...rows))),
    p.freed ? h('div.muted', { style: { fontSize: '11px', paddingTop: '6px' } },
      `${bytes(p.freed)} would be freed`) : null);
}

/**
 * Hand the work to the action that already exists.
 *
 * Deleting goes through deleteIndices(), which re-runs the snapshot verification itself
 * before it shows the confirmation. So a proposal that has gone stale — a snapshot deleted
 * since the check ran — cannot turn into a wrong delete: the proposal is advisory, the
 * dialog is authoritative. Everything else opens in the REST console prefilled, the same
 * way the Nodes page hands over its suggested requests.
 */
function runButton(rule, cluster, p) {
  const names = p.targets.map((t) => t.name);
  if (rule.action === 'delete') {
    return h('button.btn.sm.danger', {
      title: 'Opens the normal delete confirmation, which verifies the snapshots again',
      onclick: () => deleteIndices(cluster, names, { onChanged: check }),
    }, `Review & delete ${names.length}`);
  }
  if (rule.action === 'close') {
    return h('button.btn.sm', {
      title: 'Opens the normal close confirmation',
      onclick: () => closeIndices(cluster, names, { onChanged: check }),
    }, `Review & close ${names.length}`);
  }
  if (rule.action === 'ilm-retry') {
    return h('button.btn.sm', {
      title: 'Opens the request in the REST console so you can see it before sending',
      onclick: () => navigateTo('console', { method: 'POST', path: `/${names.join(',')}/_ilm/retry` }),
    }, 'Open retry in console');
  }
  if (rule.action === 'reroute-retry') {
    return h('button.btn.sm', {
      title: 'Opens the request in the REST console so you can see it before sending',
      onclick: () => navigateTo('console', { method: 'POST', path: '/_cluster/reroute?retry_failed=true' }),
    }, 'Open reroute in console');
  }
  return null;
}

/**
 * What the rule refused to propose, and why.
 *
 * This is the point of the feature rather than a footnote: an index that is past retention
 * and has no good snapshot is the one you most need to know about, and it is exactly the
 * one automation must not touch.
 */
function blockedBlock(cluster, p) {
  return h('div', { style: { marginTop: '8px' } },
    card(`Held back on ${cluster.name}`, `${p.blocked.length} not safe to propose`,
      table(['Index', 'Why it was not proposed', { label: 'Size', num: true }],
        p.blocked.map((b) => h('tr',
          h('td.mono', { style: { fontSize: '11.5px' } }, b.name),
          h('td', pill(b.reason, b.cls || 'red')),
          h('td.num', b.size ? bytes(b.size) : ''))),
        { emptyText: 'Nothing held back' })));
}
