// Run with:  node --test tests/*.test.mjs
// Chat bubbles: a message that the existing receipt mechanism already reports as failed gets a clear "Not delivered" mark.
// Nothing else about the bubble changes and no new data is requested. If Playwright is not installed (it is installed in CI),
// the browser tests are skipped. The text scan always runs.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). The marked style lines, the changed line and this file are scanned. ----
test('the new failed-state code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-failed-state:css:start');
  const end = html.indexOf('w1-failed-state:css:end');
  assert.ok(start > 0 && end > start, 'marked style block missing');
  const changed = html.split('\n').filter((l) => l.includes('ticks-failed-label">Not delivered'));
  assert.equal(changed.length, 1);
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), css: html.slice(start, end), changed: changed.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is bumped', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 66);
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
test.before(async () => {
  if (!chromium) return;
  server = await makeServer();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(() => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        // The chat area is only drawn when a chat is opened; the tests use a plain container for the bubbles.
        if (!document.getElementById('messages')) { const m = document.createElement('div'); m.id = 'messages'; document.body.appendChild(m); }
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}

test('a failed receipt shows the red mark and the words Not delivered; the reason stays in the tooltip', { skip }, async () => {
  const { page, errors } = await openPage();
  const html = await page.evaluate(() => tickHtml('failed', 'Message undeliverable <b>x</b>'));
  assert.match(html, /<span class="ticks failed" data-dstate="failed" title="Message undeliverable &lt;b&gt;x&lt;\/b&gt;">/);
  assert.match(html, /<span class="ticks-failed-label">Not delivered<\/span><\/span>$/);
  const plain = await page.evaluate(() => tickHtml('failed', ''));
  assert.match(plain, /title="Not delivered"/);
  assert.deepEqual(errors, []);
});

test('the other states are exactly as before: one tick, two ticks, two blue ticks, no label', { skip }, async () => {
  const { page } = await openPage();
  const got = await page.evaluate(() => ({
    sent: tickHtml('sent'), delivered: tickHtml('delivered'), read: tickHtml('read'), other: tickHtml('anything'),
    single: TICK_SINGLE, double: TICK_DOUBLE
  }));
  assert.equal(got.sent, '<span class="ticks" data-dstate="sent" title="Sent">' + got.single + '</span>');
  assert.equal(got.delivered, '<span class="ticks" data-dstate="delivered" title="Delivered">' + got.double + '</span>');
  assert.equal(got.read, '<span class="ticks read" data-dstate="read" title="Read">' + got.double + '</span>');
  assert.equal(got.other, got.delivered);
  assert.ok(![got.sent, got.delivered, got.read].some((h) => h.includes('Not delivered')));
});

test('in a chat bubble only a failed message gets the mark; the message text and the rest of the bubble are the same', { skip }, async () => {
  const { page } = await openPage();
  const result = await page.evaluate(() => {
    const b = (state, error, role) => ({ role: role || 'assistant', message: 'hello there', timestamp: '2026-01-02T10:00:00Z', id: 1, table: 't', deliveryState: state, deliveryError: error });
    const box = document.getElementById('messages');
    const make = (m) => { const d = document.createElement('div'); d.innerHTML = renderBubble(m); return d.firstElementChild; };
    const out = {};
    for (const st of ['failed', 'sent', 'delivered', 'read']) {
      const row = make(b(st, 'Re-engagement message'));
      box.appendChild(row);
      out[st] = { label: row.querySelector('.ticks-failed-label') ? row.querySelector('.ticks-failed-label').textContent : null, text: row.querySelector('.msg-text').textContent, ticks: row.querySelectorAll('.ticks').length };
    }
    const incoming = make(b('failed', 'x', 'user'));
    box.appendChild(incoming);
    out.incoming = { ticks: incoming.querySelectorAll('.ticks').length, label: incoming.querySelector('.ticks-failed-label') === null };
    return out;
  });
  assert.equal(result.failed.label, 'Not delivered');
  assert.equal(result.sent.label, null);
  assert.equal(result.delivered.label, null);
  assert.equal(result.read.label, null);
  assert.ok(['failed', 'sent', 'delivered', 'read'].every((k) => result[k].text === 'hello there' && result[k].ticks === 1));
  assert.deepEqual(result.incoming, { ticks: 0, label: true });
});

test('the mark is visible: red, readable size, and the time line is not dimmed for a failed message', { skip }, async () => {
  const { page } = await openPage();
  const look = await page.evaluate(() => {
    const box = document.getElementById('messages');
    box.innerHTML = '';
    const mk = (state) => { const d = document.createElement('div'); d.innerHTML = renderBubble({ role: 'assistant', message: 'hi', timestamp: '2026-01-02T10:00:00Z', id: 1, table: 't', deliveryState: state }); box.appendChild(d.firstElementChild); return box.lastElementChild; };
    const failed = mk('failed'); const ok = mk('delivered');
    const label = failed.querySelector('.ticks-failed-label');
    const cs = getComputedStyle(label);
    return { display: cs.display, color: getComputedStyle(failed.querySelector('.ticks.failed')).color, size: cs.fontSize, visible: label.getBoundingClientRect().width > 0, failedOpacity: getComputedStyle(failed.querySelector('.ts')).opacity, okOpacity: getComputedStyle(ok.querySelector('.ts')).opacity };
  });
  assert.notEqual(look.display, 'none');
  assert.equal(look.color, 'rgb(229, 83, 75)');
  assert.equal(look.size, '10px');
  assert.equal(look.visible, true);
  assert.equal(look.okOpacity, '0.7', 'other bubbles keep their dimmed time line');
  assert.equal(look.failedOpacity, '1');
});

test('a chat that is already open picks up a failed receipt in place, and a later good receipt takes the mark away again', { skip }, async () => {
  const { page } = await openPage();
  const steps = await page.evaluate(() => {
    const box = document.getElementById('messages');
    box.innerHTML = renderBubble({ role: 'assistant', message: 'hi', timestamp: '2026-01-02T10:00:00Z', id: 1, table: 't', wa_message_id: 'wamid.A', deliveryState: 'sent' });
    const ctx = (status) => ({ byId: { 'wamid.A': { status, error_code: '131026', error_text: 'Undeliverable' } }, lastRead: 0, lastDelivered: 0, firstAt: 1, sig: '' });
    const snap = () => ({ label: !!box.querySelector('.ticks-failed-label'), state: box.querySelector('.ticks').dataset.dstate, title: box.querySelector('.ticks').title, rows: box.querySelectorAll('.msg-row').length });
    const before = snap();
    applyDeliveryToDom('+10000000000', ctx('failed'));
    const failed = snap();
    applyDeliveryToDom('+10000000000', ctx('delivered'));
    const after = snap();
    return { before, failed, after };
  });
  assert.deepEqual(steps.before, { label: false, state: 'sent', title: 'Sent', rows: 1 });
  assert.deepEqual(steps.failed, { label: true, state: 'failed', title: 'Undeliverable', rows: 1 });
  assert.deepEqual(steps.after, { label: false, state: 'delivered', title: 'Delivered', rows: 1 });
});

test('no new data is requested: drawing bubbles and applying receipts makes no network call', { skip }, async () => {
  const { page } = await openPage();
  const calls = await page.evaluate(() => {
    let n = 0;
    const real = window.fetch;
    window.fetch = function() { n++; return real.apply(this, arguments); };
    const box = document.getElementById('messages');
    box.innerHTML = renderBubble({ role: 'assistant', message: 'hi', timestamp: '2026-01-02T10:00:00Z', id: 1, table: 't', wa_message_id: 'wamid.A', deliveryState: 'failed', deliveryError: 'x' });
    applyDeliveryToDom('+10000000000', { byId: { 'wamid.A': { status: 'failed', error_text: 'x' } }, lastRead: 0, lastDelivered: 0, firstAt: 1, sig: '' });
    window.fetch = real;
    return n;
  });
  assert.equal(calls, 0);
});
