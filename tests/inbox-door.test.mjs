// Run with:  node --test tests/*.test.mjs
// The Inbox card writes (Good / Adjust with rule choices, "Got it" on an alert, the lesson form, starting a lesson) go through the Seller Inbox Cards
// door with the person's own login: the rule choices travel with the card in ONE call, the lesson with its card in one call; an Undo button follows.
// Door first; the older direct writes run when the door is down or not available (503, 404, 502, not_available, the connection fails; then 30 seconds
// off) or when this device has no login; a 429 shows "try again in a moment"; a door refusal never falls back. The door and Supabase are faked by
// the test: nothing leaves the test; the token is a made-up word; no real card text.
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
  const a = html.indexOf('w1-inbox-door:js:start'); const b = html.indexOf('w1-inbox-door:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1IcTry'), block.indexOf('// One card write'));
  assert.ok(!/seller/i.test(call.replace(/Seller Inbox Cards|SELLER_INBOX_CARDS_URL|seller-inbox-cards/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
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

async function open(ctl) {
  ctl = Object.assign({ door: () => ({ status: 200, json: { ok: true, count: 1, undoId: 'u1' } }) }, ctl || {});
  const door = []; const direct = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-inbox-cards$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); const a = ctl.door(b); return a === 'abort' ? route.abort() : json(a.status, a.json); }
    if (/\/rest\/v1\/(pending_questions|rule_resolutions|seller_learned_answers)/.test(u) && m !== 'GET') { direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' }); return route.fulfill({ status: 201, headers: h, body: '' }); }
    if (/\/rest\/v1\/pending_questions/.test(u)) return json(200, [{ id: 31, phone_number: '15550001', kind: 'chat_needed', status: 'pending' }]);
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__li = 0; window.loadInboxList = async () => { window.__li++; }; window.checkInboxDot = async () => {}; window.closeInboxDetail = () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, door, direct, alerts, ctl };
}
const T = 'made-up-token';
const note = (page) => page.evaluate(() => { const b = document.getElementById('w1-ic-note'); return b && b.style.display !== 'none' ? { text: document.getElementById('w1-ic-note-msg').textContent, undo: document.getElementById('w1-ic-undo-btn').style.display !== 'none' } : null; });
const card = { id: 31, phone_number: '15550001', meta: { breaks: [{ id: '11111111-1111-4111-8111-111111111111', topic: 'Greeting' }, { id: '22222222-2222-4222-8222-222222222222', topic: 'Price' }] } };
const decide = (page, scope, decision, instruction, answer) => page.evaluate(async ([c, sc, d, i, a]) => { agentScope = sc; await agentSaveResolutions(c, d, i); await agentCloseCard(c, a); }, [card, scope, decision, instruction, answer]);

test('Good and Adjust: the rule choices travel with the card in ONE closeCard call; no direct write; an Undo button follows', { skip }, async () => {
  const { page, door, direct } = await open();
  await decide(page, 'customer', 'good', null, 'Good (customer)');
  await decide(page, 'all', 'adjust', 'Be brief', 'Adjusted (all): Be brief');
  assert.equal(door.length, 2); assert.deepEqual(direct, []);
  assert.deepEqual(door[0], { token: T, action: 'closeCard', id: 31, answer: 'Good (customer)', scope: 'this_customer', rules: [{ decision: 'good', guidelineId: '11111111-1111-4111-8111-111111111111', topic: 'Greeting' }, { decision: 'good', guidelineId: '22222222-2222-4222-8222-222222222222', topic: 'Price' }] });
  assert.equal(door[1].scope, 'all_customers'); assert.equal(door[1].rules[0].instruction, 'Be brief'); assert.equal(door[1].rules[0].decision, 'adjust');
  assert.deepEqual(await note(page), { text: 'Card saved.', undo: true });
  await page.click('#w1-ic-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-ic-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(door[2], { token: T, action: 'undo', undoId: 'u1' });
  assert.ok(await page.evaluate(() => window.__li) >= 1);
  await page.close();
});

test('a group choice: the group id goes with the card; a card with no rule choices sends no rules', { skip }, async () => {
  const { page, door } = await open();
  await page.evaluate(async () => { window.agentPrepareGroup = async () => 9; agentScope = 'group'; await agentSaveResolutions({ id: 5, phone_number: '1', meta: { breaks: [{ id: '11111111-1111-4111-8111-111111111111' }] } }, 'good', null); await agentCloseCard({ id: 5, phone_number: '1', meta: { breaks: [{ id: '11111111-1111-4111-8111-111111111111' }] } }, 'Good (group)'); });
  assert.equal(door[0].scope, 'group'); assert.equal(door[0].groupId, 9);
  const none = await open();
  await none.page.evaluate(async () => { agentScope = 'customer'; await agentSaveResolutions({ id: 6, meta: {} }, 'good', null); await agentCloseCard({ id: 6, meta: {} }, 'Good'); });
  assert.equal('rules' in none.door[0], false);
  await page.close(); await none.page.close();
});

test('"Got it" on an alert: dismissAlert with the card id', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(() => { inboxCurrentQuestion = { id: 31 }; return inboxDismissAlert(); });
  assert.deepEqual(door, [{ token: T, action: 'dismissAlert', id: 31 }]); assert.deepEqual(direct, []);
  assert.deepEqual(await note(page), { text: 'Card closed.', undo: true });
  await page.close();
});

test('the lesson form: one submitLesson call for the learned answer and the card (all customers and this customer only)', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    inboxCurrentQuestion = { id: 31, question: 'Do you ship abroad?', department: 'sales' };
    document.getElementById('inbox-lesson-text').value = 'Yes, in 5 days'; lessonScope = 'all_customers'; await submitLesson();
    lessonScope = 'this_customer'; await submitLesson();
  });
  assert.deepEqual(door[0], { token: T, action: 'submitLesson', id: 31, answer: 'Yes, in 5 days', scope: 'all_customers', summary: 'Do you ship abroad?', department: 'sales' });
  assert.deepEqual([door[1].answer, door[1].scope], ['(solved in the chat)', 'this_customer']);
  assert.deepEqual(direct, []);
  await page.close();
});

test('turning the AI back on starts the lesson through the door (the customer phone only)', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { window.openSellerInboxFromChats = async () => {}; window.openInboxDetail = () => {}; window.confirm = () => false; await startLessonIfNeeded('15550001'); });
  assert.deepEqual(door, [{ token: T, action: 'startLesson', phone: '15550001' }]); assert.deepEqual(direct, []);
  await page.close();
});

test('the door is down or not available (503, 404, 502, not_available, or the connection fails): every write runs the older way, the rule choices first, and the door is left alone for 30 seconds', { skip }, async () => {
  for (const down of [{ status: 503, json: {} }, { status: 404, json: {} }, { status: 502, json: {} }, { status: 200, json: { ok: false, error: 'not_available', message: 'x' } }, 'abort']) {
    const { page, door, direct } = await open({ door: () => down });
    await decide(page, 'customer', 'good', null, 'Good (customer)');
    assert.equal(door.length, 1, 'asked once');
    assert.deepEqual(direct.map((d) => d.method + ' ' + d.url.split('?')[0]), ['POST rule_resolutions', 'PATCH pending_questions'], 'the rule choices first, then the card');
    assert.match(direct[0].body, /"decision":"good"/); assert.match(direct[1].body, /"answer_scope":"this_customer"/);
    await page.evaluate(async () => { inboxCurrentQuestion = { id: 31 }; await inboxDismissAlert(); });
    assert.equal(door.length, 1, 'left alone for 30 seconds'); assert.equal(direct.length, 3);
    await page.evaluate(() => { W1_IC.pausedUntil = Date.now() - 1; });
    await page.evaluate(async () => { inboxCurrentQuestion = { id: 31 }; await inboxDismissAlert(); });
    assert.equal(door.length, 2, 'asked again after the pause');
    await page.close();
  }
});

test('a 429, a refusal and a refused login show plain words and never fall back; no login on this device runs the older writes', { skip }, async () => {
  const t = await open({ door: () => ({ status: 429, json: {} }) });
  await decide(t.page, 'customer', 'good', null, 'x').catch(() => {});
  assert.deepEqual(t.direct, []);
  await t.page.evaluate(() => { W1_IC.pausedUntil = 0; inboxCurrentQuestion = { id: 31 }; return inboxDismissAlert(); });
  assert.ok(t.alerts.includes('Something went wrong: Too many tries. Please try again in a moment.')); assert.deepEqual(t.direct, []);
  await t.page.close();
  const r = await open({ door: () => ({ status: 200, json: { ok: false, error: 'card_closed', message: 'This card was already answered.' } }) });
  await r.page.evaluate(() => { inboxCurrentQuestion = { id: 31 }; return inboxDismissAlert(); });
  assert.ok(r.alerts.includes('Something went wrong: This card was already answered.')); assert.deepEqual(r.direct, []);
  await r.page.close();
  const l = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  await l.page.evaluate(() => { inboxCurrentQuestion = { id: 31 }; return inboxDismissAlert(); });
  assert.ok(l.alerts.some((a) => a.endsWith('Please sign out and sign in again, then try once more.'))); assert.deepEqual(l.direct, []);
  await l.page.close();
  const n = await open();
  await n.page.evaluate(async () => { window.getValidAuthToken = async () => null; inboxCurrentQuestion = { id: 31 }; await inboxDismissAlert(); });
  assert.equal(n.door.length, 0); assert.equal(n.direct.length, 1);
  await n.page.close();
});
