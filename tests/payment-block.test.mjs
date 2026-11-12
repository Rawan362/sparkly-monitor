// Run with:  node --test tests/*.test.mjs
// A seller's WhatsApp Business Account without a currency and a payment method cannot start conversations with templates: WhatsApp accepts
// the send, then reports a failed delivery with error 131042, and the account status is BLOCKED with error 141006.
// Covers: the exact words, the JS and CSS syntax of the web app, the message above the create button (Settings) and above the buttons of the
// Start a new conversation panel (read-only status check before anything is created or sent), 131042 at delivery, the door's own reason code,
// an account that is fine, and a different failure that keeps the old generic message. Mocked doors only: nothing leaves the test, nothing is spent.
// No phone number or message text is printed anywhere. Browser tests are skipped when Playwright is not installed (it is installed in CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire('/opt/node-tools/node_modules/')('playwright').chromium; } catch (e2) { chromium = null; }
}
const skip = chromium ? false : 'Playwright is not installed';

const MESSAGE = 'Your WhatsApp Business account has no payment method or currency set up, so WhatsApp refuses to deliver business-started messages. Open Meta Business Manager, then WhatsApp Accounts, then Billing and payments, set your currency and add a payment method, then try again.';
const GENERIC = 'WhatsApp could not deliver this message.';
const PHONE = '15550100100';
const WA_ID = 'wamid.PAYBLOCK1';
const BLOCKED = { ok: true, connected: true, sendingStatus: 'blocked_payment', reason: 'payment_method_missing', message: MESSAGE };
const FINE = { ok: true, connected: true, sendingStatus: 'ok' };
const LANGS = [{ code: 'en', label: 'English', defaultText: 'Hello! This is {{1}}. We are happy to help you with anything you need.' }];
const APPROVED = { id: '1', name: 'sparkly_welcome_en', language: 'en', languageLabel: 'English', status: 'approved', statusText: 'Approved.', ours: true, canStart: true, canEdit: true, canDelete: true };

// ---------- syntax and wording (no browser needed) ----------
test('the web app JavaScript parses: every inline script is valid', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
  assert.ok(scripts.length > 0);
  for (const [i, code] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(code, { filename: 'inline-script-' + i }), 'script ' + i);
  }
});

test('the web app CSS is well formed: every style block has balanced braces and the new rules are there', () => {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0);
  for (const [i, css] of blocks.entries()) {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of bare) { if (ch === '{') depth++; if (ch === '}') depth--; assert.ok(depth >= 0, 'style block ' + i + ' closes a brace it never opened'); }
    assert.equal(depth, 0, 'style block ' + i + ' has unbalanced braces');
  }
  assert.match(html, /\.payment-block \{[^}]*background: var\(--danger-soft\)/);
});

test('the words are exact and neutral: no country, language or currency is named', () => {
  assert.ok(html.includes("const PAYMENT_BLOCK_MESSAGE = '" + MESSAGE + "';"));
  assert.ok(!/iraq|dollar|\busd\b|\biqd\b|arab/i.test(MESSAGE));
  assert.match(html, /const PAYMENT_BLOCK_CODES = \['131042', '141006'\];/);
});

// ---------- the browser ----------
function makeServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.join(root, f);
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

class World {
  constructor() {
    this.status = FINE;          // what the templates door answers to sending_status (a function or an object)
    this.statusCalls = 0;
    this.sends = 0; this.checks = 0; this.creates = 0;
    this.doorSend = { success: true, waMessageId: WA_ID };
    this.report = null;          // the delivery report row the table returns
  }
  templates(body) {
    if (body.action === 'sending_status') { this.statusCalls++; return typeof this.status === 'function' ? this.status() : this.status; }
    if (body.action === 'create') { this.creates++; return { ok: true, connected: true, created: true, message: 'Sent to WhatsApp for review.' }; }
    return { ok: true, connected: true, templates: [APPROVED], languages: LANGS, businessName: 'Shop', variable: '{{1}}' };
  }
  start(body) {
    if (body.action === 'check') { this.checks++; return { success: true, isValidWhatsApp: true, wa_id: PHONE, verified: false }; }
    this.sends++;
    return this.doorSend;
  }
}

async function boot(browser, world, base) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    let body = [];
    if (/\/webhook\/seller-message-templates$/.test(u)) body = world.templates(JSON.parse(req.postData() || '{}'));
    else if (/\/webhook\/start-new-conversation$/.test(u)) body = world.start(JSON.parse(req.postData() || '{}'));
    else if (u.includes('/rest/v1/message_status')) body = world.report ? [world.report] : [];
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(body) });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(() => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
        window._sellerPnid = 'pnid-1';
        window._newConvWaitMs = 1500; window._newConvPollMs = 100;
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const waitFor = async (cond, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out waiting'); };
// "shown" = the page did not hide it (Settings sits inside a panel that is closed in this test, so layout is not checked there).
const visible = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && e.style.display !== 'none'; }, id);
const text = (page, id) => page.evaluate((i) => document.getElementById(i).textContent, id);

let server; let browser; let base;
test.before(async () => {
  if (!chromium) return;
  server = await makeServer();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

// ----- Settings, Message templates -----
const openSettings = async (page) => { await page.evaluate(() => { const b = document.getElementById('tpl-box'); b.open = true; tplToggled(b); }); };

test('Settings: account blocked for payment (141006): the message is above the create button; creating is not blocked', { skip }, async () => {
  const w = new World(); w.status = BLOCKED;
  const { page, errors } = await boot(browser, w, base);
  await openSettings(page);
  await waitFor(() => visible(page, 'tpl-payment-block'));
  assert.equal(await text(page, 'tpl-payment-text'), MESSAGE);
  const above = await page.evaluate(() => !!(document.getElementById('tpl-payment-block').compareDocumentPosition(document.getElementById('tpl-save')) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert.ok(above, 'the message comes before the create button');
  assert.equal(await page.evaluate(() => document.getElementById('tpl-save').disabled), false, 'a template can still be created');
  assert.equal(w.creates, 0, 'nothing is created by looking');
  assert.deepEqual(errors, []);
  await page.close();
});

test('Settings: an account that is fine shows nothing', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await openSettings(page);
  await waitFor(() => w.statusCalls >= 1);
  await page.waitForTimeout(300);
  assert.equal(await visible(page, 'tpl-payment-block'), false);
  assert.equal(await text(page, 'tpl-payment-text'), '');
  await page.close();
});

test('Settings: blocked for another reason, an unreadable status or an unknown answer shows nothing about payment', { skip }, async () => {
  for (const answer of [{ ok: true, sendingStatus: 'blocked_other' }, { ok: true, sendingStatus: 'unknown' }, { ok: false, error: 'meta_failed', message: 'x' }, {}]) {
    const w = new World(); w.status = answer;
    const { page } = await boot(browser, w, base);
    await openSettings(page);
    await waitFor(() => w.statusCalls >= 1);
    await page.waitForTimeout(300);
    assert.equal(await visible(page, 'tpl-payment-block'), false, JSON.stringify(answer));
    await page.close();
  }
});

// ----- Start a new conversation -----
const open = (page) => page.evaluate((phone) => { openNewConversationModal(); document.getElementById('new-conversation-phone-input').value = phone; }, PHONE);
const toConfirm = async (page) => {
  await open(page);
  await waitFor(() => page.evaluate(() => !document.getElementById('new-conversation-check-btn').disabled));
  await page.evaluate(() => checkNewConversationNumber());
  await page.waitForFunction(() => document.getElementById('new-conversation-step-confirm').style.display === 'block');
};
const pressSend = (page) => page.evaluate(() => { window.__sendDone = sendNewConversationTemplate().then(() => true); });
const sendDone = (page) => page.evaluate(() => window.__sendDone);

test('Start panel: account blocked (141006): the message is shown above the buttons, the number is not checked, nothing is sent', { skip }, async () => {
  const w = new World(); w.status = BLOCKED;
  const { page, errors } = await boot(browser, w, base);
  await open(page);
  await waitFor(() => visible(page, 'new-conversation-payment-block'));
  assert.equal(await text(page, 'new-conversation-payment-text'), MESSAGE);
  const above = await page.evaluate(() => !!(document.getElementById('new-conversation-payment-block').compareDocumentPosition(document.getElementById('new-conversation-check-btn')) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert.ok(above);
  assert.equal(await page.evaluate(() => document.getElementById('new-conversation-check-btn').disabled), true);
  await page.evaluate(() => checkNewConversationNumber());
  assert.equal(w.checks, 0); assert.equal(w.sends, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Start panel: after the seller fixes the account, "Check again" removes the message and lets the seller go on (by hand, nothing automatic)', { skip }, async () => {
  const w = new World(); w.status = BLOCKED;
  const { page } = await boot(browser, w, base);
  await open(page);
  await waitFor(() => visible(page, 'new-conversation-payment-block'));
  w.status = FINE;
  const before = w.statusCalls;
  await page.evaluate(() => ncPaymentRecheck());
  assert.equal(w.statusCalls, before + 1);
  assert.equal(await visible(page, 'new-conversation-payment-block'), false);
  assert.equal(await page.evaluate(() => document.getElementById('new-conversation-check-btn').disabled), false);
  assert.equal(w.sends, 0);
  await page.close();
});

test('Start panel: an account that is fine shows no payment message and works as before', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await toConfirm(page);
  assert.equal(await visible(page, 'new-conversation-payment-block'), false);
  w.report = { wa_message_id: WA_ID, status: 'sent', error_code: null };
  await pressSend(page); await sendDone(page);
  assert.equal(w.sends, 1);
  assert.equal(await page.evaluate((p) => activePhone === p, PHONE), true, 'the chat opened');
  await page.close();
});

for (const code of [131042, 141006]) {
  test('Start panel: delivery failure ' + code + ' reported after the send: the message is shown, no chat, and the send is never repeated', { skip }, async () => {
    const w = new World();
    const { page, errors } = await boot(browser, w, base);
    await toConfirm(page);
    w.report = { wa_message_id: WA_ID, status: 'failed', error_code: code, error_text: 'currency is not configured' };
    await pressSend(page); await sendDone(page);
    assert.equal(await visible(page, 'new-conversation-payment-block'), true);
    assert.equal(await text(page, 'new-conversation-payment-text'), MESSAGE);
    assert.notEqual(await text(page, 'new-conversation-send-status'), GENERIC, 'not the old generic words');
    assert.equal(await page.evaluate((p) => activePhone === p, PHONE), false, 'no chat opened');
    assert.equal(await page.evaluate(() => document.getElementById('new-conversation-send-btn').disabled), true, 'the send button is not offered again');
    await page.waitForTimeout(800);
    assert.equal(w.sends, 1, 'the send was never repeated');
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('Start panel: the door itself refuses with the reason code payment_method_missing: the message is shown', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await toConfirm(page);
  w.doorSend = { success: false, error: MESSAGE, reason: 'payment_method_missing' };
  await pressSend(page); await sendDone(page);
  assert.equal(await text(page, 'new-conversation-payment-text'), MESSAGE);
  assert.equal(await visible(page, 'new-conversation-payment-block'), true);
  assert.equal(w.sends, 1);
  await page.close();
});

test('Start panel: a DIFFERENT delivery failure keeps the old generic message and no payment message', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await toConfirm(page);
  w.report = { wa_message_id: WA_ID, status: 'failed', error_code: 131000, error_text: 'Something went wrong' };
  await pressSend(page); await sendDone(page);
  assert.equal(await text(page, 'new-conversation-send-status'), GENERIC);
  assert.equal(await visible(page, 'new-conversation-payment-block'), false);
  assert.equal(w.sends, 1);
  await page.close();
});

test('Chat banner: a payment failure that arrives after the chat opened shows the message there', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await page.evaluate(() => { window._newConvWatchPollMs = 100; });
  await toConfirm(page);
  w.report = null;   // nothing within the wait: the chat opens and WhatsApp is watched
  await pressSend(page); await sendDone(page);
  assert.equal(await page.evaluate((p) => activePhone === p, PHONE), true);
  w.report = { wa_message_id: WA_ID, status: 'failed', error_code: 131042, error_text: 'currency is not configured' };
  await waitFor(() => page.evaluate(() => { const b = document.getElementById('new-conv-banner'); return !!b && b.className.includes('error'); }));
  assert.equal(await page.evaluate(() => document.querySelector('#new-conv-banner span').textContent), MESSAGE);
  await page.close();
});
