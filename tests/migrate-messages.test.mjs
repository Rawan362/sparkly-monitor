// Run with:  node --test tests/*.test.mjs
// Upgrade to email login: EVERY answer the Seller Migrate door can give (and every failure around it) shows a plain, visible message,
// in the step before the new login is signed in (sign-up) and in the step with a signed-in login ("I already created my new login"),
// at the check and at the apply. The door and the login service are faked by the test: nothing leaves the test.
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

test('this test file contains only ASCII characters, and the block still has no console output or storage of the password', () => {
  const bad = [...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length;
  assert.equal(bad, 0);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-migrate-door:js:start');
  const block = html.slice(start, html.indexOf('w1-migrate-door:js:end'));
  assert.ok(!/[^\x00-\x7f]/.test(block));
  assert.ok(!/console\./.test(block));
  assert.ok(!/localStorage\.setItem\([^)]*[pP]assword/.test(block));
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
test.before(async () => { if (!chromium) return; server = await makeServer(); base = 'http://127.0.0.1:' + server.address().port; browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

// One page per flow; `door.next` is the answer for the next door call: { status, json } | { raw, status, type } | 'abort'.
async function openApp() {
  const door = { next: null, calls: [] };
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-migrate$/.test(u)) {
      const b = JSON.parse(route.request().postData() || '{}'); door.calls.push(b.action);
      const a = typeof door.next === 'function' ? door.next(b) : door.next;
      if (a === 'abort') return route.abort();
      if (a && a.raw !== undefined) return route.fulfill({ status: a.status, contentType: a.type || 'text/html', headers: h, body: a.raw });
      return json(a.status || 200, a.json);
    }
    if (/\/auth\/v1\/signup/.test(u)) return json(200, { user: { id: 'u1' }, access_token: 'jwt-new', refresh_token: 'refresh-new' });
    if (/\/auth\/v1\/token\?grant_type=password/.test(u)) return json(200, { user: { id: 'u1' }, access_token: 'jwt-in', refresh_token: 'refresh-in' });
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__started = 0; startApp = function () { window.__started++; }; });
  return { page, door };
}
const toStep1 = (page) => page.evaluate(() => { w1MigReset(); showMigrateAccountScreen(1); });
// flow A: before the new login is signed in (sign-up gives the login), flow B: with a signed-in login ("I already created my new login")
async function runFlow(page, flow) {
  await toStep1(page);
  await page.fill('#migrate-chatid', 'old-seller-4711'); await page.fill('#migrate-password', 'OldPassw0rd-secret');
  await page.click('#migrate-step1-btn');
  await page.waitForSelector('#migrate-step2-btn');
  if (flow === 'A') {
    await page.fill('#migrate-email', 'new@example.com'); await page.fill('#migrate-newpassword', 'NewPassw0rd-secret');
    await page.click('#migrate-step2-btn');
  } else {
    await page.click('#w1-mig-have');
    await page.fill('#migrate-email', 'new@example.com'); await page.fill('#migrate-newpassword', 'NewPassw0rd-secret');
    await page.click('#migrate-step3-btn');
  }
}
// the alert box is there, is visible (it has a size, is not hidden) and says the expected words
async function shown(page, expected, label) {
  if (typeof expected === 'string') await page.waitForFunction((t) => { const e = document.getElementById('login-error'); return e && e.textContent === t; }, expected, { timeout: 8000 }).catch(() => {});
  else await page.waitForFunction(() => { const e = document.getElementById('login-error'); return e && e.textContent.trim() !== ''; }, null, { timeout: 8000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const e = document.getElementById('login-error');
    if (!e) return null;
    const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { text: e.textContent, w: b.width, h: b.height, vis: cs.visibility, disp: cs.display, role: e.getAttribute('role') };
  });
  assert.ok(r, label + ': no message box at all');
  assert.ok(r.w > 0 && r.h > 0 && r.vis === 'visible' && r.disp !== 'none', label + ': message is not visible');
  assert.equal(r.role, 'alert', label);
  if (expected instanceof RegExp) assert.match(r.text, expected, label); else assert.equal(r.text, expected, label);
  return r;
}
const WRONG = 'The old account number or password is not correct.';
const CHECK_CASES = [
  ['wrong password', { json: { ok: false, error: 'wrong_old_credentials', message: 'raw' } }, WRONG, 'step1'],
  ['account not found', { json: { ok: false, error: 'no_old_account', message: 'raw' } }, 'There is no old account to link to.', 'step1'],
  ['too many tries (minutes)', { json: { ok: false, error: 'too_many_attempts', retryAfterSeconds: 600 } }, 'Too many wrong attempts. Try again later. (about 10 min)', 'step1'],
  ['too many tries (no time)', { json: { ok: false, error: 'too_many_attempts' } }, 'Too many wrong attempts. Try again later.', 'step1'],
  ['already linked', { json: { ok: false, error: 'already_linked', message: 'raw' } }, 'This account is already linked.', 'step1'],
  ['login already has a business', { json: { ok: false, error: 'login_has_seller', message: 'raw' } }, 'This login already has a business profile. Sign in with it instead.', 'step1'],
  ['too many codes', { json: { ok: false, error: 'too_many_codes' } }, 'Too many checks are open. Wait a few minutes and try again.', 'step1'],
  ['read failed', { json: { ok: false, error: 'read_failed' } }, 'Your account could not be read. Nothing was changed. Try again in a moment.', 'step1'],
  ['bad input', { json: { ok: false, error: 'bad_input' } }, 'The old account number or the old password is missing or not valid. Check them and try again.', 'step1'],
  ['door not ready (503 with code)', { status: 503, json: { code: 'not_ready' } }, 'Linking is not available yet. Please try again later.', 'step1'],
  ['door not ready (503 empty)', { status: 503, json: {} }, 'Linking is not available yet. Please try again later.', 'step1'],
  ['door not ready (code only)', { json: { ok: false, code: 'not_ready' } }, 'Linking is not available yet. Please try again later.', 'step1'],
  ['404 and 502', { status: 502, json: {} }, 'Linking is not available yet. Please try again later.', 'step1'],
  ['429 from the web server (not JSON)', { status: 429, raw: '<html>slow down</html>' }, 'Too many tries. Wait a few minutes and try again.', 'step1'],
  ['not JSON at all (200)', { status: 200, raw: '<html>oops</html>' }, 'Something went wrong. Try again.', 'step1'],
  ['no connection', 'abort', 'Something went wrong. Try again.', 'step1'],
  ['unknown code with the door wording', { json: { ok: false, error: 'brand_new_code', message: 'Please try again tomorrow.' } }, 'Please try again tomorrow.', 'step1'],
  ['unknown code without wording', { json: { ok: false, error: 'brand_new_code' } }, 'Something went wrong. Try again.', 'step1'],
  ['empty answer', { json: {} }, 'Something went wrong. Try again.', 'step1'],
  ['the login was not accepted', { json: { ok: false, error: 'not_logged_in', message: 'raw' } }, 'Your new login was not accepted. Sign in with it again, then try once more.', 'step3']
];

for (const flow of ['A', 'B']) {
  test('flow ' + flow + ' (' + (flow === 'A' ? 'before the login is signed in' : 'with a signed-in login') + '): every answer at the CHECK shows a visible plain message and no apply is sent', { skip }, async () => {
    const { page, door } = await openApp();
    for (const [name, answer, expected, where] of CHECK_CASES) {
      door.calls.length = 0; door.next = answer;
      await runFlow(page, flow);
      await shown(page, expected, flow + ' / ' + name);
      assert.equal(await page.$(where === 'step3' ? '#migrate-step3-btn' : '#migrate-step1-btn') !== null, true, name + ': on the right step');
      assert.ok(!door.calls.includes('apply'), name + ': nothing applied');
      if (where !== 'step3') assert.equal(await page.evaluate(() => W1_MIG.password), '', name + ': the old password is not kept after a refusal');
    }
    await page.close();
  });
}

const APPLY_CASES = [
  ['save failed', { json: { ok: false, error: 'save_failed' } }, 'The link could not be saved. Nothing was changed. Try again in a moment.', 'confirm'],
  ['no safety copy', { json: { ok: false, error: 'undo_unavailable' } }, 'A safety copy could not be saved, so nothing was changed. Try again in a moment.', 'confirm'],
  ['not confirmed', { json: { ok: false, error: 'unconfirmed' } }, 'We could not confirm the link. Sign in again before you try once more.', 'confirm'],
  ['read failed', { json: { ok: false, error: 'read_failed' } }, 'Your account could not be read. Nothing was changed. Try again in a moment.', 'confirm'],
  ['wrong password at apply', { json: { ok: false, error: 'wrong_old_credentials' } }, WRONG, 'step1'],
  ['too many tries at apply', { json: { ok: false, error: 'too_many_attempts', retryAfterSeconds: 120 } }, 'Too many wrong attempts. Try again later. (about 2 min)', 'step1'],
  ['already linked at apply', { json: { ok: false, error: 'already_linked' } }, 'This account is already linked.', 'step1'],
  ['login has a business at apply', { json: { ok: false, error: 'login_has_seller' } }, 'This login already has a business profile. Sign in with it instead.', 'step1'],
  ['account gone at apply', { json: { ok: false, error: 'no_old_account' } }, 'There is no old account to link to.', 'step1'],
  ['door not ready at apply', { status: 503, json: {} }, 'Linking is not available yet. Please try again later.', 'confirm'],
  ['no connection at apply', 'abort', 'Something went wrong. Try again.', 'confirm'],
  ['unknown code at apply', { json: { ok: false, error: 'brand_new_code' } }, 'Something went wrong. Try again.', 'confirm']
];

for (const flow of ['A', 'B']) {
  test('flow ' + flow + ': every answer at the APPLY shows a visible plain message (the confirm screen stays for retryable ones), never started', { skip }, async () => {
    const { page, door } = await openApp();
    for (const [name, answer, expected, where] of APPLY_CASES) {
      door.calls.length = 0;
      door.next = (b) => (b.action === 'check' ? { json: { ok: true, confirmCode: 'code-1', chatIdEnding: '711', businessName: 'Test Shop' } } : answer);
      await runFlow(page, flow);
      await page.waitForSelector('#w1-mig-apply');
      await page.click('#w1-mig-apply');
      await shown(page, expected, flow + ' / ' + name);
      assert.equal(await page.$(where === 'confirm' ? '#w1-mig-apply' : '#migrate-step1-btn') !== null, true, name + ': on the right step');
      assert.equal(await page.evaluate(() => window.__started), 0, name + ': the app is not started');
    }
    await page.close();
  });
}

test('an expired confirmation at apply runs the check again and says so on the confirm screen', { skip }, async () => {
  const { page, door } = await openApp();
  door.next = (b) => (b.action === 'check' ? { json: { ok: true, confirmCode: 'code-' + door.calls.length, chatIdEnding: '711', businessName: '' } } : { json: { ok: false, error: 'bad_confirmation' } });
  await runFlow(page, 'A');
  await page.click('#w1-mig-apply');
  await shown(page, 'The confirmation ran out. Please check again and press the button once more.', 'bad_confirmation');
  assert.ok(await page.$('#w1-mig-apply'));
});

test('a step that is still running says so instead of doing nothing; a step stuck for 30 seconds is let go', { skip }, async () => {
  const { page, door } = await openApp();
  door.next = { json: { ok: false, error: 'wrong_old_credentials' } };
  await toStep1(page);
  await page.fill('#migrate-chatid', 'old-seller-4711'); await page.fill('#migrate-password', 'OldPassw0rd-secret');
  await page.click('#migrate-step1-btn');
  await page.waitForSelector('#migrate-step2-btn');
  await page.fill('#migrate-email', 'new@example.com'); await page.fill('#migrate-newpassword', 'NewPassw0rd-secret');
  await page.evaluate(() => { W1_MIG.busy = true; W1_MIG.busySince = Date.now(); });
  await page.click('#migrate-step2-btn');
  await shown(page, 'Please wait a moment, the last step is still running.', 'busy');
  await page.evaluate(() => { W1_MIG.busySince = Date.now() - 31000; });
  await page.click('#migrate-step2-btn');
  await shown(page, WRONG, 'stuck step let go');
});

test('an unexpected error inside a step still ends in a plain message, and the busy flag is released', { skip }, async () => {
  const { page, door } = await openApp();
  door.next = { json: { ok: true, confirmCode: 'c', chatIdEnding: '1', businessName: '' } };
  await toStep1(page);
  await page.fill('#migrate-chatid', 'old-seller-4711'); await page.fill('#migrate-password', 'OldPassw0rd-secret');
  await page.click('#migrate-step1-btn');
  await page.waitForSelector('#migrate-step2-btn');
  await page.evaluate(() => { window.__realShow = w1MigShow; let n = 0; w1MigShow = function (a, b) { if (a === 'confirm' && n++ === 0) throw new Error('boom'); return window.__realShow(a, b); }; });
  await page.fill('#migrate-email', 'new@example.com'); await page.fill('#migrate-newpassword', 'NewPassw0rd-secret');
  await page.click('#migrate-step2-btn');
  await shown(page, 'Something went wrong. Try again.', 'unexpected error');
  assert.equal(await page.evaluate(() => W1_MIG.busy), false);
});
