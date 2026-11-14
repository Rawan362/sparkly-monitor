// Run with:  node --test tests/*.test.mjs
// Delete my business screen (build chat W1, screen 3). The delete door is answered by the test: nothing leaves the test and nothing is deleted.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). Old code is not scanned. ----
function marked(html, kind) {
  const start = html.indexOf('w1-delete-screen:' + kind + ':start');
  const end = html.indexOf('w1-delete-screen:' + kind + ':end');
  assert.ok(start > 0 && end > start, 'marked block missing: ' + kind);
  return html.slice(start, end);
}
test('the new Delete screen code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const k of ['css', 'html', 'row', 'js']) files['block ' + k] = marked(html, k);
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is at least v68, the Danger zone row is new, and the old rows are untouched', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 68);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('<div class="settings-row danger" onclick="confirmDeleteAccount()">'));
  assert.ok(html.includes('<span id="settings-label-delete">Delete my account</span>'));
  assert.ok(html.includes('onclick="openDeleteScreen()"'));
  assert.ok(html.includes('<div class="settings-row" onclick="openReportsPanel()">'));
});

// ---- Browser tests ----
const FUTURE = (ms) => new Date(Date.now() + ms).toISOString();
const TABLES = (o) => [
  Object.assign({ table: 'orders', exported: 5, deleted: null, restored: null }, o && o.orders),
  Object.assign({ table: 'telegram_extra', exported: 2, deleted: null, restored: null }, o && o.extra),
  Object.assign({ table: 'sellers', exported: 1, deleted: null, restored: null }, o && o.sellers)
];
const view = (status, o) => Object.assign({ ok: true, status, requestedAt: new Date().toISOString(), executeAfter: FUTURE(86400000), validUntil: FUTURE(86400000 * 3), undoUntil: null, tables: TABLES() }, o || {});

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

async function openScreen(answer, calls, token, name) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, acceptDownloads: true });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-delete-business$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = answer(body);
      return route.fulfill({ status: a.status || 200, contentType: 'application/json', headers: h, body: JSON.stringify(a.json || {}) });
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
      await page.evaluate(([tok, nm]) => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => tok;
        window.sb = async () => (nm ? [{ business_name_location: nm }] : []);
        window.__reloads = 0;
        window.dxReloadApp = () => { window.__reloads++; };
        document.getElementById('settings-tab-content').style.display = 'block';
      }, [token, name || '']);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
const open = async (page) => { await page.click('#dx-menu-row'); await page.waitForSelector('#dx-content .dx-p, #dx-content .dx-status.error, #dx-content .dx-status'); await page.waitForFunction(() => !/^Loading/.test(document.getElementById('dx-content').textContent)); };
const text = (page, sel) => page.$eval(sel || '#dx-content', (e) => e.textContent);
const actionsOf = (calls) => calls.map((c) => c.action);

// A small pretend door that keeps a state and answers the six actions.
function door(start, hooks) {
  const state = { view: start };
  return {
    state,
    answer(body) {
      if (hooks && hooks[body.action]) { const h = hooks[body.action](body, state); if (h) return h; }
      if (body.action === 'status') return { json: state.view };
      if (body.action === 'request') { state.view = view('cooling'); return { json: state.view }; }
      if (body.action === 'cancel') { state.view = { ok: true, status: 'cancelled' }; return { json: state.view }; }
      if (body.action === 'execute') { state.view = view('deleted', { undoUntil: FUTURE(7 * 86400000), tables: TABLES({ orders: { deleted: 5 }, extra: { deleted: 2 }, sellers: { deleted: 1 } }) }); return { json: Object.assign({ remaining: 0 }, state.view) }; }
      if (body.action === 'undo') { state.view = view('restored', { tables: TABLES({ orders: { restored: 5 }, extra: { restored: 2 }, sellers: { restored: 1 } }) }); return { json: state.view }; }
      if (body.action === 'download') return { json: { ok: true, export: { version: 1, tables: { orders: [{ id: 1 }] } }, note: 'x' } };
      return { json: { ok: false, code: 'bad_action', message: 'x' } };
    }
  };
}

test('opening the screen asks the door for the status first, with only the login token', { skip }, async () => {
  const calls = [];
  const d = door({ ok: true, status: 'none' });
  const { page, errors } = await openScreen(d.answer, calls, 'test-token');
  await open(page);
  assert.deepEqual(calls, [{ token: 'test-token', action: 'status' }]);
  assert.match(await text(page), /This permanently deletes your business data: products, customers, orders and chats\./);
  assert.match(await text(page), /To start, type: DELETE/);
  assert.deepEqual(errors, []);
});

test('the words to type are the business name known to the app (the part before the first comma)', { skip }, async () => {
  const d = door({ ok: true, status: 'none' });
  const { page } = await openScreen(d.answer, [], 'test-token', 'Corner Shop, Some Town');
  await open(page);
  assert.match(await text(page), /To start, type: Corner Shop$|To start, type: Corner Shop[^,]/);
  assert.ok(!/Some Town/.test(await text(page)));
});

test('a missing login is refused: the door is not called', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(door({ ok: true, status: 'none' }).answer, calls, null);
  await open(page);
  assert.equal(calls.length, 0);
  assert.equal(await text(page), 'Please sign out and sign in again, then try once more.');
});

test('door problems are shown in plain words', { skip }, async () => {
  const cases = [
    [{ status: 503, json: {} }, 'This screen is not available yet. Please try again later.'],
    [{ json: { ok: false, code: 'relogin', message: 'x' } }, 'Please sign out and sign in again, then try once more.'],
    [{ json: { ok: false, code: 'failed', message: 'x' } }, 'Something went wrong. Open this screen again to see where your request stands before you try again.']
  ];
  for (const [reply, expected] of cases) {
    const { page } = await openScreen(() => reply, [], 'test-token');
    await open(page);
    assert.equal(await text(page), expected);
    await page.close();
  }
});

test('the start button stays disabled until words are typed; nothing is sent before it is pressed; the typed words go as typed', { skip }, async () => {
  const calls = [];
  const d = door({ ok: true, status: 'none' });
  const { page } = await openScreen(d.answer, calls, 'test-token', 'Corner Shop');
  await open(page);
  assert.equal(await page.$eval('#dx-start', (b) => b.disabled), true);
  await page.click('#dx-start', { force: true }).catch(() => {});
  assert.deepEqual(actionsOf(calls), ['status'], 'a disabled button sends nothing');
  await page.fill('#dx-type-start', 'Corner Shop');
  assert.equal(await page.$eval('#dx-start', (b) => b.disabled), false);
  await page.click('#dx-start');
  await page.waitForSelector('#dx-cancel');
  assert.deepEqual(calls[1], { token: 'test-token', action: 'request', confirmText: 'Corner Shop' });
  assert.ok(calls.every((c) => !('sellerId' in c)));
  const t = await text(page);
  assert.match(t, /Your copy is saved\. Nothing has been deleted\./);
  assert.match(t, /Orders/);
  assert.match(t, /telegram_extra/, 'a table the screen does not know is shown by its plain name');
  assert.match(t, /Your business profile/);
});

test('words that do not match are refused by the door and the exact words are shown; a failed copy says nothing was started', { skip }, async () => {
  const d = door({ ok: true, status: 'none' }, { request: () => ({ json: { ok: false, code: 'confirm_text', message: 'x', typeThis: 'Corner Shop' } }) });
  const { page } = await openScreen(d.answer, [], 'test-token', 'Corner Shop');
  await open(page);
  await page.fill('#dx-type-start', 'wrong');
  await page.click('#dx-start');
  await page.waitForFunction(() => /do not match/.test(document.getElementById('dx-msg').textContent));
  assert.equal(await text(page, '#dx-msg'), 'The words you typed do not match. Type exactly: Corner Shop');
  const d2 = door({ ok: true, status: 'none' }, { request: () => ({ json: { ok: false, code: 'export_failed', message: 'x' } }) });
  const two = await openScreen(d2.answer, [], 'test-token');
  await open(two.page);
  await two.page.fill('#dx-type-start', 'DELETE');
  await two.page.click('#dx-start');
  await two.page.waitForFunction(() => /nothing was started/.test(document.getElementById('dx-msg').textContent));
  assert.ok(await two.page.$('#dx-start'), 'still on the first state');
});

test('cooling: counts, download as a dated JSON file with the secret note, and cancel returns to the first state', { skip }, async () => {
  const calls = [];
  const d = door(view('cooling'));
  const { page } = await openScreen(d.answer, calls, 'test-token');
  await open(page);
  assert.match(await text(page), /You can delete after /);
  assert.equal(await page.$('#dx-delete'), null, 'no delete button during the waiting time');
  assert.equal(await page.$('#dx-type-again'), null, 'no second box during the waiting time');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dx-download')]);
  assert.match(dl.suggestedFilename(), /^sparkly-export-\d{4}-\d\d-\d\d\.json$/);
  const saved = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.equal(saved.version, 1);
  await page.waitForFunction(() => /Secret values such as tokens are hidden in this file\./.test(document.getElementById('dx-msg').textContent));
  await page.click('#dx-cancel');
  await page.waitForSelector('#dx-start');
  assert.deepEqual(actionsOf(calls), ['status', 'download', 'cancel', 'status'].slice(0, calls.length));
  assert.ok(actionsOf(calls).includes('cancel'));
});

test('after the waiting time a second typed box appears; Delete now stays disabled until it has text and sends the typed words', { skip }, async () => {
  const calls = [];
  const d = door(view('cooling', { executeAfter: FUTURE(1500) }), {});
  const { page } = await openScreen(d.answer, calls, 'test-token', 'Corner Shop');
  await open(page);
  assert.equal(await page.$('#dx-delete'), null);
  await page.waitForSelector('#dx-delete', { timeout: 6000 });
  assert.match(await text(page), /The waiting time is over\./);
  assert.match(await text(page), /Type the words again to confirm/);
  assert.equal(await page.$eval('#dx-delete', (b) => b.disabled), true);
  assert.equal(actionsOf(calls).includes('execute'), false);
  await page.fill('#dx-type-again', 'Corner Shop');
  await page.click('#dx-delete');
  await page.waitForSelector('#dx-undo');
  const exec = calls.filter((c) => c.action === 'execute');
  assert.equal(exec.length, 1);
  assert.deepEqual(exec[0], { token: 'test-token', action: 'execute', confirmText: 'Corner Shop' });
  const t = await text(page);
  assert.match(t, /Your business data was deleted\./);
  assert.match(t, /You can undo this until /);
});

test('the door refusing delete too early is shown in plain words with the date', { skip }, async () => {
  const d = door(view('cooling', { executeAfter: FUTURE(1000) }), { execute: () => ({ json: { ok: false, code: 'cooling_off', message: 'x', executeAfter: FUTURE(5000) } }) });
  const { page } = await openScreen(d.answer, [], 'test-token');
  await open(page);
  await page.waitForSelector('#dx-delete', { timeout: 6000 });
  await page.fill('#dx-type-again', 'DELETE');
  await page.click('#dx-delete');
  await page.waitForFunction(() => /waiting time is not over yet/.test(document.getElementById('dx-msg').textContent));
});

test('deleted: Undo calls undo, shows the put-back counts and reloads the app', { skip }, async () => {
  const calls = [];
  const d = door(view('deleted', { undoUntil: FUTURE(86400000), tables: TABLES({ orders: { deleted: 5 }, extra: { deleted: 2 }, sellers: { deleted: 1 } }) }));
  const { page } = await openScreen(d.answer, calls, 'test-token');
  await open(page);
  assert.match(await text(page), /Your business data was deleted\./);
  assert.ok(await page.$('#dx-download'));
  await page.click('#dx-undo');
  await page.waitForFunction(() => /Your data was put back\./.test(document.getElementById('dx-content').textContent));
  assert.ok(actionsOf(calls).includes('undo'));
  await page.waitForFunction(() => window.__reloads === 1, null, { timeout: 6000 });
});

test('partial offers Try again (with the typed box) and Undo; alarm offers Undo only', { skip }, async () => {
  const partial = door(view('partial', { remaining: 3 }));
  const a = await openScreen(partial.answer, [], 'test-token');
  await open(a.page);
  assert.match(await text(a.page), /Not everything could be deleted yet\./);
  assert.match(await text(a.page), /Rows still to delete: 3/);
  assert.equal(await a.page.$eval('#dx-retry-delete', (b) => b.disabled), true);
  assert.ok(await a.page.$('#dx-undo'));
  const alarm = door(view('alarm'));
  const b = await openScreen(alarm.answer, [], 'test-token');
  await open(b.page);
  assert.match(await text(b.page), /Stopped for safety\. Nothing more will be deleted\. Please contact support\./);
  assert.ok(await b.page.$('#dx-undo'));
  assert.equal(await b.page.$('#dx-retry-delete'), null);
  assert.equal(await b.page.$('#dx-delete'), null);
});

test('execute answering partial or alarm shows that state', { skip }, async () => {
  const d = door(view('cooling', { executeAfter: FUTURE(1000) }), { execute: () => ({ json: Object.assign(view('partial', { remaining: 2 }), { ok: false, code: 'partial', message: 'x', failedAt: 'orders' }) }) });
  const { page } = await openScreen(d.answer, [], 'test-token');
  await open(page);
  await page.waitForSelector('#dx-delete', { timeout: 6000 });
  await page.fill('#dx-type-again', 'DELETE');
  await page.click('#dx-delete');
  await page.waitForSelector('#dx-retry-delete');
  assert.ok(!/orders\b.*failed|failedAt/.test(await text(page)), 'the internal failedAt is not shown');
});

test('deleting shows that it is running, with no buttons, and asks the status again later', { skip }, async () => {
  const calls = [];
  const d = door(view('deleting'));
  const { page } = await openScreen(d.answer, calls, 'test-token');
  await open(page);
  assert.equal(await text(page), 'Deleting is running.');
  assert.equal(await page.$$eval('#dx-content button', (b) => b.length), 0);
  assert.equal(await page.evaluate(() => DX.poll !== null), true);
  d.state.view = view('deleted', { undoUntil: FUTURE(86400000) });
  await page.evaluate(() => { clearTimeout(DX.poll); return dxLoadStatus(); });
  await page.waitForSelector('#dx-undo');
  assert.deepEqual(actionsOf(calls), ['status', 'status']);
});

test('the codes that mean "look at the status again" reload the status; too late shows its words', { skip }, async () => {
  for (const code of ['no_request', 'not_pending', 'nothing_to_cancel']) {
    const calls = [];
    const d = door(view('cooling'), { cancel: () => ({ json: { ok: false, code, message: 'x' } }) });
    const { page } = await openScreen(d.answer, calls, 'test-token');
    await open(page);
    await page.click('#dx-cancel');
    await page.waitForFunction(() => document.querySelector('#dx-cancel'));
    await page.waitForTimeout(200);
    assert.deepEqual(actionsOf(calls), ['status', 'cancel', 'status'], code);
    await page.close();
  }
  const d = door(view('cooling'), { cancel: () => ({ json: Object.assign(view('deleting'), { ok: false, code: 'too_late', message: 'x' }) }) });
  const { page } = await openScreen(d.answer, [], 'test-token');
  await open(page);
  await page.click('#dx-cancel');
  await page.waitForFunction(() => /Deleting is running\./.test(document.getElementById('dx-content').textContent));
});

test('undo and download failures are shown in plain words', { skip }, async () => {
  const d = door(view('deleted', { undoUntil: FUTURE(86400000) }), {
    undo: () => ({ json: { ok: false, code: 'undo_failed', message: 'x' } }),
    download: () => ({ json: { ok: false, code: 'too_large', message: 'x' } })
  });
  const { page } = await openScreen(d.answer, [], 'test-token');
  await open(page);
  await page.click('#dx-undo');
  await page.waitForFunction(() => /Not everything could be put back\. Your saved copy is kept\. Try again, or contact support\./.test(document.getElementById('dx-msg').textContent));
  await page.click('#dx-download');
  await page.waitForFunction(() => /too large to download here\. Contact support for the file\./.test(document.getElementById('dx-msg').textContent));
});

test('nothing is ever deleted without both typed boxes: only status, request and cancel are sent until the second box has text and Delete now is pressed', { skip }, async () => {
  const calls = [];
  const d = door({ ok: true, status: 'none' }, { request: (b, s) => { s.view = view('cooling', { executeAfter: FUTURE(1200) }); return { json: s.view }; } });
  const { page } = await openScreen(d.answer, calls, 'test-token');
  await open(page);
  await page.fill('#dx-type-start', 'DELETE');
  await page.click('#dx-start');
  await page.waitForSelector('#dx-delete', { timeout: 6000 });
  await page.waitForTimeout(500);
  assert.deepEqual(actionsOf(calls), ['status', 'request']);
});

test('the back arrow returns to Settings and stops the timers', { skip }, async () => {
  const { page } = await openScreen(door(view('deleting')).answer, [], 'test-token');
  await open(page);
  await page.click('#dx-header-row button');
  assert.equal(await page.$eval('#dx-tab-content', (e) => e.style.display), 'none');
  assert.equal(await page.$eval('#settings-tab-content', (e) => e.style.display), 'block');
  assert.equal(await page.evaluate(() => DX.poll), null);
});
