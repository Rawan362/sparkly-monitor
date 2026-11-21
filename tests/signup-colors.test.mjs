// Run with:  node --test tests/*.test.mjs
// Sign-up messages: "Account created! Check your email ..." is GREEN; "This email already has an account ..." is RED; every other error stays RED.
// The login service and the Seller Own Row door are faked by the test: nothing leaves the test.
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

test('this test file and the new login notice style contain only ASCII characters', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const a = html.indexOf('w1-login-notice:css:start'); const b = html.indexOf('w1-login-notice:css:end');
  assert.ok(a > 0 && b > a);
  assert.ok(!/[^\x00-\x7f]/.test(html.slice(a, b)));
  assert.ok(fs.readFileSync(path.join(root, 'sw.js'), 'utf8').match(/sparkly-shell-v(\d+)'/));
});

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
test.before(async () => { if (!chromium) return; server = await makeServer(); base = 'http://127.0.0.1:' + server.address().port; browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

// `signup(body)` -> { status, json } answers the sign-up call; `door` answers createSeller.
async function run({ signup, door, theme, fill }) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/auth\/v1\/signup/.test(u)) { const a = signup(); return a === 'abort' ? route.abort() : json(a.status, a.json); }
    if (/\/webhook\/seller-own-row$/.test(u)) return json(200, door ? door() : { ok: true, chatId: 'web_x' });
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  if (theme) await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.evaluate(() => { startApp = function () {}; showSignUpScreen(); });
  const f = fill || { business: 'Test Shop', email: 'new@example.test', password: 'password123' };
  await page.fill('#signup-business', f.business); await page.fill('#signup-email', f.email); await page.fill('#signup-password', f.password);
  await page.evaluate(() => doSignUp());
  await page.waitForFunction(() => document.getElementById('login-ok') || document.getElementById('login-error'), null, { timeout: 8000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const ok = document.getElementById('login-ok'); const er = document.getElementById('login-error');
    const e = ok || er; if (!e) return null;
    const cs = getComputedStyle(e); const m = cs.color.match(/\d+(\.\d+)?/g).map(Number);
    return { kind: ok ? 'ok' : 'error', text: e.textContent, rgb: m.slice(0, 3), role: e.getAttribute('role'), both: !!(ok && er), screen: (document.querySelector('#login-card h1') || {}).textContent };
  });
  await page.close();
  return r;
}
const isGreen = (c) => c[1] > c[0] + 40 && c[1] > c[2] + 20;
const isRed = (c) => c[0] > c[1] + 60 && c[0] > c[2] + 60;

test('"Account created! Check your email" is GREEN (a status notice), in light and dark theme, and not shown in the red box', { skip }, async () => {
  for (const theme of ['light', 'dark']) {
    const r = await run({ signup: () => ({ status: 200, json: { id: 'u1', email: 'new@example.test', identities: [{ id: 'i' }] } }), theme });
    assert.ok(r, theme);
    assert.equal(r.kind, 'ok', theme); assert.equal(r.role, 'status'); assert.equal(r.both, false);
    assert.match(r.text, /^Account created! Check new@example\.test and click the confirmation link, then sign in below\.$/);
    assert.ok(isGreen(r.rgb), theme + ' colour is green: ' + r.rgb.join(','));
    assert.equal(r.screen, 'Sparkly AI', 'it is shown on the sign-in screen');
  }
});

test('"This email already has an account" is RED', { skip }, async () => {
  const r = await run({ signup: () => ({ status: 200, json: { id: 'fake', email: 'new@example.test', identities: [] } }) });
  assert.equal(r.kind, 'error'); assert.equal(r.role, 'alert');
  assert.match(r.text, /This email already has an account\. Sign in below instead of creating a new one\./);
  assert.ok(isRed(r.rgb), 'colour is red: ' + r.rgb.join(','));
});

test('every other sign-up error stays RED: empty boxes, short password, the login service refusing, no connection, profile setup failing', { skip }, async () => {
  const cases = [
    [{ fill: { business: '', email: 'a@b.co', password: 'password123' }, signup: () => ({ status: 200, json: {} }) }, /Please fill in all fields\./],
    [{ fill: { business: 'Shop', email: 'a@b.co', password: 'short' }, signup: () => ({ status: 200, json: {} }) }, /Password must be at least 8 characters\./],
    [{ signup: () => ({ status: 422, json: { msg: 'Signups not allowed for this instance' } }) }, /Signups not allowed/],
    [{ signup: () => ({ status: 429, json: { msg: 'Too many requests' } }) }, /Too many requests/],
    [{ signup: () => 'abort' }, /Something went wrong/],
    [{ signup: () => ({ status: 200, json: { user: { id: 'u1', identities: [{ id: 'i' }] }, access_token: 'jwt', refresh_token: 'r' } }), door: () => ({ ok: false, error: 'not_available' }) }, /Account created, but profile setup failed/]
  ];
  for (const [opts, re] of cases) {
    const r = await run(opts);
    assert.ok(r, String(re));
    assert.equal(r.kind, 'error', String(re)); assert.match(r.text, re);
    assert.ok(isRed(r.rgb), String(re) + ' colour is red: ' + r.rgb.join(','));
  }
});

test('the upgrade screen\'s "Account created. Confirm your email ..." notice is green too', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const body = /auth\/v1\/signup/.test(u) ? { id: 'u1', identities: [{ id: 'i' }] } : [];
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(body) });
  });
  await page.goto(base + '/index.html'); await page.waitForLoadState('load'); await page.waitForTimeout(500);
  await page.evaluate(() => showMigrateAccountScreen(1));
  await page.fill('#migrate-chatid', 'old-1'); await page.fill('#migrate-password', 'OldPassw0rd-x'); await page.click('#migrate-step1-btn');
  await page.waitForSelector('#migrate-step2-btn');
  await page.fill('#migrate-email', 'new@example.test'); await page.fill('#migrate-newpassword', 'NewPassw0rd-x'); await page.click('#migrate-step2-btn');
  await page.waitForSelector('#login-ok');
  const c = await page.$eval('#login-ok', (e) => getComputedStyle(e).color.match(/\d+/g).map(Number));
  assert.ok(isGreen(c));
  assert.equal(await page.$('#login-error'), null);
});
