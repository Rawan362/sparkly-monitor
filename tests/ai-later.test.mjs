// Run with:  node --test tests/*.test.mjs
// New sellers can use the web app BEFORE the AI is set up: the "Set up your AI" popup has "Cancel for now" (nothing saved, nothing sent), a
// "Set up your AI" button in Chats and in the Engine screen reopens the same popup, the popup does not reopen by itself after Cancel,
// things that need the AI say "Set up your AI first", and a seller with a working key sees no change. The Anthropic edge function and the
// webhooks are faked by the test: nothing leaves the test; no key value is used anywhere.
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

test('the new code and this test file contain only ASCII characters; the key check, the Connect and check button and the popup are not changed', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-ai-later:js:start'); const b = html.indexOf('w1-ai-later:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block)); assert.ok(!/console\./.test(block));
  assert.ok(!/anthropic-connect|sk-ant/.test(block), 'the new code makes no call of its own and holds no key');
  // the existing pieces are still there exactly as they were
  assert.ok(html.includes("try { const r = await engineCall({ action: 'check' }); return r.state || 'error'; } catch (e) { return 'error'; }"));
  assert.ok(html.includes('<button class="eng-btn" id="ai-w-go">Connect and check</button>'));
  assert.ok(html.includes('<button class="eng-btn sec" id="ai-w-recheck">I added funds, check again</button>'));
  assert.ok(html.includes("const r = await engineCall({ action: 'connect', key: k });"));
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

// `state` is what the existing check answers: ready, no_key, invalid, no_credit, or 'error' (the check itself fails).
async function open(state) {
  const conn = []; const hooks = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const ctl = { state };
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/functions\/v1\/anthropic-connect$/.test(u)) {
      const b = JSON.parse(route.request().postData() || '{}'); conn.push(b.action);
      if (b.action === 'check') return ctl.state === 'error' ? route.abort() : json(200, { ok: true, state: ctl.state });
      if (b.action === 'status') return json(200, { connected: ctl.state === 'ready', admin_connected: false });
      return json(200, { ok: true });
    }
    if (/\/webhook\/(web-business-chat|web-test-mode-chat|web-onboarding-chat|answer-inbox-question)/.test(u) || /web-admin-chat|ahmad|sparkly-closer/.test(u)) { hooks.push(u); return json(200, { reply: 'x' }); }
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
        try { sessionStorage.clear(); } catch (e) {}
        window.__ready = 0; window.__onReady = () => { window.__ready++; };
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, conn, hooks, ctl };
}
const ensure = (page) => page.evaluate(() => ensureAiReady(window.__onReady));
const shown = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; }, id);

test('a seller whose AI is not set up sees the same popup as always, now with "Cancel for now"', { skip }, async () => {
  const { page, conn } = await open('no_key');
  assert.equal(await ensure(page), false);
  assert.equal(await shown(page, 'ai-setup-wizard'), true);
  assert.equal(await page.$eval('.eng-h', (e) => e.textContent), 'Set up your AI');
  assert.equal(await page.$eval('#ai-w-go', (e) => e.textContent), 'Connect and check');
  assert.equal(await page.$eval('#ai-w-recheck', (e) => e.textContent), 'I added funds, check again');
  assert.equal(await page.$eval('#ai-w-cancel', (e) => e.textContent), 'Cancel for now');
  assert.deepEqual(conn, ['check'], 'only the existing read-only check was asked');
});

test('Cancel for now closes the popup, saves nothing, sends nothing, and the seller can use the whole app', { skip }, async () => {
  const { page, conn } = await open('no_key');
  await ensure(page);
  await page.fill('#ai-w-key', 'x'.repeat(5)).catch(() => {});
  await page.click('#ai-w-cancel');
  assert.equal(await page.$('#ai-setup-wizard'), null);
  assert.deepEqual(conn, ['check'], 'nothing was sent to Anthropic or the backend (no connect, no status)');
  assert.equal(await page.evaluate(() => document.getElementById('app').style.display), 'flex');
  assert.equal(await page.evaluate(() => window.__ready), 0, 'the AI onboarding does not start without an AI');
  assert.equal(await shown(page, 'w1-ai-banner'), true);
});

test('the popup does not reopen by itself after Cancel: not at the next start-up check, not when a screen changes', { skip }, async () => {
  const { page } = await open('no_credit');
  await ensure(page);
  await page.click('#ai-w-cancel');
  for (let i = 0; i < 3; i++) { assert.equal(await ensure(page), false); }
  await page.evaluate(() => { openSettings(); });
  await page.evaluate(() => { openSparklyAssistant(); });
  await page.waitForTimeout(300);
  assert.equal(await page.$('#ai-setup-wizard'), null);
  assert.equal(await page.$eval('#w1-ai-banner', (e) => e.style.display), '', 'the button stays (it is in the Chats list, which is hidden while another screen is open)');
});

test('the Set up your AI button in Chats reopens the same popup; Cancel closes it again', { skip }, async () => {
  const { page, conn } = await open('invalid');
  await ensure(page); await page.click('#ai-w-cancel');
  const above = await page.evaluate(() => { const b = document.getElementById('w1-ai-banner'); return b.parentElement.id === 'chats-tab-content' && b.compareDocumentPosition(document.getElementById('convo-list')) & Node.DOCUMENT_POSITION_FOLLOWING; });
  assert.ok(above, 'the button is above the Chats list');
  assert.equal(await page.$eval('#w1-ai-setup-btn', (e) => e.textContent), 'Set up your AI');
  await page.click('#w1-ai-setup-btn');
  assert.equal(await shown(page, 'ai-setup-wizard'), true);
  assert.equal(await page.$eval('#ai-w-go', (e) => e.textContent), 'Connect and check');
  assert.equal(await shown(page, 'w1-ai-banner'), false, 'the button hides while the popup is open');
  assert.match(await page.$eval('#ai-w-msg', (e) => e.textContent), /did not accept your key/, 'it says what the check said last');
  await page.click('#ai-w-cancel');
  assert.equal(await page.$('#ai-setup-wizard'), null);
  assert.equal(await shown(page, 'w1-ai-banner'), true);
  assert.ok(conn.every((a) => a === 'check'));
});

test('the Engine screen has a Set up your AI button while the AI is not set up, and it reopens the same popup', { skip }, async () => {
  const { page } = await open('no_key');
  await page.evaluate(() => {
    document.getElementById('app').style.display = 'flex';
    document.getElementById('engine-tab-content').style.display = 'flex';
    engineState.conn = { connected: false, admin_connected: false, state: 'no_key' };
    engineState.rows = []; engineState.prices = {}; engineState.models = engineState.models || {};
    engineRender();
  });
  assert.equal(await shown(page, 'w1-ai-engine-btn'), true);
  assert.equal(await page.$eval('#w1-ai-engine-btn', (e) => e.textContent), 'Set up your AI');
  await page.click('#w1-ai-engine-btn');
  assert.equal(await shown(page, 'ai-setup-wizard'), true);
  await page.click('#ai-w-cancel');
  // a ready AI: no button in the Engine screen
  await page.evaluate(() => { engineState.conn = { connected: true, admin_connected: false, state: 'ready' }; engineRender(); });
  assert.equal(await page.$('#w1-ai-engine-btn'), null);
  assert.equal(await shown(page, 'w1-ai-banner'), false);
});

test('while the AI is not set up, things that need it show the red message "Set up your AI first" and call nothing', { skip }, async () => {
  const { page, hooks } = await open('no_key');
  await ensure(page); await page.click('#ai-w-cancel');
  await page.evaluate(() => { for (const id of ['reply-text', 'tm-input', 'bc-input', 'onboarding-chat-input']) { if (!document.getElementById(id)) document.body.insertAdjacentHTML('beforeend', '<input id="' + id + '" value="hello">'); } });
  const actions = [() => sendAhmadMessage(), () => sendTestModeMessage(), () => sendBusinessChatMessage(), () => sendOnboardingMessage(), () => startOnboardingChat()];
  for (const [i, fn] of actions.entries()) {
    await page.evaluate(() => { const t = document.getElementById('w1-ai-first'); if (t) t.style.display = 'none'; });
    await page.evaluate(fn);
    assert.equal(await page.$eval('#w1-ai-first-msg', (e) => e.textContent), 'Set up your AI first', 'action ' + i);
    assert.equal(await shown(page, 'w1-ai-first'), true);
    const c = await page.$eval('#w1-ai-first', (e) => getComputedStyle(e).backgroundColor.match(/\d+/g).map(Number));
    assert.ok(c[0] > c[1] + 60 && c[0] > c[2] + 60, 'the message is red: ' + c.join(','));
    assert.equal(await page.$eval('#w1-ai-first', (e) => e.getAttribute('role')), 'alert');
  }
  assert.deepEqual(hooks, [], 'no AI webhook was called');
  await page.click('#w1-ai-first-btn');
  assert.equal(await shown(page, 'ai-setup-wizard'), true, 'the message offers the same popup');
});

test('a seller with a working key (or a failed check) sees NO change: no popup, no button, no message, the same return value', { skip }, async () => {
  for (const [state, expected] of [['ready', true], ['error', true]]) {
    const { page, conn } = await open(state);
    assert.equal(await ensure(page), expected, state);
    assert.equal(await page.$('#ai-setup-wizard'), null);
    assert.equal(await shown(page, 'w1-ai-banner'), false);
    assert.equal(await page.$('#w1-ai-first'), null);
    assert.deepEqual(conn, ['check']);
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<textarea id="reply-text"></textarea>'); });
    await page.evaluate(() => sendAhmadMessage());
    assert.equal(await page.$('#w1-ai-first'), null, 'the AI chat is not guarded');
    await page.close();
  }
});

test('a new login may show the popup once more (with Cancel); a successful connection hides the button and the popup', { skip }, async () => {
  const { page, ctl } = await open('no_key');
  await ensure(page); await page.click('#ai-w-cancel');
  await page.evaluate(() => clearAllAuthStorage());   // the sign-out clears the "cancelled" flag
  await page.evaluate(() => { SELLER_CHAT_ID = 'web_s1'; });
  assert.equal(await ensure(page), false);
  assert.equal(await shown(page, 'ai-setup-wizard'), true);
  assert.equal(await shown(page, 'ai-w-cancel'), true);
  // the seller connects (the existing recheck finds the AI ready): the popup closes itself, the button and the guards go away
  ctl.state = 'ready';
  await page.click('#ai-w-recheck');
  await page.waitForFunction(() => !document.getElementById('ai-setup-wizard'));
  await page.waitForFunction(() => window.__ready === 1);
  assert.equal(await page.evaluate(() => W1_AI.state), 'ready');
  assert.equal(await shown(page, 'w1-ai-banner'), false);
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<textarea id="reply-text"></textarea>'); });
  await page.evaluate(() => sendAhmadMessage());
  assert.equal(await page.$('#w1-ai-first'), null);
});
