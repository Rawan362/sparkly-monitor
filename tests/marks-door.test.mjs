// Run with:  node --test tests/*.test.mjs
// Star and pin marks on chat messages (Seller Chats door, toggleStar and togglePin): door first, the older read and PATCH kept as the fallback.
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
const STAR = codeOf('window.toggleStarMessage = async function');
const PIN = codeOf('window.togglePinMessage = async function');

test('the new code and this test file contain only ASCII characters', () => {
  const files = { block: blockOf('w4-marks-door'), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the older read and PATCH are still in the file', () => {
  assert.ok(STAR.includes("sb(table + '?id=eq.' + id + '&select=starred')") && STAR.includes("method: 'PATCH'"));
  assert.ok(PIN.includes("sb(table + '?id=eq.' + id + '&select=pinned')") && PIN.includes("method: 'PATCH'"));
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

const URL_ = 'https://sparklly.site/webhook/seller-chats';
/** over.door(body) answers { status, body } or throws; over.noLogin: no login; over.ahmad: the assistant chat is open. */
function world(over = {}) {
  const calls = { door: [], sb: [], patch: [], alerts: [], ahmad: 0, thread: 0 };
  const sandbox = {
    calls, JSON, Date, Object, Array, String, Promise, Error, RegExp, window: {}, SELLER_CHATS_URL: URL_,
    SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'public-key', ahmadChatOpen: !!over.ahmad, activePhone: over.ahmad ? null : '9647700000000',
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token'), closeMessageActionMenu() {},
    sb: async (p) => { calls.sb.push(p); return [{ starred: false, pinned: true }]; },
    renderAhmadChatPanel: () => { calls.ahmad++; }, loadThread: () => { calls.thread++; }, alert: (m) => calls.alerts.push(m),
  };
  sandbox.fetch = async (url, init) => {
    if (url === URL_) {
      const body = JSON.parse(init.body);
      calls.door.push(body);
      const a = over.door ? over.door(body) : { status: 503, body: {} };
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => { if (a.badJson) throw new Error('x'); return a.body; } };
    }
    calls.patch.push({ url: url.slice(sandbox.SUPABASE_URL.length), body: JSON.parse(init.body), method: init.method });
    return { ok: true, status: 204 };
  };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w4-marks-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var '), sandbox);
  vm.runInContext(STAR + '\n' + PIN, sandbox);
  return sandbox;
}
const ok = (extra = {}) => ({ body: { ok: true, count: 1, value: true, undoId: 'u1', ...extra } });
const FALLBACKS = [
  ['503', { status: 503, body: { ok: false, error: 'not_available' } }],
  ['404', { status: 404, body: {} }],
  ['502', { status: 502, body: {} }],
  ['not_available answer', { body: { ok: false, error: 'not_available' } }],
  ['refused connection or network problem', 'throw'],
];
const doorFor = (a) => (a === 'throw' ? () => { throw new Error('offline'); } : () => a);
const toggle = (w, action, table, id) => vm.runInContext('w4MarkToggle(' + JSON.stringify(action) + ', ' + JSON.stringify(table) + ', ' + JSON.stringify(id) + ')', w);

test('the door takes the call: the login token, the action, the table and the id, and no seller or mark', async () => {
  const w = world({ door: () => ok() });
  const r = await toggle(w, 'toggleStar', 'conversations', 42);
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.door[0], { token: 'login-token', action: 'toggleStar', table: 'conversations', id: 42 });
});

test('503, 404, 502, not_available, a refused connection, a network problem or no login fall back', async () => {
  for (const [name, a] of FALLBACKS) assert.equal((await toggle(world({ door: doorFor(a) }), 'toggleStar', 'conversations', 1)).fallback, true, name);
  const n = world({ noLogin: true, door: () => ok() });
  assert.equal((await toggle(n, 'toggleStar', 'conversations', 1)).fallback, true);
  assert.equal(n.calls.door.length, 0);
});

test('a table or an id the door would refuse takes the older path without a call', async () => {
  for (const [table, id] of [['business_chat_messages', 1], ['conversations', 'a b'], ['conversations', ''], ['conversations', 'x'.repeat(65)], ['conversations; drop', 1]]) {
    const w = world({ door: () => ok() });
    assert.equal((await toggle(w, 'togglePin', table, id)).fallback, true);
    assert.equal(w.calls.door.length, 0);
  }
  const u = world({ door: () => ok() });
  assert.equal((await toggle(u, 'togglePin', 'seller_web_chat_log', '0b1c2d3e-aaaa-bbbb-cccc-1234567890ab')).ok, true);
});

test('a 429 is never retried directly; a login problem or any refusal never falls back', async () => {
  const t = await toggle(world({ door: () => ({ status: 429, body: {} }) }), 'toggleStar', 'conversations', 1);
  assert.equal(t.fallback, undefined);
  assert.equal(t.ok, false);
  assert.equal(t.message, 'Please try again in a moment.');
  for (const body of [{ ok: false, error: 'not_logged_in' }, { ok: false, error: 'no_message', message: 'Gone.' }, { ok: false, error: 'changed', message: 'Changed.' }, { ok: false, error: 'unconfirmed', message: 'Reload.' }, { ok: false, error: 'undo_unavailable' }]) {
    const r = await toggle(world({ door: () => ({ body }) }), 'togglePin', 'conversations', 1);
    assert.equal(r.fallback, undefined);
    assert.equal(r.ok, false);
    assert.equal(r.relogin === true, body.error === 'not_logged_in');
  }
  assert.equal((await toggle(world({ door: () => ({ status: 500, badJson: true }) }), 'toggleStar', 'conversations', 1)).ok, false);
});

test('after a 503 the door is left alone for 30 seconds; a 404 does not pause', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }) });
  await toggle(w, 'toggleStar', 'conversations', 1);
  assert.equal((await toggle(w, 'toggleStar', 'conversations', 1)).fallback, true);
  assert.equal(w.calls.door.length, 1);
  const left = vm.runInContext('w4MarkPausedUntil - Date.now()', w);
  assert.ok(left > 29000 && left <= 30000, String(left));
  vm.runInContext('w4MarkPausedUntil = Date.now() - 1', w);
  await toggle(w, 'toggleStar', 'conversations', 1);
  assert.equal(w.calls.door.length, 2);
  const n = world({ door: () => ({ status: 404, body: {} }) });
  await toggle(n, 'toggleStar', 'conversations', 1); await toggle(n, 'toggleStar', 'conversations', 1);
  assert.equal(n.calls.door.length, 2);
});

test('star and pin: the door does it, the chat reloads, no direct read and no PATCH', async () => {
  for (const [fn, action] of [['toggleStarMessage', 'toggleStar'], ['togglePinMessage', 'togglePin']]) {
    const t = world({ door: () => ok() });
    await vm.runInContext('window.' + fn + '(7, "conversations")', t);
    assert.deepEqual(t.calls.door[0], { token: 'login-token', action, table: 'conversations', id: 7 });
    assert.equal(t.calls.sb.length, 0);
    assert.equal(t.calls.patch.length, 0);
    assert.equal(t.calls.thread, 1);
    const a = world({ ahmad: true, door: () => ok() });
    await vm.runInContext('window.' + fn + '(8, "seller_web_chat_log")', a);
    assert.equal(a.calls.ahmad, 1);
    assert.equal(a.calls.sb.length, 0);
  }
});

test('star and pin: every fallback runs the older read and PATCH exactly as before', async () => {
  for (const [name, a] of FALLBACKS) {
    const s = world({ door: doorFor(a) });
    await vm.runInContext('window.toggleStarMessage(7, "conversations")', s);
    assert.equal(s.calls.sb[0], 'conversations?id=eq.7&select=starred', name);
    assert.deepEqual(s.calls.patch[0], { url: '/rest/v1/conversations?id=eq.7', body: { starred: true }, method: 'PATCH' });
    assert.equal(s.calls.thread, 1);
    const p = world({ door: doorFor(a) });
    await vm.runInContext('window.togglePinMessage(9, "seller_web_chat_log")', p);
    assert.equal(p.calls.sb[0], 'seller_web_chat_log?id=eq.9&select=pinned');
    assert.deepEqual(p.calls.patch[0].body, { pinned: false });
  }
  const n = world({ noLogin: true });
  await vm.runInContext('window.toggleStarMessage(7, "conversations")', n);
  assert.equal(n.calls.door.length, 0);
  assert.equal(n.calls.patch.length, 1);
});

test('star and pin: a refusal or a 429 tells the person, reloads, and never reads or patches directly; a gone message only reloads', async () => {
  for (const a of [{ status: 429, body: {} }, { body: { ok: false, error: 'not_logged_in' } }, { body: { ok: false, error: 'changed', message: 'This changed. Look again.' } }]) {
    const w = world({ door: () => a });
    await vm.runInContext('window.toggleStarMessage(7, "conversations")', w);
    assert.equal(w.calls.sb.length, 0);
    assert.equal(w.calls.patch.length, 0);
    assert.equal(w.calls.alerts.length, 1);
    assert.equal(w.calls.thread, 1);
  }
  const g = world({ door: () => ({ body: { ok: false, error: 'no_message', message: 'Gone.' } }) });
  await vm.runInContext('window.togglePinMessage(7, "conversations")', g);
  assert.equal(g.calls.alerts.length, 0);
  assert.equal(g.calls.thread, 1);
  assert.equal(g.calls.patch.length, 0);
});
