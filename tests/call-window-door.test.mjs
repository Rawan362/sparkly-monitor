// Run with:  node --test tests/*.test.mjs
// The call window (showCallWindow) reads the ONE call from the Seller Call Detail door, with the older direct read kept as the fallback.
// The door, the database and the page are faked by the test (vm, a tiny fake page): nothing leaves the test.
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
const SHOW = () => between('window.showCallWindow = async function(', '\n};\n') + '\n};';

test('the new code and this test file contain only ASCII characters', () => {
  const added = SHOW().split('\n').filter((l) => /door|Door|W3-/.test(l)).join('\n');
  for (const [name, text] of Object.entries({ block: blockOf('w3-call-detail-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') }))
    assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is bumped and the older direct read is still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 317);
  assert.ok(SHOW().includes("sb('call_recordings?id=eq.' + encodeURIComponent(callId) + '&seller_id=eq.' + encodeURIComponent(SELLER_CHAT_ID) + '&select=' + select + '&limit=1')"));
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

function makeEl(tag, made) {
  const el = { tag, id: '', style: {}, children: [], textContent: '', className: '', classList: { add() {} }, setAttribute() {}, addEventListener() {}, src: '', controls: false, preload: '',
    appendChild(c) { el.children.push(c); return c; } };
  made.push(el);
  return el;
}
function world(over = {}) {
  const calls = { door: [], rest: [], audio: [] };
  const made = [];
  const overlayList = [];
  const sandbox = {
    window: {}, calls, made, JSON, Date, Object, Promise, setTimeout, String, Array, encodeURIComponent, SELLER_CHAT_ID: '111', currentLang: 'en', activePhone: '9647700000001',
    closeVoiceTranscript() {}, vnTranscriptEsc() {}, vnCopyText() {}, debugLog() {}, formatCallDuration: (n) => (n ? Math.round(n / 60) + 'm' : ''), audioGoneText: () => 'sound removed',
    checkAudioMissing() {}, mediaFileName: () => 'call.mp3',
    makeAudioRowWithDownload: (a) => { calls.audio.push(a.src); return makeEl('div', made); },
    document: {
      createElement: (tag) => makeEl(tag, made),
      body: { appendChild: (e) => overlayList.push(e), contains: (e) => overlayList.includes(e) },
      addEventListener() {}
    },
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token')
  };
  sandbox.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.door.push({ url, body });
    const a = over.door ? over.door(body) : { status: 503 };
    if (a.throws) throw new Error('network');
    return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
  };
  sandbox.sb = async (p) => { calls.rest.push(p); return over.rows || []; };
  vm.createContext(sandbox);
  vm.runInContext(blockOf('w3-call-detail-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ') + '\n' + SHOW() + '\nvar show = window.showCallWindow;', sandbox);
  return sandbox;
}
const byId = (w, id) => w.made.find((e) => e.id === id);
const run = (w, code) => vm.runInContext(code, w);
const CALL = { audio_url: 'https://media.test/call.mp3', duration_seconds: 125, ended_at: '2026-11-27T09:03:00Z', phone_number: '9647700000001', audio_deleted_at: null };
const TRANSCRIPT = [{ who: 'customer', text: 'hello' }, { who: 'ai', text: 'hi there' }];

test('audio view through the door: the login token and the call id are sent, no seller, no direct read, and the player is built', async () => {
  const w = world({ door: () => ({ body: { ok: true, call: CALL } }) });
  await run(w, 'show("77", "audio")');
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.door[0].body)), { token: 'login-token', action: 'call', callId: '77', mode: 'audio' });
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-call-detail'));
  assert.equal(w.calls.rest.length, 0);
  assert.deepEqual(w.calls.audio, ['https://media.test/call.mp3']);
  assert.equal(byId(w, 'vn-transcript-head').children[0].textContent, 'Call \u00B7 2m');
});

test('transcript view through the door: the transcript comes from the door and its lines are drawn', async () => {
  const w = world({ door: () => ({ body: { ok: true, call: CALL, transcript: TRANSCRIPT } }) });
  await run(w, 'show(77, "transcript")');
  assert.equal(w.calls.door[0].body.mode, 'transcript');
  assert.equal(w.calls.door[0].body.callId, '77');
  assert.equal(w.calls.rest.length, 0);
  assert.equal(byId(w, 'vn-call-lines').children.length, 2);
});

test('"no_call" shows the existing not found text and makes no direct read', async () => {
  const w = world({ door: () => ({ body: { ok: false, error: 'no_call', message: 'x' } }) });
  await run(w, 'show("77", "audio")');
  assert.equal(w.calls.rest.length, 0);
  assert.equal(byId(w, 'vn-transcript-players').textContent, 'Recording not found.');
});

test('a call whose sound was removed still shows the note', async () => {
  const w = world({ door: () => ({ body: { ok: true, call: { ...CALL, audio_deleted_at: '2026-11-20T00:00:00Z' } } }) });
  await run(w, 'show("77", "audio")');
  assert.equal(w.calls.audio.length, 0);
  assert.equal(byId(w, 'vn-transcript-players').children[0].textContent, 'sound removed');
});

test('503, 404, 502, 429, a refusal, a network problem or no login: the older direct read runs as before', async () => {
  for (const over of [
    { door: () => ({ status: 503, body: {} }) }, { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) },
    { door: () => ({ status: 429, body: {} }) }, { door: () => ({ body: { ok: false, error: 'not_available' } }) },
    { door: () => ({ body: { ok: false, error: 'not_logged_in' } }) }, { door: () => ({ throws: true }) }, { noLogin: true }
  ]) {
    const w = world({ ...over, rows: [CALL] });
    await run(w, 'show("77", "audio")');
    assert.equal(w.calls.rest.length, 1);
    assert.ok(w.calls.rest[0].startsWith('call_recordings?id=eq.77&seller_id=eq.111&select=audio_url,duration_seconds,ended_at,phone_number,audio_deleted_at&limit=1'));
    assert.deepEqual(w.calls.audio, ['https://media.test/call.mp3']);
  }
});

test('the direct read in transcript mode still asks for the transcript column, and a missing call still shows the not found text', async () => {
  const w = world({ door: () => ({ status: 503, body: {} }), rows: [] });
  await run(w, 'show("77", "transcript")');
  assert.ok(w.calls.rest[0].includes('select=audio_url,duration_seconds,ended_at,phone_number,audio_deleted_at,transcript'));
  assert.equal(byId(w, 'vn-call-lines').textContent, 'Recording not found.');
});

test('after a 429 or 503 the door is left alone for a while', async () => {
  const w = world({ door: () => ({ status: 429, body: {} }), rows: [CALL] });
  await run(w, 'show("1", "audio")');
  await run(w, 'show("2", "audio")');
  assert.equal(w.calls.door.length, 1);
  assert.equal(w.calls.rest.length, 2);
});
