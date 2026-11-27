// Run with:  node --test tests/*.test.mjs
// Delivery ticks: the marks are read through the Seller Delivery Marks door, with the older direct read kept as the fallback.
// The door and the database are faked by the test (vm, no browser): nothing leaves the test.
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
/** One top-level function, cut out by matching braces (these functions hold no braces inside strings). */
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
  const files = { block: blockOf('w3-delivery-marks'), a: functionOf('fetchDeliveryContext'), b: functionOf('waitForReceipt'), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and the older direct reads are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 311);
  assert.ok(html.includes("sb('message_status?phone_number=eq.'"));
  assert.ok(html.includes("sb('message_status?wa_message_id=eq.'"));
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
  const sandbox = {
    window: {}, SEND_HOLD_MAX_MS: 5000, SEND_HOLD_POLL_MS: 10, calls, JSON, Date, Object, Array, String, Promise, setTimeout, encodeURIComponent,
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token'),
    w1MeGet: async () => ({ phoneNumberId: 'pnid-1' }),
  };
  sandbox.fetch = async (url, init) => {
    calls.door.push({ url, body: JSON.parse(init.body) });
    const a = over.door ? over.door(JSON.parse(init.body)) : { status: 503 };
    return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
  };
  sandbox.sb = async (p) => { calls.rest.push(p); return over.rest ? over.rest(p) : []; };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w3-delivery-marks').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var '), sandbox);
  vm.runInContext(functionOf('fetchDeliveryContext') + '\n' + functionOf('waitForReceipt'), sandbox);
  return sandbox;
}
const MARK = { wa_message_id: 'wamid.1', status: 'read', sent_at: '2026-11-27T10:00:00Z', delivered_at: '2026-11-27T10:00:05Z', read_at: '2026-11-27T10:01:00Z', played_at: null, error_code: null, error_text: null, updated_at: '2026-11-27T10:01:00Z' };

test('the door answers: the ticks use its marks, with the login token, and no direct read is made', async () => {
  const w = world({ door: () => ({ body: { ok: true, connected: true, count: 1, marks: [MARK] } }) });
  const ctx = await vm.runInContext('fetchDeliveryContext("9647700000000")', w);
  assert.equal(ctx.byId['wamid.1'].status, 'read');
  assert.equal(ctx.sig, 'wamid.1:read');
  assert.equal(w.calls.rest.length, 0);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'marks', phone: '9647700000000', limit: 400 });
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-delivery-marks'));
});

test('the door says not available (503), refuses, has no number, or the device has no login: the older direct read runs as before', async () => {
  for (const over of [
    { door: () => ({ status: 503, body: { code: 'not_ready' } }) },
    { door: () => ({ body: { ok: false, error: 'bad_input' } }) },
    { door: () => ({ body: { ok: false, error: 'not_available' } }) },
    { door: () => ({ body: { ok: true, connected: false, count: 0, marks: [] } }) },
    { noLogin: true }
  ]) {
    const w = world({ ...over, rest: () => [MARK] });
    const ctx = await vm.runInContext('fetchDeliveryContext("9647700000000")', w);
    assert.equal(ctx.byId['wamid.1'].status, 'read');
    assert.equal(w.calls.rest.length, 1);
    assert.ok(w.calls.rest[0].includes('business_phone_number_id=eq.pnid-1'));
  }
});

test('after a 429 the door is left alone for a while and the direct read is used', async () => {
  const w = world({ door: () => ({ status: 429, body: {} }), rest: () => [] });
  await vm.runInContext('fetchDeliveryContext("9647700000000")', w);
  await vm.runInContext('fetchDeliveryContext("9647700000000")', w);
  assert.equal(w.calls.door.length, 1);
  assert.equal(w.calls.rest.length, 2);
});

test('waitForReceipt reads one message through the door (waMessageId) and falls back to the direct read', async () => {
  const w = world({ door: () => ({ body: { ok: true, connected: true, count: 1, marks: [{ ...MARK, status: 'delivered' }] } }) });
  assert.equal(await vm.runInContext('waitForReceipt("wamid.1")', w), 'delivered');
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'marks', waMessageId: 'wamid.1', limit: 1 });
  assert.equal(w.calls.rest.length, 0);
  const f = world({ rest: () => [{ status: 'sent' }] });
  assert.equal(await vm.runInContext('waitForReceipt("wamid.2")', f), 'sent');
  assert.equal(f.calls.rest.length, 1);
});
