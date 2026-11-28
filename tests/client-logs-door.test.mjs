// Run with:  node --test tests/*.test.mjs
// The two diagnostic inserts (logSystemError and the microphone note) go to the Seller Client Logs door first, with the older direct
// inserts kept as the fallback. The door and the database are faked by the test (vm, no browser): nothing leaves the test.
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
const blockOf = (name) => between('// <' + name + ':js:start>', '// <' + name + ':js:end>');
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
const MIC = () => between('const micNote = {', "    } catch (e) {}\n\n    const candidates = ['audio/ogg");

test('the new code and this test file contain only ASCII characters', () => {
  for (const [name, text] of Object.entries({ block: blockOf('w3-client-logs-door'), log: functionOf('async function logSystemError('), mic: MIC(), test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') }))
    assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and both older direct inserts are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 316);
  assert.ok(functionOf('async function logSystemError(').includes("SUPABASE_URL + '/rest/v1/system_errors'"));
  assert.ok(MIC().includes("SUPABASE_URL + '/rest/v1/debug_log'"));
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

function world(over = {}) {
  const calls = { door: [], direct: [], local: [] };
  const sandbox = {
    calls, JSON, Date, Object, Promise, setTimeout, String, Array, navigator: { userAgent: 'TestBrowser/1.0' },
    SELLER_CHAT_ID: '111', SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', debugLog: (m) => calls.local.push(m),
    w1StoredLoginToken: () => (over.token === undefined ? 'stored-login-token' : over.token)
  };
  sandbox.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (url.includes('/webhook/seller-client-logs')) {
      calls.door.push({ url, body });
      const a = over.door ? over.door(body, calls.door.length) : { status: 503 };
      if (a.throws) throw new Error('network');
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
    }
    calls.direct.push({ url, body, headers: init.headers });
    return { ok: true, status: 201, json: async () => ({}) };
  };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w3-client-logs-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ') + '\n' + functionOf('async function logSystemError('), sandbox);
  return sandbox;
}
const run = (w, code) => vm.runInContext(code, w);
const OK = () => ({ body: { ok: true } });

test('the door saves the line: nothing is sent to the table, the login token is sent when the device has one, and no seller is sent', async () => {
  const w = world({ door: OK });
  await run(w, 'logSystemError("send-voice", "it failed", { phone: "96477" })');
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.door[0].body)), { action: 'systemError', source: 'send-voice', message: 'it failed', context: { phone: '96477' }, token: 'stored-login-token' });
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-client-logs'));
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.local.length, 1);
});

test('no login on the device: the door is still used, without a token (the line is never lost to a login problem)', async () => {
  const w = world({ door: OK, token: null });
  await run(w, 'logSystemError("login", "bad", null)');
  assert.equal('token' in w.calls.door[0].body, false);
  assert.equal(w.calls.door[0].body.context, null);
  assert.equal(w.calls.direct.length, 0);
});

test('the message is cut to 500 characters and a number is sent as text', async () => {
  const w = world({ door: OK });
  await run(w, 'logSystemError("s", "x".repeat(900))');
  await run(w, 'logSystemError("s", 42)');
  assert.equal(w.calls.door[0].body.message.length, 500);
  assert.equal(w.calls.door[1].body.message, '42');
});

test('the door says 503, 404, 502, 429, refuses, or has a network problem: the older direct insert runs as before, with the seller id', async () => {
  for (const over of [
    { door: () => ({ status: 503, body: {} }) }, { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) },
    { door: () => ({ status: 429, body: {} }) }, { door: () => ({ body: { ok: false, error: 'bad_input' } }) },
    { door: () => ({ body: { ok: false, error: 'rate_limited' } }) }, { door: () => ({ throws: true }) }
  ]) {
    const w = world(over);
    await run(w, 'logSystemError("src", "msg", { a: 1 })');
    assert.equal(w.calls.direct.length, 1);
    assert.ok(w.calls.direct[0].url.endsWith('/rest/v1/system_errors'));
    assert.deepEqual(JSON.parse(JSON.stringify(w.calls.direct[0].body)), { seller_id: '111', source: 'src', error_message: 'msg', context: { a: 1 } });
  }
});

test('after a 429 or 503 the door is left alone for a while, and logging itself never throws', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }) });
  await run(w, 'logSystemError("a", "1")');
  await run(w, 'logSystemError("b", "2")');
  assert.equal(w.calls.door.length, 1);
  assert.equal(w.calls.direct.length, 2);
  const bad = world({ door: () => ({ throws: true }) });
  bad.fetch = async () => { throw new Error('offline'); };
  await run(bad, 'logSystemError("a", "1")');   // must not throw
});

function micWorld(over = {}) {
  const w = world(over);
  w.ts = { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: false };
  vm.runInContext('async function micNoteRun() {\n' + MIC().replace(/^const micNote/, 'const micNote') + '\n}', w);
  return w;
}

test('the microphone note: the door saves it as a debugLog line, nothing is sent to the table', async () => {
  const w = micWorld({ door: OK });
  await run(w, 'micNoteRun()');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.door[0].body)), { action: 'debugLog', source: 'mic-settings', data: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: false, ua: 'TestBrowser/1.0' }, token: 'stored-login-token' });
  assert.equal(w.calls.direct.length, 0);
});

test('the microphone note falls back to the older direct insert when the door cannot save it', async () => {
  for (const over of [{ door: () => ({ status: 503, body: {} }) }, { door: () => ({ body: { ok: false, error: 'bad_input' } }) }, { door: () => ({ throws: true }) }]) {
    const w = micWorld(over);
    await run(w, 'micNoteRun()');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.calls.direct.length, 1);
    assert.ok(w.calls.direct[0].url.endsWith('/rest/v1/debug_log'));
    assert.equal(w.calls.direct[0].body.source, 'mic-settings');
    assert.equal(w.calls.direct[0].body.data.ua, 'TestBrowser/1.0');
  }
});
