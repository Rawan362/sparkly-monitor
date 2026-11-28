// Run with:  node --test tests/*.test.mjs
// The Notifications panel writes (read or unread, mark all read, delete one, delete selected, and the buttons that mark a notice read before they
// navigate) go through the Seller Notifications door with the person's own login, with Undo after a delete and after "mark all read". Door first.
// The older direct write runs when the door is down or not available (503, 404, 502, "not available", the connection fails; then 30 seconds off) or
// when this device has no login; a 429 shows "try again in a moment"; a door refusal never falls back. The door and Supabase are faked by the test:
// nothing leaves the test; the token is a made-up word; no real notification text.
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
  const a = html.indexOf('w1-notifications-door:js:start'); const b = html.indexOf('w1-notifications-door:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1NfTry'), block.indexOf('// A quiet mark-read'));
  assert.ok(!/seller/i.test(call.replace(/Seller Notifications|SELLER_NOTIFICATIONS_URL|seller-notifications/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
  assert.equal((html.match(/w1NfQuietRead\(/g) || []).length, 5, 'the three navigation buttons, discuss, and the helper');
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
    if (/\/webhook\/seller-notifications$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); const a = ctl.door(b); return a === 'abort' ? route.abort() : json(a.status, a.json); }
    if (/\/rest\/v1\/seller_notifications/.test(u) && m !== 'GET') { direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' }); return route.fulfill({ status: 204, headers: h, body: '' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__ln = 0; window.loadNotifications = async () => { window.__ln++; }; window.checkNotificationsDot = async () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, door, direct, alerts, ctl };
}
const T = 'made-up-token';
const note = (page) => page.evaluate(() => { const b = document.getElementById('w1-nf-note'); return b && b.style.display !== 'none' ? { text: document.getElementById('w1-nf-note-msg').textContent, undo: document.getElementById('w1-nf-undo-btn').style.display !== 'none' } : null; });

test('read and unread: setRead with the id and the value; the list reloads; no direct write', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { await toggleNotificationRead('12', true); await toggleNotificationRead(13, false); });
  assert.deepEqual(door, [{ token: T, action: 'setRead', id: 12, read: true }, { token: T, action: 'setRead', id: 13, read: false }]);
  assert.deepEqual(direct, []); assert.equal(await page.evaluate(() => window.__ln), 2);
  await page.close();
});

test('mark all read: markAllRead until the door says no more; one Undo button undoes every batch, newest first', { skip }, async () => {
  let n = 0;
  const { page, door, direct } = await open({ door: (b) => b.action === 'markAllRead' ? { status: 200, json: { ok: true, count: 1000, more: ++n === 1, undoId: 'u' + n } } : { status: 200, json: { ok: true } } });
  await page.evaluate(() => markAllNotificationsRead());
  assert.deepEqual(door.map((b) => b.action), ['markAllRead', 'markAllRead']); assert.deepEqual(direct, []);
  assert.deepEqual(await note(page), { text: 'All notifications marked as read.', undo: true });
  await page.click('#w1-nf-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-nf-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(door.slice(2).map((b) => [b.action, b.undoId]), [['undo', 'u2'], ['undo', 'u1']]);
  await page.close();
});

test('delete one and delete selected: the ids go to the door, with an Undo button; select mode closes as before', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    await deleteOneNotification('7');
    document.body.insertAdjacentHTML('beforeend', '<input type="checkbox" class="notification-item-checkbox" data-id="21" checked><input type="checkbox" class="notification-item-checkbox" data-id="22" checked>');
    await deleteSelectedNotifications();
  });
  assert.deepEqual(door.map((b) => [b.action, b.id, b.ids]), [['deleteOne', 7, undefined], ['deleteSelected', undefined, [21, 22]]]);
  assert.deepEqual(direct, []); assert.deepEqual(await note(page), { text: 'Notifications deleted.', undo: true });
  await page.click('#w1-nf-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-nf-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(door[2], { token: T, action: 'undo', undoId: 'u1' });
  await page.close();
});

test('the buttons that open a question, a chat or a discussion mark the notice read through the door first; a problem never stops the navigation', { skip }, async () => {
  const ok = await open();
  await ok.page.evaluate(async () => { window.closeNotificationsPanel = () => {}; window.goToChats = () => {}; window.openSellerInboxFromChats = async () => {}; window.selectConvo = () => {}; window.conversations = [{ phone_number: '1' }]; await openEscalationChat('5', '1'); await w1OpenChatsFromNotice(6); });
  assert.deepEqual(ok.door.map((b) => [b.action, b.id, b.read]), [['setRead', 5, true], ['setRead', 6, true]]);
  assert.deepEqual(ok.direct, []);
  await ok.page.close();
  const bad = await open({ door: () => ({ status: 200, json: { ok: false, error: 'no_notification', message: 'x' } }) });
  const out = await bad.page.evaluate(async () => { window.closeNotificationsPanel = () => { window.__closed = true; }; window.goToChats = () => {}; window.selectConvo = () => {}; window.conversations = [{ phone_number: '1' }]; await openEscalationChat('5', '1'); return window.__closed === true; });
  assert.equal(out, true, 'the panel still closes and the chat still opens'); assert.deepEqual(bad.direct, []);
  await bad.page.close();
});

test('the door is down or not available (503, 404, 502, not_available, or the connection fails): every write runs the older way, and the door is left alone for 30 seconds', { skip }, async () => {
  for (const down of [{ status: 503, json: {} }, { status: 404, json: {} }, { status: 502, json: {} }, { status: 200, json: { ok: false, error: 'not_available', message: 'x' } }, 'abort']) {
    const { page, door, direct } = await open({ door: () => down });
    await page.evaluate(async () => { await toggleNotificationRead('12', true); await markAllNotificationsRead(); await deleteOneNotification('7'); });
    assert.equal(door.length, 1, 'asked once, then left alone');
    assert.deepEqual(direct.map((d) => d.method + ' ' + d.url), ['PATCH seller_notifications?id=eq.12', 'PATCH seller_notifications?seller_id=eq.web_s1&is_read=eq.false', 'DELETE seller_notifications?id=eq.7']);
    assert.match(direct[0].body, /"is_read":true/);
    await page.evaluate(() => { W1_NF.pausedUntil = Date.now() - 1; return toggleNotificationRead('13', false); });
    assert.equal(door.length, 2, 'asked again after the pause');
    await page.close();
  }
});

test('a 429 shows "try again in a moment" and nothing runs the older way; a door refusal never falls back; no login on this device runs the older write', { skip }, async () => {
  const t = await open({ door: () => ({ status: 429, json: {} }) });
  await t.page.evaluate(() => toggleNotificationRead('12', true));
  assert.deepEqual(await note(t.page), { text: 'Too many tries. Please try again in a moment.', undo: false }); assert.deepEqual(t.direct, []);
  await t.page.close();
  const r = await open({ door: () => ({ status: 200, json: { ok: false, error: 'no_notification', message: 'That notification was not found.' } }) });
  await r.page.evaluate(() => deleteOneNotification('7'));
  assert.deepEqual(await note(r.page), { text: 'That notification was not found.', undo: false }); assert.deepEqual(r.direct, []);
  await r.page.close();
  const l = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  await l.page.evaluate(() => deleteOneNotification('7'));
  assert.equal((await note(l.page)).text, 'Please sign out and sign in again, then try once more.'); assert.deepEqual(l.direct, []);
  await l.page.close();
  const n = await open();
  await n.page.evaluate(async () => { window.getValidAuthToken = async () => null; await deleteOneNotification('7'); });
  assert.equal(n.door.length, 0); assert.equal(n.direct.length, 1);
  await n.page.close();
});
