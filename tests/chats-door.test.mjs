// Run with:  node --test tests/*.test.mjs
// Customer chat writes (clear chat, archive, block, the AI toggle, the forward mark) go through the Seller Chats door with the person's own login,
// with Undo for clear / archive / block; when the door answers "not available" every screen keeps the older direct write exactly as before.
// The door, the Send Text door and Supabase are faked by the test: nothing leaves the test; the token is a made-up word; no message text is used.
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

test('this test file and the new block are ASCII; the block calls only the Seller Chats door and holds the old direct writes only as the fallback', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-chats-door:js:start'); const b = html.indexOf('w1-chats-door:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block));
  const call = block.slice(block.indexOf('async function w1ChCall'), block.indexOf('// Door first: the answer'));
  assert.ok(!/seller/i.test(call.replace(/Seller Chats|SELLER_CHATS_URL|seller-chats/g, '')), 'the door call sends no seller id: the door finds the seller from the login');
  assert.equal((block.match(/\/rest\/v1\//g) || []).length, 1, 'the only direct write left in the block is the old forward mark, kept as the fallback');
  assert.ok(!/SUPABASE_ANON_KEY/.test(call), 'the public key is not used for the door call');
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

// `ctl.door(body)` answers each door call: { status, json } ; `door` records the bodies, `direct` the direct writes to conversations / client_status.
async function open(ctl) {
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
    if (/\/webhook\/seller-chats$/.test(u)) {
      const b = JSON.parse(route.request().postData() || '{}'); door.push({ body: b, auth: route.request().headers()['authorization'] || null });
      const a = ctl.door(b); return json(a.status, a.json);
    }
    if (/\/webhook\/seller-send-text$/.test(u)) return json(200, { success: true, waMessageId: 'wamid-1' });
    if (/\/rest\/v1\/(conversations|client_status)/.test(u) && m !== 'GET') { direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' }); return route.fulfill({ status: 204, headers: h, body: '' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__lc = 0; window.__lt = 0; window.__home = 0;
    window.loadConversations = async () => { window.__lc++; }; window.loadThread = async () => { window.__lt++; }; window.goToChats = () => { window.__home++; };
    window.startLessonIfNeeded = () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, door, direct, alerts, ctl };
}
const note = (page) => page.evaluate(() => { const b = document.getElementById('w1-ch-note'); return b && b.style.display !== 'none' ? { text: document.getElementById('w1-ch-note-msg').textContent, undo: document.getElementById('w1-ch-undo-btn').style.display !== 'none' } : null; });

test('clear chat: check, then apply with the digest; no direct delete; an Undo button appears and undoes through the door', { skip }, async () => {
  const { page, door, direct } = await open({ door: (b) => b.action === 'clearCheck' ? { status: 200, json: { ok: true, count: 3, digest: 'd'.repeat(32), canUndo: true } } : b.action === 'clearApply' ? { status: 200, json: { ok: true, count: 3, deleted: 3, undoId: 'u1' } } : { status: 200, json: { ok: true, message: 'x' } } });
  await page.evaluate(() => { activePhone = '15550001'; return clearChatNow('15550001'); });
  assert.deepEqual(door.map((d) => d.body), [{ token: 'made-up-token', action: 'clearCheck', phone: '15550001' }, { token: 'made-up-token', action: 'clearApply', phone: '15550001', digest: 'd'.repeat(32) }]);
  assert.deepEqual(direct, [], 'no direct delete');
  assert.equal(await page.evaluate(() => window.__home), 1, 'the open chat closes as before');
  assert.deepEqual(await note(page), { text: 'Chat cleared.', undo: true });
  await page.click('#w1-ch-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-ch-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(door[2].body, { token: 'made-up-token', action: 'undo', undoId: 'u1' });
  await page.close();
});

test('clear chat: nothing to clear shows no Undo; a refusal (the chat changed) shows the door words and uses no direct path', { skip }, async () => {
  const none = await open({ door: (b) => b.action === 'clearCheck' ? { status: 200, json: { ok: true, count: 0, digest: 'e'.repeat(32) } } : { status: 200, json: { ok: true, count: 0, deleted: 0 } } });
  await none.page.evaluate(() => clearChatNow('1'));
  assert.equal(await note(none.page), null);
  await none.page.close();
  const ch = await open({ door: (b) => b.action === 'clearCheck' ? { status: 200, json: { ok: true, count: 2, digest: 'f'.repeat(32) } } : { status: 200, json: { ok: false, error: 'changed', message: 'The chat changed. Nothing was removed.' } } });
  await ch.page.evaluate(() => clearChatNow('1'));
  assert.deepEqual(await note(ch.page), { text: 'The chat changed. Nothing was removed.', undo: false });
  assert.deepEqual(ch.direct, []);
  await ch.page.close();
});

test('archive and block: setFlag with the field and value, an Undo button, and the list reloads', { skip }, async () => {
  const { page, door, direct } = await open({ door: () => ({ status: 200, json: { ok: true, count: 1, undoId: 'u2' } }) });
  await page.evaluate(async () => { await updateClientStatusField('15550001', 'archived', true); });
  assert.deepEqual(door[0].body, { token: 'made-up-token', action: 'setFlag', phone: '15550001', field: 'archived', value: true });
  assert.deepEqual(await note(page), { text: 'Chat archived.', undo: true });
  await page.evaluate(async () => { await updateClientStatusField('15550001', 'blocked', false); });
  assert.deepEqual(door[1].body, { token: 'made-up-token', action: 'setFlag', phone: '15550001', field: 'blocked', value: false });
  assert.equal((await note(page)).text, 'Customer unblocked.');
  assert.deepEqual(direct, []);
  assert.ok(await page.evaluate(() => window.__lc) >= 2);
  await page.close();
});

test('the AI toggle: setAi true and false; a customer with no status row still looks successful, as before', { skip }, async () => {
  const { page, door, direct, alerts } = await open({ door: (b) => b.active === true ? { status: 200, json: { ok: false, error: 'no_client', message: 'No status row.' } } : { status: 200, json: { ok: true, count: 1, undoId: 'u3' } } });
  await page.evaluate(async () => { await pauseAI('15550001'); await resumeAI('15550001'); });
  assert.deepEqual(door.map((d) => [d.body.action, d.body.phone, d.body.active]), [['setAi', '15550001', false], ['setAi', '15550001', true]]);
  assert.deepEqual(direct, []); assert.deepEqual(alerts, [], 'no error message for a customer with no row');
  assert.equal(await page.evaluate(() => window.__lt), 2, 'the chat is redrawn after each');
  await page.close();
});

test('forward: the mark is recorded through the door after the send, for the message the send answered', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { window._forwardText = 'x'; window._forwardAudio = null; await forwardMessageTo('15550002'); });
  assert.deepEqual(door.map((d) => d.body), [{ token: 'made-up-token', action: 'markForwarded', waMessageId: 'wamid-1' }]);
  assert.deepEqual(direct, []);
  await page.close();
});

test('the door is not available (503 or not_available): every action keeps the older direct write exactly as before, and the door is asked only once', { skip }, async () => {
  const { page, door, direct } = await open({ door: () => ({ status: 503, json: { ok: false, code: 'not_ready' } }) });
  await page.evaluate(async () => {
    window._forwardText = 'x'; window._forwardAudio = null;
    await clearChatNow('15550001'); await updateClientStatusField('15550001', 'blocked', true);
    await pauseAI('15550001'); await resumeAI('15550001'); await forwardMessageTo('15550002');
  });
  assert.equal(door.length, 1, 'asked once, then remembered');
  assert.deepEqual(direct.map((d) => d.method + ' ' + d.url.split('?')[0]), ['DELETE conversations', 'POST client_status', 'PATCH client_status', 'PATCH client_status', 'PATCH conversations']);
  assert.match(direct[0].url, /phone_number=eq\.15550001&seller_id=eq\.web_s1/);
  assert.match(direct[1].url, /on_conflict=phone_number,seller_id/); assert.match(direct[1].body, /"blocked":true/);
  assert.match(direct[2].body, /"ai_active":false/); assert.match(direct[3].body, /"ai_active":true/);
  assert.match(direct[4].url, /wa_message_id=eq\.wamid-1/); assert.match(direct[4].body, /"is_forwarded":true/);
  await page.close();
  const na = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_available', message: 'n' } }) });
  await na.page.evaluate(() => updateClientStatusField('1', 'archived', true));
  assert.equal(na.direct.length, 1);
  await na.page.close();
});

test('login problems: no token means no door call and no direct write (a sign-in message); a refusal never falls back to the direct path', { skip }, async () => {
  const a = await open();
  await a.page.evaluate(() => { window.getValidAuthToken = async () => null; return updateClientStatusField('1', 'blocked', true); });
  assert.equal(a.door.length, 0); assert.deepEqual(a.direct, []);
  assert.deepEqual(await note(a.page), { text: 'Please sign out and sign in again, then try once more.', undo: false });
  await a.page.close();
  const b = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  await b.page.evaluate(() => updateClientStatusField('1', 'blocked', true));
  assert.deepEqual(b.direct, []);
  assert.equal((await note(b.page)).text, 'Please sign out and sign in again, then try once more.');
  await b.page.close();
});

test('forward keeps the "Connect WhatsApp first" guard while WhatsApp is not connected: nothing is sent and the door is not asked', { skip }, async () => {
  const { page, door, direct } = await open();
  const r = await page.evaluate(async () => {
    window.__sent = 0; window._forwardText = 'x'; window._forwardAudio = null;
    W1_WA.state = 'not_connected';
    await forwardMessageTo('15550002');
    return { blocked: !!document.getElementById('w1-wa-first') };
  });
  assert.equal(r.blocked, true); assert.deepEqual(door, []); assert.deepEqual(direct, []);
  await page.close();
});
