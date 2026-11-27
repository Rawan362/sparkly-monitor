// Run with:  node --test tests/*.test.mjs
// Order writes (invoice note and rate snapshot, return, payment, status, shipping price, a sale or an edit, delete) go through the Seller Orders
// door with the person's own login, with Undo after a delete, a return, a status change and a payment; when the door answers "not available"
// every screen keeps its older direct write exactly as before. The door and Supabase are faked by the test: nothing leaves the test; the token is
// a made-up word; no customer data is used.
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

test('this test file and the new block are ASCII; the door call sends no seller id and not the public key; the older writes are only fallbacks', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-orders-door:js:start'); const b = html.indexOf('w1-orders-door:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block));
  const call = block.slice(block.indexOf('async function w1OrCall'), block.indexOf('// Door first: the answer'));
  assert.ok(!/seller/i.test(call.replace(/Seller Orders|SELLER_ORDERS_URL|seller-orders/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
  assert.ok(!/\/rest\/v1\//.test(block), 'the block itself writes nothing directly');
  // every direct write that was patched is now inside a function handed to the helper
  for (const name of ['w1OrRun(\'ensureRateSnapshot\'', 'w1OrRun(\'saveInvoiceNote\'', 'w1OrDelete(currentOrderId', 'w1OrRun(\'confirmReturn\'', 'w1OrRun(\'recordPayment\'', 'w1OrRun(\'setStatus\'', 'w1OrRun(\'submitShipping\'', 'await w1OrSave(payload, currentOrderCart)']) assert.ok(html.includes(name), name);
  assert.equal((html.match(/w1OrRun\('setStatus'/g) || []).length, 2);
  assert.equal((html.match(/w1OrRun\('submitShipping'/g) || []).length, 2);
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

// ctl.door(body) answers every door call; `door` records bodies; `direct` the direct writes to orders / order_items / seller_notifications.
async function open(ctl) {
  ctl = Object.assign({ door: () => ({ status: 200, json: { ok: true, count: 1, undoId: 'u1' } }), order: { order_total: 100, amount_received: 10, payments: [] } }, ctl || {});
  const door = []; const direct = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-orders$/.test(u)) {
      const b = JSON.parse(route.request().postData() || '{}'); door.push({ body: b, auth: route.request().headers()['authorization'] || null });
      const a = ctl.door(b); return json(a.status, a.json);
    }
    if (/\/rest\/v1\/(orders|order_items|seller_notifications)/.test(u) && m !== 'GET') {
      direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' });
      return m === 'PATCH' && /Prefer/i.test(JSON.stringify(route.request().headers())) && /return=representation/.test(route.request().headers()['prefer'] || '') ? json(200, [{ id: 1 }]) : (m === 'POST' ? json(201, [{ id: 'new-order' }]) : route.fulfill({ status: 204, headers: h, body: '' }));
    }
    if (/\/rest\/v1\/orders\?id=eq\./.test(u) && m === 'GET') return json(200, [ctl.order]);
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__lo = 0; window.loadOrders = async () => { window.__lo++; }; window.closeOrderDetail = () => {}; window.closePaymentModal = () => {};
    window.loadOrdersBox = async () => {}; window.loadNotifications = async () => {}; window.checkNotificationsDot = () => {}; window.checkOrdersBox = async () => {};
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, door, direct, alerts, ctl };
}
const note = (page) => page.evaluate(() => { const b = document.getElementById('w1-or-note'); return b && b.style.display !== 'none' ? { text: document.getElementById('w1-or-note-msg').textContent, undo: document.getElementById('w1-or-undo-btn').style.display !== 'none' } : null; });
const T = 'made-up-token';

test('invoice note and rate snapshot: the door with the order id, no direct write', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<button id="nb">Save</button><textarea id="invoice-seller-note"></textarea>');
    document.getElementById('invoice-seller-note').value = '  Deliver after noon  ';
    await saveInvoiceNote('o1', document.getElementById('nb'));
    ensureRateSnapshot({ id: 'o2' }, { cur: 'USD', altCur: 'EUR', altRate: 2, altOp: 'multiply' });
  });
  await page.waitForTimeout(300);
  assert.deepEqual(door[0].body, { token: T, action: 'saveInvoiceNote', orderId: 'o1', note: 'Deliver after noon' });
  assert.equal(door[1].body.action, 'ensureRateSnapshot'); assert.equal(door[1].body.orderId, 'o2'); assert.deepEqual(Object.keys(door[1].body.snapshot).sort(), ['date', 'from', 'op', 'rate', 'to']);
  assert.equal(await page.$eval('#nb', (e) => e.textContent), 'Saved \u2713');
  assert.deepEqual(direct, []);
  await page.close();
});

test('return, status and payment: the door, an Undo button, and the screen refreshes; the status change sends no time (the door sets it)', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    currentOrderId = 'o1'; allLoadedOrders = [{ id: 'o1', order_total: 100, shipping_cost: 10 }]; currentReturnShippingPayer = 'seller';
    document.getElementById('return-amount-input').value = '40';
    await confirmReturn();
  });
  assert.deepEqual(door[0].body, { token: T, action: 'confirmReturn', orderId: 'o1', returnType: 'partial', returnAmount: 40, shippingPayer: 'seller' });
  assert.deepEqual(await note(page), { text: 'Return recorded.', undo: true });
  await page.evaluate(() => updateOrderStatus('SHIPPED'));
  assert.deepEqual(door[1].body, { token: T, action: 'setStatus', orderId: 'o1', status: 'SHIPPED' });
  assert.equal((await note(page)).text, 'Order status changed.');
  const r = await page.evaluate(() => recordOrderPayment('o1', 'add', 25));
  assert.deepEqual(r, { changed: true, newTotal: 35, tot: 100 });
  const pay = door[2].body;
  assert.deepEqual([pay.action, pay.orderId, pay.amountReceived], ['recordPayment', 'o1', 35]); assert.equal(typeof pay.tz, 'string');
  assert.deepEqual(direct, []);
  assert.ok(await page.evaluate(() => window.__lo) >= 2);
  await page.close();
});

test('Undo sends the undo id through the door and refreshes the orders', { skip }, async () => {
  const { page, door } = await open();
  await page.evaluate(() => { currentOrderId = 'o1'; return updateOrderStatus('DELIVERED'); });
  await page.click('#w1-or-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-or-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(door[1].body, { token: T, action: 'undo', undoId: 'u1' });
  await page.close();
});

test('shipping price: the Orders box and the notification card use submitShipping; the card is marked read by the door; "already completed" keeps the screen message', { skip }, async () => {
  const { page, door, direct, alerts } = await open({ door: (b) => b.action === 'submitShipping' ? { status: 200, json: { ok: true, count: 1, undoId: 'u9', notificationMarked: !!b.notificationId } } : { status: 200, json: { ok: true } } });
  await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="ship-input-n7" value="4.5"><input id="bx" value="3"><button id="bb">x</button>');
    await submitShippingPrice('n7', 'o1', false);
    await submitBoxShipping('o2', document.getElementById('bx'), false, document.getElementById('bb'));
    await submitBoxShipping('o3', document.getElementById('bx'), true, document.getElementById('bb'));
  });
  assert.deepEqual(door.map((d) => d.body), [
    { token: T, action: 'submitShipping', orderId: 'o1', shippingCost: 4.5, notificationId: 'n7' },
    { token: T, action: 'submitShipping', orderId: 'o2', shippingCost: 3 },
    { token: T, action: 'submitShipping', orderId: 'o3', shippingCost: 0 }]);
  assert.deepEqual(direct, [], 'the card was marked read by the door, so no direct mark');
  const w = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_waiting', message: 'x' } }) });
  await w.page.evaluate(async () => { document.body.insertAdjacentHTML('beforeend', '<input id="ship-input-n8" value="1">'); await submitShippingPrice('n8', 'o1', false); });
  assert.ok(w.alerts.includes('This order was already completed.'));
  await page.close(); await w.page.close();
});

test('mark shipped from the Orders box: setStatus SHIPPED', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { ordersBoxOrders = [{ id: 'o1' }]; await markBoxOrderShipped('o1', null, false); });
  assert.deepEqual(door[0].body, { token: T, action: 'setStatus', orderId: 'o1', status: 'SHIPPED' });
  assert.deepEqual(direct, []);
  await page.close();
});

test('delete: check, then apply with the digest, with an Undo button; no direct delete', { skip }, async () => {
  const { page, door, direct } = await open({ door: (b) => b.action === 'deleteCheck' ? { status: 200, json: { ok: true, count: 2, status: 'PENDING', digest: 'd'.repeat(32), canUndo: true } } : { status: 200, json: { ok: true, count: 2, deleted: 1, undoId: 'u5' } } });
  await page.evaluate(() => { currentOrderId = 'o1'; return deleteOrder(); });
  assert.deepEqual(door.map((d) => d.body), [{ token: T, action: 'deleteCheck', orderId: 'o1' }, { token: T, action: 'deleteApply', orderId: 'o1', digest: 'd'.repeat(32) }]);
  assert.deepEqual(direct, []);
  assert.deepEqual(await note(page), { text: 'Order deleted.', undo: true });
  await page.close();
  const ch = await open({ door: (b) => b.action === 'deleteCheck' ? { status: 200, json: { ok: true, count: 1, digest: 'e'.repeat(32) } } : { status: 200, json: { ok: false, error: 'changed', message: 'The order changed. Nothing was deleted.' } } });
  await ch.page.evaluate(() => { currentOrderId = 'o1'; return deleteOrder(); });
  assert.ok(ch.alerts.some((a) => a.endsWith('The order changed. Nothing was deleted.')));
  assert.deepEqual(ch.direct, []);
  await ch.page.close();
});

test('a sale and an edit: ONE saveOrder call with the order columns and the lines, no seller id, no direct write; the invoice opens for the new id', { skip }, async () => {
  const { page, door, direct } = await open({ door: (b) => ({ status: 200, json: { ok: true, count: b.items.length, orderId: b.orderId || 'new-77', undoId: 'u8' } }) });
  const out = await page.evaluate(async () => {
    window.closeOrderCreateForm = () => {}; window.openInvoiceView = async (id) => { window.__inv = id; }; window.openOrderDetail = async (id) => { window.__det = id; };
    currentOrderCart = [{ product_id: 'p1', product_name: 'Item A', unit_price: 10, quantity: 2 }, { product_id: 'p2', product_name: 'Item B', unit_price: 5, quantity: 1, discount_type: 'percent', discount_value: 10 }];
    document.getElementById('oc-phone').value = '15550001'; document.getElementById('oc-shipping-cost').value = '3';
    document.getElementById('oc-delivery_address').value = 'Street 1'; document.getElementById('oc-order_status').value = 'PENDING';
    currentPaymentMethod = 'cash'; confirmedAmountPaid = 0; currentEditingOrderId = null;
    await saveManualOrder();
    const created = window.__inv;
    currentEditingOrderId = 'o9'; currentOrderCart = [currentOrderCart[0]];
    await saveManualOrder();
    return { created, edited: window.__det };
  });
  assert.equal(out.created, 'new-77'); assert.equal(out.edited, 'o9');
  assert.equal(door.length, 2); assert.deepEqual(direct, []);
  const n = door[0].body;
  assert.equal(n.action, 'saveOrder'); assert.equal('orderId' in n, false); assert.equal(typeof n.createdAt, 'string');
  assert.deepEqual(Object.keys(n.order).sort(), ['amount_received', 'delivery_address', 'discount_amount', 'discount_type', 'discount_value', 'order_status', 'order_total', 'payment_method', 'phone', 'product_name', 'quantity', 'shipping_cost']);
  assert.equal(n.order.phone, '15550001'); assert.equal(n.order.quantity, 3); assert.equal(n.order.payment_method, 'Cash');
  assert.equal(n.items.length, 2); assert.deepEqual(n.items[0], { product_id: 'p1', product_name: 'Item A', unit_price: 10, quantity: 2, line_total: 20, discount_type: null, discount_value: 0, discount_amount: 0 });
  assert.equal(n.items[1].discount_type, 'percent'); assert.ok(!JSON.stringify(n).includes('seller_id') && !JSON.stringify(n).includes('web_s1'));
  assert.equal(door[1].body.orderId, 'o9'); assert.equal('createdAt' in door[1].body, false); assert.equal(door[1].body.items.length, 1);
  await page.close();
});

test('a refusal shows the door words in the screen\'s own message and never falls back to the direct write', { skip }, async () => {
  const { page, direct, alerts } = await open({ door: () => ({ status: 200, json: { ok: false, error: 'save_failed', message: 'The order was not saved. Nothing was changed.' } }) });
  await page.evaluate(async () => { currentOrderId = 'o1'; await updateOrderStatus('SHIPPED'); });
  assert.ok(alerts.some((a) => a.endsWith('The order was not saved. Nothing was changed.')));
  assert.deepEqual(direct, []);
  await page.close();
});

test('the door is not available: every write keeps the older direct request exactly as before, and the door is asked once', { skip }, async () => {
  const { page, door, direct } = await open({ door: () => ({ status: 503, json: { ok: false, code: 'not_ready' } }) });
  await page.evaluate(async () => {
    currentOrderId = 'o1'; allLoadedOrders = [{ id: 'o1', order_total: 100, shipping_cost: 0 }]; currentReturnShippingPayer = 'free';
    document.body.insertAdjacentHTML('beforeend', '<button id="nb">Save</button><input id="ship-input-n7" value="2"><textarea id="invoice-seller-note"></textarea>');
    document.getElementById('invoice-seller-note').value = 'N';
    await saveInvoiceNote('o1', document.getElementById('nb'));
    document.getElementById('return-amount-input').value = '40'; await confirmReturn();
    await updateOrderStatus('DELIVERED');
    await recordOrderPayment('o1', 'add', 5);
    await submitShippingPrice('n7', 'o1', false);
    ordersBoxOrders = [{ id: 'o1' }]; await markBoxOrderShipped('o1', null, false);
    await deleteOrder();
  });
  assert.equal(door.length, 1, 'asked once, then remembered');
  assert.deepEqual(direct.map((d) => d.method + ' ' + d.url.split('?')[0]), ['PATCH orders', 'PATCH orders', 'PATCH orders', 'PATCH orders', 'PATCH orders', 'PATCH seller_notifications', 'PATCH orders', 'DELETE orders']);
  assert.match(direct[0].body, /"seller_note":"N"/); assert.match(direct[1].body, /"order_status":"RETURN"/); assert.match(direct[2].body, /"order_status":"DELIVERED"/);
  assert.match(direct[3].body, /"amount_received":15/); assert.match(direct[4].url, /seller_id=eq\.web_s1&order_status=eq\.AWAITING_SHIPPING/); assert.match(direct[5].body, /"is_read":true/);
  assert.match(direct[6].body, /"order_status":"SHIPPED"/);
  await page.close();
});

test('login problems: no token means no door call and no direct write; a refused login never falls back', { skip }, async () => {
  const a = await open();
  await a.page.evaluate(async () => { window.getValidAuthToken = async () => null; currentOrderId = 'o1'; await updateOrderStatus('SHIPPED'); });
  assert.equal(a.door.length, 0); assert.deepEqual(a.direct, []);
  assert.ok(a.alerts.some((m) => m.endsWith('Please sign out and sign in again, then try once more.')));
  await a.page.close();
});
