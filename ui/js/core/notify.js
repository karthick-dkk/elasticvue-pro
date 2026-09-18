/**
 * New alerts, announced as they appear.
 *
 * The Alerts page is where alerts are read; nothing makes you look at it. A cluster can
 * go red while you are in the REST console and the only sign is a number on a tab. This
 * puts the first sighting of an alert in front of whoever is using the app, once.
 *
 * Three rules keep it from becoming noise, which is how a notifier stops working:
 *
 * The first pass after start-up announces nothing. Everything already wrong when you open
 * the app is a state, not news, and eleven toasts on launch teaches people to dismiss
 * them without reading.
 *
 * An alert is announced once. `alerts()` is recomputed from scratch every refresh, so the
 * same red cluster reappears in the list every thirty seconds — it is announced on the
 * refresh it first appears in and then only again if it clears and comes back.
 *
 * Acknowledged alerts are never announced. Acknowledging is how somebody says they have
 * seen it; repeating it back to them is the opposite of what that means.
 */

import { alerts } from './state.js';
import { isAcked } from './acks.js';
import { toast } from '../ui/menu.js';

/** null until the first pass, which establishes what was already true rather than new. */
let seen = null;

/** Beyond this many at once, one line saying how many beats a wall of them. */
const MAX_INDIVIDUAL = 3;
const MS_CRITICAL = 9000;
const MS_WARNING = 5000;

/**
 * Compare the current alerts with the last pass and announce what is new.
 * @returns {Array} the alerts announced, for tests and callers that want to know.
 */
export function announceNewAlerts({ notify = toast } = {}) {
  let open;
  try { open = alerts().filter((a) => !isAcked(a.key)); }
  catch (_) { return []; }          // a notifier must never break a refresh

  const keys = new Set(open.map((a) => a.key));
  if (seen === null) { seen = keys; return []; }

  const fresh = open.filter((a) => !seen.has(a.key));
  seen = keys;
  if (!fresh.length) return [];

  // Critical first: if only some of them get their own line, they should be those.
  const ordered = [...fresh].sort((a, b) =>
    (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));

  if (ordered.length <= MAX_INDIVIDUAL) {
    for (const a of ordered) {
      notify(a.title, a.level === 'critical' ? 'err' : 'warn',
        a.level === 'critical' ? MS_CRITICAL : MS_WARNING);
    }
  } else {
    const crit = ordered.filter((a) => a.level === 'critical').length;
    notify(`${ordered.length} new alerts${crit ? `, ${crit} critical` : ''}`,
      crit ? 'err' : 'warn', MS_CRITICAL);
  }
  return ordered;
}

/** Forget what has been announced — after a config change, the fleet is a different one. */
export function resetAnnounced() { seen = null; }
