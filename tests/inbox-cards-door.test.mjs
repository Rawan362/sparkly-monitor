// Run with:  node --test tests/*.test.mjs
// The Inbox card writes (Good and Adjust, "Got it", the lesson form, starting the lesson) go through the Seller Inbox Cards door first, with the
// older direct writes kept as the fallback. Refusals never fall back. The door and the database are faked by the test (vm, no browser).
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
  prepareGroup: grab('async function agentPrepareGroup('),
  saveResolutions: grab('async function agentSaveResolutions('),
  closeCard: grab('async function agentCloseCard('),
  decide: grab('window.agentDecide = async function('),
  adjust: grab('window.agentSaveAdjust = async function('),
  dismiss: grab('window.inboxDismissAlert = async function('),
  lesson: grab('window.submitLesson = async function('),
  startLesson: grab('async function startLessonIfNeeded(')
};

test('the new code and this test file contain only ASCII characters', () => {
  const added = Object.values(FN).join('\n').split('\n').filter((l) => /door|W3-|w3Ic|w3Agent/.test(l)).join('\n');
  const files = { block: blockOf('w3-inbox-cards-door'), added, test: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(files)) assert.equal([...text].filter((c) => c.charCodeAt(0) > 127).length, 0, name);
});

test('the cache name is higher than 315 and the older direct writes are still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 316);
  assert.ok(FN.saveResolutions.includes("'/rest/v1/rule_resolutions'"));
  assert.ok(FN.closeCard.includes("'/rest/v1/pending_questions?id=eq.' + q.id"));
  assert.ok(FN.dismiss.includes("answer: '(seen)'"));
  assert.ok(FN.lesson.includes("'/rest/v1/seller_learned_answers'"));
  assert.ok(FN.startLesson.includes("JSON.stringify({ status: 'lesson' })"));
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
const PHONE = '9647700000001';
const CARD = { id: 9, kind: 'question', status: 'pending', phone_number: PHONE, question: 'What is the price?', department: 'sales', meta: { breaks: [{ id: '11111111-1111-1111-1111-111111111111', topic: 'Tone' }, { id: '22222222-2222-2222-2222-222222222222', topic: 'Price' }] } };
function stubEl(els) {
  const el = { style: {}, dataset: {}, children: [], textContent: '', innerHTML: '', value: '', checked: false, disabled: false, appendChild(c) { el.children.push(c); }, setAttribute() {} };
  Object.defineProperty(el, 'id', { set(v) { els[v] = el; }, get() { return ''; } });
  return el;
}
function world(over = {}) {
  const calls = { door: [], direct: [], alerts: [], closed: 0, lists: 0, dots: 0, opened: 0 };
  const els = {};
  const put = (id, props) => { els[id] = Object.assign(stubEl(els), props); };
  put('inbox-agent-good-btn', {}); put('inbox-agent-save-btn', {}); put('inbox-agent-adjust-text', { value: 'Be kind' }); put('inbox-agent-send', { checked: false });
  put('inbox-agent-group-select', { value: '4' }); put('inbox-agent-group-numbers', { value: '' }); put('inbox-lesson-text', { value: 'Explain it' }); put('inbox-lesson-save-btn', {});
  const sandbox = {
    calls, els, SELLER_CHAT_ID: '111', SUPABASE_URL: DB, SUPABASE_ANON_KEY: 'public-key', inboxCurrentQuestion: Object.assign({}, CARD, over.card || {}), agentScope: over.scope || 'customer',
    lessonScope: over.lessonScope || 'all_customers', agentDraftReady: false,
    JSON, Date, Object, Promise, encodeURIComponent, String, Array, Number, Error, Set, parseInt, setTimeout: () => 1, clearTimeout() {},
    debugLog() {}, alert: (m) => calls.alerts.push(m), confirm: () => true, window: {},
    closeInboxDetail() { calls.closed++; }, loadInboxList: async () => { calls.lists++; }, checkInboxDot: async () => { calls.dots++; }, checkNotificationsDot() {},
    openSellerInboxFromChats: async () => {}, openInboxDetail() { calls.opened++; }, sb: async () => [], w3QuestionRows: async () => [],
    document: { body: { appendChild() {} }, getElementById: (id) => els[id] || null, createElement: () => stubEl(els) },
    getValidAuthToken: async () => (over.noLogin ? null : 'login-token')
  };
  sandbox.fetch = async (url, init) => {
    if (String(url).endsWith('/webhook/seller-inbox-cards')) {
      const body = JSON.parse(init.body);
      calls.door.push({ url, body });
      const a = over.door ? over.door(body, calls.door.length) : { status: 503 };
      if (a.throws) throw new Error('network');
      return { ok: a.status === undefined || (a.status >= 200 && a.status < 300), status: a.status || 200, json: async () => a.body };
    }
    calls.direct.push({ url: String(url).replace(DB, ''), method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => [{ id: 4 }] };
  };
  vm.createContext(sandbox);
  const helper = blockOf('w3-inbox-cards-door').replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ');
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
const REFUSALS = [['not_logged_in', undefined], ['no_card', 'That card was not found.'], ['card_closed', 'That card is already answered.'], ['bad_input', 'Bad input.'], ['changed', 'It changed.']];
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const RULE_ROWS = (scope, gid, decision, instruction) => CARD.meta.breaks.map((b) => ({ seller_id: '111', guideline_id: b.id, topic: b.topic, decision, instruction, scope, phone_number: scope === 'customer' ? PHONE : null, group_id: gid }));

test('Good (this customer): ONE door call with the rules and the card, with the login token and no seller id; then the Undo note; no direct write', async () => {
  const w = world({ door: () => ok({ count: 1, rules: 2, undoId: 'u1' }) });
  await run(w, 'window.agentDecide("good")');
  same(w.calls.door.map((d) => d.body), [{ token: 'login-token', action: 'closeCard', id: 9, answer: 'Good (customer)', scope: 'this_customer',
    rules: [{ guidelineId: '11111111-1111-1111-1111-111111111111', topic: 'Tone', decision: 'good', instruction: null }, { guidelineId: '22222222-2222-2222-2222-222222222222', topic: 'Price', decision: 'good', instruction: null }] }]);
  assert.ok(w.calls.door[0].url.endsWith('/webhook/seller-inbox-cards'));
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.calls.closed, 1);
  assert.equal(w.els['w3-ic-note-msg'].textContent, 'Card answered.');
  w.calls.door.length = 0;
  await run(w, 'w3IcUndo()');
  assert.equal(w.calls.door[0].body.undoId, 'u1');
  assert.equal(w.calls.lists, 2);
});

test('Adjust for all customers and for a group: the right scope words, the instruction on every rule, the group id; group members are still written directly once', async () => {
  let w = world({ scope: 'all', door: () => ok({ count: 1, undoId: 'u2' }) });
  await run(w, 'window.agentSaveAdjust()');
  assert.equal(w.calls.door[0].body.scope, 'all_customers');
  assert.equal(w.calls.door[0].body.answer, 'Adjusted (all): Be kind');
  assert.ok(w.calls.door[0].body.rules.every((r) => r.decision === 'adjust' && r.instruction === 'Be kind'));
  assert.equal('groupId' in w.calls.door[0].body, false);
  w = world({ scope: 'group', door: () => ok({ count: 1, undoId: 'u3' }) });
  await run(w, 'window.agentSaveAdjust()');
  assert.equal(w.calls.door[0].body.scope, 'group');
  assert.equal(w.calls.door[0].body.groupId, 4);
  assert.equal(w.calls.direct.length, 1);
  assert.ok(w.calls.direct[0].url.startsWith('/rest/v1/customer_group_members?on_conflict=group_id,phone_number'));
});

test('Good / Adjust: every way the door cannot answer runs the older two writes exactly as before (rows, then the card), with no second group write', async () => {
  for (const [name, over] of FALLBACKS) {
    let w = world(over);
    await run(w, 'window.agentDecide("good")');
    same(w.calls.direct, [
      { url: '/rest/v1/rule_resolutions', method: 'POST', body: RULE_ROWS('customer', null, 'good', null) },
      { url: '/rest/v1/pending_questions?id=eq.9', method: 'PATCH', body: { status: 'answered', answer: 'Good (customer)', answer_scope: 'this_customer' } }], name);
    assert.equal(w.calls.closed, 1, name);
    w = world(Object.assign({ scope: 'group' }, over));
    await run(w, 'window.agentSaveAdjust()');
    assert.equal(w.calls.direct.length, 3, name);   // the members once, the rows, the card
    assert.ok(w.calls.direct[0].url.startsWith('/rest/v1/customer_group_members'), name);
    same(w.calls.direct[1].body, RULE_ROWS('group', 4, 'adjust', 'Be kind'), name);
    same(w.calls.direct[2].body, { status: 'answered', answer: 'Adjusted (group): Be kind', answer_scope: 'group' }, name);
  }
});

test('"Got it" on an alert: the door dismissAlert with an Undo; the older direct write only without the door', async () => {
  let w = world({ door: () => ok({ count: 1, undoId: 'u4' }) });
  await run(w, 'window.inboxDismissAlert()');
  same(w.calls.door.map((d) => d.body), [{ token: 'login-token', action: 'dismissAlert', id: 9 }]);
  assert.equal(w.calls.direct.length, 0);
  assert.equal(w.els['w3-ic-note-msg'].textContent, 'Alert dismissed.');
  assert.equal(w.calls.closed, 1);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.inboxDismissAlert()');
    same(w.calls.direct, [{ url: '/rest/v1/pending_questions?id=eq.9', method: 'PATCH', body: { status: 'answered', answer: '(seen)' } }], name);
    assert.equal(w.calls.closed, 1, name);
  }
});

test('the lesson form: the door submitLesson (summary and department only for all customers); the older two writes only without the door', async () => {
  let w = world({ door: () => ok({ count: 1, undoId: 'u5' }) });
  await run(w, 'window.submitLesson()');
  same(w.calls.door.map((d) => d.body), [{ token: 'login-token', action: 'submitLesson', id: 9, answer: 'Explain it', scope: 'all_customers', summary: 'What is the price?', department: 'sales' }]);
  assert.equal(w.calls.direct.length, 0);
  w = world({ lessonScope: 'this_customer', door: () => ok({ count: 1, undoId: 'u6' }) });
  await run(w, 'window.submitLesson()');
  same(w.calls.door.map((d) => d.body), [{ token: 'login-token', action: 'submitLesson', id: 9, answer: '(solved in the chat)', scope: 'this_customer' }]);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    await run(w, 'window.submitLesson()');
    same(w.calls.direct, [
      { url: '/rest/v1/seller_learned_answers', method: 'POST', body: { seller_id: '111', question_summary: 'What is the price?', answer: 'Explain it', scope: 'all_customers', department: 'sales' } },
      { url: '/rest/v1/pending_questions?id=eq.9', method: 'PATCH', body: { status: 'answered', answer: 'Explain it', answer_scope: 'all_customers' } }], name);
  }
});

test('turning the lesson on after the AI is switched back on: the door startLesson with the phone; the older direct write only without the door', async () => {
  let w = world({ door: () => ok({ count: 1, undoId: 'u7' }) });
  w.sb = async () => [CARD];
  await run(w, 'startLessonIfNeeded("' + PHONE + '")');
  same(w.calls.door.map((d) => d.body), [{ token: 'login-token', action: 'startLesson', phone: PHONE }]);
  assert.equal(w.calls.direct.length, 0);
  for (const [name, over] of FALLBACKS) {
    w = world(over);
    w.sb = async () => [CARD];
    await run(w, 'startLessonIfNeeded("' + PHONE + '")');
    same(w.calls.direct, [{ url: '/rest/v1/pending_questions?id=eq.9', method: 'PATCH', body: { status: 'lesson' } }], name);
  }
});

test('a refusal never falls back: the door words reach the screen (Something went wrong: ...), nothing is closed, and a login problem shows the sign-in words', async () => {
  for (const [error, message] of REFUSALS) {
    const words = error === 'not_logged_in' ? 'sign out and sign in again' : message;
    for (const [what, code] of [['decide', 'window.agentDecide("good")'], ['dismiss', 'window.inboxDismissAlert()'], ['lesson', 'window.submitLesson()']]) {
      const w = world(refuse(error, message));
      await run(w, code);
      assert.equal(w.calls.direct.length, 0, what + ' ' + error);
      assert.equal(w.calls.closed, 0, what + ' ' + error);
      assert.ok(w.calls.alerts.length === 1 && w.calls.alerts[0].startsWith('Something went wrong: ') && w.calls.alerts[0].includes(words), what + ' ' + error);
    }
    const w = world(refuse(error, message));
    w.sb = async () => [CARD];
    await run(w, 'startLessonIfNeeded("' + PHONE + '")');
    assert.equal(w.calls.direct.length, 0, 'startLesson ' + error);
    assert.ok(w.els['w3-ic-note-msg'].textContent.includes(words), 'startLesson ' + error);
  }
});

test('an Undo the door refuses shows its words; a door that cannot answer says nothing was changed', async () => {
  let w = world({ door: (b) => (b.action === 'undo' ? { body: { ok: false, error: 'changed', message: 'This was changed again.' } } : ok({ count: 1, undoId: 'u1' })) });
  await run(w, 'window.inboxDismissAlert()');
  await run(w, 'w3IcUndo()');
  assert.equal(w.els['w3-ic-note-msg'].textContent, 'This was changed again.');
  w = world({ door: (b, n) => (n === 1 ? ok({ count: 1, undoId: 'u1' }) : { status: 503, body: {} }) });
  await run(w, 'window.inboxDismissAlert()');
  await run(w, 'w3IcUndo()');
  assert.ok(w.els['w3-ic-note-msg'].textContent.includes('Nothing was changed'));
});

test('after a 429 or 503 the door is left alone for 30 seconds (the older direct writes meanwhile); a refusal, 404 and 502 do not pause it', async () => {
  for (const status of [429, 503]) {
    const w = world({ door: () => ({ status, body: {} }) });
    await run(w, 'window.inboxDismissAlert()');
    await run(w, 'window.inboxDismissAlert()');
    assert.equal(w.calls.door.length, 1);
    assert.equal(w.calls.direct.length, 2);
    const left = run(w, 'w3IcPausedUntil') - Date.now();
    assert.ok(left > 25000 && left <= 30000);
  }
  for (const over of [refuse('not_logged_in'), { door: () => ({ status: 404, body: {} }) }, { door: () => ({ status: 502, body: {} }) }]) {
    const w = world(over);
    await run(w, 'window.inboxDismissAlert()');
    assert.equal(run(w, 'w3IcPausedUntil'), 0);
  }
});
