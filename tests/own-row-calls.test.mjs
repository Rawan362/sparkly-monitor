// Run with:  node --test tests/*.test.mjs
// The seller's own row (business name, WhatsApp connected, onboarding done) is asked from the Seller Own Row door with the person's login,
// not read from the sellers table with the public key. The door and the database are faked by the test: nothing leaves the test.
// If Playwright is not installed (it is installed in CI), the browser tests are skipped. The text scan always runs.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). The new block, the changed lines and this file are scanned. ----
test('the new own-row code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-own-row-calls:js:start');
  const end = html.indexOf('w1-own-row-calls:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const outside = html.slice(0, start) + html.slice(end);
  const hooks = outside.split('\n').filter((l) => /w1MeGet\(|w1OwnRowAsk\(|AUTH_GUARD_OWN_ROW_URL|w1BnOfferUndo\(|w1MeForget\(|undoBusinessName|a door could/.test(l));
  assert.ok(hooks.length >= 8, 'the changed lines in the six functions and the login guard');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hooks: hooks.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the functions that read the seller row no longer touch the sellers table, and the cache name is bumped', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const body = (name) => {
    const i = html.search(new RegExp('(async function ' + name + '\\b|window\\.' + name + ' = async function)'));
    assert.ok(i > 0, name);
    return html.slice(i, i + 3500);
  };
  for (const name of ['fetchDeliveryContext', 'checkWhatsAppConnectedThenOnboarding', 'checkOnboardingNeeded', 'bnLoad', 'bnSave', 'expectedAuthUserId']) {
    const text = body(name).split(/\nasync function |\nfunction |\nwindow\.[A-Za-z]+ = /)[0];
    assert.equal(/rest\/v1\/sellers|sb\('sellers\?/.test(text), false, name + ' still reads or writes the sellers table');
  }
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 66);
});

// ---- Browser tests ----
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

const ME = (o) => Object.assign({ ok: true, hasSeller: true, chatId: 'seller-test', businessName: 'Corner Shop Ltd', businessNameLocation: 'Corner Shop, 12 Example Street', businessNameShort: 'Corner Shop', onboardingDone: true, whatsappConnected: true, phoneNumberId: 'pnid-1' }, o || {});

// `door(body)` answers the own-row door. `direct` collects every call to the sellers table; `statusUrls` collects message_status reads.
async function openApp(door, calls, direct, statusUrls) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-own-row$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = door(body);
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
    }
    if (/\/rest\/v1\/sellers/.test(u)) { direct.push(route.request().method()); return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' }); }
    if (/\/rest\/v1\/message_status/.test(u)) { statusUrls.push(u); return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' }); }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: '[]' });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(() => {
        SELLER_CHAT_ID = 'seller-test';
        bizLoadedFor = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'login-jwt';
        window.ensureAiReady = async () => false;
        window._sellerPnid = '';
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const doorMe = (o) => (b) => b.action === 'me' ? { json: ME(o) } : { json: { ok: false, error: 'bad_action', message: 'x' } };
const asked = (calls, a) => calls.filter((c) => c.action === a);

test('the start-up checks share one me call: only { token, action: me } is sent, never a seller id, and the sellers table is not touched', { skip }, async () => {
  const calls = []; const direct = [];
  const { page, errors } = await openApp(doorMe(), calls, direct, []);
  await page.evaluate(() => Promise.all([checkOnboardingNeeded(), checkWhatsAppConnectedThenOnboarding(), fetchDeliveryContext('+10000000000')]));
  assert.deepEqual(calls, [{ token: 'login-jwt', action: 'me' }]);
  assert.equal(direct.length, 0);
  assert.deepEqual(errors, []);
});

test('onboarding: shown only when the door says the profile has no business details yet; a door problem shows nothing, as before', { skip }, async () => {
  const shown = (page) => page.$eval('#onboarding-overlay', (e) => e.style.display);
  const need = await openApp(doorMe({ onboardingDone: false }), [], [], []);
  await need.page.evaluate(() => checkOnboardingNeeded());
  assert.equal(await shown(need.page), 'flex');
  const noSeller = await openApp(doorMe({ hasSeller: false }), [], [], []);
  await noSeller.page.evaluate(() => checkOnboardingNeeded());
  assert.equal(await shown(noSeller.page), 'flex');
  const done = await openApp(doorMe(), [], [], []);
  await done.page.evaluate(() => checkOnboardingNeeded());
  assert.notEqual(await shown(done.page), 'flex');
  const down = await openApp(() => ({ status: 503, json: {} }), [], [], []);
  await down.page.evaluate(() => checkOnboardingNeeded());
  assert.notEqual(await shown(down.page), 'flex');
});

test('the WhatsApp connect screen: shown when the door says no number is connected; not shown when connected or when the door cannot answer', { skip }, async () => {
  const gate = (page) => page.$eval('#whatsapp-connect-gate', (e) => e.style.display);
  const off = await openApp(doorMe({ whatsappConnected: false }), [], [], []);
  await off.page.evaluate(() => checkWhatsAppConnectedThenOnboarding());
  assert.equal(await gate(off.page), 'flex');
  const on = await openApp(doorMe(), [], [], []);
  await on.page.evaluate(() => { checkWhatsAppConnectedThenOnboarding(); });
  await on.page.waitForTimeout(300);
  assert.notEqual(await gate(on.page), 'flex');
  const down = await openApp(() => ({ status: 503, json: {} }), [], [], []);
  await down.page.evaluate(() => { checkWhatsAppConnectedThenOnboarding(); });
  await down.page.waitForTimeout(300);
  assert.notEqual(await gate(down.page), 'flex', 'a door problem never shows the connect screen by mistake');
});

test('delivery marks: the phone number id from the door is the filter of the receipt read; without one nothing is read', { skip }, async () => {
  const urls = [];
  const a = await openApp(doorMe(), [], [], urls);
  const ctx = await a.page.evaluate(() => fetchDeliveryContext('+10000000000').then((c) => c !== null));
  assert.equal(ctx, true);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /business_phone_number_id=eq\.pnid-1/);
  assert.match(urls[0], /phone_number=eq\.%2B10000000000/);
  const none = [];
  const b = await openApp(doorMe({ phoneNumberId: '' }), [], [], none);
  assert.equal(await b.page.evaluate(() => fetchDeliveryContext('+10000000000')), null);
  assert.equal(none.length, 0);
});

test('the business name field shows the short name from the door', { skip }, async () => {
  const a = await openApp(doorMe(), [], [], []);
  await a.page.evaluate(() => { document.getElementById('business-tab-content').style.display = 'flex'; return bnLoad(); });
  await a.page.waitForFunction(() => document.getElementById('bn-input').value === 'Corner Shop');
  const b = await openApp(doorMe({ hasSeller: false }), [], [], []);
  await b.page.evaluate(() => { document.getElementById('bn-input').value = 'stale'; return bnLoad(); });
  assert.equal(await b.page.$eval('#bn-input', (e) => e.value), '');
});

test('the settings heading shows the business name from the door', { skip }, async () => {
  const { page, errors } = await openApp(doorMe(), [], [], []);
  await page.evaluate(() => { document.getElementById('business-tab-content').style.display = 'flex'; return loadBizSettings(); });
  await page.waitForFunction(() => /These settings are for: Corner Shop Ltd/.test(document.getElementById('biz-account-label').textContent));
  assert.deepEqual(errors, []);
});

test('saving the business name sends setBusinessName with the name only; the door keeps the part after the comma; an Undo puts the old text back', { skip }, async () => {
  const calls = []; const direct = [];
  const door = (b) => {
    if (b.action === 'setBusinessName') return { json: { ok: true, message: 'The business name was saved.', undo: { restoreTo: 'Corner Shop, 12 Example Street', ifCurrentIs: 'Daily Market, 12 Example Street' } } };
    if (b.action === 'undoBusinessName') return { json: { ok: true, message: 'The business name was put back.', restored: true } };
    return doorMe()(b);
  };
  const { page } = await openApp(door, calls, direct, []);
  await page.evaluate(() => { document.getElementById('business-tab-content').style.display = 'flex'; });
  await page.fill('#bn-input', '  Daily Market ');
  await page.click('#bn-save');
  await page.waitForFunction(() => document.getElementById('bn-msg').textContent.startsWith('Saved.'));
  assert.deepEqual(asked(calls, 'setBusinessName'), [{ token: 'login-jwt', action: 'setBusinessName', name: 'Daily Market' }]);
  assert.equal(await page.$eval('#bn-msg', (e) => e.textContent), 'Saved. Your business name is now "Daily Market".');
  assert.equal(await page.$eval('#w1-bn-undo', (e) => e.textContent), 'Undo');
  await page.click('#w1-bn-undo');
  await page.waitForFunction(() => document.getElementById('bn-msg').textContent === 'The business name was put back.');
  assert.deepEqual(asked(calls, 'undoBusinessName'), [{ token: 'login-jwt', action: 'undoBusinessName', restoreTo: 'Corner Shop, 12 Example Street', ifCurrentIs: 'Daily Market, 12 Example Street' }]);
  assert.equal(await page.$eval('#bn-input', (e) => e.value), 'Corner Shop');
  assert.equal(await page.$('#w1-bn-undo'), null, 'a second undo is not offered');
  assert.equal(direct.length, 0);
});

test('refusals of the save are shown in the door words with no Undo: changed in the meantime, door off, not logged in', { skip }, async () => {
  const cases = [
    [() => ({ json: { ok: false, error: 'changed', message: 'Your business name was changed in the meantime. Nothing was changed. Reload and try again.' } }), 'Your business name was changed in the meantime. Nothing was changed. Reload and try again.'],
    [() => ({ status: 503, json: {} }), 'This is not available right now. Please try again later.'],
    [() => ({ json: { ok: false, error: 'not_logged_in', message: 'Please log in again.' } }), 'Please sign out and sign in again, then try once more.']
  ];
  for (const [answer, expected] of cases) {
    const { page } = await openApp(answer, [], [], []);
    await page.evaluate(() => { document.getElementById('business-tab-content').style.display = 'flex'; });
    await page.fill('#bn-input', 'Daily Market');
    await page.click('#bn-save');
    await page.waitForFunction((t) => document.getElementById('bn-msg').textContent === t, expected);
    assert.equal(await page.$('#w1-bn-undo'), null);
    await page.close();
  }
});

test('an Undo that the door refuses (the name changed since) says so and goes away', { skip }, async () => {
  const door = (b) => {
    if (b.action === 'setBusinessName') return { json: { ok: true, message: 'x', undo: { restoreTo: 'Old, street', ifCurrentIs: 'New, street' } } };
    if (b.action === 'undoBusinessName') return { json: { ok: false, error: 'changed', message: 'Your business name was changed in the meantime. Nothing was changed. Reload and try again.' } };
    return doorMe()(b);
  };
  const { page } = await openApp(door, [], [], []);
  await page.evaluate(() => { document.getElementById('business-tab-content').style.display = 'flex'; });
  await page.fill('#bn-input', 'New');
  await page.click('#bn-save');
  await page.waitForSelector('#w1-bn-undo');
  await page.click('#w1-bn-undo');
  await page.waitForFunction(() => /changed in the meantime/.test(document.getElementById('bn-msg').textContent));
  assert.equal(await page.$('#w1-bn-undo'), null);
});

test('the older rules of the field are unchanged: an empty name, a comma and a long name are refused on the screen before the door is asked', { skip }, async () => {
  const calls = [];
  const { page } = await openApp(doorMe(), calls, [], []);
  await page.evaluate(() => { document.getElementById('business-tab-content').style.display = 'flex'; });
  for (const [value, expected] of [['', 'Please type your business name. It cannot be empty.'], ['A, B', 'The business name cannot contain a comma.'], ['x'.repeat(41), 'The business name is too long. Please use 40 characters or fewer.']]) {
    await page.fill('#bn-input', value);
    await page.click('#bn-save');
    assert.match(await page.$eval('#bn-msg', (e) => e.textContent), new RegExp('^' + expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(asked(calls, 'setBusinessName').length, 0);
});
