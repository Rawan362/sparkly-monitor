// Run with:  node --test tests/*.test.mjs
// Menu entry "Ads" stays hidden until its door gives a real answer for this seller (not_available, 503, no login, no connection: hidden).
// The door is faked by the test: nothing leaves the test.
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
const ROW = 'ax-menu-row';
const DOOR = /\/webhook\/seller-ads$/;

test('this test file contains only ASCII characters, and the row starts hidden in the page', () => {
  const bad = [...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length;
  assert.equal(bad, 0);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('id="' + ROW + '"'));
  const start = html.indexOf('w1-menu-gate:js:start');
  const block = html.slice(start, html.indexOf('w1-menu-gate:js:end'));
  assert.ok(start > 0 && !/[^\x00-\x7f]/.test(block), 'gate block is ASCII');
  assert.ok(html.includes("w1GateRegister('" + ROW + "'"));
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

async function boot(answer, token) {
  const probes = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (DOOR.test(u)) {
      probes.push(JSON.parse(route.request().postData() || '{}'));
      const a = answer();
      if (a === 'abort') return route.abort();
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate((tok) => { SELLER_CHAT_ID = 'seller-test'; document.getElementById('app').style.display = 'flex'; window.getValidAuthToken = async () => tok; }, token === undefined ? 'test-token' : token);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, probes };
}
const hidden = (page) => page.evaluate((id) => { const r = document.getElementById(id); const t = r.closest('.dx-zone') || r; return getComputedStyle(t).display === 'none'; }, ROW);
const openSettings = (page) => page.evaluate(() => openSettings());

test('hidden before Settings is opened, and shown when the door gives a real answer (the probe sends the login and nothing else)', { skip }, async () => {
  const { page, probes } = await boot(() => ({ json: { ok: false, code: 'bad_action', message: 'x' } }));
  assert.equal(await hidden(page), true);
  assert.equal(probes.length, 0);
  await openSettings(page);
  await page.waitForFunction((id) => { const r = document.getElementById(id); const t = r.closest('.dx-zone') || r; return getComputedStyle(t).display !== 'none'; }, ROW);
  assert.equal(probes.length, 1);
  assert.deepEqual(Object.keys(probes[0]).sort(), ['action', 'token']);
  assert.equal(probes[0].token, 'test-token');
  await openSettings(page); await page.waitForTimeout(300);
  assert.equal(probes.length, 1, 'a shown row is not probed again');
});

test('stays hidden when the door says not_available (code or HTTP 503/404/502), when it is not reachable, or when there is no login', { skip }, async () => {
  const cases = [
    () => ({ json: { ok: false, code: 'not_available', message: 'x' } }),
    () => ({ json: { ok: false, error: 'not_available' } }),
    () => ({ status: 503, json: {} }), () => ({ status: 404, json: {} }), () => ({ status: 502, json: {} }),
    () => 'abort'
  ];
  for (const answer of cases) {
    const { page } = await boot(answer);
    await openSettings(page); await page.waitForTimeout(500);
    assert.equal(await hidden(page), true);
    await page.close();
  }
  const none = await boot(() => ({ json: { ok: true } }), null);
  await openSettings(none.page); await none.page.waitForTimeout(400);
  assert.equal(await hidden(none.page), true);
  assert.equal(none.probes.length, 0, 'no login: the door is not asked');
});

test('a row that was hidden is shown the next time Settings opens once the door answers (tried again, no loop)', { skip }, async () => {
  let n = 0;
  const { page, probes } = await boot(() => (++n === 1 ? { json: { ok: false, code: 'not_available' } } : { json: { ok: true } }));
  await openSettings(page); await page.waitForTimeout(500);
  assert.equal(await hidden(page), true);
  await openSettings(page);
  await page.waitForFunction((id) => { const r = document.getElementById(id); const t = r.closest('.dx-zone') || r; return getComputedStyle(t).display !== 'none'; }, ROW);
  assert.equal(probes.length, 2);
});
