// Run with:  node --test tests/*.test.mjs
// The Business chat writes (rename, pin, a new chat, delete a chat, and the messages that Retry and Edit cut away) go through the Seller Business
// Chats and Seller Business Messages doors with the person's own login; a delete is checked first and applied with its digest, and an Undo button
// follows. Door first; the older direct writes run when a door is down or not available (503, 404, 502, not_available, the connection fails; then 30
// seconds off) or when this device has no login; a 429 shows "try again in a moment"; a door refusal never falls back. The doors and Supabase are
// faked by the test: nothing leaves the test; the token is a made-up word; no real chat text.
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
  const a = html.indexOf('w1-business-chat-door:js:start'); const b = html.indexOf('w1-business-chat-door:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1BcTry'), block.indexOf('// One chat-list write'));
  assert.ok(!/seller/i.test(call.replace(/Seller Business (Chats|Messages)|SELLER_BUSINESS_(CHATS|MESSAGES)_URL|seller-business-(chats|messages)/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
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

// ctl.chats(body) and ctl.messages(body) answer the two doors; `calls` records { door, body }; `direct` the direct writes.
async function open(ctl) {
  ctl = Object.assign({
    chats: (b) => b.action === 'deleteCheck' ? { status: 200, json: { ok: true, count: 4, digest: 'd'.repeat(32) } } : b.action === 'create' ? { status: 200, json: { ok: true, conversation: { id: 'new-c', title: 'New Chat', pinned: false }, undoId: 'u0' } } : { status: 200, json: { ok: true, count: 1, undoId: 'u1' } },
    messages: (b) => b.action === 'deleteFromCheck' ? { status: 200, json: { ok: true, count: 2, digest: 'e'.repeat(32) } } : { status: 200, json: { ok: true, count: 2, deleted: 2, undoId: 'u2' } }
  }, ctl || {});
  const calls = []; const direct = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.type() === 'prompt' ? d.accept('Renamed chat') : d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    const door = /\/webhook\/seller-business-chats$/.test(u) ? 'chats' : (/\/webhook\/seller-business-messages$/.test(u) ? 'messages' : '');
    if (door) { const b = JSON.parse(route.request().postData() || '{}'); calls.push({ door, body: b }); const a = ctl[door](b); return a === 'abort' ? route.abort() : json(a.status, a.json); }
    if (/\/rest\/v1\/(business_chat_conversations|business_chat_messages)/.test(u) && m !== 'GET') { direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' }); return /conversations/.test(u) && m === 'POST' ? json(201, [{ id: 'old-c' }]) : route.fulfill({ status: 204, headers: h, body: '' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__ll = 0; window.loadBusinessChatConversationList = async () => { window.__ll++; }; window.openExistingBusinessConversation = async () => {};
    window.showBcEmptyState = () => {}; window.closeBcSidebarOnMobile = () => {}; window.closeBcConvMenu = () => {};
    window.sendBusinessChatTurn = async () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, calls, direct, alerts, ctl };
}
const T = 'made-up-token';
const note = (page) => page.evaluate(() => { const b = document.getElementById('w1-bc-note'); return b && b.style.display !== 'none' ? { text: document.getElementById('w1-bc-note-msg').textContent, undo: document.getElementById('w1-bc-undo-btn').style.display !== 'none' } : null; });
const bodies = (calls) => calls.map((c) => [c.door, c.body]);

test('rename and pin: rename with the id and the title, setPinned with the new value, each with an Undo button; no direct write', { skip }, async () => {
  const { page, calls, direct } = await open();
  await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="bc-conv-item" data-id="c1" data-pinned="false"><div class="bc-conv-item-title"><span>Old</span></div></div>');
    bcMenuTargetConvId = 'c1'; await renameBcConversationPrompt();
    bcMenuTargetConvId = 'c1'; await toggleBcConversationPin();
  });
  assert.deepEqual(bodies(calls), [['chats', { token: T, action: 'rename', conversationId: 'c1', title: 'Renamed chat' }], ['chats', { token: T, action: 'setPinned', conversationId: 'c1', pinned: true }]]);
  assert.deepEqual(direct, []); assert.deepEqual(await note(page), { text: 'Chat pinned.', undo: true });
  await page.click('#w1-bc-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-bc-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(calls[2], { door: 'chats', body: { token: T, action: 'undo', undoId: 'u1' } });
  await page.close();
});

test('a new chat: create, and the screen opens the chat the door answers', { skip }, async () => {
  const { page, calls, direct } = await open();
  const id = await page.evaluate(async () => { await startNewBusinessChat(); return activeConversationId; });
  assert.deepEqual(bodies(calls), [['chats', { token: T, action: 'create' }]]); assert.deepEqual(direct, []); assert.equal(id, 'new-c');
  await page.close();
});

test('delete a chat: deleteCheck, then deleteApply with the digest, with an Undo button; the list reloads', { skip }, async () => {
  const { page, calls, direct } = await open();
  await page.evaluate(async () => { activeConversationId = 'other'; await deleteBusinessConversation('c1'); });
  assert.deepEqual(bodies(calls), [['chats', { token: T, action: 'deleteCheck', conversationId: 'c1' }], ['chats', { token: T, action: 'deleteApply', conversationId: 'c1', digest: 'd'.repeat(32) }]]);
  assert.deepEqual(direct, []); assert.deepEqual(await note(page), { text: 'Chat deleted.', undo: true });
  assert.ok(await page.evaluate(() => window.__ll) >= 1);
  await page.close();
});

test('Retry and Edit: the messages from the point in time on go through deleteFromCheck and deleteFromApply; the retry and the edit still happen', { skip }, async () => {
  const { page, calls, direct } = await open();
  const out = await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="bcm"><div class="user" data-raw-text="Question"></div><div id="ans" data-chat-type="business" data-timestamp="2026-11-20T10:00:03.123+00:00"></div></div><textarea id="bc-input"></textarea>');
    activeConversationId = 'c1'; bcHistory = [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'A' }];
    window.__turn = 0; window.sendBusinessChatTurn = async () => { window.__turn++; };
    await retryAiMessage(document.getElementById('ans'));
    document.body.insertAdjacentHTML('beforeend', '<div id="um" data-chat-type="business" data-raw-text="Question" data-timestamp="2026-11-20T10:00:01.000+00:00"></div>');
    await editUserMessage(document.getElementById('um'));
    return { turn: window.__turn, input: document.getElementById('bc-input').value };
  });
  assert.deepEqual(bodies(calls), [
    ['messages', { token: T, action: 'deleteFromCheck', conversationId: 'c1', from: '2026-11-20T10:00:03.123+00:00' }],
    ['messages', { token: T, action: 'deleteFromApply', conversationId: 'c1', from: '2026-11-20T10:00:03.123+00:00', digest: 'e'.repeat(32) }],
    ['messages', { token: T, action: 'deleteFromCheck', conversationId: 'c1', from: '2026-11-20T10:00:01.000+00:00' }],
    ['messages', { token: T, action: 'deleteFromApply', conversationId: 'c1', from: '2026-11-20T10:00:01.000+00:00', digest: 'e'.repeat(32) }]]);
  assert.deepEqual(direct, []); assert.deepEqual(out, { turn: 1, input: 'Question' });
  await page.close();
});

test('a door that is down or not available (503, 404, 502, not_available, or the connection fails): every write runs the older way, and that door is left alone for 30 seconds', { skip }, async () => {
  for (const down of [{ status: 503, json: {} }, { status: 404, json: {} }, { status: 502, json: {} }, { status: 200, json: { ok: false, error: 'not_available', message: 'x' } }, 'abort']) {
    const { page, calls, direct } = await open({ chats: () => down, messages: () => down });
    await page.evaluate(async () => {
      document.body.insertAdjacentHTML('beforeend', '<div class="bc-conv-item" data-id="c1" data-pinned="true"><div class="bc-conv-item-title"><span>Old</span></div></div><div id="ans" data-chat-type="business" data-timestamp="2026-11-20T10:00:03.123+00:00"></div>');
      bcMenuTargetConvId = 'c1'; await renameBcConversationPrompt(); bcMenuTargetConvId = 'c1'; await toggleBcConversationPin();
      await startNewBusinessChat(); activeConversationId = 'other'; await deleteBusinessConversation('c1');
      document.body.insertAdjacentHTML('beforeend', '<div class="user" data-raw-text="Q"></div>');
      const a = document.getElementById('ans'); a.parentNode.insertBefore(document.querySelector('.user[data-raw-text="Q"]'), a); activeConversationId = 'c1'; bcHistory = [{ role: 'assistant', content: 'A' }]; await retryAiMessage(a);
    });
    assert.equal(calls.filter((c) => c.door === 'chats').length, 1, 'the chats door is asked once');
    assert.equal(calls.filter((c) => c.door === 'messages').length, 1, 'the messages door is asked once');
    assert.deepEqual(direct.map((d) => d.method + ' ' + d.url.split('?')[0]), ['PATCH business_chat_conversations', 'PATCH business_chat_conversations', 'POST business_chat_conversations', 'DELETE business_chat_conversations', 'DELETE business_chat_messages']);
    assert.match(direct[0].body, /"title":"Renamed chat"/); assert.match(direct[1].body, /"pinned":false/); assert.match(direct[2].body, /"chat_id":"web_s1"/);
    assert.match(direct[4].url, /created_at=gte\./);
    await page.close();
  }
});

test('a 429 shows "try again in a moment" and nothing runs the older way; a refusal and a refused login never fall back; no login on this device runs the older write', { skip }, async () => {
  const t = await open({ chats: () => ({ status: 429, json: {} }) });
  await t.page.evaluate(async () => { document.body.insertAdjacentHTML('beforeend', '<div class="bc-conv-item" data-id="c1" data-pinned="false"><div class="bc-conv-item-title"><span>Old</span></div></div>'); bcMenuTargetConvId = 'c1'; await toggleBcConversationPin(); });
  assert.deepEqual(await note(t.page), { text: 'Too many tries. Please try again in a moment.', undo: false }); assert.deepEqual(t.direct, []);
  await t.page.close();
  const r = await open({ chats: () => ({ status: 200, json: { ok: false, error: 'bad_title', message: 'That title is not allowed.' } }) });
  await r.page.evaluate(async () => { document.body.insertAdjacentHTML('beforeend', '<div class="bc-conv-item" data-id="c1"><div class="bc-conv-item-title"><span>Old</span></div></div>'); bcMenuTargetConvId = 'c1'; await renameBcConversationPrompt(); });
  assert.deepEqual(await note(r.page), { text: 'That title is not allowed.', undo: false }); assert.deepEqual(r.direct, []);
  await r.page.close();
  const c = await open({ chats: (b) => b.action === 'deleteCheck' ? { status: 200, json: { ok: true, count: 1, digest: 'd'.repeat(32) } } : { status: 200, json: { ok: false, error: 'changed', message: 'This chat changed. Look at it again.' } } });
  await c.page.evaluate(async () => { activeConversationId = 'x'; await deleteBusinessConversation('c1'); });
  assert.equal((await note(c.page)).text, 'This chat changed. Look at it again.'); assert.deepEqual(c.direct, []);
  await c.page.close();
  const l = await open({ chats: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  await l.page.evaluate(async () => { await startNewBusinessChat(); });
  assert.equal((await note(l.page)).text, 'Please sign out and sign in again, then try once more.'); assert.deepEqual(l.direct, []);
  await l.page.close();
  const n = await open();
  await n.page.evaluate(async () => { window.getValidAuthToken = async () => null; activeConversationId = 'x'; await deleteBusinessConversation('c1'); });
  assert.equal(n.calls.length, 0); assert.equal(n.direct.length, 1);
  await n.page.close();
});
