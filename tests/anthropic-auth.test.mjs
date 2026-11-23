// Run with:  node --test tests/*.test.mjs
// Every call to the two Anthropic edge functions (anthropic-connect: status, check, ask, connect, disconnect, usage, cost; anthropic-models: the
// model list) sends the person's own login token as "Authorization: Bearer <token>" (never the public key), and only the person's own seller id.
// A 401 shows "Please sign out and sign in again, then try once more." and is never treated as "not connected". The functions are faked by the
// test: nothing leaves the test; the token is a made-up word and no key value is used anywhere.
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
const SENTENCE = 'Please sign out and sign in again, then try once more.';

test('this test file has only ASCII; the two calls use the helper; the public key is never the bearer for them', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const lines = html.split('\n').filter((l) => l.includes('/functions/v1/anthropic-'));
  assert.equal(lines.length, 2, 'exactly the two calls');
  for (const l of lines) { assert.ok(l.includes('await w1AnthHeaders()'), l.slice(0, 80)); assert.ok(!/Bearer ' \+ SUPABASE_ANON_KEY/.test(l)); }
  const a = html.indexOf('const W1_ANTH_LOGIN_TEXT'); const blk = html.slice(a, html.indexOf('return r.json();', a));
  assert.ok(!/console\./.test(blk) && !/[^\x00-\x7f]/.test(blk));
  assert.ok(html.includes("const W1_ANTH_LOGIN_TEXT = '" + SENTENCE + "';"));
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

// `ctl.status` is the HTTP status both functions answer with; `ctl.json` the body. `calls` records header and body facts of every call.
async function open(ctl) {
  ctl = Object.assign({ status: 200, json: { ok: true, connected: true, admin_connected: false, state: 'ready', models: [] } }, ctl || {});
  const calls = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const m = u.match(/\/functions\/v1\/(anthropic-connect|anthropic-models)/);
    if (m) {
      const hd = route.request().headers(); let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) { b = {}; }
      calls.push({ fn: m[1], auth: hd['authorization'] || null, hasApikey: !!hd['apikey'], body: b });
      return route.fulfill({ status: ctl.status, contentType: 'application/json', headers: h, body: JSON.stringify(ctl.json) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => { SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token'; });
  return { page, calls, alerts, ctl };
}

test('every action of anthropic-connect and the model list carry the login token as the bearer, and only the own seller id', { skip }, async () => {
  const { page, calls } = await open();
  const anon = await page.evaluate(() => SUPABASE_ANON_KEY);
  await page.evaluate(async () => {
    for (const a of ['status', 'check', 'ask', 'connect', 'disconnect', 'usage', 'cost']) await engineCall({ action: a });
    await engineLoadModels();
  });
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map((c) => c.fn), Array(7).fill('anthropic-connect').concat(['anthropic-models']));
  for (const c of calls) {
    assert.equal(c.auth, 'Bearer made-up-token');
    assert.notEqual(c.auth, 'Bearer ' + anon, 'not the public key');
    assert.equal(c.hasApikey, true, 'the gateway key header stays as before');
    assert.equal(c.body.seller_id, 'web_s1');
  }
  assert.deepEqual(calls.slice(0, 7).map((c) => c.body.action), ['status', 'check', 'ask', 'connect', 'disconnect', 'usage', 'cost']);
  await page.close();
});

test('a caller can not send another seller id: the own one always wins', { skip }, async () => {
  const { page, calls } = await open();
  await page.evaluate(() => engineCall({ action: 'status', seller_id: 'someone_else' }));
  assert.equal(calls[0].body.seller_id, 'web_s1');
  await page.close();
});

test('no token readable: no bearer is sent (never the public key); the call is still made as before', { skip }, async () => {
  const { page, calls } = await open();
  await page.evaluate(() => { window.getValidAuthToken = async () => { throw new Error('no session'); }; });
  await page.evaluate(async () => { await engineCall({ action: 'status' }); await engineLoadModels(); });
  assert.equal(calls.length, 2);
  for (const c of calls) { assert.equal(c.auth, null); assert.equal(c.hasApikey, true); }
  await page.close();
});

test('a working seller sees no change: the answers pass straight through', { skip }, async () => {
  const { page } = await open({ json: { ok: true, connected: true, admin_connected: false, key_hint: 'hint', models: [{ id: 'm1', name: 'M1' }] } });
  const r = await page.evaluate(async () => { const s = await engineCall({ action: 'status' }); await engineLoadModels(); return { s, models: engineState.liveModels.length, note: engineState.modelsNote }; });
  assert.equal(r.s.connected, true); assert.equal(r.s.key_hint, 'hint'); assert.equal(r.models, 1);
  assert.match(r.note, /1 found/);
  await page.close();
});

test('401: every screen shows the plain sentence; a 401 is never "not connected" and never opens the set-up popup', { skip }, async () => {
  const { page, alerts } = await open({ status: 401, json: { ok: false, error: 'login_required' } });
  const r = await page.evaluate(async () => {
    const out = {};
    out.call = await engineCall({ action: 'status' });
    engineState.conn = null; await engineLoadConn();
    out.conn = { connected: engineState.conn.connected, state: engineState.conn.state, login: engineState.conn.loginRequired };
    out.card = engineConnCard();
    out.ready = await ensureAiReady();
    out.wizard = !!document.getElementById('ai-setup-wizard');
    engineState.liveModels = []; await engineLoadModels(); out.note = engineState.modelsNote;
    engineOpenConnect(); document.getElementById('eng-key').value = 'not-a-real-key'; await engineConnectSave(); out.connectErr = document.getElementById('eng-conn-err').textContent;
    return out;
  });
  assert.equal(r.call.ok, false); assert.equal(r.call.error, SENTENCE);
  assert.deepEqual(r.conn, { connected: false, state: 'error', login: true });
  assert.ok(r.card.includes(SENTENCE));
  assert.equal(r.ready, true, 'the AI check never locks a seller out'); assert.equal(r.wizard, false);
  assert.ok(r.note.startsWith(SENTENCE));
  assert.equal(r.connectErr, SENTENCE);
  // the coach and Remove my key
  const reply = await page.evaluate(async () => { engineState.coach = []; document.body.insertAdjacentHTML('beforeend', '<div id="eng-coach-box"></div>'); await engineCoachAsk('How much did I spend?'); return engineState.coach[engineState.coach.length - 1].content; });
  assert.equal(reply, SENTENCE);
  await page.evaluate(() => { engineOpenConnect(); return engineDisconnect(); });
  assert.ok(alerts.includes(SENTENCE));
  await page.close();
});

test('the key check, the Connect and check button and the funds check are unchanged', () => {
  assert.ok(html.includes("try { const r = await engineCall({ action: 'check' }); return r.state || 'error'; } catch (e) { return 'error'; }"));
  assert.ok(html.includes('<button class="eng-btn" id="ai-w-go">Connect and check</button>'));
  assert.ok(html.includes('<button class="eng-btn sec" id="ai-w-recheck">I added funds, check again</button>'));
  assert.ok(html.includes("const r = await engineCall({ action: 'connect', key: k });"));
});
