// Run with:  node --test tests/*.test.mjs
// Media saving (Media door) and the Small Writes screens (Small Writes door): door first, the older direct path as the fallback.
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
/** One top-level function or "window.x = async function" assignment, cut out up to its closing line at column 0. */
function codeOf(head) {
  const a = html.indexOf(head);
  assert.ok(a > 0, head + ' missing');
  const m = /\n\}[;]?\n/.exec(html.slice(a));
  assert.ok(m, head + ' end missing');
  return html.slice(a, a + m.index + m[0].length);
}
const CODE = {
  media: codeOf('window.saveMediaToDevice = async function'),
  ahmad: codeOf('window.sendAhmadMessage = async function'),
  newGroup: codeOf('window.agentNewGroup = async function'),
  prepGroup: codeOf('async function agentPrepareGroup('),
  debt: codeOf('window.recordDebtPayment = async function'),
  engine: codeOf('window.engineChoose = async function'),
  mediaPathOf: codeOf('function mediaPathOf('),
};

test('the new code and this test file contain only ASCII characters', () => {
  // Only the new block and this file: the older functions around the edits hold older non-ASCII text that stays as it was.
  const files = { block: blockOf('w4-writes-door'), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and every older direct path is still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 316);
  for (const old of ["'/rest/v1/media_device_receipts?on_conflict=seller_id,object_path,device_id'", "'/rest/v1/seller_web_chat_log'", "'/rest/v1/customer_groups'",
    "'/rest/v1/customer_group_members?on_conflict=group_id,phone_number'", "'/rest/v1/debt_payments'", "'/rest/v1/seller_engine?on_conflict=seller_id'",
    "call_recordings?seller_id=eq."]) assert.ok(html.includes(old), old);
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
const SMALL = 'https://sparklly.site/webhook/seller-small-writes';

/** over.door(url, body) answers { status, body } or throws (a network problem); over.noLogin: the device has no login. */
function world(over = {}) {
  const calls = { door: [], direct: [], nudge: [], sb: [], alerts: [] };
  const store = {};
  const cached = new Set(over.cached || []);
  const el = {
    'reply-text': { value: 'hello there', focus() {} },
    'debt-payment-amount-input': { value: '25' },
    'debt-record-payment-btn': { disabled: false, textContent: '' },
    'inbox-agent-group-select': { value: '7' },
    'inbox-agent-group-numbers': { value: over.numbers || '' },
  };
  const sandbox = {
    window: { caches: {} }, calls, JSON, Date, Object, Array, String, Number, Set, Promise, Math, Error, parseInt, encodeURIComponent, setTimeout, RegExp,
    SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'public-key', SELLER_CHAT_ID: 'seller-1', AHMAD_CHAT_WEBHOOK: 'https://hook.example/ahmad',
    DEVICE_MEDIA_CACHE: 'sparkly-media-v1', DEVICE_MEDIA_MARK: MARK, _deviceSaveBusy: false,
    navigator: { storage: { persist: async () => true } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    caches: { open: async () => ({ match: async (u) => cached.has(u), put: async (u) => { cached.add(u); } }) },
    getDeviceId: () => over.deviceId || 'dev_abc123',
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token'),
    sb: async (p) => { calls.sb.push(p); return over.sb ? over.sb(p) : []; },
    drafts: {}, currentLang: 'en', currentDebtDetailPhone: '9647700000000', currentDebtDetailOrders: [],
    engineState: { models: {}, open: {} }, engineRender() {}, engineModelName: (x) => x,
    appendOptimisticBubble: () => 't1', markOptimisticSent() {}, markOptimisticFailed() {}, toggleComposerButtons() {}, cancelReplyMode() {},
    escapeHtml: (x) => x, logSystemError() {}, debugLog() {}, t: () => 'Send failed: ', renderDebtDetail: async () => {}, loadDebts: async () => {},
    recordOrderPayment: async () => {}, agentLoadGroups: async (id) => { calls.groupSelected = id; },
    prompt: () => over.groupName || 'Wholesale', alert: (m) => calls.alerts.push(m),
    refreshDeviceMediaInfo: undefined,
    document: { getElementById: (id) => el[id] || (id.startsWith('engine-saved-') ? (el[id] = { textContent: '' }) : null) },
  };
  sandbox.el = el; sandbox.store = store; sandbox.cached = cached;
  sandbox.fetch = async (url, init) => {
    if (url === MEDIA || url === SMALL) {
      const body = JSON.parse(init.body);
      calls.door.push({ url, body });
      const a = over.door ? over.door(url, body) : { status: 503, body: {} };
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => { if (a.badJson) throw new Error('x'); return a.body; } };
    }
    if (url === sandbox.AHMAD_CHAT_WEBHOOK) { calls.nudge.push(url); return { ok: true, status: 200 }; }
    if (url.startsWith(sandbox.SUPABASE_URL)) {
      calls.direct.push({ url: url.slice(sandbox.SUPABASE_URL.length), body: init && init.body ? JSON.parse(init.body) : null });
      const a = over.direct ? over.direct(url) : { status: 200, body: [{ id: 42 }] };
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
    }
    return { ok: true, status: 200 };   // a media file download
  };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w4-writes-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var '), sandbox);
  vm.runInContext([CODE.mediaPathOf, CODE.media, CODE.ahmad, CODE.newGroup, CODE.prepGroup, CODE.debt, CODE.engine].join('\n'), sandbox);
  return sandbox;
}
const ok = (extra = {}) => ({ body: { ok: true, ...extra } });
const FALLBACKS = [
  ['503', { status: 503, body: { ok: false, error: 'not_available' } }],
  ['429', { status: 429, body: {} }],
  ['404', { status: 404, body: {} }],
  ['502', { status: 502, body: {} }],
  ['not_available answer', { body: { ok: false, error: 'not_available' } }],
  ['network problem', 'throw'],
];
function doorFor(a) { return a === 'throw' ? () => { throw new Error('offline'); } : () => a; }

test('w4Post: the door answers, with the login token, no seller id, and no direct call', async () => {
  const w = world({ door: () => ok({ count: 1 }) });
  const r = await vm.runInContext('w4Post(SELLER_SMALL_WRITES_URL, "assistantMessage", { message: "m" })', w);
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'assistantMessage', message: 'm' });
  assert.ok(!('seller_id' in w.calls.door[0].body) && !('sellerId' in w.calls.door[0].body));
  assert.equal(w.calls.direct.length, 0);
});

test('w4Post: 429, 503, 404, 502, not_available, a network problem or a device with no login fall back', async () => {
  for (const [name, a] of FALLBACKS) {
    const w = world({ door: doorFor(a) });
    assert.equal((await vm.runInContext('w4Post(SELLER_MEDIA_URL, "mediaLinks")', w)).fallback, true, name);
  }
  const n = world({ noLogin: true, door: () => ok() });
  assert.equal((await vm.runInContext('w4Post(SELLER_MEDIA_URL, "mediaLinks")', n)).fallback, true);
  assert.equal(n.calls.door.length, 0);
});

test('w4Post: a login problem or any door refusal never falls back', async () => {
  for (const body of [{ ok: false, error: 'not_logged_in', message: 'x' }, { ok: false, error: 'bad_input', message: 'Too long.' }, { ok: false, error: 'unconfirmed', message: 'Not sure.' }, { ok: false, error: 'no_group' }]) {
    const w = world({ door: () => ({ body }) });
    const r = await vm.runInContext('w4Post(SELLER_SMALL_WRITES_URL, "newGroup", { name: "a" })', w);
    assert.equal(r.fallback, undefined);
    assert.equal(r.ok, false);
    assert.equal(r.relogin === true, body.error === 'not_logged_in');
  }
  const w = world({ door: () => ({ status: 500, body: { ok: false, error: 'save_failed' } }) });
  assert.equal((await vm.runInContext('w4Post(SELLER_SMALL_WRITES_URL, "newGroup", { name: "a" })', w)).fallback, undefined);
  const j = world({ door: () => ({ status: 500, badJson: true }) });
  assert.equal((await vm.runInContext('w4Post(SELLER_SMALL_WRITES_URL, "newGroup", { name: "a" })', j)).ok, false);
});

test('after a 429 or a 503 that door is left alone for 30 seconds (the other door is not affected)', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: (url) => (url === MEDIA ? { status, body: {} } : ok()) });
    await vm.runInContext('w4Post(SELLER_MEDIA_URL, "mediaLinks")', w);
    const again = await vm.runInContext('w4Post(SELLER_MEDIA_URL, "mediaLinks")', w);
    assert.equal(again.fallback, true);
    assert.equal(w.calls.door.length, 1);
    const left = vm.runInContext('w4PausedUntil[SELLER_MEDIA_URL] - Date.now()', w);
    assert.ok(left > 29000 && left <= 30000, String(left));
    assert.equal((await vm.runInContext('w4Post(SELLER_SMALL_WRITES_URL, "newGroup", { name: "a" })', w)).ok, true);
    vm.runInContext('w4PausedUntil[SELLER_MEDIA_URL] = Date.now() - 1', w);
    await vm.runInContext('w4Post(SELLER_MEDIA_URL, "mediaLinks")', w);
    assert.equal(w.calls.door.filter((c) => c.url === MEDIA).length, 2);
  }
  const w = world({ door: () => ({ status: 404, body: {} }) });
  await vm.runInContext('w4Post(SELLER_MEDIA_URL, "mediaLinks")', w);
  await vm.runInContext('w4Post(SELLER_MEDIA_URL, "mediaLinks")', w);
  assert.equal(w.calls.door.length, 2);   // a 404 does not pause
});

const U1 = 'https://x.supabase.co' + MARK + 'a/1.jpg';
const U2 = 'https://x.supabase.co' + MARK + 'a/2.ogg';

test('media: the door gives the links, the files are saved and the receipts go to the door (deviceId and paths, no seller)', async () => {
  const w = world({ door: (url, b) => (b.action === 'mediaLinks' ? ok({ urls: [U1, U2, 'https://other.example/x.jpg'] }) : ok({ count: b.paths.length, undoId: 'u1' })) });
  await vm.runInContext('window.saveMediaToDevice()', w);
  assert.equal(w.calls.sb.length, 0);
  assert.equal(w.calls.direct.length, 0);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'mediaLinks' });
  assert.deepEqual(w.calls.door[1].body, { token: 'login-token', action: 'saveReceipts', deviceId: 'dev_abc123', paths: ['a/1.jpg', 'a/2.ogg'] });
  assert.deepEqual(JSON.parse(w.store.sparkly_receipts_sent), ['a/1.jpg', 'a/2.ogg']);
});

test('media: when the door cannot answer, the two older reads and the older receipt upsert run as before', async () => {
  for (const [name, a] of FALLBACKS) {
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

test('media: a door refusal skips the round and never reads or writes directly', async () => {
  const w = world({ door: () => ({ body: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  await vm.runInContext('window.saveMediaToDevice()', w);
  assert.equal(w.calls.sb.length, 0);
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.door.length, 1);
  assert.equal(vm.runInContext('_deviceSaveBusy', w), false);
});

test('receipts: groups of 100 to the door; a door that says not available halfway sends the rest directly; a refusal stops with no direct call', async () => {
  const paths = Array.from({ length: 250 }, (_, i) => 'p/' + i + '.jpg');
  const w = world({ door: (u, b) => ok({ count: b.paths.length }) });
  const saved = await vm.runInContext('w4SaveReceipts("dev_a", ' + JSON.stringify(paths) + ')', w);
  assert.equal(saved.length, 250);
  assert.deepEqual(w.calls.door.map((c) => c.body.paths.length), [100, 100, 50]);
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
  const w = world({ door: (u, b) => ok({ count: b.paths.length }) });
  const saved = await vm.runInContext('w4SaveReceipts("dev_a", ["p/1.jpg", ' + JSON.stringify(long) + '])', w);
  assert.equal(saved.length, 2);
  assert.deepEqual(w.calls.door[0].body.paths, ['p/1.jpg']);
  assert.equal(w.calls.direct[0].body.length, 1);
  const d = world({ door: () => ok() });
  await vm.runInContext('w4SaveReceipts("bad id!", ["p/1.jpg"])', d);
  assert.equal(d.calls.door.length, 0);
  assert.equal(d.calls.direct.length, 1);
});

test('assistant chat line: the door takes the message, the nudge to the Ahmad webhook still goes, no direct write', async () => {
  const w = world({ door: () => ok({ undoId: 'u' }) });
  await vm.runInContext('window.sendAhmadMessage()', w);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'assistantMessage', message: 'hello there' });
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.nudge.length, 1);
  assert.equal(w.calls.alerts.length, 0);
});

test('assistant chat line: fallbacks write directly as before; a refusal shows its words and writes nothing', async () => {
  for (const [name, a] of FALLBACKS) {
    const w = world({ door: doorFor(a) });
    await vm.runInContext('window.sendAhmadMessage()', w);
    assert.equal(w.calls.direct.length, 1, name);
    assert.ok(w.calls.direct[0].url.endsWith('/rest/v1/seller_web_chat_log'));
    assert.deepEqual(w.calls.direct[0].body, { seller_id: 'seller-1', role: 'seller', message: 'hello there' });
    assert.equal(w.calls.nudge.length, 1);
  }
  const r = world({ door: () => ({ body: { ok: false, error: 'bad_input', message: 'Too long.' } }) });
  await vm.runInContext('window.sendAhmadMessage()', r);
  assert.equal(r.calls.direct.length, 0);
  assert.equal(r.calls.nudge.length, 0);
  assert.ok(r.calls.alerts[0].includes('Too long.'));
  const l = world({ door: () => ({ body: { ok: false, error: 'not_logged_in' } }) });
  await vm.runInContext('window.sendAhmadMessage()', l);
  assert.equal(l.calls.direct.length, 0);
  assert.ok(l.calls.alerts[0].includes('sign in again'));
});

test('customer groups: new group through the door selects its groupId; fallback creates it directly; a refusal creates nothing', async () => {
  const w = world({ door: () => ok({ groupId: 9, undoId: 'u' }) });
  await vm.runInContext('window.agentNewGroup()', w);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'newGroup', name: 'Wholesale' });
  assert.equal(w.calls.groupSelected, 9);
  assert.equal(w.calls.direct.length, 0);
  for (const [name, a] of FALLBACKS) {
    const f = world({ door: doorFor(a) });
    await vm.runInContext('window.agentNewGroup()', f);
    assert.equal(f.calls.direct.length, 1, name);
    assert.deepEqual(f.calls.direct[0].body, { seller_id: 'seller-1', name: 'Wholesale' });
    assert.equal(f.calls.groupSelected, 42);
  }
  const r = world({ door: () => ({ body: { ok: false, error: 'bad_input', message: 'Name too long.' } }) });
  await vm.runInContext('window.agentNewGroup()', r);
  assert.equal(r.calls.direct.length, 0);
  assert.ok(r.calls.alerts[0].includes('Name too long.'));
});

test('customer groups: members go to the door (digits only, groupId a number); fallback upserts directly; a refusal throws and writes nothing', async () => {
  const q = '({ phone_number: "+9647700000001" })';
  const w = world({ numbers: '9647700000002, 123', door: () => ok({ count: 2 }) });
  assert.equal(await vm.runInContext('agentPrepareGroup(' + q + ')', w), 7);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'addGroupMembers', groupId: 7, phones: ['9647700000001', '9647700000002'] });
  assert.equal(w.calls.direct.length, 0);
  for (const [name, a] of FALLBACKS) {
    const f = world({ door: doorFor(a) });
    assert.equal(await vm.runInContext('agentPrepareGroup(' + q + ')', f), 7, name);
    assert.equal(f.calls.direct.length, 1);
    assert.deepEqual(f.calls.direct[0].body, [{ group_id: 7, seller_id: 'seller-1', phone_number: '9647700000001' }]);
  }
  const r = world({ door: () => ({ body: { ok: false, error: 'no_group', message: 'That group is not yours.' } }) });
  await assert.rejects(vm.runInContext('agentPrepareGroup(' + q + ')', r), /not yours/);
  assert.equal(r.calls.direct.length, 0);
  const odd = world({ door: () => ok() });
  await vm.runInContext('agentPrepareGroup({ phone_number: "12345678901234567890123" })', odd);
  assert.equal(odd.calls.door.length, 0);
  assert.equal(odd.calls.direct.length, 1);
});

test('debt payment log row: the door logs it (no date, no seller) and the allocation still runs; a refusal stops before the allocation', async () => {
  let allocated = 0;
  const w = world({ door: () => ok({ undoId: 'u' }) });
  w.currentDebtDetailOrders = [{ id: 1, order_total: 100, remaining: 100 }];
  w.recordOrderPayment = async () => { allocated++; };
  await vm.runInContext('window.recordDebtPayment()', w);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'logDebtPayment', phone: '9647700000000', amount: 25 });
  assert.equal(w.calls.direct.length, 0);
  assert.equal(allocated, 1);
  for (const [name, a] of FALLBACKS) {
    const f = world({ door: doorFor(a) });
    await vm.runInContext('window.recordDebtPayment()', f);
    assert.equal(f.calls.direct.length, 1, name);
    assert.ok(f.calls.direct[0].url.endsWith('/rest/v1/debt_payments'));
    assert.equal(f.calls.direct[0].body.seller_id, 'seller-1');
    assert.equal(f.calls.direct[0].body.amount, 25);
  }
  const r = world({ door: () => ({ body: { ok: false, error: 'bad_input', message: 'Bad amount.' } }) });
  r.currentDebtDetailOrders = [{ id: 1, order_total: 100, remaining: 100 }];
  let n = 0; r.recordOrderPayment = async () => { n++; };
  await vm.runInContext('window.recordDebtPayment()', r);
  assert.equal(r.calls.direct.length, 0);
  assert.equal(n, 0);
  assert.ok(r.calls.alerts[0].includes('Bad amount.'));
  assert.equal(r.el['debt-record-payment-btn'].disabled, false);
});

test('engine choice: the door saves it (kind and model, no seller); fallback writes the old row; a refusal says it could not save and writes nothing', async () => {
  const w = world({ door: () => ok({ undoId: 'u' }) });
  await vm.runInContext('window.engineChoose("customer", "claude-sonnet-5-5")', w);
  assert.deepEqual(w.calls.door[0].body, { token: 'login-token', action: 'chooseEngine', kind: 'customer', model: 'claude-sonnet-5-5' });
  assert.equal(w.calls.direct.length, 0);
  assert.ok(w.el['engine-saved-customer'].textContent.startsWith('Saved.'));
  for (const [name, a] of FALLBACKS) {
    const f = world({ door: doorFor(a) });
    await vm.runInContext('window.engineChoose("call", "m1")', f);
    assert.equal(f.calls.direct.length, 1, name);
    assert.equal(f.calls.direct[0].body.call_model, 'm1');
    assert.equal(f.calls.direct[0].body.seller_id, 'seller-1');
    assert.ok(f.el['engine-saved-call'].textContent.startsWith('Saved.'));
  }
  const r = world({ door: () => ({ body: { ok: false, error: 'bad_input', message: 'x' } }) });
  await vm.runInContext('window.engineChoose("chat", "m1")', r);
  assert.equal(r.calls.direct.length, 0);
  assert.equal(r.el['engine-saved-chat'].textContent, 'Could not save, try again.');
  const l = world({ door: () => ({ body: { ok: false, error: 'not_logged_in' } }) });
  await vm.runInContext('window.engineChoose("chat", "m1")', l);
  assert.ok(l.el['engine-saved-chat'].textContent.includes('sign in again'));
  const odd = world({ door: () => ok() });
  await vm.runInContext('window.engineChoose("chat", "bad model!")', odd);
  assert.equal(odd.calls.door.length, 0);
  assert.equal(odd.calls.direct.length, 1);
});
