// Run with:  node --test tests/*.test.mjs
// Business settings, "Meta Ad Account ID": saved through the Ads door (prepare, then Confirm) with a format check, instead of a direct
// write to the seller_ad_config table with the public key. The door and the database are faked by the test: nothing leaves the test.
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

test('the new ad account code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-ad-account-id:js:start');
  const end = html.indexOf('w1-ad-account-id:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const hook = html.split('\n').filter((l) => l.includes("await w1AdAccountSave(el); return;"));
  assert.equal(hook.length, 1);
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hook: hook.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the generic save keeps its older path for every other field, and the cache name is bumped', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes("const finalValue = el.dataset.numeric === 'true'"));
  assert.ok(html.includes('data-key="ad_account_id" data-table="seller_ad_config"'));
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

const PREPARED = (summary, ms) => ({ ok: true, needsConfirm: true, confirmToken: 'tok-1', expiresAt: new Date(Date.now() + (ms || 300000)).toISOString(), preview: { summary: summary || 'Save the Meta Ad Account ID act_123456789 (none is saved now).' } });

async function openApp(answer, calls, direct, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-ads$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = (answer && answer(body)) || (body.action === 'prepare' ? { json: PREPARED() } : { json: { ok: true, applied: 'set_account_id', adAccountId: 'act_123456789', verified: true } });
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
    if (/\/rest\/v1\/seller_ad_config/.test(u) && route.request().method() !== 'GET') { direct.push(route.request().method()); return route.fulfill({ status: 201, headers: h, body: '' }); }
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
        bizLoadedFor = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => tok;
        document.getElementById('business-tab-content').style.display = 'flex';
        document.getElementById('biz-ad-account-id').value = 'act_111222333';
      }, token === undefined ? 'login-jwt' : token);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const asked = (calls, a) => calls.filter((c) => c.action === a);
// The seller focuses the box, types, and leaves it (the box saves on change).
const type = async (page, value) => { await page.focus('#biz-ad-account-id'); await page.fill('#biz-ad-account-id', value); await page.evaluate(() => document.getElementById('biz-ad-account-id').blur()); };
const msg = (page) => page.$eval('#w1-acct-msg', (e) => e.textContent).catch(() => '');

test('typing an id asks the door to prepare it (token, action, change with the trimmed id); nothing is saved until Confirm, and nothing goes to the table', { skip }, async () => {
  const calls = []; const direct = [];
  const { page, errors } = await openApp(null, calls, direct);
  await type(page, '  123456789  ');
  await page.waitForSelector('#w1-acct-confirm', { state: 'visible' });
  assert.deepEqual(calls, [{ token: 'login-jwt', action: 'prepare', change: { type: 'set_account_id', accountId: '123456789' } }]);
  assert.equal(await page.$eval('#w1-acct-summary', (e) => e.textContent), 'Save the Meta Ad Account ID act_123456789 (none is saved now).');
  assert.equal(await page.$eval('#w1-acct-note', (e) => e.textContent), 'Nothing changes until you press Confirm.');
  assert.match(await page.$eval('#w1-acct-count', (e) => e.textContent), /^[0-5]:\d\d left to confirm$/);
  assert.equal(asked(calls, 'confirm').length, 0);
  assert.equal(direct.length, 0);
  assert.deepEqual(errors, []);
});

test('Confirm sends confirm once with the token; the box shows the id the door saved; Saved is shown with an Undo button', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openApp(null, calls, direct);
  await type(page, '123456789');
  await page.waitForSelector('#w1-acct-confirm', { state: 'visible' });
  await page.evaluate(() => { const b = document.getElementById('w1-acct-go'); b.click(); b.click(); });
  await page.waitForFunction(() => document.getElementById('w1-acct-msg') && document.getElementById('w1-acct-msg').textContent === 'Saved.');
  assert.deepEqual(asked(calls, 'confirm'), [{ token: 'login-jwt', action: 'confirm', confirmToken: 'tok-1' }]);
  assert.equal(await page.$eval('#biz-ad-account-id', (e) => e.value), 'act_123456789');
  assert.equal(await page.$eval('#w1-acct-confirm', (e) => e.style.display), 'none');
  assert.equal(await page.$eval('#w1-acct-undo', (e) => e.textContent), 'Undo last change');
  assert.equal(direct.length, 0);
});

test('Cancel sends nothing and puts the box back to what it held', { skip }, async () => {
  const calls = [];
  const { page } = await openApp(null, calls, []);
  await type(page, '123456789');
  await page.waitForSelector('#w1-acct-confirm', { state: 'visible' });
  await page.click('#w1-acct-cancel');
  await page.waitForTimeout(200);
  assert.deepEqual(calls.map((c) => c.action), ['prepare']);
  assert.equal(await page.$eval('#biz-ad-account-id', (e) => e.value), 'act_111222333');
});

test('an id with a wrong format is refused on the screen before the door is asked, and the box goes back', { skip }, async () => {
  for (const bad of ['', '   ', 'abc', '12', 'act_', '12345 6789', 'x'.repeat(31), '1'.repeat(31), 'act_12ab']) {
    const calls = [];
    const { page } = await openApp(null, calls, []);
    await type(page, bad);
    assert.equal(await msg(page), 'The Meta Ad Account ID must be 3 to 30 digits, with or without "act_".', JSON.stringify(bad));
    assert.equal(calls.length, 0);
    assert.equal(await page.$eval('#biz-ad-account-id', (e) => e.value), 'act_111222333');
    await page.close();
  }
  for (const ok of ['123', 'ACT_123456789', '1'.repeat(30)]) {
    const calls = [];
    const { page } = await openApp(null, calls, []);
    await type(page, ok);
    await page.waitForSelector('#w1-acct-confirm', { state: 'visible' });
    assert.equal(calls[0].change.accountId, ok);
    await page.close();
  }
});

test('the same id again says so and opens no panel', { skip }, async () => {
  const { page } = await openApp((b) => b.action === 'prepare' ? { json: { ok: true, unchanged: true, adAccountId: 'act_111222333' } } : null, [], []);
  await type(page, '111222333');
  await page.waitForFunction(() => /already your Meta Ad Account ID/.test((document.getElementById('w1-acct-msg') || {}).textContent || ''));
  assert.equal(await page.$('#w1-acct-confirm'), null);
});

test('door refusals are shown in plain words and the box goes back: at prepare and at confirm', { skip }, async () => {
  const prepareCases = [
    [{ json: { ok: false, code: 'bad_account_id', message: 'raw' } }, 'The Meta Ad Account ID must be 3 to 30 digits, with or without "act_".'],
    [{ json: { ok: false, code: 'unavailable', message: 'raw' } }, 'Your ad settings could not be read. Nothing was changed. Try again.'],
    [{ json: { ok: false, code: 'not_configured', message: 'raw' } }, 'Saving is not available yet. Please try again later.'],
    [{ status: 503, json: {} }, 'Saving is not available yet. Please try again later.'],
    [{ json: { ok: false, code: 'relogin', message: 'raw' } }, 'Please sign out and sign in again, then try once more.']
  ];
  for (const [reply, expected] of prepareCases) {
    const { page } = await openApp((b) => b.action === 'prepare' ? reply : null, [], []);
    await type(page, '123456789');
    await page.waitForFunction((t) => (document.getElementById('w1-acct-msg') || {}).textContent === t, expected);
    assert.equal(await page.$eval('#biz-ad-account-id', (e) => e.value), 'act_111222333');
    await page.close();
  }
  const confirmCases = [
    ['changed_since_preview', 'Your account ID changed meanwhile. Nothing was changed. Try again.'],
    ['undo_copy_failed', 'A safety copy could not be saved, so nothing was changed. Try again.'],
    ['not_saved', 'The Meta Ad Account ID could not be saved. Nothing was changed. Try again in a moment.'],
    ['unconfirmed', 'We could not confirm the save. Look at the box before you try again.'],
    ['already_used', 'This confirmation was already used. Nothing was changed.']
  ];
  for (const [code, expected] of confirmCases) {
    const calls = [];
    const { page } = await openApp((b) => b.action === 'confirm' ? { json: { ok: false, code, message: 'raw' } } : null, calls, []);
    await type(page, '123456789');
    await page.click('#w1-acct-go');
    await page.waitForFunction((t) => (document.getElementById('w1-acct-msg') || {}).textContent === t, expected);
    assert.equal(asked(calls, 'confirm').length, 1, 'never retried: ' + code);
    assert.equal(await page.$eval('#biz-ad-account-id', (e) => e.value), 'act_111222333');
    assert.equal(await page.$('#w1-acct-undo'), null);
    await page.close();
  }
});

test('a save the door could not read back (verified false) is not shown as saved', { skip }, async () => {
  const { page } = await openApp((b) => b.action === 'confirm' ? { json: { ok: true, applied: 'set_account_id', adAccountId: 'act_123456789', verified: false } } : null, [], []);
  await type(page, '123456789');
  await page.click('#w1-acct-go');
  await page.waitForFunction(() => /Sent, but not confirmed/.test((document.getElementById('w1-acct-msg') || {}).textContent || ''));
});

test('the confirm button is disabled when the five minutes run out, and then nothing is sent', { skip }, async () => {
  const calls = [];
  const { page } = await openApp((b) => b.action === 'prepare' ? { json: PREPARED(null, 1200) } : null, calls, []);
  await type(page, '123456789');
  await page.waitForSelector('#w1-acct-go', { state: 'attached' });
  await page.waitForFunction(() => { const b = document.getElementById('w1-acct-go'); return b && b.disabled; });
  assert.equal(await page.$eval('#w1-acct-count', (e) => e.textContent), 'This ran out of time. Try again.');
  await page.evaluate(() => w1AcctPressConfirm());
  await page.waitForTimeout(200);
  assert.equal(asked(calls, 'confirm').length, 0);
});

test('Undo prepares undo_last, needs its own Confirm, and puts the earlier id on the box; a first save says it cannot be put back', { skip }, async () => {
  const calls = [];
  const answer = (b) => {
    if (b.action === 'prepare' && b.change.type === 'undo_last') return { json: PREPARED('Undo the last change: Save the Meta Ad Account ID act_111222333.') };
    if (b.action === 'confirm' && b.confirmToken === 'tok-1' && calls.filter((c) => c.action === 'confirm').length === 2) return { json: { ok: true, applied: 'set_account_id', adAccountId: 'act_111222333', verified: true } };
    return null;
  };
  const { page } = await openApp(answer, calls, []);
  await type(page, '123456789');
  await page.click('#w1-acct-go');
  await page.waitForSelector('#w1-acct-undo', { state: 'visible' });
  await page.click('#w1-acct-undo');
  await page.waitForFunction(() => /Undo the last change/.test((document.getElementById('w1-acct-summary') || {}).textContent || ''));
  assert.deepEqual(calls.filter((c) => c.action === 'prepare')[1], { token: 'login-jwt', action: 'prepare', change: { type: 'undo_last' } });
  assert.equal(asked(calls, 'confirm').length, 1, 'the undo is not sent before its own Confirm');
  await page.click('#w1-acct-go');
  await page.waitForFunction(() => document.getElementById('biz-ad-account-id').value === 'act_111222333');
  const first = await openApp((b) => b.action === 'prepare' && b.change.type === 'undo_last' ? { json: { ok: false, code: 'cannot_undo', message: 'raw' } } : null, [], []);
  await type(first.page, '123456789');
  await first.page.click('#w1-acct-go');
  await first.page.waitForSelector('#w1-acct-undo', { state: 'visible' });
  await first.page.click('#w1-acct-undo');
  await first.page.waitForFunction(() => (document.getElementById('w1-acct-msg') || {}).textContent === 'There was no earlier ID, so this cannot be put back here.');
});

test('every other field of Business settings still saves the way it did', { skip }, async () => {
  const calls = []; const posts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-ads$/.test(u)) { calls.push(1); return route.fulfill({ status: 200, headers: h, body: '{}' }); }
    if (route.request().method() === 'POST' && /\/rest\/v1\/seller_sales_config/.test(u)) { posts.push(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ status: 201, headers: h, body: '' }); }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => { SELLER_CHAT_ID = 'seller-test'; bizLoadedFor = 'seller-test'; document.getElementById('app').style.display = 'flex'; const el = document.getElementById('biz-currency-label'); el.value = 'XYZ'; return saveBizField(el); });
  assert.equal(calls.length, 0, 'the Ads door is not asked for another field');
  assert.deepEqual(posts, [{ chat_id: 'seller-test', currency_label: 'XYZ' }]);
});
