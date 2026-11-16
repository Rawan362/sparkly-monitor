// Run with:  node --test tests/*.test.mjs
// "Upgrade to email + password" for an old chat-ID account: the old number and old password go ONLY to the Seller Migrate door
// (check, then apply), are kept in memory only, and the old direct calls (verify_seller_login, a PATCH of sellers) are gone.
// The door and the login service are faked by the test: nothing leaves the test.
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
const OLD_ID = 'old-seller-4711';
const OLD_PW = 'OldPassw0rd-secret';
const NEW_PW = 'NewPassw0rd-secret';

test('the new migrate code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-migrate-door:js:start');
  const end = html.indexOf('w1-migrate-door:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const hook = html.split('\n').filter((l) => l.includes('function showMigrateAccountScreen(step, errorMsg) { w1MigShow('));
  assert.equal(hook.length, 1);
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hook: hook.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the old direct calls are gone from the upgrade flow and the cache name is bumped', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(!html.includes('_migratingChatId'));
  assert.ok(!/sellers\?chat_id=eq\.' \+ _migrating/.test(html));
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 66);
  // the password is never written to storage by the block
  const start = html.indexOf('w1-migrate-door:js:start');
  const block = html.slice(start, html.indexOf('w1-migrate-door:js:end'));
  assert.ok(!/localStorage\.setItem\([^)]*[pP]assword/.test(block));
  assert.ok(!/sessionStorage/.test(block));
  assert.ok(!/console\./.test(block));
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

const CHECK_OK = { ok: true, confirmCode: 'code-1', chatIdEnding: '711', businessName: 'Test Shop' };
const APPLY_OK = { ok: true };

// opts.door(body) -> { status, json } or null for the default; opts.signup -> auth answer
async function openApp(opts) {
  opts = opts || {};
  const reqs = []; const logs = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(String(e.message)));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const body = route.request().postData() || '';
    reqs.push({ url: u, method: route.request().method(), body });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-migrate$/.test(u)) {
      const b = JSON.parse(body || '{}');
      const a = (opts.door && opts.door(b)) || { status: 200, json: b.action === 'check' ? CHECK_OK : APPLY_OK };
      return json(a.status, a.json);
    }
    if (/\/auth\/v1\/signup/.test(u)) return json(200, opts.signup || { user: { id: 'new-user' }, access_token: 'jwt-new', refresh_token: 'refresh-new' });
    if (/\/auth\/v1\/token\?grant_type=password/.test(u)) return json(200, opts.signin || { user: { id: 'new-user' }, access_token: 'jwt-in', refresh_token: 'refresh-in' });
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__started = 0; startApp = function () { window.__started++; }; showMigrateAccountScreen(1); });
  return { page, reqs, logs };
}
const door = (reqs, action) => reqs.filter((r) => /seller-migrate$/.test(r.url)).map((r) => JSON.parse(r.body)).filter((b) => !action || b.action === action);
const step1 = async (page, id, pw) => { await page.fill('#migrate-chatid', id || OLD_ID); await page.fill('#migrate-password', pw || OLD_PW); await page.click('#migrate-step1-btn'); };
const step2 = async (page, email, pw) => { await page.waitForSelector('#migrate-step2-btn'); await page.fill('#migrate-email', email || 'new@example.com'); await page.fill('#migrate-newpassword', pw || NEW_PW); await page.click('#migrate-step2-btn'); };
const err = (page) => page.$eval('#login-error', (e) => e.textContent).catch(() => '');

test('the happy path: signup, check, confirm screen, apply; the old password only goes to the door, in exactly two requests', { skip }, async () => {
  const { page, reqs, logs } = await openApp();
  await step1(page);
  await step2(page);
  await page.waitForSelector('#w1-mig-apply');
  assert.deepEqual(door(reqs), [{ token: 'jwt-new', action: 'check', oldChatId: OLD_ID, oldPassword: OLD_PW }]);
  const summary = await page.$eval('#w1-mig-summary', (e) => e.textContent);
  assert.equal(summary, 'Link new@example.com to the old account ending in 711 (Test Shop).');
  assert.equal(await page.$eval('#w1-mig-note', (e) => e.textContent), 'Nothing changes until you press the button.');
  assert.equal(await page.$eval('#w1-mig-apply', (e) => e.textContent), 'Link my old account');
  await page.evaluate(() => { const b = document.getElementById('w1-mig-apply'); b.click(); b.click(); });
  await page.waitForFunction(() => window.__started === 1);
  assert.deepEqual(door(reqs, 'apply'), [{ token: 'jwt-new', action: 'apply', oldChatId: OLD_ID, oldPassword: OLD_PW, confirmCode: 'code-1' }]);
  assert.equal(door(reqs).length, 2);
  const stored = await page.evaluate(() => ({ chat: localStorage.getItem('sparkly_seller_chat_id'), auth: localStorage.getItem('sparkly_auth_token'), refresh: localStorage.getItem('sparkly_refresh_token'), all: JSON.stringify(localStorage) + JSON.stringify(sessionStorage) }));
  assert.deepEqual([stored.chat, stored.auth, stored.refresh], [OLD_ID, 'jwt-new', 'refresh-new']);
  assert.ok(!stored.all.includes(OLD_PW));
  // the old password is in no other request, no URL, no log, and not in memory any more
  for (const r of reqs) {
    assert.ok(!r.url.includes(OLD_PW), 'url');
    if (!/seller-migrate$/.test(r.url)) assert.ok(!r.body.includes(OLD_PW), 'other request body: ' + r.url);
  }
  assert.ok(!logs.join('\n').includes(OLD_PW));
  assert.equal(await page.evaluate(() => W1_MIG.password + W1_MIG.chatId + W1_MIG.code), '');
  // nothing went to the sellers table or the old verify function
  assert.equal(reqs.filter((r) => /rest\/v1/.test(r.url)).length, 0);
});

test('Cancel on the confirm screen sends no apply and forgets the old password', { skip }, async () => {
  const { page, reqs } = await openApp();
  await step1(page); await step2(page);
  await page.waitForSelector('#w1-mig-apply');
  await page.click('#w1-mig-cancel');
  await page.waitForSelector('#login-email');
  assert.equal(door(reqs, 'apply').length, 0);
  assert.equal(await page.evaluate(() => W1_MIG.password + W1_MIG.token), '');
});

test('boxes left empty or a short new password are refused before any call', { skip }, async () => {
  const { page, reqs } = await openApp();
  await page.click('#migrate-step1-btn');
  assert.equal(await err(page), 'Fill in every box.');
  await step1(page);
  await step2(page, 'new@example.com', 'short');
  assert.equal(await err(page), 'Password must be at least 8 characters.');
  assert.equal(reqs.filter((r) => /seller-migrate|auth\/v1|verify_seller_login/.test(r.url)).length, 0);
});

test('a sign-up that gives no login token (email not confirmed yet) makes no door call and keeps nothing', { skip }, async () => {
  const { page, reqs } = await openApp({ signup: { user: { id: 'new-user' } } });
  await step1(page); await step2(page);
  await page.waitForSelector('#login-error');
  assert.match(await err(page), /Confirm your email, sign in, then choose Upgrade again/);
  assert.equal(door(reqs).length, 0);
  assert.equal(await page.evaluate(() => W1_MIG.password + W1_MIG.chatId + W1_MIG.token), '');
});

test('"I already created my new login": sign in, then the same check and apply', { skip }, async () => {
  const { page, reqs } = await openApp();
  await step1(page);
  await page.waitForSelector('#w1-mig-have');
  await page.click('#w1-mig-have');
  await page.fill('#migrate-email', 'new@example.com'); await page.fill('#migrate-newpassword', NEW_PW);
  await page.click('#migrate-step3-btn');
  await page.waitForSelector('#w1-mig-apply');
  assert.equal(reqs.filter((r) => /auth\/v1\/signup/.test(r.url)).length, 0);
  assert.deepEqual(door(reqs, 'check'), [{ token: 'jwt-in', action: 'check', oldChatId: OLD_ID, oldPassword: OLD_PW }]);
  await page.click('#w1-mig-apply');
  await page.waitForFunction(() => window.__started === 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('sparkly_auth_token')), 'jwt-in');
});

test('a wrong old password: plain message, the box for the password is empty again, and a retry does not sign up a second time', { skip }, async () => {
  let n = 0;
  const { page, reqs } = await openApp({ door: (b) => b.action === 'check' && ++n === 1 ? { status: 200, json: { ok: false, code: 'wrong_old_credentials', message: 'raw' } } : null });
  await step1(page); await step2(page);
  await page.waitForSelector('#migrate-step1-btn');
  assert.equal(await err(page), 'The old account number or password is not correct.');
  assert.equal(await page.$eval('#migrate-password', (e) => e.value), '');
  assert.equal(await page.evaluate(() => W1_MIG.password), '');
  await step1(page, OLD_ID, OLD_PW + '2');
  await page.waitForSelector('#w1-mig-apply');
  assert.equal(reqs.filter((r) => /auth\/v1\/signup/.test(r.url)).length, 1);
  assert.equal(door(reqs, 'check').length, 2);
});

test('door answers at check are shown in plain words and nothing is applied', { skip }, async () => {
  const cases = [
    [{ status: 200, json: { ok: false, code: 'too_many_attempts', retryAfterSeconds: 600 } }, 'Too many wrong attempts. Try again later. (about 10 min)'],
    [{ status: 200, json: { ok: false, code: 'login_has_seller' } }, 'This login already has a business profile. Sign in with it instead.'],
    [{ status: 200, json: { ok: false, code: 'no_old_account' } }, 'There is no old account to link to.'],
    [{ status: 200, json: { ok: false, code: 'already_linked' } }, 'This account is already linked.'],
    [{ status: 200, json: { ok: false, code: 'too_many_codes' } }, 'Too many checks are open. Wait a few minutes and try again.'],
    [{ status: 200, json: { ok: false, code: 'read_failed' } }, 'Your account could not be read. Nothing was changed. Try again in a moment.'],
    [{ status: 503, json: {} }, 'Linking is not available yet. Please try again later.'],
    [{ status: 200, json: { ok: false, code: 'something_new' } }, 'Something went wrong. Try again.']
  ];
  for (const [reply, expected] of cases) {
    const { page, reqs } = await openApp({ door: () => reply });
    await step1(page); await step2(page);
    await page.waitForSelector('#migrate-step1-btn');
    assert.equal(await err(page), expected);
    assert.equal(door(reqs, 'apply').length, 0);
    assert.equal(await page.evaluate(() => W1_MIG.password), '');
    await page.close();
  }
});

test('door answers at apply: refusals stay on the confirm screen or go back, never retried, never started', { skip }, async () => {
  const stay = [
    ['save_failed', 'The link could not be saved. Nothing was changed. Try again in a moment.'],
    ['undo_unavailable', 'A safety copy could not be saved, so nothing was changed. Try again in a moment.'],
    ['unconfirmed', 'We could not confirm the link. Sign in again before you try once more.']
  ];
  for (const [code, expected] of stay) {
    const { page, reqs } = await openApp({ door: (b) => b.action === 'apply' ? { status: 200, json: { ok: false, code } } : null });
    await step1(page); await step2(page);
    await page.click('#w1-mig-apply');
    await page.waitForFunction((t) => (document.getElementById('login-error') || {}).textContent === t, expected);
    assert.equal(door(reqs, 'apply').length, 1, 'no retry: ' + code);
    assert.equal(await page.evaluate(() => window.__started), 0);
    await page.close();
  }
  const back = [['already_linked', 'This account is already linked.'], ['login_has_seller', 'This login already has a business profile. Sign in with it instead.']];
  for (const [code, expected] of back) {
    const { page } = await openApp({ door: (b) => b.action === 'apply' ? { status: 200, json: { ok: false, code } } : null });
    await step1(page); await step2(page);
    await page.click('#w1-mig-apply');
    await page.waitForSelector('#migrate-step1-btn');
    assert.equal(await err(page), expected);
    assert.equal(await page.evaluate(() => W1_MIG.password), '');
    await page.close();
  }
});

test('an expired confirmation (bad_confirmation) runs the check again once and shows the confirm screen with a note', { skip }, async () => {
  const { page, reqs } = await openApp({ door: (b) => b.action === 'apply' ? { status: 200, json: { ok: false, code: 'bad_confirmation' } } : null });
  await step1(page); await step2(page);
  await page.click('#w1-mig-apply');
  await page.waitForFunction(() => /ran out/.test((document.getElementById('login-error') || {}).textContent || ''));
  assert.equal(door(reqs, 'check').length, 2);
  assert.equal(door(reqs, 'apply').length, 1);
  assert.ok(await page.$('#w1-mig-apply'));
});
