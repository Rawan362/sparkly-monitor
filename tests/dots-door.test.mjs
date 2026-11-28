// Run with:  node --test tests/*.test.mjs
// The three 15 s dots (Orders box count, Inbox dot, Notifications dot) read ONE answer from the Seller Counts door, with the older
// direct reads kept as the fallback. The door and the database are faked by the test (vm, no browser): nothing leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function blockOf(name) {
  const a = html.indexOf('// <' + name + ':js:start>');
  const b = html.indexOf('// <' + name + ':js:end>');
  assert.ok(a > 0 && b > a, name + ' block missing');
  return html.slice(a, b);
}
function functionOf(name) {
  const a = html.indexOf('async function ' + name + '(');
  assert.ok(a > 0, name + ' missing');
  let depth = 0, i = html.indexOf('{', a);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(a, i + 1);
}

test('the new code and this test file contain only ASCII characters', () => {
  const files = { block: blockOf('w3-dots-door'), orders: functionOf('checkOrdersBox'), inbox: functionOf('checkInboxDot'), notes: functionOf('checkNotificationsDot'), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped, the three older reads and the three timers are in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 312);
  assert.ok(html.includes("sb('orders?seller_id=eq.' + encodeURIComponent(SELLER_CHAT_ID) + '&order_status=in.(PENDING,AWAITING_SHIPPING)&select=id&limit=100')"));
  assert.ok(html.includes("sb('pending_questions?seller_id=eq.' + SELLER_CHAT_ID + '&status=in.(pending,lesson)&select=id&limit=1')"));
  assert.ok(html.includes("sb('seller_notifications?seller_id=eq.' + SELLER_CHAT_ID + '&is_read=eq.false&select=id&limit=1')"));
  assert.ok(html.includes('setInterval(function() { checkInboxDot(true); }, 15000)'));
  assert.ok(html.includes('setInterval(function() { checkNotificationsDot(true); }, 15000)'));
  assert.ok(html.includes('setInterval(function() { checkOrdersBox(true); }, 15000)'));
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

function world(over = {}) {
  const calls = { door: [], rest: [] };
  const state = { count: undefined, titles: [], dots: {}, loadedOrders: 0 };
  const classes = { 'bc-inbox-dot': false, 'chats-inbox-dot': false, 'bc-notifications-dot': false };
  const el = (id) => ({ classList: { toggle: (c, v) => { classes[id] = !!v; }, remove() {}, add() {} }, textContent: '', style: {}, offsetWidth: 0 });
  const sandbox = {
    SELLER_CHAT_ID: '111', calls, state, classes, JSON, Date, Object, Promise, setTimeout, encodeURIComponent, String,
    ordersBoxLastCount: null,
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token'),
    setOrdersBoxCount: (n) => { state.count = n; },
    loadOrdersBox: () => { state.loadedOrders++; },
    document: { getElementById: (id) => (id === 'orders-box-tab-content' ? { style: { display: 'none' } } : (id in classes ? el(id) : null)) }
  };
  sandbox.fetch = async (url, init) => {
    calls.door.push({ url, body: JSON.parse(init.body) });
    const a = over.door ? over.door() : { status: 503 };
    return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
  };
  sandbox.sb = async (p) => {
    calls.rest.push(p);
    if (p.startsWith('orders?')) return over.orders || [{ id: 1 }, { id: 2 }];
    return over.rows || [];
  };
  vm.createContext(sandbox);
  const src = blockOf('w3-dots-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(src + '\n' + functionOf('checkOrdersBox') + '\n' + functionOf('checkInboxDot') + '\n' + functionOf('checkNotificationsDot'), sandbox);
  return sandbox;
}
const OK = { body: { ok: true, orders: 7, inbox: true, notifications: false } };
const run = (w, code) => vm.runInContext(code, w);

test('the door answers: all three dots use it, with the login token, and no direct read is made', async () => {
  const w = world({ door: () => OK });
  await run(w, 'checkOrdersBox(); checkInboxDot(); checkNotificationsDot();');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.state.count, 7);
  assert.equal(w.classes['bc-inbox-dot'], true);
  assert.equal(w.classes['chats-inbox-dot'], true);
  assert.equal(w.classes['bc-notifications-dot'], false);
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.door.length, 1, 'three callers at the same moment share one call');
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'dots' });
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-counts'));
});

test('the three timers share one call; a caller that is not a timer is never given an older answer', async () => {
  const w = world({ door: () => OK });
  await run(w, 'checkOrdersBox(true)');
  await run(w, 'checkInboxDot(true)');
  await run(w, 'checkNotificationsDot(true)');
  assert.equal(w.calls.door.length, 1);
  await run(w, 'checkNotificationsDot()');   // for example right after a notification was marked read
  assert.equal(w.calls.door.length, 2);
});

test('a field the door could not read (null) changes nothing for that dot and makes no direct read', async () => {
  const w = world({ door: () => ({ body: { ok: true, orders: null, inbox: null, notifications: null } }) });
  await run(w, 'checkOrdersBox(); checkInboxDot(); checkNotificationsDot();');
  assert.equal(w.state.count, undefined);
  assert.deepEqual(w.classes, { 'bc-inbox-dot': false, 'chats-inbox-dot': false, 'bc-notifications-dot': false });
  assert.equal(w.calls.rest.length, 0);
});

test('the door says 503, 404, 502, 429, not available, has a network problem, or the device has no login: the older direct reads run as before', async () => {
  for (const over of [
    { door: () => ({ status: 503, body: { code: 'not_ready' } }) },
    { door: () => ({ status: 404, body: {} }) },
    { door: () => ({ status: 502, body: {} }) },
    { door: () => ({ status: 429, body: {} }) },
    { door: () => ({ body: { ok: false, error: 'not_available' } }) },
    { door: () => { throw new Error('network'); } },
    { noLogin: true }
  ]) {
    const w = world({ ...over, rows: [{ id: 9 }] });
    await run(w, 'checkOrdersBox(); checkInboxDot(); checkNotificationsDot();');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.state.count, 2);
    assert.equal(w.calls.rest.length, 3);
    assert.equal(w.classes['bc-inbox-dot'], true);
    assert.equal(w.classes['bc-notifications-dot'], true);
  }
});

test('after a 429 or 503 the door is left alone for a while', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }) });
  await run(w, 'checkInboxDot(true)');
  await run(w, 'checkInboxDot(true)');
  assert.equal(w.calls.door.length, 1);
  assert.equal(w.calls.rest.length, 2);
});

test('the Orders box count is remembered so the next tick can tell that it grew', async () => {
  const w = world({ door: () => OK });
  vm.runInContext('ordersBoxLastCount = 3', w);
  await run(w, 'checkOrdersBox()');
  assert.equal(vm.runInContext('ordersBoxLastCount', w), 7);
});

test('a REAL refusal never falls back: the three dots stay exactly as they are this tick and no direct read is made', async () => {
  for (const error of ['not_logged_in', 'no_seller', 'lookup_failed', 'read_failed']) {
    const w = world({ door: () => ({ body: { ok: false, error } }), rows: [{ id: 9 }] });
    await run(w, 'checkOrdersBox(); checkInboxDot(); checkNotificationsDot();');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.state.count, undefined, error);
    assert.deepEqual(w.classes, { 'bc-inbox-dot': false, 'chats-inbox-dot': false, 'bc-notifications-dot': false }, error);
    assert.equal(w.calls.rest.length, 0, error);
  }
});

test('a contract mismatch is NOT a refusal and falls back: an array, an empty object, ok false with no error word, a string, nothing', async () => {
  for (const body of [[], {}, { ok: false }, { ok: false, error: '' }, 'text', null, { ok: 'yes' }]) {
    const w = world({ door: () => ({ body }), rows: [{ id: 9 }] });
    await run(w, 'checkOrdersBox(); checkInboxDot(); checkNotificationsDot();');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.calls.rest.length, 3, JSON.stringify(body));
  }
});
