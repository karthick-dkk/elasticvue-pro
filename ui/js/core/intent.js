/** Cross-page hand-off (e.g. "open this index in the REST console"). */
export const intent = { console: null };

export function navigateTo(page, payload) {
  if (page === 'console') intent.console = payload || null;
  window.dispatchEvent(new CustomEvent('evp:navigate', { detail: { page } }));
}
