// Run with:  node --test tests/*.test.mjs
// Reads the REAL fast-poll / timing-mode code out of index.html (between the <fast-poll> markers) and runs it against a tiny fake page.
// No network, no real tokens, no real messages: everything below is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const region = (() => {
  const a = html.indexOf('// <fast-poll>');
  const b = html.indexOf('// </fast-poll>');
  assert.ok(a > 0 && b > a, 'fast-poll markers are missing');
  return html.slice(a, b);
})();

function world({ timing = false, hidden = false, online = true, hasBox = true, sbImpl } = {}) {
  const calls = { sb: [], loadThread: [] };
  const store = new Map();
  const frames = [];
  const els = new Map();
  const document = {
    hidden,
    getElementById: (id) => (id === 'messages' ? (hasBox ? {} : null) : els.get(id) || null),
    createElement: () => ({ style: {}, id: '', textContent: '' }),
    body: { appendChild: (e) => els.set(e.id, e) }
  };
  const clock = { now: Date.parse('2026-11-01T10:00:10.000Z') };
  const RealDate = Date;
  const FakeDate = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } };
  const ctx = vm.createContext({
    window: {}, document, Object, String, Array, Math, Promise, JSON, Set, Number, URLSearchParams, Date: FakeDate,
    navigator: { onLine: online },
    location: { search: timing ? '?timing=1' : '' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    requestAnimationFrame: (fn) => frames.push(fn),
    sb: async (p) => { calls.sb.push(p); return sbImpl ? sbImpl(p) : []; },
    loadThread: async (phone, silent) => { calls.loadThread.push([phone, silent]); }
  });
  const script = `
    let activePhone = '111';
    const SELLER_CHAT_ID = 'seller-test';
    ${region}
    ({ fastPollOpenChat, timingNote, timingKind, setPhone: (p) => { activePhone = p; }, FAST_POLL_MS, TIMING_MODE })
  `;
  const api = vm.runInContext(script, ctx);
  return { api, calls, store, frames, els, ctx, clock };
}

test('poll interval is 2.5 s', () => {
  assert.equal(world().api.FAST_POLL_MS, 2500);
});

test('asks for ONE tiny row (id and timestamp of the newest) for the open chat and this seller only', async () => {
  const w = world({ sbImpl: () => [{ id: 5, timestamp: 't1' }] });
  await w.api.fastPollOpenChat();
  assert.equal(w.calls.sb.length, 1);
  assert.match(w.calls.sb[0], /^conversations\?phone_number=eq\.111&seller_id=eq\.seller-test&select=id,timestamp&order=timestamp\.desc&limit=1$/);
});

test('a newer row than the one on screen triggers the same silent refresh as the 8 s poll', async () => {
  const w = world({ sbImpl: () => [{ id: 6, timestamp: 't2' }] });
  vm.runInContext("window._fastNewest['111'] = '5|t0'", w.ctx);
  await w.api.fastPollOpenChat();
  assert.deepEqual(w.calls.loadThread, [['111', true]]);
});

test('nothing new: no refresh', async () => {
  const w = world({ sbImpl: () => [{ id: 5, timestamp: 't1' }] });
  vm.runInContext("window._fastNewest['111'] = '5|t1'", w.ctx);
  await w.api.fastPollOpenChat();
  assert.equal(w.calls.loadThread.length, 0);
});

test('no request at all when the page is hidden, offline, no chat is open, or the message list is not on screen', async () => {
  for (const o of [{ hidden: true }, { online: false }, { hasBox: false }]) {
    const w = world(o);
    await w.api.fastPollOpenChat();
    assert.equal(w.calls.sb.length, 0, JSON.stringify(o));
  }
  const w = world();
  w.api.setPhone('');
  await w.api.fastPollOpenChat();
  assert.equal(w.calls.sb.length, 0);
});

test('never two polls at once, and a failed request is swallowed', async () => {
  let release;
  const w = world({ sbImpl: () => new Promise((r) => { release = () => r([]); }) });
  const first = w.api.fastPollOpenChat();
  await w.api.fastPollOpenChat();   // second call while the first is waiting: ignored
  assert.equal(w.calls.sb.length, 1);
  release(); await first;
  const bad = world({ sbImpl: () => { throw new Error('network'); } });
  await bad.api.fastPollOpenChat();   // must not throw
  await bad.api.fastPollOpenChat();   // and the busy flag was released
  assert.equal(bad.calls.sb.length, 2);
});

test('if the customer changed while the request was running, the old answer is dropped', async () => {
  const w = world({ sbImpl: () => { w.api.setPhone('222'); return [{ id: 9, timestamp: 'x' }]; } });
  await w.api.fastPollOpenChat();
  assert.equal(w.calls.loadThread.length, 0);
});

test('timing mode is OFF by default: no box, no storage, no frames', () => {
  const w = world();
  w.api.timingNote('111', [{ id: 1, role: 'user', message: 'a', timestamp: '2026-11-01T10:00:00.000Z' }]);
  w.api.timingNote('111', [{ id: 1, role: 'user', message: 'a', timestamp: '2026-11-01T10:00:00.000Z' }, { id: 2, role: 'user', message: 'b', timestamp: '2026-11-01T10:00:08.000Z' }]);
  assert.equal(w.api.TIMING_MODE, false);
  assert.equal(w.frames.length, 0);
  assert.equal(w.els.size, 0);
  assert.equal(w.store.size, 0);
});

test('timing mode (?timing=1): first load is silent, a new INCOMING row logs arrived -> shown in seconds, outgoing rows do not', () => {
  const w = world({ timing: true });
  const old = { id: 1, role: 'user', message: 'old', timestamp: '2026-11-01T10:00:00.000Z' };
  w.api.timingNote('111', [old]);
  assert.equal(w.frames.length, 0, 'the first load of a chat logs nothing');
  const fresh = { id: 2, role: 'user', message: 'hello', timestamp: '2026-11-01T10:00:08.000Z' };
  const mine = { id: 3, role: 'assistant', message: 'reply', timestamp: '2026-11-01T10:00:09.000Z' };
  w.api.timingNote('111', [old, fresh, mine]);
  assert.equal(w.frames.length, 1, 'only the incoming row is timed');
  w.frames[0]();   // the next paint happens at clock "10:00:10.000"
  const box = w.els.get('timing-box');
  assert.equal(box.textContent, 'in text: arrived 10:00:08.000 -> shown 10:00:10.000 (2.0 s)');
  assert.deepEqual(JSON.parse(w.store.get('sparkly_timing_log')), [box.textContent]);
  // the same row is never logged twice
  w.api.timingNote('111', [old, fresh, mine]);
  assert.equal(w.frames.length, 1);
});

test('timing mode names the kind of message without ever printing its content', () => {
  const { api } = world({ timing: true });
  assert.equal(api.timingKind('🖼️ Photo: https://x | cap'), 'photo');
  assert.equal(api.timingKind('🎥 Video: https://x'), 'video');
  assert.equal(api.timingKind('📄 File: n | https://x'), 'file');
  assert.equal(api.timingKind('🎤 Voice: https://x'), 'voice');
  assert.equal(api.timingKind('plain words'), 'text');
});

test('the real code is wired in: loadThread records the newest row and feeds the timing note; the timer is 2.5 s; cache is v58', () => {
  const lt = html.slice(html.indexOf('async function loadThread(phone, silent) {'), html.indexOf('async function loadThread(phone, silent) {') + 2500);
  assert.ok(lt.includes("window._fastNewest[phone] = rows.length ?") && lt.includes('timingNote(phone, rows)'));
  assert.ok(html.includes('window._fastPollTimer = setInterval(fastPollOpenChat, FAST_POLL_MS)'));
  assert.ok(html.includes('pollTimer = setInterval(loadConversations, 8000)'), 'the 8 s poll is unchanged');
  { const m = sw.match(/CACHE_NAME = 'sparkly-shell-v(\d+)'/); assert.ok(m && Number(m[1]) >= 58); }
});
