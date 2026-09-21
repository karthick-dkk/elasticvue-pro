/**
 * The alerts this app raises, as a list rather than as fourteen scattered decisions.
 *
 * Every rule here already existed inside `alerts()`; this is a registry describing them,
 * not a second engine. An admin can switch one off or move its threshold, and that is
 * all — writing genuinely new rules is what the automation rule builder is for, and
 * building a second authoring surface beside it would leave two screens that both make
 * alerts with no way to tell which produced the one in front of you.
 *
 * A rule's `id` is the stable part of the alert key it produces. Keys are per instance —
 * `vm-1:slm-stale:daily` names a cluster and a policy — so the id is the family, and
 * `matches()` decides whether a given key belongs to it. Nothing about identity changes
 * when a rule is disabled or retuned, so nothing an operator acknowledged is orphaned.
 */

/**
 * @typedef {{ id:string, label:string, why:string, level:'critical'|'warning',
 *             thresholds?: Array<{key:string,label:string,unit:string,min:number,max:number}> }} AlertRule
 */

/** @type {AlertRule[]} */
export const ALERT_RULES = [
  { id: 'unreachable', label: 'Cluster unreachable', level: 'critical',
    why: 'The cluster did not answer. Everything else on this page about it is stale.' },
  { id: 'health', label: 'Cluster health red or yellow', level: 'critical',
    why: 'Red means data is missing; yellow means a replica has nowhere to go.' },
  { id: 'disk', label: 'Disk usage above threshold', level: 'critical',
    why: 'Elasticsearch stops allocating shards at the high watermark and stops writing at the flood stage.',
    thresholds: [
      { key: 'diskWarnPercent', label: 'Warn at', unit: '%', min: 50, max: 99 },
      { key: 'diskCritPercent', label: 'Critical at', unit: '%', min: 50, max: 99 },
    ] },
  { id: 'disk-balance', label: 'Disk unevenly spread across nodes', level: 'warning',
    why: 'One node filling while others have room is a placement problem, not a capacity one.' },
  { id: 'disk-unaccounted', label: 'Disk not accounted for by any index', level: 'warning',
    why: 'Data the cluster state does not know about — a dangling index or orphaned shard directories.' },
  { id: 'capacity', label: 'Disk capacity changed', level: 'critical',
    why: 'The size of the storage itself moved. Growing is worth knowing; shrinking is a lost data path.' },
  { id: 'archive-missing', label: 'A day is in the cluster but not in the archive', level: 'critical',
    why: 'Elasticsearch holds that day for the tag and neither S3 copy does. The logs were '
       + 'received and not kept, which is discovered — if at all — when somebody needs them.' },
  { id: 'no-master', label: 'No master node', level: 'critical',
    why: 'The cluster cannot accept changes to its state until one is elected.' },
  { id: 'master-changed', label: 'Master moved', level: 'critical',
    why: 'The previous master left, was cut off or was restarted, and problems in that window start there.' },
  { id: 'ilm', label: 'Indices in an ILM error step', level: 'warning',
    why: 'Lifecycle management has stopped for those indices; they will not roll over or delete.' },
  { id: 'slm-mode', label: 'SLM not running', level: 'warning',
    why: 'Snapshot lifecycle is stopped, so scheduled backups are not being taken.' },
  { id: 'slm-fail', label: 'Last SLM run failed', level: 'critical',
    why: 'The most recent scheduled snapshot did not succeed.' },
  { id: 'slm-stale', label: 'No recent successful snapshot', level: 'warning',
    why: 'Backups have stopped running rather than started failing.',
    thresholds: [{ key: 'snapshotStaleHours', label: 'Stale after', unit: 'h', min: 1, max: 720 }] },
  { id: 'repo', label: 'Snapshot repository problems', level: 'critical',
    why: 'A repository is unreadable, empty, or its recent snapshots failed.' },
  { id: 'volume', label: 'Field volume spike', level: 'warning',
    why: 'One value is producing far more documents than its recent average.' },
];

export function ruleById(id) { return ALERT_RULES.find((r) => r.id === id) || null; }

/**
 * Which rule produced this alert key.
 *
 * Keys are `<clusterId>:<family>` with anything after that naming the instance. Matching
 * on the family segment means an id never has to encode a cluster or a policy name, so
 * the registry stays a list of rules rather than a list of alerts.
 */
export function ruleForKey(key) {
  const family = String(key || '').split(':')[1] || '';
  return ALERT_RULES.find((r) => r.id === family) || null;
}

/** Settings live beside the automation rules, in the same file and under the same gate. */
export function loadAlertSettings(raw) {
  const v = raw && raw.alertRules;
  return v && typeof v === 'object' ? v : {};
}

/** A rule is on unless somebody turned it off. Absent means enabled. */
export function isEnabled(settings, id) {
  const s = settings && settings[id];
  return !(s && s.enabled === false);
}

/**
 * Drop alerts whose rule is switched off.
 *
 * Applied where alerts are consumed rather than where they are raised, so `alerts()`
 * stays one description of what is true and the registry decides what is shown. An alert
 * from a family nobody registered is always kept — an unknown rule is not a disabled one.
 */
export function applySettings(list, settings) {
  return list.filter((a) => {
    const rule = ruleForKey(a.key);
    return rule ? isEnabled(settings, rule.id) : true;
  });
}

/** Thresholds an admin has moved, merged over the shipped defaults. */
export function effectiveDefaults(defaults, settings) {
  const out = { ...defaults };
  for (const rule of ALERT_RULES) {
    const s = settings && settings[rule.id];
    if (!s || !s.thresholds) continue;
    for (const t of rule.thresholds || []) {
      const v = s.thresholds[t.key];
      if (typeof v === 'number' && isFinite(v) && v >= t.min && v <= t.max) out[t.key] = v;
    }
  }
  return out;
}
