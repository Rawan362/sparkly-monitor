// Run with:  node --test tests/*.test.mjs
// Sales and stock screen (build chat W1, screen 1). The Seller Reports door is answered by the test: nothing leaves the test.
// If Playwright is not installed (it is installed in CI), the browser tests are skipped. The text scan and the cache name check always run.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). Old code is not scanned. ----
const MARKED = ['css', 'html', 'row', 'js'];
function marked(html, kind) {
  const start = html.indexOf('w1-sales-screen:' + kind + ':start');
  const end = html.indexOf('w1-sales-screen:' + kind + ':end');
  assert.ok(start > 0 && end > start, 'marked block missing: ' + kind);
  return html.slice(start, end);
}
test('the new screen code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const k of MARKED) files['block ' + k] = marked(html, k);
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the service worker cache name is bumped for this page change', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const n = Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]);
  assert.ok(n >= 66, 'cache name must be at least v66');
});

test('the screen is added as a new menu row and the existing Reports row is untouched', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('<div class="settings-row" onclick="openReportsPanel()">'));
  assert.ok(html.includes('onclick="openSalesScreen()"'));
  assert.ok(html.includes('window.openReportsPanel = async function()'));
});

// ---- Browser tests ----
const ORDERS = {
  ok: true, action: 'orders', currency: 'CUR', total: 20, revenue: 2000.5, more: 5,
  shown: [
    { id: 1, phone: '+10000000001', product: 'Lamp', total: 50, status: 'PENDING', codCollected: null, createdAt: '2026-01-02T10:00:00Z', bumpAccepted: false, upsellAccepted: false },
    { id: 2, phone: null, product: null, total: 10, status: 'DELIVERED', codCollected: false, createdAt: null, bumpAccepted: true, upsellAccepted: false }
  ]
};
const ANSWERS = {
  weekly: { ok: true, action: 'weekly', currency: 'CUR', date: '2026-01-05', silentCustomers: 4, learning: { conversations: 12, closeRatePercent: 30 },
    weekly: { orders: 7, revenue: 1200, revenueChangePercent: -10, delivered: 3, pending: 2, bumpAccepted: 1, bumpRevenue: 5, upsellAccepted: 0, upsellRevenue: 0, topProduct: { name: 'Lamp', orders: 4 } } },
  orders: ORDERS,
  analytics: { ok: true, action: 'analytics', currency: null, analytics: { total: 9, today: 1, pending: 2, shipped: 3, delivered: 3, cancelled: 1, codPending: 1, revenue: 900, todayRevenue: 40, averageOrder: 100, topProducts: [{ name: 'Lamp', orders: 5 }], bump: { offered: 4, accepted: 2, percent: 50, revenue: 20 }, upsell: { offered: 0, accepted: 0, percent: 0, revenue: 0 } } },
  stock: { ok: true, action: 'stock', currency: null, stock: { activeProducts: 3, trackedProducts: 2, items: [{ name: 'Lamp', stock: 2, lowThreshold: 5, low: true }, { name: 'Desk', stock: 40, lowThreshold: 5, low: false }] } },
  customers: { ok: true, action: 'customers', currency: null, customers: { total: 100, wholesale: 5, vip: 7, warm: 20, silent: 11 } }
};

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

// `answer(body)` returns { status, json } for each call to the reports door. `token` is what the login check hands the screen.
async function openScreen(answer, calls, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-reports$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = answer(body);
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
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
      await page.evaluate((tok) => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => tok;
        document.getElementById('settings-tab-content').style.display = 'block';
      }, token);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const okAnswer = (body) => ({ json: ANSWERS[body.action] });
const content = (page) => page.$eval('#sr-content', (e) => e.textContent);

test('opening the screen asks the door for the weekly report with the login token and shows plain numbers with the seller currency', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openScreen(okAnswer, calls, 'test-token');
  await page.click('#sr-menu-row');
  await page.waitForSelector('.report-stat-card');
  assert.deepEqual(calls.map((c) => [c.action, c.token]), [['weekly', 'test-token']]);
  const text = await content(page);
  assert.match(text, /1,200 CUR/);
  assert.match(text, /-10%/);
  assert.match(text, /Lamp \(4\)/);
  assert.match(text, /Customers silent for 14 days or more/);
  assert.deepEqual(errors, []);
});

test('a login that is missing is refused: the door is not called and the seller is told to sign in again', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(okAnswer, calls, null);
  await page.click('#sr-menu-row');
  await page.waitForSelector('.sr-status.error');
  assert.equal(calls.length, 0);
  assert.equal(await content(page), 'Please sign out and sign in again, then try once more.');
});

test('a door refusal is shown in plain words, never as raw codes', { skip }, async () => {
  const cases = [
    [{ status: 200, json: { ok: false, error: 'not_logged_in', message: 'Please log in again.' } }, 'Please sign out and sign in again, then try once more.'],
    [{ status: 503, json: {} }, 'This screen is not available yet. Please try again later.'],
    [{ status: 200, json: { ok: false, error: 'read_failed', message: 'We could not read your numbers right now. Please try again.' } }, 'We could not read your numbers right now. Please try again.'],
    [{ status: 200, json: { ok: false, error: 'bad_filter', message: 'One of the filters is not valid.' } }, 'One of the filters is not valid.'],
    [{ status: 200, json: { ok: false, error: 'weird' } }, 'We could not read your numbers right now. Please try again.']
  ];
  for (const [reply, expected] of cases) {
    const { page } = await openScreen(() => reply, [], 'test-token');
    await page.click('#sr-menu-row');
    await page.waitForSelector('.sr-status.error');
    assert.equal(await content(page), expected);
    await page.close();
  }
});

test('every tab calls its own read-only action and shows its numbers; no money label is invented when the seller has none', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(okAnswer, calls, 'test-token');
  await page.click('#sr-menu-row');
  await page.waitForSelector('.report-stat-card');
  for (const tab of ['orders', 'analytics', 'stock', 'customers']) {
    await page.click('#sr-tabs button[data-sr-tab="' + tab + '"]');
    await page.waitForFunction((t) => document.querySelector('#sr-tabs button.on').dataset.srTab === t && !!document.querySelector('#sr-refresh'), tab);
  }
  assert.deepEqual(calls.map((c) => c.action), ['weekly', 'orders', 'analytics', 'stock', 'customers']);
  const text = await content(page);
  assert.match(text, /Silent 14\+ days/);
  await page.click('#sr-tabs button[data-sr-tab="analytics"]');
  await page.waitForSelector('#sr-refresh');
  const analytics = await content(page);
  assert.match(analytics, /Average order/);
  assert.ok(!/undefined|null|NaN/.test(analytics));
  assert.ok(!/ CUR/.test(analytics));
  await page.click('#sr-tabs button[data-sr-tab="stock"]');
  await page.waitForSelector('#sr-refresh');
  assert.match(await content(page), /Low stock/);
});

test('order filters are sent as the door expects, the list shows how many more are not shown', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(okAnswer, calls, 'test-token');
  await page.click('#sr-menu-row');
  await page.waitForSelector('.report-stat-card');
  await page.click('#sr-tabs button[data-sr-tab="orders"]');
  await page.waitForSelector('#sr-f-apply');
  assert.match(await content(page), /5 more not shown/);
  assert.match(await content(page), /Lamp/);
  await page.selectOption('#sr-f-status', 'PENDING');
  await page.selectOption('#sr-f-date', 'week');
  await page.check('#sr-f-cod');
  await page.click('#sr-f-apply');
  await page.waitForFunction(() => document.querySelectorAll('.sr-order').length === 2 && document.getElementById('sr-f-status').value === 'PENDING');
  const last = calls[calls.length - 1];
  assert.equal(last.action, 'orders');
  assert.equal(last.status, 'PENDING');
  assert.equal(last.dateRange, 'week');
  assert.equal(last.codPending, true);
});

test('the screen only reads: every call is one of the five read actions and nothing else is posted', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(okAnswer, calls, 'test-token');
  await page.click('#sr-menu-row');
  await page.waitForSelector('.report-stat-card');
  for (const tab of ['orders', 'analytics', 'stock', 'customers']) {
    await page.click('#sr-tabs button[data-sr-tab="' + tab + '"]');
    await page.waitForSelector('#sr-refresh');
  }
  const allowed = ['weekly', 'orders', 'analytics', 'stock', 'customers'];
  assert.ok(calls.every((c) => allowed.includes(c.action)));
  const buttons = await page.$$eval('#sr-tab-content button', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(!buttons.some((b) => /delete|save|send|pause|confirm/i.test(b)));
});

test('the back arrow returns to Settings', { skip }, async () => {
  const { page } = await openScreen(okAnswer, [], 'test-token');
  await page.click('#sr-menu-row');
  await page.waitForSelector('.report-stat-card');
  await page.click('#sr-header-row button');
  assert.equal(await page.$eval('#sr-tab-content', (e) => e.style.display), 'none');
  assert.equal(await page.$eval('#settings-tab-content', (e) => e.style.display), 'block');
});
