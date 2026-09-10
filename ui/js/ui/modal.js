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

/* ------------------------------ confirmation -------------------------------- */

/**
 * A yes/no question the operator must answer before something irreversible happens.
 *
 * The browser's own confirm() offers OK/Cancel, which says nothing about what is
 * about to occur — this names the action in the button, so the answer is deliberate.
 * `typeToConfirm` demands the exact text back for the worst cases (deleting many
 * indices, removing a repository).
 */
export function confirmDialog(title, body, opts = {}) {
  const {
    yes = 'Yes', no = 'No', danger = false, typeToConfirm = null, hint = null,
  } = opts;

  const nodes = [
    typeof body === 'string'
      ? h('div', { style: { fontSize: '13px', lineHeight: '1.55', whiteSpace: 'pre-wrap' } }, body)
      : body,
    hint ? h('div.muted', { style: { fontSize: '11.5px' } }, hint) : null,
    typeToConfirm
      ? field(`Type ${typeToConfirm} to confirm`,
          text('confirm-echo', '', { mono: true, placeholder: typeToConfirm }))
      : null,
  ].filter(Boolean);

  return modal(title, null, nodes, (ctx) => [
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      h('button.btn', { onclick: () => ctx.done(false) }, `No, ${no.toLowerCase()}`),
      h(`button.btn.${danger ? 'danger' : 'primary'}`, {
        onclick: () => {
          if (typeToConfirm && val('confirm-echo').trim() !== typeToConfirm) {
            return ctx.msg(`Type ${typeToConfirm} exactly to confirm.`);
          }
          ctx.done(true);
        },
      }, `Yes, ${yes.toLowerCase()}`)),
  ], { width: '520px' }).then((v) => v === true);
}

/** A list of names, for a confirmation that must name what it will affect. */
export function nameList(names, max = 14) {
  return h('div.mono', {
    style: { fontSize: '11.5px', maxHeight: '190px', overflow: 'auto', marginTop: '2px',
             border: '1px solid var(--border)', borderRadius: '6px', padding: '7px' },
  }, names.slice(0, max).map((n) => h('div', n)),
     names.length > max ? h('div.muted', `…and ${names.length - max} more`) : null);
}
