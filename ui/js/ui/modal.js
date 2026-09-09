/**
 * The app's one modal. A promise that resolves with whatever the footer buttons pass to
 * `done()`, or null when the operator dismisses it (Escape, the ×, or the backdrop).
 */

import { h, mount, $ } from '../lib/dom.js';

export function modal(title, sub, bodyNodes, actions, { width = '640px' } = {}) {
  return new Promise((resolve) => {
    const overlay = h('div.modal-overlay', { onclick: (e) => { if (e.target === overlay) done(null); } });
    const dialog = h('div.modal', { role: 'dialog', 'aria-modal': 'true', style: { maxWidth: width, width: '96vw' } });
    const msg = h('div.modal-msg');
    function done(v) { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(v); }
    function onKey(e) { if (e.key === 'Escape') done(null); }
    document.addEventListener('keydown', onKey);
    const ctx = {
      done,
      dialog,
      msg: (text, cls = 'banner err') =>
        mount(msg, text ? h(`div.${cls.replace(/ /g, '.')}`, { style: { margin: 0 } }, text) : null),
      /** Run an async action with the button disabled and any failure shown in the dialog. */
      async run(btn, fn) {
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = 'Working…';
        ctx.msg(null);
        try { return await fn(); }
        catch (e) { ctx.msg(e && e.message ? e.message : String(e)); return undefined; }
        finally { btn.disabled = false; btn.textContent = label; }
      },
    };
    mount(dialog,
      h('div.modal-head', h('div', h('h2', title), sub ? h('p.sub', sub) : null),
        h('button.btn.ghost.sm', { onclick: () => done(null), 'aria-label': 'Close' }, '×')),
      h('div.modal-body', ...bodyNodes, msg),
      h('div.modal-foot', ...actions(ctx)));
    overlay.append(dialog);
    document.body.append(overlay);
    const first = dialog.querySelector('input,select,textarea');
    if (first) setTimeout(() => first.focus(), 0);
  });
}

/* ------------------------------- form helpers -------------------------------- */

export function field(label, input, hint) {
  return h('label.field', label, input, hint ? h('span.muted', { style: { fontSize: '11px' } }, hint) : null);
}

export function text(id, value, opts = {}) {
  return h('input', {
    id, type: opts.type || 'text', value: value == null ? '' : String(value),
    spellcheck: false, autocomplete: 'off', placeholder: opts.placeholder || '',
    style: { fontFamily: opts.mono ? 'var(--mono)' : '', ...(opts.style || {}) },
  });
}

export function select(id, value, options) {
  const s = h('select', { id }, ...options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  return s;
}

export function checkbox(id, label, value, hint) {
  return h('label', { style: { display: 'flex', gap: '7px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '12.5px' } },
    h('input', { id, type: 'checkbox', checked: !!value, style: { marginTop: '2px', cursor: 'pointer' } }),
    h('span', label, hint ? h('div.muted', { style: { fontSize: '11px' } }, hint) : null));
}

export function val(id) { const el = $(`#${id}`); return el ? el.value : ''; }
export function checked(id) { const el = $(`#${id}`); return !!(el && el.checked); }
