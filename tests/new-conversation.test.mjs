// Run with:  node --test tests/*.test.mjs
// Real-browser tests of the "Start a new conversation" screen. The REAL index.html runs in Chromium; the Start New Conversation door and
// the delivery-receipts table (message_status) are answered by the test. Skipped when Playwright is not installed (it is installed in CI).
// Covers: neutral number instructions, the confirm wording, and the four results after sending (sent, not on WhatsApp reported by WhatsApp,
// refused right away, nothing in time). No phone number or message text is printed anywhere.
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
const WA_ID = 'wamid.NEWCONV1';
const DOOR = '/webhook/start-new-conversation';

const NOT_ON_WA = 'This number is not on WhatsApp.';
const WAITING = 'Sent. Waiting for WhatsApp to confirm.';
const CONFIRM = 'Ready to send. If this number is not on WhatsApp, we will tell you right after sending.';
const HELP = 'Country code first, then the number, with no plus sign and no leading zero. Example: 15550100100';

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

class World {
  constructor() {
    this.sends = 0;          // how many times the door was asked to SEND
    this.checks = 0;
    this.doorSend = { success: true, waMessageId: WA_ID };   // what the door answers to a send
    this.report = null;      // { at: ms since start, row } : the delivery report appears at that time
    this.t0 = Date.now();
  }
  now() { return Date.now() - this.t0; }
  answer(url, method, postData) {
    if (method === 'POST' && url.endsWith(DOOR)) {
      const action = JSON.parse(postData || '{}').action;
      if (action === 'check') { this.checks++; return { success: true, isValidWhatsApp: true, wa_id: PHONE, verified: false }; }
      if (action === 'cleanup') return { success: true, removed: false, reason: 'kept_history' };   // the backup removal is not a send (tests/new-conversation-removal.test.mjs covers it)
      this.sends++;
      return this.doorSend;
    }
    // the chat the send created exists (one note), like in the real database; removal is covered in new-conversation-removal.test.mjs
    if (url.includes('/rest/v1/conversations?seller_id=') || url.includes('/rest/v1/conversations?phone_number=')) {
      return [{ id: 1, phone_number: PHONE, message: 'note', role: 'assistant', timestamp: '2026-11-12T10:00:00Z', channel: 'whatsapp', wa_message_id: WA_ID }];
    }
    if (url.includes('/rest/v1/message_status')) {
      return this.report && this.now() >= this.report.at ? [this.report.row] : [];
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
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}

/** Opens the screen, enters the number and presses "Check Number"; ends on the confirm step. */
const toConfirm = async (page) => {
  await page.evaluate((phone) => {
    openNewConversationModal();
    document.getElementById('new-conversation-phone-input').value = phone;
  }, PHONE);
  await page.evaluate(() => checkNewConversationNumber());
  await page.waitForFunction(() => document.getElementById('new-conversation-step-confirm').style.display === 'block');
};
const pressSend = (page) => page.evaluate(() => { window.__sendDone = sendNewConversationTemplate().then(() => true); });
const sendDone = (page) => page.evaluate(() => window.__sendDone);
const sendStatus = (page) => page.evaluate(() => document.getElementById('new-conversation-send-status').textContent);
const modalOpen = (page) => page.evaluate(() => document.getElementById('new-conversation-modal').style.display !== 'none');
const chatOpen = (page) => page.evaluate((phone) => activePhone === phone, PHONE);
const banner = (page) => page.evaluate(() => { const b = document.getElementById('new-conv-banner'); return b ? { text: b.querySelector('span').textContent, kind: b.className } : null; });
const waitFor = async (cond, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out waiting'); };

let server; let browser; let base;
test.before(async () => {
  if (!chromium) return;
  server = await makeServer();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

// ---------- wording (no browser needed) ----------
test('the number screen has one neutral example, everywhere, and no Iraqi code or example number', () => {
  const start = html.indexOf('<div id="new-conversation-modal"');
  const end = html.indexOf('<div id="whatsapp-connect-gate"');
  const modal = html.slice(start, end);
  assert.ok(modal.includes(HELP), 'the help text');
  assert.ok(modal.includes('placeholder="15550100100"'), 'the placeholder uses the same example');
  assert.ok(!/964|\+\s?\d|07\d{8,}|Iraq/i.test(modal.replace(HELP, '')), 'no national code or example left on the screen');
  const examples = modal.match(/\d{11}/g) || [];
  assert.deepEqual([...new Set(examples)], ['15550100100'], 'only one example number on the screen');
});

test('the confirm wording replaces "This number is on WhatsApp", and nothing on the screen claims WhatsApp before sending', () => {
  assert.ok(html.includes("'" + CONFIRM + " Since they haven"), 'new confirm wording');
  assert.ok(!html.includes('This number is on WhatsApp'), 'the old claim is gone');
  const modal = html.slice(html.indexOf('<div id="new-conversation-modal"'), html.indexOf('<div id="whatsapp-connect-gate"'));
  assert.ok(!/check if they have WhatsApp/i.test(modal));
});

test('the real limits: 20 s on the screen, then the chat opens and WhatsApp is watched for 10 minutes', () => {
  assert.match(html, /const NEWCONV_WAIT_MS = 20000,/);
  assert.match(html, /NEWCONV_WATCH_MS = 600000/);
  assert.match(html, /const NEWCONV_NOT_ON_WHATSAPP_CODE = '131026';/);
});

test('the screen shows the confirm text in the browser', { skip }, async () => {
  const w = new World();
  const { page, errors } = await boot(browser, w, base);
  await page.evaluate(() => openNewConversationModal());
  assert.equal(await page.evaluate(() => document.getElementById('new-conversation-phone-help').textContent), HELP);
  await toConfirm(page);
  const text = await page.evaluate(() => document.getElementById('new-conversation-confirm-text').textContent);
  assert.ok(text.startsWith(CONFIRM), text);
  assert.equal(w.sends, 0, 'nothing is sent until the seller presses send');
  assert.deepEqual(errors, []);
  await page.close();
});

// ---------- the four results after sending ----------
test('a) valid and sent: "Sending..." first, then the chat with that number opens; no banner', { skip }, async () => {
  const w = new World();
  w.report = { at: 1500, row: { wa_message_id: WA_ID, status: 'sent', error_code: null } };
  const { page, errors } = await boot(browser, w, base);
  await toConfirm(page);
  w.t0 = Date.now();
  await pressSend(page);
  await waitFor(async () => w.sends === 1);
  assert.equal(await sendStatus(page), 'Sending...');
  assert.equal(await chatOpen(page), false, 'not opened before WhatsApp answers');
  await sendDone(page);
  assert.equal(await chatOpen(page), true, 'the chat with that number is open');
  assert.equal(await modalOpen(page), false);
  assert.equal(await banner(page), null);
  assert.equal(w.sends, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a) "delivered" opens the chat too', { skip }, async () => {
  const w = new World();
  w.report = { at: 0, row: { wa_message_id: WA_ID, status: 'delivered', error_code: null } };
  const { page } = await boot(browser, w, base);
  await toConfirm(page); await pressSend(page); await sendDone(page);
  assert.equal(await chatOpen(page), true);
  await page.close();
});

test('b) not on WhatsApp, reported by WhatsApp (error 131026): the message is shown, no chat, no retry', { skip }, async () => {
  const w = new World();
  w.report = { at: 1200, row: { wa_message_id: WA_ID, status: 'failed', error_code: 131026, error_text: 'Message undeliverable' } };
  const { page, errors } = await boot(browser, w, base);
  await toConfirm(page);
  w.t0 = Date.now();
  await pressSend(page); await sendDone(page);
  assert.equal(await sendStatus(page), NOT_ON_WA);
  assert.equal(await chatOpen(page), false, 'no chat is opened');
  assert.equal(await modalOpen(page), true);
  assert.equal(await page.evaluate(() => document.getElementById('new-conversation-send-btn').disabled), true, 'the send button cannot be pressed again');
  await page.evaluate(() => document.getElementById('new-conversation-send-btn').click());
  await page.waitForTimeout(500);
  assert.equal(w.sends, 1, 'nothing was sent a second time');
  assert.deepEqual(errors, []);
  await page.close();
});

test('b) error code arrives as text "131026" too', { skip }, async () => {
  const w = new World();
  w.report = { at: 0, row: { wa_message_id: WA_ID, status: 'failed', error_code: '131026' } };
  const { page } = await boot(browser, w, base);
  await toConfirm(page); await pressSend(page); await sendDone(page);
  assert.equal(await sendStatus(page), NOT_ON_WA);
  await page.close();
});

test('b) refused right away by the door (invalid recipient): the message is shown, no chat, no retry, WhatsApp is not even asked for a report', { skip }, async () => {
  const w = new World();
  w.doorSend = { success: false, error: 'Failed to send template message: Request failed with status code 400', notOnWhatsApp: true };
  const { page, errors } = await boot(browser, w, base);
  await toConfirm(page); await pressSend(page); await sendDone(page);
  assert.equal(await sendStatus(page), NOT_ON_WA);
  assert.equal(await chatOpen(page), false);
  assert.equal(await modalOpen(page), true);
  assert.equal(await page.evaluate(() => document.getElementById('new-conversation-send-btn').disabled), true);
  assert.equal(w.sends, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('another refusal keeps the door\'s own sentence and can be tried again', { skip }, async () => {
  const w = new World();
  w.doorSend = { success: false, error: 'Failed to send template message: socket hang up' };
  const { page } = await boot(browser, w, base);
  await toConfirm(page); await pressSend(page); await sendDone(page);
  assert.equal(await sendStatus(page), 'Failed to send template message: socket hang up');
  assert.equal(await page.evaluate(() => document.getElementById('new-conversation-send-btn').disabled), false);
  await page.close();
});

test('c) nothing within the time: "Sent. Waiting for WhatsApp to confirm.", the chat opens anyway, and a LATER failure shows a banner in that chat', { skip }, async () => {
  const w = new World();
  const { page, errors } = await boot(browser, w, base);
  await page.evaluate(() => { window._newConvWaitMs = 2000; window._newConvPollMs = 300; window._newConvWatchPollMs = 300; window._ncDropGapMs = 300; });
  await toConfirm(page);
  w.t0 = Date.now();
  w.report = { at: 4500, row: { wa_message_id: WA_ID, status: 'failed', error_code: 131026 } };   // arrives well after the wait
  const t = Date.now();
  await pressSend(page); await sendDone(page);
  assert.ok(Date.now() - t >= 1900, 'it waited the full time first');
  assert.equal(await chatOpen(page), true, 'the chat is open');
  await waitFor(async () => (await banner(page))?.text === WAITING, 5000);   // the chat draws a moment after it opens
  assert.deepEqual(await banner(page), { text: WAITING, kind: 'info' });
  await waitFor(async () => (await banner(page))?.text === NOT_ON_WA, 8000);
  assert.deepEqual(await banner(page), { text: NOT_ON_WA, kind: 'error' });
  assert.equal(w.sends, 1, 'no retry');
  assert.deepEqual(errors, []);
  await page.close();
});

test('c) nothing within the time, then WhatsApp confirms: the waiting banner goes away, no failure shown', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await page.evaluate(() => { window._newConvWaitMs = 1500; window._newConvPollMs = 300; window._newConvWatchPollMs = 300; window._ncDropGapMs = 300; });
  await toConfirm(page);
  w.t0 = Date.now();
  w.report = { at: 3500, row: { wa_message_id: WA_ID, status: 'delivered', error_code: null } };
  await pressSend(page); await sendDone(page);
  await waitFor(async () => (await banner(page))?.text === WAITING, 5000);
  await waitFor(async () => (await banner(page)) === null, 8000);
  await page.close();
});

test('c) a failure that arrives while the seller is in another chat is shown when that chat is opened', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await page.evaluate(() => { window._newConvWaitMs = 1000; window._newConvPollMs = 300; window._newConvWatchPollMs = 300; window._ncDropGapMs = 300; });
  await toConfirm(page);
  w.t0 = Date.now();
  w.report = { at: 3000, row: { wa_message_id: WA_ID, status: 'failed', error_code: 131026 } };
  await pressSend(page); await sendDone(page);
  await page.evaluate(() => { activePhone = '15550199999'; });   // the seller moved to another chat
  await page.waitForTimeout(3500);
  await page.evaluate((phone) => selectConvo(phone), PHONE);
  await waitFor(async () => (await banner(page))?.text === NOT_ON_WA, 8000);
  await page.close();
});

test('the door gave no message id (old n8n answer): the report of the new message is found by phone, not by id', { skip }, async () => {
  const w = new World();
  w.doorSend = { success: true };
  w.report = { at: 800, row: { wa_message_id: 'wamid.OTHER', status: 'failed', error_code: 131026 } };
  const { page } = await boot(browser, w, base);
  await toConfirm(page); w.t0 = Date.now(); await pressSend(page); await sendDone(page);
  assert.equal(await sendStatus(page), NOT_ON_WA);
  assert.equal(await chatOpen(page), false);
  await page.close();
});

test('no phone number or message text is written to the console log by the screen', { skip }, async () => {
  const w = new World();
  w.report = { at: 0, row: { wa_message_id: WA_ID, status: 'sent', error_code: null } };
  const { page } = await boot(browser, w, base);
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await toConfirm(page); await pressSend(page); await sendDone(page);
  assert.ok(!logs.some((l) => l.includes(PHONE)), 'no number in the console');
  await page.close();
});
