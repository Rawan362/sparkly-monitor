// Run with:  node --test tests/*.test.mjs
// Business chat and assistant chat reads (Business Read door): door first, the older direct reads kept as the fallback.
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
function codeOf(head) {
  const a = html.indexOf(head);
  assert.ok(a > 0, head + ' missing');
  const m = /\n\}[;]?\n/.exec(html.slice(a));
  assert.ok(m, head + ' end missing');
  return html.slice(a, a + m.index + m[0].length);
}
/** The text from one marker up to (not including) another, both inside one function. */
function between(from, to) {
  const a = html.indexOf(from);
  assert.ok(a > 0, from + ' missing');
  const b = html.indexOf(to, a);
  assert.ok(b > a, to + ' missing');
  return html.slice(a, b);
}
const LIST = codeOf('async function loadBusinessChatConversationList(');
const OPEN = codeOf('window.openExistingBusinessConversation = async function');
const LOG = between('// Door first (Business Read: assistantLog', 'rows = applyHold(rows);');
const OLDER = between('// Door first (Business Read: assistantOlder', 'older.reverse();');

test('the new code and this test file contain only ASCII characters', () => {
  const files = { block: blockOf('w4-business-read-door'), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and the older direct reads are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 318);
  for (const old of ["business_chat_conversations?chat_id=eq.", "business_chat_messages?conversation_id=eq.", "'seller_web_chat_log?seller_id=eq.' + SELLER_CHAT_ID + '&select=id,role,message,created_at,starred,pinned&order=created_at.desc&limit=300'",
    "&created_at=lt.' + encodeURIComponent(oldest)"]) assert.ok(html.includes(old), old);
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

const URL_ = 'https://sparklly.site/webhook/seller-business-read';
function fakeEl() {
  const el = { dataset: {}, className: '', innerHTML: '', style: {}, children: [], q: {}, classList: { toggle() {}, add() {}, remove() {} },
    querySelector(sel) { return (el.q[sel] = el.q[sel] || { textContent: '', onclick: null }); },
    addEventListener() {}, appendChild(c) { el.children.push(c); }, set onclick(v) {} };
  return el;
}
/** over.door(body) answers { status, body } or throws; over.noLogin: the device has no login. */
function world(over = {}) {
  const calls = { door: [], sb: [], bubbles: 0, empty: [], logs: [] };
  const els = {};
  const sandbox = {
    calls, JSON, Date, Object, Array, String, Promise, Error, encodeURIComponent, SELLER_CHAT_ID: 'seller-1', activeConversationId: null, bcHistory: [],
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token'),
    sb: async (p) => { calls.sb.push(p); return over.sb ? over.sb(p) : []; },
    debugLog: (m) => calls.logs.push(m), openBcConvMenu() {}, openExistingBusinessConversation() {}, closeBcSidebarOnMobile() {},
    showBcEmptyState: (on) => calls.empty.push(on), renderBcMessage: () => { calls.bubbles++; }, clearTimeout() {}, setTimeout() {},
    bcLongPressTimer: null, applyHold: (r) => r,
    document: {
      getElementById: (id) => (els[id] = els[id] || fakeEl()),
      createElement: () => fakeEl(), querySelectorAll: () => [],
    },
    window: {},
  };
  sandbox.els = els;
  sandbox.fetch = async (url, init) => {
    assert.equal(url, URL_);
    const body = JSON.parse(init.body);
    calls.door.push(body);
    const a = over.door ? over.door(body) : { status: 503, body: {} };
    return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => { if (a.badJson) throw new Error('x'); return a.body; } };
  };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w4-business-read-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var '), sandbox);
  vm.runInContext(LIST + '\n' + OPEN.replace(/^window\./, 'var $ = this; window.'), sandbox);
  return sandbox;
}
const ok = (extra = {}) => ({ body: { ok: true, ...extra } });
const FALLBACKS = [
  ['503', { status: 503, body: { ok: false, error: 'not_available' } }],
  ['429', { status: 429, body: {} }],
  ['404', { status: 404, body: {} }],
  ['502', { status: 502, body: {} }],
  ['not_available answer', { body: { ok: false, error: 'not_available' } }],
  ['refused connection or network problem', 'throw'],
];
function doorFor(a) { return a === 'throw' ? () => { throw new Error('offline'); } : () => a; }
const read = (w, action, extra) => vm.runInContext('w4BizRead(' + JSON.stringify(action) + ', ' + JSON.stringify(extra || null) + ')', w);

test('w4BizRead: the door answers with the login token and no seller id', async () => {
  const w = world({ door: () => ok({ conversations: [] }) });
  const r = await read(w, 'messages', { conversationId: 'c1' });
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.door[0], { token: 'login-token', action: 'messages', conversationId: 'c1' });
});

test('w4BizRead: 503, 429, 404, 502, not_available, a network problem or no login fall back', async () => {
  for (const [name, a] of FALLBACKS) assert.equal((await read(world({ door: doorFor(a) }), 'conversations')).fallback, true, name);
  const n = world({ noLogin: true, door: () => ok() });
  assert.equal((await read(n, 'conversations')).fallback, true);
  assert.equal(n.calls.door.length, 0);
});

test('w4BizRead: a login problem or any refusal never falls back', async () => {
  for (const body of [{ ok: false, error: 'not_logged_in', message: 'x' }, { ok: false, error: 'bad_input', message: 'Bad.' }, { ok: false, error: 'no_conversation' }, { ok: false, error: 'read_failed' }]) {
    const r = await read(world({ door: () => ({ body }) }), 'conversations');
    assert.equal(r.fallback, undefined);
    assert.equal(r.ok, false);
    assert.equal(r.relogin === true, body.error === 'not_logged_in');
  }
  assert.equal((await read(world({ door: () => ({ status: 500, badJson: true }) }), 'conversations')).ok, false);
});

test('after a 429 or a 503 the door is left alone for 30 seconds; a 404 does not pause', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: () => ({ status, body: {} }) });
    await read(w, 'conversations');
    assert.equal((await read(w, 'conversations')).fallback, true);
    assert.equal(w.calls.door.length, 1);
    const left = vm.runInContext('w4BizReadPausedUntil - Date.now()', w);
    assert.ok(left > 29000 && left <= 30000, String(left));
    vm.runInContext('w4BizReadPausedUntil = Date.now() - 1', w);
    await read(w, 'conversations');
    assert.equal(w.calls.door.length, 2);
  }
  const n = world({ door: () => ({ status: 404, body: {} }) });
  await read(n, 'conversations'); await read(n, 'conversations');
  assert.equal(n.calls.door.length, 2);
});

const CONVS = [{ id: 'c1', title: 'First', updated_at: 't', pinned: true }, { id: 'c2', title: 'Second', updated_at: 't', pinned: false }];

test('conversation list: the door gives the rows, no direct read', async () => {
  const w = world({ door: () => ok({ conversations: CONVS }) });
  await vm.runInContext('loadBusinessChatConversationList()', w);
  assert.deepEqual(w.calls.door[0], { token: 'login-token', action: 'conversations' });
  assert.equal(w.calls.sb.length, 0);
  const list = w.els['bc-conv-list'].children;
  assert.deepEqual(list.map((i) => i.dataset.id), ['c1', 'c2']);
  assert.deepEqual(list.map((i) => i.dataset.pinned), ['true', 'false']);
  assert.equal(list[0].q['.bc-conv-item-title span'].textContent, 'First');
});

test('conversation list: fallbacks read directly as before; a refusal keeps the list and reads nothing directly', async () => {
  for (const [name, a] of FALLBACKS) {
    const w = world({ door: doorFor(a), sb: () => CONVS });
    await vm.runInContext('loadBusinessChatConversationList()', w);
    assert.equal(w.calls.sb.length, 1, name);
    assert.equal(w.calls.sb[0], 'business_chat_conversations?chat_id=eq.seller-1&select=id,title,updated_at,pinned&order=pinned.desc,updated_at.desc');
    assert.equal(w.els['bc-conv-list'].children.length, 2);
  }
  const r = world({ door: () => ({ body: { ok: false, error: 'not_logged_in' } }), sb: () => CONVS });
  r.els['bc-conv-list'] = fakeEl(); r.els['bc-conv-list'].innerHTML = 'KEEP';
  await vm.runInContext('loadBusinessChatConversationList()', r);
  assert.equal(r.calls.sb.length, 0);
  assert.equal(r.els['bc-conv-list'].innerHTML, 'KEEP');
});

test('open a conversation: the door gives the messages; no_conversation shows the empty state; fallbacks read directly; a refusal reads nothing directly', async () => {
  const MSGS = [{ role: 'user', content: 'hi', created_at: '2026-11-20T10:00:00Z' }, { role: 'assistant', content: 'hello', created_at: '2026-11-20T10:00:03Z' }];
  const w = world({ door: () => ok({ messages: MSGS }) });
  await vm.runInContext('window.openExistingBusinessConversation("c1")', w);
  assert.deepEqual(w.calls.door[0], { token: 'login-token', action: 'messages', conversationId: 'c1' });
  assert.equal(w.calls.sb.length, 0);
  assert.equal(w.calls.bubbles, 2);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(bcHistory)', w)), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);

  const e = world({ door: () => ({ body: { ok: false, error: 'no_conversation', message: 'x' } }) });
  await vm.runInContext('window.openExistingBusinessConversation("c9")', e);
  assert.equal(e.calls.bubbles, 0);
  assert.equal(e.calls.empty[e.calls.empty.length - 1], true);
  assert.equal(e.calls.sb.length, 0);

  for (const [name, a] of FALLBACKS) {
    const f = world({ door: doorFor(a), sb: () => MSGS });
    await vm.runInContext('window.openExistingBusinessConversation("c1")', f);
    assert.equal(f.calls.sb.length, 1, name);
    assert.equal(f.calls.sb[0], 'business_chat_messages?conversation_id=eq.c1&select=role,content,created_at&order=created_at.asc');
    assert.equal(f.calls.bubbles, 2);
  }
  const r = world({ door: () => ({ body: { ok: false, error: 'not_logged_in' } }) });
  await vm.runInContext('window.openExistingBusinessConversation("c1")', r);
  assert.equal(r.calls.sb.length, 0);
  assert.equal(r.calls.bubbles, 0);
});

const LOGROWS = [{ id: 2, role: 'seller', message: 'b', created_at: '2026-11-20T10:00:03Z', starred: false, pinned: false }, { id: 1, role: 'ahmad', message: 'a', created_at: '2026-11-20T10:00:00Z', starred: false, pinned: false }];

test('assistant chat: the log and the older rows come from the door (newest first, reversed by the screen); fallbacks read directly; a refusal throws', async () => {
  const w = world({ door: () => ok({ rows: LOGROWS.slice() }) });
  const run = (code, ctx) => vm.runInContext('(async function() { let rows; const oldest = "2026-11-01T00:00:00Z"; try { ' + code + ' ; return typeof older !== "undefined" ? older : rows; } finally {} })()', ctx);
  const rows = await run(LOG, w);
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  assert.deepEqual(w.calls.door[0], { token: 'login-token', action: 'assistantLog' });
  assert.equal(w.calls.sb.length, 0);

  const older = await vm.runInContext('(async function() { const oldest = "2026-11-01T00:00:00Z"; ' + OLDER + ' ; return older; })()', w);
  assert.equal(older.length, 2);
  assert.deepEqual(w.calls.door[1], { token: 'login-token', action: 'assistantOlder', before: '2026-11-01T00:00:00Z' });
  assert.equal(w.calls.sb.length, 0);

  for (const [name, a] of FALLBACKS) {
    const f = world({ door: doorFor(a), sb: () => LOGROWS.slice() });
    await run(LOG, f);
    assert.equal(f.calls.sb.length, 1, name);
    assert.ok(f.calls.sb[0].startsWith('seller_web_chat_log?seller_id=eq.seller-1&select=id,role,message,created_at,starred,pinned&order=created_at.desc&limit=300'));
    const g = world({ door: doorFor(a), sb: () => [] });
    await vm.runInContext('(async function() { const oldest = "2026-11-01T00:00:00Z"; ' + OLDER + ' ; return older; })()', g);
    assert.ok(g.calls.sb[0].includes('&created_at=lt.2026-11-01T00%3A00%3A00Z&select=id,role,message,created_at,starred,pinned&order=created_at.desc&limit=100'));
  }
  const r = world({ door: () => ({ body: { ok: false, error: 'not_logged_in' } }) });
  await assert.rejects(run(LOG, r), /refused/);
  await assert.rejects(vm.runInContext('(async function() { const oldest = "x"; ' + OLDER + ' ; return older; })()', r), /refused/);
  assert.equal(r.calls.sb.length, 0);
});
