// Run with:  node --test tests/*.test.mjs
// The Business chat writes (rename, pin, new chat, delete chat, and the message deletes behind Retry and Edit) go through the Seller Business Chats
// and Seller Business Messages doors first, with the older direct writes kept as the fallback. Refusals never fall back.
// The doors and the database are faked by the test (vm, no browser): nothing leaves the test.
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
const FN = {
  rename: grab('window.renameBcConversationPrompt = async function('),
  pin: grab('window.toggleBcConversationPin = async function('),
  create: grab('window.startNewBusinessChat = async function('),
  deleteChat: grab('window.deleteBusinessConversation = async function('),
  retry: grab('window.retryAiMessage = async function('),
  edit: grab('window.editUserMessage = async function(')
};

test('the new code and this test file contain only ASCII characters', () => {
  const added = Object.values(FN).join('\n').split('\n').filter((l) => /door|W3-|w3Bw/.test(l)).join('\n');
  const files = { block: blockOf('w3-business-write-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is higher than 315 and the older direct writes are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 316);
  const b = blockOf('w3-business-write-door');
  for (const needle of ["'/rest/v1/business_chat_conversations?id=eq.' + convId", "method: 'PATCH'", "method: 'DELETE'", "'/rest/v1/business_chat_messages?conversation_id=eq.' + convId + '&created_at=gte.' + encodeURIComponent(from)"]) assert.ok(b.includes(needle), needle);
  assert.ok(FN.create.includes("body: JSON.stringify({ chat_id: SELLER_CHAT_ID, title: 'New Chat' })"));
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

const DB = 'https://db.example';
const TS = '2026-11-27T10:00:03.123+00:00';
function stubEl(els) {
  const el = { style: {}, dataset: {}, children: [], textContent: '', innerHTML: '', value: '', appendChild(c) { el.children.push(c); }, setAttribute() {}, focus() {} };
  Object.defineProperty(el, 'id', { set(v) { els[v] = el; }, get() { return ''; } });
  return el;
}
function world(over = {}) {
  const calls = { door: [], direct: [], lists: 0, opened: [], created: 0, sent: [], empty: 0 };
  const els = {};
  const sandbox = {
    calls, els, __wrap: () => wrap(), SELLER_CHAT_ID: '111', SUPABASE_URL: DB, SUPABASE_ANON_KEY: 'public-key', activeConversationId: over.active === undefined ? 'c1' : over.active, bcHistory: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
    bcMenuTargetConvId: 'c1', JSON, Date, Object, Promise, encodeURIComponent, String, Array, Number, Error, setTimeout: () => 1, clearTimeout() {},
    debugLog() {}, alert() {}, prompt: () => (over.title === undefined ? '  New title  ' : over.title), window: {},
    closeBcConvMenu() {}, closeBcSidebarOnMobile() {}, showBcEmptyState() { calls.empty++; },
    loadBusinessChatConversationList: async () => { calls.lists++; },
    openExistingBusinessConversation: async (id) => { calls.opened.push(id); },
    sendBusinessChatTurn: async (t) => { calls.sent.push(t); },
    document: {
      body: { appendChild() {} },
      getElementById: (id) => els[id] || (id === 'bc-input' || id === 'bc-incognito-banner' || id === 'bc-header-title' || id === 'bc-messages' ? (els[id] = stubEl(els)) : null),
      createElement: () => stubEl(els),
      querySelector: () => ({ dataset: { pinned: over.pinned ? 'true' : 'false' }, querySelector: () => ({ textContent: 'Old title' }) }),
      querySelectorAll: () => [{ dataset: { id: 'c2' } }]
    },
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token')
  };
  sandbox.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/webhook/seller-business-chats') || u.endsWith('/webhook/seller-business-messages')) {
      const body = JSON.parse(init.body);
      calls.door.push({ door: u.endsWith('chats') ? 'chats' : 'messages', body });
      const a = over.door ? over.door(body, calls.door.length) : { status: 503 };
      if (a.throws) throw new Error('network');
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
    }
    calls.direct.push({ url: u.replace(DB, ''), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => [{ id: 'new1', title: 'New Chat', pinned: false }] };
  };
  vm.createContext(sandbox);
  const helper = blockOf('w3-business-write-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(helper + '\n' + Object.values(FN).join('\n'), sandbox);
  return sandbox;
}
const run = (w, code) => vm.runInContext(code, w);
const ok = (extra) => ({ body: Object.assign({ ok: true }, extra || {}) });
const refuse = (error, message) => ({ door: () => ({ body: { ok: false, error, message } }) });
const FALLBACKS = [
  ['503', { door: () => ({ status: 503, body: {} }) }],
  ['404', { door: () => ({ status: 404, body: {} }) }],
  ['502', { door: () => ({ status: 502, body: {} }) }],
  ['429', { door: () => ({ status: 429, body: {} }) }],
  ['not_available', { door: () => ({ body: { ok: false, error: 'not_available' } }) }],
  ['a network problem', { door: () => ({ throws: true }) }],
  ['no login on the device', { noLogin: true }]
];
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const HDR = { apikey: 'public-key', Authorization: 'Bearer public-key', 'Content-Type': 'application/json', Prefer: 'return=minimal' };
const HDR_REP = { apikey: 'public-key', Authorization: 'Bearer public-key', 'Content-Type': 'application/json', Prefer: 'return=representation' };
const HDR_DEL = { apikey: 'public-key', Authorization: 'Bearer public-key' };
const MSG_URL = '/rest/v1/business_chat_messages?conversation_id=eq.c1&created_at=gte.' + encodeURIComponent(TS);
const wrap = () => ({ dataset: { chatType: 'business', timestamp: TS, rawText: 'hi' }, previousElementSibling: { classList: { contains: (c) => c === 'user' }, dataset: { rawText: 'hi' }, previousElementSibling: null }, nextElementSibling: null, remove() {} });

test('rename: the door gets the chat and the trimmed title (login token, no seller id), then an Undo note; the list is reloaded; no direct write', async () => {
  const w = world({ door: () => ok({ count: 1, undoId: 'u1' }) });
  await run(w, 'window.renameBcConversationPrompt()');
  same(w.calls.door, [{ door: 'chats', body: { token: 'login-token', action: 'rename', conversationId: 'c1', title: 'New title' } }]);
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.lists, 1);
  assert.equal(w.els['w3-bw-note-msg'].textContent, 'Chat renamed.');
  w.calls.door.length = 0;
  await run(w, 'w3BwUndo()');
  assert.equal(w.calls.door[0].body.undoId, 'u1');
  assert.equal(w.calls.lists, 2);
});

test('rename: every way the door cannot answer runs the older direct write exactly as before; an empty title does nothing', async () => {
  for (const [name, over] of FALLBACKS) {
    const w = world(over);
    await run(w, 'window.renameBcConversationPrompt()');
    same(w.calls.direct, [{ url: '/rest/v1/business_chat_conversations?id=eq.c1', method: 'PATCH', headers: HDR, body: { title: 'New title' } }], name);
    assert.equal(w.calls.lists, 1, name);
  }
  const w = world({ title: '   ', door: () => ok() });
  await run(w, 'window.renameBcConversationPrompt()');
  assert.equal(w.calls.door.length + w.calls.direct.length, 0);
});

test('pin: the door gets the new value (the opposite of now), an Undo note, no direct write; the older direct write only without the door', async () => {
  let w = world({ pinned: false, door: () => ok({ count: 1, undoId: 'u2' }) });
  await run(w, 'window.toggleBcConversationPin()');
  same(w.calls.door.map((d) => d.body), [{ token: 'login-token', action: 'setPinned', conversationId: 'c1', pinned: true }]);
  assert.equal(w.els['w3-bw-note-msg'].textContent, 'Chat pinned.');
  w = world({ pinned: true, door: () => ok({ count: 1, undoId: 'u3' }) });
  await run(w, 'window.toggleBcConversationPin()');
  assert.equal(w.calls.door[0].body.pinned, false);
  assert.equal(w.els['w3-bw-note-msg'].textContent, 'Chat unpinned.');
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.toggleBcConversationPin()');
    same(w.calls.direct, [{ url: '/rest/v1/business_chat_conversations?id=eq.c1', method: 'PATCH', headers: HDR, body: { pinned: true } }], name);
  }
});

test('new chat: the door creates it and its answer is opened; the older direct request only without the door', async () => {
  let w = world({ door: () => ok({ conversation: { id: 'n9', title: 'New Chat', pinned: false }, undoId: 'u4' }) });
  await run(w, 'window.startNewBusinessChat()');
  same(w.calls.door.map((d) => d.body), [{ token: 'login-token', action: 'create' }]);
  assert.equal(w.calls.direct.length, 0);
  assert.equal(run(w, 'activeConversationId'), 'n9');
  assert.equal(w.calls.lists, 1);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.startNewBusinessChat()');
    same(w.calls.direct, [{ url: '/rest/v1/business_chat_conversations', method: 'POST', headers: HDR_REP, body: { chat_id: '111', title: 'New Chat' } }], name);
    assert.equal(run(w, 'activeConversationId'), 'new1', name);
  }
});

test('delete chat: check, then apply with the digest, an Undo note, then the screen goes on as before; the older direct delete only without the door', async () => {
  let w = world({ door: (b) => (b.action === 'deleteCheck' ? ok({ count: 3, digest: 'dg1' }) : ok({ count: 4, messages: 3, undoId: 'u5' })) });
  await run(w, 'window.deleteBusinessConversation("c1")');
  same(w.calls.door.map((d) => d.body), [{ token: 'login-token', action: 'deleteCheck', conversationId: 'c1' }, { token: 'login-token', action: 'deleteApply', conversationId: 'c1', digest: 'dg1' }]);
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.els['w3-bw-note-msg'].textContent, 'Chat deleted.');
  same(w.calls.opened, ['c2']);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.deleteBusinessConversation("c1")');
    same(w.calls.direct, [{ url: '/rest/v1/business_chat_conversations?id=eq.c1', method: 'DELETE', headers: HDR_DEL }], name);
    same(w.calls.opened, ['c2'], name);
  }
});

test('delete chat: "changed" reloads the list with the door words; no_chat means already gone; any other refusal keeps the screen; never a direct delete', async () => {
  let w = world(refuse('changed', 'x'));
  await run(w, 'window.deleteBusinessConversation("c1")');
  assert.equal(w.els['w3-bw-note-msg'].textContent, 'This chat changed, look at it again.');
  assert.equal(w.calls.lists, 1);
  assert.equal(w.calls.direct.length, 0);
  w = world(refuse('no_chat', 'x'));
  await run(w, 'window.deleteBusinessConversation("c1")');
  assert.equal(w.calls.direct.length, 0);
  same(w.calls.opened, ['c2']);
  for (const [error, message] of [['not_logged_in', undefined], ['no_seller', 'No business.'], ['too_many', 'Too many.']]) {
    w = world(refuse(error, message));
    await run(w, 'window.deleteBusinessConversation("c1")');
    assert.equal(w.calls.direct.length, 0, error);
    assert.equal(w.calls.lists, 0, error);
    assert.equal(w.calls.opened.length, 0, error);
    assert.ok(w.els['w3-bw-note-msg'].textContent.includes(error === 'not_logged_in' ? 'sign out and sign in again' : message), error);
  }
});

test('Retry: check and apply on the Messages door with the stale answer time, an Undo note, then the question is sent again; the older direct delete only without the door', async () => {
  let w = world({ door: (b) => (b.action === 'deleteFromCheck' ? ok({ count: 2, digest: 'dg2' }) : ok({ count: 2, deleted: 2, undoId: 'u6' })) });
  await run(w, 'window.retryAiMessage(__wrap())');
  same(w.calls.door.map((d) => [d.door, d.body]), [['messages', { token: 'login-token', action: 'deleteFromCheck', conversationId: 'c1', from: TS }], ['messages', { token: 'login-token', action: 'deleteFromApply', conversationId: 'c1', from: TS, digest: 'dg2' }]]);
  assert.equal(w.calls.direct.length, 0);
  same(w.calls.sent, ['hi']);
  assert.equal(w.els['w3-bw-note-msg'].textContent, 'Messages removed.');
  w.calls.door.length = 0;
  await run(w, 'w3BwUndo()');
  same(w.calls.door.map((d) => [d.door, d.body.action, d.body.undoId]), [['messages', 'undo', 'u6']]);
  same(w.calls.opened, ['c1']);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.retryAiMessage(__wrap())');
    same(w.calls.direct, [{ url: MSG_URL, method: 'DELETE', headers: HDR_DEL }], name);
    same(w.calls.sent, ['hi'], name);
  }
});

test('Edit: the same delete, then the text goes back in the input box; the older direct delete only without the door', async () => {
  let w = world({ door: (b) => (b.action === 'deleteFromCheck' ? ok({ count: 1, digest: 'dg3' }) : ok({ count: 1, deleted: 1, undoId: 'u7' })) });
  await run(w, 'window.editUserMessage(__wrap())');
  assert.equal(w.calls.door.length, 2);
  assert.equal(w.calls.door[1].body.action, 'deleteFromApply');
  assert.equal(w.els['bc-input'].value, 'hi');
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.editUserMessage(__wrap())');
    same(w.calls.direct, [{ url: MSG_URL, method: 'DELETE', headers: HDR_DEL }], name);
    assert.equal(w.els['bc-input'].value, 'hi', name);
  }
});

test('Retry and Edit: "changed" is tried once more; a refusal never falls back, shows the door words, reloads the chat and does nothing else', async () => {
  let n = 0;
  let w = world({ door: (b) => (b.action === 'deleteFromCheck' ? ok({ count: 1, digest: 'dg' + (++n) }) : (n === 1 ? { body: { ok: false, error: 'changed', message: 'Changed.' } } : ok({ count: 1, deleted: 1, undoId: 'u8' }))) });
  await run(w, 'window.retryAiMessage(__wrap())');
  same(w.calls.door.map((d) => d.body.action), ['deleteFromCheck', 'deleteFromApply', 'deleteFromCheck', 'deleteFromApply']);
  same(w.calls.sent, ['hi']);
  for (const [error, message] of [['changed', 'Changed again.'], ['no_message', 'No such message.'], ['no_chat', 'No chat.'], ['not_logged_in', undefined], ['too_many', 'Too many.']]) {
    for (const code of ['window.retryAiMessage(__wrap())', 'window.editUserMessage(__wrap())']) {
      w = world(refuse(error, message));
      await run(w, code);
      assert.equal(w.calls.direct.length, 0, error);
      assert.equal(w.calls.sent.length, 0, error);
      assert.ok(!w.els['bc-input'] || w.els['bc-input'].value === '', error);
      same(w.calls.opened, ['c1'], error);
      assert.ok(w.els['w3-bw-note-msg'].textContent.includes(error === 'not_logged_in' ? 'sign out and sign in again' : message), error);
    }
  }
});

test('a door that went away between the check and the apply: nothing was changed, so the older direct delete runs once', async () => {
  const w = world({ door: (b) => (b.action === 'deleteFromCheck' ? ok({ count: 1, digest: 'dg' }) : { status: 503, body: {} }) });
  await run(w, 'window.retryAiMessage(__wrap())');
  same(w.calls.direct, [{ url: MSG_URL, method: 'DELETE', headers: HDR_DEL }]);
  same(w.calls.sent, ['hi']);
});

test('an Undo the door refuses shows its words; a door that cannot answer says nothing was changed', async () => {
  let w = world({ door: (b) => (b.action === 'undo' ? { body: { ok: false, error: 'changed', message: 'Changed again since.' } } : ok({ count: 1, undoId: 'u1' })) });
  await run(w, 'window.toggleBcConversationPin()');
  await run(w, 'w3BwUndo()');
  assert.equal(w.els['w3-bw-note-msg'].textContent, 'Changed again since.');
  w = world({ door: (b, n) => (n === 1 ? ok({ count: 1, undoId: 'u1' }) : { status: 503, body: {} }) });
  await run(w, 'window.toggleBcConversationPin()');
  await run(w, 'w3BwUndo()');
  assert.ok(w.els['w3-bw-note-msg'].textContent.includes('Nothing was changed'));
});

test('after a 429 or 503 a door is left alone for 30 seconds on its own (the other door is not paused); a refusal, 404 and 502 do not pause it', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: () => ({ status, body: {} }) });
    await run(w, 'window.toggleBcConversationPin()');
    await run(w, 'window.toggleBcConversationPin()');
    assert.equal(w.calls.door.length, 1);
    assert.equal(w.calls.direct.length, 2);
    const left = run(w, 'W3_BW_DOORS.chats.pausedUntil') - Date.now();
    assert.ok(left > 25000 && left <= 30000);
    assert.equal(run(w, 'W3_BW_DOORS.messages.pausedUntil'), 0);
  }
  for (const over of [refuse('not_logged_in'), { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) }]) {
    const w = world(over);
    await run(w, 'window.toggleBcConversationPin()');
    assert.equal(run(w, 'W3_BW_DOORS.chats.pausedUntil'), 0);
  }
});
