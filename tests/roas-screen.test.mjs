// Run with:  node --test tests/*.test.mjs
// Real profit (ROAS) section of the Ads screen (build chat W1). The Seller Ads door is answered by the test: nothing leaves the test.
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
  const start = html.indexOf('w1-roas:' + kind + ':start');
  const end = html.indexOf('w1-roas:' + kind + ':end');
  assert.ok(start > 0 && end > start, 'marked block missing: ' + kind);
  return html.slice(start, end);
}
test('the new Real profit code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), css: marked(html, 'css'), js: marked(html, 'js') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is at least v71 and the Ads screen hook is one line', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 71);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(html.split('\n').filter((l) => l.includes("box.appendChild(w1RoasSection())")).length, 1);
});

// ---- Browser tests ----
const OVERVIEW = { ok: true, currency: 'CUR', dailyCap: 100, totalActiveDailyBudget: 50, activeWithUnknownBudget: 0, objects: [{ id: 'c1', name: 'Campaign A', level: 'campaign', campaignId: null, status: 'ACTIVE', dailyBudget: 30, lifetimeBudget: false }] };
const GOOD = (o) => Object.assign({ ok: true, label: 'Last 7 days', currency: 'CUR', revenue: 1200, knownCosts: 400, adSpend: 300, netProfit: 500, trueRoas: 2.345, standardRoas: 4, orders: 10, ordersWithUnknownCost: 0, ordersWithPreciseCost: 10, mappedToProduct: false }, o || {});

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

// `roasAnswer(body)` answers the roas action; the overview is always answered.
async function openAds(roasAnswer, calls, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-ads$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = body.action === 'overview' ? { json: OVERVIEW } : roasAnswer(body);
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
  await page.click('#ax-menu-row');
  if (token) await page.waitForSelector('#rs-go'); else await page.waitForSelector('#ax-content .ax-status');
  return { page, errors };
}
const roasCalls = (calls) => calls.filter((c) => c.action === 'roas');
const result = (page) => page.$eval('#rs-result', (e) => e.textContent);
const run = async (page) => { await page.click('#rs-go'); await page.waitForFunction(() => !/^Working it out/.test(document.getElementById('rs-result').textContent) && document.getElementById('rs-result').textContent !== ''); };

test('the section sits on the Ads screen; the Ads screen still works (overview) and nothing is asked until the button is pressed', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openAds(() => ({ json: GOOD() }), calls, 'test-token');
  assert.deepEqual(calls.map((c) => c.action), ['overview']);
  assert.match(await page.$eval('#ax-summary', (e) => e.textContent), /Total daily budget of your running ads: 50\.00 CUR/);
  assert.equal(await page.$eval('#rs-range', (s) => s.value), 'last_7d');
  assert.deepEqual(errors, []);
});

test('Show real profit sends the roas action with the period and the login token, never a seller id', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(() => ({ json: GOOD() }), calls, 'test-token');
  await run(page);
  assert.deepEqual(roasCalls(calls), [{ token: 'test-token', action: 'roas', roas: { range: 'last_7d' } }]);
  assert.ok(calls.every((c) => !('sellerId' in c)));
  await page.selectOption('#rs-range', 'last_90d');
  await run(page);
  assert.deepEqual(roasCalls(calls)[1].roas, { range: 'last_90d' });
});

test('the card shows revenue, costs, ad spend, net profit and both ratios with the seller currency word', { skip }, async () => {
  const { page } = await openAds(() => ({ json: GOOD() }), [], 'test-token');
  await run(page);
  const t = await page.$eval('#rs-card', (e) => e.textContent);
  assert.match(t, /Real profit - Last 7 days/);
  assert.match(t, /Revenue1,200\.00 CUR/);
  assert.match(t, /Known product costs400\.00 CUR/);
  assert.match(t, /Ad spend300\.00 CUR/);
  assert.match(t, /Net profit500\.00 CUR/);
  assert.match(t, /True ROAS \(after real costs\)2\.35x/);
  assert.match(t, /Standard ROAS \(like Meta shows, before costs\)4\.00x/);
  assert.equal(await page.$eval('#rs-net .rs-net', (e) => e.classList.contains('positive')), true);
});

test('no currency word is invented when the door sends none; a loss is marked as negative', { skip }, async () => {
  const { page } = await openAds(() => ({ json: GOOD({ currency: null, netProfit: -50, trueRoas: null }) }), [], 'test-token');
  await run(page);
  const t = await page.$eval('#rs-card', (e) => e.textContent);
  assert.ok(!/CUR/.test(t) && !/undefined|null|NaN/.test(t));
  assert.match(t, /Net profit-50\.00/);
  assert.match(t, /True ROAS \(after real costs\)-/);
  assert.equal(await page.$eval('#rs-net .rs-net', (e) => e.classList.contains('negative')), true);
});

test('the notes appear only when they apply', { skip }, async () => {
  const a = await openAds(() => ({ json: GOOD({ orders: 10, ordersWithUnknownCost: 3, ordersWithPreciseCost: 4, mappedToProduct: true, adName: 'Spring ad' }) }), [], 'test-token');
  await run(a.page);
  const t = await result(a.page);
  assert.match(t, /3 of 10 orders have no cost price set, so this is an approximation\./);
  assert.match(t, /4 of these orders used the exact items; the rest used a simpler estimate\./);
  assert.match(t, /This matches orders to the product the ad is linked to\. It is not exact per-click tracking\./);
  assert.match(await a.page.$eval('#rs-card', (e) => e.textContent), /Spring ad/);
  const b = await openAds(() => ({ json: GOOD() }), [], 'test-token');
  await run(b.page);
  const u = await result(b.page);
  assert.ok(!/approximation|simpler estimate|per-click/.test(u));
});

test('one ad: the typed name goes as nameHint with level ad; the whole account sends neither', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(() => ({ json: GOOD() }), calls, 'test-token');
  await page.fill('#rs-ad', '  Spring ad ');
  await run(page);
  assert.deepEqual(roasCalls(calls)[0].roas, { range: 'last_7d', nameHint: 'Spring ad', level: 'ad' });
  await page.fill('#rs-ad', '');
  await run(page);
  assert.deepEqual(roasCalls(calls)[1].roas, { range: 'last_7d' });
});

test('a custom range needs two valid dates; nothing is sent until they are right', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(() => ({ json: GOOD() }), calls, 'test-token');
  await page.selectOption('#rs-range', 'custom');
  assert.equal(await page.$eval('#rs-dates', (e) => e.style.display), 'flex');
  await page.click('#rs-go');
  assert.equal(await result(page), 'Choose a period, or two dates.');
  await page.fill('#rs-since', '2026-02-10');
  await page.fill('#rs-until', '2026-02-01');
  await page.click('#rs-go');
  assert.equal(await result(page), 'Choose a period, or two dates.');
  assert.equal(roasCalls(calls).length, 0);
  await page.fill('#rs-until', '2026-02-20');
  await run(page);
  assert.deepEqual(roasCalls(calls)[0].roas, { range: 'custom', since: '2026-02-10', until: '2026-02-20' });
});

test('door refusals are shown in plain words', { skip }, async () => {
  const cases = [
    [{ code: 'ads_not_connected' }, 'Your ads account is not connected yet.'],
    [{ code: 'bad_range' }, 'Choose a period, or two dates.'],
    [{ code: 'not_found' }, 'We could not find that ad.'],
    [{ code: 'not_an_ad' }, 'Real profit works for one ad at a time. Pick an ad, not a campaign.'],
    [{ code: 'not_linked', adName: 'Spring ad' }, 'Spring ad is not linked to a product yet, so real profit cannot be worked out for it.'],
    [{ code: 'no_spend' }, 'No ad spend in this period.'],
    [{ code: 'no_orders' }, 'No completed orders in this period to work out real profit.'],
    [{ code: 'relogin' }, 'Please sign out and sign in again, then try once more.'],
    [{ code: 'something_new' }, 'Something went wrong. Please try again.']
  ];
  for (const [json, expected] of cases) {
    const { page } = await openAds(() => ({ json: Object.assign({ ok: false, message: 'raw message' }, json) }), [], 'test-token');
    await run(page);
    assert.equal(await result(page), expected, json.code);
    await page.close();
  }
  const down = await openAds(() => ({ status: 503, json: {} }), [], 'test-token');
  await run(down.page);
  assert.equal(await result(down.page), 'This screen is not available yet. Please try again later.');
});

test('a read problem offers Try again, which repeats the same request', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(() => ({ json: { ok: false, code: 'meta_unavailable', message: 'x' } }), calls, 'test-token');
  await run(page);
  assert.match(await result(page), /We could not read your data\. Try again in a moment\./);
  await page.click('#rs-retry');
  await page.waitForFunction(() => document.getElementById('rs-retry'));
  assert.equal(roasCalls(calls).length, 2);
  assert.deepEqual(roasCalls(calls)[0], roasCalls(calls)[1]);
});

test('an ambiguous ad shows the names as buttons; a name runs again with that name', { skip }, async () => {
  const calls = [];
  const reply = (b) => b.roas.nameHint === 'Spring' ? { json: { ok: false, code: 'ambiguous', message: 'x', names: ['Spring ad 1', 'Spring ad 2'] } } : { json: GOOD({ adName: b.roas.nameHint }) };
  const { page } = await openAds(reply, calls, 'test-token');
  await page.fill('#rs-ad', 'Spring');
  await run(page);
  assert.match(await result(page), /More than one ad matches: Spring ad 1, Spring ad 2\. Pick one\./);
  assert.deepEqual(await page.$$eval('.rs-name', (b) => b.map((x) => x.textContent)), ['Spring ad 1', 'Spring ad 2']);
  await page.click('.rs-name:nth-child(2)');
  await page.waitForSelector('#rs-card');
  assert.deepEqual(roasCalls(calls)[1].roas, { range: 'last_7d', nameHint: 'Spring ad 2', level: 'ad' });
  assert.equal(await page.$eval('#rs-ad', (e) => e.value), 'Spring ad 2');
});

test('a missing login is refused: the Ads screen asks to sign in again and no roas request is sent', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(() => ({ json: GOOD() }), calls, null);
  assert.equal(await page.$eval('#ax-content', (e) => e.textContent), 'Please sign out and sign in again, then try once more.');
  assert.equal(roasCalls(calls).length, 0);
  // Even when the section is asked directly, no door call is made without a login.
  await page.evaluate(() => { document.getElementById('ax-content').appendChild(w1RoasSection()); });
  await page.click('#rs-go');
  await page.waitForFunction(() => /sign out and sign in again/.test(document.getElementById('rs-result').textContent));
  assert.equal(calls.length, 0);
});

test('it only reads: no confirm panel opens and only the roas action is sent from this section', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(() => ({ json: GOOD() }), calls, 'test-token');
  await run(page);
  assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
  assert.deepEqual([...new Set(calls.map((c) => c.action))].sort(), ['overview', 'roas']);
  assert.equal(await page.$$eval('#rs-section button', (b) => b.filter((x) => /confirm|pause|delete|save/i.test(x.textContent)).length), 0);
});

test('a double press sends one request', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(() => ({ json: GOOD() }), calls, 'test-token');
  await page.evaluate(() => { const b = document.getElementById('rs-go'); b.click(); b.click(); });
  await page.waitForSelector('#rs-card');
  assert.equal(roasCalls(calls).length, 1);
});
