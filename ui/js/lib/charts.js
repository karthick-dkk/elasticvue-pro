/** Hand-rolled SVG charts (MV3 forbids remote scripts, so no chart CDN).
 *  Colors are referenced as CSS custom properties so light/dark swap in one place. */

import { h, svg, tooltip, mount } from './dom.js';
import { bytes, num, pct } from './fmt.js';

export const SERIES = ['var(--series-1)','var(--series-2)','var(--series-3)','var(--series-4)',
                       'var(--series-5)','var(--series-6)','var(--series-7)','var(--series-8)'];
export const STATUS = { good: 'var(--good)', warning: 'var(--warning)', serious: 'var(--serious)', critical: 'var(--critical)' };

/** Stable color for an entity name: colour follows the entity, never its rank. */
const colorMemo = new Map();
export function seriesColor(key) {
  if (!colorMemo.has(key)) {
    let n = 0;
    for (let i = 0; i < key.length; i++) n = (n * 31 + key.charCodeAt(i)) >>> 0;
    colorMemo.set(key, SERIES[n % SERIES.length]);
  }
  return colorMemo.get(key);
}
/** Assign slots in a fixed order for a known, ordered set (never cycled past 8). */
export function assignSlots(keys) {
  const map = new Map();
  keys.slice(0, SERIES.length).forEach((k, i) => map.set(k, SERIES[i]));
  return (k) => map.get(k) || 'var(--text-muted)';
}

function tipRow(label, value) {
  return h('div.r', h('span.sec', label), h('b', { style: { display: 'inline', fontSize: '11.5px' } }, value));
}

/* ------------------------------- horizontal bars ------------------------------ */
/**
 * items: [{ key, label, value, sub, color }]
 * Rendered as HTML rows (not SVG) so labels keep their true type size at any width.
 * Every row is direct-labelled - that is the relief for the low-contrast light steps.
 */
export function hbarList(items, opts = {}) {
  const { format = num, topN = 10, showOther = true, tipTitle = (i) => i.label, categorical = false } = opts;
  const sorted = opts.sort === false ? [...items] : [...items].sort((a, b) => b.value - a.value);
  let rows = sorted.slice(0, topN);
  if (showOther && sorted.length > topN) {
    const rest = sorted.slice(topN);
    rows = rows.concat([{ key: '__other', label: `Other (${rest.length})`,
      value: rest.reduce((s, r) => s + r.value, 0), color: 'var(--text-muted)' }]);
  }
  if (!rows.length) return h('div.tbl-empty', 'No data');
  const max = Math.max(1, ...rows.map((r) => r.value));

  const el = h('div.chart', { style: { display: 'grid', gap: '7px' } });
  rows.forEach((r) => {
    // One measure, one colour. Hue only carries meaning when `categorical` is set.
    const color = r.color || (categorical ? seriesColor(r.key || r.label) : 'var(--series-1)');
    const w = Math.max(1.5, (r.value / max) * 100);
    const row = h('div', {
      style: {
        display: 'grid', gridTemplateColumns: `${opts.labelWidth || 150}px 1fr auto`,
        alignItems: 'center', gap: '10px', cursor: opts.onSelect ? 'pointer' : 'default',
      },
      onmousemove: (e) => tooltip.show(h('div', h('b', tipTitle(r)), tipRow('Value', format(r.value)),
        r.sub ? tipRow('', r.sub) : null), e.clientX, e.clientY),
      onmouseleave: () => tooltip.hide(),
      onclick: () => opts.onSelect && r.key !== '__other' && opts.onSelect(r),
    },
      h('span.trunc', { style: { fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'right' }, title: r.label }, r.label),
      h('span', { style: { height: '16px', background: 'var(--surface-3)', borderRadius: '4px', overflow: 'hidden', display: 'block' } },
        h('i', { style: { display: 'block', height: '100%', width: `${w}%`, background: color, borderRadius: '4px' } })),
      h('span', { style: { fontSize: '11.5px', fontVariantNumeric: 'tabular-nums', minWidth: '78px', textAlign: 'right' } }, format(r.value))
    );
    el.append(row);
  });
  return el;
}

/* --------------------------------- usage meter -------------------------------- */
export function usageMeter(used, total, opts = {}) {
  const p = total > 0 ? (used / total) * 100 : 0;
  const color = p >= (opts.crit ?? 90) ? STATUS.critical : p >= (opts.warn ?? 80) ? STATUS.warning : STATUS.good;
  const el = h('div', { style: { display: 'grid', gap: '4px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11.5px' } },
      h('span.sec', opts.label || 'Disk'),
      h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${bytes(used)} / ${bytes(total)} · ${pct(p)}`)),
    h('div.bar-mini', { style: { height: opts.thick ? '10px' : '6px' } },
      h('i', { style: { width: `${Math.min(100, Math.max(1.5, p))}%`, background: color } }))
  );
  return el;
}

/* ------------------------------- time histogram ------------------------------- */
/** buckets: [{ t: epochMs, v: count }] */
export function timeHistogram(buckets, opts = {}) {
  const W = 1000, H = opts.height || 150;
  const padL = 46, padR = 8, padT = 8, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const el = h('div.chart');
  if (!buckets.length) return mount(el, h('div.tbl-empty', 'No documents in this range'));

  const max = Math.max(1, ...buckets.map((b) => b.v));
  const n = buckets.length;
  const slot = iw / n;
  const bw = Math.max(1, slot - 2); // 2px surface gap between adjacent bars

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', height: 'auto' } });

  // y grid, 3 lines, recessive
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  [...new Set(ticks)].forEach((tv) => {
    const y = padT + ih - (tv / max) * ih;
    s.append(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'grid-line' }),
             svg('text', { x: padL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'axis' }, ''));
  });
  const axis = svg('g', { class: 'axis' });
  [...new Set(ticks)].forEach((tv) => {
    const y = padT + ih - (tv / max) * ih;
    axis.append(svg('text', { x: padL - 8, y: y + 3.5, 'text-anchor': 'end' }, opts.formatY ? opts.formatY(tv) : num(tv)));
  });
  s.append(axis);

  const fmtX = opts.formatX || ((t) => new Date(t).toISOString().slice(5, 16).replace('T', ' '));
  const step = Math.max(1, Math.ceil(n / 7));
  const xa = svg('g', { class: 'axis' });
  buckets.forEach((b, i) => {
    if (i % step) return;
    xa.append(svg('text', { x: padL + i * slot + bw / 2, y: H - 6, 'text-anchor': 'middle' }, fmtX(b.t)));
  });
  s.append(xa);

  buckets.forEach((b, i) => {
    const bh = Math.max(b.v > 0 ? 2 : 0, (b.v / max) * ih);
    const x = padL + i * slot + (slot - bw) / 2;
    const rect = svg('rect', {
      x, y: padT + ih - bh, width: bw, height: bh, rx: Math.min(4, bw / 2),
      style: { fill: opts.color || 'var(--series-1)' },
    });
    const hit = svg('rect', {
      x: padL + i * slot, y: padT, width: slot, height: ih, style: { fill: 'transparent', cursor: 'crosshair' },
      onmousemove: (e) => tooltip.show(h('div', h('b', fmtX(b.t)), tipRow(opts.yLabel || 'Docs', num(b.v))), e.clientX, e.clientY),
      onmouseleave: () => tooltip.hide(),
      onclick: () => opts.onSelect && opts.onSelect(b),
    });
    s.append(rect, hit);
  });
  el.append(s);
  return el;
}

/* ------------------------------ coverage strip -------------------------------- */
/** days: [{ date:'YYYY-MM-DD', ok:boolean, count:number, detail?:string }] */
export function coverageStrip(days, opts = {}) {
  const el = h('div.chart');
  if (!days.length) return mount(el, h('div.tbl-empty', 'No snapshot history'));
  const cell = opts.cell || 15, gap = 4, perRow = opts.perRow || 40;
  const rows = Math.ceil(days.length / perRow);
  const W = perRow * (cell + gap), H = rows * (cell + gap);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, style: { height: `${H}px`, maxWidth: `${W}px` } });
  days.forEach((d, i) => {
    const cx = (i % perRow) * (cell + gap);
    const cy = Math.floor(i / perRow) * (cell + gap);
    const fill = d.ok ? (d.partial ? STATUS.warning : STATUS.good) : 'var(--surface-3)';
    s.append(svg('rect', {
      x: cx, y: cy, width: cell, height: cell, rx: 3,
      style: { fill, stroke: d.ok ? 'none' : 'var(--border-strong)', strokeWidth: 1 },
      onmousemove: (e) => tooltip.show(h('div', h('b', d.date),
        tipRow('Snapshots', num(d.count || 0)), d.detail ? tipRow('', d.detail) : null), e.clientX, e.clientY),
      onmouseleave: () => tooltip.hide(),
    }));
  });
  const first = days[0], last = days[days.length - 1];
  el.append(s, h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10.5px',
    color: 'var(--text-muted)', maxWidth: `${W}px`, marginTop: '4px' } },
    h('span', first.date), h('span', last.date)),
    h('div.legend',
    h('span', h('i', { style: { background: STATUS.good } }), 'Covered'),
    h('span', h('i', { style: { background: STATUS.warning } }), 'Partial / failed'),
    h('span', h('i', { style: { background: 'var(--surface-3)', border: '1px solid var(--border-strong)' } }), 'No snapshot')));
  return el;
}

export function legend(entries) {
  return h('div.legend', ...entries.map((e) => h('span', h('i', { style: { background: e.color } }), e.label)));
}

/* ------------------------------ capacity chart -------------------------------- */

/**
 * "Does it fit?" — requirements drawn against the capacity that has to hold them.
 *
 * A column of numbers makes you do the comparison yourself; bars on a shared scale with
 * the capacity marked make it one glance. A bar that overruns the marker is drawn in the
 * critical colour and says by how much, because that is the whole question.
 *
 * @param capacity  { value, label } — the line everything is measured against
 * @param needs     [{ label, value, sub }] — what has to fit inside it
 * @param opts      { format, labelWidth, capacityUnknown }
 */
export function capacityChart(capacity, needs, opts = {}) {
  const format = opts.format || bytes;
  const cap = Number(capacity && capacity.value) || 0;
  const rows = (needs || []).filter((n) => Number.isFinite(n.value) && n.value !== null);
  if (!rows.length) return h('div.tbl-empty', 'Nothing to compare yet');

  // The scale has to cover the capacity as well as the largest requirement, or a
  // requirement that overruns would be drawn as though it fitted.
  const max = Math.max(1, cap, ...rows.map((r) => r.value));
  const pos = (v) => Math.min(100, (v / max) * 100);

  const el = h('div.chart.cap-chart', { style: { display: 'grid', gap: '7px' } });

  rows.forEach((r) => {
    const fits = opts.capacityUnknown ? null : r.value <= cap;
    const color = fits === null ? 'var(--series-1)' : fits ? 'var(--good)' : 'var(--critical)';
    const over = fits === false ? r.value - cap : 0;

    el.append(h('div.cap-row', {
      style: { display: 'grid', gridTemplateColumns: `${opts.labelWidth || 170}px 1fr auto`,
               alignItems: 'center', gap: '10px' },
      title: r.sub || '',
    },
      h('span.trunc.cap-label', { style: { fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'right' }, title: r.label }, r.label),
      // The track carries the capacity marker, so every bar is read against the same line.
      h('span', { style: { position: 'relative', height: '16px', background: 'var(--surface-3)',
                           borderRadius: '4px', display: 'block' } },
        h('i', { style: { display: 'block', height: '100%', width: `${Math.max(1.5, pos(r.value))}%`,
                          background: color, borderRadius: '4px' } }),
        opts.capacityUnknown ? null : h('i', {
          title: `${capacity.label || 'capacity'}: ${format(cap)}`,
          style: { position: 'absolute', top: '-3px', bottom: '-3px', left: `${pos(cap)}%`,
                   width: '2px', background: 'var(--text-primary)', opacity: '.7', borderRadius: '1px' },
        })),
      h('span', { style: { fontSize: '11.5px', fontVariantNumeric: 'tabular-nums', minWidth: '150px', textAlign: 'right', display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
        h('span', format(r.value)),
        h('span.cap-verdict', over > 0
          ? h('span', { style: { color: 'var(--critical)', fontWeight: 640 } }, `short ${format(over)}`)
          : fits === true ? h('span', { style: { color: 'var(--good)' } }, 'fits') : null))));
  });

  if (!opts.capacityUnknown) {
    el.append(h('div.legend',
      h('span', h('i', { style: { background: 'var(--text-primary)', opacity: '.7', width: '2px' } }),
        `${capacity.label || 'capacity'} — ${format(cap)}`),
      h('span', h('i', { style: { background: 'var(--good)' } }), 'fits'),
      h('span', h('i', { style: { background: 'var(--critical)' } }), 'does not fit')));
  }
  return el;
}
