// Run with:  node --test tests/*.test.mjs
// Ads screen (build chat W1, screen 2). The Seller Ads door is answered by the test: nothing leaves the test and nothing reaches Meta.
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
  const start = html.indexOf('w1-ads-screen:' + kind + ':start');
  const end = html.indexOf('w1-ads-screen:' + kind + ':end');
  assert.ok(start > 0 && end > start, 'marked block missing: ' + kind);
  return html.slice(start, end);
}
test('the new Ads screen code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const k of ['css', 'html', 'row', 'js']) files['block ' + k] = marked(html, k);
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the service worker cache name is at least v67 and the old Reports row and the Sales row are untouched', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 67);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('<div class="settings-row" onclick="openReportsPanel()">'));
  assert.ok(html.includes('onclick="openSalesScreen()"'));
  assert.ok(html.includes('onclick="openAdsScreen()"'));
});

// ---- Browser tests ----
const obj = (o) => Object.assign({ level: 'campaign', campaignId: null, status: 'ACTIVE', dailyBudget: 30, lifetimeBudget: false }, o);
const OVERVIEW = {
  ok: true, currency: 'CUR', dailyCap: 100, totalActiveDailyBudget: 50, activeWithUnknownBudget: 0,
  objects: [
    obj({ id: 'c1', name: 'Campaign A' }),
    obj({ id: 'a1', name: 'Adset A1', level: 'adset', campaignId: 'c1', dailyBudget: null }),
    obj({ id: 'c2', name: 'Campaign B', status: 'PAUSED', dailyBudget: 20 }),
    obj({ id: 'c3', name: 'Campaign C', dailyBudget: null }),
    obj({ id: 'c4', name: 'Campaign D', dailyBudget: null, lifetimeBudget: true })
  ]
};
const PREPARED = (extra) => Object.assign({ ok: true, needsConfirm: true, confirmToken: 'tok-1', expiresAt: new Date(Date.now() + 300000).toISOString(), preview: { summary: 'Pause "Campaign A" (campaign). Total daily budget of your active ads: 50.00 CUR now, 20.00 CUR after.', totals: { before: 50, after: 20, cap: 100, currency: 'CUR' } } }, extra || {});

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

// `answer(body)` returns { status, json } for each call to the ads door.
async function openScreen(answer, calls, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-ads$/.test(u)) {
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
// A door that answers the overview and a prepared change, and records everything.
function standard(extra) {
  return (body) => {
    if (extra) { const e = extra(body); if (e) return e; }
    if (body.action === 'overview') return { json: OVERVIEW };
    if (body.action === 'prepare') return { json: PREPARED() };
    if (body.action === 'confirm') return { json: { ok: true, applied: 'pause', verified: true, currency: 'CUR' } };
    if (body.action === 'report') return { json: { ok: true, range: body.range, rows: [{ name: 'Campaign A', spend: 12.5, impressions: 1000, clicks: 40, ctr: 4, conversations: 3 }] } };
    return { json: { ok: false, code: 'bad_action', message: 'x' } };
  };
}
const open = async (page) => { await page.click('#ax-menu-row'); await page.waitForSelector('#ax-summary, .ax-status'); };
const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
const actionsOf = (calls) => calls.map((c) => c.action);

test('opening the screen asks only for the overview with the login token (no seller id) and shows the totals, the cap and the list', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openScreen(standard(), calls, 'test-token');
  await open(page);
  assert.deepEqual(calls, [{ token: 'test-token', action: 'overview' }]);
  assert.match(await text(page, '#ax-summary'), /Total daily budget of your running ads: 50\.00 CUR\. Your daily limit: 100\.00 CUR/);
  const content = await text(page, '#ax-content');
  assert.match(content, /Campaign A/);
  assert.match(content, /Adset A1/);
  assert.match(content, /Budget: 30\.00 CUR per day/);
  assert.match(content, /Budget is set on its ad sets/);
  assert.match(content, /Lifetime budget \(change it in Meta Ads Manager\)/);
  assert.deepEqual(errors, []);
  // Buttons by state: running has Pause, paused has Resume, Change budget only with an own daily budget.
  const rows = await page.$$eval('[data-ax-id]', (els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-ax-id'), [...e.querySelectorAll('.ax-actions button')].map((b) => b.textContent)])));
  assert.deepEqual(rows.c1, ['Pause', 'Change budget']);
  assert.deepEqual(rows.a1, ['Pause']);
  assert.deepEqual(rows.c2, ['Resume', 'Change budget']);
  assert.deepEqual(rows.c3, ['Pause']);
  assert.deepEqual(rows.c4, ['Pause']);
});

test('no daily limit is said plainly', { skip }, async () => {
  const { page } = await openScreen(standard((b) => b.action === 'overview' ? { json: Object.assign({}, OVERVIEW, { dailyCap: null }) } : null), [], 'test-token');
  await open(page);
  assert.match(await text(page, '#ax-summary'), /No daily limit set/);
});

test('a missing login is refused: the door is not called', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard(), calls, null);
  await open(page);
  assert.equal(calls.length, 0);
  assert.equal(await text(page, '#ax-content'), 'Please sign out and sign in again, then try once more.');
});

test('"not connected" is shown when the ads account is not connected, and the list is hidden', { skip }, async () => {
  const { page } = await openScreen(() => ({ json: { ok: false, code: 'ads_not_connected', message: 'x' } }), [], 'test-token');
  await open(page);
  assert.equal(await text(page, '#ax-content'), 'Your ads account is not connected yet.');
  assert.equal(await page.$('[data-ax-id]'), null);
  assert.equal(await page.$('#ax-limit-card'), null);
});

test('door and Meta problems are shown in plain words; a Try again button repeats the same read', { skip }, async () => {
  const cases = [
    [{ status: 503, json: {} }, 'This screen is not available yet. Please try again later.'],
    [{ json: { ok: false, code: 'relogin', message: 'x' } }, 'Please sign out and sign in again, then try once more.'],
    [{ json: { ok: false, code: 'failed', message: 'x' } }, 'Something went wrong. Check your ads in Meta Ads Manager before you try again.']
  ];
  for (const [reply, expected] of cases) {
    const { page } = await openScreen(() => reply, [], 'test-token');
    await open(page);
    assert.equal(await text(page, '#ax-content').then((t) => t.replace('Try again', '')), expected);
    await page.close();
  }
  const calls = [];
  const { page } = await openScreen(() => ({ json: { ok: false, code: 'meta_unavailable', message: 'x' } }), calls, 'test-token');
  await open(page);
  assert.match(await text(page, '#ax-content'), /Meta did not answer\. Nothing was changed\./);
  await page.click('#ax-retry');
  await page.waitForFunction(() => document.querySelector('#ax-retry'));
  assert.deepEqual(actionsOf(calls), ['overview', 'overview']);
});

test('pause: prepare shows the confirm panel, nothing is written until Confirm, Cancel sends nothing', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard(), calls, 'test-token');
  await open(page);
  await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(calls[1], { token: 'test-token', action: 'prepare', change: { type: 'pause', targetId: 'c1' } });
  assert.match(await text(page, '#ax-confirm-summary'), /Pause "Campaign A" \(campaign\)\. Total daily budget of your active ads: 50\.00 CUR now, 20\.00 CUR after\./);
  assert.match(await text(page, '#ax-confirm'), /Nothing changes until you press Confirm\./);
  assert.match(await text(page, '#ax-confirm-count'), /^[0-5]:\d\d left to confirm$/);
  assert.deepEqual(actionsOf(calls), ['overview', 'prepare']);
  await page.click('#ax-confirm-cancel');
  assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
  await page.waitForTimeout(200);
  assert.deepEqual(actionsOf(calls), ['overview', 'prepare'], 'cancel sends nothing');
});

test('Confirm calls confirm once with the token, works only once, then shows Done and reloads the overview', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard(), calls, 'test-token');
  await open(page);
  await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  await page.evaluate(() => { const b = document.getElementById('ax-confirm-go'); b.click(); b.click(); axPressConfirm(); });
  await page.waitForFunction(() => /Done\./.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || ''));
  assert.deepEqual(actionsOf(calls), ['overview', 'prepare', 'confirm', 'overview']);
  assert.deepEqual(calls[2], { token: 'test-token', action: 'confirm', confirmToken: 'tok-1' });
  assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
});

test('verified false says it was sent but not yet seen in Meta', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard((b) => b.action === 'confirm' ? { json: { ok: true, applied: 'pause', verified: false, currency: 'CUR' } } : null), calls, 'test-token');
  await open(page);
  await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await page.click('#ax-confirm-go');
  await page.waitForFunction(() => /not yet seen in Meta/.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || ''));
});

test('confirm refusals: unconfirmed has no retry, expired and used tokens close the panel and reload', { skip }, async () => {
  const cases = [
    ['unconfirmed', /Meta did not confirm\. Check the ad in Meta Ads Manager before you try again\./, false],
    ['meta_refused', /Meta says no/, false],
    ['already_used', /Already used/, true],
    ['changed_since_preview', /Look at the change again\./, true],
    ['not_saved', /The limit could not be saved\. Nothing was changed\./, false],
    ['failed', /Something went wrong\. Check your ads in Meta Ads Manager/, false]
  ];
  for (const [code, pattern, reloads] of cases) {
    const calls = [];
    const message = code === 'meta_refused' ? 'Meta says no' : code === 'already_used' ? 'Already used' : 'x';
    const { page } = await openScreen(standard((b) => b.action === 'confirm' ? { json: { ok: false, code, message } } : null), calls, 'test-token');
    await open(page);
    await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
    await page.click('#ax-confirm-go');
    await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('[data-ax-msg="top"]') ? document.querySelector('[data-ax-msg="top"]').textContent : ''), pattern.source);
    assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none', code);
    assert.equal(await page.$('#ax-retry'), null, 'no retry for ' + code);
    assert.equal(actionsOf(calls).filter((a) => a === 'confirm').length, 1, 'confirm is never repeated: ' + code);
    assert.equal(actionsOf(calls).filter((a) => a === 'overview').length, reloads ? 2 : 1, code);
    await page.close();
  }
});

test('the confirm button is disabled when the five minutes run out', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard((b) => b.action === 'prepare' ? { json: PREPARED({ expiresAt: new Date(Date.now() + 1200).toISOString() }) } : null), calls, 'test-token');
  await open(page);
  await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await page.waitForFunction(() => document.getElementById('ax-confirm-go').disabled);
  assert.equal(await text(page, '#ax-confirm-count'), 'This ran out of time. Look at the change again.');
  await page.evaluate(() => axPressConfirm());
  await page.waitForTimeout(200);
  assert.equal(actionsOf(calls).includes('confirm'), false);
});

test('change budget: a typed number (comma or dot) goes to prepare as a number; a bad number is refused on the screen', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard(), calls, 'test-token');
  await open(page);
  await page.click('[data-ax-id="c1"] .ax-change-budget');
  await page.fill('[data-ax-id="c1"] .ax-budget-input', 'abc');
  await page.click('[data-ax-id="c1"] .ax-review');
  assert.equal(await text(page, '[data-ax-id="c1"] [data-ax-msg]'), 'Enter a number above zero.');
  assert.deepEqual(actionsOf(calls), ['overview'], 'nothing is sent for a bad number');
  await page.fill('[data-ax-id="c1"] .ax-budget-input', '35,5');
  await page.click('[data-ax-id="c1"] .ax-review');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(calls[1], { token: 'test-token', action: 'prepare', change: { type: 'set_budget', targetId: 'c1', newBudget: 35.5 } });
  assert.deepEqual(actionsOf(calls), ['overview', 'prepare']);
});

test('change limit sends set_cap and shows the confirm panel', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard(), calls, 'test-token');
  await open(page);
  await page.fill('#ax-limit-input', '150');
  await page.click('#ax-limit-go');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(calls[1].change, { type: 'set_cap', newCap: 150 });
});

test('prepare refusals show the door message next to the button and open no confirm panel', { skip }, async () => {
  for (const [code, message] of [['over_cap', 'This would go over your limit.'], ['unbounded_budget', 'A lifetime budget is running.'], ['budget_elsewhere', 'Choose the ad set.'], ['lifetime_budget', 'Use Meta Ads Manager.'], ['no_change', 'That is already the budget.']]) {
    const { page } = await openScreen(standard((b) => b.action === 'prepare' ? { json: { ok: false, code, message } } : null), [], 'test-token');
    await open(page);
    await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
    await page.waitForFunction((m) => document.querySelector('[data-ax-id="c1"] [data-ax-msg]').textContent === m, message);
    assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none', code);
    await page.close();
  }
});

test('no_cap asks for a daily limit first and moves to the limit box', { skip }, async () => {
  const { page } = await openScreen(standard((b) => b.action === 'prepare' ? { json: { ok: false, code: 'no_cap', message: 'x' } } : null), [], 'test-token');
  await open(page);
  await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await page.waitForFunction(() => document.querySelector('#ax-limit-card [data-ax-msg]').textContent === 'Set a daily limit first');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'ax-limit-input');
});

test('a Meta outage on prepare says nothing was changed and opens no panel', { skip }, async () => {
  const { page } = await openScreen(standard((b) => b.action === 'prepare' ? { json: { ok: false, code: 'meta_unavailable', message: 'x' } } : null), [], 'test-token');
  await open(page);
  await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await page.waitForFunction(() => /Nothing was changed/.test(document.querySelector('[data-ax-id="c1"] [data-ax-msg]').textContent));
  assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
});

test('the report buttons call report with the range and fill the table; a refusal is shown in plain words', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard(), calls, 'test-token');
  await open(page);
  await page.click('[data-ax-range="last_7d"]');
  await page.waitForSelector('.ax-table');
  assert.deepEqual(calls[1], { token: 'test-token', action: 'report', range: 'last_7d' });
  const t = await text(page, '#ax-report');
  assert.match(t, /Campaign A/);
  assert.match(t, /12\.50 CUR/);
  assert.match(t, /Click rate/);
  const down = await openScreen(standard((b) => b.action === 'report' ? { json: { ok: false, code: 'meta_unavailable', message: 'x' } } : null), [], 'test-token');
  await open(down.page);
  await down.page.click('[data-ax-range="today"]');
  await down.page.waitForSelector('#ax-report-retry');
  assert.match(await text(down.page, '#ax-report'), /Meta did not answer\. Nothing was changed\./);
});

test('the screen never writes by itself: only overview, report and prepare are sent until Confirm is pressed', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(standard(), calls, 'test-token');
  await open(page);
  await page.click('[data-ax-range="today"]');
  await page.waitForSelector('.ax-table');
  await page.click('[data-ax-id="c2"] .ax-actions button:first-child');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  await page.waitForTimeout(700);
  assert.ok(actionsOf(calls).every((a) => ['overview', 'report', 'prepare'].includes(a)));
  assert.equal(calls.some((c) => 'sellerId' in c), false);
});

test('the back arrow closes the panel, forgets the token and returns to Settings', { skip }, async () => {
  const { page } = await openScreen(standard(), [], 'test-token');
  await open(page);
  await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  await page.evaluate(() => closeAdsScreen());
  assert.equal(await page.evaluate(() => AX_state.pending), null);
  assert.equal(await page.$eval('#ax-tab-content', (e) => e.style.display), 'none');
  assert.equal(await page.$eval('#settings-tab-content', (e) => e.style.display), 'block');
});
