/**
 * Sign in, and the first-run screen that creates the first administrator.
 *
 * Only the installed and hosted builds ever reach this. The portable build has no
 * accounts at all — see `Edition` in crates/espro-core/src/auth.rs — so `authState()`
 * reports `required: false` there and the app boots straight into the dashboard exactly
 * as it always did.
 *
 * This is a full-screen gate rather than a modal on purpose: until there is a session
 * there is nothing behind it worth looking at, and a dismissible dialog in front of an
 * empty app invites people to try dismissing it.
 */

import { h, mount } from '../lib/dom.js';
import { bridge, setSession } from '../core/transport.js';

const MIN_PASSWORD = 10;   // must match auth::MIN_PASSWORD

/** What the core says about accounts on this build. */
export async function authState() {
  const res = await bridge({ type: 'WHOAMI' });
  if (!res || res.ok !== true) return { required: false, bootstrap: false, caller: null };
  return {
    required: !!res.authRequired,
    bootstrap: !!res.needsBootstrap,
    apiTokens: !!res.apiTokens,
    edition: res.edition || 'portable',
    caller: res.caller || null,
  };
}

export async function signOut() {
  await bridge({ type: 'LOGOUT' });
  setSession('');
}

/**
 * Draw the gate into `root` and resolve once somebody is signed in.
 *
 * Resolves with the caller, so the shell can render a role-appropriate UI without asking
 * again.
 */
export function loginScreen(root, { bootstrap = false } = {}) {
  return new Promise((resolve) => {
    let busy = false;
    let error = '';
    let mode = bootstrap ? 'bootstrap' : 'login';

    const submit = async () => {
      if (busy) return;
      const name = (document.getElementById('login-name') || {}).value || '';
      const password = (document.getElementById('login-pw') || {}).value || '';
      const confirm = (document.getElementById('login-pw2') || {}).value || '';

      if (!name.trim()) { error = 'Enter a user name.'; return draw(); }
      if (mode === 'bootstrap') {
        if (password.length < MIN_PASSWORD) {
          error = `The password must be at least ${MIN_PASSWORD} characters.`;
          return draw();
        }
        if (password !== confirm) { error = 'The two passwords do not match.'; return draw(); }
      }

      busy = true; error = ''; draw();
      const res = await bridge({
        type: mode === 'bootstrap' ? 'BOOTSTRAP_ADMIN' : 'LOGIN',
        name: name.trim(),
        password,
      });
      busy = false;

      if (res && res.ok && res.session) {
        setSession(res.session);
        return resolve(res.caller || { name: name.trim(), role: 'admin' });
      }
      error = (res && res.message) || 'Sign-in failed.';
      draw();
      const pw = document.getElementById('login-pw');
      if (pw) { pw.value = ''; pw.focus(); }
    };

    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };

    function draw() {
      const first = mode === 'bootstrap';
      mount(root, h('div.setup',
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' } },
          h('img', { src: 'icons/icon48.png', width: 34, height: 34, alt: '' }),
          h('div',
            h('h2', 'ElasticVue Pro'),
            h('div.muted', { style: { fontSize: '12.5px' } },
              first
                ? 'No accounts exist yet. Create the administrator for this installation.'
                : 'Sign in to continue.'))),

        error ? h('div.banner.err', { role: 'alert' }, h('div', h('div.ttl', first ? 'Could not create the account' : 'Could not sign in'), h('div', error))) : null,

        h('div.card', h('div.body',
          h('label.field',
            h('span', 'User name'),
            h('input#login-name', {
              type: 'text', autocomplete: 'username', autofocus: true,
              spellcheck: 'false', autocapitalize: 'none', onkeydown: onKey,
            })),
          h('label.field', { style: { marginTop: '10px' } },
            h('span', first ? 'Password' : 'Password'),
            h('input#login-pw', {
              type: 'password',
              autocomplete: first ? 'new-password' : 'current-password',
              onkeydown: onKey,
            }),
            first ? h('span.sec', { style: { fontSize: '11.5px' } },
              `At least ${MIN_PASSWORD} characters. It is stored only as a PBKDF2 hash and cannot be recovered — if it is lost, delete users.json to start again.`) : null),
          first
            ? h('label.field', { style: { marginTop: '10px' } },
                h('span', 'Repeat the password'),
                h('input#login-pw2', { type: 'password', autocomplete: 'new-password', onkeydown: onKey }))
            : null,

          h('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', alignItems: 'center' } },
            h('button.btn.primary', { disabled: busy, onclick: submit },
              busy ? 'Working…' : (first ? 'Create administrator' : 'Sign in')),
            first
              ? h('span.muted', { style: { fontSize: '11.5px' } }, 'This account can manage every other one.')
              : null))),

        first
          ? h('div.banner', { style: { marginTop: '14px' } },
              h('div',
                h('div.ttl', 'What the three roles can do'),
                h('div',
                  h('div', h('b', 'admin'), ' — everything, and the only role that can write to a cluster.'),
                  h('div', h('b', 'user'), ' — read-only across every page.'),
                  h('div', h('b', 'guest'), ' — the dashboard only. No index names, because those tend to carry customer and project names.'))))
          : null,
      ));
      const el = document.getElementById('login-name');
      if (el && !busy) el.focus();
    }

    draw();
  });
}
