/** Tiny DOM helpers. No innerHTML for user/ES-supplied strings - everything is
 *  created as text nodes, which also keeps us clear of MV3's CSP. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs, ...kids) {
  const parts = tag.split(/([#.])/);
  const el = document.createElement(parts[0] || 'div');
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === '#') el.id = parts[i + 1];
    else el.classList.add(parts[i + 1]);
  }
  if (attrs && (attrs.nodeType || typeof attrs === 'string' || Array.isArray(attrs))) {
    kids.unshift(attrs);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // only ever used with our own markup
      else if (k in el && k !== 'list' && typeof v !== 'object') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (k) => {
    if (k === null || k === undefined || k === false) return;
    if (Array.isArray(k)) return k.forEach(add);
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
}

export const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  kids.flat().forEach((k) => k && el.append(k.nodeType ? k : document.createTextNode(String(k))));
  return el;
};

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...kids) { clear(el); kids.flat().forEach((k) => k && el.append(k)); return el; }

/** Shared singleton tooltip. */
let tipEl = null;
export const tooltip = {
  show(html, x, y) {
    if (!tipEl) { tipEl = h('div.tip'); document.body.append(tipEl); }
    clear(tipEl);
    tipEl.append(html);
    tipEl.style.display = 'block';
    const r = tipEl.getBoundingClientRect();
    const px = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
    const py = Math.min(Math.max(8, y + 14), window.innerHeight - r.height - 8);
    tipEl.style.left = px + 'px';
    tipEl.style.top = py + 'px';
  },
  hide() { if (tipEl) tipEl.style.display = 'none'; },
};
