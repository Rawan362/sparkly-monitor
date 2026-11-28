// Run with:  node --test tests/*.test.mjs
// Customer writes (the chat profile name, the customer form, "Add new customer" in a sale, delete) go through the Seller Customers door with the
// person's own login; a delete is checked first and can be undone; when the door answers "not available" every screen keeps its older direct write
// exactly as before. The door and Supabase are faked by the test: nothing leaves the test; the token is a made-up word; no real customer data.
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
  const a = html.indexOf('w1-customers-door:js:start'); const b = html.indexOf('w1-customers-door:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1CuCall'), block.indexOf('// Door first: the answer'));
  assert.ok(!/seller/i.test(call.replace(/Seller Customers|SELLER_CUSTOMERS_URL|seller-customers/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
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
  ctl = Object.assign({ door: () => ({ status: 200, json: { ok: true, count: 1, customerId: 'c1' } }) }, ctl || {});
  const door = []; const direct = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-customers$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); const a = ctl.door(b); return json(a.status, a.json); }
    if (/\/rest\/v1\/customers/.test(u) && m !== 'GET') { direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' }); return route.fulfill({ status: m === 'POST' ? 201 : 204, headers: h, body: '' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__op = 0; window.openProfile = async () => { window.__op++; }; window.loadCustomersList = async () => { window.__cl = (window.__cl || 0) + 1; }; window.closeCustomerForm = () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, door, direct, alerts, ctl };
}
const T = 'made-up-token';
const fill = (page, o) => page.evaluate((v) => { for (const [k, x] of Object.entries(v)) document.getElementById(k).value = x; }, o);
const note = (page) => page.evaluate(() => { const b = document.getElementById('w1-cu-note'); return b && b.style.display !== 'none' ? { text: document.getElementById('w1-cu-note-msg').textContent, undo: document.getElementById('w1-cu-undo-btn').style.display !== 'none' } : null; });

test('the chat profile name: saveName with the phone and the name, no direct read or write; the profile reloads', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { document.body.insertAdjacentHTML('beforeend', '<input id="profile-name-input" value="  Sam  "><button id="profile-name-save">Save</button>'); await saveCustomerName('15550001'); });
  assert.deepEqual(door, [{ token: T, action: 'saveName', phone: '15550001', name: 'Sam' }]);
  assert.deepEqual(direct, []); assert.equal(await page.evaluate(() => window.__op), 1);
  await page.close();
});

test('the customer form: a new customer and an edit are one saveCustomer call; a phone already in the list keeps the screen message and sends nothing', { skip }, async () => {
  const { page, door, direct, alerts } = await open();
  await page.evaluate(async () => {
    customersCache = [{ id: 'x', phone: '999', name: 'Existing' }];
    for (const [k, v] of Object.entries({ 'cf-name': 'Ann', 'cf-phone': '15550001', 'cf-address': 'Street 1', 'cf-city': ' Town ', 'cf-notes': '' })) document.getElementById(k).value = v;
    currentEditingCustomerId = null; await saveCustomerForm();
    currentEditingCustomerId = 'c7'; document.getElementById('cf-notes').value = 'Likes tea'; await saveCustomerForm();
    currentEditingCustomerId = null; document.getElementById('cf-phone').value = '999'; await saveCustomerForm();
  });
  assert.equal(door.length, 2);
  assert.deepEqual(door[0], { token: T, action: 'saveCustomer', name: 'Ann', phone: '15550001', address: 'Street 1', city: 'Town', notes: '' });
  assert.deepEqual(door[1], { token: T, action: 'saveCustomer', name: 'Ann', phone: '15550001', address: 'Street 1', city: 'Town', notes: 'Likes tea', customerId: 'c7' });
  assert.ok(alerts.includes('A customer with this phone number already exists: Existing'));
  assert.deepEqual(direct, []);
  await page.close();
});

test('the customer form: the door words show for a refusal (for example a duplicate it found) and nothing is written the old way', { skip }, async () => {
  const { page, direct, alerts } = await open({ door: () => ({ status: 200, json: { ok: false, error: 'already_exists', message: 'You already have a customer with this phone number.' } }) });
  await page.evaluate(async () => {
    customersCache = []; for (const [k, v] of Object.entries({ 'cf-name': 'Ann', 'cf-phone': '15550001', 'cf-address': 'Street 1' })) document.getElementById(k).value = v;
    currentEditingCustomerId = null; await saveCustomerForm();
  });
  assert.ok(alerts.some((a) => a === 'Could not save: You already have a customer with this phone number.'));
  assert.deepEqual(direct, []);
  await page.close();
});

test('"Add new customer" in a sale: addFromPos with phone, name and address', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    window.selectCustomerSuggestion = () => {}; document.body.insertAdjacentHTML('beforeend', '<input id="oc-new-phone"><input id="oc-new-name"><input id="oc-new-address">');
    document.getElementById('oc-new-phone').value = '15550002'; document.getElementById('oc-new-name').value = 'Bo'; document.getElementById('oc-new-address').value = 'Road 2';
    await saveNewCustomerFromPOS();
  });
  assert.deepEqual(door, [{ token: T, action: 'addFromPos', phone: '15550002', name: 'Bo', address: 'Road 2' }]);
  assert.deepEqual(direct, []);
  await page.close();
});

test('delete: check, then apply with the digest, an Undo button, and Undo brings the list back; a customer in use is refused with the reason and nothing is applied', { skip }, async () => {
  const { page, door, direct, alerts } = await open({ door: (b) => b.action === 'deleteCheck' ? { status: 200, json: { ok: true, canDelete: true, blockedBy: [], digest: 'd'.repeat(32) } } : b.action === 'deleteApply' ? { status: 200, json: { ok: true, count: 1, deleted: 1, undoId: 'u1' } } : { status: 200, json: { ok: true } } });
  await page.evaluate(() => { currentEditingCustomerId = 'c1'; return deleteCurrentCustomer(); });
  assert.deepEqual(door.map((b) => [b.action, b.customerId, b.digest]), [['deleteCheck', 'c1', undefined], ['deleteApply', 'c1', 'd'.repeat(32)]]);
  assert.deepEqual(direct, []); assert.deepEqual(await note(page), { text: 'Customer deleted.', undo: true });
  await page.click('#w1-cu-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-cu-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(door[2], { token: T, action: 'undo', undoId: 'u1' });
  await page.close();
  const use = await open({ door: () => ({ status: 200, json: { ok: true, canDelete: false, blockedBy: ['orders', 'messages'], digest: 'e'.repeat(32) } }) });
  await use.page.evaluate(() => { currentEditingCustomerId = 'c2'; return deleteCurrentCustomer(); });
  assert.deepEqual(use.door.map((b) => b.action), ['deleteCheck']);
  assert.ok(use.alerts.some((a) => a === 'Could not delete: This customer cannot be deleted because they have orders and they have messages in the history.'));
  assert.deepEqual(use.direct, []);
  await use.page.close();
});

test('the door is not available: every write keeps the older direct request exactly as before, and the door is asked once', { skip }, async () => {
  const { page, door, direct } = await open({ door: () => ({ status: 503, json: { ok: false, code: 'not_ready' } }) });
  await page.evaluate(async () => {
    window.selectCustomerSuggestion = () => {};
    document.body.insertAdjacentHTML('beforeend', '<input id="profile-name-input" value="Sam"><button id="profile-name-save">Save</button>');
    await saveCustomerName('15550001');
    customersCache = []; for (const [k, v] of Object.entries({ 'cf-name': 'Ann', 'cf-phone': '15550001', 'cf-address': 'Street 1' })) document.getElementById(k).value = v;
    currentEditingCustomerId = null; await saveCustomerForm();
    currentEditingCustomerId = 'c7'; await saveCustomerForm();
    document.body.insertAdjacentHTML('beforeend', '<input id="oc-new-phone"><input id="oc-new-name"><input id="oc-new-address">');
    document.getElementById('oc-new-phone').value = '15550002'; document.getElementById('oc-new-name').value = 'Bo'; document.getElementById('oc-new-address').value = 'Road 2';
    await saveNewCustomerFromPOS();
    currentEditingCustomerId = 'c9'; await deleteCurrentCustomer();
  });
  assert.equal(door.length, 1, 'asked once, then remembered');
  assert.deepEqual(direct.map((d) => d.method + ' ' + d.url.split('?')[0]), ['POST customers', 'POST customers', 'PATCH customers', 'POST customers', 'DELETE customers']);
  assert.match(direct[1].body, /"seller_id":"web_s1"/); assert.match(direct[2].url, /customers\?id=eq\.c7/); assert.match(direct[3].url, /on_conflict=phone,seller_id/); assert.match(direct[4].url, /id=eq\.c9/);
  await page.close();
});

test('login problems: no token means no door call and no direct write; the screen shows its own failure message', { skip }, async () => {
  const { page, door, direct, alerts } = await open();
  await page.evaluate(async () => { window.getValidAuthToken = async () => null; document.body.insertAdjacentHTML('beforeend', '<input id="profile-name-input" value="Sam"><button id="profile-name-save">Save</button>'); await saveCustomerName('1'); });
  assert.equal(door.length, 0); assert.deepEqual(direct, []);
  assert.ok(alerts.includes('Failed to save name: Please sign out and sign in again, then try once more.'));
  await page.close();
});
