// Run with:  node --test tests/*.test.mjs
// Device linking through the Seller Device Link door and a login for the linked device (backend PR 322, Option B): the new device creates a code,
// polls status, registers with claimLinked, gets a signed login token (memory only) and uses it on every door call; the signed-in phone approves
// with its own login; a linked device uses heartbeatLinked and logoutLinked; when a door is not available the older flow runs exactly as before.
// All doors are faked by the test: nothing leaves the test; the tokens and the secret are made-up words.
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
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('this test file and the new block are ASCII; the secret and the device token are never written to storage or a web address', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-device-flow:js:start'); const b = html.indexOf('w1-device-flow:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block));
  const setItems = block.match(/localStorage\.setItem\([^)]*\)/g) || [];
  assert.deepEqual(setItems.sort(), ["localStorage.setItem('sparkly_session_token', sessionToken)", 'localStorage.setItem(W1_DL_FLAG, \'1\')'].sort());
  assert.ok(!/sessionStorage/.test(block));
  assert.ok(!/location\.(href|search|hash)\s*=|encodeURIComponent\(W1_DL\.(secret|token)/.test(block));
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

// ctl.link(body) answers the Device Link door, ctl.sess(body) the Sessions door. `calls` records { door, body } in order; `direct` the direct
// device_link_codes requests; `alerts` the messages shown.
async function open(ctl, preload) {
  const ok = { status: 200, json: { ok: true } };
  ctl = Object.assign({
    link: (b) => b.action === 'create' ? { status: 200, json: { ok: true, code: 'ABCDEFGH2345', secret: 'made-up-secret', expiresInSeconds: 600 } } : b.action === 'status' ? { status: 200, json: { ok: true, state: 'approved' } } : b.action === 'token' ? { status: 200, json: { ok: true, token: 'dl1.made-up-token', expiresInSeconds: 600 } } : ok,
    sess: (b) => b.action === 'heartbeatLinked' ? { status: 200, json: { ok: true, active: true } } : ok,
    me: { status: 200, json: { ok: true, hasSeller: true, chatId: 'web_dev1' } }
  }, ctl || {});
  const calls = []; const direct = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  if (preload) await page.addInitScript(preload);
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    const b = () => { try { return JSON.parse(route.request().postData() || '{}'); } catch (e) { return {}; } };
    if (/\/webhook\/seller-device-link$/.test(u)) { const body = b(); calls.push({ door: 'link', body }); const a = ctl.link(body); return json(a.status, a.json); }
    if (/\/webhook\/seller-sessions$/.test(u)) { const body = b(); calls.push({ door: 'sess', body }); const a = ctl.sess(body); return json(a.status, a.json); }
    if (/\/webhook\/seller-own-row$/.test(u)) { const body = b(); calls.push({ door: 'me', body }); return json(ctl.me.status, ctl.me.json); }
    if (/\/rest\/v1\/device_link_codes/.test(u)) { direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' }); return m === 'GET' ? json(200, []) : route.fulfill({ status: 204, headers: h, body: '' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__started = 0; window.startApp = function () { window.__started++; }; window.t = window.t || ((k) => k); });
  return { page, calls, direct, alerts, ctl };
}
const links = (calls) => calls.filter((c) => c.door === 'link').map((c) => c.body);

test('new device: create, status until approved, claimLinked with its own session token, token, then the business from the token, then the app starts', { skip }, async () => {
  const { page, calls } = await open();
  await page.evaluate(() => openNewDeviceLinkScreen());
  await page.waitForFunction(() => window.__started === 1, null, { timeout: 8000 });
  const order = calls.map((c) => c.door + ':' + (c.body.action || ''));
  assert.deepEqual(order, ['link:create', 'link:status', 'sess:claimLinked', 'link:token', 'me:me']);
  assert.deepEqual(calls[1].body, { action: 'status', code: 'ABCDEFGH2345', secret: 'made-up-secret' });
  const claim = calls[2].body;
  assert.equal(claim.code, 'ABCDEFGH2345'); assert.match(claim.sessionToken, /^[A-Za-z0-9-]{16,200}$/); assert.equal(typeof claim.deviceLabel, 'string');
  assert.equal('token' in claim, false, 'claimLinked needs no login');
  assert.deepEqual(calls[3].body, { action: 'token', sessionToken: claim.sessionToken });
  assert.deepEqual(calls[4].body, { token: 'dl1.made-up-token', action: 'me' });
  const st = await page.evaluate(() => ({ chat: SELLER_CHAT_ID, saved: localStorage.getItem('sparkly_seller_chat_id'), session: localStorage.getItem('sparkly_session_token'), flag: localStorage.getItem(W1_DL_FLAG), all: JSON.stringify([localStorage, sessionStorage]) + location.href, secret: W1_DL.secret, code: W1_DL.code }));
  assert.equal(st.chat, 'web_dev1'); assert.equal(st.saved, 'web_dev1'); assert.equal(st.session, claim.sessionToken); assert.equal(st.flag, '1');
  assert.ok(!st.all.includes('made-up-secret') && !st.all.includes('dl1.made-up-token'), 'the secret and the device token are in memory only');
  assert.equal(st.secret, ''); assert.equal(st.code, '');
  await page.close();
});

test('new device: an expired or unknown code ends the flow with a plain message, nothing is registered', { skip }, async () => {
  const { page, calls, alerts } = await open({ link: (b) => b.action === 'create' ? { status: 200, json: { ok: true, code: 'ABCDEFGH2345', secret: 's', expiresInSeconds: 600 } } : { status: 200, json: { ok: false, error: 'invalid_code', message: 'x' } } });
  await page.evaluate(() => openNewDeviceLinkScreen());
  await page.waitForFunction(() => !document.getElementById('link-device-overlay').classList.contains('show') && W1_DL.code === '', null, { timeout: 8000 });
  assert.ok(alerts.includes('This code is not valid or has expired. Make a new code on the other device.'));
  assert.ok(!calls.some((c) => c.door === 'sess'));
  await page.close();
});

test('new device: when claimLinked or token is not available, a plain message shows and no half-linked device is kept', { skip }, async () => {
  const a = await open({ sess: () => ({ status: 503, json: { ok: false, code: 'not_ready' } }) });
  await a.page.evaluate(() => openNewDeviceLinkScreen());
  await a.page.waitForFunction(() => W1_DL.code === '', null, { timeout: 8000 });
  assert.ok(a.alerts.includes('Linking is not available yet. Please try again later.'));
  assert.equal(await a.page.evaluate(() => localStorage.getItem(W1_DL_FLAG) + '|' + localStorage.getItem('sparkly_session_token')), 'null|null');
  await a.page.close();
});

test('create not available: the older flow runs exactly as before (a code written to device_link_codes), and the door is asked once', { skip }, async () => {
  const { page, calls, direct } = await open({ link: () => ({ status: 503, json: { ok: false, code: 'not_ready' } }) });
  await page.evaluate(() => { document.getElementById('link-device-overlay'); return openNewDeviceLinkScreen(); });
  await page.waitForTimeout(300);
  assert.ok(direct.some((d) => d.method === 'POST' && d.url.startsWith('device_link_codes')), 'the old code row is written');
  assert.equal(links(calls).length, 1);
  await page.evaluate(() => closeLinkDeviceFlow());
  await page.evaluate(() => openNewDeviceLinkScreen());
  assert.equal(links(calls).length, 1, 'not asked again');
  await page.close();
});

const LINKED = () => { if (sessionStorage.getItem('w1-test-seeded')) return; sessionStorage.setItem('w1-test-seeded', '1'); localStorage.setItem('sparkly_linked_device_token_flag', '1'); localStorage.setItem('sparkly_session_token', 'dev-session-token-0001'); localStorage.setItem('sparkly_seller_chat_id', 'web_dev1'); };

test('a linked device: the door token is the login token of every door call; renewed after 5 minutes, one call at a time; no mismatch error', { skip }, async () => {
  let n = 0;
  const { page, calls } = await open({ link: (b) => b.action === 'token' ? { status: 200, json: { ok: true, token: 'dl1.token-' + (++n) } } : { status: 200, json: { ok: true } } }, LINKED);
  await page.evaluate(() => { SELLER_CHAT_ID = 'web_dev1'; W1_DL.token = ''; W1_DL.tokenAt = 0; });
  n = 0; calls.length = 0;
  const r = await page.evaluate(async () => { const [a, b] = await Promise.all([getValidAuthToken(), getValidAuthToken()]); return [a, b, await getValidAuthToken()]; });
  assert.deepEqual(r, ['dl1.token-1', 'dl1.token-1', 'dl1.token-1']);
  assert.deepEqual(links(calls), [{ action: 'token', sessionToken: 'dev-session-token-0001' }], 'one call for three uses');
  await page.evaluate(() => { W1_DL.tokenAt = Date.now() - 6 * 60 * 1000; });
  assert.equal(await page.evaluate(() => getValidAuthToken()), 'dl1.token-2');
  assert.equal(links(calls).length, 2);
  await page.close();
});

test('a linked device: "invalid_session" (signed out or removed) logs it out', { skip }, async () => {
  let gone = false;
  const { page } = await open({ link: (b) => gone && b.action === 'token' ? { status: 200, json: { ok: false, error: 'invalid_session', message: 'x' } } : { status: 200, json: { ok: true, token: 'dl1.t' } } }, LINKED);
  gone = true;
  await page.evaluate(() => { W1_DL.token = ''; W1_DL.tokenAt = 0; window.__out = 0; window.w1SessionSignedOutHere = function () { window.__out++; clearAllAuthStorage(); }; SELLER_CHAT_ID = 'web_dev1'; });
  assert.equal(await page.evaluate(() => getValidAuthToken()), null);
  assert.equal(await page.evaluate(() => window.__out), 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_session_token')), null);
  await page.close();
});

test('a linked device: heartbeatLinked on its actions without a login; not active logs it out; ensureSession does not register it again', { skip }, async () => {
  let active = true;
  const { page, calls } = await open({ sess: (b) => b.action === 'heartbeatLinked' ? { status: 200, json: { ok: true, active } } : { status: 200, json: { ok: true } } }, LINKED);
  await page.evaluate(() => { window.__out = 0; window.w1SessionSignedOutHere = function () { window.__out++; }; SELLER_CHAT_ID = 'web_dev1'; });
  await page.evaluate(async () => { await ensureSession(); });
  assert.equal(calls.filter((c) => c.door === 'sess').length, 0, 'no ensure for a linked device');
  assert.equal(await page.evaluate(() => w1SessionCheck(true)), 'ok');
  assert.deepEqual(calls.find((c) => c.door === 'sess').body, { action: 'heartbeatLinked', sessionToken: 'dev-session-token-0001' });
  active = false;
  assert.equal(await page.evaluate(() => w1SessionCheck(true)), 'signed_out');
  assert.equal(await page.evaluate(() => window.__out), 1);
  await page.close();
});

test('a linked device: Sign out sends logoutLinked and clears the device', { skip }, async () => {
  const { page, calls } = await open({}, LINKED);
  const nav = page.waitForNavigation({ waitUntil: 'load' });
  await page.evaluate(() => logout());
  await nav;
  assert.ok(calls.some((c) => c.door === 'sess' && c.body.action === 'logoutLinked' && c.body.sessionToken === 'dev-session-token-0001'));
  assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_session_token') + '|' + localStorage.getItem(W1_DL_FLAG) + '|' + localStorage.getItem('sparkly_seller_chat_id')), 'null|null|null');
  await page.close();
});

test('a device linked the old way (no flag) is not changed: no token call, the older session code runs', { skip }, async () => {
  const { page, calls } = await open({}, () => { localStorage.setItem('sparkly_session_token', 'old-way-session'); localStorage.setItem('sparkly_seller_chat_id', 'web_old'); });
  await page.evaluate(() => { SELLER_CHAT_ID = 'web_old'; });
  assert.equal(await page.evaluate(() => w1DlIsLinked()), false);
  assert.equal(await page.evaluate(() => getValidAuthToken()), null);
  assert.equal(links(calls).length, 0);
  await page.close();
});

test('the signed-in phone approves with its own login: approve, code and token only, no seller id; the Devices list reloads', { skip }, async () => {
  const { page, calls, alerts } = await open();
  await page.evaluate(() => { SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'phone-login-token'; window.renderDevicesList = async () => { window.__list = 1; }; window.stopDeviceScanner = () => {}; });
  await page.evaluate(() => claimDeviceCode('ABCDEFGH2345'));
  assert.deepEqual(links(calls), [{ action: 'approve', token: 'phone-login-token', code: 'ABCDEFGH2345' }]);
  assert.equal(await page.evaluate(() => window.__list), 1);
  assert.ok(alerts.includes('Link this new device to your account?'));
  await page.close();
});

test('the phone: an invalid code and a missing login show plain words; a refusal never writes the old way', { skip }, async () => {
  const a = await open({ link: () => ({ status: 200, json: { ok: false, error: 'invalid_code', message: 'x' } }) });
  await a.page.evaluate(() => { SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'phone-login-token'; });
  await a.page.evaluate(() => claimDeviceCode('ZZZZZZZZZZZZ'));
  assert.ok(a.alerts.some((m) => m.endsWith('This code is not valid or has expired. Make a new code on the other device.')));
  assert.deepEqual(a.direct, []);
  await a.page.close();
  const b = await open();
  await b.page.evaluate(() => { SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => null; });
  await b.page.evaluate(() => claimDeviceCode('ABCDEFGH2345'));
  assert.ok(b.alerts.includes('Please sign out and sign in again, then try once more.'));
  assert.equal(links(b.calls).length, 0);
  await b.page.close();
});

test('the phone: approve not available runs the older direct approval, with one question only', { skip }, async () => {
  const { page, direct, alerts } = await open({ link: () => ({ status: 503, json: { ok: false, code: 'not_ready' } }) });
  await page.evaluate(() => { SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'phone-login-token'; window.renderDevicesList = async () => {}; window.stopDeviceScanner = () => {}; });
  await page.evaluate(() => claimDeviceCode('ABCDEFGH2345'));
  assert.equal(alerts.filter((m) => m === 'Link this new device to your account?').length, 1);
  assert.ok(direct.some((d) => d.method === 'GET' && /device_link_codes\?code=eq\.ABCDEFGH2345/.test(d.url)), 'the older lookup ran');
  await page.close();
});
