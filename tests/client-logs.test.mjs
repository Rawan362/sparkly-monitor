// Run with:  node --test tests/*.test.mjs
// The two diagnostic inserts (an error line from logSystemError and the microphone note of the voice recorder) go through the Seller Client Logs door.
// The login token is optional (a line is never lost to a login problem); the older direct insert runs only when the door is down or not available
// (503, 404, 502, not_available, or the connection fails; then 30 seconds off); a 429, a "too many lines" answer and a refused line are dropped on
// purpose; nothing ever shows a message or breaks the app. The door and Supabase are faked by the test: nothing leaves the test; the token is a
// made-up word; no real log text.
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

test('this test file and the new block are ASCII; the door call sends no seller id and not the public key; the block writes nothing directly', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-client-logs:js:start'); const b = html.indexOf('w1-client-logs:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1ClSend'));
  assert.ok(!/seller/i.test(call.replace(/Seller Client Logs|SELLER_CLIENT_LOGS_URL|seller-client-logs/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
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

async function open(ctl, token) {
  ctl = Object.assign({ door: () => ({ status: 200, json: { ok: true } }) }, ctl || {});
  const door = []; const direct = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-client-logs$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); const a = ctl.door(b); return a === 'abort' ? route.abort() : (a.raw !== undefined ? route.fulfill({ status: a.status, contentType: 'text/html', headers: h, body: a.raw }) : json(a.status, a.json)); }
    if (/\/rest\/v1\/(system_errors|debug_log)/.test(u) && m !== 'GET') { direct.push({ url: u.replace(/^.*\/rest\/v1\//, ''), body: JSON.parse(route.request().postData() || '{}') }); return route.fulfill({ status: 201, headers: h, body: '' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate((tk) => { SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => tk; const l = document.getElementById('login-overlay'); if (l) l.remove(); }, token === undefined ? 'made-up-token' : token);
  door.length = 0; direct.length = 0;
  return { page, door, direct, alerts, ctl };
}

test('an error line: systemError with the source, the message cut to 500 characters, the context and the login token; no seller id; no direct insert', { skip }, async () => {
  const { page, door, direct, alerts } = await open();
  await page.evaluate(() => logSystemError('claimDeviceCode', 'x'.repeat(600), '15550001'));
  assert.equal(door.length, 1); assert.deepEqual(direct, []); assert.deepEqual(alerts, []);
  assert.deepEqual(Object.keys(door[0]).sort(), ['action', 'context', 'message', 'source', 'token']);
  assert.equal(door[0].action, 'systemError'); assert.equal(door[0].source, 'claimDeviceCode'); assert.equal(door[0].message.length, 500); assert.equal(door[0].context, '15550001'); assert.equal(door[0].token, 'made-up-token');
  await page.evaluate(() => logSystemError('plain', 'no context'));
  assert.equal(door[1].context, null);
  await page.close();
});

test('with no login the line is still sent (no token field); a login that cannot be read never stops it', { skip }, async () => {
  const { page, door, direct } = await open({}, null);
  await page.evaluate(() => logSystemError('boot', 'm'));
  assert.equal(door.length, 1); assert.equal('token' in door[0], false); assert.deepEqual(direct, []);
  await page.evaluate(() => { window.getValidAuthToken = async () => { throw new Error('no session'); }; return logSystemError('boot2', 'm'); });
  assert.equal(door.length, 2); assert.equal('token' in door[1], false);
  await page.close();
});

test('the microphone note: debugLog with the source "mic-settings" and the five fields; no direct insert', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [{ getSettings: () => ({ channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: false }) }], getTracks: () => [] });
    window.MediaRecorder = function () { throw new Error('no recorder in the test'); };
    try { await toggleRecording('15550001'); } catch (e) {}
  });
  await page.waitForTimeout(300);
  const note = door.find((b) => b.action === 'debugLog');
  assert.ok(note, 'the note was sent to the door');
  assert.deepEqual(Object.keys(note).sort(), ['action', 'data', 'source', 'token']); assert.equal(note.source, 'mic-settings');
  assert.deepEqual(Object.keys(note.data).sort(), ['channelCount', 'echoCancellation', 'noiseSuppression', 'sampleRate', 'ua']);
  assert.ok(!direct.some((d) => /debug_log/.test(d.url)));
  await page.close();
});

test('the door is down or not available (503, 404, 502, not_available, or the connection fails): the older direct insert runs with the same columns, and the door is left alone for 30 seconds', { skip }, async () => {
  for (const down of [{ status: 503, json: {} }, { status: 404, json: {} }, { status: 502, json: {} }, { status: 200, json: { ok: false, error: 'not_available', message: 'x' } }, 'abort']) {
    const { page, door, direct } = await open({ door: () => down });
    await page.evaluate(async () => { await logSystemError('a', 'one', 'c'); await logSystemError('b', 'two', null); });
    assert.equal(door.length, 1, 'asked once, then left alone');
    assert.deepEqual(direct.map((d) => d.url.split('?')[0]), ['system_errors', 'system_errors']);
    assert.deepEqual(direct[0].body, { seller_id: 'web_s1', source: 'a', error_message: 'one', context: 'c' });
    await page.evaluate(() => { W1_CL.pausedUntil = Date.now() - 1; return logSystemError('c', 'three', null); });
    assert.equal(door.length, 2, 'asked again after the pause'); 
    await page.close();
  }
});

test('a 429, a "too many lines" answer and a refused line are dropped on purpose (nothing is inserted the older way); an answer that is not understood is not repeated either', { skip }, async () => {
  for (const drop of [{ status: 429, json: {} }, { status: 200, json: { ok: false, error: 'rate_limited', message: 'x' } }, { status: 200, json: { ok: false, error: 'bad_input', message: 'x' } }, { status: 200, raw: '<html>', json: null }]) {
    const { page, door, direct, alerts } = await open({ door: () => drop });
    await page.evaluate(() => logSystemError('a', 'one', null));
    assert.equal(door.length, 1); assert.deepEqual(direct, []); assert.deepEqual(alerts, []);
    await page.close();
  }
});

test('logSystemError never throws or shows a message, whatever the door does', { skip }, async () => {
  const { page, alerts } = await open({ door: () => 'abort' });
  const out = await page.evaluate(async () => { try { await logSystemError('x', 'y', { deep: { a: 1 } }); return 'ok'; } catch (e) { return 'threw'; } });
  assert.equal(out, 'ok'); assert.deepEqual(alerts, []);
  await page.close();
});
