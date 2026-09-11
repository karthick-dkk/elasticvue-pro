/** Shared page pieces. */
import { h, mount } from '../lib/dom.js';
import { healthClass, diskClass, bytes, pct, ago, dt } from '../lib/fmt.js';
import { state, client, refreshAll } from '../core/state.js';
import { idb } from '../lib/idb.js';
import { confirmDialog } from '../ui/modal.js';
import { showCredentialDialog } from '../ui/credential-dialog.js';
import { diagnoseCluster } from '../core/diagnose.js';
import { trustCert, untrustCert, trustHostKey, untrustHostKey, tunnelSecret, tunnelReconnect } from '../core/es.js';

export function card(title, sub, body, actions) {
  return h('section.card',
    h('header', h('h2', title), sub ? h('span.sub', sub) : null,
      actions ? h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } }, actions) : null),
    h('div.body', body));
}

/**
 * A card the operator can fold away.
 *
 * The charts and coverage strips are useful but tall; left open they push the table
 * that people actually work in below the fold. Secondary panels start folded, and the
 * choice is remembered per panel so it only has to be made once.
 */
const foldState = new Map();

export function collapsible(title, sub, bodyFn, opts = {}) {
  const key = `fold:${opts.key || title}`;
  const openByDefault = opts.open !== undefined ? opts.open : false;
  const isOpen = foldState.has(key) ? foldState.get(key) : openByDefault;

  const body = h('div.body', { hidden: !isOpen }, isOpen ? bodyFn() : null);
  const chevron = h('span', { style: { display: 'inline-block', width: '11px', fontSize: '10px' } },
    isOpen ? '▾' : '▸');
  // The hint used to read "click to fold" whichever way the panel was, so a folded card
  // invited you to fold it again. It moves with the chevron, from one place, so the two
  // cannot disagree.
  const hint = h('span.muted', { style: { marginLeft: 'auto', fontSize: '11px' } },
    isOpen ? 'click to fold' : 'click to open');

  const show = (open) => {
    body.hidden = !open;
    chevron.textContent = open ? '▾' : '▸';
    hint.textContent = open ? 'click to fold' : 'click to open';
  };

  const toggle = () => {
    const next = body.hidden;                    // hidden now => we are opening it
    if (next && !body.firstChild) mount(body, bodyFn());   // build on first open
    show(next);
    foldState.set(key, next);
    idb.setKV(key, next).catch(() => {});
  };

  // Restore the remembered choice; the first paint uses the default so nothing jumps.
  idb.getKV(key).then((v) => {
    if (v === undefined || v === null || v === !body.hidden) return;
    foldState.set(key, v);
    if (v && !body.firstChild) mount(body, bodyFn());
    show(v);
  }).catch(() => {});

  return h('section.card',
    h('header', { style: { cursor: 'pointer', userSelect: 'none' }, onclick: toggle },
      chevron, h('h2', title), sub ? h('span.sub', sub) : null, hint),
    body);
}

export function pill(text, cls) {
  return h(`span.pill.${cls || healthClass(text)}`, h('i.dot'), String(text || 'unknown'));
}

export function statTile(k, v, d) {
  return h('div.stat', h('div.k', k), h('div.v', v), d ? h('div.d', d) : null);
}

export function empty(msg) { return h('div.tbl-empty', msg); }

export function table(headers, rows, opts = {}) {
  const thead = h('thead', h('tr', ...headers.map((c) =>
    h('th', { class: c.num ? 'num' : '', style: c.width ? { width: c.width } : null }, c.label || c))));
  const tbody = h('tbody');
  if (!rows.length) tbody.append(h('tr', h('td', { colspan: headers.length }, empty(opts.emptyText || 'Nothing to show'))));
  rows.forEach((r) => tbody.append(r));
  return h('div.tbl-wrap', h('table.tbl', thead, tbody));
}

/** Connection trouble banner with the self-signed-certificate escape hatch. */
/**
 * Connection problem banner. The core reports exactly what went wrong, and for the two
 * cases that need a human decision — an unknown certificate, an unknown jump-host key —
 * the decision is taken right here and the request retried.
 */
export function connectionBanner(cluster, onRetry) {
  const cl = client(cluster.id);
  const err = (cl && cl.lastError) || {};
  const kind = err.kind || '';
  const auth = cl && cl.state === 'auth_error';
  const out = h('div', { style: { display: 'grid', gap: '0' } });

  async function act(btn, fn) {
    btn.disabled = true; const t = btn.textContent; btn.textContent = 'Working…';
    try { await fn(); } finally { btn.disabled = false; btn.textContent = t; }
  }

  let title, cls = 'err', body = null, actions = [];
  const help = err.help ? h('div.sec', { style: { fontSize: '12px', marginTop: '5px' } }, err.help) : null;

  if (auth) {
    cls = 'warn'; title = 'authentication failed';
    actions.push(h('button.btn.sm.primary', { onclick: () => showCredentialDialog('auth_error') }, 'Enter credentials…'));
  } else if (kind === 'tls_untrusted' || kind === 'tls_pin_mismatch') {
    const c = err.cert || {};
    cls = 'warn';
    title = kind === 'tls_untrusted' ? 'certificate not trusted yet' : 'certificate CHANGED since it was pinned';
    body = h('div', { style: { marginTop: '6px', display: 'grid', gap: '3px', fontSize: '12px' } },
      kv('Subject', c.subject), kv('Issuer', c.self_signed ? `${c.issuer} (self-signed)` : c.issuer),
      kv('Valid', c.not_before && c.not_after ? `${c.not_before} → ${c.not_after}` : '–'),
      c.sans && c.sans.length ? kv('SAN', c.sans.join(', ')) : null,
      kv('SHA-256', c.sha256, true),
      err.pinned ? kv('Pinned', err.pinned, true) : null,
      help);
    if (kind === 'tls_untrusted') {
      actions.push(h('button.btn.sm.primary', {
        title: 'Pin exactly this certificate for this address. A different certificate will be refused later.',
        onclick: (e) => act(e.target, async () => { await trustCert(c.host, c.sha256); await refreshAll({ force: true }); }),
      }, 'Trust this certificate'));
    } else {
      actions.push(h('button.btn.sm.danger', {
        title: 'Only if the certificate was rotated on purpose.',
        onclick: (e) => act(e.target, async () => {
          const ok = await confirmDialog(`Replace the pinned certificate for ${c.host}?`,
            `Old  ${err.pinned}\nNew  ${c.sha256}\n\n` +
            'Do this only if you know the certificate was rotated on purpose. If it was not, ' +
            'something is sitting between you and this cluster.',
            { yes: 'replace the pin', danger: true });
          if (!ok) return;
          await untrustCert(c.host); await trustCert(c.host, c.sha256); await refreshAll({ force: true });
        }),
      }, 'Replace pin with the new certificate'));
    }
  } else if (kind === 'tunnel_error') {
    const tk = err.tunnelKind || '';
    const hk = err.hostKey || {};
    const jumpId = (err.tunnel && err.tunnel.id) || hk.jumpId || cluster.via;
    cls = 'warn';
    title = `jump host ${jumpId || ''} — ${String(tk || 'error').replace(/_/g, ' ')}`;
    body = h('div', { style: { marginTop: '6px', display: 'grid', gap: '4px', fontSize: '12px' } },
      err.tunnel ? kv('SSH', `${err.tunnel.user}@${err.tunnel.host}:${err.tunnel.port}`) : null,
      err.tunnel && err.tunnel.keyFile ? kv('Key file', err.tunnel.keyFile, true) : null,
      hk.fingerprint ? kv(hk.pinned ? 'Offered key' : 'Host key', `${hk.keyType} ${hk.fingerprint}`, true) : null,
      hk.pinned ? kv('Pinned key', hk.pinned, true) : null,
      help);
    if (tk === 'hostkey_unknown') {
      actions.push(h('button.btn.sm.primary', {
        title: 'Pin this host key. Verify it out-of-band first: ssh-keygen -lf on the jump host.',
        onclick: (e) => act(e.target, async () => { await trustHostKey(jumpId, hk.fingerprint); await refreshAll({ force: true }); }),
      }, 'Trust this host key'));
    } else if (tk === 'hostkey_mismatch') {
      actions.push(h('button.btn.sm.danger', {
        onclick: (e) => act(e.target, async () => {
          const ok = await confirmDialog(`Replace the pinned SSH host key for ${jumpId}?`,
            `Offered  ${hk.keyType || ''} ${hk.fingerprint || ''}\nPinned    ${hk.pinned || ''}\n\n` +
            'Do this only if the jump host was reinstalled or rekeyed on purpose. Otherwise the ' +
            'host you are reaching is not the one you pinned.',
            { yes: 'replace the key', danger: true });
          if (!ok) return;
          await untrustHostKey(jumpId); await trustHostKey(jumpId, hk.fingerprint); await refreshAll({ force: true });
        }),
      }, 'Replace pinned host key'));
    } else if (tk === 'passphrase_needed' || tk === 'passphrase_wrong') {
      const inp = h('input', { type: 'password', placeholder: 'key passphrase', autocomplete: 'off', style: { width: '180px' },
        onkeydown: (e) => { if (e.key === 'Enter') e.target.nextSibling.click(); } });
      actions.push(inp, h('button.btn.sm.primary', {
        onclick: (e) => act(e.target, async () => { await tunnelSecret(jumpId, { passphrase: inp.value }); inp.value = ''; await refreshAll({ force: true }); }),
      }, 'Unlock key'));
    } else if (tk === 'no_auth' || tk === 'auth_failed' || tk === 'key_unreadable') {
      const inp = h('input', { type: 'password', placeholder: `password for ${(err.tunnel && err.tunnel.user) || 'user'}`, autocomplete: 'off', style: { width: '200px' },
        onkeydown: (e) => { if (e.key === 'Enter') e.target.nextSibling.click(); } });
      actions.push(inp, h('button.btn.sm', {
        title: 'Session only — never written to disk.',
        onclick: (e) => act(e.target, async () => { await tunnelSecret(jumpId, { password: inp.value }); inp.value = ''; await refreshAll({ force: true }); }),
      }, 'Use a password instead'));
    } else {
      actions.push(h('button.btn.sm', { onclick: (e) => act(e.target, async () => { await tunnelReconnect(jumpId); await onRetry(); }) }, 'Reconnect tunnel'));
    }
  } else if (kind === 'blocked_readonly') {
    cls = 'warn'; title = 'blocked by read-only mode';
  } else {
    title = kind ? String(kind).replace(/_/g, ' ') : 'unreachable';
    body = help;
  }

  async function runDiagnosis(btn) {
    await act(btn, async () => {
      let d;
      try { d = await diagnoseCluster(cluster); }
      catch (e) { d = { steps: [], verdict: 'error', title: 'Diagnosis failed', detail: e.message, fix: '' }; }
      const panel = out.querySelector('.diag');
      const node = h('div.diag', { style: { marginTop: '-6px', marginBottom: '14px' } },
        h('div.card', h('div.body', { style: { display: 'grid', gap: '9px' } },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h(`span.pill.${d.verdict === 'ok' ? 'green' : /tls|scheme/.test(d.verdict) ? 'yellow' : 'red'}`, h('i.dot'), String(d.verdict).replace('_', ' ')),
            h('b', d.title)),
          h('div.sec', { style: { fontSize: '12.5px', lineHeight: '1.55' } }, d.detail),
          h('div', { style: { display: 'grid', gap: '3px' } },
            ...d.steps.map((st) => h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11.5px' } },
              h(`span.pill.${st.ok ? 'green' : 'red'}`, h('i.dot'), st.ok ? 'answered' : 'no answer'),
              h('span.mono.trunc', { style: { maxWidth: '520px' }, title: st.label }, st.label),
              h('span.muted', st.detail)))),
          d.fix && !/CA|trust store|policy/i.test(d.fix) ? h('div', { style: { fontSize: '12.5px', borderLeft: '2px solid var(--accent)', paddingLeft: '10px' } }, h('b', 'Next step: '), d.fix) : null,
          h('div', h('button.btn.sm', { onclick: onRetry }, 'Recheck')))));
      if (panel) panel.replaceWith(node); else out.append(node);
    });
  }

  const banner = h(`div.banner.${cls}`,
    h('div', { style: { minWidth: 0 } },
      h('div.ttl', `${cluster.name} — ${title}`),
      h('div.sec', { style: { fontSize: '12px' } }, err.message || 'No response from the cluster.'),
      h('div.mono.muted', { style: { fontSize: '11px', marginTop: '2px' } }, cluster.url + (cluster.via ? `  (via ${cluster.via})` : '')),
      body),
    h('div.acts', { style: { flexWrap: 'wrap' } },
      ...actions,
      h('button.btn.sm', { onclick: (e) => runDiagnosis(e.target) }, 'Diagnose'),
      h('button.btn.sm', { onclick: onRetry }, 'Retry')));

  out.append(banner);
  return out;
}

function kv(k, v, mono = false) {
  if (!v) return null;
  return h('div', { style: { display: 'flex', gap: '8px' } },
    h('span.muted', { style: { width: '78px', flex: 'none' } }, k),
    h(mono ? 'span.mono' : 'span', { style: { wordBreak: 'break-all', fontSize: mono ? '11px' : '12px' } }, v));
}

export function diskCell(d) {
  if (!d || !isFinite(d.percent)) return h('span.muted', '–');
  const cls = diskClass(d.percent, state.defaults.diskWarnPercent, state.defaults.diskCritPercent);
  const color = cls === 'red' ? 'var(--critical)' : cls === 'yellow' ? 'var(--warning)' : 'var(--good)';
  return h('div', { style: { display: 'grid', gap: '3px', minWidth: '150px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11.5px' } },
      h('span', pct(d.percent, 1)), h('span.muted', `${bytes(d.used)} / ${bytes(d.total)}`)),
    h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, d.percent))}%`, background: color } })));
}

export function lastSnapshotOf(data) {
  let best = null;
  Object.entries(data.snapshots || {}).forEach(([repo, list]) => {
    (list || []).forEach((s) => { if (!best || s.start > best.start) best = { ...s, repo }; });
  });
  return best;
}

export function snapshotPill(s) {
  if (!s) return pill('none', 'grey');
  const st = String(s.status || '').toUpperCase();
  const cls = st === 'SUCCESS' ? 'green' : st === 'PARTIAL' ? 'yellow' : st === 'IN_PROGRESS' ? 'yellow' : st === 'FAILED' ? 'red' : 'grey';
  return h('div', { style: { display: 'grid', gap: '2px' } },
    pill(st || 'unknown', cls),
    h('span.muted', { style: { fontSize: '11px' }, title: dt(s.start) }, `${ago(s.start)} · ${s.repo || ''}`));
}
