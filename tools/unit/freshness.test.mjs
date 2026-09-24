/**
 * Freshness reporting.
 *
 * Pages serve cached data, so the age on screen is what makes that safe. The cases
 * below are the ones where a wrong answer is worse than no answer: never-fetched must
 * not read as "just now", and a fleet figure must describe the stalest cluster, not the
 * freshest — otherwise one recently-refreshed cluster makes the whole fleet look current.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { isStale, STALE_AFTER_MS } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/freshness.js')).href);
const { stampFetch, fetchedAt, oldestFetch, state } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);

test('never fetched is 0, not now', () => {
  assert.equal(fetchedAt('nope', 'indices'), 0);
  assert.equal(isStale(0), false, 'never-fetched is not "stale", it is unknown');
});

test('a stamp is per cluster AND per dataset', () => {
  stampFetch('c1', 'indices');
  assert.ok(fetchedAt('c1', 'indices') > 0);
  assert.equal(fetchedAt('c1', 'data'), 0, 'stamping indices must not imply disk stats');
  assert.equal(fetchedAt('c2', 'indices'), 0, 'stamping one cluster must not imply another');
});

test('staleness is decided by the threshold, not by feel', () => {
  const now = Date.now();
  assert.equal(isStale(now - 1000, now), false);
  assert.equal(isStale(now - STALE_AFTER_MS - 1, now), true);
  assert.equal(isStale(now - STALE_AFTER_MS + 1, now), false, 'exactly at the threshold is not yet stale');
});

test('a fleet figure reports the OLDEST cluster', () => {
  state.fetchedAt['a:indices'] = 1000;
  state.fetchedAt['b:indices'] = 9000;
  assert.equal(oldestFetch(['a', 'b'], 'indices'), 1000,
    'reporting the newest would let one fresh cluster make a stale fleet look current');
});

test('a fleet figure is unknown until every cluster has been read', () => {
  state.fetchedAt['a:indices'] = 1000;
  delete state.fetchedAt['zz:indices'];
  assert.equal(oldestFetch(['a', 'zz'], 'indices'), 0,
    'one unread cluster means the fleet age is not known — not that it equals the read one');
});
