// Run with:  node --test tests/*.test.mjs
// Four small writes (the assistant chat line, a new customer group and its members, the debt payment log row, the engine choice) go through the
// Seller Small Writes door with the person's own login. The older direct write runs when the door is down or not available (503, 404, 502,
// "not available", or the connection fails) and the door is then left alone for 30 seconds; a 429 shows "try again in a moment" and is never sent the
// older way; a door refusal or a login problem never falls back. The door and Supabase are faked by the test: nothing leaves the test; the token is a
// made-up word; no real data.
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
  const a = html.indexOf('w1-small-writes:js:start'); const b = html.indexOf('w1-small-writes:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1SwTry'));
  assert.ok(!/seller/i.test(call.replace(/Seller Small Writes|SELLER_SMALL_WRITES_URL|seller-small-writes/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
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

// ctl.door(body) -> { status, json } | 'abort'; `door` records bodies; `direct` the direct writes; `nudge` the Ahmad webhook calls.
async function open(ctl) {
  ctl = Object.assign({ door: () => ({ status: 200, json: { ok: true, count: 1, groupId: 77, undoId: 'u1' } }) }, ctl || {});
  const door = []; const direct = []; const alerts = []; let nudge = 0;
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.type() === 'prompt' ? d.accept('Wholesale customers') : d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-small-writes$/.test(u)) {
      door.push(JSON.parse(route.request().postData() || '{}')); const a = ctl.door(door[door.length - 1]);
      return a === 'abort' ? route.abort() : json(a.status, a.json);
    }
    if (/\/rest\/v1\/(seller_web_chat_log|customer_groups|customer_group_members|debt_payments|seller_engine)/.test(u) && m !== 'GET') {
      direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' });
      return /customer_groups/.test(u) ? json(201, [{ id: 5 }]) : route.fulfill({ status: 201, headers: h, body: '' });
    }
    if (/ahmad|business-chat/i.test(u) && m === 'POST') { nudge++; return json(200, {}); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__groups = []; window.agentLoadGroups = async (id) => { window.__groups.push(id); };
    window.renderDebtDetail = async () => {}; window.loadDebts = async () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, door, direct, alerts, ctl, nudges: () => nudge };
}
const T = 'made-up-token';

test('assistant chat line: assistantMessage with the text only; no direct write; the line is marked sent', { skip }, async () => {
  const { page, door, direct, alerts } = await open();
  const r = await page.evaluate(async () => {
    window.appendOptimisticBubble = () => 't1'; window.markOptimisticSent = (id) => { window.__sent = id; }; window.markOptimisticFailed = (id) => { window.__failed = id; };
    document.body.insertAdjacentHTML('beforeend', '<textarea id="reply-text">Hello there</textarea>');
    await sendAhmadMessage();
    return { sent: window.__sent || null, failed: window.__failed || null };
  });
  assert.deepEqual(door, [{ token: T, action: 'assistantMessage', message: 'Hello there' }]);
  assert.deepEqual(direct, []); assert.deepEqual(r, { sent: 't1', failed: null }); assert.deepEqual(alerts, []);
  await page.close();
});

test('a new group and its members: newGroup with the name (the screen selects the id the door answers); addGroupMembers with the group id and digit-only numbers', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    await agentNewGroup();
    document.getElementById('inbox-agent-group-select').innerHTML = '<option value="77" selected>g</option>'; document.getElementById('inbox-agent-group-numbers').value = '+15550102, 15550103';
    await agentPrepareGroup({ phone_number: '+15550101' });
  });
  assert.deepEqual(door, [{ token: T, action: 'newGroup', name: 'Wholesale customers' }, { token: T, action: 'addGroupMembers', groupId: 77, phones: ['15550101', '15550102', '15550103'] }]);
  assert.deepEqual(direct, []); assert.deepEqual(await page.evaluate(() => window.__groups), [77]);
  await page.close();
});

test('the debt payment log row: logDebtPayment with the phone and the amount; the allocation that follows is not this door', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    window.recordOrderPayment = async () => ({ changed: true }); currentDebtDetailPhone = '15550001'; currentDebtDetailOrders = [{ id: 'o1', order_total: 100, remaining: 100 }];
    document.body.insertAdjacentHTML('beforeend', '<input id="debt-payment-amount-input" value="$25"><button id="debt-record-payment-btn">Save Payment</button>');
    await recordDebtPayment();
  });
  assert.deepEqual(door, [{ token: T, action: 'logDebtPayment', phone: '15550001', amount: 25 }]);
  assert.deepEqual(direct, []);
  await page.close();
});

test('the engine choice: chooseEngine with the kind and the model id; the screen shows its own saved line', { skip }, async () => {
  const { page, door, direct } = await open();
  const text = await page.evaluate(async () => {
    window.engineRender = () => {}; document.body.insertAdjacentHTML('beforeend', '<div id="engine-saved-chat"></div>');
    await engineChoose('chat', 'model-x');
    return document.getElementById('engine-saved-chat').textContent;
  });
  assert.deepEqual(door, [{ token: T, action: 'chooseEngine', kind: 'chat', model: 'model-x' }]);
  assert.deepEqual(direct, []); assert.match(text, /^Saved\. /);
  await page.close();
});

test('the door is down or not available (503, 404, 502, not_available, or the connection fails): every write runs the older way, and the door is left alone for 30 seconds', { skip }, async () => {
  for (const down of [{ status: 503, json: {} }, { status: 404, json: {} }, { status: 502, json: {} }, { status: 200, json: { ok: false, error: 'not_available', message: 'x' } }, 'abort']) {
    const { page, door, direct } = await open({ door: () => down });
    await page.evaluate(async () => {
      window.appendOptimisticBubble = () => 't'; window.markOptimisticSent = () => {};
      document.body.insertAdjacentHTML('beforeend', '<textarea id="reply-text">Hi</textarea><div id="engine-saved-chat"></div>'); window.engineRender = () => {};
      await sendAhmadMessage(); await engineChoose('chat', 'model-x');
    });
    assert.equal(door.length, 1, 'asked once, then left alone');
    assert.deepEqual(direct.map((d) => d.method + ' ' + d.url.split('?')[0]), ['POST seller_web_chat_log', 'POST seller_engine']);
    assert.match(direct[0].body, /"seller_id":"web_s1"/); assert.match(direct[1].url, /on_conflict=seller_id/);
    // after the 30 seconds the door is asked again
    await page.evaluate(() => { W1_SW.pausedUntil = Date.now() - 1; window.agentLoadGroups = async () => {}; });
    await page.evaluate(() => agentNewGroup());
    assert.equal(door.length, 2, 'asked again after the pause');
    await page.close();
  }
});

test('a 429: the screen says "try again in a moment", nothing is sent the older way, and the door is left alone', { skip }, async () => {
  const { page, door, direct, alerts } = await open({ door: () => ({ status: 429, json: { ok: false } }) });
  await page.evaluate(() => agentNewGroup());
  assert.ok(alerts.includes('Something went wrong: Too many tries. Please try again in a moment.'));
  assert.deepEqual(direct, []); assert.equal(door.length, 1);
  await page.evaluate(() => agentNewGroup());
  assert.equal(door.length, 1, 'the door is left alone for 30 seconds');
  assert.equal(direct.length, 1, 'while it is left alone the older write runs');
  await page.close();
  const e = await open({ door: () => ({ status: 429, json: {} }) });
  const text = await e.page.evaluate(async () => { window.engineRender = () => {}; document.body.insertAdjacentHTML('beforeend', '<div id="engine-saved-chat"></div>'); await engineChoose('chat', 'm'); return document.getElementById('engine-saved-chat').textContent; });
  assert.equal(text, 'Too many tries. Please try again in a moment.'); assert.deepEqual(e.direct, []);
  await e.page.close();
});

test('a door refusal (including a refused login) never falls back: the door words show, nothing is written the older way; no login on this device runs the older write', { skip }, async () => {
  const { page, door, direct, alerts } = await open({ door: () => ({ status: 200, json: { ok: false, error: 'bad_input', message: 'The group name is too long.' } }) });
  await page.evaluate(() => agentNewGroup());
  assert.ok(alerts.includes('Something went wrong: The group name is too long.')); assert.deepEqual(direct, []);
  await page.close();
  const n = await open();
  await n.page.evaluate(() => { window.getValidAuthToken = async () => null; });
  await n.page.evaluate(() => agentNewGroup());
  assert.equal(n.door.length, 0); assert.equal(n.direct.length, 1, 'no login on this device: the older write runs');
  assert.ok(!n.alerts.some((a) => /Something went wrong/.test(a)), 'no error message');
  await n.page.close();
  const f = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  await f.page.evaluate(() => agentNewGroup());
  assert.deepEqual(f.direct, []); assert.ok(f.alerts.some((a) => a.endsWith('Please sign out and sign in again, then try once more.')));
  await f.page.close();
});
