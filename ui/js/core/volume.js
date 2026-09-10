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

/** Today is still being written to, so its index is short and would drag a mean down. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

  const live = parseRetention(cluster.liveRetention);
  const snap = parseRetention(cluster.snapshotRetention) || slmRetention(data);

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
export function reportRows(r) {
  return [
    ['Cluster', r.cluster.name],
    ['ES URL', r.cluster.url],
    ['Current Per Day Volume (GB)', gb(r.perDayGB), r.vol.basis],
    ['Daily Volume + 30% Buffer (GB)', gb(r.bufferedGB)],
    ['Current Live Storage (GB)', gb(r.liveTotalGB)],
    ['Live Storage Used (%)', r.livePct === null ? '–' : `${r.livePct.toFixed(1)} %`],
    ['Current Live Storage – Sufficient upto (days)', days(r.liveSufficientDays), 'at the current daily rate'],
    ['Live Retention Policy', r.liveRetention ? r.liveRetention.label : 'not set'],
    ['Required Live storage is available (YES/NO)', yesNo(r.liveRetentionMet),
      r.requiredLiveGB ? `needs ${gb(r.requiredLiveGB)}` : 'set liveRetention on the cluster'],
    ['Required Live Storage for 30 Days (GB)', gb(r.required30GB)],
    ['Required Live Storage for 90 Days (GB)', gb(r.required90GB)],
    ['Live logs available', r.liveLogsFrom ? `${r.liveLogsDays} days` : '–',
      r.liveLogsFrom ? `${r.liveLogsFrom} → ${r.liveLogsTo}` : 'no dated indices'],
    ['Current Backup/Repo Storage (GB)', r.repoGB === null ? 'not measured' : gb(r.repoGB),
      r.repoGB === null ? 'Elasticsearch does not report it — press Measure' : null],
    ['Backup/Repo Storage & Type', r.repoSummary],
    ['Repo/Snapshot Retention policy', r.snapshotRetention ? r.snapshotRetention.label : 'not set'],
    ['Required Backup storage is available (YES/NO)', yesNo(r.snapshotRetentionMet),
      r.repoGB === null ? 'measure the repository first' : null],
    ['Required Backup/Repo Storage for 365 Days (GB)', gb(r.required365GB),
      'upper bound — snapshots are incremental and usually smaller'],
    ['Current Backup Storage – Sufficient upto (days)', days(r.backupSufficientDays),
      r.repoGB === null ? 'measure the repository first' : 'days of data it currently holds'],
    ['Snapshot logs available', r.snapshotsDays ? `${r.snapshotsDays} days` : '–',
      r.snapshotsFrom ? `${r.snapshotsFrom} → ${r.snapshotsTo} · ${r.snapshotCount} snapshots` : 'no snapshots'],
  ];
}
