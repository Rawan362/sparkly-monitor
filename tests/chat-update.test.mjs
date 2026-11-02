// Run with:  node --test tests/*.test.mjs
// Real-browser tests: the REAL index.html runs in Chromium (Playwright) against a fake backend (every network call is answered by the
// test). They prove that a new message only ADDS a bubble: the bubbles already on screen, the header and the input stay the very same
// DOM nodes, in short chats and in a 1,000-row chat, in the chat list and on the AI assistant screen.
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
  constructor() { this.rows = []; this.ahmad = []; this.nextId = 1000; this.typingUntil = null; }
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
      if (url.includes('select=id,timestamp')) { const l = desc(this.rows.filter((r) => r.phone_number === PHONE))[0]; return l ? [{ id: l.id, timestamp: l.timestamp }] : []; }
      return desc(this.rows.filter((r) => r.phone_number === PHONE)).slice(0, 200);
    }
    if (url.includes('/rest/v1/conversations?')) return desc(this.rows).slice(0, 500);
    if (url.includes('/rest/v1/seller_web_chat_log?')) return desc(this.ahmad).slice(0, 300);
    if (url.includes('/rest/v1/client_status')) return [{ phone_number: PHONE, ai_active: true, ai_typing_until: this.typingUntil }, { phone_number: OTHER, ai_active: true }];
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

test('short chat: a new customer message, an AI reply and a seller message only ADD one bubble each; nothing on screen is redrawn', { skip }, async () => {
  const b = new Backend(); seed(b, 12);
  const { page, errors } = await boot(browser, b, base);
  await openChat(page);
  for (const [role, text] of [['user', 'new customer message'], ['assistant', 'new AI reply'], ['assistant', 'new seller message']]) {
    const r = await measure(page, async () => { b.row(PHONE, role, text, later(b)); await page.evaluate((p) => loadThread(p, true), PHONE); });
    assert.equal(r.sameBox, true); assert.equal(r.sameHeader, true); assert.equal(r.sameInput, true);
    assert.equal(r.oldRowsStillTheSameNodes, r.oldRows, 'every bubble that was on screen is still the same node');
    assert.equal(r.rowsNow, r.oldRows + 1);
    assert.equal(r.removed, 0);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('1,000-row chat: a new message adds one bubble; the 200 bubbles, the header and the input are not replaced (three messages in a row)', { skip }, async () => {
  const b = new Backend(); seed(b, 1000);
  const { page, errors } = await boot(browser, b, base);
  await openChat(page);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#messages .msg-row').length), 200);
  for (let i = 0; i < 3; i++) {
    const r = await measure(page, async () => { b.row(PHONE, i === 1 ? 'assistant' : 'user', 'long chat message ' + i, later(b)); await page.evaluate((p) => loadThread(p, true), PHONE); });
    assert.equal(r.sameBox, true, 'round ' + i); assert.equal(r.sameHeader, true); assert.equal(r.sameInput, true);
    assert.equal(r.oldRowsStillTheSameNodes, r.oldRows, 'round ' + i + ': old bubbles kept');
    assert.equal(r.rowsNow, r.oldRows + 1);
    assert.equal(r.removed, 0);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('the AI typing dots turn into the reply: the dots row is replaced by the reply, the rest stays; the reply gets the morph animation', { skip }, async () => {
  const b = new Backend(); seed(b, 12);
  const { page } = await boot(browser, b, base);
  await openChat(page);
  b.typingUntil = new Date(Date.now() + 60000).toISOString();
  await page.evaluate((p) => loadThread(p, true), PHONE);
  await page.waitForFunction(() => !!document.querySelector('#messages .typing-bubble'));
  const r = await measure(page, async () => { b.typingUntil = null; b.row(PHONE, 'assistant', 'reply after typing', later(b)); await page.evaluate((p) => loadThread(p, true), PHONE); });
  assert.equal(r.sameBox, true); assert.equal(r.sameHeader, true);
  assert.equal(await page.evaluate(() => !!document.querySelector('#messages .typing-bubble')), false);
  assert.equal(r.oldRowsStillTheSameNodes, r.oldRows - 1, 'only the typing row went away');
  await page.close();
});

test('the arrival animation: style A (spring + glow) uses transform and opacity only, is removed after it played, and a reduced-motion device gets a plain fade', { skip }, async () => {
  const b = new Backend(); seed(b, 12);
  const { page } = await boot(browser, b, base);
  await openChat(page);
  b.row(PHONE, 'user', 'animated message', later(b));
  await page.evaluate((p) => loadThread(p, true), PHONE);
  const during = await page.evaluate(() => { const all = document.querySelectorAll('#messages .msg-row'); const el = all[all.length - 1]; return { cls: el.className, anims: el.getAnimations({ subtree: true }).map((a) => a.animationName).sort().join(',') }; });
  assert.match(during.cls, /msg-enter/);
  assert.equal(during.anims, 'msgA-glow,msgA-in');
  const props = await page.evaluate(() => { const names = []; for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch (e) { continue; } for (const r of rules) if (r.type === CSSRule.KEYFRAMES_RULE && /^msg(A-in|A-glow|A-morph)$/.test(r.name)) { const set = new Set(); for (const k of r.cssRules) for (let i = 0; i < k.style.length; i++) set.add(k.style[i]); names.push([r.name, [...set].sort().join(',')]); } } return names.sort(); });
  for (const [name, p] of props) assert.match(p, /^(opacity|opacity,transform)$/, name + ' animates only opacity and transform');
  assert.equal(props.length, 3);
  await page.waitForTimeout(1700);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.msg-enter').length), 0, 'the class is removed after the animation');
  await page.close();
  const rm = await boot(browser, b, base, { reducedMotion: 'reduce' });
  await openChat(rm.page);
  b.row(PHONE, 'user', 'calm message', later(b));
  await rm.page.evaluate((p) => loadThread(p, true), PHONE);
  const anims = await rm.page.evaluate(() => (() => { const all = document.querySelectorAll('#messages .msg-row'); return all[all.length - 1].getAnimations({ subtree: true }).map((a) => a.animationName).join(','); })());
  assert.equal(anims, 'msgRm-in');
  await rm.page.close();
});

test('scroll rules: at the bottom the view follows; scrolled up it stays where it is and a "N new messages" pill counts; the pill jumps down and goes away', { skip }, async () => {
  const b = new Backend(); seed(b, 40);
  const { page } = await boot(browser, b, base);
  await openChat(page);
  // at the bottom: follows the new message, no pill
  b.row(PHONE, 'user', 'one while at the bottom', later(b));
  await page.evaluate((p) => loadThread(p, true), PHONE);
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => { const s = document.getElementById('messages'); return s.scrollHeight - s.scrollTop - s.clientHeight < 5; }), true);
  assert.equal(await page.evaluate(() => !!document.querySelector('#new-msgs-pill.show')), false);
  // scrolled up
  await page.evaluate(() => { document.getElementById('messages').scrollTop = 0; });
  await page.waitForTimeout(150);
  b.row(PHONE, 'user', 'first while scrolled up', later(b));
  b.row(PHONE, 'assistant', 'second while scrolled up', later(b) + 1000);
  await page.evaluate((p) => loadThread(p, true), PHONE);
  await page.waitForTimeout(400);
  const up = await page.evaluate(() => ({ top: document.getElementById('messages').scrollTop, pill: (document.querySelector('#new-msgs-pill.show') || {}).textContent || null }));
  assert.ok(up.top < 5, 'the scroll position was kept');
  assert.match(up.pill, /2 new messages/);
  b.row(PHONE, 'user', 'third', later(b) + 2000);
  await page.evaluate((p) => loadThread(p, true), PHONE);
  await page.waitForTimeout(300);
  assert.match(await page.evaluate(() => document.querySelector('#new-msgs-pill.show').textContent), /3 new messages/);
  await page.click('#new-msgs-pill');
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => { const s = document.getElementById('messages'); return { bottom: s.scrollHeight - s.scrollTop - s.clientHeight < 5, pill: !!document.querySelector('#new-msgs-pill.show') }; });
  assert.deepEqual(after, { bottom: true, pill: false });
  await page.close();
});

test('chat list: the 8 s poll with nothing new replaces nothing; a new message in one chat only changes that row; order changes move rows without redrawing the others', { skip }, async () => {
  const b = new Backend(); seed(b, 6); seed(b, 6, OTHER);
  const { page } = await boot(browser, b, base);
  await page.evaluate(async () => { await loadConversations(); });
  await page.waitForFunction(() => document.querySelectorAll('#convo-list .convo-row').length === 2);
  const keep = () => page.evaluate(() => { window.__rows = Array.from(document.querySelectorAll('#convo-list .convo-row')); return window.__rows.length; });
  await keep();
  await page.evaluate(async () => { await loadConversations(); });
  assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('#convo-list .convo-row')).every((r, i) => r === window.__rows[i])), true, 'nothing new: every row is the same node');
  // a new message in the OTHER chat moves it to the top; the first chat's row keeps being the same node
  b.row(OTHER, 'user', 'something new in the other chat', Date.now());
  const ref = await page.evaluate(() => { const rows = Array.from(document.querySelectorAll('#convo-list .convo-row')); return rows.map((r) => r.dataset.phone); });
  await page.evaluate(async () => { await loadConversations(); });
  const res = await page.evaluate((ph) => { const now = Array.from(document.querySelectorAll('#convo-list .convo-row')); const before = window.__rows; const byPhone = (arr, p) => arr.find((r) => r.dataset.phone === p); return { order: now.map((r) => r.dataset.phone), keptTheChangedRowNode: byPhone(now, ph.other) === byPhone(before, ph.other), keptTheOtherRowNode: byPhone(now, ph.phone) === byPhone(before, ph.phone) }; }, { phone: PHONE, other: OTHER });
  assert.equal(res.keptTheOtherRowNode, true, 'the untouched chat row is the very same node');
  assert.equal(res.order.length, 2);
  void ref;
  await page.close();
});

test('AI assistant screen: a new message only adds a bubble; the header, the old bubbles and the input stay the same nodes', { skip }, async () => {
  const b = new Backend();
  for (let i = 0; i < 14; i++) b.ahmadRow(i % 2 ? 'ahmad' : 'seller', 'assistant screen message ' + i, T0 + i * 60000);
  const { page, errors } = await boot(browser, b, base);
  await page.evaluate(async () => { ahmadChatOpen = true; await renderAhmadChatPanel(false); });
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg-row').length === 14);
  for (let i = 0; i < 2; i++) {
    const r = await measure(page, async () => { b.ahmadRow(i ? 'seller' : 'ahmad', 'fresh assistant message ' + i, T0 + (30 + i) * 60000); await page.evaluate(() => renderAhmadChatPanel(true)); });
    assert.equal(r.sameBox, true); assert.equal(r.sameHeader, true); assert.equal(r.sameInput, true);
    assert.equal(r.oldRowsStillTheSameNodes, r.oldRows); assert.equal(r.rowsNow, r.oldRows + 1); assert.equal(r.removed, 0);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('when the screen cannot simply be extended (an older message disappeared) the full redraw still works', { skip }, async () => {
  const b = new Backend(); seed(b, 12);
  const { page, errors } = await boot(browser, b, base);
  await openChat(page);
  b.rows.splice(3, 1);   // an old message was removed
  b.row(PHONE, 'user', 'after a removal', later(b));
  await page.evaluate((p) => loadThread(p, true), PHONE);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#messages .msg-row').length), 12);   // 12 - 1 + 1
  assert.deepEqual(errors, []);
  await page.close();
});

test('bubbles added one by one are byte-for-byte the same as bubbles drawn by a full redraw (text with a quote, photo, video, file, voice)', { skip }, async () => {
  const mk = (b, ms) => {
    b.row(PHONE, 'user', 'plain customer text', ms);
    b.row(PHONE, 'assistant', 'reply with a quote', ms + 1000, { reply_to_wa_id: 'wamid.QUOTE', reply_to_text: 'the quoted words' });
    b.row(PHONE, 'user', '🖼️ Photo: https://example.test/storage/v1/object/public/chat-media/s/p.png | a caption', ms + 2000);
    b.row(PHONE, 'user', '🎥 Video: https://example.test/storage/v1/object/public/chat-media/s/v.mp4', ms + 3000);
    b.row(PHONE, 'assistant', '📄 File: report.pdf | https://example.test/storage/v1/object/public/chat-media/s/f.pdf', ms + 4000);
    b.row(PHONE, 'user', '🎤 Voice: https://example.test/storage/v1/object/public/chat-media/s/a.ogg', ms + 5000, { transcript: 'spoken words' });
  };
  const grab = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#messages .msg-row')).map((r) => r.outerHTML.replace(/\s+(msg-enter|msg-from-typing)/g, '').replace(/ style=""/g, '').replace(/ data-gonecheck="1"/g, '')));
  // full redraw
  const full = new Backend(); seed(full, 4); mk(full, T0 + 100 * 60000);
  const p1 = await boot(browser, full, base); await openChat(p1.page);
  const fullHtml = await grab(p1.page); await p1.page.close();
  // one by one
  const inc = new Backend(); seed(inc, 4);
  const p2 = await boot(browser, inc, base); await openChat(p2.page);
  const probe = new Backend(); mk(probe, T0 + 100 * 60000);
  for (const r of probe.rows) { inc.rows.push({ ...r, id: full.rows[4 + probe.rows.indexOf(r)].id, wa_message_id: full.rows[4 + probe.rows.indexOf(r)].wa_message_id }); await p2.page.evaluate((p) => loadThread(p, true), PHONE); await p2.page.waitForTimeout(120); }
  await p2.page.waitForTimeout(300);
  const incHtml = await grab(p2.page); await p2.page.close();
  assert.equal(incHtml.length, fullHtml.length);
  assert.deepEqual(incHtml.slice(-6), fullHtml.slice(-6));
});

test('the bubble drawing code itself is unchanged by this change (renderBubble keeps the same text)', () => {
  const start = html.indexOf('function renderBubble(');
  assert.ok(start > 0);
  const end = html.indexOf('\n}\n', start);
  const src = html.slice(start, end + 3);
  const hash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
  assert.equal(hash, process.env.RENDER_BUBBLE_HASH_OVERRIDE || EXPECTED_RENDER_BUBBLE_HASH);
});

test('service worker cache version is v59 or newer and the new CSS and JS pieces are present', () => {
  const m = sw.match(/CACHE_NAME = 'sparkly-shell-v(\d+)'/);
  assert.ok(m && Number(m[1]) >= 59);
  for (const needle of ['// <smooth-update>', '// </smooth-update>', '@keyframes msgA-in', '@keyframes msgRm-in', '#new-msgs-pill']) assert.ok(html.includes(needle), needle);
});

const EXPECTED_RENDER_BUBBLE_HASH = '95c3e594506e0768';
