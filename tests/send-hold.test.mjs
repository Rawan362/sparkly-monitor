// Run with:  node --test tests/*.test.mjs
// Real-browser tests of the SEND HOLD: after a photo, video, file or voice note the web app waits for WhatsApp's receipt (sent / delivered /
// read / played / failed, or 60 s at most) before it sends the next message to that customer. The REAL index.html runs in Chromium; the
// send doors and the receipts table are answered by the test, which records the exact time of every request.
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


class World {
  constructor() { this.reqs = []; this.receipts = {}; this.t0 = Date.now(); this.n = 0; this.noWaId = false; }
  now() { return Date.now() - this.t0; }
  /** receipt for a message id: status appears `afterMs` after the message was accepted */
  setReceipt(id, status, afterMs) { this.receipts[id] = { status, at: Date.now() + afterMs }; }
  answer(url, method) {
    if (method === 'POST' && /\/webhook\/seller-send-(text|media|voice)$/.test(url)) {
      const kind = url.split('seller-send-')[1];
      const id = 'wamid.' + kind + (++this.n);
      this.reqs.push({ kind, at: this.now(), id });
      if (!this.receipts[id] && this.defaultReceipt) this.setReceipt(id, this.defaultReceipt.status, this.defaultReceipt.afterMs);
      return this.noWaId ? { success: true } : { success: true, waMessageId: id };
    }
    const m = url.match(/message_status\?wa_message_id=eq\.([^&]+)/);
    if (m) {
      const r = this.receipts[decodeURIComponent(m[1])];
      this.polls = (this.polls || 0) + 1;
      return r && Date.now() >= r.at ? [{ status: r.status }] : [];
    }
    if (url.includes('/rest/v1/client_status')) return [{ phone_number: PHONE, ai_active: true, ai_typing_until: null }];
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
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(world.answer(u, route.request().method())) });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate((phone) => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
        window._sellerPnid = 'pnid-1';
        selectConvo(phone);
      }, PHONE);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  await page.waitForFunction(() => !!document.getElementById('reply-text'));
  return { page, errors };
}

const sendText = (page, text) => page.evaluate(async ({ phone, text }) => { document.getElementById('reply-text').value = text; await sendReply(phone); }, { phone: PHONE, text });
const sendMedia = (page, kind) => page.evaluate(async ({ phone, kind }) => {
  window._stagedAttachment = { dataUrl: 'data:application/octet-stream;base64,AAAA', mimeType: kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/jpeg' : 'application/pdf', kind, fileName: 'x' };
  document.getElementById('reply-text').value = '';
  await sendReply(phone);
}, { phone: PHONE, kind });
const sendVoice = (page) => page.evaluate(({ phone }) => { sendVoiceNote(phone, 'data:audio/webm;base64,AAAA'); }, { phone: PHONE });
const kinds = (w) => w.reqs.map((r) => r.kind);
const waitFor = async (cond, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out waiting'); };

let server; let browser; let base;
test.before(async () => {
  if (!chromium) return;
  server = await makeServer();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

for (const [name, send, kind] of [['video', (p) => sendMedia(p, 'video'), 'media'], ['photo', (p) => sendMedia(p, 'image'), 'media'], ['file', (p) => sendMedia(p, 'document'), 'media'], ['voice note', sendVoice, 'voice']]) {
  test(name + ' then text: the text is NOT sent until the receipt shows "sent" (late receipt), its bubble stays visible meanwhile, and the requests are in order', { skip }, async () => {
    const w = new World(); w.defaultReceipt = null;
    const { page, errors } = await boot(browser, w, base);
    w.nextReceipt = true;
    const origAnswer = w.answer.bind(w);
    w.answer = (u, m) => { const r = origAnswer(u, m); if (m === 'POST' && /seller-send-(media|voice)$/.test(u) && r.waMessageId) w.setReceipt(r.waMessageId, 'sent', 2200); return r; };
    await send(page);
    await sendText(page, 'the text right behind it');
    await waitFor(() => w.reqs.length >= 1);
    await page.waitForTimeout(1200);
    assert.deepEqual(kinds(w), [kind], 'only the ' + name + ' has been sent; the text is waiting');
    assert.ok(await page.evaluate(() => document.body.innerText.includes('the text right behind it')), 'the waiting text bubble is visible');
    await waitFor(() => w.reqs.length >= 2);
    assert.deepEqual(kinds(w), [kind, 'text']);
    const receiptAt = w.receipts[w.reqs[0].id].at - w.t0;
    assert.ok(w.reqs[1].at >= receiptAt - 50, 'the text went out only after the receipt (' + w.reqs[1].at + ' vs ' + receiptAt + ')');
    assert.ok(w.reqs[1].at - receiptAt < 1800, 'and right after it');
    assert.deepEqual(errors, []);
    await page.close();
  });
}

for (const st of ['delivered', 'read', 'played', 'failed']) {
  test('receipt "' + st + '" also releases the next send', { skip }, async () => {
    const w = new World();
    const { page } = await boot(browser, w, base);
    const orig = w.answer.bind(w);
    w.answer = (u, m) => { const r = orig(u, m); if (m === 'POST' && /seller-send-media$/.test(u)) w.setReceipt(r.waMessageId, st, 1000); return r; };
    await sendMedia(page, 'video'); await sendText(page, 'next');
    await waitFor(() => w.reqs.length >= 2);
    assert.ok(w.reqs[1].at - (w.receipts[w.reqs[0].id].at - w.t0) < 1800);
    await page.close();
  });
}

test('no receipt at all: the next send is released after the time limit (shortened to 2.5 s here), not before', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await page.evaluate(() => { window._sendHoldMaxMs = 2500; });
  await sendMedia(page, 'video'); await sendText(page, 'after timeout');
  await waitFor(() => w.reqs.length >= 1);
  await page.waitForTimeout(1800);
  assert.deepEqual(kinds(w), ['media'], 'still waiting after 1.8 s');
  await waitFor(() => w.reqs.length >= 2);
  const gap = w.reqs[1].at - w.reqs[0].at;
  assert.ok(gap >= 2400 && gap < 4500, 'released after the limit: ' + gap + ' ms');
  await page.close();
});

test('the real limits are 0.7 s polling and 60 s at most', () => {
  assert.match(html, /const SEND_HOLD_POLL_MS = 700;/);
  assert.match(html, /const SEND_HOLD_MAX_MS = 60000;/);
});

test('text after text is NOT held: both go out at once, in order', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await sendText(page, 'one'); await sendText(page, 'two'); await sendText(page, 'three');
  await waitFor(() => w.reqs.length >= 3);
  assert.deepEqual(kinds(w), ['text', 'text', 'text']);
  assert.ok(w.reqs[2].at - w.reqs[0].at < 1500, 'no waiting between texts');
  assert.equal(w.polls || 0, 0, 'no receipt checks for text');
  await page.close();
});

test('text then video: the video is sent right behind the text (no hold before a media send)', { skip }, async () => {
  const w = new World();
  const { page } = await boot(browser, w, base);
  await sendText(page, 'first'); await sendMedia(page, 'video');
  await waitFor(() => w.reqs.length >= 2);
  assert.deepEqual(kinds(w), ['text', 'media']);
  assert.ok(w.reqs[1].at - w.reqs[0].at < 1500);
  await page.close();
});

test('mixed run: text, video, text, voice, text - exact order of requests, each media send holds only the one after it', { skip }, async () => {
  const w = new World();
  const { page, errors } = await boot(browser, w, base);
  w.defaultReceipt = { status: 'delivered', afterMs: 1500 };
  await sendText(page, 'a'); await sendMedia(page, 'video'); await sendText(page, 'b'); await sendVoice(page); await sendText(page, 'c');
  await waitFor(() => w.reqs.length >= 5, 20000);
  assert.deepEqual(kinds(w), ['text', 'media', 'text', 'voice', 'text']);
  const r = w.reqs;
  assert.ok(r[1].at - r[0].at < 1500, 'video right behind the first text');
  assert.ok(r[2].at - r[1].at >= 1400, 'text b waited for the video receipt');
  assert.ok(r[3].at - r[2].at < 1500, 'voice right behind text b (text is not held)');
  assert.ok(r[4].at - r[3].at >= 1400, 'text c waited for the voice receipt');
  assert.deepEqual(errors, []);
  await page.close();
});

test('if the door does not return a WhatsApp id (old n8n answer), nothing is held', { skip }, async () => {
  const w = new World(); w.noWaId = true;
  const { page } = await boot(browser, w, base);
  await sendMedia(page, 'video'); await sendText(page, 'x');
  await waitFor(() => w.reqs.length >= 2);
  assert.ok(w.reqs[1].at - w.reqs[0].at < 1500);
  assert.equal(w.polls || 0, 0);
  await page.close();
});

test('service worker cache version is v61 or newer', () => {
  const m = sw.match(/CACHE_NAME = 'sparkly-shell-v(\d+)'/);
  assert.ok(m && Number(m[1]) >= 61);
});
