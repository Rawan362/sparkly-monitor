// Run with:  node --test tests/*.test.mjs
// The Business settings reads (assistant keys, sales settings, point-of-sale settings, the ad account id) and the other reads of seller_sales_config
// (currency, invoice details, reply delay, AI name, default language, delivery and pickup) go through the Seller Bot Settings door with the person's
// own login: the screen's own address is turned into a door "read" request (no owner filter, no seller id) and the answer has the shape the screen
// already got. The older direct read runs when the door is down or not available (503, 404, 502, 429, the connection fails, not understood, a
// contract mismatch such as bad_column or read_failed; then 30 seconds off) or when this device has no login; a refused login is not read the older
// way. The door and Supabase are faked by the test: nothing leaves the test; the token is a made-up word; no real settings.
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

test('this test file and the new block are ASCII; the door call sends no seller id and not the public key; the block reads nothing directly; the 11 reads use the helpers', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  const a = html.indexOf('w1-settings-reads:js:start'); const b = html.indexOf('w1-settings-reads:js:end');
  assert.ok(a > 0 && b > a);
  const block = html.slice(a, b);
  assert.ok(!/[^\x00-\x7f]/.test(block) && !/console\./.test(block));
  assert.ok(!/apikey/.test(block));
  const call = block.slice(block.indexOf('async function w1SrTry'), block.indexOf('// A drop-in for fetch'));
  assert.ok(!/seller/i.test(call.replace(/Seller Bot Settings|SELLER_BOT_SETTINGS_URL|seller-bot-settings|no_seller/g, '')) && !/SUPABASE_ANON_KEY/.test(call));
  assert.equal((html.match(/w1SrFetch\(SUPABASE_URL/g) || []).length, 8); assert.equal((html.match(/w1SrSb\('seller_sales_config/g) || []).length, 3);
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

const ROWS = { bot_settings: [{ key: 'broadcast_message', value: 'Hello' }], seller_sales_config: [{ ai_name: 'Ana', currency_label: 'USD', reply_delay_seconds: 60, default_language: 'English' }], pos_settings: [{ invoice_prefix: 'INV' }], seller_ad_config: [{ ad_account_id: 'act_1' }] };
async function open(ctl, token) {
  ctl = Object.assign({ door: (b) => ({ status: 200, json: { ok: true, table: b.table, count: 1, truncated: false, rows: ROWS[b.table] || [] } }) }, ctl || {});
  const door = []; const direct = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => d.accept());
  await page.route('**/*', (route) => {
    const u = route.request().url(); const m = route.request().method();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/seller-bot-settings$/.test(u)) { const b = JSON.parse(route.request().postData() || '{}'); door.push(b); if (b.action !== 'read') return json(503, {}); const a = ctl.door(b); return a === 'abort' ? route.abort() : (a.raw !== undefined ? route.fulfill({ status: a.status, contentType: 'text/html', headers: h, body: a.raw }) : json(a.status, a.json)); }
    if (/\/rest\/v1\/(bot_settings|seller_sales_config|pos_settings|seller_ad_config)\?/.test(u) && m === 'GET') { direct.push(u.replace(/^.*\/rest\/v1\//, '')); return json(200, []); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate((tk) => { SELLER_CHAT_ID = 'web_s1'; window.getValidAuthToken = async () => tk; const l = document.getElementById('login-overlay'); if (l) l.remove(); }, token === undefined ? 'made-up-token' : token);
  door.length = 0; direct.length = 0;
  return { page, door, direct, ctl };
}
const T = 'made-up-token';

test('the translator: columns, filters, order and limit; the owner filter is dropped; a single-row table asks for one row; what it does not understand is not translated', { skip }, async () => {
  const { page } = await open();
  const out = await page.evaluate(() => [
    w1SrParse('https://x/rest/v1/bot_settings?chat_id=eq.web_s1&select=key,value'),
    w1SrParse('https://x/rest/v1/seller_sales_config?chat_id=eq.web_s1&select=ai_name&limit=1'),
    w1SrParse('https://x/rest/v1/pos_settings?chat_id=eq.web_s1&select=*'),
    w1SrParse('https://x/rest/v1/bot_settings?chat_id=eq.web_s1&key=in.(a,b)&order=key.asc'),
    w1SrParse('https://x/rest/v1/seller_ad_config?chat_id=eq.web_s1&select=ad_account_id,token'),
    w1SrParse('https://x/rest/v1/seller_sales_config?chat_id=eq.web_s1&select=*,x(y)'),
    w1SrParse('https://x/rest/v1/orders?chat_id=eq.web_s1'),
    w1SrParse('https://x/rest/v1/bot_settings?chat_id=neq.web_s1')
  ]);
  assert.deepEqual(out[0], { action: 'read', table: 'bot_settings', filters: [], select: ['key', 'value'], limit: 200 });
  assert.deepEqual(out[1], { action: 'read', table: 'seller_sales_config', filters: [], select: ['ai_name'], limit: 1 });
  assert.deepEqual(out[2], { action: 'read', table: 'pos_settings', filters: [], limit: 5 });
  assert.deepEqual(out[3].filters, [{ column: 'key', op: 'in', value: ['a', 'b'] }]); assert.deepEqual(out[3].order, [{ column: 'key', dir: 'asc' }]);
  assert.deepEqual(out.slice(5), [null, null, null]);
  await page.close();
});

test('the settings screen asks the door four times (keys, sales settings, point-of-sale settings, the ad account id) with exact columns and no seller id; nothing is read directly', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => { bizLoadedFor = 'web_s1'; await loadBizSettings(); });
  assert.deepEqual(direct, []);
  assert.ok(door.every((b) => b.token === T && b.action === 'read' && !JSON.stringify(b).includes('web_s1') && !('chat_id' in b)));
  const sig = door.map((b) => b.table + ':' + (b.select || ['*']).join(','));
  for (const want of ['bot_settings:key,value', 'pos_settings:*', 'seller_ad_config:ad_account_id']) assert.ok(sig.includes(want), want + ' in ' + sig.join(' | '));
  assert.ok(sig.some((x) => x.startsWith('seller_sales_config:ai_name,alt_currency_operation,currency_label')));
  await page.close();
});

test('the other reads of the sales settings use the door: reply delay, the AI name, the default language, currency, invoice details; no direct read', { skip }, async () => {
  const { page, door, direct } = await open();
  await page.evaluate(async () => {
    window.setReplyDelayUi = () => {}; await loadReplyDelay(); await loadAiName();
    if (typeof ensureSellerCurrency === 'function') { try { await ensureSellerCurrency(); } catch (e) {} }
    if (typeof fetchInvoiceConfig === 'function') { try { await fetchInvoiceConfig(); } catch (e) {} }
  });
  assert.deepEqual(direct, []);
  const cols = door.map((b) => (b.select || []).join(','));
  assert.ok(cols.includes('reply_delay_seconds')); assert.ok(cols.includes('ai_name')); assert.ok(cols.includes('currency_label'));
  assert.ok(door.every((b) => b.table === 'seller_sales_config' && b.limit >= 1 && !('chat_id' in b)));
  await page.close();
});

test('the door is down or not available (503, 404, 502, 429, the connection fails, not understood, a contract mismatch, read_failed): the older reads run, and the door is left alone for 30 seconds', { skip }, async () => {
  const cases = [{ status: 503, json: {} }, { status: 404, json: {} }, { status: 502, json: {} }, { status: 429, json: {} }, 'abort', { status: 200, raw: '<html>', json: null }, { status: 200, json: { ok: false, error: 'not_available', message: 'x' } }, { status: 200, json: { ok: false, error: 'bad_column', message: 'x' } }, { status: 200, json: { ok: false, error: 'bad_table', message: 'x' } }, { status: 200, json: { ok: false, error: 'bad_input', message: 'x' } }, { status: 200, json: { ok: false, error: 'bad_action', message: 'x' } }, { status: 200, json: { ok: false, error: 'read_failed', message: 'x' } }];
  for (const down of cases) {
    const { page, door, direct } = await open({ door: () => down });
    await page.evaluate(async () => { bizLoadedFor = 'web_s1'; await loadBizSettings(); });
    assert.ok(door.length >= 1 && door.length <= 4, 'the four reads start together, so each may ask once before the first answer is known');
    assert.equal(direct.length, 4, 'all four older reads ran');
    assert.ok(direct.some((d) => /^bot_settings\?chat_id=eq\.web_s1&select=key,value/.test(d)));
    const asked = door.length;
    await page.evaluate(() => loadReplyDelay());
    assert.equal(door.length, asked, 'left alone for 30 seconds');
    await page.evaluate(() => { W1_SR.pausedUntil = Date.now() - 1; return loadReplyDelay(); });
    assert.equal(door.length, asked + 1, 'asked again after the pause');
    await page.close();
  }
});

test('a refused login is not read the older way; no login on this device runs the older reads', { skip }, async () => {
  const r = await open({ door: () => ({ status: 200, json: { ok: false, error: 'not_logged_in', message: 'x' } }) });
  const err = await r.page.evaluate(async () => { try { await w1SrTry('https://x/rest/v1/pos_settings?chat_id=eq.web_s1&select=*'); return 'no error'; } catch (e) { return e.message; } });
  assert.equal(err, 'Please sign out and sign in again, then try once more.'); assert.deepEqual(r.direct, []);
  await r.page.close();
  const n = await open({}, null);
  await n.page.evaluate(async () => { bizLoadedFor = 'web_s1'; await loadBizSettings(); });
  assert.equal(n.door.length, 0); assert.equal(n.direct.length, 4);
  await n.page.close();
});
