// Run with:  node --test tests/*.test.mjs
// Sign-up and first login with the Seller Own Row door: createSeller at sign-up (or at the first login after the email is confirmed),
// "me" at login. The door and the login system are faked by the test: nothing leaves the test. If Playwright is not installed (it is
// installed in CI), the browser tests are skipped. The text scan always runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire('/opt/node-tools/node_modules/')('playwright').chromium; } catch (e2) { chromium = null; }
}
const skip = chromium ? false : 'Playwright is not installed';

// ---- Rule: code written by the W1 chat is English only (ASCII). The new block, the changed lines and this file are scanned. ----
test('the new sign-up code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-signup-create-seller:js:start');
  const end = html.indexOf('w1-signup-create-seller:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const outside = html.slice(0, start) + html.slice(end);
  const hooks = outside.split('\n').filter((l) => /w1OwnRowCall\(|w1ResolveSeller\(|w1FinishLogin\(|w1KeepPendingName\(|w1OwnRowErrorText\(/.test(l));
  assert.ok(hooks.length >= 6, 'the changed lines in doSignUp and doLoginWithEmail');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hooks: hooks.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('sign-up and sign-in no longer write or read the sellers table with the public key, and the cache name is bumped', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const signUp = html.slice(html.indexOf('window.doSignUp = async function()'), html.indexOf('window.doLoginWithEmail = async function()'));
  const login = html.slice(html.indexOf('window.doLoginWithEmail = async function()'), html.indexOf('// One-time flow for your EXISTING Telegram-linked account'));
  assert.equal(signUp.includes('rest/v1/sellers'), false);
  assert.equal(login.includes('rest/v1/sellers'), false);
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 66);
});

// ---- Browser tests ----
function makeServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.join(root, f);
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
let server; let browser; let base;
test.before(async () => {
  if (!chromium) return;
  server = await makeServer();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const USER = { id: '11111111-2222-3333-4444-555555555555', identities: [{}] };
const SIGNED = (o) => Object.assign({ access_token: 'new-login-jwt', refresh_token: 'rt', user: USER }, o || {});

// `door(body)` answers the own-row door; `auth` says what the login system answers: { signup, token, admin }.
async function openApp(door, calls, auth, direct) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(body) });
    if (/\/webhook\/seller-own-row$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = door(body);
      return json(a.status || 200, a.json || {});
    }
    if (/\/auth\/v1\/signup/.test(u)) return json(200, auth.signup);
    if (/\/auth\/v1\/token/.test(u)) return auth.token ? json(200, auth.token) : json(400, { error: 'invalid_grant' });
    if (/\/rest\/v1\/admin_users/.test(u)) return json(200, auth.admin ? [{ id: 1 }] : []);
    if (/\/rest\/v1\/sellers/.test(u)) { direct.push(route.request().method()); return json(200, []); }
    return json(200, []);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(() => {
        window.__started = null; window.__adminStarted = false;
        window.startApp = () => { window.__started = SELLER_CHAT_ID; };
        window.startAdminApp = () => { window.__adminStarted = true; };
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const doorOk = (over) => (b) => {
  if (b.action === 'me') return { json: { ok: true, hasSeller: true, chatId: 'web_' + USER.id } };
  if (b.action === 'createSeller') return { json: { ok: true, created: true, chatId: 'web_' + USER.id } };
  return { json: { ok: false, error: 'bad_action', message: 'x' } };
};
const fillSignUp = (page, name, email) => page.evaluate(([n, e]) => { showSignUpScreen(); document.getElementById('signup-business').value = n; document.getElementById('signup-email').value = e; document.getElementById('signup-password').value = 'long-enough-password'; return doSignUp(); }, [name, email]);
const fillLogin = (page, email) => page.evaluate((e) => { showLoginScreen(); document.getElementById('login-email').value = e; document.getElementById('login-password2').value = 'long-enough-password'; return doLoginWithEmail(); }, email);
const loginError = (page) => page.$eval('#login-error, #login-ok', (e) => e.textContent).catch(() => '');
const pending = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sparkly_pending_business') || 'null'));

test('sign-up with a login token: createSeller is sent with the new login and the typed name, nothing goes to the sellers table, and the app starts as that seller', { skip }, async () => {
  const calls = []; const direct = [];
  const { page, errors } = await openApp(doorOk(), calls, { signup: SIGNED() }, direct);
  await fillSignUp(page, 'Corner Shop', 'a@example.test');
  assert.deepEqual(calls, [{ token: 'new-login-jwt', action: 'createSeller', businessName: 'Corner Shop' }]);
  assert.equal(await page.evaluate(() => window.__started), 'web_' + USER.id);
  assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_seller_chat_id')), 'web_' + USER.id);
  assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_auth_token')), 'new-login-jwt');
  assert.equal(direct.length, 0);
  assert.equal(await pending(page), null);
  assert.ok(calls.every((c) => !('chatId' in c) && !('email' in c) && !('authUserId' in c)));
  assert.deepEqual(errors, []);
});

test('sign-up with no token (email not confirmed): no door call, the typed name is kept with the email only, and the seller is told to confirm', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openApp(doorOk(), calls, { signup: { user: USER, id: USER.id, identities: [{}] } }, direct);
  await fillSignUp(page, 'Corner Shop', 'A@Example.Test');
  assert.equal(calls.length, 0);
  assert.equal(direct.length, 0);
  const kept = await pending(page);
  assert.deepEqual(Object.keys(kept).sort(), ['at', 'email', 'name']);
  assert.equal(kept.email, 'a@example.test');
  assert.equal(kept.name, 'Corner Shop');
  assert.match(await loginError(page), /Account created! Check A@Example\.Test and click the confirmation link, then sign in below\./);
  assert.ok(!JSON.stringify(await page.evaluate(() => Object.assign({}, localStorage))).includes('long-enough-password'));
});

test('the first login after the email is confirmed creates the seller from the kept name with the login token, then forgets the name', { skip }, async () => {
  const calls = []; const direct = [];
  const door = (b) => b.action === 'me' ? { json: { ok: true, hasSeller: false } } : doorOk()(b);
  const { page } = await openApp(door, calls, { token: SIGNED() }, direct);
  await page.evaluate(() => localStorage.setItem('sparkly_pending_business', JSON.stringify({ email: 'a@example.test', name: 'Corner Shop', at: Date.now() })));
  await fillLogin(page, 'A@example.test');
  assert.deepEqual(calls, [{ token: 'new-login-jwt', action: 'me' }, { token: 'new-login-jwt', action: 'createSeller', businessName: 'Corner Shop' }]);
  assert.equal(await page.evaluate(() => window.__started), 'web_' + USER.id);
  assert.equal(await pending(page), null);
  assert.equal(direct.length, 0);
});

test('a login that already has a seller just starts: only me is asked, no createSeller, the kept name of another email is left alone', { skip }, async () => {
  const calls = [];
  const { page } = await openApp(doorOk(), calls, { token: SIGNED() }, []);
  await page.evaluate(() => localStorage.setItem('sparkly_pending_business', JSON.stringify({ email: 'other@example.test', name: 'Other', at: Date.now() })));
  await fillLogin(page, 'a@example.test');
  assert.deepEqual(calls.map((c) => c.action), ['me']);
  assert.equal(await page.evaluate(() => window.__started), 'web_' + USER.id);
  assert.notEqual(await pending(page), null);
});

test('an admin login is unchanged: it goes to the admin app and the door is not called', { skip }, async () => {
  const calls = [];
  const { page } = await openApp(doorOk(), calls, { token: SIGNED(), admin: true }, []);
  await fillLogin(page, 'admin@example.test');
  assert.equal(calls.length, 0);
  assert.equal(await page.evaluate(() => window.__adminStarted), true);
});

test('a login with no seller and no kept name on this device asks for the business name, then creates the seller', { skip }, async () => {
  const calls = [];
  const door = (b) => b.action === 'me' ? { json: { ok: true, hasSeller: false } } : doorOk()(b);
  const { page } = await openApp(door, calls, { token: SIGNED() }, []);
  await fillLogin(page, 'a@example.test');
  await page.waitForSelector('#w1-business-name');
  assert.equal(await page.$eval('#login-card h1', (e) => e.textContent), 'One more step');
  assert.deepEqual(calls.map((c) => c.action), ['me']);
  await page.click('#w1-business-name-btn');
  await page.waitForFunction(() => /Please type your business name\./.test(document.getElementById('login-error').textContent));
  assert.equal(calls.length, 1, 'an empty name sends nothing');
  await page.fill('#w1-business-name', '  Corner Shop ');
  await page.click('#w1-business-name-btn');
  await page.waitForFunction(() => window.__started !== null);
  assert.deepEqual(calls[1], { token: 'new-login-jwt', action: 'createSeller', businessName: 'Corner Shop' });
  assert.equal(await page.evaluate(() => window.__started), 'web_' + USER.id);
});

test('a kept name that is too old is not used', { skip }, async () => {
  const calls = [];
  const door = (b) => b.action === 'me' ? { json: { ok: true, hasSeller: false } } : doorOk()(b);
  const { page } = await openApp(door, calls, { token: SIGNED() }, []);
  await page.evaluate(() => localStorage.setItem('sparkly_pending_business', JSON.stringify({ email: 'a@example.test', name: 'Old', at: Date.now() - 15 * 24 * 3600 * 1000 })));
  await fillLogin(page, 'a@example.test');
  await page.waitForSelector('#w1-business-name');
  assert.deepEqual(calls.map((c) => c.action), ['me']);
  assert.equal(await pending(page), null, 'the old kept name is removed');
});

test('door problems are shown in plain words and nothing is lost: login screen on a refusal, the kept name stays after a failed create', { skip }, async () => {
  const off = await openApp(() => ({ status: 503, json: {} }), [], { token: SIGNED() }, []);
  await fillLogin(off.page, 'a@example.test');
  assert.equal(await loginError(off.page), 'Sign-in is not available right now. Please try again later.');
  assert.equal(await off.page.evaluate(() => window.__started), null);
  const lost = await openApp((b) => b.action === 'me' ? { json: { ok: true, hasSeller: false } } : { json: { ok: false, error: 'bad_name', message: 'The business name cannot be empty and can be at most 100 characters.' } }, [], { token: SIGNED() }, []);
  await lost.page.evaluate(() => localStorage.setItem('sparkly_pending_business', JSON.stringify({ email: 'a@example.test', name: 'Corner Shop', at: Date.now() })));
  await fillLogin(lost.page, 'a@example.test');
  assert.equal(await loginError(lost.page), 'The business name cannot be empty and can be at most 100 characters.');
  assert.notEqual(await pending(lost.page), null, 'kept for the next try');
  const login = await openApp(() => ({ json: { ok: false, error: 'not_logged_in', message: 'Please log in again.' } }), [], { token: SIGNED() }, []);
  await fillLogin(login.page, 'a@example.test');
  assert.equal(await loginError(login.page), 'Please sign out and sign in again, then try once more.');
});

test('sign-up with a token but a refused create keeps the name and tells the seller to sign in to finish', { skip }, async () => {
  const { page } = await openApp(() => ({ status: 503, json: {} }), [], { signup: SIGNED() }, []);
  await fillSignUp(page, 'Corner Shop', 'a@example.test');
  assert.equal(await loginError(page), 'Account created, but profile setup failed: Sign-in is not available right now. Please try again later. Sign in to finish.');
  assert.equal((await pending(page)).name, 'Corner Shop');
  assert.equal(await page.evaluate(() => window.__started), null);
});

test('the older messages are unchanged: a wrong password, and an email that already has an account', { skip }, async () => {
  const calls = [];
  const wrong = await openApp(doorOk(), calls, { token: null }, []);
  await fillLogin(wrong.page, 'a@example.test');
  assert.equal(await loginError(wrong.page), 'Incorrect email or password.');
  const dup = await openApp(doorOk(), calls, { signup: { user: { id: USER.id, identities: [] } } }, []);
  await fillSignUp(dup.page, 'Corner Shop', 'a@example.test');
  assert.equal(await loginError(dup.page), 'This email already has an account. Sign in below instead of creating a new one.');
  assert.equal(calls.length, 0);
});
