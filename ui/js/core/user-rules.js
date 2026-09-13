/**
 * Automations you write yourself.
 *
 * Five parts, in the order you think about them:
 *
 *   Condition Match   which indices (or which clusters) this is about
 *   Expected output   what matches right now — shown live, before you save
 *   Trigger Rule      when that counts as worth acting on
 *   Expected output   what the action would do to those matches
 *   Notify            how you get told
 *
 * Two previews rather than one, because "did I select the right indices" and "is the
 * consequence what I meant" are different mistakes and each deserves its own look.
 *
 * A user rule returns the same proposal shape as a built-in rule, so the Automation page
 * renders both with one code path, and everything a built-in rule refuses to do — never the
 * newest index, never a closed one, nothing whose snapshot coverage could not be proved — a
 * user rule refuses too. Writing your own rule cannot buy you a sharper knife.
 */

import { state } from './state.js';
import { parseRetention, parseSize } from './volume.js';
import { verifyIndicesInSnapshots, coverageLabel } from './snapshot-verify.js';

/* ------------------------------- the vocabulary -------------------------------- */

/** Fields a condition can test, with the operators that make sense for each. */
export const FIELDS = {
  name:     { label: 'Index name',        ops: ['contains', 'notContains', 'startsWith', 'endsWith'], value: 'text' },
  source:   { label: 'Source',            ops: ['is', 'isNot'],                 value: 'text' },
  day:      { label: 'Date in the name',  ops: ['olderThan', 'newerThan'],      value: 'duration' },
  size:     { label: 'Store size',        ops: ['greaterThan', 'lessThan'],     value: 'size' },
  docs:     { label: 'Document count',    ops: ['greaterThan', 'lessThan'],     value: 'number' },
  status:   { label: 'Open or closed',    ops: ['is'],                          value: 'choice', choices: ['open', 'close'] },
  health:   { label: 'Index health',      ops: ['is', 'isNot'],                 value: 'choice', choices: ['green', 'yellow', 'red'] },
  backedUp: { label: 'In a good snapshot', ops: ['is'],                         value: 'choice', choices: ['yes', 'no'] },
};

export const OP_LABEL = {
  is: 'is', isNot: 'is not', contains: 'contains', notContains: 'does not contain',
  startsWith: 'starts with', endsWith: 'ends with',
  olderThan: 'is older than', newerThan: 'is newer than',
  greaterThan: 'is more than', lessThan: 'is less than',
};

export const ACTIONS = {
  notify:         { label: 'Notify only',            verb: 'notify about',  destructive: false },
  'propose-close':  { label: 'Propose closing them',  verb: 'close',         destructive: true },
  'propose-delete': { label: 'Propose deleting them', verb: 'delete',        destructive: true },
};

export const TRIGGERS = {
  any:     { label: 'as soon as anything matches' },
  atLeast: { label: 'only when this many match' },
};

/** A field that needs a snapshot listing costs network, so only fetch when it is used. */
const needsCoverage = (rule) => (rule.match.conditions || []).some((c) => c.field === 'backedUp');

export function blankRule() {
  return {
    id: `r${Date.now().toString(36)}`,
    name: '',
    enabled: true,
    clusters: ['*'],
    match: { conditions: [{ field: 'day', op: 'olderThan', value: '30d' }], all: true },
    trigger: { when: 'any', count: 5 },
    action: 'notify',
    notify: { alert: true, level: 'warning', webhook: '' },
  };
}

/* --------------------------------- validation ---------------------------------- */

export function validateRule(rule) {
  const errs = [];
  if (!rule.name || !rule.name.trim()) errs.push('Give the automation a name.');
  if (!(rule.match.conditions || []).length) errs.push('Add at least one condition.');
  for (const c of rule.match.conditions || []) {
    const f = FIELDS[c.field];
    if (!f) { errs.push(`Unknown field "${c.field}".`); continue; }
    if (!f.ops.includes(c.op)) errs.push(`"${f.label}" cannot use "${c.op}".`);
    if (c.value === '' || c.value === undefined || c.value === null) {
      errs.push(`"${f.label}" needs a value.`);
    } else if (f.value === 'duration' && !parseRetention(c.value)) {
      errs.push(`"${c.value}" is not a duration — try 30d, 6M or 1y.`);
    } else if (f.value === 'size' && !parseSize(c.value)) {
      errs.push(`"${c.value}" is not a size — try 5GB or 500MB.`);
    } else if (f.value === 'number' && !isFinite(Number(c.value))) {
      errs.push(`"${f.label}" needs a number.`);
    }
  }
  if (rule.trigger.when === 'atLeast' && !(Number(rule.trigger.count) > 0)) {
    errs.push('"only when this many match" needs a count above zero.');
  }
  if (!ACTIONS[rule.action]) errs.push('Pick an action.');
  if (!rule.notify.alert && !rule.notify.webhook) {
    errs.push('Choose at least one way to be notified, or the rule has no effect.');
  }
  if (rule.notify.webhook && !/^https?:\/\/\S+$/i.test(rule.notify.webhook)) {
    errs.push('The webhook must be an http:// or https:// URL.');
  }
  return errs;
}

/** Plain-English restatement, so you can read back what you built. */
export function describeRule(rule) {
  const conds = (rule.match.conditions || []).map((c) => {
    const f = FIELDS[c.field] || { label: c.field };
    return `${f.label.toLowerCase()} ${OP_LABEL[c.op] || c.op} ${c.value}`;
  });
  const join = rule.match.all ? ' and ' : ' or ';
  const when = rule.trigger.when === 'atLeast'
    ? `when at least ${rule.trigger.count} match`
    : 'as soon as anything matches';
  const how = [rule.notify.alert ? `raise a ${rule.notify.level} alert` : null,
               rule.notify.webhook ? 'post to the webhook' : null].filter(Boolean).join(' and ');
  return `For indices where ${conds.join(join)}, ${when}, ${(ACTIONS[rule.action] || {}).label.toLowerCase()} and ${how}.`;
}

/* --------------------------------- matching ------------------------------------ */

const ymdDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function testCondition(c, row, coverage) {
  const f = FIELDS[c.field];
  if (!f) return false;
  const v = String(c.value ?? '');
  switch (c.field) {
    case 'name': {
      const n = row.index || '';
      if (c.op === 'contains') return n.includes(v);
      if (c.op === 'notContains') return !n.includes(v);
      if (c.op === 'startsWith') return n.startsWith(v);
      if (c.op === 'endsWith') return n.endsWith(v);
      return false;
    }
    case 'source':
      return c.op === 'is' ? row.source === v : row.source !== v;
    case 'day': {
      if (!row.day) return false;                  // no date parsed: never matches a date test
      const ret = parseRetention(v);
      if (!ret) return false;
      const edge = ymdDaysAgo(ret.days);
      return c.op === 'olderThan' ? row.day < edge : row.day > edge;
    }
    case 'size': {
      const s = parseSize(v);
      if (!s) return false;
      const bytes = s.gb * 1024 ** 3;
      return c.op === 'greaterThan' ? (row.size || 0) > bytes : (row.size || 0) < bytes;
    }
    case 'docs': {
      const n = Number(v);
      return c.op === 'greaterThan' ? (row.docs || 0) > n : (row.docs || 0) < n;
    }
    case 'status':
      return String(row.status || '') === v;
    case 'health':
      return c.op === 'is' ? row.health === v : row.health !== v;
    case 'backedUp': {
      const cov = coverage && coverage.get(row.index);
      if (!cov) return false;                      // unknown is never a match
      return v === 'yes' ? cov.covered : !cov.covered;
    }
    default:
      return false;
  }
}

/**
 * Condition Match -> the first Expected output.
 *
 * @returns {Promise<{matched:Array, total:number, coverage:Map|null, unreadable:string[]}>}
 */
export async function matchIndices(rule, cluster, indices, { coverage = null } = {}) {
  let cov = coverage;
  let unreadable = [];
  if (!cov && needsCoverage(rule) && indices.length) {
    cov = await verifyIndicesInSnapshots(cluster, indices.map((i) => i.index));
    unreadable = [...new Set([...cov.values()].flatMap((v) => v.unverified || []))];
  }
  const conds = rule.match.conditions || [];
  const test = (row) => (rule.match.all
    ? conds.every((c) => testCondition(c, row, cov))
    : conds.some((c) => testCondition(c, row, cov)));
  return { matched: indices.filter(test), total: indices.length, coverage: cov, unreadable };
}

/* -------------------------------- evaluation ----------------------------------- */

/**
 * Trigger Rule + the second Expected output, as a built-in-shaped proposal.
 *
 * The refusals are not optional and are not the user's to relax. A destructive action
 * never reaches a target that is the newest dated index, already closed, or whose snapshot
 * coverage could not be proved — whatever the conditions say.
 */
export async function evaluateUserRule(rule, { cluster, indices }) {
  if (!rule.enabled) return null;
  if (!(rule.clusters || ['*']).includes('*') && !rule.clusters.includes(cluster.id)) return null;
  const errs = validateRule(rule);
  if (errs.length) return { skipped: `rule is incomplete: ${errs[0]}` };
  if (!indices.length) return { skipped: 'no index list loaded for this cluster yet' };

  const { matched, unreadable } = await matchIndices(rule, cluster, indices);
  const spec = ACTIONS[rule.action];

  if (spec.destructive && unreadable.length) {
    return {
      skipped: `a repository could not be read (${unreadable.join('; ')}), so coverage is unknown `
             + 'and nothing destructive is proposed',
    };
  }

  const need = rule.trigger.when === 'atLeast' ? Number(rule.trigger.count) : 1;
  if (matched.length < need) {
    return matched.length
      ? { skipped: `${matched.length} matched, below the trigger of ${need}` }
      : null;
  }

  // Safety rails, applied after matching and regardless of what the conditions asked for.
  const targets = [];
  const blocked = [];
  if (spec.destructive) {
    const dated = indices.filter((i) => i.day);
    const newest = dated.length ? dated.reduce((a, b) => (a.day > b.day ? a : b)).day : null;
    let cov = null;
    if (rule.action === 'propose-delete') {
      cov = await verifyIndicesInSnapshots(cluster, matched.map((i) => i.index));
    }
    for (const i of matched) {
      if (i.day && i.day === newest) {
        blocked.push({ name: i.index, reason: 'newest dated index — still being written to', cls: 'yellow', size: i.size });
      } else if (i.status === 'close' && rule.action === 'propose-close') {
        blocked.push({ name: i.index, reason: 'already closed', cls: 'grey', size: i.size });
      } else if (rule.action === 'propose-delete') {
        const v = cov.get(i.index);
        // A closed index can be deleted, and if the rule asked for it and a snapshot proves
        // it, that is the user's call. Say "closed" on the row so the decision is made with
        // that in view rather than silently.
        const closed = i.status === 'close' ? 'closed · ' : '';
        if (v && v.covered) targets.push({ name: i.index, size: i.size, detail: closed + coverageLabel(v).text, day: i.day });
        else blocked.push({ name: i.index, reason: coverageLabel(v).text, cls: coverageLabel(v).cls, size: i.size, day: i.day });
      } else {
        targets.push({ name: i.index, size: i.size, detail: i.day || '', day: i.day });
      }
    }
  } else {
    for (const i of matched) targets.push({ name: i.index, size: i.size, detail: i.day || '', day: i.day });
  }

  if (!targets.length && !blocked.length) return null;
  return {
    targets,
    blocked,
    note: describeRule(rule),
    evidence: `${matched.length} of ${indices.length} indices matched`,
    freed: spec.destructive ? targets.reduce((s, t) => s + (t.size || 0), 0) : 0,
  };
}

/* ------------------------------- notification ---------------------------------- */

/**
 * Why a webhook cannot fire yet.
 *
 * The desktop WebView is locked to `connect-src ipc: http://ipc.localhost`, so the UI
 * cannot POST anywhere itself — by design, and that design is worth keeping. Delivery has
 * to go through the Rust core, which already proxies every outbound request. Until it
 * carries a message for this, a configured webhook is stored and not sent, and the UI says
 * so rather than pretending.
 */
export function webhookSupport() {
  return {
    ok: false,
    reason: 'The UI cannot make outbound requests — its content policy allows only the local '
          + 'IPC channel. Webhook delivery needs a message in the Rust core, which also keeps '
          + 'the URL out of the browser. Configured webhooks are saved but not yet sent.',
  };
}

/* -------------------------------- persistence ---------------------------------- */

/**
 * Rules live in the config file, next to liveRetention and backupCapacity, because they are
 * operator policy of exactly that kind: reviewable, portable with the exe, and the same for
 * everyone on a hosted deployment.
 *
 * Note the hosted stack mounts ./config read-only, so a save from a browser there will fail
 * with a permission error. That is the deployment's choice to change, and the UI reports the
 * failure rather than silently keeping the rule in memory.
 */
export function loadRules() {
  const raw = state.config && state.config.raw;
  const list = (raw && raw.automations) || [];
  return Array.isArray(list) ? list : [];
}

/** Mutates the in-memory raw config. The caller saves it, so one write covers many edits. */
export function putRule(rule) {
  const raw = state.config && state.config.raw;
  if (!raw) throw new Error('no config loaded');
  if (!Array.isArray(raw.automations)) raw.automations = [];
  const i = raw.automations.findIndex((r) => r.id === rule.id);
  if (i >= 0) raw.automations[i] = rule; else raw.automations.push(rule);
  return raw.automations;
}

export function removeRule(id) {
  const raw = state.config && state.config.raw;
  if (!raw || !Array.isArray(raw.automations)) return [];
  raw.automations = raw.automations.filter((r) => r.id !== id);
  return raw.automations;
}
