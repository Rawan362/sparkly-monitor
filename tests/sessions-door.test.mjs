// Run with:  node --test tests/*.test.mjs
// Device sessions: ensure, heartbeat, log out, list and sign out another device go through the Seller Sessions door with the person's own
// login, not straight to the sessions table with the public key. The door and the database are faked by the test: nothing leaves the test.
// If Playwright is not installed (it is installed in CI), the browser tests are skipped. The text scan always runs.
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
test('the new sessions code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-sessions-door:js:start');
  const end = html.indexOf('w1-sessions-door:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const hooks = html.split('\n').filter((l) => /w1SessionsCall\(|w1SessionsPost\(/.test(l) && !l.includes('function '));
  assert.ok(hooks.length >= 6, 'the changed lines in the five session functions');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hooks: hooks.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('no part of the web app reads or writes the sessions table directly any more, and the cache name is bumped', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(html.includes('rest/v1/sessions'), false);
  assert.equal(/sb\('sessions\?/.test(html), false);
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

const DEVICES = [
  { id: 'dev-1', deviceLabel: 'Chrome on Android', createdAt: '2026-01-01T10:00:00Z', lastSeenAt: new Date().toISOString(), isThisDevice: true },
  { id: 'dev-2', deviceLabel: 'Safari on iOS <b>x</b>', createdAt: '2026-01-01T10:00:00Z', lastSeenAt: new Date(Date.now() - 3600000).toISOString(), isThisDevice: false }
];

// `answer(body)` answers the door. `direct` collects any call that goes straight to the sessions table.
async function openApp(answer, calls, direct, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-sessions$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = (answer && answer(body)) || { json: { ok: true } };
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
    if (/\/rest\/v1\/sessions/.test(u)) { direct.push(route.request().method()); return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' }); }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate((tok) => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => tok;
        window.__alerts = [];
        window.alert = (m) => { window.__alerts.push(String(m)); };
        window.confirm = () => true;
        localStorage.setItem('sparkly_auth_token', tok || 'stored-login');
      }, token === undefined ? 'login-jwt' : token);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const asked = (calls, action) => calls.filter((c) => c.action === action);

test('ensureSession makes the token in the browser and sends it to the door with the device label and the login', { skip }, async () => {
  const calls = []; const direct = [];
  const { page, errors } = await openApp(null, calls, direct);
  await page.evaluate(() => { localStorage.removeItem('sparkly_session_token'); return ensureSession(); });
  const made = await page.evaluate(() => localStorage.getItem('sparkly_session_token'));
  assert.match(made, /^[0-9a-f-]{36}$|^sess-/);
  const body = asked(calls, 'ensure')[0];
  assert.deepEqual(Object.keys(body).sort(), ['action', 'deviceLabel', 'sessionToken', 'token']);
  assert.equal(body.sessionToken, made);
  assert.equal(body.token, 'login-jwt');
  assert.match(body.deviceLabel, /^\w+ on \w+$/);
  assert.equal(direct.length, 0);
  assert.deepEqual(errors, []);
});

test('the same device keeps its token: a second ensure sends the same sessionToken', { skip }, async () => {
  const calls = [];
  const { page } = await openApp(null, calls, []);
  await page.evaluate(async () => { localStorage.removeItem('sparkly_session_token'); await ensureSession(); await ensureSession(); });
  assert.equal(asked(calls, 'ensure')[0].sessionToken, asked(calls, 'ensure')[1].sessionToken);
});

test('the heartbeat asks the door about every sixth poll, and a device the door says is signed out logs itself out', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openApp((b) => b.action === 'heartbeat' ? { json: { ok: true, active: true } } : null, calls, direct);
  await page.evaluate(async () => { localStorage.setItem('sparkly_session_token', 'tok-device'); sessionCheckCounter = 0; for (let i = 0; i < 12; i++) await heartbeatSession(); });
  assert.equal(asked(calls, 'heartbeat').length, 2);
  assert.deepEqual(asked(calls, 'heartbeat')[0], { token: 'login-jwt', action: 'heartbeat', sessionToken: 'tok-device' });
  assert.equal(direct.length, 0);
  assert.deepEqual(await page.evaluate(() => window.__alerts), []);
  const out = await openApp((b) => b.action === 'heartbeat' ? { json: { ok: true, active: false } } : null, [], []);
  const nav = out.page.waitForEvent('load');
  await out.page.evaluate(() => { localStorage.setItem('sparkly_session_token', 'tok-device'); sessionCheckCounter = 5; return heartbeatSession(); }).catch(() => {});
  await nav;
  assert.equal(await out.page.evaluate(() => localStorage.getItem('sparkly_auth_token')), null);
});

test('a problem with the door or no login never signs the device out; the heartbeat just tries again later', { skip }, async () => {
  for (const [answer, token] of [[() => ({ status: 503, json: {} }), 'login-jwt'], [() => ({ json: { ok: false, error: 'read_failed', message: 'x' } }), 'login-jwt'], [() => ({ json: { ok: true, active: false } }), null]]) {
    const calls = [];
    const { page } = await openApp(answer, calls, [], token);
    await page.evaluate(async () => { localStorage.setItem('sparkly_session_token', 'tok-device'); sessionCheckCounter = 5; await heartbeatSession(); });
    assert.deepEqual(await page.evaluate(() => window.__alerts), []);
    assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_session_token')), 'tok-device');
    if (token === null) assert.equal(calls.length, 0, 'no login: the door is not called');
    await page.close();
  }
});

test('logout sends the logout to the door with the stored login and clears the device', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openApp(null, calls, direct);
  await page.evaluate(() => { localStorage.setItem('sparkly_session_token', 'tok-device'); });
  const sent = page.waitForRequest((r) => /seller-sessions$/.test(r.url()));
  const nav = page.waitForEvent('load');
  await page.evaluate(() => { logout(); }).catch(() => {});
  const req = await sent;
  assert.deepEqual(JSON.parse(req.postData()), { token: 'login-jwt', action: 'logout', sessionToken: 'tok-device' });
  await nav;
  assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_session_token')), null, 'cleared by clearAllAuthStorage');
  assert.equal(direct.length, 0);
});

test('logout of a device with no stored login does not call the door and still signs out', { skip }, async () => {
  const calls = [];
  const { page } = await openApp(null, calls, []);
  await page.evaluate(() => { localStorage.setItem('sparkly_session_token', 'tok-device'); localStorage.removeItem('sparkly_auth_token'); });
  const nav = page.waitForEvent('load');
  await page.evaluate(() => { logout(); }).catch(() => {});
  await nav;
  assert.equal(asked(calls, 'logout').length, 0);
});

test('the device list shows the label and last seen, marks this device, hides Sign out on it, and never has or shows a token', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openApp((b) => b.action === 'list' ? { json: { ok: true, count: 2, devices: DEVICES } } : null, calls, direct);
  await page.evaluate(() => { localStorage.setItem('sparkly_session_token', 'tok-device'); document.body.insertAdjacentHTML('beforeend', '<div id="devices-list"></div>'); return renderDevicesList(); });
  assert.deepEqual(asked(calls, 'list'), [{ token: 'login-jwt', action: 'list', sessionToken: 'tok-device' }]);
  const rows = await page.$$eval('.device-row', (els) => els.map((e) => ({ label: e.querySelector('.device-label').textContent, thisTag: !!e.querySelector('.device-this-tag'), signOut: !!e.querySelector('.device-signout-btn'), html: e.innerHTML })));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].thisTag, true);
  assert.equal(rows[0].signOut, false);
  assert.equal(rows[1].signOut, true);
  assert.match(rows[1].label, /Safari on iOS <b>x<\/b>/, 'shown as text');
  assert.ok(!rows[1].html.includes('<b>x</b>'));
  assert.match(rows[1].html, /signOutDevice\('dev-2'\)/);
  assert.equal(direct.length, 0);
  const text = await page.$eval('#devices-list', (e) => e.innerHTML);
  assert.ok(!text.includes('tok-device') && !/session_token/.test(text));
});

test('an empty list or a door problem shows the same "no devices" line as before', { skip }, async () => {
  for (const answer of [() => ({ json: { ok: true, count: 0, devices: [] } }), () => ({ status: 503, json: {} })]) {
    const { page } = await openApp(answer, [], []);
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div id="devices-list"></div>'); return renderDevicesList(); });
    assert.equal(await page.$$eval('.device-row', (e) => e.length), 0);
    assert.equal(await page.$eval('#devices-list', (e) => e.textContent), await page.evaluate(() => t('no_devices_found')));
    await page.close();
  }
});

test('Sign out on another device sends signOutDevice with that device id and then redraws the list', { skip }, async () => {
  const calls = [];
  const { page } = await openApp((b) => b.action === 'list' ? { json: { ok: true, count: 1, devices: [DEVICES[0]] } } : null, calls, []);
  await page.evaluate(async () => { document.body.insertAdjacentHTML('beforeend', '<div id="devices-list"></div>'); await signOutDevice('dev-2'); });
  assert.deepEqual(asked(calls, 'signOutDevice'), [{ token: 'login-jwt', action: 'signOutDevice', deviceId: 'dev-2' }]);
  assert.equal(asked(calls, 'list').length, 1, 'the list is drawn again');
});

test('a device without a login of its own (linked with a code) makes no door call and keeps working', { skip }, async () => {
  const calls = []; const direct = [];
  const { page, errors } = await openApp(null, calls, direct, null);
  await page.evaluate(async () => { localStorage.removeItem('sparkly_session_token'); await ensureSession(); sessionCheckCounter = 5; await heartbeatSession(); document.body.insertAdjacentHTML('beforeend', '<div id="devices-list"></div>'); await renderDevicesList(); });
  assert.equal(calls.length, 0);
  assert.equal(direct.length, 0);
  assert.deepEqual(errors, []);
});
