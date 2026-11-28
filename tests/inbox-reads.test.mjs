// Run with:  node --test tests/*.test.mjs
// The notification list and the Inbox / agent card reads go through the Seller Inbox Read door with the person's own login; the older direct read runs
// when the door is down or not available (503, 404, 502, 429, the connection fails, an answer that is not understood; then 30 seconds off) or when
// this device has no login; a refused login is not read the older way. The door and Supabase are faked by the test: nothing leaves the test; the
// token is a made-up word; no real notification or card text.
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

test('this test file and the new block are ASCII; the door call sends no seller id and not the public key; the block reads nothing directly', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-inbox-reads:js:start'); const b = html.indexOf('w1-inbox-reads:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1IrTry'), block.indexOf('async function w1IrRead'));
  assert.ok(!/seller/i.test(call.replace(/Seller Inbox Read|SELLER_INBOX_READ_URL|seller-inbox-read/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
  assert.equal((html.match(/w1IrRead\('/g) || []).length, 7, 'the seven reads');
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

const ANSWERS = {
  notifications: { ok: true, notifications: [{ id: 1, type: 'x', title: 'T', message: 'M', is_read: false, created_at: '2026-11-20T10:00:00Z' }] },
  notification: { ok: true, notification: { id: 1, type: 'x', title: 'T', message: 'M', is_read: true } },
  inboxList: { ok: true, questions: [{ id: 31, kind: 'question', status: 'pending', question: 'Q' }] },
  question: { ok: true, question: { id: 31, kind: 'question', status: 'pending', question: 'Q' } },
  chatNeeded: { ok: true, question: { id: 32, kind: 'chat_needed', status: 'pending', phone_number: '15550001' } },
  groups: { ok: true, groups: [{ id: 5, name: 'G' }] }
};
async function open(ctl) {
  ctl = Object.assign({ door: (b) => ({ status: 200, json: ANSWERS[b.action] }) }, ctl || {});
  const door = []; const direct = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => d.accept());
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-inbox-read$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); const a = ctl.door(b); return a === 'abort' ? route.abort() : (a.raw !== undefined ? route.fulfill({ status: a.status, contentType: 'text/html', headers: h, body: a.raw }) : json(a.status, a.json)); }
    if (/\/rest\/v1\/(seller_notifications|pending_questions|customer_groups)/.test(u) && m === 'GET') { direct.push(u.replace(/^.*\/rest\/v1\//, '').split('&')[0]); return json(200, []); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.checkNotificationsDot = async () => {}; window.checkInboxDot = async () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  const settle = () => page.waitForTimeout(150);
  direct.length = 0; door.length = 0;
  return { page, door, direct, ctl, settle };
}
const T = 'made-up-token';

test('every read asks the door with its action and no seller id, and gets the rows in the shape the screen already had; nothing is read directly', { skip }, async () => {
  const { page, door, direct } = await open();
  const out = await page.evaluate(async () => ({
    notifications: await w1IrRead('notifications', {}, () => 'D'),
    notification: await w1IrRead('notification', { id: 1 }, () => 'D'),
    inboxList: await w1IrRead('inboxList', {}, () => 'D'),
    question: await w1IrRead('question', { id: 31 }, () => 'D'),
    chatNeeded: await w1IrRead('chatNeeded', { phone: '15550001' }, () => 'D'),
    groups: await w1IrRead('groups', {}, () => 'D')
  }));
  assert.deepEqual(door, [{ token: T, action: 'notifications' }, { token: T, action: 'notification', id: 1 }, { token: T, action: 'inboxList' }, { token: T, action: 'question', id: 31 }, { token: T, action: 'chatNeeded', phone: '15550001' }, { token: T, action: 'groups' }]);
  assert.equal(out.notifications.length, 1); assert.equal(out.notification[0].is_read, true); assert.equal(out.inboxList[0].id, 31); assert.equal(out.question[0].id, 31); assert.equal(out.chatNeeded[0].id, 32); assert.deepEqual(out.groups, [{ id: 5, name: 'G' }]);
  assert.deepEqual(direct, []);
  await page.close();
});

test('the screens use the door: the notification list, the card list, the groups, a question from a notification and a discussion; no direct read', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    window.closeNotificationsPanel = () => {}; window.goToChats = () => {}; window.openSellerInboxFromChats = async () => {}; window.openInboxDetail = () => {}; window.startNewBusinessChat = async () => {}; window.showBcEmptyState = () => {}; window.renderBcMessage = () => ({}); window.sendBusinessChatTurn = async () => {};
    await loadNotifications(); await loadInboxList(); await agentLoadGroups(); await openQuestionFromNotification(1, 31); await discussNotification(1);
  });
  assert.deepEqual(door.map((b) => b.action), ['notifications', 'inboxList', 'groups', 'question', 'notification']);
  assert.deepEqual(direct, []);
  await page.close();
});

test('"not found" answers (no_notification, no_question) are an empty result, as the older read gave, and nothing is read the older way', { skip }, async () => {
  const { page, direct } = await open({ door: (b) => ({ status: 200, json: { ok: false, error: b.action === 'question' ? 'no_question' : 'no_notification', message: 'x' } }) });
  const out = await page.evaluate(async () => [await w1IrRead('question', { id: 1 }, () => 'D'), await w1IrRead('notification', { id: 1 }, () => 'D')]);
  assert.deepEqual(out, [[], []]); assert.deepEqual(direct, []);
  await page.close();
});

test('the door is down or not available (503, 404, 502, 429, the connection fails, not understood, another refusal): the older read runs, and the door is left alone for 30 seconds', { skip }, async () => {
  const cases = [{ status: 503, json: {} }, { status: 404, json: {} }, { status: 502, json: {} }, { status: 429, json: {} }, 'abort', { status: 200, raw: '<html>', json: null }, { status: 200, json: { ok: false, error: 'not_available', message: 'x' } }, { status: 200, json: { ok: false, error: 'read_failed', message: 'x' } }];
  for (const down of cases) {
    const { page, door, direct } = await open({ door: () => down });
    await page.evaluate(async () => { window.loadNotifications = window.loadNotifications; await loadNotifications(); await loadInboxList(); });
    assert.equal(door.length, 1, 'asked once, then left alone');
    assert.deepEqual(direct.map((d) => d.split('?')[0]), ['seller_notifications', 'pending_questions']);
    assert.match(direct[0], /seller_notifications\?seller_id=eq\.web_s1/);
    await page.evaluate(() => { W1_IR.pausedUntil = Date.now() - 1; return agentLoadGroups(); });
    assert.equal(door.length, 2, 'asked again after the pause');
    await page.close();
  }
});

test('a refused login is not read the older way (the screen shows its own "could not load"); no login on this device runs the older read', { skip }, async () => {
  const r = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  const err = await r.page.evaluate(async () => { try { await w1IrRead('inboxList', {}, () => 'D'); return 'no error'; } catch (e) { return e.message; } });
  assert.equal(err, 'Please sign out and sign in again, then try once more.'); assert.deepEqual(r.direct, []);
  await r.page.close();
  const n = await open();
  const out = await n.page.evaluate(async () => { window.getValidAuthToken = async () => null; return w1IrRead('inboxList', {}, () => 'D'); });
  assert.equal(out, 'D'); assert.equal(n.door.length, 0);
  await n.page.close();
});
