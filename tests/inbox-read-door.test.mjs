// Run with:  node --test tests/*.test.mjs
// The notification list and the Inbox / AI agent cards read the Seller Inbox Read door first (notifications, notification, inboxList, question,
// chatNeeded, groups), with the older direct reads kept as the fallback. The door and the database are faked by the test (vm, no browser).
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
  loadNotifications: grab('async function loadNotifications('),
  discuss: grab('window.discussNotification = async function('),
  openQuestion: grab('window.openQuestionFromNotification = async function('),
  loadInbox: grab('async function loadInboxList('),
  groups: grab('async function agentLoadGroups('),
  startLesson: grab('async function startLessonIfNeeded(')
};

test('the new code and this test file contain only ASCII characters', () => {
  const added = Object.values(FN).join('\n').split('\n').filter((l) => /door|W3-|w3Inbox|w3Question/.test(l)).join('\n');
  const files = { block: blockOf('w3-inbox-read-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is higher than 315 and every older direct read is still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 316);
  for (const [fn, needle] of [
    ['loadNotifications', "'seller_notifications?seller_id=eq.' + SELLER_CHAT_ID + '&select=*&order=created_at.desc&limit=100'"],
    ['discuss', "'seller_notifications?id=eq.' + id + '&select=*&limit=1'"],
    ['loadInbox', "'pending_questions?seller_id=eq.' + SELLER_CHAT_ID + '&status=in.(pending,lesson)&select=*&order=created_at.desc'"],
    ['groups', "'customer_groups?seller_id=eq.' + encodeURIComponent(SELLER_CHAT_ID) + '&select=id,name&order=created_at.asc'"],
    ['startLesson', "'pending_questions?seller_id=eq.' + SELLER_CHAT_ID + '&phone_number=eq.' + encodeURIComponent(phone) + '&kind=eq.chat_needed&status=eq.pending&select=*&limit=1'"]
  ]) assert.ok(FN[fn].includes(needle), fn);
  assert.ok(blockOf('w3-inbox-read-door').includes("'pending_questions?id=eq.' + qid + '&seller_id=eq.' + SELLER_CHAT_ID + '&select=*&limit=1'"));
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

const N1 = { id: 5, type: 'daily_summary', title: 'T', message: 'M', is_read: false, created_at: '2026-11-27T10:00:00Z', order_id: null, customer_phone: null, question_id: null };
const Q1 = { id: 9, kind: 'chat_needed', status: 'pending', phone_number: '9647700000001', question: 'Q', answer: null, answer_scope: null, department: null, created_at: '2026-11-27T10:00:00Z', meta: null };
const QL = Object.assign({}, Q1, { status: 'lesson' });

function world(over = {}) {
  const calls = { door: [], rest: [], writes: [], opened: [], alerts: [], debug: [], bc: 0, goChats: 0 };
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', style: {}, value: '', appendChild() {} });
  const sandbox = {
    calls, els, SELLER_CHAT_ID: '111', SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'public', agentGroups: [], NOTIFICATION_TYPE_LABELS: {},
    JSON, Date, Object, Promise, encodeURIComponent, String, Array, Number, Error,
    debugLog: (m) => calls.debug.push(m), alert: (m) => calls.alerts.push(m), confirm: () => true,
    escapeHtml: (x) => String(x), formatRelativeTime: () => 'now', agentKindsLabel: () => 'x', renderNotificationItem: (n) => '<n' + n.id + '>',
    openInboxDetail: (q) => calls.opened.push(q.id), closeNotificationsPanel() {}, goToChats() { calls.goChats++; }, openSellerInboxFromChats: async () => {},
    startNewBusinessChat: async () => { calls.bc++; }, showBcEmptyState() {}, renderBcMessage: () => ({}), sendBusinessChatTurn: async () => {},
    checkNotificationsDot() {}, checkInboxDot() {}, setTimeout, window: {},
    document: { getElementById: el, createElement: () => ({ className: '', set innerHTML(v) {}, querySelector: () => ({}) }) },
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token')
  };
  sandbox.fetch = async (url, init) => {
    if (String(url).endsWith('/webhook/seller-inbox-read')) {
      const body = JSON.parse(init.body);
      calls.door.push({ url, body });
      const a = over.door ? over.door(body, calls.door.length) : { status: 503 };
      if (a.throws) throw new Error('network');
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
    }
    calls.writes.push({ url, method: init && init.method });
    return { ok: true, status: 200, json: async () => [] };
  };
  sandbox.sb = async (p) => {
    calls.rest.push(p);
    if (p.startsWith('seller_notifications?seller_id')) return [N1];
    if (p.startsWith('seller_notifications?id=')) return [N1];
    if (p.startsWith('pending_questions?seller_id=eq.111&status')) return [Q1];
    if (p.startsWith('pending_questions?seller_id=eq.111&phone_number')) return [Q1];
    if (p.startsWith('pending_questions?id=')) return [Q1];
    if (p.startsWith('customer_groups?')) return [{ id: 1, name: 'G' }];
    return [];
  };
  vm.createContext(sandbox);
  const helper = blockOf('w3-inbox-read-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(helper + '\n' + Object.values(FN).join('\n'), sandbox);
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

test('notifications: the door list is drawn, with the login token and no seller id, and no direct read', async () => {
  const w = world({ door: () => ({ body: { ok: true, notifications: [N1, Object.assign({}, N1, { id: 6 })] } }) });
  await run(w, 'loadNotifications()');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'notifications' }));
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-inbox-read'));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.els['notifications-list'].innerHTML, '<n5><n6>');
});

test('notifications: an empty door list shows the empty message (not the older read)', async () => {
  const w = world({ door: () => ({ body: { ok: true, notifications: [] } }) });
  await run(w, 'loadNotifications()');
  assert.equal(w.calls.rest.length, 0);
  assert.ok(w.els['notifications-list'].innerHTML.includes('notifications-empty-msg'));
});

test('notifications: every way the door cannot answer runs the older direct read as before', async () => {
  for (const [name, over] of FALLBACKS) {
    const w = world(over);
    await run(w, 'loadNotifications()');
    assert.equal(w.calls.rest.length, 1, name);
    assert.equal(w.els['notifications-list'].innerHTML, '<n5>', name);
  }
});

test('notifications: a refusal never falls back; a login problem shows the sign-in words, any other the screen error', async () => {
  for (const error of REFUSALS) {
    const w = world(refuse(error));
    await run(w, 'loadNotifications()');
    assert.equal(w.calls.rest.length, 0, error);
    const text = w.els['notifications-list'].innerHTML;
    assert.ok(error === 'not_logged_in' ? text.includes('sign out and sign in again') : text.includes('Could not load notifications'), error);
  }
});

test('discussNotification: one notification by id from the door; not found or refused does nothing; the older read only when the door cannot answer', async () => {
  let w = world({ door: () => ({ body: { ok: true, notification: N1 } }) });
  await run(w, 'window.discussNotification(5)');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'notification', id: 5 }));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.bc, 1);
  w = world(refuse('no_notification'));
  await run(w, 'window.discussNotification(5)');
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.bc, 0);
  assert.equal(w.calls.alerts.length, 0);
  for (const error of REFUSALS) {
    w = world(refuse(error));
    await run(w, 'window.discussNotification(5)');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(w.calls.bc, 0, error);
    assert.equal(w.calls.alerts.length, error === 'not_logged_in' ? 1 : 0, error);
  }
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.discussNotification(5)');
    assert.equal(w.calls.rest.length, 1, name);
    assert.equal(w.calls.bc, 1, name);
  }
});

test('Inbox list: the door cards are drawn; the older read only when the door cannot answer; a refusal shows the screen error', async () => {
  let w = world({ door: () => ({ body: { ok: true, questions: [Q1, QL] } }) });
  await run(w, 'loadInboxList()');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'inboxList' }));
  assert.equal(w.calls.rest.length, 0);
  w = world({ door: () => ({ body: { ok: true, questions: [] } }) });
  await run(w, 'loadInboxList()');
  assert.equal(w.calls.rest.length, 0);
  assert.ok(w.els['inbox-list'].innerHTML.includes('Nothing waiting'));
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'loadInboxList()');
    assert.equal(w.calls.rest.length, 1, name);
  }
  for (const error of REFUSALS) {
    w = world(refuse(error));
    await run(w, 'loadInboxList()');
    assert.equal(w.calls.rest.length, 0, error);
    assert.ok(w.els['inbox-list'].innerHTML.includes(error === 'not_logged_in' ? 'sign out and sign in again' : 'Could not load the inbox'), error);
  }
});

test('open a question from a notification: one card by id from the door; no_question is "not found"; the older read (with the seller) only without the door', async () => {
  let w = world({ door: () => ({ body: { ok: true, question: Q1 } }) });
  await run(w, 'window.openQuestionFromNotification(5, 9)');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'question', id: 9 }));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(JSON.stringify(w.calls.opened), '[9]');
  w = world({ door: () => ({ body: { ok: true, question: Object.assign({}, Q1, { status: 'answered' }) } }) });
  await run(w, 'window.openQuestionFromNotification(5, 9)');
  assert.equal(w.calls.opened.length, 0);
  assert.equal(w.calls.alerts[0], 'You already answered this one.');
  w = world(refuse('no_question'));
  await run(w, 'window.openQuestionFromNotification(5, 9)');
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.opened.length, 0);
  assert.equal(w.calls.alerts.length, 0);
  for (const error of REFUSALS) {
    w = world(refuse(error));
    await run(w, 'window.openQuestionFromNotification(5, 9)');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(w.calls.opened.length, 0, error);
  }
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.openQuestionFromNotification(5, 9)');
    assert.equal(w.calls.rest.length, 1, name);
    assert.ok(w.calls.rest[0].startsWith('pending_questions?id=eq.9&seller_id=eq.111'), name);
    assert.equal(w.calls.opened.length, 1, name);
  }
});

test('groups: the door list is used; a refusal shows no groups and never falls back; the older read only when the door cannot answer', async () => {
  let w = world({ door: () => ({ body: { ok: true, groups: [{ id: 3, name: 'Wholesale' }] } }) });
  await run(w, 'agentLoadGroups()');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'groups' }));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(JSON.stringify(run(w, 'agentGroups')), '[{"id":3,"name":"Wholesale"}]');
  for (const error of REFUSALS) {
    w = world(refuse(error));
    await run(w, 'agentLoadGroups()');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(run(w, 'agentGroups.length'), 0, error);
  }
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'agentLoadGroups()');
    assert.equal(w.calls.rest.length, 1, name);
    assert.equal(run(w, 'agentGroups.length'), 1, name);
  }
});

test('turning the AI back on: the door says if a card waits; none = nothing happens; a card = the same write as before, then the fresh read from the door', async () => {
  let w = world({ door: (b) => ({ body: b.action === 'chatNeeded' ? { ok: true, question: null } : { ok: true, question: QL } }) });
  await run(w, 'startLessonIfNeeded("9647700000001")');
  assert.equal(JSON.stringify(w.calls.door[0].body), JSON.stringify({ token: 'login-token', action: 'chatNeeded', phone: '9647700000001' }));
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.writes.length, 0);
  w = world({ door: (b) => ({ body: b.action === 'chatNeeded' ? { ok: true, question: Q1 } : { ok: true, question: QL } }) });
  await run(w, 'startLessonIfNeeded("9647700000001")');
  assert.equal(w.calls.door.length, 2);
  assert.equal(w.calls.door[1].body.action, 'question');
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.writes.length, 1);
  assert.ok(w.calls.writes[0].url.endsWith('/rest/v1/pending_questions?id=eq.9'));
  assert.equal(w.calls.writes[0].method, 'PATCH');
  assert.equal(JSON.stringify(w.calls.opened), '[9]');
  for (const error of REFUSALS) {
    w = world(refuse(error));
    await run(w, 'startLessonIfNeeded("9647700000001")');
    assert.equal(w.calls.rest.length, 0, error);
    assert.equal(w.calls.writes.length, 0, error);
  }
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'startLessonIfNeeded("9647700000001")');
    assert.equal(w.calls.rest.length, 2, name);   // the waiting card and the fresh read
    assert.equal(w.calls.writes.length, 1, name);
    assert.equal(w.calls.opened.length, 1, name);
  }
});

test('after a 429 or 503 the door is left alone for 30 seconds, by all six reads; a refusal, 404 and 502 do not pause it', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: () => ({ status, body: {} }) });
    await run(w, 'loadNotifications()');
    await run(w, 'loadInboxList()');
    await run(w, 'agentLoadGroups()');
    assert.equal(w.calls.door.length, 1);
    assert.equal(w.calls.rest.length, 3);
    const left = run(w, 'w3InboxPausedUntil') - Date.now();
    assert.ok(left > 25000 && left <= 30000);
  }
  for (const over of [refuse('not_logged_in'), { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) }]) {
    const w = world(over);
    await run(w, 'loadNotifications()');
    assert.equal(run(w, 'w3InboxPausedUntil'), 0);
  }
});
