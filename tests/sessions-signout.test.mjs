// Run with:  node --test tests/*.test.mjs
// A device signed out from another device is logged out within a few seconds of its next action, and is not registered again by the next
// page start. The Seller Sessions door is faked by the test: nothing leaves the test.
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

test('the new session code and this test file contain only ASCII characters; the flag is cleared with the other login keys', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const a = html.indexOf('w1-sessions-signout:js:start'); const b = html.indexOf('w1-sessions-signout:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block)); assert.ok(!/console\./.test(block));
  // the flag name matches the pattern that clearAllAuthStorage removes on every sign-out
  assert.ok(/^sparkly_.*(token|chat_id|is_admin|link_code)/.test('sparkly_session_token_registered'));
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

// `answer(body)` answers the door (default: ok). `token` is the login token (null: a device linked with a code).
async function openApp(answer, token, preset) {
  const calls = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-sessions$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}'); calls.push(body);
      const a = (answer && answer(body)) || { json: body.action === 'heartbeat' ? { ok: true, active: true } : { ok: true } };
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(([tok, pre]) => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => tok;
        window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); };
        localStorage.removeItem('sparkly_session_token'); localStorage.removeItem('sparkly_session_token_registered');
        if (pre) { localStorage.setItem('sparkly_session_token', 'tok-device'); if (pre === 'registered') localStorage.setItem('sparkly_session_token_registered', '1'); }
        localStorage.setItem('sparkly_auth_token', 'login-jwt'); localStorage.setItem('sparkly_seller_chat_id', 'seller-test');
      }, [token === undefined ? 'login-jwt' : token, preset || null]);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, calls };
}
const acts = (calls, a) => calls.filter((c) => c.action === a);
const gone = (page) => page.evaluate(() => localStorage.getItem('sparkly_auth_token') === null && localStorage.getItem('sparkly_seller_chat_id') === null);

test('a new device registers once (ensure) and remembers that it is registered; a refused ensure does not set the flag', { skip }, async () => {
  const a = await openApp(null, 'login-jwt', null);
  await a.page.evaluate(() => ensureSession());
  assert.equal(acts(a.calls, 'ensure').length, 1);
  assert.equal(await a.page.evaluate(() => localStorage.getItem('sparkly_session_token_registered')), '1');
  const b = await openApp((x) => (x.action === 'ensure' ? { status: 503, json: {} } : null), 'login-jwt', null);
  await b.page.evaluate(() => ensureSession());
  assert.equal(await b.page.evaluate(() => localStorage.getItem('sparkly_session_token_registered')), null);
});

test('a registered device whose session was removed (signed out from another device) is logged out at the next start and is NOT registered again', { skip }, async () => {
  const { page, calls } = await openApp((b) => (b.action === 'heartbeat' ? { json: { ok: true, active: false } } : null), 'login-jwt', 'registered');
  const nav = page.waitForEvent('load');
  await page.evaluate(() => ensureSession()).catch(() => {});
  await nav;
  assert.equal(acts(calls, 'ensure').length, 0, 'no second registration');
  assert.equal(acts(calls, 'heartbeat').length, 1);
  assert.equal(await gone(page), true);
});

test('a registered device that still has its session just refreshes it (heartbeat) and does not register again; a door that is not available changes nothing', { skip }, async () => {
  const ok = await openApp(null, 'login-jwt', 'registered');
  await ok.page.evaluate(() => ensureSession());
  assert.equal(acts(ok.calls, 'ensure').length, 0); assert.equal(acts(ok.calls, 'heartbeat').length, 1);
  assert.equal(await ok.page.evaluate(() => localStorage.getItem('sparkly_auth_token')), 'login-jwt');
  const down = await openApp(() => ({ status: 503, json: {} }), 'login-jwt', 'registered');
  await down.page.evaluate(() => ensureSession());
  assert.equal(acts(down.calls, 'ensure').length, 0);
  assert.equal(await down.page.evaluate(() => localStorage.getItem('sparkly_auth_token')), 'login-jwt');
  assert.deepEqual(await down.page.evaluate(() => window.__alerts), []);
});

for (const [name, trigger] of [
  ['a click', (page) => page.mouse.click(200, 400)],
  ['a key press', (page) => page.keyboard.press('a')],
  ['a touch', (page) => page.evaluate(() => document.dispatchEvent(new Event('touchstart', { bubbles: true })))],
  ['returning to the tab', (page) => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })],
  ['the window getting focus', (page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))]
]) {
  test('a device that was signed out from another device is logged out within a few seconds of ' + name, { skip }, async () => {
    const { page, calls } = await openApp((b) => (b.action === 'heartbeat' ? { json: { ok: true, active: false } } : null), 'login-jwt', 'registered');
    const nav = page.waitForEvent('load', { timeout: 6000 });
    const t0 = Date.now();
    await trigger(page).catch(() => {});
    await nav;
    assert.ok(Date.now() - t0 < 4000, 'within a few seconds: ' + (Date.now() - t0) + ' ms');
    assert.deepEqual(acts(calls, 'heartbeat').map((c) => c.sessionToken), ['tok-device']);
    assert.equal(await gone(page), true);
  });
}

test('the check on actions is limited to one every 5 seconds, and it does not start before the device has a login or a known registration', { skip }, async () => {
  const { page, calls } = await openApp(null, 'login-jwt', 'registered');
  for (let i = 0; i < 10; i++) await page.mouse.click(200, 400);
  await page.waitForTimeout(500);
  assert.equal(acts(calls, 'heartbeat').length, 1);
  await page.evaluate(() => { W1_SESSW.last = Date.now() - 6000; });
  await page.mouse.click(200, 400); await page.waitForTimeout(500);
  assert.equal(acts(calls, 'heartbeat').length, 2);
  const unreg = await openApp(null, 'login-jwt', 'unregistered');
  await unreg.page.mouse.click(200, 400); await unreg.page.waitForTimeout(500);
  assert.equal(unreg.calls.length, 0, 'no registered flag: no check on actions');
  const noSeller = await openApp(null, 'login-jwt', 'registered');
  await noSeller.page.evaluate(() => { SELLER_CHAT_ID = ''; });
  await noSeller.page.mouse.click(200, 400); await noSeller.page.waitForTimeout(500);
  assert.equal(noSeller.calls.length, 0, 'not signed in to the app: no check');
});

test('a device linked with a code (no login token) makes no call on its actions and keeps working', { skip }, async () => {
  const { page, calls } = await openApp(null, null, 'registered');
  await page.mouse.click(200, 400); await page.keyboard.press('b'); await page.waitForTimeout(500);
  assert.equal(calls.length, 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_seller_chat_id')), 'seller-test');
});

test('a problem with the door on an action never signs the device out', { skip }, async () => {
  for (const answer of [() => ({ status: 503, json: {} }), () => ({ json: { ok: false, error: 'read_failed' } }), () => ({ json: { ok: true, active: true } })]) {
    const { page } = await openApp(answer, 'login-jwt', 'registered');
    await page.mouse.click(200, 400); await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_auth_token')), 'login-jwt');
    assert.deepEqual(await page.evaluate(() => window.__alerts), []);
    await page.close();
  }
});

test('the registered flag goes away with the other login keys, so a new login on this device registers again', { skip }, async () => {
  const { page } = await openApp(null, 'login-jwt', 'registered');
  await page.evaluate(() => clearAllAuthStorage());
  assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_session_token_registered')), null);
});
