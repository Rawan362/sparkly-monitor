// Run with:  node --test tests/*.test.mjs
// Real-browser tests of the HOLD DESIGN: while a voice note, video, photo or file is still being stored (the server keeps a pending row for
// it), no later message may show; when it is ready it appears in its place, followed by everything after it, in order, without a refresh.
// If Playwright is not installed (it is installed in CI), these tests are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

let chromium = null;
try {
  const require = createRequire(import.meta.url);
  chromium = require('playwright').chromium;
} catch (e) {
  try {
    const require = createRequire('/opt/node-tools/node_modules/');
    chromium = require('playwright').chromium;
  } catch (e2) { chromium = null; }
}
const skip = chromium ? false : 'Playwright is not installed';

const HOLD = '\u23F3 pending:';
const PHONE = '96470000001';
const OTHER = '96470000002';
const T0 = Date.parse('2026-11-02T08:00:00Z');

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

class Backend {
  constructor() { this.rows = []; this.ahmad = []; this.nextId = 1000; this.typingUntil = null; this.aiActive = true; this.requests = 0; }
  row(phone, role, message, ms, extra = {}) {
    const r = { id: this.nextId++, phone_number: phone, role, message, timestamp: new Date(ms).toISOString(), starred: false, pinned: false, channel: 'whatsapp', wa_message_id: 'wamid.' + this.nextId, reply_to_wa_id: null, reply_to_text: null, is_forwarded: false, transcript: null, ...extra };
    this.rows.push(r);
    return r;
  }
  ahmadRow(role, message, ms) {
    const r = { id: this.nextId++, role, message, created_at: new Date(ms).toISOString(), starred: false, pinned: false };
    this.ahmad.push(r);
    return r;
  }
  answer(url) {
    const desc = (a) => a.slice().sort((x, y) => String(y.timestamp || y.created_at).localeCompare(String(x.timestamp || x.created_at)));
    if (url.includes('/rest/v1/conversations?') && url.includes('phone_number=eq.' + PHONE)) {
      const mine = this.rows.filter((r) => r.phone_number === PHONE);
      this.requests++;
      if (url.includes('message=like.')) return desc(mine.filter((r) => String(r.message).startsWith(HOLD))).slice(0, 3).map((r) => ({ id: r.id }));
      if (url.includes('select=id,timestamp')) { const l = desc(mine)[0]; return l ? [{ id: l.id, timestamp: l.timestamp }] : []; }
      return desc(mine).slice(0, 200);
    }
    if (url.includes('/rest/v1/conversations?')) return desc(this.rows).slice(0, 500);
    if (url.includes('/rest/v1/seller_web_chat_log?')) return desc(this.ahmad).slice(0, 300);
    if (url.includes('/rest/v1/client_status')) return [{ phone_number: PHONE, ai_active: this.aiActive, ai_typing_until: null }, { phone_number: OTHER, ai_active: true }];
    return [];
  }
}

async function boot(browser, backend, base, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 }, reducedMotion: opts.reducedMotion || 'no-preference' });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(backend.answer(u)) });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
  for (let attempt = 0; attempt < 6; attempt++) {   // on a slow machine the page may still be starting: retry if it reloads itself
    try {
    await page.evaluate(() => { SELLER_CHAT_ID = 'seller-test'; try { document.getElementById('app').style.display = 'flex'; document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; }); } catch (e) { /* show the app as it looks after a login */ } });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
async function openChat(page) {
  await page.evaluate((phone) => { selectConvo(phone); }, PHONE);
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg-row').length > 0);
  await page.waitForTimeout(2300);   // the app holds the bottom position for the first 2 s after a chat opens (existing behaviour)
}
/** Marks everything that is on screen now, runs `action`, and reports what stayed the very same node. */
async function measure(page, action) {
  await page.evaluate(() => {
    const box = document.getElementById('messages');
    window.__before = { box, header: document.getElementById('chat-header'), textarea: document.getElementById('reply-text'), rows: Array.from(box.querySelectorAll('.msg-row')) };
    window.__added = 0; window.__removed = 0;
    if (window.__mo) window.__mo.disconnect();
    window.__mo = new MutationObserver((l) => { for (const m of l) { m.addedNodes.forEach((n) => { if (n.nodeType === 1) window.__added++; }); m.removedNodes.forEach((n) => { if (n.nodeType === 1) window.__removed++; }); } });
    window.__mo.observe(document.getElementById('main'), { childList: true, subtree: true });
  });
  await action();
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const box = document.getElementById('messages');
    const old = window.__before;
    return {
      sameBox: box === old.box,
      sameHeader: document.getElementById('chat-header') === old.header,
      sameInput: document.getElementById('reply-text') === old.textarea,
      oldRows: old.rows.length,
      oldRowsStillTheSameNodes: old.rows.filter((r) => r.isConnected && r.parentNode === box).length,
      rowsNow: box.querySelectorAll('.msg-row').length,
      added: window.__added,
      removed: window.__removed
    };
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

function seed(b, n, phone = PHONE) { for (let i = 0; i < n; i++) b.row(phone, i % 2 ? 'assistant' : 'user', 'message number ' + i, T0 + i * 60000); }
const later = (b) => T0 + (b.rows.length + 10) * 60000;

// Times: old rows are hours old; new rows are seconds old (the 4-minute safety release is measured against the real clock).
const BASE = Date.now() - 60000;
let tick = 0;
const nowish = () => BASE + (tick++) * 1000;
function seedOld(b, n) { for (let i = 0; i < n; i++) b.row(PHONE, i % 2 ? 'assistant' : 'user', 'message number ' + i, BASE - 3 * 3600000 + i * 60000); }
const pending = (b, kind, wa) => b.row(PHONE, 'user', HOLD + kind, nowish(), { wa_message_id: wa });
const complete = (r, message) => { r.message = message; };
const poll = (page) => page.evaluate(() => fastPollOpenChat());
const texts = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#messages .msg-row')).map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
const kinds = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#messages .msg-row')).map((r) => r.querySelector('video') ? 'video' : r.querySelector('audio') ? 'audio' : r.querySelector('img:not(.emoji)') && !r.textContent.trim().length ? 'img' : r.querySelector('img') ? 'img' : 'text'));
const ids = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#messages .msg-row[data-id], #messages [data-msg-id]')).map((r) => r.getAttribute('data-id') || r.getAttribute('data-msg-id')));
const VOICE = '🎤 Voice: https://storage.example.test/a.ogg';
const PHOTO = '🖼️ Photo: https://storage.example.test/a.jpg | pic';
const VIDEO = '🎥 Video: https://storage.example.test/a.mp4';

async function nothingReplaced(page, b, action, expectRows) {
  const r = await measure(page, action);
  assert.equal(r.sameBox, true); assert.equal(r.sameHeader, true); assert.equal(r.sameInput, true);
  assert.equal(r.oldRowsStillTheSameNodes, r.oldRows, 'every bubble that was on screen is still the same node (no flash)');
  assert.equal(r.removed, 0);
  assert.equal(r.rowsNow, r.oldRows + expectRows, 'rows added: ' + expectRows);
  return r;
}

for (const [name, kind, done, tag] of [['voice', 'audio', VOICE, 'Voice'], ['video', 'video', VIDEO, 'Video']]) {
  test(name + ' then text: the text stays hidden until the ' + name + ' is ready; then the ' + name + ' appears first, then the text; nothing already on screen is replaced', { skip }, async () => {
    const b = new Backend(); seedOld(b, 12);
    const { page, errors } = await boot(browser, b, base);
    await openChat(page);
    const a = pending(b, kind, 'wamid.A'); b.row(PHONE, 'user', 'text sent right after', nowish(), { wa_message_id: 'wamid.B' });
    const r1 = await nothingReplaced(page, b, async () => { await poll(page); }, 0);
    assert.equal((await texts(page)).some((t) => t.includes('text sent right after')), false, 'the later text is NOT shown while the ' + name + ' is pending');
    assert.equal((await texts(page)).some((t) => t.includes('pending')), false, 'the pending row itself is never shown');
    assert.ok(r1);
    complete(a, done);       // the ready ' + name + ' keeps its row, id and time; only its text changes. The NEWEST row (the text) did not change at all.
    await nothingReplaced(page, b, async () => { await poll(page); }, 2);
    const t = await texts(page); const k = await kinds(page);
    const iA = k.indexOf(kind === 'audio' ? 'audio' : 'video'); const iB = t.findIndex((x) => x.includes('text sent right after'));
    assert.ok(iA === 12 && iB === 13, 'the ' + name + ' is shown (' + k.slice(10).join(',') + '), and the text comes right after it');
    assert.equal(t.length, 14);
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('photo, voice note, text: nothing shows until the photo is ready; then the photo; the voice note and text wait for the voice note; then both, in order', { skip }, async () => {
  const b = new Backend(); seedOld(b, 12);
  const { page, errors } = await boot(browser, b, base);
  await openChat(page);
  const a = pending(b, 'image', 'wamid.A'); const v = pending(b, 'audio', 'wamid.B'); b.row(PHONE, 'user', 'third message', nowish(), { wa_message_id: 'wamid.C' });
  await nothingReplaced(page, b, async () => { await poll(page); }, 0);
  complete(a, PHOTO);
  await nothingReplaced(page, b, async () => { await poll(page); }, 1);
  let t = await texts(page);
  assert.equal(t.some((x) => x.includes('third message')), false, 'the text still waits for the voice note');
  assert.equal(t.length, 13);
  complete(v, VOICE);
  await nothingReplaced(page, b, async () => { await poll(page); }, 2);
  t = await texts(page); const k = await kinds(page);
  assert.equal(t.length, 15);
  assert.deepEqual(k.slice(12), ['img', 'audio', 'text'], 'photo, voice note, text - in that order');
  assert.ok(t[t.length - 1].includes('third message'), 'the text is last');
  assert.deepEqual(errors, []);
  await page.close();
});

for (const aiOn of [true, false]) {
  test('AI ' + (aiOn ? 'on' : 'off') + ': ' + (aiOn ? 'the AI reply and a manual message wait behind a pending voice note' : 'a customer text and a manual message wait behind a pending voice note') + ', then appear in order', { skip }, async () => {
    const b = new Backend(); seedOld(b, 12); b.aiActive = aiOn;
    const { page, errors } = await boot(browser, b, base);
    await openChat(page);
    const a = pending(b, 'audio', 'wamid.A');
    b.row(PHONE, 'user', 'customer text', nowish(), { wa_message_id: 'wamid.B' });
    if (aiOn) b.row(PHONE, 'assistant', 'AI reply', nowish(), { wa_message_id: 'wamid.R' });
    b.row(PHONE, 'assistant', 'manual message', nowish(), { wa_message_id: 'wamid.M' });
    await nothingReplaced(page, b, async () => { await poll(page); }, 0);
    complete(a, VOICE);
    await nothingReplaced(page, b, async () => { await poll(page); }, aiOn ? 4 : 3);
    const t = await texts(page); const k = await kinds(page);
    const names = ['customer text'].concat(aiOn ? ['AI reply'] : [], ['manual message']);
    assert.equal(k[12], 'audio', 'the voice note comes first');
    assert.deepEqual(names.map((n) => t.findIndex((x) => x.includes(n))), names.map((_, i) => 13 + i), 'then the rest in order');
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('a pending row that becomes ready is NOT missed even though the newest row did not change (the check must watch the pending rows)', { skip }, async () => {
  const b = new Backend(); seedOld(b, 12);
  const { page } = await boot(browser, b, base);
  await openChat(page);
  const a = pending(b, 'audio', 'wamid.A'); b.row(PHONE, 'user', 'newest text', nowish());
  await poll(page);
  const cursorBefore = await page.evaluate((p) => window._fastNewest[p], PHONE);
  complete(a, VOICE);
  await poll(page);
  const cursorAfter = await page.evaluate((p) => window._fastNewest[p], PHONE);
  assert.notEqual(cursorBefore, cursorAfter);
  assert.equal((await texts(page)).length, 14);
  await page.close();
});

test('a late row is never skipped: a row older than the newest one that appears afterwards is shown, in its place', { skip }, async () => {
  const b = new Backend(); seedOld(b, 12);
  const { page } = await boot(browser, b, base);
  await openChat(page);
  const t1 = nowish(); const t2 = nowish(); const t3 = nowish();
  b.row(PHONE, 'user', 'second (arrived first)', t3);
  await page.evaluate((p) => loadThread(p, true), PHONE);
  b.row(PHONE, 'user', 'first (saved late, older time)', t1);
  await page.evaluate((p) => loadThread(p, true), PHONE);   // the 8-second refresh path
  const t = await texts(page);
  const i1 = t.findIndex((x) => x.includes('first (saved late')); const i2 = t.findIndex((x) => x.includes('second (arrived first)'));
  assert.ok(i1 >= 0, 'the late row is shown');
  assert.ok(i1 < i2, 'and in its place, before the newer one');
  assert.ok(t2 > 0);
  await page.close();
});

test('no duplicates: a message that goes from pending to ready is exactly one bubble; the same text twice in a row stays two messages', { skip }, async () => {
  const b = new Backend(); seedOld(b, 12);
  const { page } = await boot(browser, b, base);
  await openChat(page);
  const a = pending(b, 'image', 'wamid.A'); b.row(PHONE, 'user', 'same words', nowish(), { wa_message_id: 'wamid.B' });
  await poll(page); complete(a, PHOTO); await poll(page); await poll(page);
  await page.evaluate((p) => loadThread(p, true), PHONE);
  const t = await texts(page);
  assert.equal(t.filter((x) => x.includes('pic')).length, 1, 'the photo is one bubble');
  assert.equal(t.filter((x) => x.includes('same words')).length, 1);
  assert.equal(t.length, 14);
  const dom = await page.evaluate(() => Array.from(document.querySelectorAll('#messages .msg-row')).length);
  assert.equal(dom, 14);
  await page.close();
});

test('the chat list shows the last message that may be shown (never the one waiting behind a pending row); it is updated when the pending row is ready', { skip }, async () => {
  const b = new Backend(); seedOld(b, 12);
  const { page } = await boot(browser, b, base);
  await page.evaluate(() => loadConversations());
  const a = pending(b, 'audio', 'wamid.A'); b.row(PHONE, 'user', 'hidden newest text', nowish());
  await page.evaluate(() => loadConversations());
  let list = await page.evaluate(() => conversations.find((c) => c.phone_number === '96470000001') && conversations.find((c) => c.phone_number === '96470000001').message);
  assert.ok(!String(list).includes('hidden newest text') && !String(list).includes('pending'), 'preview: ' + list);
  complete(a, VOICE);
  await page.evaluate(() => loadConversations());
  list = await page.evaluate(() => conversations.find((c) => c.phone_number === '96470000001').message);
  assert.ok(String(list).includes('hidden newest text'));
  await page.close();
});

test('a pending row that never finishes stops holding after 4 minutes and is shown as a plain note', { skip }, async () => {
  const b = new Backend(); seedOld(b, 12);
  b.row(PHONE, 'user', HOLD + 'image', Date.now() - 5 * 60000);
  b.row(PHONE, 'user', 'message behind it', Date.now() - 4 * 60000 + 30000);
  const { page } = await boot(browser, b, base);
  await openChat(page);
  const t = await texts(page);
  assert.ok(t.some((x) => x.includes('message behind it')));
  assert.ok(t.some((x) => x.includes('could not be loaded')));
  assert.equal(t.some((x) => x.includes('pending')), false);
  await page.close();
});

test('the AI assistant screen uses the same rule (a pending row and everything after it stay hidden)', { skip }, async () => {
  const b = new Backend();
  const t0 = BASE - 600000;
  b.ahmadRow('user', 'first', t0); b.ahmadRow('assistant', 'second', t0 + 1000);
  const a = b.ahmadRow('user', HOLD + 'audio', Date.now() - 20000); b.ahmadRow('assistant', 'answer waiting', Date.now() - 10000);
  const { page } = await boot(browser, b, base);
  await page.evaluate(() => renderAhmadChatPanel(false));
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg-row').length > 0);
  let tx = await texts(page);
  assert.equal(tx.some((x) => x.includes('answer waiting') || x.includes('pending')), false);
  a.message = VOICE;
  await page.evaluate(() => renderAhmadChatPanel(true));
  await page.waitForTimeout(300);
  tx = await texts(page);
  assert.ok(tx.some((x) => x.includes('answer waiting')));
  await page.close();
});

test('manual sends: a voice note and then a text sent quickly go out strictly in that order, even when the voice note is slow', { skip }, async () => {
  const b = new Backend();
  const { page } = await boot(browser, b, base);
  const order = await page.evaluate(async () => {
    const log = [];
    const p1 = enqueueSend('96470000001', () => new Promise((r) => setTimeout(() => { log.push('voice'); r(); }, 300)));
    const p2 = enqueueSend('96470000001', async () => { log.push('text'); });
    await Promise.all([p1, p2]);
    return log;
  });
  assert.deepEqual(order, ['voice', 'text']);
  await page.close();
});

test('service worker cache version is v61 so every device fetches the new app', { skip: false }, () => {
  assert.match(sw, /sparkly-shell-v[0-9]{2,}/);
  assert.ok(html.includes('HOLD_MARK') && html.includes('function applyHold'));
});
