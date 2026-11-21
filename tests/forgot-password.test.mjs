// Run with:  node --test tests/*.test.mjs
// Forgot password: the link on the login screen, the reset email request (always the same GREEN answer), the reset page opened from the email
// link (new password twice, saved, signed in, into the app), expired or used links, and the wrong-password message with the link.
// The login service (Supabase Auth) and the Seller Own Row door are faked by the test: nothing leaves the test, no secret is used.
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
const SAME = 'If this email has an account, a reset link was sent. Check your inbox and spam folder.';

test('the new forgot-password code and this test file contain only ASCII characters, with no console output', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const a = html.indexOf('w1-forgot-password:js:start'); const b = html.indexOf('w1-forgot-password:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block)); assert.ok(!/console\./.test(block));
  assert.ok(!/localStorage\.setItem\([^)]*(token|password)/i.test(block.replace(/sparkly_auth_token/g, '')));
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

// opts.recover/opts.put/opts.token/opts.login are answers: { status, json } | 'abort'
async function open(opts, hash) {
  opts = opts || {};
  const reqs = []; const logs = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('console', (m) => logs.push(m.text()));
  await page.route('**/*', (route) => {
    const u = route.request().url(); const method = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    const pick = (a, dflt) => { const x = typeof a === 'function' ? a() : a; if (x === 'abort') return 'abort'; return x || dflt; };
    const body = route.request().postData() || '';
    if (/\/auth\/v1\/recover/.test(u)) { reqs.push({ kind: 'recover', url: u, method, body, headers: route.request().headers() }); const a = pick(opts.recover, { status: 200, json: {} }); return a === 'abort' ? route.abort() : json(a.status, a.json); }
    if (/\/auth\/v1\/user$/.test(u) && method === 'PUT') { reqs.push({ kind: 'put', url: u, body, headers: route.request().headers() }); const a = pick(opts.put, { status: 200, json: { id: 'u1', email: 'seller@example.test' } }); return a === 'abort' ? route.abort() : json(a.status, a.json); }
    if (/\/auth\/v1\/token\?grant_type=password/.test(u)) { reqs.push({ kind: 'login', body }); const a = pick(opts.login, { status: 200, json: { access_token: 'jwt-new', refresh_token: 'refresh-new', user: { id: 'u1', email: 'seller@example.test' } } }); return a === 'abort' ? route.abort() : json(a.status, a.json); }
    if (/\/webhook\/seller-own-row$/.test(u)) { reqs.push({ kind: 'door', body }); return json(200, { ok: true, hasSeller: true, chatId: 'web_seller1' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html' + (hash || ''));
  await page.waitForLoadState('load');
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.__started = 0; startApp = function () { window.__started++; }; });
  return { page, reqs, logs };
}
const msgOf = (page, sel) => page.$eval(sel, (e) => e.textContent).catch(() => null);
const colour = (page, sel) => page.$eval(sel, (e) => getComputedStyle(e).color.match(/\d+/g).slice(0, 3).map(Number));
const isGreen = (c) => c[1] > c[0] + 40 && c[1] > c[2] + 20;
const isRed = (c) => c[0] > c[1] + 60 && c[0] > c[2] + 60;
const RESET_HASH = '#access_token=RESET-TOK-123&expires_in=3600&refresh_token=RESET-REF&token_type=bearer&type=recovery';

test('the login screen has a Forgot password? link; it opens a screen that asks for the email (kept from the sign-in box)', { skip }, async () => {
  const { page } = await open();
  await page.evaluate(() => showLoginScreen());
  assert.equal(await page.$eval('#forgot-link', (e) => e.textContent), 'Forgot password?');
  await page.fill('#login-email', 'seller@example.test');
  await page.click('#forgot-link');
  assert.equal(await page.$eval('#login-card h1', (e) => e.textContent), 'Forgot password');
  assert.equal(await page.$eval('#forgot-email', (e) => e.value), 'seller@example.test');
  await page.click('#forgot-back');
  await page.waitForSelector('#login-email');
});

test('an empty or wrong-looking email asks again in red and sends nothing', { skip }, async () => {
  const { page, reqs } = await open();
  await page.evaluate(() => w1ForgotShow(''));
  await page.click('#forgot-send-btn');
  await page.waitForSelector('#login-error');
  assert.equal(await msgOf(page, '#login-error'), 'Enter your email address.');
  assert.ok(isRed(await colour(page, '#login-error')));
  assert.equal(reqs.filter((r) => r.kind === 'recover').length, 0);
});

test('sending asks Supabase Auth /recover with the email and the redirect address; the answer is always the same GREEN message (account or not)', { skip }, async () => {
  const answers = [{ status: 200, json: {} }, { status: 200, json: { message: 'x' } }, { status: 400, json: { error_code: 'user_not_found', msg: 'User not found' } }, { status: 422, json: { msg: 'Unable to validate email address: invalid format' } }];
  for (const recover of answers) {
    const { page, reqs } = await open({ recover });
    await page.evaluate(() => w1ForgotShow('seller@example.test'));
    await page.click('#forgot-send-btn');
    await page.waitForSelector('#login-ok');
    assert.equal(await msgOf(page, '#login-ok'), SAME);
    assert.ok(isGreen(await colour(page, '#login-ok')));
    assert.equal(await page.$('#login-error'), null);
    const r = reqs.filter((x) => x.kind === 'recover');
    assert.equal(r.length, 1);
    const u = new URL(r[0].url);
    assert.equal(u.pathname, '/auth/v1/recover');
    assert.equal(u.searchParams.get('redirect_to'), base + '/');
    assert.deepEqual(JSON.parse(r[0].body), { email: 'seller@example.test' });
    assert.ok(r[0].headers.apikey);
    await page.close();
  }
});

test('too many requests, a server error and no connection are shown in red (not the green message)', { skip }, async () => {
  const cases = [[{ status: 429, json: {} }, /Too many requests/], [{ status: 500, json: {} }, /could not send the email right now/], ['abort', /Could not reach the server/]];
  for (const [recover, re] of cases) {
    const { page } = await open({ recover });
    await page.evaluate(() => w1ForgotShow('seller@example.test'));
    await page.click('#forgot-send-btn');
    await page.waitForSelector('#login-error');
    assert.match(await msgOf(page, '#login-error'), re);
    assert.ok(isRed(await colour(page, '#login-error')));
    assert.equal(await page.$('#login-ok'), null);
    assert.equal(await page.$eval('#forgot-email', (e) => e.value), 'seller@example.test');
    await page.close();
  }
});

test('a wrong password on the login screen shows a plain red message that includes the Forgot password? link, which opens the forgot screen with the email', { skip }, async () => {
  const { page } = await open({ login: { status: 400, json: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } } });
  await page.evaluate(() => showLoginScreen());
  await page.fill('#login-email', 'seller@example.test'); await page.fill('#login-password2', 'wrong-password');
  await page.click('#login-email-btn');
  await page.waitForSelector('#login-error');
  assert.equal(await msgOf(page, '#login-error'), 'Incorrect email or password. Forgot password?');
  assert.ok(isRed(await colour(page, '#login-error')));
  await page.click('#login-error .w1-fp-link');
  assert.equal(await page.$eval('#login-card h1', (e) => e.textContent), 'Forgot password');
  assert.equal(await page.$eval('#forgot-email', (e) => e.value), 'seller@example.test');
});

test('opening the link from the email shows the reset page (not the login or the app) and stores nothing; the link stays in the address until it is used up', { skip }, async () => {
  const { page, logs } = await open({}, RESET_HASH);
  assert.equal(await page.$eval('#login-card h1', (e) => e.textContent), 'Set a new password');
  assert.ok(await page.$('#reset-pw1') && await page.$('#reset-pw2'));
  assert.match(await page.evaluate(() => window.location.hash), /^#access_token=RESET-TOK-123/);
  assert.equal(await page.evaluate(() => window.__started), 0);
  const stored = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
  assert.ok(!stored.includes('RESET-TOK-123') && !stored.includes('RESET-REF'));
  assert.ok(!logs.join('\n').includes('RESET-TOK-123'));
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('RESET-TOK-123'));
});

test('the new password must be at least 8 characters and typed the same twice: red messages, nothing is sent', { skip }, async () => {
  const { page, reqs } = await open({}, RESET_HASH);
  await page.fill('#reset-pw1', 'short'); await page.fill('#reset-pw2', 'short');
  await page.click('#reset-save-btn');
  await page.waitForSelector('#login-error');
  assert.equal(await msgOf(page, '#login-error'), 'Password must be at least 8 characters.');
  await page.fill('#reset-pw1', 'GoodPassw0rd'); await page.fill('#reset-pw2', 'GoodPassw0rD');
  await page.click('#reset-save-btn');
  await page.waitForFunction(() => /not the same/.test((document.getElementById('login-error') || {}).textContent || ''));
  assert.ok(isRed(await colour(page, '#login-error')));
  assert.equal(reqs.filter((r) => r.kind === 'put').length, 0);
});

test('saving: PUT /auth/v1/user with the link token and the password, then signs in with the new password and goes into the app', { skip }, async () => {
  const { page, reqs, logs } = await open({}, RESET_HASH);
  await page.fill('#reset-pw1', 'GoodPassw0rd'); await page.fill('#reset-pw2', 'GoodPassw0rd');
  await page.click('#reset-save-btn');
  await page.waitForFunction(() => window.__started === 1);
  const put = reqs.filter((r) => r.kind === 'put');
  assert.equal(put.length, 1);
  assert.equal(put[0].headers.authorization, 'Bearer RESET-TOK-123');
  assert.deepEqual(JSON.parse(put[0].body), { password: 'GoodPassw0rd' });
  const login = reqs.filter((r) => r.kind === 'login');
  assert.deepEqual(JSON.parse(login[0].body), { email: 'seller@example.test', password: 'GoodPassw0rd' });
  const st = await page.evaluate(() => ({ chat: localStorage.getItem('sparkly_seller_chat_id'), auth: localStorage.getItem('sparkly_auth_token'), refresh: localStorage.getItem('sparkly_refresh_token'), all: JSON.stringify(localStorage) + JSON.stringify(sessionStorage) }));
  assert.deepEqual([st.chat, st.auth, st.refresh], ['web_seller1', 'jwt-new', 'refresh-new']);
  assert.ok(!st.all.includes('GoodPassw0rd') && !st.all.includes('RESET-TOK-123'));
  assert.ok(!logs.join('\n').includes('GoodPassw0rd'));
  assert.equal(await page.$('#login-overlay'), null);
  assert.equal(await page.evaluate(() => window.location.hash), '', 'the used link is removed from the address');
});

test('refusals when saving are plain red messages: same password, weak password, other failure, no connection', { skip }, async () => {
  const cases = [
    [{ status: 422, json: { error_code: 'same_password', msg: 'New password should be different from the old password.' } }, /Choose a password you have not used before\./],
    [{ status: 422, json: { error_code: 'weak_password', msg: 'Password is known to be weak' } }, /too easy to guess/],
    [{ status: 500, json: {} }, /could not be saved/],
    ['abort', /Could not reach the server/]
  ];
  for (const [put, re] of cases) {
    const { page } = await open({ put }, RESET_HASH);
    await page.fill('#reset-pw1', 'GoodPassw0rd'); await page.fill('#reset-pw2', 'GoodPassw0rd');
    await page.click('#reset-save-btn');
    await page.waitForSelector('#login-error');
    assert.match(await msgOf(page, '#login-error'), re);
    assert.ok(isRed(await colour(page, '#login-error')));
    assert.ok(await page.$('#reset-pw1'), 'the form stays so the seller can try again');
    await page.close();
  }
});

test('a link that expired or was already used (in the address or at saving) gives a plain red message with the Forgot password? link', { skip }, async () => {
  const ADDR = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
  const a = await open({}, ADDR);
  assert.equal(await msgOf(a.page, '#login-error'), 'This link has expired or was already used. Ask for a new reset link below. Forgot password?');
  assert.ok(isRed(await colour(a.page, '#login-error')));
  assert.equal(await a.page.evaluate(() => window.__started), 0);
  await a.page.click('#login-error .w1-fp-link');
  assert.equal(await a.page.evaluate(() => window.location.hash), '', 'a bad link is removed from the address at the first action');
  assert.equal(await a.page.$eval('#login-card h1', (e) => e.textContent), 'Forgot password');
  const b = await open({ put: { status: 401, json: { msg: 'invalid JWT' } } }, RESET_HASH);
  await b.page.fill('#reset-pw1', 'GoodPassw0rd'); await b.page.fill('#reset-pw2', 'GoodPassw0rd');
  await b.page.click('#reset-save-btn');
  await b.page.waitForSelector('#login-error .w1-fp-link');
  assert.match(await msgOf(b.page, '#login-error'), /^This link has expired or was already used/);
});

test('if signing in with the new password fails after saving, the seller is told to sign in (green) instead of being stuck', { skip }, async () => {
  const { page } = await open({ login: { status: 400, json: { msg: 'x' } } }, RESET_HASH);
  await page.fill('#reset-pw1', 'GoodPassw0rd'); await page.fill('#reset-pw2', 'GoodPassw0rd');
  await page.click('#reset-save-btn');
  await page.waitForSelector('#login-ok');
  assert.equal(await msgOf(page, '#login-ok'), 'Your password was saved. Sign in with your new password.');
});

test('an address with no reset link (or an unrelated hash) starts the app exactly as before', { skip }, async () => {
  const { page } = await open({}, '#something-else');
  assert.equal(await page.$('#reset-pw1'), null);
  assert.ok(await page.$('#landing, #login-overlay'));
});
