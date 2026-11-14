// Run with:  node --test tests/*.test.mjs
// Notifications panel: the eight notice types written by the Seller Alerts door. Supabase is answered by the test: nothing leaves the test.
// If Playwright is not installed (it is installed in CI), the browser tests are skipped. The text scan always runs.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). The marked block and the two small hooks are scanned; old code is not. ----
test('the new notice code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-notice-types:js:start');
  const end = html.indexOf('w1-notice-types:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const hookLines = html.split('\n').filter((l) => /w1NoticeIcon\(n\.type\)|w1NoticeTap\(n\) \|\|/.test(l));
  assert.equal(hookLines.length, 2, 'the two small hooks in the notice list code');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hooks: hookLines.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is at least v70 and the older labels are unchanged', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 70);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const line of ["daily_summary: 'Daily Summary'", "customer_escalation: 'Customer needs you'", "customer_question: 'Needs your answer'", "invoice_shipping: 'Shipping price needed'"]) assert.ok(html.includes(line), line);
});

// ---- Browser tests ----
const OLD = [
  { id: 1, type: 'daily_summary', title: 'Daily', message: 'm1' },
  { id: 2, type: 'customer_escalation', title: 'Esc', message: 'm2', customer_phone: '+10000000002' },
  { id: 3, type: 'customer_question', title: 'Q', message: 'm3', question_id: 7 },
  { id: 4, type: 'system_alert', title: 'Sys', message: 'm4' }
];
const NEW_TYPES = {
  order_confirmed: 'Order confirmed',
  customer_needs_you: 'Customer needs you',
  new_vip_customer: 'New VIP customer',
  not_a_customer: 'Not a customer',
  whatsapp_not_connected: 'WhatsApp not connected',
  overdue_orders: 'Overdue orders',
  silent_customers: 'Silent customers',
  cod_not_collected: 'Cash on delivery not collected'
};
const NEW_ROWS = Object.keys(NEW_TYPES).map((type, i) => ({ id: 100 + i, type, title: 'T ' + type, message: 'M ' + type }));
const base_row = { is_read: false, created_at: '2026-01-02T10:00:00Z' };

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

async function openPanel(rows, patches) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/rest\/v1\/seller_notifications/.test(u)) {
      if (route.request().method() === 'PATCH') { patches.push({ url: u, body: route.request().postData() }); return route.fulfill({ status: 204, headers: h }); }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(rows.map((r) => Object.assign({}, base_row, r))) });
    }
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
        window.__chats = 0;
        window.goToChats = () => { window.__chats++; };
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  await page.evaluate(() => { document.getElementById('seller-notifications-tab-content').style.display = 'flex'; return loadNotifications(); });
  await page.waitForSelector('.notification-item');
  return { page, errors };
}
const itemOf = (page, id) => page.$eval('.notification-item[data-id="' + id + '"]', (el) => ({
  label: el.querySelector('.notification-item-type').textContent,
  icons: el.querySelectorAll('.notification-item-type svg').length,
  onclick: el.querySelector('.notification-item-body').getAttribute('onclick'),
  title: el.querySelector('.notification-item-title').textContent,
  message: el.querySelector('.notification-item-message').textContent
}));

test('each of the eight new types shows its label and one icon', { skip }, async () => {
  const { page, errors } = await openPanel(NEW_ROWS, []);
  for (const row of NEW_ROWS) {
    const it = await itemOf(page, row.id);
    assert.equal(it.label, NEW_TYPES[row.type], row.type);
    assert.equal(it.icons, 1, 'icon for ' + row.type);
    assert.equal(it.title, 'T ' + row.type);
    assert.equal(it.message, 'M ' + row.type);
  }
  assert.deepEqual(errors, []);
});

test('the older types look and behave exactly as before: same labels, no icon, same tap action', { skip }, async () => {
  const { page } = await openPanel(OLD, []);
  const a = await itemOf(page, 1);
  const b = await itemOf(page, 2);
  const c = await itemOf(page, 3);
  const d = await itemOf(page, 4);
  assert.deepEqual([a.label, b.label, c.label, d.label], ['Daily Summary', 'Customer needs you', 'Needs your answer', 'System alert']);
  assert.deepEqual([a.icons, b.icons, c.icons, d.icons], [0, 0, 0, 0]);
  assert.equal(a.onclick, 'discussNotification(1)');
  assert.equal(b.onclick, "openEscalationChat(2, '+10000000002')");
  assert.equal(c.onclick, 'openQuestionFromNotification(3, 7)');
  assert.equal(d.onclick, 'discussNotification(4)');
});

test('an unknown type is still shown by its own name with no icon and the old tap action', { skip }, async () => {
  const { page } = await openPanel([{ id: 9, type: 'something_else', title: 'x', message: 'y' }], []);
  const it = await itemOf(page, 9);
  assert.equal(it.label, 'something_else');
  assert.equal(it.icons, 0);
  assert.equal(it.onclick, 'discussNotification(9)');
});

test('tapping "customer needs you" or "not a customer" marks it read and opens the chats list', { skip }, async () => {
  for (const type of ['customer_needs_you', 'not_a_customer']) {
    const patches = [];
    const row = NEW_ROWS.find((r) => r.type === type);
    const { page } = await openPanel(NEW_ROWS, patches);
    await page.click('.notification-item[data-id="' + row.id + '"] .notification-item-body');
    await page.waitForFunction(() => window.__chats === 1);
    assert.equal(await page.$eval('#seller-notifications-tab-content', (e) => e.style.display), 'none');
    const marks = patches.filter((p) => p.url.includes('id=eq.' + row.id));
    assert.equal(marks.length, 1, type);
    assert.deepEqual(JSON.parse(marks[0].body), { is_read: true });
    await page.close();
  }
});

test('the other six new types keep the default tap action (the AI conversation about the notice)', { skip }, async () => {
  const { page } = await openPanel(NEW_ROWS, []);
  for (const row of NEW_ROWS) {
    const it = await itemOf(page, row.id);
    if (['customer_needs_you', 'not_a_customer'].includes(row.type)) assert.equal(it.onclick, 'w1OpenChatsFromNotice(' + row.id + ')', row.type);
    else assert.equal(it.onclick, 'discussNotification(' + row.id + ')', row.type);
  }
});

test('a notice text with HTML in it is shown as text, not as markup', { skip }, async () => {
  const { page } = await openPanel([{ id: 5, type: 'overdue_orders', title: '<b>x</b>', message: '<img src=x onerror=alert(1)>' }], []);
  const it = await itemOf(page, 5);
  assert.equal(it.title, '<b>x</b>');
  assert.equal(it.message, '<img src=x onerror=alert(1)>');
  assert.equal(await page.$('.notification-item img'), null);
});
