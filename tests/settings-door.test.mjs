// Run with:  node --test tests/*.test.mjs
// Business settings writes (currency, reply delay, invoice logo and the other seller_sales_config columns, the point-of-sale settings, and the
// winback, offer and referral keys of bot_settings) go through the Seller Bot Settings door with the person's own login: setSalesConfig, setPosSetting,
// setBotKey and clearReferral, with an Undo button; when the door answers "not available" every control keeps its older direct write exactly as
// before. The door and Supabase are faked by the test: nothing leaves the test; the token is a made-up word; no real settings data.
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

test('this test file and the new block are ASCII; the door call sends no seller id and not the public key; the block writes nothing directly', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-settings-door:js:start'); const b = html.indexOf('w1-settings-door:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block) && !/\/rest\/v1\//.test(block));
  const call = block.slice(block.indexOf('async function w1BsCall'), block.indexOf('// Door first: the answer'));
  assert.ok(!/seller/i.test(call.replace(/Seller Bot Settings|SELLER_BOT_SETTINGS_URL|seller-bot-settings/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
  // the 14 keys keep their own door code
  assert.ok(html.includes("if (w1BotHandles(key) && await w1BotTry(key, value)) return;"));
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

async function open(ctl) {
  ctl = Object.assign({ door: () => ({ status: 200, json: { ok: true, changed: true, undoId: 'u1' } }) }, ctl || {});
  const door = []; const direct = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-bot-settings$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); const a = ctl.door(b); return json(a.status, a.json); }
    if (/\/rest\/v1\/(seller_sales_config|pos_settings|bot_settings)/.test(u) && m !== 'GET') { direct.push({ method: m, url: u.replace(/^.*\/rest\/v1\//, ''), body: route.request().postData() || '' }); return route.fulfill({ status: 201, headers: h, body: '' }); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => 'made-up-token';
    window.__lb = 0; window.loadBizSettings = async () => { window.__lb++; };
    const l = document.getElementById('login-overlay'); if (l) l.remove();
  });
  return { page, door, direct, alerts, ctl };
}
const T = 'made-up-token';
const field = (page, o) => page.evaluate((x) => { const e = document.createElement(x.tag || 'input'); e.id = 'tmp-' + x.key; e.dataset.key = x.key; if (x.table) e.dataset.table = x.table; if (x.numeric) e.dataset.numeric = 'true'; e.value = x.value; document.body.appendChild(e); return saveBizField(e); }, o);
const note = (page) => page.evaluate(() => { const b = document.getElementById('w1-bs-note'); return b && b.style.display !== 'none' ? { text: document.getElementById('w1-bs-note-msg').textContent, undo: document.getElementById('w1-bs-undo-btn').style.display !== 'none' } : null; });

test('sales settings: a text box, a numeric box and the currency switch send one column each through setSalesConfig; no direct write; an Undo button follows', { skip }, async () => {
  const { page, door, direct } = await open();
  await field(page, { key: 'invoice_phone', table: 'seller_sales_config', value: '+1 555 0100' });
  await field(page, { key: 'alt_currency_rate', table: 'seller_sales_config', numeric: true, value: '1,450.5' });
  await field(page, { key: 'shipping_free_over_qty', table: 'seller_sales_config', numeric: true, value: '' });
  await page.evaluate(async () => { const b = document.getElementById('biz-alt-currency-operation'); b.classList.remove('on'); await toggleCurrencyOperation(b); });
  assert.deepEqual(door.map((b) => [b.action, b.column, b.value]), [['setSalesConfig', 'invoice_phone', '+1 555 0100'], ['setSalesConfig', 'alt_currency_rate', 1450.5], ['setSalesConfig', 'shipping_free_over_qty', null], ['setSalesConfig', 'alt_currency_operation', 'divide']]);
  assert.ok(door.every((b) => b.token === T && !('seller_id' in b) && !('chat_id' in b)));
  assert.deepEqual(direct, []);
  assert.deepEqual(await note(page), { text: 'Setting saved.', undo: true });
  await page.click('#w1-bs-undo-btn');
  await page.waitForFunction(() => document.getElementById('w1-bs-note-msg').textContent === 'The change was undone.');
  assert.deepEqual(door[4], { token: T, action: 'undo', undoId: 'u1' });
  assert.ok(await page.evaluate(() => window.__lb) >= 1, 'the screen reloads its values after an undo');
  await page.close();
});

test('reply delay and invoice logo: setSalesConfig with the number of seconds, the logo address, and null to remove it', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { await saveReplyDelaySeconds(120); await saveInvoiceLogoUrl('https://example.com/storage/chat-media/web_s1/invoice-logo/1.png'); await saveInvoiceLogoUrl(null); });
  assert.deepEqual(door.map((b) => [b.action, b.column, b.value]), [['setSalesConfig', 'reply_delay_seconds', 120], ['setSalesConfig', 'invoice_logo_url', 'https://example.com/storage/chat-media/web_s1/invoice-logo/1.png'], ['setSalesConfig', 'invoice_logo_url', null]]);
  assert.deepEqual(direct, []);
  await page.close();
});

test('point-of-sale settings: switches and the number and prefix go through setPosSetting', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { const b = document.getElementById('biz-toggle-pos_inventory'); b.classList.remove('on'); await toggleBizSetting(b); });
  await field(page, { key: 'low_stock_default_threshold', table: 'pos_settings', numeric: true, value: '5' });
  await field(page, { key: 'invoice_prefix', table: 'pos_settings', value: 'INV' });
  assert.deepEqual(door.map((b) => [b.action, b.column, b.value]), [['setPosSetting', 'inventory_tracking_active', true], ['setPosSetting', 'low_stock_default_threshold', 5], ['setPosSetting', 'invoice_prefix', 'INV']]);
  assert.ok(!JSON.stringify(door).includes('next_invoice_number') && !JSON.stringify(door).includes('confirmation_mode'));
  assert.deepEqual(direct, []);
  await page.close();
});

test('the other assistant keys (winback, offers, referral): setBotKey with the key and the text value; the 14 door keys still use their own door code', { skip }, async () => {
  const { page, door, direct } = await open();
  await field(page, { key: 'winback_days1', value: '30' });
  await field(page, { key: 'bump_product', value: 'Case' });
  await page.evaluate(async () => { const b = document.getElementById('biz-toggle-bump'); if (b) { b.classList.remove('on'); await toggleBizSetting(b); } });
  assert.deepEqual(door.slice(0, 2).map((b) => [b.action, b.key, b.value]), [['setBotKey', 'winback_days1', '30'], ['setBotKey', 'bump_product', 'Case']]);
  if (door.length > 2) assert.deepEqual([door[2].action, door[2].key, door[2].value], ['setBotKey', 'bump_active', 'true']);
  assert.deepEqual(direct, []);
  const own = await open();
  await field(own.page, { key: 'followup_active', value: 'true' });
  assert.ok(own.door.every((b) => b.action !== 'setBotKey'), 'a key of the 14 never goes to setBotKey');
  await page.close(); await own.page.close();
});

test('the referral switch turned off is one clearReferral call; the boxes empty as before', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { document.getElementById('biz-referral-reward').value = 'x'; const b = document.getElementById('biz-toggle-referral'); b.classList.add('on'); await toggleReferralActive(b); });
  assert.deepEqual(door, [{ token: T, action: 'clearReferral' }]);
  assert.equal(await page.evaluate(() => document.getElementById('biz-referral-reward').value), '');
  assert.deepEqual(direct, []);
  await page.close();
});

test('a refusal shows the door words in the screen\'s own message and never falls back to the direct write', { skip }, async () => {
  const { page, direct, alerts } = await open({ door: () => ({ status: 200, json: { ok: false, error: 'bad_value', message: 'The reply delay must be between 10 and 3600 seconds.' } }) });
  await page.evaluate(() => saveReplyDelaySeconds(5));
  assert.ok(alerts.some((a) => a.endsWith('The reply delay must be between 10 and 3600 seconds.')));
  assert.deepEqual(direct, []);
  await page.close();
});

test('the door is not available: every control keeps the older direct write exactly as before, and the door is asked once', { skip }, async () => {
  const { page, door, direct } = await open({ door: () => ({ status: 503, json: { ok: false, code: 'not_ready' } }) });
  await field(page, { key: 'invoice_phone', table: 'seller_sales_config', value: '5' });
  await field(page, { key: 'invoice_prefix', table: 'pos_settings', value: 'INV' });
  await field(page, { key: 'winback_days1', value: '30' });
  await page.evaluate(async () => { await saveReplyDelaySeconds(60); document.getElementById('biz-referral-reward').value = 'x'; const b = document.getElementById('biz-toggle-referral'); b.classList.add('on'); await toggleReferralActive(b); });
  assert.equal(door.length, 1, 'asked once, then remembered');
  assert.deepEqual(direct.map((d) => d.method + ' ' + d.url.split('?')[0]), ['POST seller_sales_config', 'POST pos_settings', 'POST bot_settings', 'POST seller_sales_config', 'POST bot_settings', 'POST bot_settings']);
  assert.match(direct[0].body, /"invoice_phone":"5"/); assert.match(direct[2].body, /"key":"winback_days1","value":"30"/); assert.match(direct[3].body, /"reply_delay_seconds":60/);
  assert.match(direct[4].body, /"key":"referral_reward","value":""/);
  await page.close();
});

test('login problems: no login on this device means no door call and the older write runs; a refusal by the door shows the screen\'s failure message', { skip }, async () => {
  const { page, door, direct, alerts } = await open();
  await page.evaluate(() => { window.getValidAuthToken = async () => null; });
  await field(page, { key: 'invoice_phone', table: 'seller_sales_config', value: '5' });
  assert.equal(door.length, 0); assert.equal(direct.length, 1, 'the older direct write ran'); assert.deepEqual(alerts, []);
  await page.close();
  const b = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  await field(b.page, { key: 'invoice_phone', table: 'seller_sales_config', value: '5' });
  assert.deepEqual(b.direct, []); assert.ok(b.alerts.some((a) => a.endsWith('Please sign out and sign in again, then try once more.')));
  await b.page.close();
});
