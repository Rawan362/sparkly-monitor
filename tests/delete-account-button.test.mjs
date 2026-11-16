// Run with:  node --test tests/*.test.mjs
// Settings, "Delete my account": the row now opens the Delete my business screen (typed confirmation, a saved copy first, a waiting time,
// an undo window) instead of deleting in one step with a database function called with the public key. The door is faked by the test:
// nothing leaves the test. If Playwright is not installed (it is installed in CI), the browser tests are skipped. The text scan always runs.
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

test('the changed function and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const i = html.indexOf('window.confirmDeleteAccount = function()');
  const j = html.indexOf('window.logout = function()');
  assert.ok(i > 0 && j > i);
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), changed: html.slice(i, j) };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('no database function for deleting an account is called from the web app any more, and the cache name is bumped', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(html.includes('delete_seller_account'), false);
  assert.equal(html.includes('deleteAccountNow'), false);
  assert.ok(html.includes('<div class="settings-row danger" onclick="confirmDeleteAccount()">'), 'the Settings row is still there');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 86);
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

async function openApp() {
  const calls = []; const rpc = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-delete-business$/.test(u)) {
      calls.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ ok: true, status: 'none' }) });
    }
    if (/\/rest\/v1\/rpc\//.test(u)) { rpc.push(u); return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: 'true' }); }
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
        window.getValidAuthToken = async () => 'login-jwt';
        window.sb = async () => [];
        window.__prompts = 0; window.prompt = () => { window.__prompts++; return 'DELETE'; };
        window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); };
        document.getElementById('settings-tab-content').style.display = 'block';
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, calls, rpc, errors };
}

test('the Delete my account row opens the Delete my business screen and asks the door for the status; nothing is deleted and no prompt or database function is used', { skip }, async () => {
  const { page, calls, rpc, errors } = await openApp();
  await page.click('#settings-tab-content .settings-row.danger:has(#settings-label-delete)');
  await page.waitForSelector('#dx-tab-content', { state: 'visible' });
  await page.waitForFunction(() => document.getElementById('dx-start'));
  assert.deepEqual(calls, [{ token: 'login-jwt', action: 'status' }]);
  assert.equal(await page.evaluate(() => window.__prompts), 0);
  assert.equal(rpc.length, 0);
  assert.equal(await page.$eval('#settings-tab-content', (e) => e.style.display), 'none');
  assert.match(await page.$eval('#dx-content', (e) => e.textContent), /This permanently deletes your business data/);
  assert.equal(await page.$eval('#dx-start', (b) => b.disabled), true, 'the start button needs the typed words');
  assert.deepEqual(await page.evaluate(() => window.__alerts), []);
  assert.deepEqual(errors, []);
});

test('the back arrow of the screen returns to Settings, where the same row is still there', { skip }, async () => {
  const { page } = await openApp();
  await page.evaluate(() => confirmDeleteAccount());
  await page.waitForSelector('#dx-tab-content', { state: 'visible' });
  await page.click('#dx-header-row button');
  assert.equal(await page.$eval('#settings-tab-content', (e) => e.style.display), 'block');
  assert.ok(await page.$('#settings-label-delete'));
});
