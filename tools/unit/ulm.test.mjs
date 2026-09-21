/**
 * ULM's layout assumptions and the alert it exists for.
 *
 * These are worth testing precisely because getting them wrong is invisible: a prefix
 * that is subtly off returns an empty listing, which on screen is indistinguishable from
 * an archive with nothing in it. "No data" and "wrong question" have to be told apart
 * here, because they cannot be told apart later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ulm = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/ulm.js')).href);

const S3 = { bucket: 'client-bucket', rawPrefix: 'rawlog', enrichedPrefix: 'enrichedlog' };
const obj = (key, size = 1024) => ({ key, size });

/* --------------------------------- the layout --------------------------------- */

test('the day segment is unpadded, the way the bucket writes it', () => {
  // date=2026.8.1, not date=2026.08.01. Padding produces a prefix that matches nothing,
  // and an empty listing reads as "never archived" rather than "asked wrong".
  assert.equal(ulm.s3Day(new Date(Date.UTC(2026, 7, 1))), '2026.8.1');
  assert.equal(ulm.s3Day(new Date(Date.UTC(2026, 11, 25))), '2026.12.25');
});

test('both padded and unpadded days are understood when reading', () => {
  assert.equal(ulm.isoDay('2026.8.1'), '2026-08-01');
  assert.equal(ulm.isoDay('2026.08.01'), '2026-08-01');
  assert.equal(ulm.isoDay('nonsense'), '');
  assert.equal(ulm.isoDay(''), '');
});

test('prefixes match the layout ULM was given', () => {
  assert.equal(ulm.tagPrefix(S3, 'raw', 'tag1'), 'rawlog/tag1/');
  assert.equal(ulm.tagPrefix(S3, 'enriched', 'tag1'), 'enrichedlog/tag1/');
  assert.equal(ulm.dayPrefix(S3, 'raw', 'tag1', 'HQ', '2026.8.1'), 'rawlog/tag1/HQ/date=2026.8.1/');
  // No branch means every branch for that tag, which is the per-day aggregate.
  assert.equal(ulm.dayPrefix(S3, 'raw', 'tag1', '', '2026.8.1'), 'rawlog/tag1/');
});

test('a bucket that names its folders differently is followed', () => {
  const custom = { rawPrefix: 'raw', enrichedPrefix: 'parsed' };
  assert.equal(ulm.tagPrefix(custom, 'raw', 't'), 'raw/t/');
  assert.equal(ulm.tagPrefix(custom, 'enriched', 't'), 'parsed/t/');
});

test('a key is taken apart into tag, branch and day', () => {
  const p = ulm.parseKey('rawlog/tag1/HQ/date=2026.8.1/part-0.gz', S3);
  assert.deepEqual(p, { copy: 'raw', tag: 'tag1', branch: 'HQ', day: '2026-08-01', file: 'part-0.gz' });
  const e = ulm.parseKey('enrichedlog/tag1/DR/date=2026.08.02/a/b.gz', S3);
  assert.equal(e.copy, 'enriched');
  assert.equal(e.branch, 'DR');
  assert.equal(e.day, '2026-08-02');
  assert.equal(e.file, 'a/b.gz', 'a nested file keeps its path');
});

test('a key that does not fit the layout is refused, not guessed at', () => {
  // Inventing a day for an unrecognised key puts a row in the table that no object
  // supports, which is worse than leaving it out and saying how many were skipped.
  for (const k of ['rawlog/tag1/HQ/part-0.gz', 'rawlog/tag1/HQ/2026.8.1/x.gz',
                   'other/tag1/HQ/date=2026.8.1/x.gz', 'rawlog/tag1/', '']) {
    assert.equal(ulm.parseKey(k, S3), null, `${k} should not parse`);
  }
});

/* ------------------------------- rolling up ------------------------------- */

test('the two copies land on one row per day', () => {
  const { rows } = ulm.byDay([
    obj('rawlog/tag1/HQ/date=2026.8.1/a.gz', 100),
    obj('rawlog/tag1/DR/date=2026.8.1/b.gz', 50),
    obj('enrichedlog/tag1/HQ/date=2026.8.1/a.gz', 20),
    obj('rawlog/tag1/HQ/date=2026.8.2/c.gz', 7),
  ], S3);
  assert.equal(rows.length, 2);
  const first = rows.find((r) => r.day === '2026-08-01');
  assert.equal(first.raw.objects, 2);
  assert.equal(first.raw.bytes, 150);
  assert.equal(first.enriched.objects, 1);
  assert.equal(first.enriched.bytes, 20);
  assert.deepEqual(first.branches, ['DR', 'HQ']);
});

test('days come back newest first', () => {
  const { rows } = ulm.byDay([
    obj('rawlog/t/HQ/date=2026.8.1/a.gz'),
    obj('rawlog/t/HQ/date=2026.8.10/a.gz'),
    obj('rawlog/t/HQ/date=2026.8.2/a.gz'),
  ], S3);
  assert.deepEqual(rows.map((r) => r.day), ['2026-08-10', '2026-08-02', '2026-08-01']);
});

test('keys that could not be read are counted, not silently dropped', () => {
  const { rows, unparsed } = ulm.byDay([
    obj('rawlog/t/HQ/date=2026.8.1/a.gz'),
    obj('something/else.gz'),
    obj('rawlog/broken.gz'),
  ], S3);
  assert.equal(rows.length, 1);
  assert.equal(unparsed, 2, 'the page has to be able to say how many it skipped');
});

test('a day present in one copy only is its own state', () => {
  // A parser that stopped and a shipper that stopped are different problems; a status
  // that cannot tell them apart is not worth showing.
  const both = ulm.byDay([obj('rawlog/t/H/date=2026.8.1/a.gz'), obj('enrichedlog/t/H/date=2026.8.1/a.gz')], S3);
  assert.equal(ulm.dayStatus(both.rows[0]).id, 'both');
  const rawOnly = ulm.byDay([obj('rawlog/t/H/date=2026.8.1/a.gz')], S3);
  assert.equal(ulm.dayStatus(rawOnly.rows[0]).id, 'raw-only');
  const enrOnly = ulm.byDay([obj('enrichedlog/t/H/date=2026.8.1/a.gz')], S3);
  assert.equal(ulm.dayStatus(enrOnly.rows[0]).id, 'enriched-only');
  assert.equal(ulm.dayStatus(null).id, 'none');
});

test('totals add up across every day', () => {
  const a = ulm.byDay([
    obj('rawlog/t/H/date=2026.8.1/a.gz', 100),
    obj('enrichedlog/t/H/date=2026.8.1/a.gz', 10),
    obj('rawlog/t/H/date=2026.8.2/a.gz', 5),
  ], S3);
  const t = ulm.totals(a);
  assert.equal(t.days, 2);
  assert.equal(t.rawBytes, 105);
  assert.equal(t.enrichedBytes, 10);
  assert.equal(t.rawObjects, 2);
});

/* --------------------------------- the alert --------------------------------- */

const archiveOf = (keys) => ulm.byDay(keys.map((k) => obj(k)), S3);

test('a day Elasticsearch has and the archive does not is critical', () => {
  const archive = archiveOf(['rawlog/tag1/HQ/date=2026.8.1/a.gz']);
  const found = ulm.missingArchive(
    [{ tag: 'tag1', day: '2026-08-01', docs: 10 }, { tag: 'tag1', day: '2026-08-02', docs: 900 }],
    archive,
    { pulledDays: new Set(['2026-08-01', '2026-08-02']), today: '2026-08-05' },
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].day, '2026-08-02');
  assert.equal(found[0].docs, 900);
  assert.match(found[0].reason, /neither the raw nor the enriched/);
});

test('a day held in either copy is not a finding', () => {
  const enrichedOnly = archiveOf(['enrichedlog/tag1/HQ/date=2026.8.2/a.gz']);
  const found = ulm.missingArchive([{ tag: 'tag1', day: '2026-08-02', docs: 5 }], enrichedOnly,
    { pulledDays: new Set(['2026-08-02']), today: '2026-08-05' });
  assert.equal(found.length, 0, 'one copy present is still archived');
});

test('a day nobody pulled is not reported as missing', () => {
  // Absence in a listing that was never taken is not absence in the bucket. Firing on it
  // would make the alert mean "you have not pressed Pull Now", which nobody would keep.
  const found = ulm.missingArchive([{ tag: 'tag1', day: '2026-08-02', docs: 5 }], archiveOf([]),
    { pulledDays: new Set(['2026-08-01']), today: '2026-08-05' });
  assert.equal(found.length, 0);
});

test('today is not judged, because it is still being written', () => {
  const found = ulm.missingArchive(
    [{ tag: 'tag1', day: '2026-08-05', docs: 5 }, { tag: 'tag1', day: '2026-08-04', docs: 5 }],
    archiveOf([]),
    { pulledDays: new Set(['2026-08-04', '2026-08-05']), today: '2026-08-05' },
  );
  assert.deepEqual(found.map((f) => f.day), ['2026-08-04']);
});

test('findings come back newest first', () => {
  const found = ulm.missingArchive(
    [{ tag: 't', day: '2026-08-01', docs: 1 }, { tag: 't', day: '2026-08-03', docs: 1 },
     { tag: 't', day: '2026-08-02', docs: 1 }],
    archiveOf([]),
    { pulledDays: new Set(['2026-08-01', '2026-08-02', '2026-08-03']), today: '2026-08-05' },
  );
  assert.deepEqual(found.map((f) => f.day), ['2026-08-03', '2026-08-02', '2026-08-01']);
});

/* ------------------------------- the size chart ------------------------------- */

test('daily points keep every day, oldest first', () => {
  const { rows } = ulm.byDay([
    obj('rawlog/t/H/date=2026.8.2/a.gz', 20),
    obj('rawlog/t/H/date=2026.8.1/a.gz', 10),
  ], S3);
  const pts = ulm.rollUp(rows, 'day');
  assert.deepEqual(pts.map((p) => p.at), ['2026-08-01', '2026-08-02']);
  assert.equal(pts[1].rawBytes, 20);
});

test('weeks start on Monday and sum what falls in them', () => {
  // 2026-08-01 is a Saturday; 2026-08-03 is the following Monday.
  const { rows } = ulm.byDay([
    obj('rawlog/t/H/date=2026.8.1/a.gz', 10),
    obj('rawlog/t/H/date=2026.8.3/a.gz', 20),
    obj('rawlog/t/H/date=2026.8.4/a.gz', 30),
  ], S3);
  const pts = ulm.rollUp(rows, 'week');
  assert.equal(pts.length, 2);
  assert.equal(pts[0].at, '2026-07-27', 'the Saturday belongs to the week that began the Monday before');
  assert.equal(pts[0].rawBytes, 10);
  assert.equal(pts[1].at, '2026-08-03');
  assert.equal(pts[1].rawBytes, 50);
});

test('months group by calendar month', () => {
  const { rows } = ulm.byDay([
    obj('rawlog/t/H/date=2026.7.31/a.gz', 5),
    obj('rawlog/t/H/date=2026.8.1/a.gz', 10),
    obj('rawlog/t/H/date=2026.8.31/a.gz', 10),
  ], S3);
  const pts = ulm.rollUp(rows, 'month');
  assert.deepEqual(pts.map((p) => p.at), ['2026-07', '2026-08']);
  assert.equal(pts[1].rawBytes, 20);
});

test('one day of data is one point, not a trend', () => {
  const { rows } = ulm.byDay([obj('rawlog/t/H/date=2026.8.1/a.gz', 10)], S3);
  assert.equal(ulm.rollUp(rows, 'week').length, 1);
  assert.equal(ulm.rollUp(rows, 'month').length, 1);
});
