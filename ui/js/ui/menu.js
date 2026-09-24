/**
 * Row action menu.
 *
 * Destructive actions used to sit in the row as plain buttons, one mis-click away from
 * deleting an index or a snapshot. They live behind this now: the row keeps the safe,
 * frequent actions, and everything that changes or removes something is a deliberate
 * two-step — open the menu, then confirm.
 */

import { h, mount } from '../lib/dom.js';

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
  anchorTo(el, trigger);

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
  edit: '✎',
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

/** Position a floating panel under its trigger, flipped or nudged to stay on screen. */
export function anchorTo(el, trigger) {
  const r = trigger.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - m.width), window.innerWidth - m.width - 8);
  const below = r.bottom + 4;
  const top = below + m.height > window.innerHeight - 8 ? Math.max(8, r.top - m.height - 4) : below;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/* --------------------------------- popover ---------------------------------- */

let openPop = null;

export function closePopover() {
  if (!openPop) return;
  const { el, away, key, onClose } = openPop;
  el.remove();
  document.removeEventListener('mousedown', away, true);
  document.removeEventListener('keydown', key, true);
  window.removeEventListener('resize', closePopover);
  window.removeEventListener('scroll', closePopover, true);
  openPop = null;
  if (onClose) onClose();
}

/**
 * A panel anchored to what you clicked, for content that does not deserve a row of its
 * own — notes on an alert, say. Unlike the row menu it stays open while you interact
 * with it, and closes on Escape, on a click outside, or when its own content asks to.
 *
 * @param trigger  the element to anchor under
 * @param build    (ctx) => Node — ctx.close() dismisses, ctx.rebuild() redraws in place
 * @param opts     { title, sub, width, onClose }
 */
export function popover(trigger, build, opts = {}) {
  const already = openPop && openPop.trigger === trigger;
  closePopover();
  closeMenus();
  if (already) return null;   // clicking the same trigger again closes it

  const el = h('div.pop', opts.width ? { style: { minWidth: opts.width } } : null);
  const body = h('div.body');
  const ctx = {
    close: closePopover,
    rebuild: () => { mount(body, build(ctx)); anchorTo(el, trigger); },
  };

  el.append(
    h('header', h('span', opts.title || ''),
      opts.sub ? h('span.sub', opts.sub) : null,
      h('button.btn.sm.ghost', { title: 'Close', onclick: closePopover }, '×')),
    body,
  );
  mount(body, build(ctx));
  document.body.append(el);
  anchorTo(el, trigger);

  const away = (e) => { if (!el.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) closePopover(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', closePopover);
  window.addEventListener('scroll', closePopover, true);

  openPop = { el, trigger, away, key, onClose: opts.onClose };
  const first = el.querySelector('input,textarea');
  if (first) setTimeout(() => first.focus(), 0);
  return ctx;
}

/* ---------------------------------- toast ------------------------------------ */

let toastWrap = null;

/**
 * A short confirmation that fades itself out. For actions that close the panel they were
 * performed in, where an alert() would be an interruption and silence would be a doubt.
 */
/** At most this many on screen. Beyond it they stop being notices and become a wall. */
const MAX_TOASTS = 4;

/**
 * A short-lived notice.
 *
 * `opts.key` is what stops a repeated action stacking. Pressing Run four times used to
 * leave four notices piled over the page, because each message ended with a different
 * duration and so counted as a different message — the one thing they had in common was
 * the only thing not being compared. A keyed toast replaces the one already showing and
 * restarts its clock, so repeating an action updates one line instead of growing a
 * column.
 *
 * Unkeyed toasts still stack, because two different things happening are two things
 * worth seeing. They are capped: past four, the oldest goes, since a notice nobody can
 * read before the next arrives is not a notice.
 */
export function toast(message, kind = 'ok', ms = 2600, opts = {}) {
  if (!toastWrap) { toastWrap = h('div.toast-wrap'); document.body.append(toastWrap); }

  const cls = `div.toast${kind === 'ok' ? '' : `.${kind}`}`;
  const key = opts.key || null;

  // Replacing in place rather than removing and appending: a toast that vanishes and
  // reappears at the bottom reads as two events, which is exactly what this avoids.
  let el = key ? toastWrap.querySelector(`[data-toast-key="${CSS_ESCAPE(key)}"]`) : null;
  if (el) {
    clearTimeout(Number(el.dataset.timer));
    el.className = cls.slice(4).split('.').filter(Boolean).join(' ');
    el.textContent = message;
    el.classList.remove('out');
  } else {
    el = h(cls, message);
    if (key) el.dataset.toastKey = key;
    toastWrap.append(el);
    while (toastWrap.children.length > MAX_TOASTS) toastWrap.firstElementChild.remove();
  }

  const timer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
  el.dataset.timer = String(timer);
  return el;
}

/** Attribute selectors need quoting; CSS.escape is not everywhere (jsdom has none). */
function CSS_ESCAPE(v) {
  return String(v).replace(/["\\]/g, '\\$&');
}
