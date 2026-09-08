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

export async function bridge(msg) {
  try {
    if (isTauri) return await T.core.invoke('bridge', { msg });
    const r = await fetch('/bridge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, kind: 'worker_error', message: String(e && e.message || e) };
  }
}
