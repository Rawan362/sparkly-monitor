// Run with:  node --test tests/*.test.mjs
// Alert check screen (build chat W1). The Seller Alerts door is answered by the test: nothing leaves the test.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). Old code is not scanned. ----
function marked(html, kind) {
  const start = html.indexOf('w1-alert-check:' + kind + ':start');
  const end = html.indexOf('w1-alert-check:' + kind + ':end');
  assert.ok(start > 0 && end > start, 'marked block missing: ' + kind);
  return html.slice(start, end);
}
test('the new Alert check code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const k of ['css', 'html', 'row', 'js']) files['block ' + k] = marked(html, k);
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is at least v69, the new row is added and the old Alerts row is untouched', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 69);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('<div class="settings-row" onclick="openAlertsPanel()">'));
  assert.ok(html.includes('window.openAlertsPanel = async function()'));
  assert.ok(html.includes('onclick="openAlertCheck()"'));
});

// ---- Browser tests ----
const scan = (o) => Object.assign({ overdueOrders: 0, silentCustomers: 0, codNotCollected: { count: 0, total: 0 }, salesIntelligence: null }, o);
const answer = (o, currency) => ({ json: { ok: true, action: 'scan', currency: currency === undefined ? 'CUR' : currency, scan: scan(o) } });

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

async function openScreen(reply, calls, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-alerts$/.test(u)) {
      calls.push(JSON.parse(route.request().postData() || '{}'));
      const a = reply();
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
  await page.click('#ac-menu-row');
  return { page, errors };
}
const result = (page) => page.$eval('#ac-result', (e) => e.textContent);
const check = async (page) => { await page.click('#ac-go'); await page.waitForFunction(() => !/^Checking/.test(document.getElementById('ac-result').textContent) && document.getElementById('ac-result').textContent !== ''); };

test('nothing is asked until Check now is pressed; then only scan is sent, with the login token and no seller id', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openScreen(() => answer({}), calls, 'test-token');
  await page.waitForTimeout(300);
  assert.equal(calls.length, 0);
  await check(page);
  assert.deepEqual(calls, [{ token: 'test-token', action: 'scan' }]);
  assert.equal(await result(page), 'All good, no alerts right now');
  assert.deepEqual(errors, []);
});

test('the counts, the cash on delivery sum with the seller currency, and the learning line are shown', { skip }, async () => {
  const { page } = await openScreen(() => answer({ overdueOrders: 3, silentCustomers: 2, codNotCollected: { count: 2, total: 1500.5 }, salesIntelligence: { conversations: 42, closeRatePercent: 31 } }), [], 'test-token');
  await check(page);
  const t = await result(page);
  assert.match(t, /Overdue orders3/);
  assert.match(t, /Silent customers2/);
  assert.match(t, /Cash on delivery not collected2 \(1,500\.5 CUR\)/);
  assert.match(t, /The AI learned from 42 conversations/);
  assert.match(t, /Close rate31%/);
  assert.ok(!/All good/.test(t));
});

test('a count at the door limit is shown as "or more"', { skip }, async () => {
  const { page } = await openScreen(() => answer({ overdueOrders: 10, silentCustomers: 5, codNotCollected: { count: 5, total: 90 } }), [], 'test-token');
  await check(page);
  const t = await result(page);
  assert.match(t, /Overdue orders10 or more/);
  assert.match(t, /Silent customers5 or more/);
  assert.match(t, /5 or more \(90 CUR\)/);
});

test('with no money label only the number is shown, and the learning line is hidden when there is none', { skip }, async () => {
  const { page } = await openScreen(() => answer({ codNotCollected: { count: 1, total: 40 } }, null), [], 'test-token');
  await check(page);
  const t = await result(page);
  assert.match(t, /Cash on delivery not collected1 \(40\)/);
  assert.ok(!/learned|Close rate|CUR|undefined|null|NaN/.test(t));
});

test('only the lines with something to show appear; a learning line alone does not hide the all-good message', { skip }, async () => {
  const { page } = await openScreen(() => answer({ salesIntelligence: { conversations: 9, closeRatePercent: 12 } }), [], 'test-token');
  await check(page);
  const t = await result(page);
  assert.match(t, /All good, no alerts right now/);
  assert.match(t, /The AI learned from 9 conversations/);
  assert.ok(!/Overdue|Silent|Cash on delivery/.test(t));
});

test('a missing login is refused: the door is not called', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(() => answer({}), calls, null);
  await check(page);
  assert.equal(calls.length, 0);
  assert.equal(await result(page), 'Please sign out and sign in again, then try once more.');
});

test('door problems are shown in plain words', { skip }, async () => {
  const cases = [
    [{ status: 503, json: {} }, 'Not available yet. Please try again later.'],
    [{ json: { ok: false, error: 'not_logged_in', message: 'Please log in again.' } }, 'Please sign out and sign in again, then try once more.'],
    [{ json: { ok: false, error: 'read_failed', message: 'We could not read your numbers right now. Please try again.' } }, 'We could not read your numbers right now. Please try again.'],
    [{ json: { ok: false, error: 'no_seller', message: 'No seller account was found for this login.' } }, 'No seller account was found for this login.'],
    [{ json: { ok: false, error: 'strange', message: 'x' } }, 'We could not read your numbers right now. Please try again.']
  ];
  for (const [reply, expected] of cases) {
    const { page } = await openScreen(() => reply, [], 'test-token');
    await check(page);
    assert.equal(await result(page), expected);
    await page.close();
  }
});

test('the button is disabled while checking, so a double press sends one request', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(() => answer({}), calls, 'test-token');
  await page.evaluate(() => { const b = document.getElementById('ac-go'); b.click(); b.click(); acCheckNow(); });
  await page.waitForFunction(() => document.getElementById('ac-result').textContent === 'All good, no alerts right now');
  assert.equal(calls.length, 1);
});

test('the back arrow returns to Settings', { skip }, async () => {
  const { page } = await openScreen(() => answer({}), [], 'test-token');
  await page.click('#ac-header-row button');
  assert.equal(await page.$eval('#ac-tab-content', (e) => e.style.display), 'none');
  assert.equal(await page.$eval('#settings-tab-content', (e) => e.style.display), 'block');
});
