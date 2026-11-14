// Run with:  node --test tests/*.test.mjs
// Ads screen additions (build chat W1): rename, single ads, budget through an ad set, undo last change, and the Everything list.
// The Seller Ads door is answered by the test: nothing leaves the test and nothing reaches Meta.
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
  const start = html.indexOf('w1-ads-additions:' + kind + ':start');
  const end = html.indexOf('w1-ads-additions:' + kind + ':end');
  assert.ok(start > 0 && end > start, 'marked block missing: ' + kind);
  return html.slice(start, end);
}
test('the new Ads additions code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), css: marked(html, 'css'), js: marked(html, 'js') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is at least v72 and the Ads screen has exactly three one-line hooks', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 72);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const hook of ['w1AdsCardExtras(card, o)', 'w1AdsHeaderExtras(box)', 'w1AdsEverything(box)']) {
    assert.equal(html.split('\n').filter((l) => l.includes("typeof " + hook.split('(')[0] + " === 'function'")).length, 1, hook);
  }
});

// ---- Browser tests ----
const obj = (o) => Object.assign({ level: 'campaign', campaignId: null, status: 'ACTIVE', dailyBudget: 30, lifetimeBudget: false }, o);
const OVERVIEW = {
  ok: true, currency: 'CUR', dailyCap: 100, totalActiveDailyBudget: 50, activeWithUnknownBudget: 0,
  objects: [
    obj({ id: 'c1', name: 'Campaign A' }),
    obj({ id: 's1', name: 'Set A1', level: 'adset', campaignId: 'c1', dailyBudget: null }),
    obj({ id: 'c2', name: 'Campaign B', dailyBudget: null }),
    obj({ id: 's2', name: 'Set B1', level: 'adset', campaignId: 'c2', dailyBudget: 10 }),
    obj({ id: 's3', name: 'Set B2', level: 'adset', campaignId: 'c2', dailyBudget: 12 }),
    obj({ id: 'c3', name: 'Campaign C', dailyBudget: null }),
    obj({ id: 's4', name: 'Set C1', level: 'adset', campaignId: 'c3', dailyBudget: 9 }),
    obj({ id: 'c4', name: 'Campaign D', dailyBudget: null, lifetimeBudget: true })
  ]
};
const ADS = [{ id: 'ad1', name: 'Ad One', status: 'ACTIVE' }, { id: 'ad2', name: 'Ad Two', status: 'PAUSED' }];
const PREPARED = (summary) => ({ ok: true, needsConfirm: true, confirmToken: 'tok-1', expiresAt: new Date(Date.now() + 300000).toISOString(), preview: { summary: summary || 'Do it.', totals: { before: 50, after: 50, cap: 100, currency: 'CUR' } } });

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

async function openAds(answer, calls) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-ads$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = (answer && answer(body)) || defaults(body);
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
      await page.evaluate(() => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
        document.getElementById('settings-tab-content').style.display = 'block';
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  await page.click('#ax-menu-row');
  await page.waitForSelector('#ax-summary');
  return { page, errors };
}
function defaults(body) {
  if (body.action === 'overview') return { json: OVERVIEW };
  if (body.action === 'prepare') return { json: PREPARED() };
  if (body.action === 'confirm') return { json: { ok: true, applied: 'x', verified: true, currency: 'CUR' } };
  if (body.action === 'structure') {
    const s = body.structure || {};
    if (s.level === 'ad') return { json: { ok: true, level: 'ad', parent: 'Set A1', count: ADS.length, items: ADS } };
    if (s.level === 'adset') return { json: { ok: true, level: 'adset', parent: s.parentHint ? 'Campaign' : null, count: 2, items: [{ id: 's1', name: 'Set A1', status: 'ACTIVE' }, { id: 's2', name: 'Set B1', status: 'PAUSED' }] } };
    return { json: { ok: true, level: 'campaign', parent: null, count: 2, items: [{ id: 'c1', name: 'Campaign A', status: 'ACTIVE' }, { id: 'c2', name: 'Campaign B', status: 'PAUSED' }] } };
  }
  return { json: { ok: false, code: 'bad_action', message: 'x' } };
}
const actionsOf = (calls) => calls.map((c) => c.action);
const prepares = (calls) => calls.filter((c) => c.action === 'prepare').map((c) => c.change);
const card = (id) => '[data-ax-id="' + id + '"]';
const msgOf = (page, id) => page.$eval(card(id) + ' [data-ax-msg]', (e) => e.textContent);

test('the older buttons are exactly as before; the new ones sit in a second row', { skip }, async () => {
  const { page, errors } = await openAds(null, []);
  const rows = await page.$$eval('[data-ax-id]', (els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-ax-id'), [...e.querySelectorAll(':scope > .ax-actions button')].map((b) => b.textContent)])));
  assert.deepEqual(rows.c1, ['Pause', 'Change budget']);
  assert.deepEqual(rows.s1, ['Pause']);
  assert.deepEqual(rows.c2, ['Pause']);
  const more = await page.$$eval('[data-ax-id]', (els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-ax-id'), [...e.querySelectorAll(':scope > .ae-more button')].map((b) => b.textContent)])));
  assert.deepEqual(more.c1, ['Rename']);
  assert.deepEqual(more.s1, ['Rename', 'Show ads']);
  assert.deepEqual(more.c2, ['Rename', 'Change budget']);
  assert.deepEqual(more.c3, ['Rename', 'Change budget']);
  assert.deepEqual(more.c4, ['Rename'], 'a lifetime budget gets no budget button');
  assert.deepEqual(errors, []);
});

test('rename: a name of 1 to 200 characters goes to prepare with the level; nothing is written until Confirm', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  await page.click(card('c1') + ' .ae-rename');
  await page.fill(card('c1') + ' .ae-name-input', '   ');
  await page.click(card('c1') + ' .ae-review-rename');
  assert.equal(await msgOf(page, 'c1'), 'The name must have 1 to 200 characters.');
  assert.deepEqual(actionsOf(calls), ['overview'], 'a bad name sends nothing');
  await page.fill(card('c1') + ' .ae-name-input', 'New name');
  await page.click(card('c1') + ' .ae-review-rename');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'rename', targetId: 'c1', level: 'campaign', newName: 'New name' }]);
  assert.equal(actionsOf(calls).includes('confirm'), false);
  await page.click('#ax-confirm-go');
  await page.waitForFunction(() => /Done\./.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || ''));
  assert.equal(actionsOf(calls).filter((a) => a === 'confirm').length, 1);
  assert.deepEqual(calls.find((c) => c.action === 'confirm'), { token: 'test-token', action: 'confirm', confirmToken: 'tok-1' });
});

test('rename of an ad set sends level adset; the door can refuse a name in plain words', { skip }, async () => {
  const calls = [];
  const { page } = await openAds((b) => b.action === 'prepare' ? { json: { ok: false, code: 'bad_name', message: 'x' } } : null, calls);
  await page.click(card('s1') + ' .ae-rename');
  await page.fill(card('s1') + ' .ae-name-input', 'Renamed');
  await page.click(card('s1') + ' .ae-review-rename');
  await page.waitForFunction(() => document.querySelector('[data-ax-id="s1"] [data-ax-msg]').textContent !== '');
  assert.deepEqual(prepares(calls), [{ type: 'rename', targetId: 's1', level: 'adset', newName: 'Renamed' }]);
  assert.equal(await msgOf(page, 's1'), 'The name must have 1 to 200 characters.');
  assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
});

test('Show ads lists the ads of an ad set; an ad has Pause or Resume and Rename but no budget', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  await page.click(card('s1') + ' .ae-show-ads');
  await page.waitForSelector('[data-ae-ad]');
  assert.deepEqual(calls.find((c) => c.action === 'structure'), { token: 'test-token', action: 'structure', structure: { level: 'ad', parentHint: 's1' } });
  const ads = await page.$$eval('[data-ae-ad]', (els) => els.map((e) => ({ name: e.querySelector('.ax-name').firstChild.textContent, status: e.querySelector('.ax-badge').textContent, buttons: [...e.querySelectorAll('button')].map((b) => b.textContent) })));
  assert.deepEqual(ads, [{ name: 'Ad One', status: 'Running', buttons: ['Pause', 'Rename'] }, { name: 'Ad Two', status: 'Paused', buttons: ['Resume', 'Rename'] }]);
  await page.click('[data-ax-id="ad1"] .ae-more button');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'pause', targetId: 'ad1', level: 'ad' }]);
  await page.click('#ax-confirm-cancel');
  await page.click('[data-ax-id="ad2"] .ae-more button');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls)[1], { type: 'resume', targetId: 'ad2', level: 'ad' });
  await page.click('#ax-confirm-cancel');
  await page.click('[data-ax-id="ad1"] .ae-rename');
  await page.fill('[data-ax-id="ad1"] .ae-name-input', 'Ad Uno');
  await page.click('[data-ax-id="ad1"] .ae-review-rename');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls)[2], { type: 'rename', targetId: 'ad1', level: 'ad', newName: 'Ad Uno' });
});

test('the ads of an open ad set are shown again after a change reloads the screen; Hide ads closes them', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  await page.click(card('s1') + ' .ae-show-ads');
  await page.waitForSelector('[data-ae-ad]');
  await page.click('[data-ax-id="ad1"] .ae-more button');
  await page.click('#ax-confirm-go');
  await page.waitForFunction(() => /Done\./.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || '') && document.querySelectorAll('[data-ae-ad]').length === 2);
  assert.equal(await page.$eval(card('s1') + ' .ae-show-ads', (b) => b.textContent), 'Hide ads');
  await page.click(card('s1') + ' .ae-show-ads');
  assert.equal(await page.$$eval('[data-ae-ad]', (e) => e.length), 0);
});

test('a campaign with no budget of its own and one ad set: the change is prepared for the campaign and the confirm panel shows the door sentence', { skip }, async () => {
  const calls = [];
  const { page } = await openAds((b) => b.action === 'prepare' ? { json: PREPARED('Change the daily budget of "Set C1" (ad set) from 9.00 CUR to 20.00 CUR.') } : null, calls);
  await page.click(card('c3') + ' .ae-budget');
  await page.fill(card('c3') + ' .ae-budget-input', '20');
  await page.click(card('c3') + ' .ae-review-budget');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'set_budget', targetId: 'c3', newBudget: 20 }]);
  assert.match(await page.$eval('#ax-confirm-summary', (e) => e.textContent), /Set C1/);
});

test('a campaign with several ad sets: the choice is shown and the change is sent for the ad set picked', { skip }, async () => {
  const calls = [];
  const reply = (b) => b.action === 'prepare' && b.change.targetId === 'c2' ? { json: { ok: false, code: 'adset_choice', message: 'x', names: ['Set B1', 'Set B2'] } } : null;
  const { page } = await openAds(reply, calls);
  await page.click(card('c2') + ' .ae-budget');
  await page.fill(card('c2') + ' .ae-budget-input', '35,5');
  await page.click(card('c2') + ' .ae-review-budget');
  await page.waitForSelector(card('c2') + ' .ae-pick-adset');
  assert.deepEqual(await page.$$eval(card('c2') + ' .ae-pick-adset', (b) => b.map((x) => x.textContent)), ['Set B1', 'Set B2']);
  assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
  await page.click(card('c2') + ' .ae-pick-adset:nth-of-type(2)');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'set_budget', targetId: 'c2', newBudget: 35.5 }, { type: 'set_budget', targetId: 's3', newBudget: 35.5 }]);
});

test('no ad sets and bad numbers are told in plain words', { skip }, async () => {
  const calls = [];
  const { page } = await openAds((b) => b.action === 'prepare' ? { json: { ok: false, code: 'no_adsets', message: 'This campaign has no ad sets.' } } : null, calls);
  await page.click(card('c3') + ' .ae-budget');
  await page.fill(card('c3') + ' .ae-budget-input', 'abc');
  await page.click(card('c3') + ' .ae-review-budget');
  assert.equal(await msgOf(page, 'c3'), 'Enter a number above zero.');
  assert.deepEqual(actionsOf(calls), ['overview']);
  await page.fill(card('c3') + ' .ae-budget-input', '10');
  await page.click(card('c3') + ' .ae-review-budget');
  await page.waitForFunction(() => document.querySelector('[data-ax-id="c3"] [data-ax-msg]').textContent !== '');
  assert.equal(await msgOf(page, 'c3'), 'This campaign has no ad sets.');
});

test('Undo last change prepares undo_last, shows the confirm panel, and writes only after Confirm', { skip }, async () => {
  const calls = [];
  const { page } = await openAds((b) => b.action === 'prepare' ? { json: PREPARED('Undo the last change: Resume "Campaign A". Total daily budget of your active ads: 50.00 CUR now, 80.00 CUR after.') } : null, calls);
  assert.equal(await page.$eval('#ae-last', (e) => e.textContent.startsWith('Last change')), true);
  await page.click('#ae-undo-last');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'undo_last' }]);
  assert.match(await page.$eval('#ax-confirm-summary', (e) => e.textContent), /^Undo the last change: Resume/);
  assert.equal(actionsOf(calls).includes('confirm'), false);
  await page.click('#ax-confirm-go');
  await page.waitForFunction(() => /Done\./.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || ''));
  assert.equal(actionsOf(calls).filter((a) => a === 'confirm').length, 1);
});

test('nothing to undo, cannot undo and a failed safety copy are shown in plain words', { skip }, async () => {
  for (const [code, message, expected] of [
    ['nothing_to_undo', 'There is nothing to undo.', 'There is nothing to undo.'],
    ['cannot_undo', 'There was no daily limit before, so it cannot be put back here.', 'There was no daily limit before, so it cannot be put back here.'],
    ['undo_copy_failed', 'x', 'A safety copy could not be saved, so nothing was changed. Try again.']
  ]) {
    const { page } = await openAds((b) => b.action === 'prepare' ? { json: { ok: false, code, message } } : null, []);
    await page.click('#ae-undo-last');
    await page.waitForFunction(() => document.querySelector('#ae-last [data-ax-msg]').textContent !== '');
    assert.equal(await page.$eval('#ae-last [data-ax-msg]', (e) => e.textContent), expected, code);
    assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
    await page.close();
  }
});

test('a safety copy that fails at Confirm says nothing was changed', { skip }, async () => {
  const { page } = await openAds((b) => b.action === 'confirm' ? { json: { ok: false, code: 'undo_copy_failed', message: 'x' } } : null, []);
  await page.click(card('c1') + ' .ae-rename');
  await page.fill(card('c1') + ' .ae-name-input', 'Other');
  await page.click(card('c1') + ' .ae-review-rename');
  await page.click('#ax-confirm-go');
  await page.waitForFunction(() => /safety copy could not be saved/.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || ''));
});

test('Everything: a list per level with the count and the status, and drilling into a campaign or an ad set', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  await page.click('[data-ae-level="campaign"]');
  await page.waitForSelector('#ae-structure .ae-list-row');
  assert.deepEqual(calls.find((c) => c.action === 'structure'), { token: 'test-token', action: 'structure', structure: { level: 'campaign' } });
  const t = await page.$eval('#ae-structure', (e) => e.textContent);
  assert.match(t, /You have 2 campaigns/);
  assert.match(t, /Campaign ARunning/);
  assert.match(t, /Campaign BPaused/);
  await page.click('#ae-structure .ae-open');
  await page.waitForFunction(() => /ad sets/.test(document.getElementById('ae-structure').textContent));
  assert.deepEqual(calls.filter((c) => c.action === 'structure')[1].structure, { level: 'adset', parentHint: 'c1' });
  await page.click('#ae-structure .ae-open');
  await page.waitForFunction(() => /ads in Set A1/.test(document.getElementById('ae-structure').textContent));
  assert.deepEqual(calls.filter((c) => c.action === 'structure')[2].structure, { level: 'ad', parentHint: 's1' });
});

test('Everything: nothing found, not found and ambiguous answers are shown in plain words', { skip }, async () => {
  const none = await openAds((b) => b.action === 'structure' ? { json: { ok: true, level: 'ad', parent: null, count: 0, items: [] } } : null, []);
  await none.page.click('[data-ae-level="ad"]');
  await none.page.waitForFunction(() => /Nothing found\./.test(document.getElementById('ae-structure').textContent));
  const nf = await openAds((b) => b.action === 'structure' ? { json: { ok: false, code: 'not_found', message: 'x' } } : null, []);
  await nf.page.click('[data-ae-level="adset"]');
  await nf.page.waitForFunction(() => /We could not find that\./.test(document.getElementById('ae-structure').textContent));
  const calls = [];
  const amb = await openAds((b) => b.action === 'structure' ? (b.structure.parentHint === 'Set X' ? { json: { ok: true, level: 'ad', parent: 'Set X', count: 1, items: [{ id: 'z', name: 'Z', status: 'ACTIVE' }] } } : { json: { ok: false, code: 'ambiguous', message: 'x', names: ['Set X', 'Set Y'] } }) : null, calls);
  await amb.page.click('[data-ae-level="ad"]');
  await amb.page.waitForSelector('.ae-pick');
  await amb.page.click('.ae-pick');
  await amb.page.waitForFunction(() => /You have 1 ad in Set X/.test(document.getElementById('ae-structure').textContent));
});

test('only the read actions are sent until a Confirm is pressed, and no seller id is ever sent', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  await page.click(card('s1') + ' .ae-show-ads');
  await page.waitForSelector('[data-ae-ad]');
  await page.click('[data-ae-level="campaign"]');
  await page.waitForSelector('#ae-structure .ae-list-row');
  await page.click('#ae-undo-last');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.ok(actionsOf(calls).every((a) => ['overview', 'structure', 'prepare'].includes(a)));
  assert.ok(calls.every((c) => !('sellerId' in c)));
});
