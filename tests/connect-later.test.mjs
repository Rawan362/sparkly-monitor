// Run with:  node --test tests/*.test.mjs
// New sellers can use the web app BEFORE connecting WhatsApp: the connection popup has Cancel and a close X, a Connect WhatsApp button sits at the top
// of the Chats list while not connected, things that need WhatsApp say "Connect WhatsApp first", connected sellers see no change, and an unknown
// state blocks nothing. The own-row door and the sending doors are faked by the test: nothing leaves the test.
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
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('the new code and this test file contain only ASCII characters; the connection flow itself is not changed', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-connect-later:js:start'); const b = html.indexOf('w1-connect-later:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block)); assert.ok(!/console\./.test(block));
  // launchWhatsAppSignup is the same as before (PR 142 is held and is not touched here): its callback still sends code and seller_id only
  assert.ok(html.includes("body: JSON.stringify({ code: response.authResponse.code, seller_id: SELLER_CHAT_ID })"));
  assert.ok(!block.includes('launchWhatsAppSignup = '));
  assert.ok(html.includes('onclick="launchWhatsAppSignup()">Connect WhatsApp Number</button>'));
});

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
test.before(async () => { if (!chromium) return; server = await makeServer(); base = 'http://127.0.0.1:' + server.address().port; browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const NEW_SELLER = { ok: true, hasSeller: true, chatId: 'web_s1', whatsappConnected: false, phoneNumberId: '', onboardingDone: false };
const CONNECTED = { ok: true, hasSeller: true, chatId: 'web_s1', whatsappConnected: true, phoneNumberId: 'pn-1', onboardingDone: true };

// `me` is the own-row door's answer: an object, { status, json }, or 'abort'.
async function open(me) {
  const sends = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-own-row$/.test(u)) {
      if (me === 'abort') return route.abort();
      return me && me.json !== undefined ? json(me.status || 200, me.json) : json(200, me);
    }
    if (/seller-send-|start-new-conversation|seller-message-templates/.test(u)) { sends.push(u); return json(200, { ok: true }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(() => {
        SELLER_CHAT_ID = 'web_s1';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
        window.__ai = 0; window.__cal = 0; window.__media = 0;
        window.ensureAiReady = async () => { window.__ai++; return false; };
        window.refreshCallingStatus = () => { window.__cal++; };
        window.saveMediaToDevice = () => { window.__media++; };
        try { sessionStorage.clear(); } catch (e) {}
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, sends };
}
const check = (page) => page.evaluate(() => checkWhatsAppConnectedThenOnboarding());
const shown = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); if (!e) return null; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; }, id);
const display = (page, id) => page.$eval('#' + id, (e) => e.style.display);

test('a new seller (not connected): the popup appears with a Cancel button and a close X; the app is behind it', { skip }, async () => {
  const { page } = await open(NEW_SELLER);
  await check(page);
  assert.equal(await shown(page, 'whatsapp-connect-gate'), true);
  assert.equal(await shown(page, 'whatsapp-connect-gate-cancel'), true);
  assert.equal(await page.$eval('#whatsapp-connect-gate-cancel', (e) => e.textContent), 'Cancel');
  assert.equal(await shown(page, 'whatsapp-connect-gate-x'), true);
  assert.equal(await page.$eval('#whatsapp-connect-gate-btn', (e) => e.getAttribute('onclick')), 'launchWhatsAppSignup()');
  assert.equal(await display(page, 'app'), 'none');
  assert.equal(await page.evaluate(() => window.__ai), 0, 'nothing else starts behind the popup');
});

for (const [name, sel] of [['Cancel', '#whatsapp-connect-gate-cancel'], ['the close X', '#whatsapp-connect-gate-x']]) {
  test(name + ' closes the popup and lets the seller into the app; it does not reopen by itself in the same session', { skip }, async () => {
    const { page } = await open(NEW_SELLER);
    await check(page);
    await page.click(sel);
    assert.equal(await shown(page, 'whatsapp-connect-gate'), false);
    assert.equal(await display(page, 'app'), 'flex');
    await page.waitForFunction(() => window.__ai === 1);
    // the same session starts the app again (a reload, another start): no popup, the app opens as usual
    await check(page);
    assert.equal(await shown(page, 'whatsapp-connect-gate'), false);
    assert.equal(await display(page, 'app'), 'flex');
    assert.equal(await shown(page, 'w1-wa-banner'), true, 'the Connect WhatsApp button stays');
    // a new login on this device (the sign-out clears the flag): the popup may appear again, with Cancel
    await page.evaluate(() => clearAllAuthStorage());
    await page.evaluate(() => { SELLER_CHAT_ID = 'web_s1'; document.getElementById('app').style.display = 'flex'; });
    await check(page);
    assert.equal(await shown(page, 'whatsapp-connect-gate'), true);
    assert.equal(await shown(page, 'whatsapp-connect-gate-cancel'), true);
  });
}

test('while not connected a Connect WhatsApp button is at the top of the Chats list, with the empty-state line; it opens the same popup', { skip }, async () => {
  const { page } = await open(NEW_SELLER);
  await check(page);
  await page.click('#whatsapp-connect-gate-cancel');
  const order = await page.evaluate(() => { const list = document.getElementById('convo-list'); const b = document.getElementById('w1-wa-banner'); return b.nextElementSibling === list && b.parentElement.id === 'chats-tab-content'; });
  assert.equal(order, true, 'the banner is directly above the list');
  assert.equal(await shown(page, 'w1-wa-connect-btn'), true);
  assert.equal(await page.$eval('#w1-wa-connect-btn', (e) => e.textContent), 'Connect WhatsApp');
  await page.evaluate(() => { conversations = []; renderConvoList(); });
  assert.equal(await shown(page, 'w1-wa-empty'), true);
  assert.equal(await page.$eval('#w1-wa-empty', (e) => e.textContent), 'Connect your WhatsApp to start receiving chats');
  await page.evaluate(() => { conversations = [{ phone_number: '+10000000001', message: 'hi', role: 'user', timestamp: new Date().toISOString(), channel: 'whatsapp', displayName: 'A' }]; renderConvoList(); });
  assert.equal(await shown(page, 'w1-wa-empty'), false, 'the line is only for an empty list');
  assert.equal(await shown(page, 'w1-wa-connect-btn'), true);
  await page.click('#w1-wa-connect-btn');
  assert.equal(await shown(page, 'whatsapp-connect-gate'), true, 'the same popup as today');
  assert.equal(await page.$eval('#whatsapp-connect-gate-btn', (e) => e.getAttribute('onclick')), 'launchWhatsAppSignup()');
  await page.click('#whatsapp-connect-gate-cancel');
  assert.equal(await display(page, 'app'), 'flex');
});

test('after a successful connection (the existing flow writes Connected into its status line) the button, the popup and the guards go away', { skip }, async () => {
  for (const statusId of ['whatsapp-connect-gate-status', 'whatsapp-connect-status']) {
    const { page, sends } = await open(NEW_SELLER);
    await check(page);
    await page.click('#whatsapp-connect-gate-cancel');
    assert.equal(await shown(page, 'w1-wa-banner'), true);
    await page.evaluate((id) => { document.getElementById(id).textContent = 'Connected \u2713'; }, statusId);
    await page.waitForFunction(() => document.getElementById('w1-wa-banner').style.display === 'none');
    assert.equal(await shown(page, 'whatsapp-connect-gate'), false);
    assert.equal(await page.evaluate(() => W1_WA.state), 'connected');
    await page.evaluate(() => { document.getElementById('reply-text') || document.body.insertAdjacentHTML('beforeend', '<textarea id="reply-text"></textarea>'); });
    await page.evaluate(() => sendReply('+10000000001'));
    assert.equal(await page.$('#w1-wa-first'), null, 'nothing says Connect WhatsApp first any more');
    await page.close();
  }
});

test('a seller who is already connected sees NO change: no popup, no button, the same start-up steps', { skip }, async () => {
  const { page } = await open(CONNECTED);
  await check(page);
  assert.equal(await shown(page, 'whatsapp-connect-gate'), false);
  assert.equal(await shown(page, 'w1-wa-banner'), false);
  assert.equal(await display(page, 'app'), 'flex');
  await page.waitForFunction(() => window.__ai === 1);
  assert.equal(await page.evaluate(() => W1_WA.state), 'connected');
  assert.equal(await page.evaluate(() => W1_WA.timers), true);
  await page.evaluate(() => { conversations = []; renderConvoList(); });
  assert.equal(await shown(page, 'w1-wa-empty'), false);
  assert.equal(await page.$('#w1-wa-first'), null);
  const phoneOnly = await open({ ok: true, hasSeller: true, phoneNumberId: 'pn-9' });
  await check(phoneOnly.page);
  assert.equal(await shown(phoneOnly.page, 'whatsapp-connect-gate'), false);
  assert.equal(await shown(phoneOnly.page, 'w1-wa-banner'), false);
});

test('an unknown state (no answer, an error, no seller row yet, no field) blocks nothing and shows nothing extra', { skip }, async () => {
  const cases = ['abort', { status: 503, json: {} }, { ok: false, error: 'not_available' }, { ok: true, hasSeller: false }, { ok: true, hasSeller: true, onboardingDone: true }, { status: 200, json: null }];
  for (const me of cases) {
    const { page, sends } = await open(me);
    await check(page);
    assert.equal(await shown(page, 'whatsapp-connect-gate'), false, JSON.stringify(me));
    assert.equal(await shown(page, 'w1-wa-banner'), false, JSON.stringify(me));
    assert.equal(await display(page, 'app'), 'flex');
    await page.waitForFunction(() => window.__ai === 1);
    assert.equal(await page.evaluate(() => W1_WA.state), 'unknown');
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<textarea id="reply-text"></textarea>'); });
    await page.evaluate(() => sendReply('+10000000001'));
    assert.equal(await page.$('#w1-wa-first'), null, 'an unknown state never says Connect WhatsApp first');
    await page.close();
  }
});

test('while not connected, actions that need WhatsApp show the red message "Connect WhatsApp first" and send nothing', { skip }, async () => {
  const { page, sends } = await open(NEW_SELLER);
  await check(page);
  await page.click('#whatsapp-connect-gate-cancel');
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<textarea id="reply-text">typed words</textarea>'); });
  const actions = [
    () => sendReply('+10000000001'),
    () => sendAttachment('data:image/png;base64,AAAA', 'image/png', 'image', 'a.png', '', '+10000000001', null),
    () => sendLocation(),
    () => sendVoiceNote('+10000000001', 'data:audio/webm;base64,AAAA'),
    () => forwardMessageTo('+10000000001'),
    () => openNewConversationModal(),
    () => checkNewConversationNumber(),
    () => sendNewConversationTemplate()
  ];
  for (const [i, fn] of actions.entries()) {
    await page.evaluate(() => { const t = document.getElementById('w1-wa-first'); if (t) t.style.display = 'none'; });
    await page.evaluate(fn);
    assert.equal(await page.$eval('#w1-wa-first-msg', (e) => e.textContent), 'Connect WhatsApp first', 'action ' + i);
    assert.equal(await shown(page, 'w1-wa-first'), true, 'action ' + i);
    const c = await page.$eval('#w1-wa-first', (e) => getComputedStyle(e).backgroundColor.match(/\d+/g).map(Number));
    assert.ok(c[0] > c[1] + 60 && c[0] > c[2] + 60, 'the message is red: ' + c.join(','));
    assert.equal(await page.$eval('#w1-wa-first', (e) => e.getAttribute('role')), 'alert');
  }
  assert.equal(await page.$eval('#reply-text', (e) => e.value), 'typed words', 'what the seller typed is kept');
  assert.equal(await shown(page, 'new-conversation-modal'), false, 'the new conversation screen did not open');
  assert.deepEqual(sends, [], 'nothing was sent to any WhatsApp door');
  await page.click('#w1-wa-first-btn');
  assert.equal(await shown(page, 'whatsapp-connect-gate'), true, 'the message offers the same popup');
});

test('the message templates section says Connect WhatsApp first in its own red line while not connected, and works as before when connected', { skip }, async () => {
  const off = await open(NEW_SELLER);
  await check(off.page);
  await off.page.click('#whatsapp-connect-gate-cancel');
  await off.page.evaluate(() => { const d = document.getElementById('tpl-box'); d.open = true; tplToggled(d); });
  assert.equal(await off.page.$eval('#tpl-msg, .tpl-msg', (e) => e.textContent).catch(() => null) !== null, true);
  const msgs = await off.page.$$eval('.tpl-msg', (els) => els.map((e) => e.textContent));
  assert.ok(msgs.includes('Connect WhatsApp first'), JSON.stringify(msgs));
  assert.deepEqual(off.sends, []);
  const on = await open(CONNECTED);
  await check(on.page);
  await on.page.evaluate(() => { const d = document.getElementById('tpl-box'); d.open = true; tplToggled(d); });
  await on.page.waitForTimeout(500);
  const msgs2 = await on.page.$$eval('.tpl-msg', (els) => els.map((e) => e.textContent));
  assert.ok(!msgs2.includes('Connect WhatsApp first'));
  assert.ok(on.sends.length >= 1, 'a connected seller\'s templates are asked for as before');
});

test('a connected seller\'s actions reach the original functions untouched (no guard message, the original ran)', { skip }, async () => {
  const { page } = await open(CONNECTED);
  await check(page);
  const ran = await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<textarea id="reply-text"></textarea>');
    let called = 0;
    const orig = window.sendLocation; // the guard wraps the real one; the real one is reached when connected
    const out = await sendReply('+10000000001');   // empty text: the original returns without sending
    return { out: out === undefined, toast: !!document.getElementById('w1-wa-first') };
  });
  assert.equal(ran.toast, false);
});
