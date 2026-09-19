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
