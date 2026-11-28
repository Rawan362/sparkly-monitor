// Run with:  node --test tests/*.test.mjs
// The Notifications panel writes (read or unread, mark all read, delete one, delete selected, and the "open" buttons that mark a notification read)
// go through the Seller Notifications door first, with the older direct writes kept as the fallback. Refusals never fall back.
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
const FN = {
  toggle: grab('window.toggleNotificationRead = async function('),
  markAll: grab('window.markAllNotificationsRead = async function('),
  deleteOne: grab('window.deleteOneNotification = async function('),
  deleteSelected: grab('window.deleteSelectedNotifications = async function('),
  openChats: grab('window.w1OpenChatsFromNotice = async function('),
  openQuestion: grab('window.openQuestionFromNotification = async function('),
  escalation: grab('window.openEscalationChat = async function('),
  discuss: grab('window.discussNotification = async function(')
};

test('the new code and this test file contain only ASCII characters', () => {
  const added = Object.values(FN).join('\n').split('\n').filter((l) => /door|W3-|w3Nt/.test(l)).join('\n');
  const files = { block: blockOf('w3-notifications-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is higher than 315', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 316);
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
function stubEl(els) {
  const el = { style: {}, dataset: {}, children: [], textContent: '', innerHTML: '', onclick: null, appendChild(c) { el.children.push(c); }, setAttribute() {} };
  Object.defineProperty(el, 'id', { set(v) { els[v] = el; }, get() { return ''; } });
  return el;
}
function world(over = {}) {
  const calls = { door: [], direct: [], loads: 0, dots: 0, chats: 0, sb: 0, bc: 0 };
  const els = {};
  let ticks = 0;
  const sandbox = {
    calls, els, SELLER_CHAT_ID: '111', SUPABASE_URL: DB, SUPABASE_ANON_KEY: 'public-key', NOTIFICATION_TYPE_LABELS: {},
    JSON, Date, Object, Promise, encodeURIComponent, String, Array, Number, Error, setTimeout: () => ++ticks, clearTimeout() {},
    debugLog() {}, alert() {}, window: {},
    loadNotifications: async () => { calls.loads++; }, checkNotificationsDot: async () => { calls.dots++; },
    exitNotificationsSelectMode() {}, closeNotificationsPanel() {}, goToChats() { calls.chats++; }, openSellerInboxFromChats: async () => {}, openInboxDetail() {},
    selectConvo() {}, conversations: [{ phone_number: '9647700000001' }], loadConversations: async () => {},
    startNewBusinessChat: async () => { calls.bc++; }, showBcEmptyState() {}, renderBcMessage: () => ({}), sendBusinessChatTurn: async () => {},
    sb: async () => { calls.sb++; return [{ id: 5, type: 'x', title: 'T', message: 'M', is_read: false }]; },
    document: {
      body: { appendChild() {} },
      getElementById: (id) => els[id] || null,
      createElement: () => stubEl(els),
      querySelectorAll: () => (over.checked || []).map((id) => ({ dataset: { id: String(id) } }))
    },
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token')
  };
  sandbox.fetch = async (url, init) => {
    if (String(url).endsWith('/webhook/seller-notifications')) {
      const body = JSON.parse(init.body);
      calls.door.push({ url, body });
      const a = over.door ? over.door(body, calls.door.length) : { status: 503 };
      if (a.throws) throw new Error('network');
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
    }
    calls.direct.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { ok: true, status: 200, json: async () => [] };
  };
  vm.createContext(sandbox);
  const helper = blockOf('w3-notifications-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(helper + '\n' + Object.values(FN).join('\n'), sandbox);
  return sandbox;
}
const run = (w, code) => vm.runInContext(code, w);
const ok = (extra) => ({ body: Object.assign({ ok: true }, extra || {}) });
const doorBodies = (w) => w.calls.door.map((d) => JSON.stringify(d.body));
const FALLBACKS = [
  ['503', { door: () => ({ status: 503, body: {} }) }],
  ['404', { door: () => ({ status: 404, body: {} }) }],
  ['502', { door: () => ({ status: 502, body: {} }) }],
  ['429', { door: () => ({ status: 429, body: {} }) }],
  ['not_available', { door: () => ({ body: { ok: false, error: 'not_available' } }) }],
  ['a network problem', { door: () => ({ throws: true }) }],
  ['no login on the device', { noLogin: true }]
];
const REFUSALS = ['not_logged_in', 'no_seller', 'no_notification', 'bad_input', 'save_failed', 'changed'];
const refuse = (error, message) => ({ door: () => ({ body: { ok: false, error, message } }) });
const HDR_JSON = { apikey: 'public-key', Authorization: 'Bearer public-key', 'Content-Type': 'application/json', Prefer: 'return=minimal' };
const HDR_DEL = { apikey: 'public-key', Authorization: 'Bearer public-key', Prefer: 'return=minimal' };
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

test('read or unread: the door gets the id and the new value with the login token and no seller id; the list and the dot are refreshed', async () => {
  const w = world({ door: () => ok({ count: 1, undoId: 'u1' }) });
  await run(w, 'window.toggleNotificationRead(5, true)');
  await run(w, 'window.toggleNotificationRead(6, false)');
  assert.deepEqual(doorBodies(w), [JSON.stringify({ token: 'login-token', action: 'setRead', id: 5, read: true }), JSON.stringify({ token: 'login-token', action: 'setRead', id: 6, read: false })]);
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-notifications'));
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.loads, 2);
  assert.equal(w.calls.dots, 2);
});

test('read or unread: every way the door cannot answer runs the older direct write exactly as before', async () => {
  for (const [name, over] of FALLBACKS) {
    const w = world(over);
    await run(w, 'window.toggleNotificationRead(5, false)');
    same(w.calls.direct, [{ url: DB + '/rest/v1/seller_notifications?id=eq.5', method: 'PATCH', headers: HDR_JSON, body: '{"is_read":false}' }], name);
    assert.equal(w.calls.loads, 1, name);
  }
});

test('the four "open" buttons mark the notification read through the door, and the screen goes on', async () => {
  const w = world({ door: () => ok({ count: 1 }) });
  await run(w, 'window.w1OpenChatsFromNotice(5)');
  await run(w, 'window.openQuestionFromNotification(6, 9)');
  await run(w, 'window.openEscalationChat(7, "9647700000001")');
  await run(w, 'window.discussNotification(5)');
  assert.deepEqual(doorBodies(w), [5, 6, 7, 5].map((id) => JSON.stringify({ token: 'login-token', action: 'setRead', id, read: true })));
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.chats, 3);
  assert.equal(w.calls.bc, 1);
});

test('the four "open" buttons: the older direct write when the door cannot answer', async () => {
  for (const [name, over] of FALLBACKS) {
    const w = world(over);
    await run(w, 'window.w1OpenChatsFromNotice(5)');
    await run(w, 'window.openQuestionFromNotification(6, 9)');
    await run(w, 'window.openEscalationChat(7, "9647700000001")');
    await run(w, 'window.discussNotification(5)');
    same(w.calls.direct.map((d) => d.url), [5, 6, 7, 5].map((id) => DB + '/rest/v1/seller_notifications?id=eq.' + id), name);
    assert.ok(w.calls.direct.every((d) => d.method === 'PATCH' && d.body === '{"is_read":true}' && JSON.stringify(d.headers) === JSON.stringify(HDR_JSON)), name);
    assert.equal(w.calls.chats, 3, name);
  }
});

test('the four "open" buttons: a refusal never falls back and never stops the screen; only a login problem is told to the person', async () => {
  for (const error of REFUSALS) {
    const w = world(refuse(error, 'Door words.'));
    await run(w, 'window.w1OpenChatsFromNotice(5)');
    await run(w, 'window.openEscalationChat(7, "9647700000001")');
    assert.equal(w.calls.direct.length, 0, error);
    assert.equal(w.calls.chats, 2, error);
    const note = w.els['w3-nt-note-msg'];
    if (error === 'not_logged_in') assert.ok(note && note.textContent.includes('sign out and sign in again'), error);
    else assert.equal(note, undefined, error);
  }
});

test('mark all as read: one door call; while it says more, again; one Undo undoes every part, last first', async () => {
  const answers = [ok({ count: 1000, more: true, undoId: 'u1' }), ok({ count: 30, more: false, undoId: 'u2' })];
  const w = world({ door: (b, n) => (b.action === 'undo' ? ok({ count: 1 }) : answers[n - 1]) });
  await run(w, 'window.markAllNotificationsRead()');
  assert.deepEqual(doorBodies(w), [JSON.stringify({ token: 'login-token', action: 'markAllRead' }), JSON.stringify({ token: 'login-token', action: 'markAllRead' })]);
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.loads, 1);
  assert.equal(w.els['w3-nt-note-msg'].textContent, 'All notifications marked as read.');
  await run(w, 'w3NtUndo()');
  assert.deepEqual(w.calls.door.slice(2).map((d) => d.body.undoId), ['u2', 'u1']);
  assert.equal(w.els['w3-nt-note-msg'].textContent, 'The change was undone.');
  assert.equal(w.calls.loads, 2);
});

test('mark all as read: nothing to change shows no Undo; the older direct write only when the door cannot answer', async () => {
  let w = world({ door: () => ok({ count: 0, more: false }) });
  await run(w, 'window.markAllNotificationsRead()');
  assert.equal(w.els['w3-nt-note'], undefined);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.markAllNotificationsRead()');
    same(w.calls.direct, [{ url: DB + '/rest/v1/seller_notifications?seller_id=eq.111&is_read=eq.false', method: 'PATCH', headers: HDR_JSON, body: '{"is_read":true}' }], name);
    assert.equal(w.calls.loads, 1, name);
  }
});

test('delete one: the door with the id and an Undo; no_notification means already gone (list reloaded); the older direct delete only without the door', async () => {
  let w = world({ door: (b) => (b.action === 'undo' ? ok({ count: 1 }) : ok({ count: 1, undoId: 'u9' })) });
  await run(w, 'window.deleteOneNotification(5)');
  assert.equal(doorBodies(w)[0], JSON.stringify({ token: 'login-token', action: 'deleteOne', id: 5 }));
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.els['w3-nt-note-msg'].textContent, 'Notification deleted.');
  await run(w, 'w3NtUndo()');
  assert.equal(w.calls.door[1].body.undoId, 'u9');
  w = world(refuse('no_notification', 'gone'));
  await run(w, 'window.deleteOneNotification(5)');
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.loads, 1);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.deleteOneNotification(5)');
    same(w.calls.direct, [{ url: DB + '/rest/v1/seller_notifications?id=eq.5', method: 'DELETE', headers: HDR_DEL, body: undefined }], name);
  }
});

test('delete selected: the door gets the ids (numbers) and an Undo; the older direct delete only without the door', async () => {
  let w = world({ checked: ['5', '6'], door: () => ok({ count: 2, deleted: 2, undoId: 'u7' }) });
  await run(w, 'window.deleteSelectedNotifications()');
  assert.equal(doorBodies(w)[0], JSON.stringify({ token: 'login-token', action: 'deleteSelected', ids: [5, 6] }));
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.els['w3-nt-note-msg'].textContent, 'Notifications deleted.');
  assert.equal(w.calls.loads, 1);
  w = world({ checked: [], door: () => ok() });
  await run(w, 'window.deleteSelectedNotifications()');
  assert.equal(w.calls.door.length, 0);
  for (const [name, over] of FALLBACKS) {
    w = world(Object.assign({ checked: ['5', '6'] }, over));
    await run(w, 'window.deleteSelectedNotifications()');
    same(w.calls.direct, [{ url: DB + '/rest/v1/seller_notifications?id=in.(5,6)', method: 'DELETE', headers: HDR_DEL, body: undefined }], name);
  }
});

test('a refusal never falls back: the door words are shown, nothing is reloaded, and a login problem shows the sign-in words', async () => {
  for (const error of REFUSALS) {
    for (const [fn, code] of [['toggle', 'window.toggleNotificationRead(5, true)'], ['markAll', 'window.markAllNotificationsRead()'], ['deleteSelected', 'window.deleteSelectedNotifications()'], ['deleteOne', 'window.deleteOneNotification(5)']]) {
      const w = world(Object.assign({ checked: ['5'] }, refuse(error, 'Door words for ' + error)));
      await run(w, code);
      assert.equal(w.calls.direct.length, 0, fn + ' ' + error);
      if (fn === 'deleteOne' && error === 'no_notification') { assert.equal(w.calls.loads, 1); continue; }
      assert.equal(w.calls.loads, 0, fn + ' ' + error);
      const text = w.els['w3-nt-note-msg'].textContent;
      assert.ok(error === 'not_logged_in' ? text.includes('sign out and sign in again') : text === 'Door words for ' + error, fn + ' ' + error);
    }
  }
});

test('an Undo the door refuses shows its words and changes nothing else', async () => {
  const w = world({ door: (b) => (b.action === 'undo' ? { body: { ok: false, error: 'changed', message: 'This was changed again.' } } : ok({ count: 1, undoId: 'u1' })) });
  await run(w, 'window.deleteOneNotification(5)');
  await run(w, 'w3NtUndo()');
  assert.equal(w.els['w3-nt-note-msg'].textContent, 'This was changed again.');
  assert.equal(w.calls.direct.length, 0);
});

test('after a 429 or 503 the door is left alone for 30 seconds (the older direct writes meanwhile); a refusal, 404 and 502 do not pause it', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: () => ({ status, body: {} }) });
    await run(w, 'window.toggleNotificationRead(5, true)');
    await run(w, 'window.toggleNotificationRead(6, true)');
    assert.equal(w.calls.door.length, 1);
    assert.equal(w.calls.direct.length, 2);
    const left = run(w, 'w3NtPausedUntil') - Date.now();
    assert.ok(left > 25000 && left <= 30000);
  }
  for (const over of [refuse('not_logged_in', 'x'), { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) }]) {
    const w = world(over);
    await run(w, 'window.toggleNotificationRead(5, true)');
    assert.equal(run(w, 'w3NtPausedUntil'), 0);
  }
});
