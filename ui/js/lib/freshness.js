/**
 * "Fetched N ago" plus a Refresh button, as one component.
 *
 * Pages serve cached data — navigating to one does not re-query Elasticsearch. That is
 * the right behaviour, and it is only safe while the age of what you are looking at is
 * on screen: a five-minute-old index list and a five-second-old one render identically,
 * and the difference is whether an index someone just deleted is still listed.
 *
 * One component rather than a line of markup per page, because the three pages that had
 * their own version already disagreed about whether "updated" meant this dataset or the
 * last global refresh.
 */

import { h } from './dom.js';
import { ago } from './fmt.js';

/** Past this, the data is old enough that it is worth saying so rather than implying it. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

export function isStale(ts, now = Date.now()) {
  return !!ts && now - ts > STALE_AFTER_MS;
}

/**
 * @param ts       epoch ms this dataset was fetched, 0 when never
 * @param onRefresh  called when the operator asks for current data
 * @param opts.label what was fetched ("indices", "shards") — named, because a page can
 *                   show more than one dataset and "updated 4 min ago" would not say which
 * @param opts.busy  a refresh is in flight
 */
export function freshnessBar(ts, onRefresh, opts = {}) {
  const { label = 'data', busy = false, dense = false } = opts;
  const stale = isStale(ts);
  return h('div.freshness', { class: dense ? 'freshness sm' : 'freshness' },
    busy
      ? h('span.muted', h('span.spin'), ' Fetching…')
      : ts
        ? h('span', { class: stale ? 'muted stale' : 'muted',
            title: new Date(ts).toLocaleString() },
            // Named and timestamped: "this list, at this moment", not "something happened".
            `${label} fetched ${ago(ts)}`)
        : h('span.muted', `${label} not fetched yet`),
    h('button.btn.sm', {
      disabled: busy,
      title: `Ask the cluster for current ${label} now`,
      onclick: onRefresh,
    }, busy ? '…' : '↻ Refresh'));
}
