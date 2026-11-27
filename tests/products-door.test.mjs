// Run with:  node --test tests/*.test.mjs
// The product form (save and delete) goes through the Seller Product Writes door with the person's own login: the same columns without the seller,
// updated_at and created_at; an edit and a delete can be undone; when the door answers "not available" the older direct write runs exactly as
// before. The door and Supabase are faked by the test: nothing leaves the test; the token is a made-up word; no real product data.
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

test('this test file and the new block are ASCII; the door call sends no seller id and not the public key; the block writes nothing directly', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-products-door:js:start'); const b = html.indexOf('w1-products-door:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1PrCall'), block.indexOf('// Door first: the answer'));
  assert.ok(!/seller/i.test(call.replace(/Seller Product Writes|SELLER_PRODUCT_WRITES_URL|seller-product-writes/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
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

async function open(ctl) {
  ctl = Object.assign({ door: () => ({ status: 200, json: { ok: true, count: 1, productId: 'p-new', undoId: 'u1' } }) }, ctl || {});
  const door = []; const direct = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-product-writes$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); const a = ctl.door(b); return json(a.status, a.json); }
    if (/\/rest\/v1\/seller_products/.test(u) && m !== 'GET') { direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' }); return route.fulfill({ status: m === 'POST' ? 201 : 204, headers: h, body: '' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__lp = 0; window.loadProducts = async () => { window.__lp++; }; window.closeProductForm = () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, door, direct, alerts, ctl };
}
const T = 'made-up-token';
const fillForm = (page) => page.evaluate(() => {
  const v = { 'pf-product_name': 'Item A', 'pf-product_category': ' Shoes ', 'pf-product_code': 'A-1', 'pf-sell_unit': 'piece', 'pf-retail_price': '$50', 'pf-stock_quantity': '12', 'pf-pack_units': 'carton = 40' };
  for (const [k, x] of Object.entries(v)) document.getElementById(k).value = x;
  document.getElementById('pf-track_stock-toggle').classList.add('on');
});
const note = (page) => page.evaluate(() => { const b = document.getElementById('w1-pr-note'); return b && b.style.display !== 'none' ? { text: document.getElementById('w1-pr-note-msg').textContent, undo: document.getElementById('w1-pr-undo-btn').style.display !== 'none' } : null; });

test('a new product: one save call with the form columns and no seller, updated_at or created_at; no direct write; the list reloads', { skip }, async () => {
  const { page, door, direct } = await open();
  await fillForm(page);
  await page.evaluate(() => { currentEditingProductId = null; return saveProductForm(); });
  assert.equal(door.length, 1); assert.equal(direct.length, 0);
  const d = door[0];
  assert.equal(d.token, T); assert.equal(d.action, 'save'); assert.equal('productId' in d, false);
  assert.deepEqual(Object.keys(d.product).sort(), ['cost_price', 'common_questions', 'competitors_difference', 'delivery_info', 'delivery_timing_preference', 'escalation_rules', 'is_active', 'key_features', 'low_stock_threshold', 'market_city', 'pack_units', 'payment_methods', 'product_category', 'product_code', 'product_name', 'retail_price', 'sell_unit', 'special_offers', 'stock_quantity', 'target_customers', 'track_stock', 'wholesale_price'].sort());
  assert.equal(d.product.product_category, 'shoes'); assert.equal(d.product.retail_price, 50); assert.equal(d.product.stock_quantity, 12);
  assert.equal(d.product.track_stock, true); assert.equal(d.product.is_active, true); assert.deepEqual(d.product.pack_units, [{ unit: 'carton', size: 40 }]);
  assert.equal(d.product.wholesale_price, null);
  assert.ok(!JSON.stringify(d).includes('web_s1') && !/chat_id|updated_at|created_at/.test(JSON.stringify(d)));
  assert.equal(await note(page), null, 'no Undo for a new product');
  assert.equal(await page.evaluate(() => window.__lp), 1);
  await page.close();
});

test('an edit: the product id goes with it, and an Undo button undoes through the door', { skip }, async () => {
  const { page, door, direct } = await open();
  await fillForm(page);
  await page.evaluate(() => { currentEditingProductId = 'p7'; return saveProductForm(); });
  assert.equal(door[0].productId, 'p7'); assert.equal(direct.length, 0);
  assert.deepEqual(await note(page), { text: 'Product saved.', undo: true });
  await page.click('#w1-pr-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-pr-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(door[1], { token: T, action: 'undo', undoId: 'u1' });
  await page.close();
});

test('delete: the product id only, with an Undo button; no direct delete', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(() => { currentEditingProductId = 'p7'; return deleteCurrentProduct(); });
  assert.deepEqual(door, [{ token: T, action: 'delete', productId: 'p7' }]);
  assert.deepEqual(direct, []); assert.deepEqual(await note(page), { text: 'Product deleted.', undo: true });
  await page.close();
});

test('the screen\'s own checks still come first (no name, no code, no unit, a bad number, a bad pack): nothing is sent', { skip }, async () => {
  const { page, door, direct, alerts } = await open();
  await page.evaluate(async () => { currentEditingProductId = null; for (const id of ['pf-product_name', 'pf-product_code', 'pf-sell_unit']) document.getElementById(id).value = ''; await saveProductForm(); });
  assert.equal(door.length, 0); assert.equal(direct.length, 0); assert.ok(alerts.includes('Product name is required'));
  await page.close();
});

test('a refusal shows the door words in the screen\'s own message and never falls back to the direct write', { skip }, async () => {
  const { page, direct, alerts } = await open({ door: () => ({ status: 200, json: { ok: false, error: 'bad_input', message: 'The product name is too long.' } }) });
  await fillForm(page);
  await page.evaluate(() => { currentEditingProductId = null; return saveProductForm(); });
  assert.ok(alerts.includes('Could not save: The product name is too long.'));
  assert.deepEqual(direct, []);
  await page.close();
});

test('the door is not available: save, edit and delete keep the older direct request exactly as before, and the door is asked once', { skip }, async () => {
  const { page, door, direct } = await open({ door: () => ({ status: 503, json: { ok: false, code: 'not_ready' } }) });
  await fillForm(page);
  await page.evaluate(async () => { currentEditingProductId = null; await saveProductForm(); currentEditingProductId = 'p7'; await saveProductForm(); await deleteCurrentProduct(); });
  assert.equal(door.length, 1, 'asked once, then remembered');
  assert.deepEqual(direct.map((d) => d.method + ' ' + d.url.split('?')[0]), ['POST seller_products', 'PATCH seller_products', 'DELETE seller_products']);
  assert.match(direct[0].body, /"chat_id":"web_s1"/); assert.match(direct[0].body, /"created_at"/); assert.match(direct[0].body, /"updated_at"/);
  assert.match(direct[1].url, /id=eq\.p7/); assert.doesNotMatch(direct[1].body, /created_at/); assert.match(direct[2].url, /id=eq\.p7/);
  await page.close();
});

test('login problems: no token means no door call and no direct write; the screen shows its own failure message', { skip }, async () => {
  const { page, door, direct, alerts } = await open();
  await fillForm(page);
  await page.evaluate(() => { window.getValidAuthToken = async () => null; currentEditingProductId = null; return saveProductForm(); });
  assert.equal(door.length, 0); assert.deepEqual(direct, []);
  assert.ok(alerts.includes('Could not save: Please sign out and sign in again, then try once more.'));
  await page.close();
});
