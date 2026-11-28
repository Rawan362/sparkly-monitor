// Run with:  node --test tests/*.test.mjs
// The Business chat (conversation list and messages) and the Sparkly assistant chat (newest 300 and "Load older messages") read the Seller
// Business Read door first, with the older direct reads kept as the fallback. The door and the database are faked by the test (vm, no browser).
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
function between(startText, endText) {
  const a = html.indexOf(startText);
  assert.ok(a > 0, startText + ' missing');
  const b = html.indexOf(endText, a);
  assert.ok(b > a, endText + ' missing');
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
const FN = {
  panel: grab('async function renderAhmadChatPanel('),
  older: grab('window.loadOlderAhmadMessages = async function('),
  list: grab('async function loadBusinessChatConversationList('),
  open: grab('window.openExistingBusinessConversation = async function(')
};

test('the new code and this test file contain only ASCII characters', () => {
  const added = Object.values(FN).join('\n').split('\n').filter((l) => /door|W3-|w3Biz/.test(l)).join('\n');
  const files = { block: blockOf('w3-business-read-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is higher than 315 and every older direct read is still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 316);
  for (const [fn, needle] of [
    ['panel', "'seller_web_chat_log?seller_id=eq.' + SELLER_CHAT_ID + '&select=id,role,message,created_at,starred,pinned&order=created_at.desc&limit=300'"],
    ['older', "'&select=id,role,message,created_at,starred,pinned&order=created_at.desc&limit=100'"],
    ['list', "'business_chat_conversations?chat_id=eq.' + SELLER_CHAT_ID + '&select=id,title,updated_at,pinned&order=pinned.desc,updated_at.desc'"],
    ['open', "'business_chat_messages?conversation_id=eq.' + conversationId + '&select=role,content,created_at&order=created_at.asc'"]
  ]) assert.ok(FN[fn].includes(needle), fn);
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

const A1 = { id: 1, role: 'user', message: 'one', created_at: '2026-11-27T10:00:00Z', starred: false, pinned: false };
const A2 = { id: 2, role: 'ahmad', message: 'two', created_at: '2026-11-27T10:01:00Z', starred: false, pinned: false };
const C1 = { id: 'c1', title: 'Chat one', updated_at: '2026-11-27T10:00:00Z', pinned: true };
const M1 = { role: 'user', content: 'hello', created_at: '2026-11-27T10:00:00Z' };
const M2 = { role: 'assistant', content: 'hi', created_at: '2026-11-27T10:00:05Z' };

function stubEl() {
  const el = { innerHTML: '', style: {}, dataset: {}, className: '', textContent: '', children: [], firstChild: null, scrollHeight: 100, scrollTop: 0, disabled: false,
    classList: { toggle() {}, add() {}, remove() {} }, appendChild(c) { el.children.push(c); }, insertBefore() {}, remove() {}, addEventListener() {} };
  el.querySelector = () => stubEl();
  return el;
}
function world(over = {}) {
  const calls = { door: [], rest: [], debug: [], alerts: [], panelRows: null, rendered: [], empty: [], items: 0 };
  const els = {};
  const sandbox = {
    calls, els, SELLER_CHAT_ID: '111', activeConversationId: 'c1', bcHistory: [], JSON, Date, Object, Promise, setTimeout, encodeURIComponent, String, Array, Number, Set, Error,
    debugLog: (m) => calls.debug.push(m), alert: (m) => calls.alerts.push(m), window: { innerWidth: 1200 },
    tryIncrementalAhmadUpdate: (rows) => { calls.panelRows = rows; return true; },
    getLocallyDeletedIds: () => new Set(), formatDateDivider: () => 'D', renderBubble: (m) => '<b' + m.id + '>', closeBcSidebarOnMobile() {},
    showBcEmptyState: (v) => calls.empty.push(v), renderBcMessage: (c, role) => calls.rendered.push(role + ':' + c), openBcConvMenu() {},
    document: {
      getElementById: (id) => (els[id] = els[id] || stubEl()),
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { calls.items++; return stubEl(); }
    },
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
    if (p.startsWith('seller_web_chat_log?') && p.includes('created_at=lt.')) return [A2, A1].slice().reverse().reverse();
    if (p.startsWith('seller_web_chat_log?')) return [A2, A1];
    if (p.startsWith('business_chat_conversations?')) return [C1];
    if (p.startsWith('business_chat_messages?')) return [M1, M2];
    return [];
  };
  vm.createContext(sandbox);
  const hold = between('// <hold>', '// </hold>').replace(/\bconst /g, 'var ');
  const helper = blockOf('w3-business-read-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(['var HOLD_MARK = "pending:", HOLD_TIMEOUT_MS = 240000;', hold, helper, Object.values(FN).join('\n')].join('\n'), sandbox);
  return sandbox;
}
const run = (w, code) => vm.runInContext(code, w);
const FALLBACKS = [
  ['503', { door: () => ({ status: 503, body: {} }) }],
  ['404', { door: () => ({ status: 404, body: {} }) }],
  ['502', { door: () => ({ status: 502, body: {} }) }],
  ['429', { door: () => ({ status: 429, body: {} }) }],
  ['not_available', { door: () => ({ body: { ok: false, error: 'not_available' } }) }],
  ['a network problem', { door: () => ({ throws: true }) }],
  ['no login on the device', { noLogin: true }]
];
const REFUSALS = ['not_logged_in', 'no_seller', 'lookup_failed', 'bad_input', 'read_failed'];
const refuse = (error) => ({ door: () => ({ body: { ok: false, error } }) });
const ids = (rows) => JSON.stringify(rows.map((r) => r.id));

test('assistant chat: the door rows (newest first) are turned oldest first with the login token and no seller id, no direct read', async () => {
  const w = world({ door: () => ({ body: { ok: true, rows: [A2, A1] } }) });
  await run(w, 'renderAhmadChatPanel(true)');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'assistantLog' }));
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-business-read'));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(ids(w.calls.panelRows), '[1,2]');
});

test('assistant chat: every way the door cannot answer runs the older direct read as before', async () => {
  for (const [name, over] of FALLBACKS) {
    const w = world(over);
    await run(w, 'renderAhmadChatPanel(true)');
    assert.equal(w.calls.rest.length, 1, name);
    assert.equal(ids(w.calls.panelRows), '[1,2]', name);
  }
});

test('assistant chat: a refusal never falls back; a silent refresh keeps the screen, a login problem asks to sign in again', async () => {
  for (const error of REFUSALS) {
    const w = world(refuse(error));
    await run(w, 'renderAhmadChatPanel(true)');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(w.calls.panelRows, null, error);
    assert.equal(w.calls.alerts.length, error === 'not_logged_in' ? 1 : 0, error);
  }
});

test('Load older (assistant): the door is asked with the oldest loaded time; rows are put oldest first; the older read only without the door', async () => {
  let w = world({ door: () => ({ body: { ok: true, rows: [A2, A1] } }) });
  run(w, 'window._ahmadOldestLoaded = "2026-11-27T11:00:00Z"');
  await run(w, 'window.loadOlderAhmadMessages()');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'assistantOlder', before: '2026-11-27T11:00:00Z' }));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(run(w, 'window._ahmadOldestLoaded'), A1.created_at);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    run(w, 'window._ahmadOldestLoaded = "2026-11-27T11:00:00Z"');
    await run(w, 'window.loadOlderAhmadMessages()');
    assert.equal(w.calls.rest.length, 1, name);
    assert.ok(w.calls.rest[0].includes('created_at=lt.'), name);
  }
  for (const error of REFUSALS) {
    w = world(refuse(error));
    run(w, 'window._ahmadOldestLoaded = "2026-11-27T11:00:00Z"');
    await run(w, 'window.loadOlderAhmadMessages()');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(run(w, 'window._ahmadOldestLoaded'), '2026-11-27T11:00:00Z', error);
  }
});

test('Business chat list: the door conversations are drawn; the older read only without the door; a refusal never falls back and keeps the list', async () => {
  let w = world({ door: () => ({ body: { ok: true, conversations: [C1] } }) });
  await run(w, 'loadBusinessChatConversationList()');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'conversations' }));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.items, 1);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'loadBusinessChatConversationList()');
    assert.equal(w.calls.rest.length, 1, name);
    assert.equal(w.calls.items, 1, name);
  }
  for (const error of REFUSALS) {
    w = world(refuse(error));
    w.els['bc-conv-list'] = Object.assign(stubEl(), { innerHTML: 'KEEP' });
    await run(w, 'loadBusinessChatConversationList()');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(w.els['bc-conv-list'].innerHTML, 'KEEP', error);
    assert.equal(w.calls.alerts.length, error === 'not_logged_in' ? 1 : 0, error);
  }
});

test('open a Business chat: the door messages are drawn with their roles; no_conversation shows the empty state; the older read only without the door', async () => {
  let w = world({ door: () => ({ body: { ok: true, messages: [M1, M2] } }) });
  await run(w, 'window.openExistingBusinessConversation("c1")');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'messages', conversationId: 'c1' }));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(JSON.stringify(w.calls.rendered), JSON.stringify(['user:hello', 'assistant:hi']));
  assert.equal(JSON.stringify(run(w, 'bcHistory')), JSON.stringify([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]));
  w = world(refuse('no_conversation'));
  await run(w, 'window.openExistingBusinessConversation("c1")');
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.rendered.length, 0);
  assert.equal(w.calls.empty[w.calls.empty.length - 1], true);
  for (const error of REFUSALS) {
    w = world(refuse(error));
    await run(w, 'window.openExistingBusinessConversation("c1")');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(w.calls.rendered.length, 0, error);
    assert.equal(w.calls.alerts.length, error === 'not_logged_in' ? 1 : 0, error);
  }
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.openExistingBusinessConversation("c1")');
    assert.equal(w.calls.rest.length, 1, name);
    assert.equal(w.calls.rendered.length, 2, name);
  }
});

test('after a 429 or 503 the door is left alone for 30 seconds, by all four reads; a refusal, 404 and 502 do not pause it', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: () => ({ status, body: {} }) });
    await run(w, 'loadBusinessChatConversationList()');
    await run(w, 'window.openExistingBusinessConversation("c1")');
    await run(w, 'renderAhmadChatPanel(true)');
    assert.equal(w.calls.door.length, 1);
    assert.equal(w.calls.rest.length, 3);
    const left = run(w, 'w3BizPausedUntil') - Date.now();
    assert.ok(left > 25000 && left <= 30000);
  }
  for (const over of [refuse('not_logged_in'), { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) }]) {
    const w = world(over);
    await run(w, 'loadBusinessChatConversationList()');
    assert.equal(run(w, 'w3BizPausedUntil'), 0);
  }
});
