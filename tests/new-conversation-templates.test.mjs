// Run with:  node --test tests/*.test.mjs
// Real-browser tests of the message-template part of the "Start a new conversation" screen. The REAL index.html runs in Chromium; the Message
// Templates door and the Start New Conversation door are answered by the test (mocked Meta answers): nothing leaves the test and no real
// template is created. If Playwright is not installed (it is installed in CI), these tests are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch (e) {
  try { chromium = createRequire('/opt/node-tools/node_modules/')('playwright').chromium; } catch (e2) { chromium = null; }
}
const skip = chromium ? false : 'Playwright is not installed';

const LANGS = [
  { code: 'en', label: 'English', defaultText: 'Hello! This is {{1}}. We are happy to help you with anything you need.' },
  { code: 'es', label: 'Spanish', defaultText: 'Hola! Te escribimos de {{1}}. Con gusto te ayudamos con lo que necesites.' },
  { code: 'fr', label: 'French', defaultText: 'Bonjour ! Merci de nous contacter. Répondez à ce message et nous discuterons.' },
  { code: 'xx', label: 'No default language', defaultText: null }
];
const tpl = (o) => Object.assign({ ours: true, canStart: false, canEdit: true, canDelete: true, name: 'sparkly_welcome_en', language: 'en', languageLabel: 'English', status: 'approved' }, o);
const APPROVED_EN = tpl({ id: '1', canStart: true });
const APPROVED_ES = tpl({ id: '2', name: 'sparkly_welcome_es', language: 'es', languageLabel: 'Spanish', canStart: true });
const HAND_MADE = tpl({ id: '3', name: 'my_own_hello', language: 'fr', languageLabel: 'French', ours: false, canStart: true });
const PENDING_EN = tpl({ id: '4', status: 'pending' });
const REJECTED_EN = tpl({ id: '5', status: 'rejected', reason: 'WhatsApp says the format is wrong.' });
const NOT_STARTABLE = tpl({ id: '6', name: 'login_code', canStart: false });

const NONE = 'You need a message template first';
const WAITING = 'Your message template is waiting for approval';

function makeServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.join(root, f);
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
let server; let browser; let base;
test.before(async () => {
  if (!chromium) return;
  server = await makeServer();
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const listOf = (templates) => ({ json: { ok: true, connected: true, templates, languages: LANGS, businessName: 'Corner Shop' } });

// `door(body)` answers the template door; `starts` collects what the app asks the Start New Conversation door.
async function openScreen(door, calls, starts, o = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-message-templates$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = door(body);
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
    if (/\/webhook\/start-new-conversation$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      starts.push(body);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify(body.action === 'check' ? { success: true, isValidWhatsApp: true, verified: false } : { success: false, error: 'stop here' }) });
    }
    if (/seller_sales_config/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify([{ default_language: o.defaultLanguage || null }]) });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate((poll) => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
        window._nctPollMs = poll;
      }, o.pollMs || 60000);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  await page.evaluate(() => window.openNewConversationModal());
  return { page, errors };
}
const text = (page, id) => page.$eval('#' + id, (e) => e.textContent);
const shown = (page, id) => page.$eval('#' + id, (e) => e.style.display !== 'none' && getComputedStyle(e).display !== 'none');
const checkDisabled = (page) => page.$eval('#new-conversation-check-btn', (e) => e.disabled);
const settled = (page) => page.waitForFunction(() => document.getElementById('nct-title') && document.getElementById('nct-title').textContent !== 'Checking your message templates...');

test('no template: "You need a message template first", one-tap ready-made message in the seller language, the number step is held back', { skip }, async () => {
  const calls = []; const starts = [];
  const { page, errors } = await openScreen(() => listOf([]), calls, starts, { defaultLanguage: 'Spanish' });
  await settled(page);
  assert.equal(await text(page, 'nct-title'), NONE);
  assert.match(await text(page, 'nct-text'), /usually takes a few minutes and can take up to 24 hours/);
  assert.equal(await text(page, 'nct-create'), 'Create a ready-made message in Spanish', 'the seller language is used, not a fixed one');
  assert.equal(await text(page, 'nct-preview'), 'Hola! Te escribimos de Corner Shop. Con gusto te ayudamos con lo que necesites.');
  assert.equal(await checkDisabled(page), true);
  assert.deepEqual(calls.map((c) => c.action), ['list']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the preview fills in the business name when the ready-made text has {{1}}, and shows a text without it as it is', { skip }, async () => {
  const { page } = await openScreen(() => listOf([]), [], [], { defaultLanguage: 'French' });
  await settled(page);
  assert.equal(await text(page, 'nct-preview'), 'Bonjour ! Merci de nous contacter. Répondez à ce message et nous discuterons.');
  await page.close();
  const { page: p2 } = await openScreen(() => listOf([]), [], [], { defaultLanguage: 'English' });
  await settled(p2);
  assert.equal(await text(p2, 'nct-preview'), 'Hello! This is Corner Shop. We are happy to help you with anything you need.');
  await p2.close();
});

test('the phone language is used when the seller has set none; a language with no ready-made text sends the seller to Message templates', { skip }, async () => {
  const calls = []; const starts = [];
  const { page } = await openScreen(() => listOf([]), calls, starts, { defaultLanguage: 'No default language' });
  await settled(page);
  assert.equal(await shown(page, 'nct-create'), false);
  assert.match(await text(page, 'nct-text'), /We do not have a ready-made message in your language yet\. Write your own in Message templates\./);
  assert.equal(await text(page, 'nct-settings'), 'Open message templates');
  await page.close();
  const c2 = [];
  const { page: p2 } = await openScreen(() => listOf([]), c2, [], {});
  await settled(p2);
  assert.match(await text(p2, 'nct-create'), /^Create a ready-made message in /);
  await p2.close();
});

test('one tap creates the template, shows it waiting for approval with how long it takes, and starting is allowed as soon as it is approved', { skip }, async () => {
  const calls = []; const starts = [];
  let phase = 'none';
  const door = (b) => {
    if (b.action === 'create') { phase = 'pending'; return { json: { ok: true, created: true, message: 'Sent to WhatsApp for review. It shows as "Waiting for approval" until WhatsApp has checked it.' } }; }
    return listOf(phase === 'none' ? [] : phase === 'pending' ? [PENDING_EN] : [APPROVED_EN]);
  };
  const { page, errors } = await openScreen(door, calls, starts, { defaultLanguage: 'English', pollMs: 300 });
  await settled(page);
  await page.click('#nct-create');
  await page.waitForFunction((t) => document.getElementById('nct-title').textContent === t, WAITING);
  const create = calls.find((c) => c.action === 'create');
  assert.deepEqual(Object.keys(create).sort(), ['action', 'language', 'text', 'token']);
  assert.equal(create.language, 'en');
  assert.equal(create.text, LANGS[0].defaultText);
  assert.match(await text(page, 'nct-text'), /within a few minutes, and it can take up to 24 hours/);
  assert.match(await text(page, 'nct-msg'), /Sent to WhatsApp for review/);
  assert.equal(await checkDisabled(page), true, 'cannot start while the template is only waiting');
  phase = 'approved';                      // WhatsApp approves; the screen checks again by itself
  await page.waitForFunction(() => !document.getElementById('new-conversation-check-btn').disabled, null, { timeout: 5000 });
  assert.equal(await shown(page, 'new-conversation-templates'), false, 'one approved template: nothing more to ask');
  assert.deepEqual(errors, []);
  await page.close();
});

test('waiting only: says so, and the Check again button asks the door again', { skip }, async () => {
  const calls = []; const starts = [];
  const { page } = await openScreen(() => listOf([PENDING_EN]), calls, starts);
  await settled(page);
  assert.equal(await text(page, 'nct-title'), WAITING);
  assert.equal(await shown(page, 'nct-create'), false, 'no second template is offered while one is waiting');
  await page.click('#nct-refresh');
  await page.waitForFunction(() => document.getElementById('nct-msg').textContent === '');
  assert.deepEqual(calls.map((c) => c.action), ['list', 'list']);
  await page.close();
});

test('rejected only: shows WhatsApp\'s reason and leads to Message templates', { skip }, async () => {
  const calls = []; const starts = [];
  const { page } = await openScreen(() => listOf([REJECTED_EN]), calls, starts);
  await settled(page);
  assert.equal(await text(page, 'nct-title'), 'WhatsApp rejected your message template');
  assert.equal(await text(page, 'nct-reason'), 'WhatsApp says the format is wrong.');
  assert.equal(await text(page, 'nct-settings'), 'Open message templates');
  assert.equal(await checkDisabled(page), true);
  await page.close();
});

test('one approved template: no extra step, and the send asks for exactly that template', { skip }, async () => {
  const calls = []; const starts = [];
  const { page } = await openScreen(() => listOf([HAND_MADE, NOT_STARTABLE, PENDING_EN]), calls, starts);
  await page.waitForFunction(() => !document.getElementById('new-conversation-check-btn').disabled);
  assert.equal(await shown(page, 'new-conversation-templates'), false);
  await page.fill('#new-conversation-phone-input', '15550100100');
  await page.click('#new-conversation-check-btn');
  await page.waitForSelector('#new-conversation-step-confirm', { state: 'visible' });
  await page.click('#new-conversation-send-btn');
  await page.waitForFunction(() => /stop here/.test(document.getElementById('new-conversation-send-status').textContent));
  const send = starts.find((s) => s.action === 'send');
  assert.equal(send.templateName, 'my_own_hello', 'a hand-made template works, whatever its name');
  assert.equal(send.templateLanguage, 'fr');
  await page.close();
});

test('several approved templates: the seller chooses, the seller language is pre-selected, and the choice is what is sent', { skip }, async () => {
  const calls = []; const starts = [];
  const { page, errors } = await openScreen(() => listOf([APPROVED_EN, APPROVED_ES, HAND_MADE, NOT_STARTABLE]), calls, starts, { defaultLanguage: 'Spanish' });
  await page.waitForSelector('#nct-picker', { state: 'visible' });
  assert.equal(await text(page, 'nct-title'), 'Choose your message template');
  const options = await page.$$eval('#nct-select option', (o) => o.map((x) => x.textContent));
  assert.deepEqual(options, ['English', 'Spanish', 'French (my_own_hello)'], 'a template that cannot start a conversation is not offered');
  assert.equal(await page.$eval('#nct-select', (e) => e.value), 'sparkly_welcome_es|es');
  assert.equal(await checkDisabled(page), false);
  await page.selectOption('#nct-select', 'my_own_hello|fr');
  await page.fill('#new-conversation-phone-input', '15550100100');
  await page.click('#new-conversation-check-btn');
  await page.waitForSelector('#new-conversation-step-confirm', { state: 'visible' });
  await page.click('#new-conversation-send-btn');
  await page.waitForFunction(() => /stop here/.test(document.getElementById('new-conversation-send-status').textContent));
  const send = starts.find((s) => s.action === 'send');
  assert.deepEqual([send.templateName, send.templateLanguage], ['my_own_hello', 'fr']);
  assert.equal(starts.find((s) => s.action === 'check').templateName, undefined, 'the number check carries no template');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the template door is not available (503), refuses, says not connected, or answers oddly: the screen works exactly as before', { skip }, async () => {
  for (const door of [() => ({ status: 503, json: { code: 'not_ready' } }), () => ({ json: { ok: false, error: 'no_permission', message: 'x' } }), () => ({ json: { ok: true, connected: false } }), () => ({ json: [] })]) {
    const calls = []; const starts = [];
    const { page, errors } = await openScreen(door, calls, starts);
    await page.waitForFunction(() => !document.getElementById('new-conversation-check-btn').disabled);
    assert.equal(await shown(page, 'new-conversation-templates'), false);
    await page.fill('#new-conversation-phone-input', '15550100100');
    await page.click('#new-conversation-check-btn');
    await page.waitForSelector('#new-conversation-step-confirm', { state: 'visible' });
    await page.click('#new-conversation-send-btn');
    await page.waitForFunction(() => /stop here/.test(document.getElementById('new-conversation-send-status').textContent));
    const send = starts.find((s) => s.action === 'send');
    assert.deepEqual(Object.keys(send).sort(), ['action', 'phoneNumber', 'sellerChatId'], 'no template is named: the door chooses (backend #142)');
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('a refusal while creating is shown in the server words and nothing else changes', { skip }, async () => {
  const words = 'Your WhatsApp connection does not have permission to manage message templates. Connect your WhatsApp number again.';
  const calls = []; const starts = [];
  const { page } = await openScreen((b) => (b.action === 'create' ? { json: { ok: false, error: 'no_permission', message: words } } : listOf([])), calls, starts, { defaultLanguage: 'English' });
  await settled(page);
  await page.click('#nct-create');
  await page.waitForFunction((t) => document.getElementById('nct-msg').textContent === t, words);
  assert.ok(await page.$eval('#nct-msg', (e) => e.classList.contains('error')));
  assert.equal(await page.$eval('#nct-title', (e) => e.textContent), NONE);
  assert.equal(await page.$eval('#nct-create', (e) => e.disabled), false, 'the seller can try again');
  await page.close();
});

test('closing the screen stops the automatic checking', { skip }, async () => {
  const calls = []; const starts = [];
  const { page } = await openScreen(() => listOf([PENDING_EN]), calls, starts, { pollMs: 200 });
  await settled(page);
  await page.waitForFunction(() => true);
  await page.waitForTimeout(700);
  assert.ok(calls.length >= 3, 'it checks again by itself while open');
  await page.evaluate(() => window.closeNewConversationModal());
  const n = calls.length;
  await page.waitForTimeout(700);
  assert.equal(calls.length, n);
  await page.close();
});
