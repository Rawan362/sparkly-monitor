// Run with:  node --test tests/*.test.mjs
// The login's admin check reads the Seller Admin Reads door (action isAdmin) first. Only the door's "yes" is taken as it is; a "no" or "cannot answer"
// runs the older direct check (the door matches by email, the web app by auth_user_id: listed in the pull request). A refusal never falls back.
// The door and the database are faked by the test (vm, no browser): nothing leaves the test.
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
function grab(startText) {
  const a = html.indexOf(startText);
  assert.ok(a > 0, startText + ' missing');
  let depth = 0, i = html.indexOf('{', a);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(a, i + 1);
}
const LOGIN = grab('async function w1LoginAfterAuth(');

test('the new code and this test file contain only ASCII characters', () => {
  const added = LOGIN.split('\n').filter((l) => /door|W3-|w3Admin/.test(l)).join('\n');
  const files = { block: blockOf('w3-admin-read-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the older direct admin check is still in the file; every inline script parses', () => {
  assert.ok(LOGIN.includes("'/rest/v1/admin_users?auth_user_id=eq.' + authData.user.id + '&select=id'"));
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type=["'](application\/json|application\/ld\+json|text\/template)/.test(m[1]));
  for (const m of scripts) new vm.Script(m[2]);
});

function world(over = {}) {
  const calls = { door: [], direct: [], admin: 0, seller: 0, stored: {} };
  const sandbox = {
    calls, SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'public-key', JSON, Date, Object, Promise, Error, String,
    localStorage: { setItem: (k, v) => { calls.stored[k] = v; } }, document: { getElementById: () => null },
    startAdminApp() { calls.admin++; }, w1ResolveSeller: async () => { calls.seller++; return 'chat1'; }, w1FinishLogin() {}
  };
  sandbox.fetch = async (url, init) => {
    if (String(url).endsWith('/webhook/seller-admin-reads')) {
      calls.door.push(JSON.parse(init.body));
      const a = over.door ? over.door() : { status: 503 };
      if (a.throws) throw new Error('network');
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
    }
    calls.direct.push(String(url).replace('https://db.example', ''));
    return { json: async () => (over.directAdmin ? [{ id: 1 }] : []) };
  };
  vm.createContext(sandbox);
  const helper = blockOf('w3-admin-read-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(helper + '\n' + LOGIN, sandbox);
  return sandbox;
}
const login = (w) => vm.runInContext('w1LoginAfterAuth({ user: { id: "u1" }, access_token: "tok", refresh_token: "r" }, "a@b.c")', w);
const ok = (admin) => ({ body: { ok: true, admin } });

test('the door says yes: an administrator, no direct read, with the login token and nothing else sent', async () => {
  const w = world({ door: () => ok(true) });
  await login(w);
  assert.equal(JSON.stringify(w.calls.door), JSON.stringify([{ token: 'tok', action: 'isAdmin' }]));
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.admin, 1);
  assert.equal(w.calls.seller, 0);
});

test('the door says no: the older direct check confirms before anyone is treated as a seller (email versus auth_user_id mismatch)', async () => {
  let w = world({ door: () => ok(false), directAdmin: true });
  await login(w);
  assert.equal(w.calls.direct.length, 1);
  assert.equal(w.calls.admin, 1);
  w = world({ door: () => ok(false), directAdmin: false });
  await login(w);
  assert.equal(w.calls.admin, 0);
  assert.equal(w.calls.seller, 1);
});

test('every way the door cannot answer runs the older direct check as before', async () => {
  for (const over of [{ status: 503, body: {} }, { status: 404, body: {} }, { status: 502, body: {} }, { status: 429, body: {} }, { body: { ok: false, error: 'not_available' } }, { throws: true }]) {
    for (const directAdmin of [true, false]) {
      const w = world({ door: () => over, directAdmin });
      await login(w);
      assert.equal(w.calls.direct.length, 1);
      assert.equal(w.calls.admin, directAdmin ? 1 : 0);
      assert.equal(w.calls.seller, directAdmin ? 0 : 1);
    }
  }
});

test('a door refusal never falls back and never makes a seller: the login fails like any error (the sign-in screen says try again)', async () => {
  for (const error of ['not_logged_in', 'no_seller', 'read_failed', 'bad_action']) {
    const w = world({ door: () => ({ body: { ok: false, error } }), directAdmin: true });
    await assert.rejects(() => login(w), /refused/);
    assert.equal(w.calls.direct.length, 0);
    assert.equal(w.calls.admin + w.calls.seller, 0);
  }
});

test('after a 429 or 503 the door is left alone for 30 seconds', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: () => ({ status, body: {} }) });
    await login(w);
    await login(w);
    assert.equal(w.calls.door.length, 1);
    const left = vm.runInContext('w3AdminPausedUntil', w) - Date.now();
    assert.ok(left > 25000 && left <= 30000);
  }
});
