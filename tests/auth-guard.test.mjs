// Run with:  node --test tests/*.test.mjs
// These tests read the REAL code out of index.html (between the <auth-guard> markers, plus the real logout function)
// and run it against fake storage, so they test what ships. No network, no real tokens: the "tokens" are made-up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const KHANI = '0b280dbe-d2c1-4f00-8a11-000000000001'; // made-up login user ids
const DOUBLE_LINE = '582dbf89-fdaa-4794-ab9b-000000000002';
const MESSAGE = 'Your login does not match this account. Please sign in again.';

const region = (() => {
  const a = html.indexOf('// <auth-guard>');
  const b = html.indexOf('// </auth-guard>');
  assert.ok(a > 0 && b > a, 'auth-guard markers are missing');
  return html.slice(a, b);
})();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, expiresInSec = 3600) => `${b64({ alg: 'HS256' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + expiresInSec })}.sig`;

class FakeStorage {
  constructor(initial = {}) { this.m = new Map(Object.entries(initial)); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  keys() { return [...this.m.keys()].sort(); }
}

// Loads the real guard code with fake storage and a fake network. `fetches` records every request the code makes.
function load({ local = {}, session = {}, seller = null, fetchImpl } = {}) {
  const localStorage = new FakeStorage(local);
  const sessionStorage = new FakeStorage(session);
  const fetches = [];
  const ctx = vm.createContext({
    localStorage, sessionStorage, atob, encodeURIComponent, Object, JSON, Date, Math, Error, String, RegExp,
    SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'test-anon',
    fetch: async (url, init) => {
      fetches.push({ url: String(url), method: (init && init.method) || 'GET' });
      if (fetchImpl) return fetchImpl(String(url), init);
      throw new Error('unexpected network call in this test');
    }
  });
  const api = vm.runInContext(
    `let SELLER_CHAT_ID = ${JSON.stringify(seller)};\n${region}\n({ clearAllAuthStorage, applyLinkedSeller, getValidAuthToken, getSeller: () => SELLER_CHAT_ID, setSeller: (v) => { SELLER_CHAT_ID = v; } })`,
    ctx
  );
  return { api, localStorage, sessionStorage, fetches, ctx };
}

// ---------- 1) logout clears every stored login token ----------

test('clearAllAuthStorage removes every login token and the remembered seller from every storage place, and nothing else', () => {
  const secrets = {
    sparkly_auth_token: jwt(KHANI), sparkly_refresh_token: 'r1', sparkly_session_token: 's1',
    sparkly_seller_chat_id: `web_${KHANI}`, sparkly_is_admin: 'true', sparkly_pending_link_code: '{}',
    sparkly_some_future_token: 'x' // not in the list: caught by the pattern
  };
  const keep = { sparkly_lang: 'ar', sparkly_theme: 'dark' };
  const { api, localStorage, sessionStorage } = load({ local: { ...secrets, ...keep }, session: { ...secrets } });
  api.clearAllAuthStorage();
  assert.deepEqual(localStorage.keys(), ['sparkly_lang', 'sparkly_theme']);
  assert.deepEqual(sessionStorage.keys(), []);
});

test('the real logout() leaves no login token behind and reloads the page', () => {
  const m = /window\.logout = function\(\) \{[\s\S]*?\n\};/.exec(html);
  assert.ok(m, 'window.logout not found');
  const { ctx, localStorage, sessionStorage } = load({
    local: { sparkly_auth_token: jwt(KHANI), sparkly_refresh_token: 'r1', sparkly_session_token: 's1', sparkly_seller_chat_id: `web_${KHANI}`, sparkly_lang: 'en' },
    session: { sparkly_auth_token: jwt(KHANI) }
  });
  let reloads = 0;
  const calls = [];
  ctx.window = {};
  ctx.location = { reload: () => { reloads++; } };
  ctx.fetch = (url, init) => { calls.push({ url: String(url), method: init && init.method }); return Promise.resolve({}); };
  vm.runInContext(m[0], ctx); // the guard code is already loaded in this context by load()
  ctx.window.logout();
  assert.deepEqual(localStorage.keys(), ['sparkly_lang']);
  assert.deepEqual(sessionStorage.keys(), []);
  assert.equal(reloads, 1);
  assert.equal(calls.length, 1); // only the existing "delete this device's session row" call
  assert.equal(calls[0].method, 'DELETE');
});

test('every other sign-out path also clears all tokens (admin logout, "signed out from this device", delete account)', () => {
  const admin = /window\.adminLogout = function\(\) \{[\s\S]*?\n\};/.exec(html);
  assert.ok(admin && admin[0].includes('clearAllAuthStorage()'), 'adminLogout');
  const beat = html.slice(html.indexOf("alert('You were signed out from this device.')") - 200, html.indexOf("alert('You were signed out from this device.')"));
  assert.ok(beat.includes('clearAllAuthStorage()'), 'heartbeat sign-out');
  const del = /async function deleteAccountNow\(\) \{[\s\S]*?\n\}/.exec(html);
  assert.ok(del && del[0].includes('clearAllAuthStorage()'), 'deleteAccountNow');
});

test('no code outside the guard reads the stored login token (nothing can bypass the check)', () => {
  const outside = html.replace(region, '');
  assert.equal((outside.match(/getItem\('sparkly_auth_token'\)/g) || []).length, 0);
});

// ---------- 2) "link with a code" never leaves an old seller's token behind ----------

test('linking a device as Double Line while Khani\'s token is still on it: the old token is gone, the seller is Double Line', async () => {
  const { api, localStorage, sessionStorage, fetches } = load({
    local: { sparkly_auth_token: jwt(KHANI), sparkly_refresh_token: 'khani-refresh', sparkly_seller_chat_id: `web_${KHANI}` },
    session: { sparkly_auth_token: jwt(KHANI) },
    seller: `web_${KHANI}`
  });
  api.applyLinkedSeller(`web_${DOUBLE_LINE}`);
  assert.equal(api.getSeller(), `web_${DOUBLE_LINE}`);
  assert.equal(localStorage.getItem('sparkly_seller_chat_id'), `web_${DOUBLE_LINE}`);
  assert.equal(localStorage.getItem('sparkly_auth_token'), null);
  assert.equal(localStorage.getItem('sparkly_refresh_token'), null);
  assert.equal(sessionStorage.getItem('sparkly_auth_token'), null);
  assert.equal(await api.getValidAuthToken(), null); // no token at all: the server will ask to sign in; never Khani's
  assert.equal(fetches.length, 0);
});

test('the link-with-a-code flow and the older chat-id sign-in both go through applyLinkedSeller', () => {
  assert.match(html, /localStorage\.removeItem\('sparkly_pending_link_code'\);\s*applyLinkedSeller\(rows\[0\]\.seller_id\);/);
  assert.match(html, /applyLinkedSeller\(chatId\);/);
  assert.doesNotMatch(html, /SELLER_CHAT_ID = rows\[0\]\.seller_id;/);
});

// ---------- 3) a send is blocked when the token's seller is not the seller on screen ----------

test('OLD KHANI TOKEN LEFT BEHIND + DOUBLE LINE ON SCREEN: the send is blocked with the clear message, nothing is sent, nobody is logged out', async () => {
  const khaniToken = jwt(KHANI);
  const { api, localStorage, fetches } = load({
    local: { sparkly_auth_token: khaniToken, sparkly_refresh_token: 'khani-refresh', sparkly_seller_chat_id: `web_${DOUBLE_LINE}` },
    seller: `web_${DOUBLE_LINE}`
  });
  // This is exactly what every send does first: `const authToken = await getValidAuthToken(); const res = await fetch(<webhook>, ...)`.
  let sent = false;
  await assert.rejects(async () => { await api.getValidAuthToken(); sent = true; }, { message: MESSAGE });
  assert.equal(sent, false);
  assert.equal(fetches.length, 0); // nothing went out, not even a token refresh
  assert.equal(localStorage.getItem('sparkly_auth_token'), khaniToken); // not logged out silently
  assert.equal(localStorage.getItem('sparkly_seller_chat_id'), `web_${DOUBLE_LINE}`);
});

test('a token that matches the seller on screen is allowed', async () => {
  const token = jwt(DOUBLE_LINE);
  const { api } = load({ local: { sparkly_auth_token: token }, seller: `web_${DOUBLE_LINE}` });
  assert.equal(await api.getValidAuthToken(), token);
});

test('an expired token is refreshed, and the refreshed token is checked too (Khani refresh on a Double Line screen is blocked)', async () => {
  const refreshed = jwt(KHANI);
  const reply = (token) => async () => ({ ok: true, json: async () => ({ access_token: token, refresh_token: 'new-refresh' }) });
  const blocked = load({
    local: { sparkly_auth_token: jwt(KHANI, -60), sparkly_refresh_token: 'khani-refresh' },
    seller: `web_${DOUBLE_LINE}`, fetchImpl: reply(refreshed)
  });
  await assert.rejects(() => blocked.api.getValidAuthToken(), { message: MESSAGE });
  const fine = load({
    local: { sparkly_auth_token: jwt(DOUBLE_LINE, -60), sparkly_refresh_token: 'dl-refresh' },
    seller: `web_${DOUBLE_LINE}`, fetchImpl: reply(jwt(DOUBLE_LINE))
  });
  assert.equal(authSub(await fine.api.getValidAuthToken()), DOUBLE_LINE);
});

function authSub(token) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; }

test('older sellers (ids not starting with web_) are checked against their linked login user, looked up once', async () => {
  const lookup = (authUserId) => async () => ({ ok: true, json: async () => [{ auth_user_id: authUserId }] });
  const mismatch = load({ local: { sparkly_auth_token: jwt(KHANI) }, seller: '6150148292', fetchImpl: lookup(DOUBLE_LINE) });
  await assert.rejects(() => mismatch.api.getValidAuthToken(), { message: MESSAGE });
  const noLogin = load({ local: { sparkly_auth_token: jwt(KHANI) }, seller: '6150148292', fetchImpl: lookup(null) });
  await assert.rejects(() => noLogin.api.getValidAuthToken(), { message: MESSAGE });
  const match = load({ local: { sparkly_auth_token: jwt(DOUBLE_LINE) }, seller: '6150148292', fetchImpl: lookup(DOUBLE_LINE) });
  await match.api.getValidAuthToken();
  await match.api.getValidAuthToken();
  assert.equal(match.fetches.length, 1); // cached after the first look-up
  const down = load({ local: { sparkly_auth_token: jwt(DOUBLE_LINE) }, seller: '6150148292', fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(() => down.api.getValidAuthToken(), { message: /Could not verify your login/ }); // fails closed
});

test('with no token, or no seller on screen, behaviour is unchanged', async () => {
  const none = load({ local: {}, seller: `web_${DOUBLE_LINE}` });
  assert.equal(await none.api.getValidAuthToken(), null);
  const noSeller = load({ local: { sparkly_auth_token: jwt(KHANI) }, seller: null });
  assert.equal(authSub(await noSeller.api.getValidAuthToken()), KHANI);
});

test('every send and settings call gets its token from getValidAuthToken, right before it uses the server address', () => {
  const lines = html.split('\n');
  const targets = [/fetch\(SELLER_SEND_(TEXT|MEDIA|VOICE|LOCATION)_WEBHOOK/, /fetch\(SELLER_UPDATE_PROFILE(_PHOTO)?_WEBHOOK/, /fetch\(SELLER_CALLING_URL/];
  let found = 0;
  lines.forEach((line, i) => {
    if (!targets.some((re) => re.test(line))) return;
    found++;
    const before = lines.slice(Math.max(0, i - 40), i + 1).join('\n');
    assert.match(before, /await getValidAuthToken\(\)/, `line ${i + 1} sends without getValidAuthToken(): ${line.trim().slice(0, 80)}`);
  });
  assert.ok(found >= 7, `expected at least 7 send call sites, found ${found}`);
});

// ---------- the page still parses (JS and CSS syntax) ----------

test('every inline script in index.html is valid JavaScript', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s));
});

test('every style block in index.html has balanced braces and no unterminated comment', () => {
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.ok(styles.length > 0);
  for (const css of styles) {
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!noComments.includes('/*'), 'unterminated comment');
    const opens = (noComments.match(/\{/g) || []).length;
    const closes = (noComments.match(/\}/g) || []).length;
    assert.equal(opens, closes);
  }
});
