/**
 * ULM — what is in the archive, and what should be.
 *
 * Two copies of every client's logs live in S3: the raw bytes as they arrived, and the
 * enriched copy a parser produced. The question ULM answers is not "how big is the
 * bucket" but "is yesterday there, for this tag, in both copies" — and the alert it
 * exists for fires when Elasticsearch has a day's data for a tag and the archive does
 * not, because that is a backup that silently is not one.
 *
 * Pure: paths in, facts out. Nothing here talks to S3; the page does the fetching and
 * hands the keys back. That is what makes the layout assumptions testable, and they need
 * to be — a prefix that is subtly wrong returns an empty listing, which looks exactly
 * like an archive with nothing in it.
 *
 * The layout this was specified against:
 *
 *   <bucket>/rawlog/<tag>/<branch>/date=YYYY.M.D/*.gz
 *   <bucket>/enrichedlog/<tag>/<branch>/date=YYYY.M.D/*.gz
 *
 * The date segment is not zero-padded in the example given (`date=2026.8.1`), so both
 * forms are accepted when reading and the unpadded form is used when writing. Getting
 * that backwards is the difference between "no data" and "wrong question".
 */

/** The two copies, in the order they are shown. */
export const COPIES = [
  { id: 'raw', label: 'Raw', prefixKey: 'rawPrefix' },
  { id: 'enriched', label: 'Enriched', prefixKey: 'enrichedPrefix' },
];

/** `rawlog/tag1/` — everything under one tag, both branches. */
export function tagPrefix(s3, copy, tag) {
  const base = (s3 && s3[copyPrefixKey(copy)]) || copy;
  return `${base}/${String(tag || '').trim()}/`;
}

function copyPrefixKey(copy) {
  const c = COPIES.find((x) => x.id === copy);
  return c ? c.prefixKey : 'rawPrefix';
}

/**
 * `rawlog/tag1/HQ/date=2026.8.1/` for one day.
 *
 * `branch` may be empty, which lists every branch for that tag — the aggregate ULM shows
 * per day. A day with several branches is one day, not several.
 */
export function dayPrefix(s3, copy, tag, branch, day) {
  const head = tagPrefix(s3, copy, tag);
  const b = String(branch || '').trim();
  return b ? `${head}${b}/date=${day}/` : head;
}

/**
 * `2026.8.1` from a Date or an ISO day — the unpadded form the bucket uses.
 *
 * Padding it would produce `date=2026.08.01`, a prefix that matches nothing, and an
 * empty listing reads as "this day was never archived" rather than "you asked wrong".
 */
export function s3Day(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (!isFinite(t.getTime())) return '';
  return `${t.getUTCFullYear()}.${t.getUTCMonth() + 1}.${t.getUTCDate()}`;
}

/** The reverse: `2026.8.1` or `2026.08.01` → `2026-08-01`, for sorting and display. */
export function isoDay(s3day) {
  const m = String(s3day || '').match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) return '';
  const p = (n) => String(Number(n)).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])}`;
}

/**
 * Pull the tag, branch and day out of an object key.
 *
 * Returns null for anything that does not match the layout rather than guessing: a key
 * that does not parse is a key this page has nothing true to say about, and inventing a
 * day for it would put a row in a table that no object supports.
 */
export function parseKey(key, s3) {
  const k = String(key || '');
  for (const copy of COPIES) {
    const base = (s3 && s3[copy.prefixKey]) || copy.id;
    const head = `${base}/`;
    if (!k.startsWith(head)) continue;
    const rest = k.slice(head.length).split('/');
    // tag / branch / date=… / file
    if (rest.length < 4) return null;
    const dateSeg = rest[2];
    if (!dateSeg.startsWith('date=')) return null;
    const day = isoDay(dateSeg.slice(5));
    if (!day) return null;
    return { copy: copy.id, tag: rest[0], branch: rest[1], day, file: rest.slice(3).join('/') };
  }
  return null;
}

/**
 * Roll a set of listed objects into one row per day.
 *
 * `objects` are `{ key, size }` from any number of listings, of either copy. The result
 * is keyed by day so the two copies line up on the same row, which is the comparison the
 * page exists to make.
 */
export function byDay(objects, s3) {
  const days = new Map();
  let unparsed = 0;
  for (const o of objects || []) {
    const p = parseKey(o.key, s3);
    if (!p) { unparsed += 1; continue; }
    if (!days.has(p.day)) {
      days.set(p.day, { day: p.day, tags: new Set(), branches: new Set(),
                        raw: { objects: 0, bytes: 0 }, enriched: { objects: 0, bytes: 0 } });
    }
    const row = days.get(p.day);
    row.tags.add(p.tag);
    row.branches.add(p.branch);
    const side = row[p.copy];
    side.objects += 1;
    side.bytes += Number(o.size) || 0;
  }
  const rows = [...days.values()]
    .map((r) => ({ ...r, tags: [...r.tags].sort(), branches: [...r.branches].sort() }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));   // newest first
  return { rows, unparsed };
}

/**
 * What a day's archive looks like: present in both copies, one, or neither.
 *
 * "Partial" is its own state rather than being folded into present or absent. A day with
 * raw bytes and no enriched copy is a parser that stopped, which is a different problem
 * from a shipper that stopped, and a status that cannot tell them apart is not worth
 * showing.
 */
export function dayStatus(row) {
  const raw = row && row.raw ? row.raw.objects > 0 : false;
  const enr = row && row.enriched ? row.enriched.objects > 0 : false;
  if (raw && enr) return { id: 'both', label: 'both copies', cls: 'green' };
  if (raw) return { id: 'raw-only', label: 'raw only', cls: 'yellow' };
  if (enr) return { id: 'enriched-only', label: 'enriched only', cls: 'yellow' };
  return { id: 'none', label: 'nothing archived', cls: 'red' };
}

/**
 * The alert this feature was asked for.
 *
 * Elasticsearch holding a day's data for a tag while the archive holds none of it means
 * the logs were received and not kept. Critical, because it is discovered — if it is
 * discovered — at the moment somebody needs the archive and it is far too late.
 *
 * Two deliberate narrowings, both to keep this from crying wolf:
 *
 *   * A day nobody has pulled is not a finding. Absence in a listing that was never
 *     taken is not absence in the bucket, and firing on it would make the alert mean
 *     "you have not pressed Pull Now", which nobody would keep.
 *   * Today is excluded. A day still in progress is expected to be incomplete — archives
 *     are written after the fact — so the newest day that can be judged is yesterday.
 *
 * @param indexDays  [{ tag, day, docs }] what Elasticsearch has
 * @param archive    the output of byDay()
 * @param opts       { pulledDays: Set<string>, today: 'YYYY-MM-DD' }
 */
export function missingArchive(indexDays, archive, opts = {}) {
  const pulled = opts.pulledDays instanceof Set ? opts.pulledDays : new Set(opts.pulledDays || []);
  const today = opts.today || '';
  const rows = new Map((archive && archive.rows ? archive.rows : []).map((r) => [r.day, r]));

  const out = [];
  for (const d of indexDays || []) {
    const day = String(d.day || '');
    if (!day || (today && day >= today)) continue;
    if (pulled.size && !pulled.has(day)) continue;
    const row = rows.get(day);
    const has = row && (row.raw.objects > 0 || row.enriched.objects > 0);
    if (has) continue;
    out.push({
      tag: d.tag || '',
      day,
      docs: Number(d.docs) || 0,
      reason: `Elasticsearch holds ${Number(d.docs) || 0} document(s) for ${d.tag || 'this tag'} on ${day}, `
            + 'and neither the raw nor the enriched copy has anything archived for that day.',
    });
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** Totals across every day pulled, for the header line. */
export function totals(archive) {
  const rows = (archive && archive.rows) || [];
  return rows.reduce((acc, r) => ({
    days: acc.days + 1,
    rawBytes: acc.rawBytes + r.raw.bytes,
    enrichedBytes: acc.enrichedBytes + r.enriched.bytes,
    rawObjects: acc.rawObjects + r.raw.objects,
    enrichedObjects: acc.enrichedObjects + r.enriched.objects,
  }), { days: 0, rawBytes: 0, enrichedBytes: 0, rawObjects: 0, enrichedObjects: 0 });
}

/**
 * Daily rows rolled up for the size chart.
 *
 * `week` starts Monday, `month` on the first. A bucket in its first week has one point,
 * which is honest — padding it to look like a trend would invent movement.
 */
export function rollUp(rows, grain) {
  if (grain === 'day' || !grain) {
    return [...(rows || [])].sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((r) => ({ at: r.day, rawBytes: r.raw.bytes, enrichedBytes: r.enriched.bytes }));
  }
  const key = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    if (grain === 'month') return day.slice(0, 7);
    // ISO-ish week: back up to Monday.
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  };
  const buckets = new Map();
  for (const r of rows || []) {
    const k = key(r.day);
    if (!buckets.has(k)) buckets.set(k, { at: k, rawBytes: 0, enrichedBytes: 0 });
    const b = buckets.get(k);
    b.rawBytes += r.raw.bytes;
    b.enrichedBytes += r.enriched.bytes;
  }
  return [...buckets.values()].sort((a, b) => (a.at < b.at ? -1 : 1));
}
