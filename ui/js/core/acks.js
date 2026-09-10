/**
 * Acknowledgements and operator notes on alerts.
 *
 * An alert is a live reading, not a record — it exists while the condition holds and
 * disappears when it clears. What an operator adds to it is the opposite: "seen it, the
 * vendor is on it, ticket 4412". That belongs to the alert's KEY, which names the problem
 * rather than its current value, so a note written when the disk was at 86% is still
 * attached when it reaches 91%.
 *
 * Kept in IndexedDB on this machine. It is a local operator log, not shared state — two
 * people running the app do not see each other's notes.
 */

import { idb } from '../lib/idb.js';

const cache = new Map();      // key -> record, so rendering does not await
let loaded = false;

/** @typedef {{key:string, acked:boolean, ackedAt:number, ackedBy:string, notes:Array}} AckRecord */

export async function loadAcks() {
  try {
    const all = (await idb.allAcks()) || [];
    cache.clear();
    for (const a of all) cache.set(a.key, a);
    loaded = true;
  } catch (_) { loaded = true; }   // a browser with no IndexedDB just gets no notes
  return cache;
}

export function acksLoaded() { return loaded; }

export function ackFor(key) {
  return cache.get(key) || { key, acked: false, ackedAt: 0, ackedBy: '', notes: [] };
}

export function isAcked(key) { return !!(cache.get(key) || {}).acked; }
export function noteCount(key) { return ((cache.get(key) || {}).notes || []).length; }

async function save(rec) {
  cache.set(rec.key, rec);
  try { await idb.putAck(rec); } catch (_) { /* memory-only for this session */ }
  return rec;
}

/** Who wrote this. Remembered so it is typed once, not once per note. */
let who = '';
export function currentUser() { return who; }
export async function setCurrentUser(name) {
  who = String(name || '').trim();
  try { await idb.setKV('ackUser', who); } catch (_) { /* ignore */ }
}
export async function loadCurrentUser() {
  try { who = (await idb.getKV('ackUser')) || ''; } catch (_) { who = ''; }
  return who;
}

export async function acknowledge(key, { by = who, note = '' } = {}) {
  const rec = { ...ackFor(key), acked: true, ackedAt: Date.now(), ackedBy: by || 'operator' };
  rec.notes = [...(rec.notes || [])];
  if (note.trim()) rec.notes.push({ text: note.trim(), by: by || 'operator', ts: Date.now() });
  return save(rec);
}

export async function unacknowledge(key) {
  const rec = { ...ackFor(key), acked: false, ackedAt: 0, ackedBy: '' };
  // Notes are kept: they are the history of the problem, not of the acknowledgement.
  return save(rec);
}

export async function addNote(key, text, by = who) {
  const t = String(text || '').trim();
  if (!t) return null;
  const rec = { ...ackFor(key) };
  rec.notes = [...(rec.notes || []), { text: t, by: by || 'operator', ts: Date.now() }];
  return save(rec);
}

export async function removeNote(key, ts) {
  const rec = { ...ackFor(key) };
  rec.notes = (rec.notes || []).filter((n) => n.ts !== ts);
  return save(rec);
}

/**
 * Drop records whose alert no longer exists, so the store does not grow forever with
 * problems that were fixed months ago. Records carrying notes are kept.
 */
export async function pruneAcks(liveKeys) {
  const live = new Set(liveKeys);
  for (const [key, rec] of [...cache.entries()]) {
    if (live.has(key)) continue;
    if ((rec.notes || []).length) continue;
    cache.delete(key);
    try { await idb.delAck(key); } catch (_) { /* ignore */ }
  }
}
