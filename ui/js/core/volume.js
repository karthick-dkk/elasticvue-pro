/**
 * Capacity arithmetic: how much a cluster ingests per day, and what that means for the
 * disk it has and the retention it promises.
 *
 * The daily figure is the mean of the THREE HEAVIEST of the last seven complete days.
 * A plain seven-day mean under-provisions whenever the window catches a quiet weekend
 * or a collector outage; taking the busiest three sizes against days that actually
 * happen. Today is never counted — its index is still being written to.
 */

const GB = 1024 ** 3;
export const bytesToGB = (b) => (Number(b) || 0) / GB;

/**
 * Today is still being written to, so its index is short and would drag a mean down.
 *
 * UTC, to match the dates in the index names themselves — deriving it from local parts
 * would exclude the wrong day for anyone not on UTC.
 */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * "30d", "90 days", "3M", "6 months", "1y", or a bare number of days.
 * @returns {{days:number, label:string}|null}
 */
export function parseRetention(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) return { days: v, label: `${v} days` };
  const s = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!isFinite(n) || n < 0) return null;
  const unit = m[2].toLowerCase();
  // A capital M means months; lower-case m alone is ambiguous, and months is the only
  // sense that makes sense for a retention policy.
  const isMonth = m[2] === 'M' || unit.startsWith('mo') || unit === 'm' || unit === 'month' || unit === 'months';
  if (!unit || unit.startsWith('d')) return { days: n, label: `${n} days` };
  if (isMonth) return { days: Math.round(n * 30), label: `${n} month${n === 1 ? '' : 's'}` };
  if (unit.startsWith('w')) return { days: Math.round(n * 7), label: `${n} week${n === 1 ? '' : 's'}` };
  if (unit.startsWith('y')) return { days: Math.round(n * 365), label: `${n} year${n === 1 ? '' : 's'}` };
  if (unit.startsWith('h')) return { days: Math.max(0, n / 24), label: `${n} hours` };
  return null;
}

/**
 * Daily ingest, from the date-suffixed indices.
 * @param indices  rows from state.indices (each with `day` and `size`)
 */
export function dailyVolume(indices) {
  const t = today();
  const byDay = new Map();
  for (const r of indices || []) {
    if (!r.day || r.day >= t) continue;             // skip undated and today's partial index
    byDay.set(r.day, (byDay.get(r.day) || 0) + (r.size || 0));
  }
  const days = [...byDay.entries()]
    .map(([day, bytes]) => ({ day, bytes }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));      // newest first

  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

  // The window: the seven most recent complete days that have an index.
  const window7 = days.slice(0, 7);
  // Within that window, the three heaviest days are what the cluster must cope with.
  const top3 = [...window7].sort((a, b) => b.bytes - a.bytes).slice(0, 3);

  const perDay = mean(top3.map((d) => d.bytes));
  const avg7 = mean(window7.map((d) => d.bytes));   // kept for context, not for sizing

  return {
    days,
    daysCovered: days.length,
    oldestDay: days.length ? days[days.length - 1].day : null,
    newestDay: days.length ? days[0].day : null,
    perDay,
    avg7,
    windowDays: window7.length,
    top3Days: top3.map((d) => d.day),
    sampleDays: window7.length,
    basis: !days.length
      ? 'no dated indices'
      : `mean of the ${top3.length} heaviest of the last ${window7.length} day${window7.length === 1 ? '' : 's'}` +
        (top3.length ? ` (${top3.map((d) => d.day).join(', ')})` : ''),
  };
}

const div = (a, b) => (b > 0 ? a / b : null);

/**
 * Everything the volume report shows for one cluster.
 *
 * @param cluster  the config entry (carries liveRetention / snapshotRetention)
 * @param data     state.data entry (disk, repos, snapshots, slm)
 * @param indices  state.indices entry
 * @param repoBytes  measured repository size, when the operator has asked for it
 */
export function volumeReport(cluster, data = {}, indices = [], repoBytes = null) {
  const vol = dailyVolume(indices);
  const perDayGB = bytesToGB(vol.perDay);
  const bufferedGB = perDayGB * 1.3;                 // planning figure: +30% headroom

  const disk = data.disk || {};
  const liveTotalGB = bytesToGB(disk.total);
  const liveUsedGB = bytesToGB(disk.used);
  const liveFreeGB = bytesToGB(disk.avail);
  const livePct = isFinite(disk.percent) ? disk.percent : null;

  // What the cluster actually enforces, read from ILM and SLM.
  const ilm = data.appliedIlm || null;
  const slmApplied = data.appliedSlm || null;
  const ilmRetention = ilm ? parseRetention(ilm.deleteAfter) : null;
  const slmAppliedRetention = slmApplied ? parseRetention(slmApplied.expireAfter) : null;

  // The config states the intent; ILM/SLM state the reality. Prefer the stated policy
  // for sizing, fall back to what the cluster does, and report both so drift is visible.
  const live = parseRetention(cluster.liveRetention) || ilmRetention;
  const snap = parseRetention(cluster.snapshotRetention) || slmAppliedRetention || slmRetention(data);

  // What retention actually costs, at the planning rate.
  const requiredLiveGB = live ? bufferedGB * live.days : null;
  const required30GB = bufferedGB * 30;
  const required90GB = bufferedGB * 90;
  const required365GB = bufferedGB * 365;

  // Snapshot window actually present in the repositories.
  const snapWindow = snapshotWindow(data);

  const repoGB = repoBytes === null || repoBytes === undefined ? null : bytesToGB(repoBytes);
  const repos = data.repos || [];

  return {
    cluster, vol,
    perDayGB, bufferedGB,
    liveTotalGB, liveUsedGB, liveFreeGB, livePct,

    // How long the free space lasts at the current rate — a projection of today's
    // behaviour, so it uses the unbuffered figure.
    liveSufficientDays: div(liveFreeGB, perDayGB),

    liveRetention: live,
    liveRetentionSource: parseRetention(cluster.liveRetention) ? 'config' : ilmRetention ? 'ILM' : null,

    // Applied policies — the metric names the operator asked for.
    appliedIlm: ilm,
    appliedIlmLabel: ilm
      ? `${ilm.name}${ilm.deleteAfter ? ` — delete after ${ilm.deleteAfter}` : ' — no delete phase'}`
      : 'none applied',
    appliedIlmRetention: ilmRetention,
    appliedSlm: slmApplied,
    appliedSlmLabel: slmApplied
      ? `${slmApplied.name}${slmApplied.expireAfter ? ` — expire after ${slmApplied.expireAfter}` : ' — no expiry'}` +
        (slmApplied.maxCount != null ? `, max ${slmApplied.maxCount}` : '')
      : 'none configured',
    appliedSlmRetention: slmAppliedRetention,

    // Does the cluster actually do what the config says it should?
    livePolicyMatchesIlm: parseRetention(cluster.liveRetention) && ilmRetention
      ? parseRetention(cluster.liveRetention).days === ilmRetention.days : null,
    snapshotPolicyMatchesSlm: parseRetention(cluster.snapshotRetention) && slmAppliedRetention
      ? parseRetention(cluster.snapshotRetention).days === slmAppliedRetention.days : null,

    requiredLiveGB,
    liveRetentionMet: live && liveTotalGB > 0 ? liveTotalGB >= requiredLiveGB : null,
    required30GB, required90GB, required365GB,

    liveLogsFrom: vol.oldestDay,
    liveLogsTo: vol.newestDay,
    liveLogsDays: vol.daysCovered,

    repoGB,
    repoSummary: repos.length
      ? repos.map((r) => `${r.name} (${r.type}${r.location ? ` @ ${r.location}` : ''})`).join('; ')
      : 'none registered',
    snapshotRetention: snap,
    snapshotRetentionMet: snap && repoGB !== null ? repoGB >= bufferedGB * snap.days : null,
    // How many days of data the repository currently holds, at the same daily rate.
    backupSufficientDays: repoGB === null ? null : div(repoGB, perDayGB),
    snapshotsFrom: snapWindow.from,
    snapshotsTo: snapWindow.to,
    snapshotsDays: snapWindow.days,
    snapshotCount: snapWindow.count,
  };
}

/** SLM's own `expire_after` is a retention policy too, when the config does not name one. */
function slmRetention(data) {
  for (const p of data.slm || []) {
    const exp = p.policy && p.policy.retention && p.policy.retention.expire_after;
    const parsed = parseRetention(exp);
    if (parsed) return { ...parsed, label: `${parsed.label} (from SLM)` };
  }
  return null;
}

function snapshotWindow(data) {
  let from = null, to = null, count = 0;
  for (const list of Object.values(data.snapshots || {})) {
    for (const s of list || []) {
      if (!s.start) continue;
      count++;
      if (from === null || s.start < from) from = s.start;
      if (to === null || s.start > to) to = s.start;
    }
  }
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
  return {
    from: day(from), to: day(to), count,
    days: from && to ? Math.max(1, Math.round((to - from) / 86400000) + 1) : 0,
  };
}

/* --------------------------------- presentation -------------------------------- */

export const gb = (v) => (v === null || v === undefined || !isFinite(v) ? '–' : `${v.toFixed(1)} GB`);
export const days = (v) => (v === null || v === undefined || !isFinite(v) ? '–' : `${Math.floor(v)} days`);
export const yesNo = (v) => (v === null || v === undefined ? 'unknown' : v ? 'YES' : 'NO');

/** The report as ordered label/value pairs — the shape the table and the CSV share. */
/**
 * The same report as label / value / explanation, for the per-cluster card.
 *
 * Derived from SHEET_COLUMNS rather than written out again: the card and the export used
 * to be two lists that had drifted apart, so the screen and the file named the same
 * numbers differently.
 */
export function reportRows(r) {
  return SHEET_COLUMNS.map((c) => [
    c.unit ? `${c.label} (${c.unit})` : c.label,
    sheetCell(c, r),
    c.note ? c.note(r) : null,
  ]);
}

/**
 * The spreadsheet layout: one column per parameter, grouped by what it is about.
 *
 * `get` returns a plain value; `kind` tells the view how to align and colour it, and
 * the CSV uses the same definitions so the screen and the file cannot diverge.
 */
/**
 * The report, defined once.
 *
 * The grid, the CSV and the per-cluster card are all rendered from this list, so a column
 * cannot be renamed in one and not the others. `note` is the explanation shown beside the
 * value on the card and as hover text in the grid; it never travels in the CSV, where a
 * sentence per cell would drown the numbers.
 */
export const SHEET_COLUMNS = [
  { group: 'Cluster', label: 'Cluster name', kind: 'text', get: (r) => r.cluster.name },
  { group: 'Cluster', label: 'Elasticsearch URL', kind: 'text', get: (r) => r.cluster.url },
  { group: 'Cluster', label: 'Tags', kind: 'text', get: (r) => (r.cluster.tags || []).join(', ') },

  { group: 'How much comes in', label: 'Log volume per day', unit: 'GB', kind: 'num',
    get: (r) => round1(r.perDayGB), note: (r) => r.vol.basis },
  { group: 'How much comes in', label: 'Per day + 30% buffer', unit: 'GB', kind: 'num',
    get: (r) => round1(r.bufferedGB), note: () => 'the daily figure plus 30% headroom — what sizing is done against' },

  { group: 'Disk on the cluster', label: 'Disk total', unit: 'GB', kind: 'num', get: (r) => round1(r.liveTotalGB) },
  { group: 'Disk on the cluster', label: 'Disk used', unit: '%', kind: 'num', get: (r) => (r.livePct === null ? null : round1(r.livePct)) },
  { group: 'Disk on the cluster', label: 'Disk free', unit: 'GB', kind: 'num', get: (r) => round1(r.liveFreeGB) },
  { group: 'Disk on the cluster', label: 'Free disk lasts', unit: 'days', kind: 'num',
    get: (r) => floorOrNull(r.liveSufficientDays), note: () => 'at the current daily rate' },

  { group: 'Logs kept on the cluster', label: 'Retention policy', kind: 'text',
    get: (r) => (r.liveRetention ? r.liveRetention.label : 'not set'),
    note: (r) => (r.liveRetentionSource ? `stated by ${r.liveRetentionSource}` : 'set liveRetention on the cluster') },
  { group: 'Logs kept on the cluster', label: 'ILM policy in force', kind: 'text', get: (r) => r.appliedIlmLabel,
    note: (r) => (r.appliedIlm && r.appliedIlm.indices ? `on ${r.appliedIlm.indices} matching index/indices` : null) },
  { group: 'Logs kept on the cluster', label: 'Policy matches ILM?', kind: 'bool', get: (r) => r.livePolicyMatchesIlm,
    note: (r) => (r.livePolicyMatchesIlm === false
      ? `config says ${r.liveRetention ? r.liveRetention.label : '?'}, ILM deletes after ${r.appliedIlm.deleteAfter}` : null) },
  { group: 'Logs kept on the cluster', label: 'Disk needed for the policy', unit: 'GB', kind: 'num', get: (r) => round1(r.requiredLiveGB) },
  { group: 'Logs kept on the cluster', label: 'Enough disk for the policy?', kind: 'bool', get: (r) => r.liveRetentionMet,
    note: (r) => (r.requiredLiveGB ? `needs ${gb(r.requiredLiveGB)}` : 'set liveRetention on the cluster') },
  { group: 'Logs kept on the cluster', label: 'Disk needed for 30 days', unit: 'GB', kind: 'num', get: (r) => round1(r.required30GB) },
  { group: 'Logs kept on the cluster', label: 'Disk needed for 90 days', unit: 'GB', kind: 'num', get: (r) => round1(r.required90GB) },
  { group: 'Logs kept on the cluster', label: 'Days of logs held now', unit: 'days', kind: 'num',
    get: (r) => r.vol.daysCovered || null,
    note: (r) => (r.liveLogsFrom ? `${r.liveLogsFrom} → ${r.liveLogsTo}` : 'no dated indices') },
  { group: 'Logs kept on the cluster', label: 'Oldest log day', kind: 'text', get: (r) => r.liveLogsFrom },
  { group: 'Logs kept on the cluster', label: 'Newest log day', kind: 'text', get: (r) => r.liveLogsTo },

  { group: 'Backups (snapshots)', label: 'Backup size now', unit: 'GB', kind: 'num', get: (r) => round1(r.repoGB),
    note: (r) => (r.repoGB === null ? 'Elasticsearch does not report it — press Measure' : null) },
  { group: 'Backups (snapshots)', label: 'Where backups go', kind: 'text', get: (r) => r.repoSummary },
  { group: 'Backups (snapshots)', label: 'Backup retention policy', kind: 'text',
    get: (r) => (r.snapshotRetention ? r.snapshotRetention.label : 'not set') },
  { group: 'Backups (snapshots)', label: 'SLM policy in force', kind: 'text', get: (r) => r.appliedSlmLabel,
    note: (r) => (r.appliedSlm && r.appliedSlm.schedule ? `schedule ${r.appliedSlm.schedule}` : null) },
  { group: 'Backups (snapshots)', label: 'Policy matches SLM?', kind: 'bool', get: (r) => r.snapshotPolicyMatchesSlm,
    note: (r) => (r.snapshotPolicyMatchesSlm === false
      ? `config says ${r.snapshotRetention ? r.snapshotRetention.label : '?'}, SLM expires after ${r.appliedSlm.expireAfter}` : null) },
  { group: 'Backups (snapshots)', label: 'Enough backup space?', kind: 'bool', get: (r) => r.snapshotRetentionMet,
    note: (r) => (r.repoGB === null ? 'measure the repository first' : null) },
  { group: 'Backups (snapshots)', label: 'Backup space for 365 days', unit: 'GB', kind: 'num', get: (r) => round1(r.required365GB),
    note: () => 'upper bound — snapshots are incremental and usually smaller' },
  { group: 'Backups (snapshots)', label: 'Days the backup covers', unit: 'days', kind: 'num',
    get: (r) => floorOrNull(r.backupSufficientDays),
    note: (r) => (r.repoGB === null ? 'measure the repository first' : 'days of data it currently holds') },
  { group: 'Backups (snapshots)', label: 'Days of snapshots held', unit: 'days', kind: 'num', get: (r) => r.snapshotsDays || null,
    note: (r) => (r.snapshotsFrom ? `${r.snapshotsFrom} → ${r.snapshotsTo} · ${r.snapshotCount} snapshots` : 'no snapshots') },
  { group: 'Backups (snapshots)', label: 'Oldest snapshot day', kind: 'text', get: (r) => r.snapshotsFrom },
  { group: 'Backups (snapshots)', label: 'Newest snapshot day', kind: 'text', get: (r) => r.snapshotsTo },
];

function round1(v) { return v === null || v === undefined || !isFinite(v) ? null : Math.round(v * 10) / 10; }
function floorOrNull(v) { return v === null || v === undefined || !isFinite(v) ? null : Math.floor(v); }

/** How a cell prints — one place, so the grid and the CSV agree. */
export function sheetCell(col, r) {
  const v = col.get(r);
  if (col.kind === 'bool') return v === null || v === undefined ? 'unknown' : v ? 'YES' : 'NO';
  if (v === null || v === undefined || v === '') return '–';
  return String(v);
}
