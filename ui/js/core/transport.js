/**
 * Transport to the Rust core.
 *
 * Inside the desktop app this is a Tauri command (`bridge`); in the development bridge
 * (`espro-bridge`) it is POST /bridge on loopback. Same message API either way, and the
 * same shape the browser extension used for chrome.runtime.sendMessage — which is why
 * the pages did not need to change.
 */

const T = globalThis.__TAURI__;
export const isTauri = !!(T && T.core && typeof T.core.invoke === 'function');

/**
 * The signed-in session, attached to every message the core then authorises against.
 *
 * Kept in sessionStorage rather than localStorage: closing the window should end the
 * session, and a reload should not. It is a bearer token, so it lives per-tab and goes
 * when the tab does. The portable build never has one — the core does not ask.
 */
const KEY_SESSION = 'espro.session';
let session = read();

function read() {
  try { return sessionStorage.getItem(KEY_SESSION) || ''; } catch { return ''; }
}
export function getSession() { return session; }
export function setSession(token) {
  session = token || '';
  try {
    if (session) sessionStorage.setItem(KEY_SESSION, session);
    else sessionStorage.removeItem(KEY_SESSION);
  } catch { /* a private window still works, it just forgets on reload */ }
}

/** Notified when the core says the session is gone, so the app can show the login again. */
const expiryListeners = new Set();
export function onSessionLost(fn) { expiryListeners.add(fn); return () => expiryListeners.delete(fn); }

export async function bridge(msg) {
  try {
    // LOGIN carries no session, and LOGOUT carries the one it is ending.
    const out = session && msg.session === undefined ? { ...msg, session } : msg;
    const res = isTauri
      ? await T.core.invoke('bridge', { msg: out })
      : await (await fetch('/bridge', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out),
      })).json();
    // An expired or revoked session must not leave the app quietly showing stale data —
    // every caller would otherwise have to notice this for itself.
    if (res && res.kind === 'unauthenticated' && session) {
      setSession('');
      for (const fn of expiryListeners) { try { fn(); } catch { /* keep telling the rest */ } }
    }
    return res;
  } catch (e) {
    return { ok: false, kind: 'worker_error', message: String(e && e.message || e) };
  }
}
