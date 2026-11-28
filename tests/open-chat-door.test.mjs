// Run with:  node --test tests/*.test.mjs
// The open chat reads the Seller Chats Read door: the 2.5 s check (chatPoll), the thread (thread) and "Load older messages" (older), with the
// older direct reads kept as the fallback. The door and the database are faked by the test (vm, no browser): nothing leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function between(startNeedle, endNeedle) {
  const a = html.indexOf(startNeedle);
  const b = html.indexOf(endNeedle, a);
  assert.ok(a > 0 && b > a, startNeedle + ' missing');
  return html.slice(a, b);
}
function blockOf(name) { return between('// <' + name + ':js:start>', '// <' + name + ':js:end>'); }
function functionOf(head) {
  const a = html.indexOf(head);
  assert.ok(a > 0, head + ' missing');
  let depth = 0, i = html.indexOf('{', a);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(a, i + 1);
}
const POLL = () => functionOf('async function fastPollOpenChat(');
const THREAD = () => functionOf('async function loadThread(');
const OLDER = () => functionOf('window.loadOlderThreadMessages = async function(');

test('the lines added to the open chat and this test file contain only ASCII characters', () => {
  const marker = /door|Door|W3-/;
  const added = [POLL(), THREAD(), OLDER()].join('\n').split('\n').filter((l) => marker.test(l)).join('\n');
  for (const [name, text] of Object.entries({ added, block: blockOf('w3-chats-read-door'), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') }))
    assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and every older direct read is still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 315);
  assert.ok(POLL().includes("sb(q + '&select=id,timestamp&order=timestamp.desc&limit=1')"));
  assert.ok(POLL().includes("encodeURIComponent(HOLD_MARK + '*') + '&select=id&order=timestamp.desc&limit=3'"));
  assert.ok(THREAD().includes("'&select=id,role,message,timestamp,starred,pinned,channel,wa_message_id,reply_to_wa_id,reply_to_text,is_forwarded&order=timestamp.desc&limit=200'"));
  assert.ok(THREAD().includes("'&select=ai_typing_until'"));
  assert.ok(THREAD().includes('fetchCallRecordingCards(phone, rowsLoaded >= 200'));
  assert.ok(OLDER().includes("'&select=id,role,message,timestamp,starred,pinned,channel&order=timestamp.desc&limit=100'"));
  assert.ok(OLDER().includes('fetchCallRecordingCards(phone, older.length >= 100'));
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

const R1 = { id: 11, role: 'user', message: 'hi', timestamp: '2026-11-27T10:00:00Z', starred: false, pinned: false, channel: 'whatsapp' };
const R2 = { id: 12, role: 'assistant', message: 'hello', timestamp: '2026-11-27T10:01:00Z', starred: false, pinned: false, channel: 'whatsapp' };
const PHONE = '9647700000001';

function world(over = {}) {
  const calls = { door: [], rest: [], updates: [], loads: 0, merged: [] };
  const sandbox = {
    calls, SELLER_CHAT_ID: '111', activePhone: PHONE, JSON, Date, Object, Promise, setTimeout, encodeURIComponent, String, Array, navigator: { onLine: true },
    window: { _threadFlags: {} }, HOLD_MARK: '\u23F3 pending:',
    document: { hidden: false, getElementById: (id) => (id === 'messages' ? { scrollTop: 0, scrollHeight: 0, clientHeight: 0 } : null), querySelector: () => null },
    debugLog() {}, threadRefreshBlockedByRecording: () => false, timingNote() {}, fetchDeliveryContext: async () => null, computeDeliveryState: () => ({ state: 'sent' }),
    getLocallyDeletedIds: () => new Set(), threadFlagsMap: () => ({}),
    tryIncrementalThreadUpdate: (phone, rows, cards, typing) => { calls.updates.push({ rows, cards, typing }); return true; },
    mergeCallCards: (older, cards) => { calls.merged.push({ older, cards }); throw new Error('stop here'); },
    loadThread: async () => { calls.loads++; },
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token'),
    fetchCallRecordingCards: async () => (over.direct && over.direct.cards) || []
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
    if (p.includes('limit=1') && p.includes('select=id,timestamp')) return [{ id: 12, timestamp: R2.timestamp }];
    if (p.includes('like.')) return [];
    if (p.startsWith('conversations?') && p.includes('limit=200')) return [R2, R1];
    if (p.startsWith('client_status?')) return [{ ai_typing_until: new Date(Date.now() + 60000).toISOString() }];
    if (p.includes('timestamp=lt.')) return [R2, R1];
    return [];
  };
  vm.createContext(sandbox);
  const hold = between('// <hold>', '// </hold>').replace(/\bconst /g, 'var ');
  const helper = blockOf('w3-chats-read-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
  vm.runInContext(helper + '\n' + hold + '\nvar _fastPollBusy = false; window._fastNewest = {}; ' + POLL() + '\n' + THREAD() + '\n' + OLDER() + '\nwindow.__older = window.loadOlderThreadMessages;', sandbox);
  return sandbox;
}
const run = (w, code) => vm.runInContext(code, w);
/** The 2.5 s check only decides WHETHER to refresh; the refresh itself is tested separately, so it is replaced by a counter here. */
const stubThread = (w) => run(w, 'loadThread = async function() { calls.loads++; }');
const plain = (v) => JSON.parse(JSON.stringify(v));
const CARDS = [{ id: 7, duration_seconds: 125, ended_at: '2026-11-27T09:03:00Z' }];

test('the 2.5 s check: the door cursor is compared with the last one and the thread is refreshed only when it differs', async () => {
  const w = world({ door: () => ({ body: { ok: true, newest: { id: 12, timestamp: R2.timestamp }, pendingIds: [], cursor: '12|2026-11-27T10:01:00Z#' } }) });
  stubThread(w);
  await run(w, 'fastPollOpenChat()');
  assert.deepEqual(plain(w.calls.door[0].body), { token: 'login-token', action: 'chatPoll', phone: PHONE });
  assert.equal(w.calls.rest.length, 0);
  assert.equal(w.calls.loads, 1);
  run(w, 'window._fastNewest[activePhone] = "12|2026-11-27T10:01:00Z#"');
  await run(w, 'fastPollOpenChat()');
  assert.equal(w.calls.loads, 1, 'same cursor: no refresh');
});

test('the 2.5 s check falls back to the two direct reads on 503, 404, 502, 429, not_available, a network problem or no login, and builds the same cursor', async () => {
  for (const over of [
    { door: () => ({ status: 503, body: {} }) }, { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) },
    { door: () => ({ status: 429, body: {} }) }, { door: () => ({ body: { ok: false, error: 'not_available' } }) }, { door: () => ({ throws: true }) }, { noLogin: true }
  ]) {
    const w = world(over);
    stubThread(w);
    await run(w, 'fastPollOpenChat()');
    assert.equal(w.calls.rest.length, 2);
    assert.equal(w.calls.loads, 1);
  }
});

test('the thread: the door rows (newest first) are reversed, the typing time and the call items come from the door, and no direct read is made', async () => {
  const typing = new Date(Date.now() + 60000).toISOString();
  const w = world({ door: () => ({ body: { ok: true, rows: [R2, R1], aiTypingUntil: typing, calls: CARDS } }) });
  await run(w, 'loadThread("' + PHONE + '", true)');
  assert.deepEqual(plain(w.calls.door[0].body), { token: 'login-token', action: 'thread', phone: PHONE });
  assert.equal(w.calls.rest.length, 0);
  const u = w.calls.updates[0];
  assert.deepEqual(plain(u.rows.map((r) => r.id)), [11, 12]);
  assert.equal(u.typing, true);
  assert.deepEqual(JSON.parse(JSON.stringify(u.cards)), [{ kind: 'call_recording', id: 'call-7', callId: 7, role: 'system', message: '', timestamp: '2026-11-27T09:03:00Z', durationSeconds: 125 }]);
  assert.equal(run(w, 'window._fastNewest["' + PHONE + '"]'), '12|2026-11-27T10:01:00Z#');
});

test('the thread falls back to the three direct reads when the door cannot answer', async () => {
  for (const over of [{ door: () => ({ status: 503, body: {} }) }, { door: () => ({ body: { ok: false, error: 'not_available' } }) }, { door: () => ({ throws: true }) }, { noLogin: true }]) {
    const w = world(over);
    await run(w, 'loadThread("' + PHONE + '", true)');
    assert.equal(w.calls.rest.length, 2);   // the rows and the typing time; the call items use fetchCallRecordingCards
    const u = w.calls.updates[0];
    assert.deepEqual(plain(u.rows.map((r) => r.id)), [11, 12]);
    assert.equal(u.typing, true);
  }
});

test('an expired typing time and a missing one both mean "not typing" on the door path', async () => {
  for (const aiTypingUntil of [null, new Date(Date.now() - 60000).toISOString()]) {
    const w = world({ door: () => ({ body: { ok: true, rows: [R2, R1], aiTypingUntil, calls: [] } }) });
    await run(w, 'loadThread("' + PHONE + '", true)');
    assert.equal(w.calls.updates[0].typing, false);
  }
});

test('Load older messages: the door answers with rows and call items, with the oldest loaded time as before', async () => {
  const w = world({ door: () => ({ body: { ok: true, rows: [R2, R1], calls: CARDS } }) });
  run(w, 'window._threadOldestLoaded = { "' + PHONE + '": "2026-11-27T10:00:00Z" }');
  await run(w, 'window.loadOlderThreadMessages("' + PHONE + '")');
  assert.deepEqual(plain(w.calls.door[0].body), { token: 'login-token', action: 'older', phone: PHONE, before: '2026-11-27T10:00:00Z' });
  assert.equal(w.calls.rest.length, 0);
  assert.deepEqual(plain(w.calls.merged[0].older.map((r) => r.id)), [11, 12]);
  assert.equal(w.calls.merged[0].cards[0].callId, 7);
});

test('Load older messages falls back to the direct reads when the door cannot answer', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }), direct: { cards: [] } });
  run(w, 'window._threadOldestLoaded = { "' + PHONE + '": "2026-11-27T10:00:00Z" }');
  await run(w, 'window.loadOlderThreadMessages("' + PHONE + '")');
  assert.equal(w.calls.rest.length, 1);
  assert.ok(w.calls.rest[0].includes('timestamp=lt.'));
  assert.deepEqual(plain(w.calls.merged[0].older.map((r) => r.id)), [11, 12]);
});

test('after a 429 or 503 the door is left alone for a while, so the open chat uses the direct reads', async () => {
  const w = world({ door: () => ({ status: 429, body: {} }) });
  stubThread(w);
  await run(w, 'fastPollOpenChat()');
  run(w, '_fastPollBusy = false');
  await run(w, 'fastPollOpenChat()');
  assert.equal(w.calls.door.length, 1);
  assert.equal(w.calls.rest.length, 4);
});

test('the door call items equal the cards the direct read makes', async () => {
  const w = world({});
  const door = JSON.parse(JSON.stringify(run(w, 'w3CallCardsFromRows(' + JSON.stringify(CARDS) + ')')));
  const direct = JSON.parse(JSON.stringify(await vm.runInContext('(async () => { const f = ' + JSON.stringify(CARDS) + '; return f.map(r => ({ kind: "call_recording", id: "call-" + r.id, callId: r.id, role: "system", message: "", timestamp: r.ended_at, durationSeconds: r.duration_seconds })); })()', w)));
  assert.deepEqual(door, direct);
  assert.deepEqual(JSON.parse(JSON.stringify(run(w, 'w3CallCardsFromRows(null)'))), []);
});

test('a door refusal (not_logged_in or any other) never falls back: no direct read, nothing refreshed, the thread and the older read fail like a failed read', async () => {
  for (const error of ['not_logged_in', 'no_seller', 'lookup_failed', 'bad_input', 'read_failed']) {
    const refuse = () => ({ body: { ok: false, error } });
    const p = world({ door: refuse });
    stubThread(p);
    await run(p, 'fastPollOpenChat()');
    assert.equal(p.calls.rest.length, 0, error);
    assert.equal(p.calls.loads, 0, error);
    const t = world({ door: refuse });
    await assert.rejects(() => run(t, 'loadThread("' + PHONE + '", true)'), /refused/, error);
    assert.equal(t.calls.rest.length, 0, error);
    assert.equal(t.calls.updates.length, 0, error);
    const o = world({ door: refuse });
    run(o, 'window._threadOldestLoaded = { "' + PHONE + '": "2026-11-27T10:00:00Z" }');
    await run(o, 'window.loadOlderThreadMessages("' + PHONE + '")');
    assert.equal(o.calls.rest.length, 0, error);
    assert.equal(run(o, 'window._threadOldestLoaded["' + PHONE + '"]'), '2026-11-27T10:00:00Z', error);
  }
});

test('a refusal does not pause the door, and 404 or 502 do not pause it either; only 429 and 503 do (30 seconds)', async () => {
  for (const [over, paused] of [[{ door: () => ({ body: { ok: false, error: 'not_logged_in' } }) }, false], [{ door: () => ({ status: 404, body: {} }) }, false], [{ door: () => ({ status: 502, body: {} }) }, false], [{ door: () => ({ status: 503, body: {} }) }, true], [{ door: () => ({ status: 429, body: {} }) }, true]]) {
    const w = world(over);
    stubThread(w);
    await run(w, 'fastPollOpenChat()');
    const left = run(w, 'w3ChatsPausedUntil') - Date.now();
    if (paused) assert.ok(left > 25000 && left <= 30000);
    else assert.equal(run(w, 'w3ChatsPausedUntil'), 0);
  }
});
