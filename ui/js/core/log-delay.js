/**
 * Log delay — can this cluster be analysed at all?
 *
 * Delay is arrival time minus event time, per device. That needs three things present in
 * the indices: a field to group devices by, at least one field carrying when the event
 * actually happened, and the arrival timestamp the page already uses. A cluster missing
 * any of them cannot be analysed.
 *
 * This module is only the preflight. It exists before any aggregation because of how
 * Elasticsearch answers a question about a field it does not have: a terms aggregation on
 * an unmapped field returns zero buckets, with no error and no warning. Run the analysis
 * without asking first and a cluster whose parser changed renders an empty table that
 * reads as "no devices are delayed" — good news, and false. Asking costs one cheap call
 * and turns that into a named refusal.
 *
 *      preflight(cluster)
 *        │
 *        ├── _field_caps on the names the AGGREGATION will use
 *        │
 *        ├── device field present?        no ──┐
 *        ├── any event-time field present? no ──┼──► { ok: false, missing: [...] }
 *        └── both present ──────────────────────┴──► { ok: true, resolved: {...} }
 */

/**
 * The name an aggregation actually runs against.
 *
 * Elasticsearch cannot aggregate a `text` field; the convention is a `.keyword` sub-field
 * beside it. The Python this is ported from appends `.keyword` unless the name already
 * ends in it, or the field is IP-like, or it is `ClientID` — three exceptions that exist
 * because those are mapped as keyword or ip directly.
 *
 * Checking the base name instead of this one is the mistake that makes a preflight pass
 * and the query that follows return nothing.
 */
const IP_LIKE = /(^|[._])(ip|addr|address)([._]|$)/i;
const ALREADY_KEYWORD = /\.keyword$/;
const LITERAL = new Set(['ClientID']);

export function aggregatableName(field) {
  const f = String(field || '');
  if (!f) return '';
  if (ALREADY_KEYWORD.test(f)) return f;
  if (LITERAL.has(f)) return f;
  if (IP_LIKE.test(f)) return f;
  return `${f}.keyword`;
}

/** The delayFields block for a cluster, with the shape guaranteed. */
export function resolveFields(cluster) {
  const d = (cluster && cluster.delayFields) || {};
  return {
    device: d.device || 'src_hostname',
    eventTime: Array.isArray(d.eventTime) && d.eventTime.length
      ? d.eventTime : ['ingested_time', 'event_created', 'event.created'],
    metadata: Array.isArray(d.metadata) ? d.metadata : [],
    arrival: (cluster && cluster.timeField) || '@timestamp',
  };
}

/**
 * Every field name to ask about, in the form it will be used.
 *
 * The device field is asked about by its aggregatable name because that is what the terms
 * aggregation will use. Event-time and arrival are date fields read from `_source`, never
 * aggregated as keywords, so they are asked about as they are.
 */
export function fieldsToProbe(fields) {
  return [
    aggregatableName(fields.device),
    ...fields.eventTime,
    fields.arrival,
    ...fields.metadata.map(aggregatableName),
  ];
}

/**
 * Read a _field_caps response into the set of names that exist.
 *
 * A name is present when the response lists it at all; `_field_caps` omits what it cannot
 * find rather than returning it empty, so absence from the map is the answer.
 */
export function presentFields(caps) {
  const f = (caps && caps.fields) || {};
  return new Set(Object.keys(f));
}

/**
 * Decide whether the analysis can run, from a _field_caps response.
 *
 * Separated from the call so it can be exercised without a cluster: this is the part with
 * the rules in it, and the part worth being sure about.
 */
export function decide(fields, caps) {
  const have = presentFields(caps);
  const deviceName = aggregatableName(fields.device);

  const deviceOk = have.has(deviceName);
  const eventOk = fields.eventTime.filter((f) => have.has(f));
  const arrivalOk = have.has(fields.arrival);

  const missing = [];
  if (!deviceOk) missing.push(deviceName);
  if (!arrivalOk) missing.push(fields.arrival);
  // Only one event-time candidate has to exist. Naming all of them when none does is
  // more useful than naming the first — it says what the parser could be producing.
  if (!eventOk.length) missing.push(...fields.eventTime);

  return {
    ok: deviceOk && arrivalOk && eventOk.length > 0,
    missing,
    resolved: {
      device: deviceOk ? deviceName : null,
      eventTime: eventOk[0] || null,
      arrival: arrivalOk ? fields.arrival : null,
      metadata: fields.metadata.map(aggregatableName).filter((m) => have.has(m)),
    },
    // What was asked for but is not there, so the page can say which context columns
    // will be blank rather than pretending the data has them.
    metadataMissing: fields.metadata.map(aggregatableName).filter((m) => !have.has(m)),
  };
}

/**
 * Ask one cluster whether it can be analysed.
 *
 * Returns the same shape whether the answer is yes, no, or the question could not be
 * asked — a cluster that refuses the call is "unknown", never "no fields".
 */
export async function preflight(client, cluster) {
  const fields = resolveFields(cluster);
  if (!client) return { ok: false, unknown: true, error: 'not connected', fields, missing: [], resolved: {} };
  try {
    const caps = await client.fieldCaps(cluster.logIndexPattern || 'logstash-*', fieldsToProbe(fields));
    return { ...decide(fields, caps), unknown: false, error: null, fields };
  } catch (e) {
    const es = e.res && e.res.json && e.res.json.error;
    return {
      ok: false, unknown: true, missing: [], resolved: {}, fields,
      error: (es && (es.reason || es.type)) || e.message || String(e),
    };
  }
}

/* ------------------------------- classification ------------------------------- */

/** Defaults from the tool this is ported from; overridable per cluster. */
export const DEFAULT_THRESHOLDS = {
  delayMinutes: 30,
  criticalMinutes: 60,
  tzToleranceMinutes: 3,
  veryLongMinutes: 24 * 60,
};

export function thresholds(cluster) {
  const t = (cluster && cluster.delayThresholds) || {};
  return {
    delayMinutes: num(t.delayMinutes, DEFAULT_THRESHOLDS.delayMinutes),
    criticalMinutes: num(t.criticalMinutes, DEFAULT_THRESHOLDS.criticalMinutes),
    tzToleranceMinutes: num(t.tzToleranceMinutes, DEFAULT_THRESHOLDS.tzToleranceMinutes),
    veryLongMinutes: num(t.veryLongMinutes, DEFAULT_THRESHOLDS.veryLongMinutes),
  };
}
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * What a delay means.
 *
 * Order matters. A negative delay is not a small delay — it is a device whose clock is
 * ahead of real time, which is a different fault with a different fix, so it is tested
 * before the "is it big" questions. A delay that cannot be computed at all is ERROR, and
 * a device that sent nothing is NO_DATA; neither is zero.
 */
export const STATUS = {
  OK: { label: 'ok', cls: 'green' },
  DELAYED: { label: 'delayed', cls: 'yellow' },
  CRITICAL: { label: 'critical', cls: 'red' },
  CLOCK_AHEAD: { label: 'clock ahead', cls: 'orange' },
  ERROR: { label: 'error', cls: 'grey' },
  NO_DATA: { label: 'no data', cls: 'grey' },
};

export function classify(delayMinutes, t = DEFAULT_THRESHOLDS) {
  if (delayMinutes === null || delayMinutes === undefined || !isFinite(delayMinutes)) return 'ERROR';
  if (delayMinutes <= -t.delayMinutes) return 'CLOCK_AHEAD';
  if (delayMinutes >= t.criticalMinutes) return 'CRITICAL';
  if (delayMinutes >= t.delayMinutes) return 'DELAYED';
  return 'OK';
}

/** Why it is in that state, in the words an operator would use. */
export function reasonFor(status, trend = 'NO_TREND') {
  const base = {
    OK: 'Healthy — within threshold',
    DELAYED: 'Pipeline lag: forwarder batching or network latency',
    CRITICAL: 'Severe lag: forwarder backlog, pipeline backpressure, or device clock behind',
    CLOCK_AHEAD: 'Device clock is ahead of real time (NTP)',
    ERROR: 'Timestamp missing or unparseable (parser)',
    NO_DATA: 'No logs received in the window',
  }[status] || status;
  if (trend === 'WORSENING' && (status === 'DELAYED' || status === 'CRITICAL')) {
    return `${base} — the backlog is growing`;
  }
  if (trend === 'IMPROVING' && (status === 'DELAYED' || status === 'CRITICAL')) {
    return `${base} — the queue is draining`;
  }
  return base;
}

/** What to do about it. */
export function fixFor(status) {
  return {
    OK: 'None',
    DELAYED: 'Reduce the forwarder flush interval; check the site link; tune Logstash batch and workers',
    CRITICAL: 'Check the forwarder queue and service; Logstash backpressure; Elasticsearch write rejections; NTP on the device',
    CLOCK_AHEAD: 'Fix NTP and timezone on the source device, and the parser date filter',
    ERROR: 'Fix the parser, or point eventTime at the field your pipeline actually writes',
    NO_DATA: 'Verify the device and its forwarder are alive and shipping',
  }[status] || '';
}

/**
 * Which way it is moving, from a series of delays oldest-first.
 *
 * Compares the first half against the second rather than first-against-last, because one
 * outlying sample at either end should not decide the answer. Fewer than four samples is
 * NO_TREND: two points make a line through noise, not a trend.
 */
export function trend(series, minChangePct = 20) {
  const xs = (series || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (xs.length < 4) return 'NO_TREND';
  const mid = Math.floor(xs.length / 2);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const first = mean(xs.slice(0, mid));
  const second = mean(xs.slice(mid));
  if (Math.abs(first) < 1 && Math.abs(second) < 1) return 'NO_TREND';
  const base = Math.max(Math.abs(first), 1);
  const changePct = ((second - first) / base) * 100;
  if (changePct >= minChangePct) return 'WORSENING';
  if (changePct <= -minChangePct) return 'IMPROVING';
  return 'NO_TREND';
}

/**
 * What the shape of the delay suggests, beyond how big it is.
 *
 * The one worth having: a delay within a few minutes of a whole number of hours is almost
 * never a queue. Queues drift; timezone offsets do not. A device an exact hour behind has
 * its clock or its parser in the wrong zone, and telling someone to tune their forwarder
 * would send them to fix the wrong thing.
 */
export function analysePattern(delayMinutes, t = DEFAULT_THRESHOLDS) {
  if (delayMinutes === null || delayMinutes === undefined || !isFinite(delayMinutes)) {
    return { pattern: '-', note: '' };
  }
  const abs = Math.abs(delayMinutes);
  const hours = abs / 60;
  const nearestHour = Math.round(hours);
  const offBy = Math.abs(hours - nearestHour) * 60;

  if (nearestHour >= 1 && offBy <= t.tzToleranceMinutes) {
    const dir = delayMinutes > 0 ? 'behind' : 'ahead';
    return {
      pattern: 'timezone',
      note: `within ${Math.round(offBy)} min of exactly ${nearestHour}h ${dir} — a timezone or NTP offset, not a queue`,
    };
  }
  if (abs >= t.veryLongMinutes) {
    return { pattern: 'very-long', note: `more than ${Math.round(t.veryLongMinutes / 60)}h — likely a replay or a stalled forwarder` };
  }
  return { pattern: '-', note: '' };
}

/* --------------------------------- the record --------------------------------- */

/**
 * One device's delay, built from a terms bucket and its top_hits document.
 *
 * Every figure the rest of the app shows comes from here, so the arithmetic exists once.
 * A document missing either timestamp yields a null delay and ERROR — never a zero, which
 * would sort as healthy and read as measured.
 */
export function recordFrom(bucket, resolved, t = DEFAULT_THRESHOLDS) {
  const hit = ((((bucket || {}).latest || {}).hits || {}).hits || [])[0];
  const src = (hit && hit._source) || {};
  const arrival = Date.parse(dotted(src, resolved.arrival));
  const event = Date.parse(dotted(src, resolved.eventTime));

  const ok = isFinite(arrival) && isFinite(event);
  const delayMinutes = ok ? (arrival - event) / 60000 : null;
  const status = classify(delayMinutes, t);
  const { pattern, note } = analysePattern(delayMinutes, t);

  return {
    device: bucket.key,
    docs: bucket.doc_count || 0,
    arrival: isFinite(arrival) ? arrival : null,
    event: isFinite(event) ? event : null,
    delayMinutes,
    status,
    pattern,
    patternNote: note,
    trend: 'NO_TREND',
    reason: reasonFor(status),
    fix: fixFor(status),
    meta: Object.fromEntries((resolved.metadata || []).map((m) => {
      const plain = String(m).replace(/\.keyword$/, '');
      return [plain, dotted(src, plain) ?? dotted(src, m) ?? ''];
    })),
  };
}

const dotted = (o, path) => String(path || '').split('.').reduce((v, k) => (v == null ? v : v[k]), o);

/**
 * The search the analysis runs.
 *
 * One terms aggregation over the device field with a top_hits picking the newest document
 * per device. `size` bounds the device count; a fleet with more devices than that reports
 * the shortfall rather than silently showing a subset.
 */
export function buildSearchBody(resolved, { from, to, size = 500 } = {}) {
  return {
    size: 0,
    query: { bool: { filter: [{ range: { [resolved.arrival]: { gte: from, lte: to, format: 'strict_date_optional_time' } } }] } },
    aggs: {
      devices: {
        terms: { field: resolved.device, size, order: { _count: 'desc' } },
        aggs: {
          latest: {
            top_hits: {
              size: 1,
              sort: [{ [resolved.arrival]: { order: 'desc' } }],
              _source: [resolved.arrival, resolved.eventTime,
                        ...(resolved.metadata || []).map((m) => String(m).replace(/\.keyword$/, ''))],
            },
          },
        },
      },
    },
  };
}

/** Roll a set of records into the counts the summary shows. */
export function summarise(records) {
  const by = { OK: 0, DELAYED: 0, CRITICAL: 0, CLOCK_AHEAD: 0, ERROR: 0, NO_DATA: 0 };
  let worst = null;
  for (const r of records) {
    by[r.status] = (by[r.status] || 0) + 1;
    if (r.delayMinutes !== null && (worst === null || r.delayMinutes > worst.delayMinutes)) worst = r;
  }
  const measured = records.filter((r) => r.delayMinutes !== null).map((r) => r.delayMinutes);
  return {
    devices: records.length,
    by,
    unhealthy: by.DELAYED + by.CRITICAL + by.CLOCK_AHEAD,
    // Unknown rather than zero when nothing could be measured.
    median: measured.length ? median(measured) : null,
    worst,
  };
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
