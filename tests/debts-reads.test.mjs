// Run with:  node --test tests/*.test.mjs
// The Debts, Alerts and Reports reads go through the Seller Debts Reads door with the person's own login: the screen's own address is turned into a
// door request (table, columns, filters, order, limit; no owner filter, no seller id) and the answer has the shape the screen already got. The older
// direct read runs when the door is down or not available (503, 404, 502, 429, the connection fails, not understood, a request the door does not
// take; then 30 seconds off) or when this device has no login; a refused login is not read the older way. The door and Supabase are faked by the
// test: nothing leaves the test; the token is a made-up word; no real rows.
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

test('this test file and the new block are ASCII; the door call sends no seller id and not the public key; the block reads nothing directly; the 12 reads use the helper', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-debts-reads:js:start'); const b = html.indexOf('w1-debts-reads:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block));
  assert.ok(!/fetch\(SUPABASE_URL|apikey/.test(block), 'the block makes no direct read of its own');
  const call = block.slice(block.indexOf('async function w1RdTry'), block.indexOf('// A drop-in'));
  assert.ok(!/seller/i.test(call.replace(/Seller Debts Reads|SELLER_DEBTS_READS_URL|seller-debts-reads|no_seller/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
  assert.equal((html.match(/w1RdFetch\(SUPABASE_URL/g) || []).length, 12);
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

async function open(ctl, token) {
  ctl = Object.assign({ door: (b) => ({ status: 200, json: { ok: true, count: 1, truncated: false, rows: b.table === 'orders' ? [{ id: 'o1', phone: '15550001', order_total: 100, amount_received: 40, order_status: 'PENDING', product_name: 'Item', created_at: '2026-11-01T00:00:00Z' }] : (b.table === 'customers' ? [{ phone: '15550001', name: 'Sam', total_orders: 1 }] : []) } }) }, ctl || {});
  const door = []; const direct = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => d.accept());
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-debts-reads$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); const a = ctl.door(b); return a === 'abort' ? route.abort() : (a.raw !== undefined ? route.fulfill({ status: a.status, contentType: 'text/html', headers: h, body: a.raw }) : json(a.status, a.json)); }
    if (/\/rest\/v1\/(orders|customers|debt_payments|seller_products)\?/.test(u) && m === 'GET') { direct.push(u.replace(/^.*\/rest\/v1\//, '')); return json(200, []); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate((tk) => { SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => tk; const l = document.getElementById('login-overlay'); if (l) l.remove(); }, token === undefined ? 'made-up-token' : token);
  door.length = 0; direct.length = 0;
  return { page, door, direct, ctl };
}
const T = 'made-up-token';

test('the translator: columns, filters of every kind, order and limit; the owner filter is dropped; no limit asks for the table\'s largest; what it does not understand is not translated', { skip }, async () => {
  const { page } = await open();
  const out = await page.evaluate(() => [
    w1RdParse('https://x/rest/v1/orders?seller_id=eq.web_s1&order_status=neq.CANCELLED&select=phone,order_total'),
    w1RdParse('https://x/rest/v1/orders?seller_id=eq.web_s1&phone=eq.' + encodeURIComponent('+1 555') + '&select=id&order=created_at.asc&limit=10'),
    w1RdParse('https://x/rest/v1/seller_products?chat_id=eq.web_s1&is_active=eq.true&track_stock=is.true&select=*'),
    w1RdParse('https://x/rest/v1/orders?seller_id=eq.web_s1&created_at=gte.2026-11-01T00:00:00.000Z&created_at=lte.2026-11-08T00:00:00.000Z&order_status=in.(A,B)'),
    w1RdParse('https://x/rest/v1/customers?seller_id=eq.web_s1&limit=99999'),
    w1RdParse('https://x/rest/v1/orders?seller_id=eq.web_s1&select=*,customers(name)'),
    w1RdParse('https://x/rest/v1/orders?seller_id=eq.web_s1&phone=like.*5'),
    w1RdParse('https://x/rest/v1/other_table?seller_id=eq.web_s1'),
    w1RdParse('https://x/rest/v1/orders?id=eq.5&seller_id=neq.web_s1')
  ]);
  assert.deepEqual(out[0], { action: 'read', table: 'orders', filters: [{ column: 'order_status', op: 'neq', value: 'CANCELLED' }], select: ['phone', 'order_total'], limit: 5000 });
  assert.deepEqual(out[1], { action: 'read', table: 'orders', filters: [{ column: 'phone', op: 'eq', value: '+1 555' }], select: ['id'], order: [{ column: 'created_at', dir: 'asc' }], limit: 10 });
  assert.deepEqual(out[2], { action: 'read', table: 'seller_products', filters: [{ column: 'is_active', op: 'eq', value: 'true' }, { column: 'track_stock', op: 'is', value: true }], limit: 2000 });
  assert.deepEqual(out[3].filters, [{ column: 'created_at', op: 'gte', value: '2026-11-01T00:00:00.000Z' }, { column: 'created_at', op: 'lte', value: '2026-11-08T00:00:00.000Z' }, { column: 'order_status', op: 'in', value: ['A', 'B'] }]);
  assert.equal(out[4].limit, 2000, 'never above the door\'s maximum');
  assert.deepEqual(out.slice(5), [null, null, null, null]);
  await page.close();
});

test('the screens use the door: Debts (list and one customer), Alerts and Reports send exactly their reads, with no owner filter and no seller id, and nothing is read directly', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    currentDebtDetailPhone = '15550001';
    await loadDebts(); await renderDebtDetail(); await loadAlerts(); await loadReports();
  });
  assert.deepEqual(direct, []);
  assert.ok(door.every((b) => b.token === T && b.action === 'read' && !JSON.stringify(b).includes('web_s1') && !('seller_id' in b) && !('chat_id' in b)));
  const sig = door.map((b) => b.table + ':' + (b.select || ['*']).join(',') + ':' + b.filters.map((f) => f.column + ' ' + f.op).join('|'));
  for (const want of [
    'orders:phone,order_total,amount_received:order_status neq',
    'customers:phone,name:',
    'orders:id,order_total,amount_received,created_at,product_name:phone eq|order_status neq',
    'debt_payments:amount,payment_date:phone eq',
    'orders:phone,product_name,order_total,created_at:order_status eq|created_at lte',
    'customers:phone,name,total_orders:last_reply_date lte|list_status eq',
    'orders:phone,product_name,order_total:order_status eq|cod_collected eq',
    'seller_products:product_name,stock_quantity,low_stock_threshold:is_active eq|track_stock eq',
    'orders:order_total,order_status,product_name,bump_accepted,bump_value,upsell_accepted,upsell_value:created_at gte',
    'orders:order_total:created_at gte|created_at lte',
    'orders:order_total,order_status:',
    'customers:phone:last_reply_date lte']) assert.ok(sig.includes(want), want + '\nGOT\n' + sig.join('\n'));
  assert.equal(door.length, 12);
  await page.close();
});

test('the rows come back in the shape the screen already had: a customer with a debt is shown', { skip }, async () => {
  const { page } = await open({ door: (b) => ({ status: 200, json: { ok: true, count: 1, truncated: false, rows: b.table === 'orders' ? [{ phone: '15550001', order_total: 100, amount_received: 40 }] : [{ phone: '15550001', name: 'Sam' }] } }) });
  const text = await page.evaluate(async () => { await loadDebts(); return document.getElementById('debts-list').textContent + ' ' + document.getElementById('debts-total-banner').textContent; });
  assert.match(text, /Sam/); assert.match(text, /60/);
  await page.close();
});

test('the door is down or not available (503, 404, 502, 429, the connection fails, not understood, another door answer): the older reads run, and the door is left alone for 30 seconds', { skip }, async () => {
  const cases = [{ status: 503, json: {} }, { status: 404, json: {} }, { status: 502, json: {} }, { status: 429, json: {} }, 'abort', { status: 200, raw: '<html>', json: null }, { status: 200, json: { ok: false, error: 'not_available', message: 'x' } }, { status: 200, json: { ok: false, error: 'bad_column', message: 'x' } }, { status: 200, json: { ok: false, error: 'read_failed', message: 'x' } }];
  for (const down of cases) {
    const { page, door, direct } = await open({ door: () => down });
    await page.evaluate(async () => { currentDebtDetailPhone = '15550001'; await loadDebts(); });
    assert.equal(door.length, 1, 'asked once, then left alone');
    assert.equal(direct.length, 1, 'the older read ran (the customers are read only when a debt exists)');
    assert.match(direct[0], /^orders\?seller_id=eq\.web_s1&order_status=neq\.CANCELLED/);
    await page.evaluate(() => { W1_RD.pausedUntil = Date.now() - 1; return loadReports(); });
    assert.ok(door.length >= 2, 'asked again after the pause');
    await page.close();
  }
});

test('a refused login is not read the older way; no login on this device runs the older reads', { skip }, async () => {
  const r = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  const err = await r.page.evaluate(async () => { try { await w1RdTry('https://x/rest/v1/orders?seller_id=eq.web_s1&select=id'); return 'no error'; } catch (e) { return e.message; } });
  assert.equal(err, 'Please sign out and sign in again, then try once more.'); assert.deepEqual(r.direct, []);
  await r.page.close();
  const n = await open({}, null);
  await n.page.evaluate(async () => { currentDebtDetailPhone = '1'; await loadDebts(); });
  assert.equal(n.door.length, 0); assert.equal(n.direct.length, 1);
  await n.page.close();
});
