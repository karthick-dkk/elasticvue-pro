/**
 * Page — accounts: who can sign in, and what they may do.
 *
 * Admin only, and the core enforces that independently — every message this page sends
 * is refused for anyone else regardless of whether the tab was rendered. See
 * `required_role()` in crates/espro-core/src/auth.rs.
 *
 * API tokens appear only on the hosted build. The desktop app talks to its core over
 * local IPC and has no socket to serve an API on, so offering to mint a token there would
 * be offering something that cannot be used.
 */

import { h, mount } from '../lib/dom.js';
import { bridge } from '../core/transport.js';
import { card, pill, statTile, empty, table } from './common.js';
import { modal, field, text, select, val, confirmDialog } from '../ui/modal.js';

const MIN_PASSWORD = 10;   // must match auth::MIN_PASSWORD

let host = null;
const ui = { users: [], tokens: [], caller: null, apiTokens: false, err: '', freshSecret: null };

export function render(el) {
  host = el;
  el.classList.add('dense');
  draw();
  load();
}
export function onData() { /* accounts do not change when cluster data does */ }

async function load() {
  const who = await bridge({ type: 'WHOAMI' });
  ui.caller = (who && who.caller) || null;
  ui.apiTokens = !!(who && who.apiTokens);

  const res = await bridge({ type: 'USER_LIST' });
  if (res && res.ok) { ui.users = res.users || []; ui.err = ''; }
  else ui.err = (res && res.message) || 'Could not read the account list.';

  if (ui.apiTokens) {
    const t = await bridge({ type: 'TOKEN_LIST' });
    ui.tokens = (t && t.ok && t.tokens) || [];
  }
  draw();
}

const ROLE_HELP = {
  admin: 'Everything, and the only role that can write to a cluster.',
  user: 'Read-only across every page.',
  guest: 'The dashboard only — no index names.',
};

function roleCell(role) {
  const cls = role === 'admin' ? 'red' : role === 'user' ? '' : 'grey';
  return h('span', { title: ROLE_HELP[role] || '' }, pill(role, cls));
}

function draw() {
  if (!host || !host.isConnected) return;
  const admins = ui.users.filter((u) => u.role === 'admin' && !u.disabled).length;

  mount(host,
    ui.err ? h('div.banner.err', { role: 'alert' }, h('div', h('div.ttl', 'Accounts'), h('div', ui.err))) : null,

    h('div.grid.c4', { style: { marginBottom: '10px' } },
      statTile('Accounts', String(ui.users.length), 'who can sign in'),
      statTile('Administrators', String(admins), admins === 1 ? 'the only one — cannot be removed' : 'full control'),
      statTile('Read-only', String(ui.users.filter((u) => u.role === 'user').length), 'every page, no writes'),
      statTile('Guests', String(ui.users.filter((u) => u.role === 'guest').length), 'dashboard only')),

    h('div.toolbar',
      h('button.btn.sm.primary', { onclick: () => editUser(null) }, '+ New account'),
      h('button.btn.sm', { onclick: load }, '↻ Reload'),
      h('div', { style: { marginLeft: 'auto' } },
        h('span.muted', { style: { fontSize: '11px' } },
          ui.caller ? `signed in as ${ui.caller.name}` : ''))),

    h('div', { style: { marginTop: '10px' } },
      card('Accounts', `${ui.users.length} on this installation`,
        table(['Name', 'Role', 'Created', ''], ui.users.map((u) => h('tr',
          h('td', h('b', u.name), u.disabled ? h('span.muted', { style: { marginLeft: '6px', fontSize: '11px' } }, '(disabled)') : null),
          h('td', roleCell(u.role)),
          h('td.muted', { style: { fontSize: '11.5px' } }, u.createdAt ? new Date(u.createdAt * 1000).toISOString().slice(0, 10) : ''),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            h('button.btn.sm', { onclick: () => editUser(u) }, 'Edit'),
            h('button.btn.sm.ghost', { style: { marginLeft: '6px' }, onclick: () => setPassword(u) }, 'Password'),
            h('button.btn.sm.ghost', {
              style: { marginLeft: '6px' },
              title: isSelf(u) ? 'You cannot remove the account you are signed in as' : `Remove ${u.name}`,
              disabled: isSelf(u),
              onclick: () => removeUser(u),
            }, '×')))),
          { emptyText: 'No accounts yet.' }))),

    ui.apiTokens ? tokensCard() : notHostedNote(),
  );
}

function isSelf(u) {
  return !!(ui.caller && u.name.toLowerCase() === String(ui.caller.name).toLowerCase());
}

function notHostedNote() {
  return h('div', { style: { marginTop: '10px' } },
    h('div.banner',
      h('div',
        h('div.ttl', 'API tokens are not available on this build'),
        h('div',
          'A token is only useful to something that can make an HTTP request to this core. '
          + 'The desktop app talks to its core over local IPC and has no socket to serve one on, '
          + 'so tokens — including the one Zabbix would use — belong to the hosted deployment.'))));
}

function tokensCard() {
  return h('div', { style: { marginTop: '10px' } },
    ui.freshSecret
      ? h('div.banner', { style: { marginBottom: '10px' }, role: 'alert' },
          h('div',
            h('div.ttl', `Token "${ui.freshSecret.name}" created — copy it now`),
            h('div', { style: { marginBottom: '6px' } },
              'This is the only time it is shown. It is stored as a hash, so it cannot be shown again.'),
            h('code.inline', { style: { userSelect: 'all', wordBreak: 'break-all' } }, ui.freshSecret.secret),
            h('div', { style: { marginTop: '8px' } },
              h('button.btn.sm', { onclick: () => { ui.freshSecret = null; draw(); } }, 'I have copied it'))))
      : null,
    card('API tokens', 'for Zabbix and scripts — not people',
      table(['Name', 'Role', 'Created', 'Last used', ''], ui.tokens.map((t) => h('tr',
        h('td', h('b', t.name)),
        h('td', roleCell(t.role)),
        h('td.muted', { style: { fontSize: '11.5px' } }, t.createdAt ? new Date(t.createdAt * 1000).toISOString().slice(0, 10) : ''),
        h('td.muted', { style: { fontSize: '11.5px' } }, t.lastUsed ? new Date(t.lastUsed * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never'),
        h('td', { style: { textAlign: 'right' } },
          h('button.btn.sm.ghost', { onclick: () => revokeToken(t) }, 'Revoke')))),
        { emptyText: 'No tokens yet.' }),
      h('button.btn.sm.primary', { onclick: newToken }, '+ New token')));
}

/* ---------------------------------- actions ---------------------------------- */

function editUser(existing) {
  const isNew = !existing;
  modal(
    isNew ? 'New account' : `Edit ${existing.name}`,
    isNew ? 'They sign in with this name and password.' : 'Changing the role signs them out immediately.',
    [
      isNew ? field('User name', text('acct-name', '')) : null,
      isNew
        ? field('Password', text('acct-pw', '', { type: 'password' }), `At least ${MIN_PASSWORD} characters.`)
        : null,
      field('Role', select('acct-role', existing ? existing.role : 'user', [
        ['admin', 'admin — everything, and the only role that can write'],
        ['user', 'user — read-only across every page'],
        ['guest', 'guest — the dashboard only, no index names'],
      ])),
    ].filter(Boolean),
    (ctx) => [
      h('button.btn', { onclick: () => ctx.done(false) }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          const name = isNew ? val('acct-name') : existing.name;
          const role = val('acct-role');
          const res = isNew
            ? await bridge({ type: 'USER_ADD', name, password: val('acct-pw'), role })
            : await bridge({ type: 'USER_SET_ROLE', name, role });
          if (!res || !res.ok) { ui.err = (res && res.message) || 'Failed.'; draw(); return; }
          ctx.done(true);
          await load();
        },
      }, isNew ? 'Create' : 'Save'),
    ],
  );
}

function setPassword(u) {
  modal(`New password for ${u.name}`,
    isSelf(u) ? 'You stay signed in.' : 'They are signed out of any session they have open.',
    [field('Password', text('acct-newpw', '', { type: 'password' }), `At least ${MIN_PASSWORD} characters.`)],
    (ctx) => [
      h('button.btn', { onclick: () => ctx.done(false) }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          const res = await bridge({ type: 'USER_SET_PASSWORD', name: u.name, password: val('acct-newpw') });
          if (!res || !res.ok) { ui.err = (res && res.message) || 'Failed.'; draw(); return; }
          ctx.done(true);
          await load();
        },
      }, 'Set password'),
    ]);
}

async function removeUser(u) {
  if (!(await confirmDialog(`Remove the account "${u.name}"?`,
    'They are signed out at once and can no longer sign in. Nothing they did is undone.',
    { yes: 'remove', danger: true }))) return;
  const res = await bridge({ type: 'USER_REMOVE', name: u.name });
  if (!res || !res.ok) ui.err = (res && res.message) || 'Failed.';
  await load();
}

function newToken() {
  modal('New API token', 'For Zabbix or a script. A token can never be an administrator.',
    [
      field('Name', text('tok-name', ''), 'How you will recognise it later, e.g. "zabbix".'),
      field('Role', select('tok-role', 'guest', [
        ['guest', 'guest — cluster health only'],
        ['user', 'user — read-only across every page'],
      ]), 'The automation scrape needs "user"; a health-only dashboard needs "guest".'),
      field('Expires after (days)', text('tok-ttl', '', { type: 'number' }), 'Leave blank for no expiry.'),
    ],
    (ctx) => [
      h('button.btn', { onclick: () => ctx.done(false) }, 'Cancel'),
      h('button.btn.primary', {
        onclick: async () => {
          const ttl = Number(val('tok-ttl'));
          const res = await bridge({
            type: 'TOKEN_CREATE',
            name: val('tok-name'),
            role: val('tok-role'),
            ...(ttl > 0 ? { expiresDays: ttl } : {}),
          });
          if (!res || !res.ok) { ui.err = (res && res.message) || 'Failed.'; draw(); return; }
          ui.freshSecret = { name: val('tok-name'), secret: res.secret };
          ctx.done(true);
          await load();
        },
      }, 'Create token'),
    ]);
}

async function revokeToken(t) {
  if (!(await confirmDialog(`Revoke the token "${t.name}"?`,
    'Anything using it stops working at once. A revoked token cannot be restored.',
    { yes: 'revoke', danger: true }))) return;
  const res = await bridge({ type: 'TOKEN_REVOKE', id: t.id });
  if (!res || !res.ok) ui.err = (res && res.message) || 'Failed.';
  await load();
}
