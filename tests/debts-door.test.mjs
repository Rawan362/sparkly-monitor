// Run with:  node --test tests/*.test.mjs
// The Debts screen reads orders, debt payments and customer names through the Seller Debts Reads door (backend PR 317, port 5099), with the older
// direct reads kept as the fallback. The door, the database and the page are faked by the test (vm, a tiny fake page): nothing leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function between(startNeedle, endNeedle) {
  const a = html.indexOf(startNeedle);
  const b = html.indexOf(endNeedle, a);
  assert.ok(a > 0 && b > a, startNeedle + ' missing');
  return html.slice(a, b);
}
const blockOf = (name) => between('// <' + name + ':js:start>', '// <' + name + ':js:end>');
function functionOf(head) {
  const a = html.indexOf(head);
  assert.ok(a > 0, head + ' missing');
  let depth = 0, i = html.indexOf('{', a);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(a, i + 1);
}
const LOAD = () => functionOf('async function loadDebts(');
const DETAIL = () => functionOf('async function renderDebtDetail(');
const ALERTS = () => functionOf('async function loadAlerts(');
const REPORTS = () => functionOf('async function loadReports(');

test('the new code and this test file contain only ASCII characters', () => {
  const added = [LOAD(), DETAIL(), ALERTS(), REPORTS()].join('\n').split('\n').filter((l) => /door|Door|W3-|w3Debts/.test(l)).join('\n');
  for (const [name, text] of Object.entries({ block: blockOf('w3-debts-reads-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') }))
    assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and the older direct reads of Alerts and Reports are still in the file', () => {
  for (const needle of ["'&order_status=eq.PENDING&created_at=lte.' + twoDaysAgo + '&select=phone,product_name,order_total,created_at&limit=10'", "'&last_reply_date=lte.' + fourteenDaysAgo + '&list_status=eq.WARM&select=phone,name,total_orders&limit=10'",
    "'&order_status=eq.DELIVERED&cod_collected=eq.false&select=phone,product_name,order_total&limit=10'", "'&is_active=eq.true&track_stock=eq.true&select=product_name,stock_quantity,low_stock_threshold'"])
    assert.ok(ALERTS().includes(needle), needle);
  for (const needle of ["'&created_at=gte.' + weekAgo + '&select=order_total,order_status,product_name,bump_accepted,bump_value,upsell_accepted,upsell_value'", "'&created_at=gte.' + twoWeeksAgo + '&created_at=lte.' + weekAgo + '&select=order_total'",
    "'&select=order_total,order_status'", "'&last_reply_date=lte.' + fourteenDaysAgo + '&select=phone&limit=200'"])
    assert.ok(REPORTS().includes(needle), needle);
});

test('the cache name is bumped and the four older direct reads of Debts are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 318);
  assert.ok(LOAD().includes("'&order_status=neq.CANCELLED&select=phone,order_total,amount_received'"));
  assert.ok(LOAD().includes("'&select=phone,name'"));
  assert.ok(DETAIL().includes("&select=id,order_total,amount_received,created_at,product_name&order=created_at.asc'"));
  assert.ok(DETAIL().includes("&select=amount,payment_date&order=payment_date.desc'"));
});

test('every inline script parses and every style block has balanced braces', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type=["'](application\/json|application\/ld\+json|text\/template)/.test(m[1]));
  assert.ok(scripts.length > 0);
  for (const m of scripts) new vm.Script(m[2]);
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const css = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
  }
});

const ORDERS = [{ phone: '111', order_total: 100, amount_received: 40 }, { phone: '111', order_total: 50, amount_received: null }, { phone: '222', order_total: 30, amount_received: 30 }];
const DETAIL_ORDERS = [{ id: 5, order_total: 100, amount_received: 40, created_at: '2026-11-01T10:00:00Z', product_name: 'Shirt' }];
const PAYMENTS = [{ amount: 40, payment_date: '2026-11-02T10:00:00Z' }];

function world(over = {}) {
  const calls = { door: [], direct: [] };
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', value: '', style: {}, classList: { add() {}, remove() {}, toggle() {} } });
  const sandbox = {
    calls, els, JSON, Date, Object, Promise, setTimeout, String, Array, encodeURIComponent, Number,
    SELLER_CHAT_ID: '111', SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon',
    document: { getElementById: el }, debugLog() {}, ensureSellerCurrency: async () => 'USD', currencyCodeToSymbol: () => '$', escapeHtml: (x) => String(x),
    renderDebtsList() {}, debtsCurrencySymbol: '', cachedDebtors: [], cachedDebtorNames: {}, currentDebtDetailPhone: '111', currentDebtDetailOrders: [],
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token')
  };
  sandbox.fetch = async (url, init) => {
    if (url.includes('/webhook/seller-debts-reads')) {
      const body = JSON.parse(init.body);
      calls.door.push({ url, body });
      const a = over.door ? over.door(body) : { status: 503 };
      if (a.throws) throw new Error('network');
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
    }
    calls.direct.push(url);
    let data = [];
    if (url.includes('/rest/v1/orders') && url.includes('phone=eq.')) data = DETAIL_ORDERS;
    else if (url.includes('/rest/v1/orders') && url.includes('order_status=eq.PENDING')) data = [{ phone: '333', product_name: 'Hat', order_total: 20, created_at: '2026-11-01T00:00:00Z' }];
    else if (url.includes('/rest/v1/orders') && url.includes('cod_collected')) data = [{ phone: '444', product_name: 'Cap', order_total: 15 }];
    else if (url.includes('/rest/v1/orders') && url.includes('select=order_total,order_status,product_name')) data = [{ order_total: 100, order_status: 'DELIVERED', product_name: 'Shirt', bump_accepted: true, bump_value: 5, upsell_accepted: false, upsell_value: 0 }];
    else if (url.includes('/rest/v1/orders') && url.includes('select=order_total,order_status') && !url.includes('created_at')) data = [{ order_total: 100, order_status: 'DELIVERED' }, { order_total: 50, order_status: 'DELIVERED' }];
    else if (url.includes('/rest/v1/orders') && url.includes('select=order_total')) data = [{ order_total: 50, order_status: 'DELIVERED' }];
    else if (url.includes('/rest/v1/orders')) data = ORDERS;
    else if (url.includes('/rest/v1/seller_products')) data = [{ product_name: 'Socks', stock_quantity: 1, low_stock_threshold: 5 }];
    else if (url.includes('/rest/v1/customers') && url.includes('list_status=eq.WARM')) data = [{ phone: '555', name: 'Ali', total_orders: 2 }];
    else if (url.includes('/rest/v1/customers') && url.includes('last_reply_date')) data = [{ phone: '555' }, { phone: '556' }];
    else if (url.includes('/rest/v1/debt_payments')) data = PAYMENTS;
    else if (url.includes('/rest/v1/customers')) data = [{ phone: '111', name: 'Sara' }];
    return { ok: true, status: 200, json: async () => data };
  };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w3-debts-reads-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ') + '\n' + LOAD() + '\n' + DETAIL() + '\n' + ALERTS() + '\n' + REPORTS(), sandbox);
  return sandbox;
}
const run = (w, code) => vm.runInContext(code, w);
const plain = (v) => JSON.parse(JSON.stringify(v));
const READ_OK = (rows) => ({ body: { ok: true, table: 't', count: rows.length, truncated: false, rows } });

test('the debts list through the door: the orders and the customer names come from the door with the login token, no seller id and no direct read', async () => {
  const w = world({ door: (b) => READ_OK(b.table === 'orders' ? ORDERS : [{ phone: '111', name: 'Sara' }]) });
  await run(w, 'loadDebts()');
  assert.equal(w.calls.direct.length, 0);
  const orders = w.calls.door.find((c) => c.body.table === 'orders').body;
  assert.deepEqual(plain(orders), { token: 'login-token', action: 'read', limit: 5000, table: 'orders', select: ['phone', 'order_total', 'amount_received'], filters: [{ column: 'order_status', op: 'neq', value: 'CANCELLED' }] });
  const names = w.calls.door.find((c) => c.body.table === 'customers').body;
  assert.equal(names.limit, 2000);
  assert.equal('seller_id' in orders, false);
  assert.deepEqual(plain(run(w, 'cachedDebtors')), [{ phone: '111', debt: 110 }]);
  assert.deepEqual(plain(run(w, 'cachedDebtorNames')), { 111: 'Sara' });
});

test('the debt detail through the door: ONE batch call carries both reads and the same totals are built', async () => {
  const w = world({ door: (b) => ({ body: { ok: true, count: 2, results: [{ ok: true, rows: DETAIL_ORDERS, truncated: false }, { ok: true, rows: PAYMENTS, truncated: false }] } }) });
  await run(w, 'renderDebtDetail()');
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.door.length, 1);
  const b = plain(w.calls.door[0].body);
  assert.equal(b.action, 'batch');
  assert.deepEqual(b.reads.map((r) => r.table), ['orders', 'debt_payments']);
  assert.deepEqual(b.reads[0].filters, [{ column: 'phone', op: 'eq', value: '111' }, { column: 'order_status', op: 'neq', value: 'CANCELLED' }]);
  assert.deepEqual(b.reads[0].order, [{ column: 'created_at', dir: 'asc' }]);
  assert.deepEqual(b.reads[1].order, [{ column: 'payment_date', dir: 'desc' }]);
  assert.ok(w.els['debt-detail-content'].innerHTML.includes('Total Outstanding'));
  assert.ok(w.els['debt-detail-content'].innerHTML.includes('60'));
});

test('an answer cut at the door limit is NOT used (a debt total from part of the orders would be wrong): the direct read runs', async () => {
  const w = world({ door: () => ({ body: { ok: true, table: 'orders', count: 5000, truncated: true, rows: [{ phone: '999', order_total: 1, amount_received: 0 }] } }) });
  await run(w, 'loadDebts()');
  assert.equal(plain(run(w, 'cachedDebtors')).length, 1);
  assert.equal(plain(run(w, 'cachedDebtors'))[0].phone, '111');
  assert.ok(w.calls.direct.some((u) => u.includes('/rest/v1/orders')));
  const d = world({ door: () => ({ body: { ok: true, count: 2, results: [{ ok: true, rows: [], truncated: true }, { ok: true, rows: [], truncated: false }] } }) });
  await run(d, 'renderDebtDetail()');
  assert.equal(d.calls.direct.length, 2);
});

test('503, 404, 502, 429, a refusal, a network problem or no login: the older direct reads run as before', async () => {
  for (const over of [
    { door: () => ({ status: 503, body: {} }) }, { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) },
    { door: () => ({ status: 429, body: {} }) }, { door: () => ({ body: { ok: false, error: 'not_available' } }) },
    { door: () => ({ body: { ok: false, error: 'not_logged_in' } }) }, { door: () => ({ throws: true }) }, { noLogin: true }
  ]) {
    const w = world(over);
    await run(w, 'loadDebts()');
    assert.equal(plain(run(w, 'cachedDebtors'))[0].debt, 110);
    assert.equal(w.calls.direct.length, 2);   // the orders and the customer names
    const d = world(over);
    await run(d, 'renderDebtDetail()');
    assert.equal(d.calls.direct.length, 2);   // the orders and the debt payments
    assert.ok(d.els['debt-detail-content'].innerHTML.includes('Shirt'));
  }
});

test('a batch with a failed read or the wrong number of answers is not used', async () => {
  for (const results of [[{ ok: false, error: 'bad_table' }, { ok: true, rows: [], truncated: false }], [{ ok: true, rows: [], truncated: false }]]) {
    const w = world({ door: () => ({ body: { ok: true, count: results.length, results } }) });
    await run(w, 'renderDebtDetail()');
    assert.equal(w.calls.direct.length, 2);
  }
});

test('after a 429 or 503 the door is left alone for a while', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }) });
  await run(w, 'loadDebts()');
  await run(w, 'renderDebtDetail()');
  assert.equal(w.calls.door.length, 1);
});

// ---- Alerts and Reports (the older panels that still read the tables directly) ----
function doorForAlertsReports(b) {
  if (b.action === 'batch') return { body: { ok: true, count: 3, results: [
    { ok: true, rows: [{ order_total: 100, order_status: 'DELIVERED', product_name: 'Shirt', bump_accepted: true, bump_value: 5, upsell_accepted: false, upsell_value: 0 }], truncated: false },
    { ok: true, rows: [{ order_total: 50 }], truncated: false },
    { ok: true, rows: [{ order_total: 100, order_status: 'DELIVERED' }, { order_total: 50, order_status: 'DELIVERED' }], truncated: false }] } };
  if (b.table === 'orders' && b.filters.some((f) => f.value === 'PENDING')) return READ_OK([{ phone: '333', product_name: 'Hat', order_total: 20, created_at: '2026-11-01T00:00:00Z' }]);
  if (b.table === 'orders') return READ_OK([{ phone: '444', product_name: 'Cap', order_total: 15 }]);
  if (b.table === 'seller_products') return READ_OK([{ product_name: 'Socks', stock_quantity: 1, low_stock_threshold: 5 }]);
  if (b.filters.some((f) => f.column === 'list_status')) return READ_OK([{ phone: '555', name: 'Ali', total_orders: 2 }]);
  return { body: { ok: true, table: 'customers', count: 200, truncated: true, rows: [{ phone: '555' }, { phone: '556' }] } };   // a "first 200" list is cut on purpose
}

test('alerts through the door: the four reads are door reads (small limits allowed to be cut, booleans as "is"), with no direct read and the same cards', async () => {
  const w = world({ door: doorForAlertsReports });
  await run(w, 'loadAlerts()');
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.door.length, 4);
  const bodies = w.calls.door.map((c) => plain(c.body));
  assert.deepEqual(bodies.map((b) => b.table), ['orders', 'customers', 'orders', 'seller_products']);
  assert.deepEqual(bodies.map((b) => b.limit), [10, 10, 10, 2000]);
  assert.deepEqual(bodies[2].filters, [{ column: 'order_status', op: 'eq', value: 'DELIVERED' }, { column: 'cod_collected', op: 'is', value: false }]);
  assert.deepEqual(bodies[3].filters, [{ column: 'is_active', op: 'is', value: true }, { column: 'track_stock', op: 'is', value: true }]);
  for (const b of bodies) { assert.equal('allowCut' in b, false); assert.equal('seller_id' in b, false); assert.equal('chat_id' in b, false); }
  const out = w.els['alerts-list'].innerHTML;
  for (const t of ['Overdue Orders (1)', 'Silent Customers (1)', 'Cash Not Collected (1)', 'Low Stock (1)']) assert.ok(out.includes(t), t);
});

test('alerts: a cut "first 10" list is used, but a cut full list (low stock) is not', async () => {
  const cut = (rows) => ({ body: { ok: true, table: 't', count: rows.length, truncated: true, rows } });
  const w = world({ door: (b) => (b.table === 'seller_products' ? cut([{ product_name: 'Socks', stock_quantity: 1, low_stock_threshold: 5 }]) : cut([{ phone: '9', product_name: 'x', order_total: 1, created_at: '2026-11-01T00:00:00Z', name: 'n', total_orders: 1 }])) });
  await run(w, 'loadAlerts()');
  assert.equal(w.calls.direct.length, 1);
  assert.ok(w.calls.direct[0].includes('/rest/v1/seller_products'));
  assert.ok(w.els['alerts-list'].innerHTML.includes('Overdue Orders (1)'));
});

test('alerts fall back to the four older direct reads on 503, 404, 502, 429, a refusal, a network problem and no login', async () => {
  for (const over of [
    { door: () => ({ status: 503, body: {} }) }, { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) }, { door: () => ({ status: 429, body: {} }) },
    { door: () => ({ body: { ok: false, error: 'not_available' } }) }, { door: () => ({ throws: true }) }, { noLogin: true }
  ]) {
    const w = world(over);
    await run(w, 'loadAlerts()');
    assert.equal(w.calls.direct.length, 4);
    const out = w.els['alerts-list'].innerHTML;
    for (const t of ['Overdue Orders (1)', 'Silent Customers (1)', 'Cash Not Collected (1)', 'Low Stock (1)']) assert.ok(out.includes(t), t);
  }
});

test('reports through the door: ONE batch for the three order reads and one small read for silent customers, with the same numbers on screen', async () => {
  const w = world({ door: doorForAlertsReports });
  await run(w, 'loadReports()');
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.door.length, 2);
  const batch = plain(w.calls.door[0].body);
  assert.equal(batch.action, 'batch');
  assert.deepEqual(batch.reads.map((r) => r.table), ['orders', 'orders', 'orders']);
  assert.equal(batch.reads[1].filters.length, 2);
  const silent = plain(w.calls.door[1].body);
  assert.equal(silent.limit, 200);
  assert.deepEqual(silent.select, ['phone']);
  const out = w.els['reports-content'].innerHTML;
  assert.ok(out.includes('report-stat-value">1<'));   // one order this week
});

test('reports fall back to the four older direct reads when the door cannot answer, and show the same numbers', async () => {
  const doorW = world({ door: doorForAlertsReports });
  await run(doorW, 'loadReports()');
  for (const over of [{ door: () => ({ status: 503, body: {} }) }, { door: () => ({ body: { ok: false, error: 'not_logged_in' } }) }, { door: () => ({ throws: true }) }, { noLogin: true }]) {
    const w = world(over);
    await run(w, 'loadReports()');
    assert.equal(w.calls.direct.length, 4);
    assert.equal(w.els['reports-content'].innerHTML, doorW.els['reports-content'].innerHTML);
  }
});
