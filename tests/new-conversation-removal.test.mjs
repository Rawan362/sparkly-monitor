// Run with:  node --test tests/*.test.mjs
// A number that is not on WhatsApp leaves no chat. The backend door removes the chat it created (backend PR); these browser tests cover what the
// web app does: the list drops the chat, an open chat closes, an existing customer chat is kept with the old banner, and the after-send result
// still says "This number is not on WhatsApp.". The door and the tables are answered by the test. No phone number or message text is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

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


const PHONE = '15550100100';
const OLD = '15550177777';
const WA_ID = 'wamid.NEWCONV1';
const DOOR = '/webhook/start-new-conversation';
const NOT_ON_WA = 'This number is not on WhatsApp.';
const NOTE = { id: 1, phone_number: PHONE, message: 'Hello from Shop! How can we help?', role: 'assistant', timestamp: '2026-11-12T10:00:00Z', channel: 'whatsapp', wa_message_id: WA_ID };
const EARLIER = { id: 2, phone_number: PHONE, message: 'earlier message', role: 'user', timestamp: '2026-11-10T10:00:00Z', channel: 'whatsapp', wa_message_id: 'wamid.OLD' };

function makeServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.join(root, f);
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

class World {
  constructor(rows) {
    this.rows = rows;            // the conversations rows (the test changes this when "the backend removes the chat")
    this.sends = 0;
    this.cleanups = [];          // what the door was asked by the "cleanup" action (waMessageId only)
    this.cleanupAnswer = { success: true, removed: false, reason: 'kept_history' };
    this.doorSend = { success: true, waMessageId: WA_ID };
    this.report = null;
  }
  answer(url, method, postData) {
    if (method === 'POST' && url.endsWith(DOOR)) {
      const b = JSON.parse(postData || '{}');
      if (b.action === 'check') return { success: true, isValidWhatsApp: true, wa_id: PHONE, verified: false };
      if (b.action === 'cleanup') { this.cleanups.push(b.waMessageId); if (this.cleanupAnswer === 'invalid') return { success: false, error: 'Invalid action - must be check or send' }; return this.cleanupAnswer; }
      this.sends++;
      return this.doorSend;
    }
    if (url.includes('/rest/v1/message_status')) return this.report ? [this.report] : [];
    if (url.includes('/rest/v1/conversations?seller_id=')) return this.rows;
    if (url.includes('/rest/v1/conversations?phone_number=')) {
      const phone = decodeURIComponent(url.split('phone_number=eq.')[1].split('&')[0]);
      return this.rows.filter((r) => r.phone_number === phone);
    }
    return [];
  }
}

async function boot(browser, world, base) {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(world.answer(u, route.request().method(), route.request().postData())) });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(() => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
        window._sellerPnid = 'pnid-1';
        window._newConvWaitMs = 1500; window._newConvPollMs = 200; window._newConvWatchPollMs = 300; window._ncDropGapMs = 300;
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}

const toConfirm = async (page) => {
  await page.evaluate((phone) => { openNewConversationModal(); document.getElementById('new-conversation-phone-input').value = phone; }, PHONE);
  await page.evaluate(() => checkNewConversationNumber());
  await page.waitForFunction(() => document.getElementById('new-conversation-step-confirm').style.display === 'block');
};
const pressSend = (page) => page.evaluate(() => { window.__sendDone = sendNewConversationTemplate().then(() => true); });
const sendDone = (page) => page.evaluate(() => window.__sendDone);
const sendStatus = (page) => page.evaluate(() => document.getElementById('new-conversation-send-status').textContent);
const activePhoneOf = (page) => page.evaluate(() => activePhone);
const inList = (page, phone) => page.evaluate((p) => conversations.some((c) => c.phone_number === p), phone);
const banner = (page) => page.evaluate(() => { const b = document.getElementById('new-conv-banner'); return b ? b.querySelector('span').textContent : null; });
const toast = (page) => page.evaluate(() => { const t = document.querySelector('.nc-toast'); return t ? t.textContent : null; });
const waitFor = async (cond, ms = 12000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out waiting'); };

let server; let browser; let base;
test.before(async () => {
  if (!chromium) return;
  server = await makeServer();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test('wording and wiring that must stay: the result sentence, the cleanup action, the list hook', () => {
  assert.match(html, /const NEWCONV_NOT_ON_WHATSAPP = 'This number is not on WhatsApp\.';/);
  assert.match(html, /action: 'cleanup', waMessageId: waId/);
  assert.match(html, /window\.ncAfterListLoad\(\)/);
});

test('the not-on-WhatsApp chat is removed by the backend while the seller is in it: the list drops it and the chat closes, no refresh', { skip }, async () => {
  const w = new World([NOTE]);
  const { page, errors } = await boot(browser, w, base);
  await toConfirm(page);
  await pressSend(page);
  // nothing from WhatsApp yet: the chat opens with the real message (the note), watched in the background
  await sendDone(page);
  assert.equal(await activePhoneOf(page), PHONE);
  assert.equal(await inList(page, PHONE), true);
  // WhatsApp reports 131026 and the backend has already removed the one note
  w.rows = [];
  w.report = { wa_message_id: WA_ID, status: 'failed', error_code: 131026 };
  await waitFor(async () => (await activePhoneOf(page)) === null);
  assert.equal(await inList(page, PHONE), false, 'the list no longer has the chat');
  assert.equal(await toast(page), NOT_ON_WA);
  assert.equal(await banner(page), null);
  assert.ok(w.cleanups.length >= 1 && w.cleanups.every((id) => id === WA_ID), 'the backup cleanup names only the message id');
  assert.equal(w.sends, 1, 'nothing was sent again');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the same, when the failure arrives before the chat opens: the screen says it, and the list has no chat', { skip }, async () => {
  const w = new World([NOTE]);
  w.report = { wa_message_id: WA_ID, status: 'failed', error_code: 131026 };
  const { page, errors } = await boot(browser, w, base);
  await toConfirm(page);
  await pressSend(page);
  await waitFor(async () => (await sendStatus(page)) === NOT_ON_WA);
  w.rows = [];                                   // the backend removed it
  await sendDone(page);
  assert.equal(await sendStatus(page), NOT_ON_WA, 'the result still says it');
  assert.equal(await activePhoneOf(page), null, 'no chat is opened');
  await waitFor(async () => (await inList(page, PHONE)) === false);
  assert.ok(w.cleanups.includes(WA_ID));
  assert.deepEqual(errors, []);
  await page.close();
});

test('an existing customer chat is kept: it stays in the list and open, and shows the same failure banner as before', { skip }, async () => {
  const w = new World([EARLIER, NOTE]);          // an earlier customer message: the backend never removes it
  const { page, errors } = await boot(browser, w, base);
  await toConfirm(page); await pressSend(page); await sendDone(page);
  assert.equal(await activePhoneOf(page), PHONE);
  w.report = { wa_message_id: WA_ID, status: 'failed', error_code: 131026 };
  await waitFor(async () => (await banner(page)) === NOT_ON_WA);
  assert.equal(await activePhoneOf(page), PHONE, 'still open');
  assert.equal(await inList(page, PHONE), true, 'still in the list');
  assert.equal(await toast(page), null);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a door that does not know "cleanup" (the old n8n answer) or does not answer changes nothing the seller sees', { skip }, async () => {
  for (const answer of ['invalid', { success: true }]) {
    const w = new World([EARLIER, NOTE]);
    w.cleanupAnswer = answer;
    const { page, errors } = await boot(browser, w, base);
    await toConfirm(page); await pressSend(page); await sendDone(page);
    w.report = { wa_message_id: WA_ID, status: 'failed', error_code: 131026 };
    await waitFor(async () => (await banner(page)) === NOT_ON_WA);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('other failures and a good delivery never remove or close a chat', { skip }, async () => {
  for (const report of [{ status: 'delivered', error_code: null }, { status: 'failed', error_code: 131042 }, { status: 'failed', error_code: 130472 }]) {
    const w = new World([NOTE]);
    const { page, errors } = await boot(browser, w, base);
    await toConfirm(page); await pressSend(page); await sendDone(page);
    w.report = { wa_message_id: WA_ID, ...report };
    await page.waitForTimeout(1500);
    assert.equal(await activePhoneOf(page), PHONE);
    assert.equal(await inList(page, PHONE), true);
    assert.deepEqual(w.cleanups, [], 'the door is not asked to remove anything');
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('the list poll alone drops a chat the backend removed (no manual refresh)', { skip }, async () => {
  const w = new World([NOTE, { ...NOTE, id: 9, phone_number: OLD, wa_message_id: 'wamid.X' }]);
  const { page } = await boot(browser, w, base);
  await page.evaluate(() => loadConversations());
  assert.equal(await inList(page, PHONE), true);
  w.rows = w.rows.filter((r) => r.phone_number !== PHONE);
  await page.evaluate(() => loadConversations());
  assert.equal(await inList(page, PHONE), false);
  assert.equal(await inList(page, OLD), true, 'another chat is untouched');
  await page.close();
});

test('no phone number or message text is written to the console log', { skip }, async () => {
  const w = new World([NOTE]);
  const { page } = await boot(browser, w, base);
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await toConfirm(page); await pressSend(page); await sendDone(page);
  w.rows = []; w.report = { wa_message_id: WA_ID, status: 'failed', error_code: 131026 };
  await waitFor(async () => (await activePhoneOf(page)) === null);
  assert.ok(!logs.some((l) => l.includes(PHONE) || l.includes('Hello from Shop')), 'nothing private in the console');
  await page.close();
});
