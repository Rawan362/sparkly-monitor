// Run with:  node --test tests/*.test.mjs
// Real-browser test of Settings -> Message templates. The template door is answered by the test (mocked Meta answers): nothing leaves the
// test and no real template is created. If Playwright is not installed (it is installed in CI), this test is skipped.
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
  { code: 'xx', label: 'No default language', defaultText: null }
];
const tpl = (o) => Object.assign({ ours: true, canEdit: true, canDelete: true, languageLabel: 'English', language: 'en', status: 'approved', statusText: 'Approved. You can use it to start conversations.' }, o);
const TEMPLATES = [
  tpl({ id: '1', name: 'sparkly_welcome_en', text: 'Hello <b>x</b> {{1}} approved text here' }),
  tpl({ id: '2', language: 'es', languageLabel: 'Spanish', status: 'pending', statusText: 'Waiting for approval from WhatsApp.', canEdit: false, blockedText: 'WhatsApp only allows a change while the template is approved, rejected or paused. Wait until the review is finished, then press Refresh.' }),
  tpl({ id: '3', language: 'fr', languageLabel: 'French', status: 'rejected', statusText: 'Rejected by WhatsApp.', reason: 'WhatsApp says the format is wrong.', text: 'Bonjour {{1}} text' }),
  tpl({ id: '4', language: 'de', languageLabel: 'German', status: 'other', statusText: 'Paused by WhatsApp because customers gave bad feedback.', canEdit: true }),
  tpl({ id: '5', language: 'en', languageLabel: 'English', name: 'made_by_hand', ours: false, canEdit: false, canDelete: false, blockedText: 'This template was not made here, so it can only be changed in WhatsApp Manager.' })
];

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

// `answer(body)` returns { status, json } for each call the app makes to the template door.
async function openSection(answer, calls) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-message-templates$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action !== 'sending_status') calls.push(body);   // the read-only payment status check is covered by tests/payment-block.test.mjs
      const a = answer(body);
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('dialog', (d) => d.accept());
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(() => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  await page.evaluate(() => {
    document.getElementById('business-tab-content').style.display = 'flex';
    document.getElementById('tpl-box').scrollIntoView();
  });
  return { page, errors };
}
const text = (page, id) => page.$eval('#' + id, (e) => e.textContent);
const shown = (page, id) => page.$eval('#' + id, (e) => e.style.display !== 'none');
const listOk = () => ({ json: { ok: true, connected: true, templates: TEMPLATES, languages: LANGS, businessName: 'Shop', variable: '{{1}}' } });
const openBox = async (page) => { await page.click('#tpl-box > summary'); await page.waitForSelector('.tpl-card'); };

test('opening the section loads the list once and shows every status in plain words, with the reason when rejected', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openSection(() => listOk(), calls);
  assert.equal(calls.length, 0, 'nothing is asked until the seller opens the section');
  await openBox(page);
  assert.deepEqual(calls.map((c) => c.action), ['list']);
  assert.equal(calls[0].token, 'test-token');
  const cards = await page.$$eval('.tpl-card', (els) => els.map((e) => ({ badge: e.querySelector('.tpl-badge').textContent, status: e.querySelector('.tpl-status-text').textContent, reason: (e.querySelector('.tpl-reason') || {}).textContent || '', buttons: [...e.querySelectorAll('button')].map((b) => b.textContent) })));
  assert.deepEqual(cards.map((c) => c.badge), ['Approved', 'Waiting for approval', 'Rejected', 'Not available', 'Approved']);
  assert.equal(cards[2].reason, 'WhatsApp says the format is wrong.');
  assert.match(cards[3].status, /Paused by WhatsApp/);
  assert.deepEqual(cards[0].buttons, ['Edit', 'Delete']);
  assert.deepEqual(cards[1].buttons, ['Delete'], 'a template in review can be deleted but not edited');
  assert.deepEqual(cards[4].buttons, [], 'a template made by hand is shown and left alone');
  // the saved text is shown as text, never as HTML
  assert.equal(await page.$$eval('.tpl-body b', (e) => e.length), 0);
  assert.match(await page.$eval('.tpl-body', (e) => e.textContent), /Hello <b>x<\/b>/);
  await page.click('#tpl-refresh');
  await page.waitForFunction(() => document.querySelectorAll('.tpl-card').length === 5);
  assert.deepEqual(calls.map((c) => c.action), ['list', 'list'], 'the refresh button asks again');
  assert.deepEqual(errors, []);
  await page.close();
});

test('every language comes from the server, the box is pre-filled with a safe default, and a seller text is not overwritten', { skip }, async () => {
  const calls = [];
  const { page } = await openSection(() => listOk(), calls);
  await openBox(page);
  const options = await page.$$eval('#tpl-language option', (o) => o.map((x) => x.value));
  assert.deepEqual(options, ['en', 'es', 'xx']);
  assert.equal(await page.inputValue('#tpl-text'), LANGS[0].defaultText);
  await page.selectOption('#tpl-language', 'es');
  assert.equal(await page.inputValue('#tpl-text'), LANGS[1].defaultText, 'an untouched default follows the language');
  await page.fill('#tpl-text', 'My own greeting from {{1}} for you today');
  await page.selectOption('#tpl-language', 'en');
  assert.equal(await page.inputValue('#tpl-text'), 'My own greeting from {{1}} for you today', 'the seller text stays');
  await page.fill('#tpl-text', '');
  await page.selectOption('#tpl-language', 'xx');
  assert.equal(await page.inputValue('#tpl-text'), '', 'a language with no default starts empty');
  await page.close();
});

test('Create sends the chosen language and the text, shows the plain-words answer, and refreshes the list', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openSection((b) => b.action === 'create'
    ? { json: { ok: true, created: true, message: 'Sent to WhatsApp for review. It shows as "Waiting for approval" until WhatsApp has checked it.' } }
    : listOk(), calls);
  await openBox(page);
  await page.selectOption('#tpl-language', 'es');
  await page.click('#tpl-save');
  await page.waitForFunction(() => /Sent to WhatsApp for review/.test(document.getElementById('tpl-msg').textContent));
  const create = calls.filter((c) => c.action === 'create');
  assert.equal(create.length, 1);
  assert.deepEqual(Object.keys(create[0]).sort(), ['action', 'language', 'text', 'token']);
  assert.equal(create[0].language, 'es');
  assert.equal(create[0].text, LANGS[1].defaultText);
  assert.equal(calls[calls.length - 1].action, 'list', 'the list is refreshed after creating');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a refusal is shown exactly as the server words it: no permission, text problem, duplicate, unsupported language, edit limit', { skip }, async () => {
  const words = [
    'Your WhatsApp connection does not have permission to manage message templates. Connect your WhatsApp number again and, when WhatsApp asks, allow "Manage message templates" (the whatsapp_business_management permission).',
    '{{1}} cannot be the very first thing in the text. Write a few words before it, for example a greeting.',
    'You already have this template and it is approved. Nothing was sent again.',
    'WhatsApp does not support message templates in this language. Pick another language from the list.',
    'An approved template can only be changed once every 24 hours.'
  ];
  for (const w of words) {
    const calls = [];
    const { page } = await openSection((b) => b.action === 'list' ? listOk() : { json: { ok: false, error: 'x', message: w } }, calls);
    await openBox(page);
    await page.click('#tpl-save');
    await page.waitForFunction((t) => document.getElementById('tpl-msg').textContent === t, w);
    assert.ok(await page.$eval('#tpl-msg', (e) => e.classList.contains('error')));
    await page.close();
  }
});

test('the help line says {{1}} is optional, and the text is sent exactly as typed with or without the variable (the server applies the rules)', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openSection((b) => (b.action === 'create' ? { json: { ok: true, created: true, message: 'Sent to WhatsApp for review.' } } : listOk()), calls);
  await openBox(page);
  assert.equal(
    await page.$eval('#tpl-help', (e) => e.textContent),
    'You can use {{1}} once; it is replaced by your business name when the message is sent. Or write the text without it. If you use it, put it in the middle of the text with a few words before and after it, not at the very start or end. Keep it a simple greeting: no prices, offers, shortened links, or requests for passwords or ID numbers.'
  );
  assert.doesNotMatch(await page.$eval('#tpl-help', (e) => e.textContent), /must contain|exactly once/);
  for (const text of ['Hello! Thank you for contacting our shop. Just reply and we will chat.', 'Hello! This is {{1}}. We are happy to help with anything you need.']) {
    await page.fill('#tpl-text', text);
    await page.click('#tpl-save');
    await page.waitForFunction(() => /Sent to WhatsApp for review/.test(document.getElementById('tpl-msg').textContent));
    const sent = calls.filter((c) => c.action === 'create').pop();
    assert.equal(sent.text, text, 'nothing is added or removed by the app');
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('the preview shows the business name in place of {{1}}, and a text without it as it is', { skip }, async () => {
  const calls = [];
  const { page } = await openSection(() => listOk(), calls);
  await openBox(page);
  await page.fill('#tpl-text', 'Hello! This is {{1}}. Reply to chat with us.');
  assert.equal(await text(page, 'tpl-preview'), 'Preview: Hello! This is Shop. Reply to chat with us.');
  await page.fill('#tpl-text', 'Hello! Thank you for contacting our shop.');
  assert.equal(await text(page, 'tpl-preview'), 'Preview: Hello! Thank you for contacting our shop.');
  await page.fill('#tpl-text', '');
  assert.equal(await shown(page, 'tpl-preview'), false);
  await page.close();
});

test('Edit puts the saved text in the box with the warning, locks the language, and sends only the template id and the text', { skip }, async () => {
  const calls = [];
  const { page } = await openSection((b) => b.action === 'edit' ? { json: { ok: true, edited: true, message: 'Change sent to WhatsApp for review.' } } : listOk(), calls);
  await openBox(page);
  await page.click('[data-tpl-edit="3"]');
  assert.equal(await page.inputValue('#tpl-text'), 'Bonjour {{1}} text');
  assert.equal(await page.$eval('#tpl-language', (e) => e.disabled), true);
  assert.equal(await page.$eval('#tpl-save', (e) => e.textContent), 'Save change');
  assert.match(await page.$eval('#tpl-edit-warning', (e) => e.textContent), /once every 24 hours and at most 10 times in 30 days/);
  await page.fill('#tpl-text', 'Bonjour, ici {{1}}. Nous sommes ravis de vous aider.');
  await page.click('#tpl-save');
  await page.waitForFunction(() => /Change sent to WhatsApp/.test(document.getElementById('tpl-msg').textContent));
  const edit = calls.find((c) => c.action === 'edit');
  assert.deepEqual(Object.keys(edit).sort(), ['action', 'templateId', 'text', 'token']);
  assert.equal(edit.templateId, '3');
  assert.equal(await page.$eval('#tpl-save', (e) => e.textContent), 'Create', 'the form is back to creating');
  await page.close();
});

test('Cancel leaves editing without sending anything', { skip }, async () => {
  const calls = [];
  const { page } = await openSection(() => listOk(), calls);
  await openBox(page);
  await page.click('[data-tpl-edit="1"]');
  await page.click('#tpl-cancel');
  assert.equal(await page.$eval('#tpl-save', (e) => e.textContent), 'Create');
  assert.deepEqual(calls.map((c) => c.action), ['list']);
  await page.close();
});

test('Delete asks first (with the 30-day warning for an approved one), then sends the template id and refreshes', { skip }, async () => {
  const calls = [];
  const { page } = await openSection((b) => b.action === 'delete' ? { json: { ok: true, deleted: true, message: 'Deleted.' } } : listOk(), calls);
  const asked = [];
  await openBox(page);
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => { asked.push(d.message()); d.accept(); });
  await page.click('[data-tpl-delete="1"]');
  await page.waitForFunction(() => /Deleted\./.test(document.getElementById('tpl-msg').textContent));
  assert.match(asked[0], /30 days/);
  const del = calls.find((c) => c.action === 'delete');
  assert.deepEqual(Object.keys(del).sort(), ['action', 'templateId', 'token']);
  assert.equal(del.templateId, '1');
  await page.close();
});

test('a door that is not switched on yet (503) says so in plain words and breaks nothing', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openSection(() => ({ status: 503, json: { code: 'not_ready' } }), calls);
  await page.click('#tpl-box > summary');
  await page.waitForFunction(() => /not available yet/.test(document.getElementById('tpl-msg').textContent));
  assert.equal(await page.$eval('#tpl-msg', (e) => e.textContent), 'Message templates are not available yet. Please try again later.');
  assert.deepEqual(errors, []);
  await page.close();
});

test('not connected: the server words are shown and no form call is made', { skip }, async () => {
  const calls = [];
  const { page } = await openSection(() => ({ json: { ok: true, connected: false, message: 'Connect your WhatsApp number first.' } }), calls);
  await page.click('#tpl-box > summary');
  await page.waitForFunction(() => /Connect your WhatsApp number first/.test(document.getElementById('tpl-msg').textContent));
  assert.deepEqual(calls.map((c) => c.action), ['list']);
  await page.close();
});
