// Run with:  node --test tests/*.test.mjs
// The chat list (every 8 s) reads the Seller Chats Read door (action chatList), with the four older direct reads kept as the fallback.
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
  // loadConversations also holds older Arabic text, so only the lines this change added to it are scanned.
  const added = functionOf('loadConversations').split('\n').filter((l) => /door|useDoor|keepList|W3-/.test(l)).join('\n');
  const files = { block: blockOf('w3-chats-read-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and the four older direct reads are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 313);
  for (const needle of [
    "'conversations?seller_id=eq.' + SELLER_CHAT_ID +",
    "'client_status?seller_id=eq.' + SELLER_CHAT_ID + '&select=phone_number,ai_active,pinned,muted,archived,favorite,blocked'",
    "'customers?seller_id=eq.' + SELLER_CHAT_ID + '&select=phone,name'",
    "sb('call_recordings?seller_id=eq.' + SELLER_CHAT_ID + '&select=phone_number,ended_at,duration_seconds&order=ended_at.desc&limit=200')"
  ]) assert.ok(functionOf('loadConversations').includes(needle), needle);
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

const ROW = { phone_number: '9647700000001', message: 'hello', role: 'user', timestamp: '2026-11-27T10:00:00Z', channel: 'whatsapp' };
const CALL_ROW = { phone_number: '9647700000002', message: '', role: 'user', timestamp: '2026-11-27T09:00:00Z', channel: 'voice' };
const DOOR_LIST = { ok: true, changed: true, cursor: 'c1', conversations: [ROW, CALL_ROW], clientStatus: [{ phone_number: '9647700000001', ai_active: false, pinned: true, ai_typing_until: null }], customers: [{ phone: '9647700000001', name: 'Sara' }], calls: [{ phone_number: '9647700000002', ended_at: '2026-11-27T09:03:00Z', duration_seconds: 125 }] };

function world(over = {}) {
  const calls = { door: [], rest: [], rendered: 0, threads: 0, pills: 0 };
  const sandbox = {
    calls, SELLER_CHAT_ID: '111', conversations: [], activePhone: null, ahmadChatOpen: false, currentLang: 'en',
    JSON, Date, Object, Promise, setTimeout, encodeURIComponent, String, Array,
    heartbeatSession() {}, debugLog() {}, holdActive: () => false, isHoldRow: () => false, formatCallDuration: (n) => Math.round(n / 60) + 'm',
    renderChannelPills() { calls.pills++; }, renderConvoList() { calls.rendered++; }, loadThread: async () => { calls.threads++; }, renderAhmadChatPanel: async () => {}, loadProducts() {},
    document: { getElementById: () => null }, window: {},
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
    if (p.startsWith('conversations?')) return [ROW];
    if (p.startsWith('client_status?')) return [];
    if (p.startsWith('customers?')) return [];
    return [];
  };
  vm.createContext(sandbox);
  const src = blockOf('w3-chats-read-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(src + '\n' + functionOf('loadConversations'), sandbox);
  return sandbox;
}
const run = (w, code) => vm.runInContext(code, w);

test('the door answers: the list is built from its four lists with the login token, and no direct read is made', async () => {
  const w = world({ door: () => ({ body: DOOR_LIST }) });
  await run(w, 'loadConversations()');
  assert.equal(w.calls.rest.length, 0);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'chatList' });
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-chats-read'));
  const list = JSON.parse(run(w, 'JSON.stringify(conversations)'));
  assert.equal(list.length, 2);
  assert.equal(list[0].phone_number, '9647700000001');   // pinned first
  assert.equal(list[0].displayName, 'Sara');
  assert.equal(list[0].aiActive, false);
  assert.equal(list[0].pinned, true);
  assert.equal(list[1].previewText.replace(/^\S+ /, ''), 'Call 2m');   // the call preview uses the door's calls
  assert.equal(w.calls.rendered, 1);
});

test('the second tick sends the last cursor; "changed: false" keeps the list, still draws it, and still runs the open chat refresh', async () => {
  const w = world({ door: (b, n) => (n === 1 ? { body: DOOR_LIST } : { body: { ok: true, changed: false, cursor: 'c1' } }) });
  await run(w, 'activePhone = "9647700000001"');
  await run(w, 'loadConversations()');
  const before = run(w, 'JSON.stringify(conversations)');
  await run(w, 'loadConversations()');
  assert.equal(w.calls.door[1].body.since, 'c1');
  assert.equal(run(w, 'JSON.stringify(conversations)'), before);
  assert.equal(w.calls.rendered, 2);
  assert.equal(w.calls.threads, 2);
  assert.equal(w.calls.rest.length, 0);
});

test('503, 404, 502, 429, not_available, a network problem, or no login: the four direct reads run as before, and the cursor is dropped', async () => {
  for (const over of [
    { door: () => ({ status: 503, body: { code: 'not_ready' } }) },
    { door: () => ({ status: 404, body: {} }) },
    { door: () => ({ status: 502, body: {} }) },
    { door: () => ({ status: 429, body: {} }) },
    { door: () => ({ body: { ok: false, error: 'not_available' } }) },
    { door: () => ({ throws: true }) },
    { noLogin: true }
  ]) {
    const w = world(over);
    await run(w, 'loadConversations()');
    assert.equal(w.calls.rest.length, 4);
    assert.equal(JSON.parse(run(w, 'JSON.stringify(conversations)')).length, 1);
    assert.equal(run(w, 'w3ChatListCursor'), null);
  }
});

test('a door outage after a good answer drops the cursor, so the next good answer sends the whole list again', async () => {
  const w = world({ door: (b, n) => (n === 2 ? { status: 503, body: {} } : { body: DOOR_LIST }) });
  await run(w, 'loadConversations()');
  assert.equal(run(w, 'w3ChatListCursor'), 'c1');
  await run(w, 'loadConversations()');
  assert.equal(run(w, 'w3ChatListCursor'), null);
  assert.equal(w.calls.rest.length, 4);
});

test('after a 429 or 503 the door is left alone for a while', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }) });
  await run(w, 'loadConversations()');
  await run(w, 'loadConversations()');
  assert.equal(w.calls.door.length, 1);
  assert.equal(w.calls.rest.length, 8);
});

test('a door refusal (a login problem or any other) never falls back: no direct read, and the list on screen stays as it is', async () => {
  for (const error of ['not_logged_in', 'no_seller', 'read_failed']) {
    const w = world({ door: (b, n) => (n === 1 ? { body: DOOR_LIST } : { body: { ok: false, error } }) });
    await run(w, 'loadConversations()');
    const before = run(w, 'JSON.stringify(conversations)');
    await run(w, 'loadConversations()');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(run(w, 'JSON.stringify(conversations)'), before, error);
    assert.equal(run(w, 'w3ChatListCursor'), 'c1', error);
  }
});

test('a contract mismatch is NOT a refusal and falls back to the four direct reads: an array, an empty object, "ok: false" with no error word, a string or nothing', async () => {
  for (const body of [[], {}, { ok: false }, { ok: false, error: '' }, 'text', null, { ok: 'yes' }]) {
    const w = world({ door: () => ({ body }) });
    await run(w, 'loadConversations()');
    assert.equal(w.calls.rest.length, 4, JSON.stringify(body));
    assert.equal(run(w, 'w3ChatListCursor'), null);
  }
});
