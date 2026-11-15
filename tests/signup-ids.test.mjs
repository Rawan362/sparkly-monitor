// Run with:  node --test tests/*.test.mjs
// WhatsApp signup (connect flow): the signup call also sends the seller's login token and the two ids picked in Meta's popup.
// Meta and the signup door are faked by the test: nothing leaves the test. If Playwright is not installed (it is installed in CI),
// the browser tests are skipped. The text scan always runs.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). The new block, the two small hooks and this file are scanned. ----
test('the new signup code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-signup-ids:js:start');
  const end = html.indexOf('w1-signup-ids:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const hooks = html.split('\n').filter((l) => /w1SignupListen\(\);|w1SignupPost\(WHATSAPP/.test(l));
  assert.equal(hooks.length, 2, 'the two small hooks in the connect flow');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hooks: hooks.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is bumped and the rest of the connect flow is as before', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 66);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(html.split('onclick="launchWhatsAppSignup()"').length - 1, 2, 'the Settings row and the first-run button');
  assert.ok(html.includes("const WHATSAPP_SIGNUP_CALLBACK_URL = 'https://sparklly.site/webhook/whatsapp-signup-callback';"));
  assert.ok(html.includes("config_id: '1383145003804853'"));
  assert.ok(html.includes("extras: { setup: {}, featureType: '', sessionInfoVersion: '3' }"));
  assert.ok(html.includes("if (statusEl) statusEl.textContent = 'Connecting...';"));
  assert.ok(html.includes("alert('Could not connect your WhatsApp number: ' + (data.error || 'unknown error'));"));
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

// `door(body)` answers the signup call. `token` is what the login check hands the flow.
async function openFlow(door, calls, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/whatsapp-signup-callback$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = door(body);
      if (a.abort) return route.abort();
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
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
        document.getElementById('whatsapp-connect-gate').style.display = 'none';
        window.getValidAuthToken = async () => tok;
        window.__alerts = [];
        window.alert = (m) => { window.__alerts.push(String(m)); };
        window.__fb = null;
        // Meta's login popup is faked: the test decides when it "finishes".
        window.FB = { login: (cb, opts) => { window.__fb = { cb, opts }; } };
      }, token === undefined ? 'login-jwt' : token);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const good = () => ({ json: { success: true, phoneNumberId: '1', wabaId: '2', displayPhoneNumber: '3' } });
const start = (page) => page.evaluate(() => { launchWhatsAppSignup(); });
const finishMsg = (page, origin, data) => page.evaluate(([o, d]) => { window.dispatchEvent(new MessageEvent('message', { origin: o, data: JSON.stringify(d) })); }, [origin, data]);
const FINISH = (pn, wb) => ({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', version: '3', data: { phone_number_id: pn, waba_id: wb, business_id: '777' } });
const login = (page, code) => page.evaluate((c) => { window.__fb.cb(c ? { authResponse: { code: c } } : {}); }, code === undefined ? 'CODE1' : code);
const status = (page) => page.$eval('#whatsapp-connect-status', (e) => e.textContent);
const waitStatus = (page, re) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('whatsapp-connect-status').textContent), re);

test('the signup call sends the code, the seller id, the login token and the two picked ids', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openFlow(good, calls);
  await start(page);
  await finishMsg(page, 'https://www.facebook.com', FINISH('1234567890', '9876543210'));
  assert.equal(await status(page), 'Finishing setup...', 'the older progress message still works');
  await login(page);
  await waitStatus(page, 'Connected');
  assert.deepEqual(calls, [{ code: 'CODE1', seller_id: 'seller-test', token: 'login-jwt', phone_number_id: '1234567890', waba_id: '9876543210' }]);
  assert.deepEqual(errors, []);
});

test('a finish message that arrives just after the code is still used', { skip }, async () => {
  const calls = [];
  const { page } = await openFlow(good, calls);
  await start(page);
  await login(page);
  await finishMsg(page, 'https://web.facebook.com', FINISH('1234567890', '9876543210'));
  await waitStatus(page, 'Connected');
  assert.deepEqual(calls[0], { code: 'CODE1', seller_id: 'seller-test', token: 'login-jwt', phone_number_id: '1234567890', waba_id: '9876543210' });
});

test('with no finish message the ids are left out (never empty) and the call still goes, so the door decides', { skip }, async () => {
  const calls = [];
  const { page } = await openFlow(good, calls);
  await start(page);
  await login(page);
  await waitStatus(page, 'Connected');
  assert.deepEqual(calls, [{ code: 'CODE1', seller_id: 'seller-test', token: 'login-jwt' }]);
  assert.ok(!('phone_number_id' in calls[0]) && !('waba_id' in calls[0]));
});

test('messages from other origins or with ids that are not Meta ids are ignored', { skip }, async () => {
  const bad = [
    ['https://evilfacebook.com', FINISH('1234567890', '9876543210')],
    ['https://example.com', FINISH('1234567890', '9876543210')],
    ['https://www.facebook.com.evil.example', FINISH('1234567890', '9876543210')],
    ['https://www.facebook.com', FINISH('12ab', '9876543210')],
    ['https://www.facebook.com', FINISH('1234567890', '')],
    ['https://www.facebook.com', FINISH(undefined, '9876543210')],
    ['https://www.facebook.com', { type: 'OTHER', event: 'FINISH', data: { phone_number_id: '1234567890', waba_id: '9876543210' } }],
    ['https://www.facebook.com', FINISH('1234567890', '9876543210'.repeat(5))]
  ];
  for (const [origin, data] of bad) {
    const calls = [];
    const { page } = await openFlow(good, calls);
    await start(page);
    await finishMsg(page, origin, data);
    await login(page);
    await waitStatus(page, 'Connected');
    assert.deepEqual(Object.keys(calls[0]).sort(), ['code', 'seller_id', 'token'], origin + ' ' + JSON.stringify(data).slice(0, 60));
    await page.close();
  }
});

test('ids sent as numbers are accepted; a cancel message stops the listening', { skip }, async () => {
  const a = [];
  const one = await openFlow(good, a);
  await start(one.page);
  await finishMsg(one.page, 'https://www.facebook.com', FINISH(1234567890, 9876543210));
  await login(one.page);
  await waitStatus(one.page, 'Connected');
  assert.equal(a[0].phone_number_id, '1234567890');
  const b = [];
  const two = await openFlow(good, b);
  await start(two.page);
  await finishMsg(two.page, 'https://www.facebook.com', { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'x' } });
  await finishMsg(two.page, 'https://www.facebook.com', FINISH('1234567890', '9876543210'));
  await login(two.page);
  await waitStatus(two.page, 'Connected');
  assert.deepEqual(Object.keys(b[0]).sort(), ['code', 'seller_id', 'token']);
});

test('without a login nothing is sent and the seller is told to sign in again', { skip }, async () => {
  const calls = [];
  const { page } = await openFlow(good, calls, null);
  await start(page);
  await finishMsg(page, 'https://www.facebook.com', FINISH('1234567890', '9876543210'));
  await login(page);
  await waitStatus(page, 'Failed');
  assert.equal(calls.length, 0);
  assert.deepEqual(await page.evaluate(() => window.__alerts), ['Could not connect your WhatsApp number: Please sign out and sign in again, then try once more.']);
});

test('what the door answers is shown exactly as before: a refusal text, a network failure, a cancel', { skip }, async () => {
  const refuse = await openFlow(() => ({ json: { success: false, error: 'Please pick the number you want to connect.' } }), []);
  await start(refuse.page);
  await login(refuse.page);
  await waitStatus(refuse.page, 'Failed');
  assert.deepEqual(await refuse.page.evaluate(() => window.__alerts), ['Could not connect your WhatsApp number: Please pick the number you want to connect.']);
  const down = await openFlow(() => ({ abort: true }), []);
  await start(down.page);
  await login(down.page);
  await waitStatus(down.page, 'Failed');
  const alerts = await down.page.evaluate(() => window.__alerts);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^Could not connect your WhatsApp number .{1,3} please try again\.$/);
  const calls = [];
  const cancel = await openFlow(good, calls);
  await start(cancel.page);
  await login(cancel.page, '');
  assert.equal(await status(cancel.page), '');
  assert.equal(calls.length, 0);
});

test('the login token is never shown to the seller', { skip }, async () => {
  const { page } = await openFlow(() => ({ json: { success: false, error: 'No.' } }), []);
  await start(page);
  await login(page);
  await waitStatus(page, 'Failed');
  const shown = (await status(page)) + (await page.evaluate(() => window.__alerts.join(' ')));
  assert.ok(!shown.includes('login-jwt'));
});

test('the Meta popup is opened with the same settings as before', { skip }, async () => {
  const { page } = await openFlow(good, []);
  await start(page);
  const opts = await page.evaluate(() => window.__fb.opts);
  assert.deepEqual(opts, { config_id: '1383145003804853', response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } });
});

test('the listener is removed once the call is made, so a later finish message changes nothing', { skip }, async () => {
  const calls = [];
  const { page } = await openFlow(good, calls);
  await start(page);
  await finishMsg(page, 'https://www.facebook.com', FINISH('1234567890', '9876543210'));
  await login(page);
  await waitStatus(page, 'Connected');
  await finishMsg(page, 'https://www.facebook.com', FINISH('5555555555', '6666666666'));
  assert.equal(calls.length, 1);
});
