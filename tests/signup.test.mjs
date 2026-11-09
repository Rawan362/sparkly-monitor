// Run with:  node --test tests/*.test.mjs
// Real-browser tests of "Create account". The REAL index.html runs in Chromium; the login system (/auth/v1/signup) and the database
// (/rest/v1/sellers) are answered by the test. Skipped when Playwright is not installed (it is installed in CI).
// Found 2026-11-09: signing up with an email that ALREADY has a confirmed account made the app insert a profile row with the made-up id
// Supabase returns for such emails (identities is an empty list), and the database refused it (foreign key, error 23503).
// No email or id is printed anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let chromium = null;
try {
  const require = createRequire(import.meta.url);
  chromium = require('playwright').chromium;
} catch (e) {
  try {
    const require = createRequire('/opt/node-tools/node_modules/');
    chromium = require('playwright').chromium;
  } catch (e2) { chromium = null; }
}
const skip = chromium ? false : 'Playwright is not installed';

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

const NEW_ID = '11111111-1111-4111-8111-111111111111';
const FAKE_ID = '22222222-2222-4222-8222-222222222222';

/** What the login system answers to a sign-up, by kind. */
const SIGNUPS = {
  // email confirmation on, new email: the user's own fields at the top level, a real identity
  newEmail: { id: NEW_ID, aud: 'authenticated', email: 'x@example.test', identities: [{ id: NEW_ID, provider: 'email' }] },
  // an email that already has a confirmed account: made-up id, no identities
  repeated: { id: FAKE_ID, aud: 'authenticated', email: 'x@example.test', identities: [] },
  // confirmation off: user nested next to a session
  withSession: { user: { id: NEW_ID, identities: [{ id: NEW_ID }] }, access_token: 'tok', refresh_token: 'ref' }
};

async function run(browser, base, kind, sellerAnswer) {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  const calls = { signups: 0, sellerPosts: [], errorsLogged: 0 };
  await page.route('**/*', async (route) => {
    const req = route.request(); const u = req.url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (u.includes('/auth/v1/signup')) { calls.signups++; return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(SIGNUPS[kind]) }); }
    if (u.includes('/rest/v1/sellers') && req.method() === 'POST') {
      calls.sellerPosts.push(JSON.parse(req.postData() || '{}'));
      const a = sellerAnswer || { status: 201, body: '' };
      return route.fulfill({ status: a.status, contentType: 'application/json', headers: h, body: a.body });
    }
    if (u.includes('system_errors') || u.includes('debug_log')) calls.errorsLogged++;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
  await page.evaluate(() => showSignUpScreen());
  await page.fill('#signup-business', 'Test Shop');
  await page.fill('#signup-email', 'x@example.test');
  await page.fill('#signup-password', 'password123');
  await page.evaluate(() => doSignUp());
  await page.waitForTimeout(400);
  const text = await page.evaluate(() => (document.getElementById('login-error') || {}).textContent || '');
  const screen = await page.evaluate(() => (document.querySelector('#login-card h1') || {}).textContent || '');
  await page.close();
  return { calls, text, screen, pageErrors };
}

let server; let browser; let base;
test.before(async () => {
  if (!chromium) return;
  server = await makeServer();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test('an email that already has an account: no profile row is created with the made-up id, and the person is told to sign in', { skip }, async () => {
  const r = await run(browser, base, 'repeated');
  assert.equal(r.calls.signups, 1);
  assert.deepEqual(r.calls.sellerPosts, [], 'no profile row is inserted with the made-up id');
  assert.match(r.text, /already has an account/i);
  assert.equal(r.screen, 'Sparkly AI', 'the sign-in screen is shown');
  assert.deepEqual(r.pageErrors, []);
});

test('a new email (confirmation on): exactly one profile row with the real id, then the "check your email" message', { skip }, async () => {
  const r = await run(browser, base, 'newEmail');
  assert.equal(r.calls.sellerPosts.length, 1);
  assert.equal(r.calls.sellerPosts[0].auth_user_id, NEW_ID);
  assert.equal(r.calls.sellerPosts[0].chat_id, 'web_' + NEW_ID);
  assert.match(r.text, /Account created! Check/);
  assert.deepEqual(r.pageErrors, []);
});

test('a new email (confirmation off, session returned): one profile row with the real id', { skip }, async () => {
  const r = await run(browser, base, 'withSession');
  assert.equal(r.calls.sellerPosts.length, 1);
  assert.equal(r.calls.sellerPosts[0].auth_user_id, NEW_ID);
});

test('if the database still refuses the link (23503), the message says so in plain words and shows no database wording', { skip }, async () => {
  const body = JSON.stringify({ code: '23503', message: 'insert or update on table "sellers" violates foreign key constraint' });
  const r = await run(browser, base, 'newEmail', { status: 409, body });
  assert.match(r.text, /could not finish setting up this account/i);
  assert.ok(!/violates|23503|constraint/i.test(r.text), 'no database wording on the screen');
});

test('the sign-up code checks for the made-up user before it inserts the profile row', () => {
  const a = html.indexOf('user.identities.length === 0');
  const b = html.indexOf("/rest/v1/sellers', {", html.indexOf('window.doSignUp'));
  assert.ok(a > 0 && b > a, 'the check comes first');
});
