// Run with:  node --test tests/*.test.mjs
// The Engine screen (models, price list, usage) reads the Seller Engine Reads door first, with the older direct reads kept as the fallback.
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
function grab(startText) {
  const a = html.indexOf(startText);
  assert.ok(a > 0, startText + ' missing');
  let depth = 0, i = html.indexOf('{', a);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(a, i + 1);
}
const LOAD = grab('async function loadEngine(');
const USAGE = grab('async function engineLoadUsage(');

test('the new code and this test file contain only ASCII characters', () => {
  const added = (LOAD + '\n' + USAGE).split('\n').filter((l) => /door|W3-|w3Engine/.test(l)).join('\n');
  const files = { block: blockOf('w3-engine-read-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is not lower than 319 and the three older direct reads are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 319);
  assert.ok(LOAD.includes("'seller_engine?seller_id=eq.' + encodeURIComponent(SELLER_CHAT_ID) + '&select=chat_model,customer_model,call_model&limit=1'"));
  assert.ok(LOAD.includes("'ai_model_prices?select=*'"));
  assert.ok(USAGE.includes("'ai_usage?seller_id=eq.' + encodeURIComponent(SELLER_CHAT_ID) + '&created_at=gte.'"));
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

const ENG = { chat_model: 'm-chat', customer_model: 'm-cust', call_model: 'm-call' };
const PRICE = { model: 'm-chat', input_per_mtok: 3 };
const USE = { created_at: '2026-11-27T10:00:00Z', model: 'm-chat', purpose: 'chat', channel: 'web', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 };
function world(over = {}) {
  const calls = { door: [], rest: [], rendered: 0 };
  const box = { innerHTML: '' };
  const sandbox = {
    calls, box, SELLER_CHAT_ID: '111', engineState: { models: {}, prices: {}, period: '7', rows: [], conn: null }, JSON, Date, Object, Promise, encodeURIComponent, String, Array, Error, parseInt,
    document: { getElementById: () => box }, escapeHtml: (x) => String(x), engineLoadConn: async () => {}, engineRender() { calls.rendered++; }, engineLoadModels: async () => {}, engineLoadReal() {},
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token')
  };
  sandbox.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.door.push({ url, body });
    const a = over.door ? over.door(body, calls.door.length) : { status: 503 };
    if (a.throws) throw new Error('network');
    return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
  };
  sandbox.sb = async (p) => {
    calls.rest.push(p);
    if (p.startsWith('seller_engine?')) return [ENG];
    if (p.startsWith('ai_model_prices?')) return [PRICE];
    if (p.startsWith('ai_usage?')) return [USE];
    return [];
  };
  vm.createContext(sandbox);
  const helper = blockOf('w3-engine-read-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(helper + '\n' + LOAD + '\n' + USAGE, sandbox);
  return sandbox;
}
const run = (w, code) => vm.runInContext(code, w);
const doorRows = (b) => ({ body: { ok: true, table: b.table, count: 1, truncated: false, rows: b.table === 'seller_engine' ? [ENG] : b.table === 'ai_model_prices' ? [PRICE] : [USE] } });
const FALLBACKS = [
  ['503', { door: () => ({ status: 503, body: {} }) }],
  ['404', { door: () => ({ status: 404, body: {} }) }],
  ['502', { door: () => ({ status: 502, body: {} }) }],
  ['429', { door: () => ({ status: 429, body: {} }) }],
  ['not_available', { door: () => ({ body: { ok: false, error: 'not_available' } }) }],
  ['a network problem', { door: () => ({ throws: true }) }],
  ['no login on the device', { noLogin: true }]
];
const REFUSALS = ['not_logged_in', 'no_seller', 'lookup_failed', 'bad_column', 'read_failed'];
const refuse = (error) => ({ door: () => ({ body: { ok: false, error } }) });
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

test('the Engine screen: models, price list and usage come from the door with the login token and no seller id; no direct read', async () => {
  const w = world({ door: (b) => doorRows(b) });
  await run(w, 'loadEngine()');
  assert.equal(w.calls.rest.length, 0);
  const bodies = w.calls.door.map((d) => d.body);
  same(bodies[0], { token: 'login-token', action: 'read', table: 'seller_engine', select: ['chat_model', 'customer_model', 'call_model'], limit: 1 });
  same(bodies[1], { token: 'login-token', action: 'read', table: 'ai_model_prices' });
  const u = bodies[2];
  assert.equal(u.table, 'ai_usage');
  same(u.select, ['created_at', 'model', 'purpose', 'channel', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']);
  same(u.order, [{ column: 'created_at', dir: 'desc' }]);
  assert.equal(u.limit, 5000);
  assert.equal(u.filters[0].column + u.filters[0].op, 'created_atgte');
  assert.ok(!isNaN(Date.parse(u.filters[0].value)));
  assert.ok(!('seller_id' in u) && !JSON.stringify(bodies).includes('111'));
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-engine-reads'));
  same(run(w, 'engineState.models'), { chat: 'm-chat', customer: 'm-cust', call: 'm-call' });
  same(Object.keys(run(w, 'engineState.prices')), ['m-chat']);
  assert.equal(run(w, 'engineState.rows.length'), 1);
  assert.equal(w.calls.rendered, 1);
});

test('the usage period: "today" asks from midnight today and 30 days from 29 days back', async () => {
  const w = world({ door: (b) => doorRows(b) });
  run(w, 'engineState.period = "today"');
  await run(w, 'engineLoadUsage()');
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  assert.equal(w.calls.door[0].body.filters[0].value, d0.toISOString());
  run(w, 'engineState.period = "30"');
  await run(w, 'engineLoadUsage()');
  d0.setDate(d0.getDate() - 29);
  assert.equal(w.calls.door[1].body.filters[0].value, d0.toISOString());
});

test('every way the door cannot answer runs the older direct reads exactly as before', async () => {
  for (const [name, over] of FALLBACKS) {
    const w = world(over);
    await run(w, 'loadEngine()');
    assert.equal(w.calls.rest.length, 3, name);
    assert.ok(w.calls.rest[0].startsWith('seller_engine?seller_id=eq.111&select=chat_model,customer_model,call_model&limit=1'), name);
    assert.equal(w.calls.rest[1], 'ai_model_prices?select=*', name);
    assert.ok(w.calls.rest[2].startsWith('ai_usage?seller_id=eq.111&created_at=gte.'), name);
    assert.equal(run(w, 'engineState.models.chat'), 'm-chat', name);
    assert.equal(w.calls.rendered, 1, name);
  }
});

test('a door refusal never falls back: the screen shows its own error, nothing is rendered, and a login problem shows the sign-in words', async () => {
  for (const error of REFUSALS) {
    const w = world(refuse(error));
    await run(w, 'loadEngine()');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(w.calls.rendered, 0, error);
    assert.ok(w.box.innerHTML.includes(error === 'not_logged_in' ? 'sign out and sign in again' : 'could not be read (' + error + ')'), error);
  }
  const w = world(refuse('read_failed'));
  await assert.rejects(() => run(w, 'engineLoadUsage()'), /could not be read/);
  assert.equal(w.calls.rest.length, 0);
});

test('after a 429 or 503 the door is left alone for 30 seconds (the direct reads meanwhile); a refusal, 404 and 502 do not pause it', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: () => ({ status, body: {} }) });
    await run(w, 'loadEngine()');
    await run(w, 'engineLoadUsage()');
    assert.equal(w.calls.door.length, 2);   // the two first reads went out together; nothing after the pause began
    assert.equal(w.calls.rest.length, 4);
    const left = run(w, 'w3EnginePausedUntil') - Date.now();
    assert.ok(left > 25000 && left <= 30000);
  }
  for (const over of [refuse('not_logged_in'), { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) }]) {
    const w = world(over);
    await run(w, 'loadEngine()');
    assert.equal(run(w, 'w3EnginePausedUntil'), 0);
  }
});
