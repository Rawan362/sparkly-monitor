// Run with:  node --test tests/*.test.mjs
// Easier ways into the upgrade of an old chat-ID account: a visible "Upgrade your old account" button and an "I already created my new login"
// link on the login screen, and a clearer green message after sign-up. There is no banner after login (the door refuses a login that already has
// a business). The Seller Migrate door, its calls and the old-password check are NOT changed. The door and the login service are faked by the
// test: nothing leaves the test; no password or token value is used anywhere.
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
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('the new code and this test file contain only ASCII; the new code makes no call of its own; the door block keeps its calls', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-migrate-entry:js:start'); const b = html.indexOf('w1-migrate-entry:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block)); assert.ok(!/console\./.test(block));
  assert.ok(!/fetch\(|XMLHttpRequest|seller-migrate/.test(block), 'the new code calls nothing; the door block does all the calls');
  assert.ok(!/oldPassword|W1_MIG\.password/.test(block), 'the old-password check is untouched');
  const css = html.slice(html.indexOf('w1-migrate-entry:css:start'), html.indexOf('w1-migrate-entry:css:end'));
  assert.ok(css.length > 50 && !/[^\x00-\x7f]/.test(css));
  // the door block still makes the same two calls with the same fields
  assert.ok(html.includes("action: 'check', oldChatId: W1_MIG.chatId, oldPassword: W1_MIG.password }"));
  assert.ok(html.includes("action: 'apply', oldChatId: W1_MIG.chatId, oldPassword: W1_MIG.password, confirmCode: W1_MIG.code }"));
  // the old way in is still there
  assert.ok(html.includes('onclick="showMigrateAccountScreen(1)"') && html.includes('Upgrade to email + password'));
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

// `ctl.me` is the own-row answer ({status, json} or 'abort'); `ctl.signup` the sign-up answer; the door check answers ok with a confirm code.
async function open(ctl) {
  ctl = Object.assign({ me: { json: { ok: true, hasSeller: true, onboardingDone: false, chatId: 'web_s1' } }, signup: { user: { id: 'u1' } }, calls: [], tokens: [] }, ctl || {});
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-own-row$/.test(u)) {
      if (ctl.me === 'abort') return route.abort();
      return json(ctl.me.status || 200, ctl.me.json);
    }
    if (/\/webhook\/seller-migrate$/.test(u)) {
      const b = JSON.parse(route.request().postData() || '{}'); ctl.calls.push(b.action); ctl.tokens.push(b.token);
      if (b.action === 'check') return json(200, { ok: true, confirmCode: 'c1', chatIdEnding: '1234', businessName: 'Shop' });
      return json(200, { ok: true, chatId: 'web_old' });
    }
    if (/\/auth\/v1\/signup/.test(u)) return json(200, ctl.signup);
    if (/\/auth\/v1\/token\?grant_type=password/.test(u)) return json(200, { user: { id: 'u1' }, access_token: 'jwt-in', refresh_token: 'refresh-in' });
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__started = 0; });
  return { page, ctl };
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
const visible = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; }, id);
const loginScreen = (page, msg, tone) => page.evaluate(([m, t]) => { document.getElementById('app').style.display = 'none'; showLoginScreen(m, t); }, [msg || '', tone || '']);
test('the login screen has a visible "Upgrade your old account" button; it opens Step 1 of the upgrade', { skip }, async () => {
  const { page } = await open();
  await loginScreen(page);
  assert.equal(await visible(page, 'w1-mige-upgrade'), true, 'visible without opening anything');
  assert.equal(await text(page, '#w1-mige-upgrade'), 'Upgrade your old account');
  await page.click('#w1-mige-upgrade');
  assert.equal(await text(page, '.login-sub'), 'Step 1: enter your old account number and old password');
  assert.equal(await visible(page, 'migrate-chatid'), true);
  await page.close();
});

test('the login screen has a direct "I already created my new login" link; it opens the sign-in step, and then Step 1 and the check', { skip }, async () => {
  const { page, ctl } = await open();
  await loginScreen(page);
  assert.equal(await visible(page, 'w1-mige-have'), true);
  assert.equal(await text(page, '#w1-mige-have'), 'I already created my new login');
  await page.click('#w1-mige-have');
  assert.equal(await text(page, '.login-sub'), 'Sign in with the new login you already created');
  await page.fill('#migrate-email', 'a@example.com'); await page.fill('#migrate-newpassword', 'not-a-real-password');
  await page.click('#migrate-step3-btn');
  await page.waitForFunction(() => document.querySelector('.login-sub') && document.querySelector('.login-sub').textContent.startsWith('Step 1'));
  await page.fill('#migrate-chatid', 'old-1'); await page.fill('#migrate-password', 'old-pass');
  await page.click('#migrate-step1-btn');
  await page.waitForFunction(() => document.querySelector('.login-sub') && document.querySelector('.login-sub').textContent.startsWith('Step 3'));
  assert.deepEqual(ctl.calls, ['check']);
  assert.match(await text(page, '#w1-mig-summary'), /ending in 1234/);
  await page.close();
});

test('the green message after sign-up names the link to use, and that link is on the same screen', { skip }, async () => {
  const { page } = await open({ signup: { user: { id: 'u9' } } });   // no access token: the email must be confirmed first
  await page.evaluate(() => { w1MigReset(); showMigrateAccountScreen(1); });
  await page.fill('#migrate-chatid', 'old-1'); await page.fill('#migrate-password', 'old-pass');
  await page.click('#migrate-step1-btn');
  await page.waitForSelector('#migrate-step2-btn');
  await page.fill('#migrate-email', 'new@example.com'); await page.fill('#migrate-newpassword', 'not-a-real-password');
  await page.click('#migrate-step2-btn');
  await page.waitForSelector('#login-ok');
  const msg = await text(page, '#login-ok');
  assert.equal(msg, 'Account created. Confirm your email, then tap "I already created my new login" below. Do not sign in the normal way first.');
  assert.doesNotMatch(msg, /choose Upgrade again/);
  assert.equal(await visible(page, 'w1-mige-have'), true, 'the link the message names is right there');
  await page.close();
});

test('there is no banner after login: nothing of it is in the page', { skip }, async () => {
  assert.ok(!/w1-mige-banner|w1MigeOpen|w1MigeCheck|fromApp/.test(html));
  const { page } = await open();
  await page.evaluate(() => { SELLER_CHAT_ID = 'web_s1'; document.getElementById('app').style.display = 'flex'; });
  assert.equal(await page.evaluate(() => !document.getElementById('w1-mige-banner')), true);
  await page.close();
});

test('the old way in (the footnote under the login boxes) still works', { skip }, async () => {
  const { page } = await open();
  await loginScreen(page);
  await page.evaluate(() => { document.querySelector('#login-card details').open = true; });
  await page.click('text=Upgrade to email + password');
  assert.equal(await text(page, '.login-sub'), 'Step 1: enter your old account number and old password');
  await page.close();
});
