// Run with:  node --test tests/*.test.mjs
// Real-browser test of Settings -> Profile: ALL seven text fields are filled the way a person types them, "Save to WhatsApp" is pressed,
// and the exact request body the app builds is captured. Nothing leaves the test: the profile door is answered by the test.
// If Playwright is not installed (it is installed in CI), this test is skipped.
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

const FILLED = {
  about: 'About test text', address: 'Address test text', description: 'Description test text',
  email: 'shop@example.com', website1: 'https://one.example.com', website2: 'https://two.example.com', vertical: 'RETAIL'
};

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

async function openPanel(profileAnswer, onBody) {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-update-profile(-photo)?$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      onBody(u, body);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(body.action === 'get' ? { success: true, profile: {} } : profileAnswer) });
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
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await page.evaluate(() => { window.openProfilePanel(); }); break; } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  await page.waitForSelector('#wa-about', { state: 'visible' });
  return { page, errors };
}

test('all seven fields typed by hand: the request body carries every one of them, under the names the node reads', { skip }, async () => {
  const bodies = [];
  const { page, errors } = await openPanel({ success: true }, (u, b) => bodies.push({ u, b }));
  await page.fill('#wa-about', FILLED.about);
  await page.fill('#wa-address', FILLED.address);
  await page.fill('#wa-description', FILLED.description);
  await page.fill('#wa-email', FILLED.email);
  await page.fill('#wa-website-1', FILLED.website1);
  await page.fill('#wa-website-2', FILLED.website2);
  await page.fill('#wa-vertical', FILLED.vertical);
  await page.click('#wa-profile-sync');
  await page.waitForFunction(() => /Saved to WhatsApp/.test(document.getElementById('wa-profile-status').textContent));
  const saves = bodies.filter((x) => x.b.action !== 'get');
  assert.equal(saves.length, 1, 'exactly one save request');
  const b = saves[0].b;
  assert.match(saves[0].u, /\/webhook\/seller-update-profile$/, 'no photo: the text-only door');
  for (const k of ['about', 'address', 'description', 'email', 'website1', 'website2', 'vertical']) assert.equal(b[k], FILLED[k], k + ' is sent exactly as typed');
  assert.equal(b.token, 'test-token');
  assert.deepEqual(Object.keys(b).sort(), ['about', 'address', 'description', 'email', 'token', 'vertical', 'website1', 'website2'].sort(), 'no field is missing or extra');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the per-field answer is shown: saved, refused with the reason, not shown yet, and left empty', { skip }, async () => {
  const answer = {
    success: false, reason: 'Some fields were not saved: see the list.',
    fields: {
      about: { status: 'saved' }, address: { status: 'not_changed' },
      description: { status: 'unconfirmed', reason: 'x' },
      email: { status: 'refused', reason: 'The email address does not look valid.' },
      website1: { status: 'saved' }, website2: { status: 'unchecked' }, vertical: { status: 'refused', reason: 'Not a category WhatsApp knows.' }
    }
  };
  const { page, errors } = await openPanel(answer, () => {});
  await page.fill('#wa-about', 'a');
  await page.click('#wa-profile-sync');
  await page.waitForFunction(() => /Not updated/.test(document.getElementById('wa-profile-status').textContent));
  const rows = await page.$$eval('#wa-profile-fields div', (els) => els.map((e) => e.textContent));
  assert.deepEqual(rows, [
    'About: Saved at Meta (read back)', 'Address: Left empty, nothing changed', 'Description: Accepted, but WhatsApp does not show it yet',
    'Email: Not saved - The email address does not look valid.', 'Website 1: Saved at Meta (read back)', 'Website 2: Accepted, could not be checked',
    'Category: Not saved - Not a category WhatsApp knows.',
    'Saved at Meta does not mean the customer view shows it: WhatsApp decides what customers see.'
  ]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('an old-style answer (no per-field result, as from n8n) shows no list and the old message', { skip }, async () => {
  const { page } = await openPanel({ success: true }, () => {});
  await page.click('#wa-profile-sync');
  await page.waitForFunction(() => /Saved to WhatsApp/.test(document.getElementById('wa-profile-status').textContent));
  assert.equal(await page.$eval('#wa-profile-fields', (e) => e.style.display), 'none');
  await page.close();
});
