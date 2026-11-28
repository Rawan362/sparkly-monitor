// Run with:  node --test tests/*.test.mjs
// Devices linked with a code (no login): the Seller Sessions door's three no-login actions (claimLinked, heartbeatLinked, logoutLinked).
// Sessions have no older direct path, so "fall back" means "do nothing, as before". The door is faked by the test (vm, no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function blockOf(name) {
  const a = html.indexOf('// <' + name + ':js:start>');
  const b = html.indexOf('// <' + name + ':js:end>');
  assert.ok(a > 0 && b > a, name + ' block missing');
  return html.slice(a, b);
}
function codeOf(head) {
  const a = html.indexOf(head);
  assert.ok(a > 0, head + ' missing');
  const m = /\n\}[;]?\n/.exec(html.slice(a));
  assert.ok(m, head + ' end missing');
  return html.slice(a, a + m.index + m[0].length);
}
const SESS_CALL = codeOf('async function w1SessionsCall(');
const LOGOUT = codeOf('window.logout = function');

test('the new code and this test file contain only ASCII characters', () => {
  const files = { block: blockOf('w4-sessions-linked'), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and the logged-in session calls are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 320);
  for (const old of ["w1SessionsCall('ensure'", "w1SessionsCall('list'", "w1SessionsCall('signOutDevice'", "w1SessionsCall('heartbeat'", "w1SessionsPost(authToken, 'logout'"]) assert.ok(html.includes(old), old);
});

test('every inline script parses and every style block has balanced braces', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type=["'](application\/json|application\/ld\+json|text\/template)/.test(m[1]));
  assert.ok(scripts.length > 0);
  for (const m of scripts) new vm.Script(m[2]);
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const css = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
  }
});

test('the sign-in after an approved code registers the device (not awaited), and the flag is cleared at sign out', () => {
  const a = html.indexOf('applyLinkedSeller(rows[0].seller_id);');
  assert.ok(a > 0);
  assert.ok(html.slice(a, a + 300).includes('w4ClaimLinked(code);'));
  assert.ok(!/await w4ClaimLinked/.test(html));
  assert.ok(html.includes("'sparkly_session_linked'];"));
});

const URL_ = 'https://sparklly.site/webhook/seller-sessions';
/** over.door(body) answers { status, body } or throws; over.login: the device has a login token; over.store: starting local storage. */
function world(over = {}) {
  const calls = { door: [], post: [], reload: 0 };
  const store = Object.assign({}, over.store || {});
  const sandbox = {
    calls, JSON, Date, Object, Array, String, Promise, Error, Math, crypto: { randomUUID: () => 'uuid-new' }, window: { crypto: { randomUUID: () => 'uuid-new' } },
    SELLER_SESSIONS_URL: URL_, W1_SESSW_FLAG: 'sparkly_session_token_registered',
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    getValidAuthToken: async () => (over.login ? 'login-token' : null),
    w1StoredLoginToken: () => (over.login ? 'login-token' : null),
    w1SessionsPost: async (t, a, x, k) => { calls.post.push({ t, a, x, k }); return { ok: true, via: 'login' }; },
    detectDeviceLabel: () => 'Chrome on Android', clearAllAuthStorage() {}, location: { reload() { calls.reload++; } },
  };
  sandbox.store = store;
  sandbox.fetch = async (url, init) => {
    assert.equal(url, URL_);
    const body = JSON.parse(init.body);
    calls.door.push({ body, keepalive: init.keepalive });
    const a = over.door ? over.door(body) : { status: 503, body: {} };
    return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => { if (a.badJson) throw new Error('x'); return a.body; } };
  };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w4-sessions-linked').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var '), sandbox);
  vm.runInContext(SESS_CALL + '\n' + LOGOUT.replace(/^window\.logout = /, 'var logout = '), sandbox);
  return sandbox;
}
const ok = (extra = {}) => ({ body: { ok: true, ...extra } });
const DO_NOTHING = [
  ['503', { status: 503, body: { ok: false, error: 'not_ready' } }],
  ['404', { status: 404, body: {} }],
  ['502', { status: 502, body: {} }],
  ['not_available answer', { body: { ok: false, error: 'not_available' } }],
  ['refused connection or network problem', 'throw'],
];
const doorFor = (a) => (a === 'throw' ? () => { throw new Error('offline'); } : () => a);
const post = (w, action, extra) => vm.runInContext('w4LinkedPost(' + JSON.stringify(action) + ', ' + JSON.stringify(extra || {}) + ')', w);

test('w4LinkedPost: sends only the action and its fields (no login token) and answers the door body', async () => {
  const w = world({ door: () => ok({ active: true }) });
  const r = await post(w, 'heartbeatLinked', { sessionToken: 's1' });
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.door[0].body, { action: 'heartbeatLinked', sessionToken: 's1' });
});

test('w4LinkedPost: 503, 404, 502, not_ready, a network problem do nothing; a 429 is not retried; a refusal is final', async () => {
  for (const [name, a] of DO_NOTHING) assert.equal((await post(world({ door: doorFor(a) }), 'heartbeatLinked', { sessionToken: 's' })).fallback, true, name);
  const t = await post(world({ door: () => ({ status: 429, body: {} }) }), 'heartbeatLinked', { sessionToken: 's' });
  assert.equal(t.fallback, undefined);
  assert.equal(t.code, 'rate_limited');
  const r = await post(world({ door: () => ({ body: { ok: false, error: 'invalid_code' } }) }), 'claimLinked', { code: 'c', sessionToken: 's' });
  assert.equal(r.fallback, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_code');
  assert.equal((await post(world({ door: () => ({ status: 500, badJson: true }) }), 'claimLinked', {})).ok, false);
});

test('after a 503 the door is left alone for 30 seconds; a 404 does not pause', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }) });
  await post(w, 'heartbeatLinked', { sessionToken: 's' });
  assert.equal((await post(w, 'heartbeatLinked', { sessionToken: 's' })).fallback, true);
  assert.equal(w.calls.door.length, 1);
  const left = vm.runInContext('w4LinkedPausedUntil - Date.now()', w);
  assert.ok(left > 29000 && left <= 30000, String(left));
  vm.runInContext('w4LinkedPausedUntil = Date.now() - 1', w);
  await post(w, 'heartbeatLinked', { sessionToken: 's' });
  assert.equal(w.calls.door.length, 2);
  const n = world({ door: () => ({ status: 404, body: {} }) });
  await post(n, 'heartbeatLinked', { sessionToken: 's' }); await post(n, 'heartbeatLinked', { sessionToken: 's' });
  assert.equal(n.calls.door.length, 2);
});

test('claim: the approved code and this device token go to the door; ok marks the device as registered; a refusal or no answer marks nothing', async () => {
  const w = world({ store: { sparkly_session_token: 'tok-1' }, door: () => ok() });
  await vm.runInContext('w4ClaimLinked("CODE123")', w);
  assert.deepEqual(w.calls.door[0].body, { action: 'claimLinked', code: 'CODE123', sessionToken: 'tok-1', deviceLabel: 'Chrome on Android' });
  assert.equal(w.store.sparkly_session_linked, '1');
  assert.equal(w.store.sparkly_session_token_registered, '1');
  for (const a of [{ body: { ok: false, error: 'invalid_code' } }, ...DO_NOTHING.map((x) => x[1]), { status: 429, body: {} }]) {
    const f = world({ store: { sparkly_session_token: 'tok-1' }, door: doorFor(a) });
    await vm.runInContext('w4ClaimLinked("CODE123")', f);
    assert.equal(f.store.sparkly_session_linked, undefined);
    assert.equal(f.store.sparkly_session_token_registered, undefined);
  }
  const n = world({ door: () => ok() });
  await vm.runInContext('w4ClaimLinked("C")', n);
  assert.equal(n.store.sparkly_session_token, 'uuid-new');
  assert.equal(n.calls.door[0].body.sessionToken, 'uuid-new');
  const e = world({ door: () => ok() });
  await vm.runInContext('w4ClaimLinked("")', e);
  assert.equal(e.calls.door.length, 0);
});

test('w1SessionsCall: a device with a login uses the logged-in door call; a registered linked device uses its own actions; anything else answers no_login with no call', async () => {
  const l = world({ login: true, store: { sparkly_session_linked: '1' } });
  assert.equal((await vm.runInContext('w1SessionsCall("heartbeat", { sessionToken: "t" })', l)).via, 'login');
  assert.equal(l.calls.door.length, 0);

  const h = world({ store: { sparkly_session_linked: '1' }, door: () => ok({ active: true }) });
  const r = await vm.runInContext('w1SessionsCall("heartbeat", { sessionToken: "t" })', h);
  assert.equal(r.ok, true); assert.equal(r.active, true);
  assert.deepEqual(h.calls.door[0].body, { action: 'heartbeatLinked', sessionToken: 't' });
  const gone = world({ store: { sparkly_session_linked: '1' }, door: () => ok({ active: false }) });
  assert.equal((await vm.runInContext('w1SessionsCall("heartbeat", { sessionToken: "t" })', gone)).active, false);

  for (const [name, a] of DO_NOTHING) {
    const f = world({ store: { sparkly_session_linked: '1' }, door: doorFor(a) });
    const x = await vm.runInContext('w1SessionsCall("heartbeat", { sessionToken: "t" })', f);
    assert.equal(x.ok, false, name);
    assert.equal(x.error, 'not_available', name);
  }
  const none = world({ door: () => ok() });
  assert.deepEqual(JSON.parse(JSON.stringify(await vm.runInContext('w1SessionsCall("heartbeat", { sessionToken: "t" })', none))), { ok: false, error: 'no_login' });
  for (const action of ['list', 'signOutDevice', 'ensure']) {
    const w = world({ store: { sparkly_session_linked: '1' }, door: () => ok() });
    assert.equal((await vm.runInContext('w1SessionsCall(' + JSON.stringify(action) + ', { sessionToken: "t" })', w)).error, 'no_login');
    assert.equal(w.calls.door.length, 0);
  }
});

test('a refusal of a linked heartbeat is passed on (the caller never treats it as signed out); only active false signs the device out', async () => {
  const w = world({ store: { sparkly_session_linked: '1' }, door: () => ({ body: { ok: false, error: 'bad_input' } }) });
  const r = await vm.runInContext('w1SessionsCall("heartbeat", { sessionToken: "t" })', w);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_input');
});

test('sign out: a device with a login uses the logged-in logout; a registered linked device uses logoutLinked (keepalive); an unregistered one calls nothing', async () => {
  const a = world({ login: true, store: { sparkly_session_token: 'tok', sparkly_session_linked: '1' } });
  vm.runInContext('logout()', a);
  assert.equal(a.calls.post.length, 1);
  assert.equal(a.calls.post[0].a, 'logout');
  assert.equal(a.calls.door.length, 0);

  const b = world({ store: { sparkly_session_token: 'tok', sparkly_session_linked: '1' }, door: () => ok({ loggedOut: true }) });
  vm.runInContext('logout()', b);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(b.calls.door[0].body, { action: 'logoutLinked', sessionToken: 'tok' });
  assert.equal(b.calls.door[0].keepalive, true);
  assert.equal(b.calls.post.length, 0);
  assert.equal(b.calls.reload, 1);

  const c = world({ store: { sparkly_session_token: 'tok' }, door: () => ok() });
  vm.runInContext('logout()', c);
  assert.equal(c.calls.door.length, 0);
  assert.equal(c.calls.reload, 1);
});
