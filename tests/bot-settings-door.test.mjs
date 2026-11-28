// Run with:  node --test tests/*.test.mjs
// Business settings: the 14 assistant (bot) settings are saved through the Seller Bot Settings door instead of straight to the table.
// The door and the database are faked by the test: nothing leaves the test. If Playwright is not installed (it is installed in CI),
// the browser tests are skipped. The text scan always runs.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). The new block, the one hook line and this file are scanned. ----
test('the new bot settings code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-bot-settings-door:js:start');
  const end = html.indexOf('w1-bot-settings-door:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const hook = html.split('\n').filter((l) => l.includes('W1-FALLBACK-REMOVE') && l.includes('w1BotTry'));
  assert.equal(hook.length, 1);
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hook: hook.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is bumped and the older save path for the other settings is still in the file', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 66);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes("fetch(SUPABASE_URL + '/rest/v1/bot_settings?on_conflict=chat_id,key', {"));
  assert.ok(html.includes("body: JSON.stringify({ chat_id: SELLER_CHAT_ID, key: key, value: value })"));
});

// ---- Browser tests ----
const SETTINGS = [
  { key: 'global_ai_active', group: 'ai', kind: 'bool', value: null, effective: 'true' },
  { key: 'broadcast_message', group: 'broadcast', kind: 'text', value: 'Old text', effective: 'Old text', maxLength: 1000 },
  { key: 'broadcast_interval', group: 'broadcast', kind: 'int', value: '30', effective: '30', min: 1, max: 365 },
  { key: 'followup1_hours', group: 'followup', kind: 'int', value: null, effective: '6', min: 1, max: 720 },
  { key: 'target_audience', group: 'broadcast', kind: 'enum', value: 'both', effective: 'both', values: ['both', 'wholesale', 'retail'] }
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

// `answer(body)` can override a door answer. `direct` collects writes that go straight to bot_settings.
async function openBusiness(answer, calls, direct, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-bot-settings$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      let a = answer && answer(body);
      if (!a) {
        if (body.action === 'get') a = { json: { ok: true, action: 'get', settings: SETTINGS } };
        else if (body.action === 'set') a = { json: { ok: true, action: 'set', changed: true, key: body.key, before: '30', after: String(body.value) } };
        else a = { status: 503, json: {} };   // the newer actions (setBotKey, setSalesConfig, ...) are not available in these tests: the older direct save runs, as these tests prove
      }
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
    if (/\/rest\/v1\/bot_settings/.test(u) && route.request().method() === 'POST') {
      direct.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ status: 201, headers: h, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate((tok) => {
        SELLER_CHAT_ID = 'seller-test';
        bizLoadedFor = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => tok;
        window.__alerts = [];
        window.alert = (m) => { window.__alerts.push(String(m)); };
        document.getElementById('business-tab-content').style.display = 'flex';
      }, token === undefined ? 'test-token' : token);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const setsOf = (calls) => calls.filter((c) => c.action === 'set');
const typeInto = (page, id, value) => page.evaluate(([i, v]) => { const el = document.getElementById(i); el.value = v; return saveBizField(el); }, [id, value]);

test('turning a switch on or off sends set to the door (token, key and the word true or false) and writes nothing to the table', { skip }, async () => {
  const calls = []; const direct = [];
  const { page, errors } = await openBusiness(null, calls, direct);
  await page.click('#biz-toggle-global_ai_active');
  await page.waitForFunction(() => document.getElementById('biz-toggle-global_ai_active').classList.contains('on'));
  assert.deepEqual(setsOf(calls), [{ token: 'test-token', action: 'set', key: 'global_ai_active', value: 'true' }]);
  assert.equal(direct.length, 0);
  assert.ok(calls.every((c) => !('sellerId' in c) && !('chat_id' in c)));
  assert.deepEqual(errors, []);
});

test('a text field and a number field are saved through the door as text', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openBusiness(null, calls, direct);
  await typeInto(page, 'biz-broadcast-message', 'Hello customers');
  await typeInto(page, 'biz-broadcast-interval', '45');
  assert.deepEqual(setsOf(calls).map((c) => [c.key, c.value]), [['broadcast_message', 'Hello customers'], ['broadcast_interval', '45']]);
  assert.equal(direct.length, 0);
  assert.deepEqual(await page.evaluate(() => window.__alerts), []);
});

test('all 14 assistant keys go to the door; any other bot setting still saves the way it did', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openBusiness(null, calls, direct);
  const keys = ['global_ai_active', 'global_pause_message', 'followup_active', 'followup1_hours', 'followup2_hours', 'followup3_hours', 'followup1_message', 'followup2_message', 'followup3_message', 'broadcast_active', 'broadcast_interval', 'broadcast_message', 'target_audience', 'winback_active'];
  for (const k of keys) await page.evaluate((key) => saveBotSetting(key, key === 'target_audience' ? 'retail' : '7'), k);
  assert.deepEqual(setsOf(calls).map((c) => c.key), keys);
  assert.equal(direct.length, 0);
  await page.evaluate(() => saveBotSetting('referral_reward', 'a gift'));
  assert.deepEqual(direct, [{ chat_id: 'seller-test', key: 'referral_reward', value: 'a gift' }]);
  assert.equal(setsOf(calls).length, keys.length, 'the other setting did not go to the door');
});

test('a value the door refuses is shown in the door words and the field goes back to the saved value', { skip }, async () => {
  const calls = []; const direct = [];
  const refuse = (b) => b.action === 'set' ? { json: { ok: false, error: 'bad_value', message: 'That value is not allowed.' } } : null;
  const { page } = await openBusiness(refuse, calls, direct);
  await typeInto(page, 'biz-broadcast-interval', '9999');
  assert.deepEqual(await page.evaluate(() => window.__alerts), ['Could not save: That value is not allowed.']);
  assert.equal(await page.$eval('#biz-broadcast-interval', (e) => e.value), '30');
  assert.equal(direct.length, 0);
});

test('a refused switch stays where it was', { skip }, async () => {
  const refuse = (b) => b.action === 'set' ? { json: { ok: false, error: 'save_failed', message: 'We could not save the change. Nothing was changed.' } } : null;
  const { page } = await openBusiness(refuse, [], []);
  await page.click('#biz-toggle-global_ai_active');
  await page.waitForFunction(() => window.__alerts.length === 1);
  assert.equal(await page.$eval('#biz-toggle-global_ai_active', (e) => e.classList.contains('on')), false);
  assert.deepEqual(await page.evaluate(() => window.__alerts), ['Could not save: We could not save the change. Nothing was changed.']);
});

test('a refusal of the login by the door is told in plain words and nothing is written to the table; no login on this device runs the older write (a device linked the older way)', { skip }, async () => {
  const cases = [
    [() => ({ json: { ok: false, error: 'not_logged_in', message: 'Please log in again.' } }), 'test-token', 'Could not save: Please sign out and sign in again, then try once more.']
  ];
  for (const [answer, token, expected] of cases) {
    const direct = [];
    const { page } = await openBusiness(answer, [], direct, token);
    await typeInto(page, 'biz-broadcast-message', 'x');
    assert.deepEqual(await page.evaluate(() => window.__alerts), [expected]);
    assert.equal(direct.length, 0);
    await page.close();
  }
  const calls = []; const direct = [];
  const none = await openBusiness(null, calls, direct, null);
  await typeInto(none.page, 'biz-broadcast-message', 'x');
  assert.deepEqual(await none.page.evaluate(() => window.__alerts), []);
  assert.equal(calls.length, 0);
  assert.equal(direct.length, 1, 'the older direct write ran');
});

test('after a change an Undo button appears; it sends the old value back through the door and puts it on the field', { skip }, async () => {
  const calls = [];
  const { page } = await openBusiness(null, calls, []);
  await typeInto(page, 'biz-broadcast-interval', '45');
  await page.waitForSelector('#w1-bot-undo', { state: 'visible' });
  assert.equal(await page.$eval('#w1-bot-undo-btn', (e) => e.textContent), 'Undo last change');
  await page.click('#w1-bot-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-bot-undo-msg').textContent === 'The change was undone.');
  assert.deepEqual(setsOf(calls).map((c) => [c.key, c.value]), [['broadcast_interval', '45'], ['broadcast_interval', '30']]);
  assert.equal(await page.$eval('#biz-broadcast-interval', (e) => e.value), '30');
  assert.equal(await page.$eval('#w1-bot-undo-btn', (e) => e.style.display), 'none', 'a second undo is not offered');
});

test('when the setting had never been saved, Undo sends the default the door reported', { skip }, async () => {
  const calls = [];
  const reply = (b) => b.action === 'set' ? { json: { ok: true, action: 'set', changed: true, key: b.key, before: null, after: String(b.value) } } : null;
  const { page } = await openBusiness(reply, calls, []);
  await page.evaluate(() => saveBotSetting('followup1_hours', '12'));
  await page.waitForSelector('#w1-bot-undo', { state: 'visible' });
  await page.click('#w1-bot-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-bot-undo-msg').textContent === 'The change was undone.');
  assert.deepEqual(setsOf(calls).map((c) => c.value).slice(-2), ['12', '6']);
});

test('no Undo is offered when the door says nothing changed, and the offer goes away by itself', { skip }, async () => {
  const same = (b) => b.action === 'set' ? { json: { ok: true, action: 'set', changed: false, key: b.key, before: '30', after: '30' } } : null;
  const a = await openBusiness(same, [], []);
  await typeInto(a.page, 'biz-broadcast-interval', '30');
  assert.equal(await a.page.$('#w1-bot-undo'), null);
  const b = await openBusiness(null, [], []);
  await typeInto(b.page, 'biz-broadcast-interval', '45');
  await b.page.waitForSelector('#w1-bot-undo', { state: 'visible' });
  await b.page.evaluate(() => { clearTimeout(W1_BOT.timer); w1BotHideUndo(); });
  assert.equal(await b.page.$eval('#w1-bot-undo', (e) => e.style.display), 'none');
});

test('the limits from the door are put on the fields when the seller first uses one, and the screen text is unchanged', { skip }, async () => {
  const calls = [];
  const { page } = await openBusiness(null, calls, []);
  const before = await page.$eval('#business-tab-content', (e) => e.textContent);
  await page.focus('#biz-broadcast-interval');
  await page.waitForFunction(() => document.getElementById('biz-broadcast-interval').max === '365');
  assert.equal(await page.$eval('#biz-broadcast-interval', (e) => e.min), '1');
  await page.focus('#biz-broadcast-message');
  await page.waitForFunction(() => document.getElementById('biz-broadcast-message').maxLength === 1000);
  assert.equal(calls.filter((c) => c.action === 'get').length, 1, 'the door is asked once');
  assert.equal(await page.$eval('#business-tab-content', (e) => e.textContent), before);
});

test('only get, read and set are ever sent (the reading of the settings asks the door first), and the older reading stays as the fallback', { skip }, async () => {
  const calls = [];
  const { page } = await openBusiness(null, calls, []);
  await page.click('#biz-toggle-winback_active');
  await page.waitForFunction(() => document.getElementById('biz-toggle-winback_active').classList.contains('on'));
  assert.ok(calls.every((c) => ['get', 'read', 'set'].includes(c.action)));
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes("w1SrFetch(SUPABASE_URL + '/rest/v1/bot_settings?chat_id=eq.' + encodeURIComponent(SELLER_CHAT_ID) + '&select=key,value', {"));
});

// ---- Fallback: a seller who is not on the door's list gets not_available; the older direct write runs exactly as before. ----
const NOT_AVAILABLE = (b) => ({ json: { ok: false, error: 'not_available', code: 'not_available', message: 'raw' } });

test('fallback: when the door answers not_available the value is saved the older way (one direct write, same body), no error is shown and the typed value stays', { skip }, async () => {
  const calls = []; const direct = [];
  const { page, errors } = await openBusiness(NOT_AVAILABLE, calls, direct);
  await typeInto(page, 'biz-broadcast-message', 'Hello there');
  await page.waitForTimeout(300);
  assert.deepEqual(direct, [{ chat_id: 'seller-test', key: 'broadcast_message', value: 'Hello there' }]);
  assert.equal(await page.$eval('#biz-broadcast-message', (e) => e.value), 'Hello there');
  assert.equal(await page.$('#w1-bot-undo'), null);
  assert.deepEqual(await page.evaluate(() => window.__alerts), []);
  assert.deepEqual(errors, []);
});

test('fallback: an HTTP 503 from the door does the same, and once not_available is known the door is not asked again in this visit', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openBusiness(() => ({ status: 503, json: {} }), calls, direct);
  await typeInto(page, 'biz-broadcast-message', 'One');
  await page.waitForTimeout(300);
  const after1 = calls.length;
  await typeInto(page, 'biz-broadcast-message', 'Two');
  await page.waitForTimeout(300);
  assert.deepEqual(direct.map((d) => d.value), ['One', 'Two']);
  assert.equal(calls.length, after1, 'no further door calls');
});

test('fallback: a switch is saved the older way too (the switch moves after the direct write)', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openBusiness(NOT_AVAILABLE, calls, direct);
  await page.click('#biz-toggle-global_ai_active');
  await page.waitForTimeout(400);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].key, 'global_ai_active');
});

test('fallback: other door refusals (a value outside the limits) are NOT sent the old way', { skip }, async () => {
  const calls = []; const direct = [];
  const { page } = await openBusiness((b) => b.action === 'set' ? { json: { ok: false, error: 'out_of_range', message: 'Must be at most 365.' } } : null, calls, direct);
  await typeInto(page, 'biz-broadcast-interval', '999');
  await page.waitForTimeout(400);
  assert.equal(direct.length, 0);
});
