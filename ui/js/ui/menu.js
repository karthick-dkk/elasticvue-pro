/**
 * Row action menu.
 *
 * Destructive actions used to sit in the row as plain buttons, one mis-click away from
 * deleting an index or a snapshot. They live behind this now: the row keeps the safe,
 * frequent actions, and everything that changes or removes something is a deliberate
 * two-step — open the menu, then confirm.
 */

import { h, clear } from '../lib/dom.js';

let open = null;   // the popup currently on screen, if any

function close() {
  if (!open) return;
  open.el.remove();
  document.removeEventListener('mousedown', open.away, true);
  document.removeEventListener('keydown', open.key, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('scroll', close, true);
  open = null;
}

export function closeMenus() { close(); }

/**
 * @param items  [{ label, icon, onClick, danger, disabled, title, sep, hint }]
 *               `sep: true` draws a divider; `hint` is a line of muted text.
 * @param opts   { label } for the trigger button (default '⋮')
 */
export function rowMenu(items, opts = {}) {
  const trigger = h('button.btn.sm.menu-trigger', {
    title: opts.title || 'More actions',
    'aria-haspopup': 'menu',
    onclick: (e) => {
      e.stopPropagation();
      const wasOpen = open && open.trigger === trigger;
      close();
      if (wasOpen) return;             // clicking the same trigger closes it
      show(trigger, items);
    },
  }, opts.label || '⋮');
  return trigger;
}

function show(trigger, items) {
  const el = h('div.menu-pop', { role: 'menu' });

  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.append(h('div.sep')); continue; }
    if (it.hint) { el.append(h('div.hint', it.hint)); continue; }
    el.append(h(`button${it.danger ? '.danger' : ''}`, {
      disabled: !!it.disabled,
      title: it.title || '',
      role: 'menuitem',
      onclick: (e) => {
        e.stopPropagation();
        close();
        if (!it.disabled && it.onClick) it.onClick(e);
      },
    }, h('span.ico', it.icon || ''), h('span', it.label)));
  }

  document.body.append(el);

  // Anchor under the trigger, flipped or nudged to stay on screen.
  const r = trigger.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - m.width), window.innerWidth - m.width - 8);
  const below = r.bottom + 4;
  const top = below + m.height > window.innerHeight - 8 ? Math.max(8, r.top - m.height - 4) : below;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const away = (e) => { if (!el.contains(e.target) && e.target !== trigger) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);

  open = { el, trigger, away, key };
  const first = el.querySelector('button:not(:disabled)');
  if (first) first.focus();
}

/** The icons used for row actions, so they mean the same thing on every page. */
export const ICON = {
  delete: '🗑',
  open: '⊕',
  close: '⊘',
  move: '⇄',
  settings: '⚙',
  restore: '⇩',
  details: '☰',
  refresh: '↻',
  verify: '✓',
  cleanup: '🧹',
  console: '↗',
  free: '⌫',
};
