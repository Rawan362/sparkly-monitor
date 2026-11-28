// Run with:  node --test tests/*.test.mjs
// Media saving (Media door): door first, the older direct reads and receipt upsert kept as the fallback.
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
/** One top-level function or "window.x = async function" assignment, cut out up to its closing line at column 0. */
function codeOf(head) {
  const a = html.indexOf(head);
  assert.ok(a > 0, head + ' missing');
  const m = /\n\}[;]?\n/.exec(html.slice(a));
  assert.ok(m, head + ' end missing');
  return html.slice(a, a + m.index + m[0].length);
}
const SAVE = codeOf('window.saveMediaToDevice = async function');
const PATH_OF = codeOf('function mediaPathOf(');

test('the new code and this test file contain only ASCII characters', () => {
  const files = { block: blockOf('w4-media-door'), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the older direct paths are still in the file', () => {
  assert.ok(html.includes("'/rest/v1/media_device_receipts?on_conflict=seller_id,object_path,device_id'"));
  assert.ok(html.includes("call_recordings?seller_id=eq."));
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

const MARK = '/storage/v1/object/public/chat-media/';
const MEDIA = 'https://sparklly.site/webhook/seller-media';

/** over.door(body) answers { status, body } or throws (a network problem); over.noLogin: the device has no login. */
function world(over = {}) {
  const calls = { door: [], direct: [], sb: [] };
  const store = {};
  const cached = new Set(over.cached || []);
  const sandbox = {
    window: { caches: {} }, calls, JSON, Date, Object, Array, String, Number, Set, Promise, Math, Error, RegExp, encodeURIComponent, decodeURIComponent,
    SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'public-key', SELLER_CHAT_ID: 'seller-1',
    DEVICE_MEDIA_CACHE: 'sparkly-media-v1', DEVICE_MEDIA_MARK: MARK, _deviceSaveBusy: false,
    navigator: { storage: { persist: async () => true } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    caches: { open: async () => ({ match: async (u) => cached.has(u), put: async (u) => { cached.add(u); } }) },
    getDeviceId: () => over.deviceId || 'dev_abc123',
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token'),
    sb: async (p) => { calls.sb.push(p); return over.sb ? over.sb(p) : []; },
  };
  sandbox.store = store;
  sandbox.fetch = async (url, init) => {
    if (url === MEDIA) {
      const body = JSON.parse(init.body);
      calls.door.push(body);
      const a = over.door ? over.door(body) : { status: 503, body: {} };
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => { if (a.badJson) throw new Error('x'); return a.body; } };
    }
    if (url.startsWith(sandbox.SUPABASE_URL)) {
      calls.direct.push({ url: url.slice(sandbox.SUPABASE_URL.length), body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200 };   // a media file download
  };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w4-media-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var '), sandbox);
  vm.runInContext(PATH_OF + '\n' + SAVE, sandbox);
  return sandbox;
}
const ok = (extra = {}) => ({ body: { ok: true, ...extra } });
const post = (w, action, write) => vm.runInContext('w4MediaPost(' + JSON.stringify(action) + ', ' + write + ')', w);
// What makes a call fall back, for a read and for a write.
const BOTH = [
  ['503', { status: 503, body: { ok: false, error: 'not_available' } }],
  ['404', { status: 404, body: {} }],
  ['502', { status: 502, body: {} }],
  ['not_available answer', { body: { ok: false, error: 'not_available' } }],
  ['refused connection or network problem', 'throw'],
];
function doorFor(a) { return a === 'throw' ? () => { throw new Error('offline'); } : () => a; }

test('the door answers: the login token is sent, no seller id, no direct call', async () => {
  const w = world({ door: () => ok({ urls: [] }) });
  const r = await post(w, 'mediaLinks', false);
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.door[0], { token: 'login-token', action: 'mediaLinks' });
  assert.equal(w.calls.direct.length, 0);
});

test('503, 404, 502, not_available, a refused connection, a network problem or no login fall back (read and write)', async () => {
  for (const write of [false, true]) {
    for (const [name, a] of BOTH) {
      const w = world({ door: doorFor(a) });
      assert.equal((await post(w, 'x', write)).fallback, true, name + ' write=' + write);
    }
    const n = world({ noLogin: true, door: () => ok() });
    assert.equal((await post(n, 'x', write)).fallback, true);
    assert.equal(n.calls.door.length, 0);
  }
});

test('a 429 falls back for a read, with a 30 second pause, but never for a write', async () => {
  const w = world({ door: () => ({ status: 429, body: {} }) });
  assert.equal((await post(w, 'mediaLinks', false)).fallback, true);
  assert.equal((await post(w, 'mediaLinks', false)).fallback, true);
  assert.equal(w.calls.door.length, 1);
  const left = vm.runInContext('w4MediaPausedUntil - Date.now()', w);
  assert.ok(left > 29000 && left <= 30000, String(left));
  vm.runInContext('w4MediaPausedUntil = Date.now() - 1', w);
  await post(w, 'mediaLinks', false);
  assert.equal(w.calls.door.length, 2);
  const x = world({ door: () => ({ status: 429, body: {} }) });
  const r = await post(x, 'saveReceipts', true);
  assert.equal(r.fallback, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rate_limited');
});

test('a 503 pauses the door for 30 seconds; a 404 does not', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }) });
  await post(w, 'mediaLinks', false);
  await post(w, 'mediaLinks', false);
  assert.equal(w.calls.door.length, 1);
  const n = world({ door: () => ({ status: 404, body: {} }) });
  await post(n, 'mediaLinks', false);
  await post(n, 'mediaLinks', false);
  assert.equal(n.calls.door.length, 2);
});

test('a login problem or any door refusal never falls back', async () => {
  for (const write of [false, true]) {
    for (const body of [{ ok: false, error: 'not_logged_in', message: 'x' }, { ok: false, error: 'bad_input', message: 'Bad.' }, { ok: false, error: 'unconfirmed', message: 'Not sure.' }, { ok: false, error: 'no_seller' }]) {
      const w = world({ door: () => ({ body }) });
      const r = await post(w, 'x', write);
      assert.equal(r.fallback, undefined);
      assert.equal(r.ok, false);
      assert.equal(r.relogin === true, body.error === 'not_logged_in');
    }
  }
  const w = world({ door: () => ({ status: 500, badJson: true }) });
  assert.equal((await post(w, 'x', true)).ok, false);
});

const U1 = 'https://x.supabase.co' + MARK + 'a/1.jpg';
const U2 = 'https://x.supabase.co' + MARK + 'a/2.ogg';

test('the door gives the links, the files are saved and the receipts go to the door (deviceId and paths, no seller)', async () => {
  const w = world({ door: (b) => (b.action === 'mediaLinks' ? ok({ urls: [U1, U2, 'https://other.example/x.jpg'] }) : ok({ count: b.paths.length, undoId: 'u1' })) });
  await vm.runInContext('window.saveMediaToDevice()', w);
  assert.equal(w.calls.sb.length, 0);
  assert.equal(w.calls.direct.length, 0);
  assert.deepEqual(w.calls.door[0], { token: 'login-token', action: 'mediaLinks' });
  assert.deepEqual(w.calls.door[1], { token: 'login-token', action: 'saveReceipts', deviceId: 'dev_abc123', paths: ['a/1.jpg', 'a/2.ogg'] });
  assert.deepEqual(JSON.parse(w.store.sparkly_receipts_sent), ['a/1.jpg', 'a/2.ogg']);
});

test('when the door cannot answer, the two older reads and the older receipt upsert run as before', async () => {
  for (const [name, a] of BOTH) {
    const w = world({ door: doorFor(a), sb: (p) => (p.startsWith('conversations') ? [{ message: 'see ' + U1 }] : [{ audio_url: U2 }]) });
    await vm.runInContext('window.saveMediaToDevice()', w);
    assert.equal(w.calls.sb.length, 2, name);
    assert.ok(w.calls.sb[0].startsWith('conversations?seller_id=eq.seller-1'));
    assert.ok(w.calls.sb[1].startsWith('call_recordings?seller_id=eq.seller-1'));
    assert.equal(w.calls.direct.length, 1);
    assert.ok(w.calls.direct[0].url.startsWith('/rest/v1/media_device_receipts?on_conflict='));
    assert.deepEqual(w.calls.direct[0].body.map((r) => r.object_path), ['a/1.jpg', 'a/2.ogg']);
    assert.deepEqual(JSON.parse(w.store.sparkly_receipts_sent), ['a/1.jpg', 'a/2.ogg']);
  }
  const n = world({ noLogin: true, sb: () => [] });
  await vm.runInContext('window.saveMediaToDevice()', n);
  assert.equal(n.calls.door.length, 0);
  assert.equal(n.calls.sb.length, 2);
});

test('a 429 on the read uses the older reads, and the receipts that follow also leave the door alone (the pause)', async () => {
  const w = world({ door: () => ({ status: 429, body: {} }), sb: (p) => (p.startsWith('conversations') ? [{ message: U1 }] : []) });
  await vm.runInContext('window.saveMediaToDevice()', w);
  assert.equal(w.calls.sb.length, 2);
  assert.equal(w.calls.door.length, 1);
  assert.equal(w.calls.direct.length, 1);
});

test('a door refusal on the read skips the round and never reads or writes directly', async () => {
  const w = world({ door: () => ({ body: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  await vm.runInContext('window.saveMediaToDevice()', w);
  assert.equal(w.calls.sb.length, 0);
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.door.length, 1);
  assert.equal(vm.runInContext('_deviceSaveBusy', w), false);
});

test('a 429 or a refusal on the receipt write saves nothing, writes nothing directly and keeps the paths for the next round', async () => {
  for (const wr of [{ status: 429, body: {} }, { body: { ok: false, error: 'save_failed', message: 'x' } }]) {
    const w = world({ door: (b) => (b.action === 'mediaLinks' ? ok({ urls: [U1] }) : wr) });
    await vm.runInContext('window.saveMediaToDevice()', w);
    assert.equal(w.calls.direct.length, 0);
    assert.equal(w.store.sparkly_receipts_sent, undefined);
  }
});

test('receipts: groups of 100 to the door; a 503 halfway sends the rest directly; a refusal stops with no direct call', async () => {
  const paths = Array.from({ length: 250 }, (_, i) => 'p/' + i + '.jpg');
  const w = world({ door: (b) => ok({ count: b.paths.length }) });
  const saved = await vm.runInContext('w4SaveReceipts("dev_a", ' + JSON.stringify(paths) + ')', w);
  assert.equal(saved.length, 250);
  assert.deepEqual(w.calls.door.map((c) => c.paths.length), [100, 100, 50]);
  assert.equal(w.calls.direct.length, 0);

  let n = 0;
  const h = world({ door: () => (++n === 2 ? { status: 503, body: {} } : ok()) });
  const s2 = await vm.runInContext('w4SaveReceipts("dev_a", ' + JSON.stringify(paths) + ')', h);
  assert.equal(s2.length, 250);
  assert.equal(h.calls.direct.length, 1);
  assert.equal(h.calls.direct[0].body.length, 150);

  let m = 0;
  const r = world({ door: () => (++m === 2 ? { body: { ok: false, error: 'save_failed' } } : ok()) });
  const s3 = await vm.runInContext('w4SaveReceipts("dev_a", ' + JSON.stringify(paths) + ')', r);
  assert.equal(s3.length, 100);
  assert.equal(r.calls.direct.length, 0);
});

test('receipts: a path or a device id the door would refuse is sent by the older direct upsert instead', async () => {
  const long = 'p/' + 'x'.repeat(600);
  const w = world({ door: (b) => ok({ count: b.paths.length }) });
  const saved = await vm.runInContext('w4SaveReceipts("dev_a", ["p/1.jpg", ' + JSON.stringify(long) + '])', w);
  assert.equal(saved.length, 2);
  assert.deepEqual(w.calls.door[0].paths, ['p/1.jpg']);
  assert.equal(w.calls.direct[0].body.length, 1);
  const d = world({ door: () => ok() });
  await vm.runInContext('w4SaveReceipts("bad id!", ["p/1.jpg"])', d);
  assert.equal(d.calls.door.length, 0);
  assert.equal(d.calls.direct.length, 1);
});
