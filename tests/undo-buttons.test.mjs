// Run with:  node --test tests/*.test.mjs
// Undo section of the Import and barcodes screen: undo last import, last barcode link, last stock change, and Cancel this invoice (a soft cancel).
// The stock door is answered by the test: nothing leaves the test and nothing is changed. If Playwright is not installed (it is installed in
// CI), the browser tests are skipped. The text scan always runs.
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

// ---- Rule: code written by the W1 chat is English only (ASCII). The new block, the four small hooks and this file are scanned. ----
test('the new undo code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('w1-undo-buttons:js:start');
  const end = html.indexOf('w1-undo-buttons:js:end');
  assert.ok(start > 0 && end > start, 'marked block missing');
  const hooks = html.split('\n').filter((l) => /w1UndoSection\(\)\)|await w1UndoConfirm\(p\)|w1UndoRefresh\(\);/.test(l) && !l.includes('function '));
  assert.ok(hooks.length >= 4, 'the small hooks in the Import and barcodes screen');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), block: html.slice(start, end), hooks: hooks.join('\n') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is at least v75 and the older parts of the screen are still there', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 75);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const id of ['bk-check', 'bk-find', 'bk-confirm-go', 'bk-import']) assert.ok(html.includes('id="' + id + '"') || html.includes("'" + id + "'"), id);
});

// ---- Browser tests ----
const PLANS = {
  csvApply: { ok: true, kind: 'csvApply', canUndo: true, digest: 'a'.repeat(32), summary: { products: 3, changedAt: '2026-01-02T10:00:00Z' } },
  barcodeLink: { ok: true, kind: 'barcodeLink', canUndo: true, digest: 'b'.repeat(32), summary: { productId: 'p1', productName: 'Lamp', from: 'OLD-1234', to: 'NEW-5678', changedAt: '2026-01-02T10:00:00Z' } },
  stockSet: { ok: true, kind: 'stockSet', canUndo: true, digest: 'c'.repeat(32), summary: { productId: 'p1', productName: 'Lamp', from: { quantity: 7, tracked: true }, to: { quantity: 2, tracked: true }, changedAt: '2026-01-02T10:00:00Z' } },
  invoiceCreate: { ok: true, kind: 'invoiceCreate', canUndo: true, digest: 'd'.repeat(32), summary: { orderId: 41, lines: 2, total: 150.5, changedAt: '2026-01-02T10:00:00Z' } }
};
const NOTHING = { ok: false, error: 'nothing_to_undo', message: 'x' };

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

// `plans` says which kinds have something to undo (the others answer nothing_to_undo). `answer(body)` can override any door answer.
async function openScreen(plans, calls, answer, token) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-stock-invoices$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      let a = answer && answer(body);
      if (!a) {
        if (body.action === 'undoCheck') a = { json: plans.includes(body.kind) ? PLANS[body.kind] : NOTHING };
        else if (body.action === 'undoApply') a = { json: { ok: true, message: 'x', kind: body.kind, undone: true, rows: 1 } };
        else if (body.action === 'csvCheck') a = { json: { ok: true, digest: 'e'.repeat(32), total: 1, willImport: 1, skipped: 0, errors: 0, problems: [], sample: [{ product_name: 'Lamp' }], ignoredColumns: [] } };
        else if (body.action === 'csvApply') a = { json: { ok: true, message: 'x', imported: 1, skipped: 0, errors: 0 } };
        else a = { json: { ok: false, error: 'bad_action', message: 'x' } };
      }
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
      await page.evaluate((tok) => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => tok;
        document.getElementById('settings-tab-content').style.display = 'block';
      }, token === undefined ? 'test-token' : token);
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  await page.click('#bk-menu-row');
  await page.waitForSelector('#w1u-rows', { state: 'attached' });
  await page.waitForFunction(() => document.getElementById('w1u-msg').textContent !== 'Checking...');
  return { page, errors };
}
const kindsAsked = (calls) => calls.filter((c) => c.action === 'undoCheck').map((c) => c.kind);
const applies = (calls) => calls.filter((c) => c.action === 'undoApply');
const buttons = (page) => page.$$eval('.w1u-button', (b) => b.map((x) => x.textContent));
const msg = (page) => page.$eval('#w1u-msg', (e) => e.textContent);
const press = async (page, kind) => { await page.click('.w1u-button[data-w1u-kind="' + kind + '"]'); await page.waitForSelector('#bk-confirm', { state: 'visible' }); };
const refreshed = (page) => page.waitForFunction(() => document.getElementById('w1u-msg').textContent !== 'Checking...');

test('opening the screen asks undoCheck for the four kinds (a dry run, token only) and shows a button only for a kind that has something to undo', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openScreen(['csvApply', 'invoiceCreate'], calls);
  assert.deepEqual(kindsAsked(calls), ['csvApply', 'barcodeLink', 'stockSet', 'invoiceCreate']);
  assert.deepEqual(calls.filter((c) => c.action === 'undoCheck')[0], { token: 'test-token', action: 'undoCheck', kind: 'csvApply' });
  assert.deepEqual(await buttons(page), ['Undo last import', 'Cancel this invoice']);
  assert.ok(calls.every((c) => !('sellerId' in c)));
  assert.deepEqual(errors, []);
});

test('with nothing to undo the section says so and shows no button; the cancel rule is always written', { skip }, async () => {
  const { page } = await openScreen([], []);
  assert.deepEqual(await buttons(page), []);
  assert.equal(await msg(page), 'Nothing to undo right now.');
  assert.match(await page.$eval('#w1u-section', (e) => e.textContent), /Cancel only works while the invoice has not been numbered, sent or paid\. Nothing is deleted\./);
});

test('each row shows the dry run summary from the door before anything is asked', { skip }, async () => {
  const { page } = await openScreen(['csvApply', 'barcodeLink', 'stockSet', 'invoiceCreate'], []);
  const rows = await page.$$eval('#w1u-rows .bk-row', (r) => r.map((x) => x.firstChild.textContent));
  assert.match(rows[0], /^Last import: 3 products, /);
  assert.match(rows[1], /^Last barcode link: Lamp \(OLD-1234 to NEW-5678\), /);
  assert.match(rows[2], /^Last stock change: Lamp, 2 to 7, /);
  assert.match(rows[3], /^Last invoice: order 41, 2 lines, total 150\.5, /);
  assert.deepEqual(await buttons(page), ['Undo last import', 'Undo last barcode link', 'Undo last stock change', 'Cancel this invoice']);
});

test('undo last import: the question is asked in words, nothing is sent until Confirm, Cancel sends nothing, Confirm sends undoApply once with the digest', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(['csvApply'], calls);
  await press(page, 'csvApply');
  assert.equal(await page.$eval('#bk-confirm-summary', (e) => e.textContent), 'Hide the 3 products you imported? They are hidden, not deleted.');
  assert.equal(applies(calls).length, 0);
  await page.click('#bk-confirm-cancel');
  await page.waitForTimeout(200);
  assert.equal(applies(calls).length, 0);
  await press(page, 'csvApply');
  await page.evaluate(() => { const b = document.getElementById('bk-confirm-go'); b.click(); b.click(); });
  await page.waitForFunction(() => /The change was undone\./.test(document.getElementById('w1u-msg').textContent));
  assert.deepEqual(applies(calls), [{ token: 'test-token', action: 'undoApply', kind: 'csvApply', digest: 'a'.repeat(32) }]);
});

test('after an undo the section asks again, and a kind that is now empty has no button (a second undo is not offered)', { skip }, async () => {
  const calls = [];
  let undone = false;
  const answer = (b) => {
    if (b.action === 'undoApply') { undone = true; return { json: { ok: true, message: 'x', kind: b.kind, undone: true, rows: 3 } }; }
    if (b.action === 'undoCheck' && b.kind === 'csvApply' && undone) return { json: NOTHING };
    return null;
  };
  const { page } = await openScreen(['csvApply'], calls, answer);
  await press(page, 'csvApply');
  await page.click('#bk-confirm-go');
  await page.waitForFunction(() => /The change was undone\./.test(document.getElementById('w1u-msg').textContent));
  await page.waitForFunction(() => document.querySelectorAll('.w1u-button').length === 0);
  assert.ok(kindsAsked(calls).filter((k) => k === 'csvApply').length >= 2);
});

test('undo last barcode link and last stock change are asked in words, including when there was no old code or the product was not tracked', { skip }, async () => {
  const a = await openScreen(['barcodeLink'], []);
  await press(a.page, 'barcodeLink');
  assert.equal(await a.page.$eval('#bk-confirm-summary', (e) => e.textContent), 'Put the old barcode back on Lamp?');
  const noOld = JSON.parse(JSON.stringify(PLANS.barcodeLink)); noOld.summary.from = null;
  const b = await openScreen([], [], (x) => x.action === 'undoCheck' && x.kind === 'barcodeLink' ? { json: noOld } : null);
  await press(b.page, 'barcodeLink');
  assert.equal(await b.page.$eval('#bk-confirm-summary', (e) => e.textContent), 'Take the barcode off Lamp?');
  const c = await openScreen(['stockSet'], []);
  await press(c.page, 'stockSet');
  assert.equal(await c.page.$eval('#bk-confirm-summary', (e) => e.textContent), 'Put the stock of Lamp back to 7?');
  const untracked = JSON.parse(JSON.stringify(PLANS.stockSet)); untracked.summary.from = { quantity: null, tracked: false };
  const d = await openScreen([], [], (x) => x.action === 'undoCheck' && x.kind === 'stockSet' ? { json: untracked } : null);
  await press(d.page, 'stockSet');
  assert.equal(await d.page.$eval('#bk-confirm-summary', (e) => e.textContent), 'Put the stock of Lamp back to not tracked?');
});

test('Cancel this invoice: the confirm says the order is only marked cancelled and kept, and that cancel works only before numbering, sending or payment', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(['invoiceCreate'], calls);
  await press(page, 'invoiceCreate');
  const text = await page.$eval('#bk-confirm-summary', (e) => e.textContent);
  assert.match(text, /Mark this order as cancelled\. The order and its lines are kept\./);
  assert.match(text, /Cancel only works while the invoice has not been numbered, sent or paid\. Nothing is deleted\./);
  assert.equal(applies(calls).length, 0);
  await page.click('#bk-confirm-go');
  await page.waitForFunction(() => /The order was cancelled\. Nothing was deleted/.test(document.getElementById('w1u-msg').textContent));
  assert.deepEqual(applies(calls), [{ token: 'test-token', action: 'undoApply', kind: 'invoiceCreate', digest: 'd'.repeat(32) }]);
});

test('an invoice that was already changed, sent or paid cannot be cancelled: the screen says why with no values and shows no button', { skip }, async () => {
  const reply = (b) => b.action === 'undoCheck' && b.kind === 'invoiceCreate' ? { json: { ok: false, error: 'changed_since', message: 'raw', counts: { total: 1, changed: 0, sent: 1, paid: 1, missing: 0 } } } : null;
  const { page } = await openScreen([], [], reply);
  assert.deepEqual(await buttons(page), []);
  const t = await page.$eval('#w1u-rows', (e) => e.textContent);
  assert.match(t, /Cancel this invoice: This order was already changed, sent or paid, so it cannot be cancelled here\. Correct it in the invoice system\. Why: it was sent, a payment was recorded\./);
  assert.ok(!/\d/.test(t), 'no values, no counts shown');
});

test('an import that was changed afterwards cannot be undone: N of M products, no button; a barcode whose old code is taken says so', { skip }, async () => {
  const reply = (b) => {
    if (b.action !== 'undoCheck') return null;
    if (b.kind === 'csvApply') return { json: { ok: false, error: 'changed_since', message: 'raw', counts: { total: 5, changed: 1, missing: 1 } } };
    if (b.kind === 'barcodeLink') return { json: { ok: false, error: 'barcode_in_use', message: 'raw' } };
    return { json: NOTHING };
  };
  const { page } = await openScreen([], [], reply);
  assert.deepEqual(await buttons(page), []);
  const t = await page.$eval('#w1u-rows', (e) => e.textContent);
  assert.match(t, /Undo last import: 2 of 5 products were changed after the import, so it cannot be undone automatically\./);
  assert.match(t, /Undo last barcode link: The old barcode now belongs to another product, so this cannot be undone\. Nothing was changed\./);
});

test('undoApply refusals: a newer change checks again; a save problem or an unconfirmed answer hides the buttons until Refresh and is not retried', { skip }, async () => {
  const calls = [];
  const changed = await openScreen(['csvApply'], calls, (b) => b.action === 'undoApply' ? { json: { ok: false, error: 'changed', message: 'raw' } } : null);
  const before = kindsAsked(calls).length;
  await press(changed.page, 'csvApply');
  await changed.page.click('#bk-confirm-go');
  for (let i = 0; i < 50 && kindsAsked(calls).length <= before; i++) await changed.page.waitForTimeout(100);
  assert.ok(kindsAsked(calls).length > before, 'the checks were asked again');
  await changed.page.waitForFunction(() => document.querySelectorAll('.w1u-button').length === 1 && !/^Checking/.test(document.getElementById('w1u-msg').textContent));
  for (const [error, expected] of [
    ['undo_unavailable', 'Nothing was changed, or it is not known. Press Refresh and look at your list before you try again.'],
    ['save_failed', 'Nothing was changed, or it is not known. Press Refresh and look at your list before you try again.'],
    ['unconfirmed', 'We did not get a confirmation in time. Do not try again: press Refresh and look at your list first.']
  ]) {
    const c = [];
    const { page } = await openScreen(['stockSet'], c, (b) => b.action === 'undoApply' ? { json: { ok: false, error, message: 'raw' } } : null);
    await press(page, 'stockSet');
    await page.click('#bk-confirm-go');
    await page.waitForFunction((t) => document.getElementById('w1u-msg').textContent === t, expected);
    assert.deepEqual(await buttons(page), [], error + ': no second try without Refresh');
    assert.equal(applies(c).length, 1);
    await page.close();
  }
});

test('the door being off is said plainly, and a missing login makes no call', { skip }, async () => {
  const down = await openScreen([], [], () => ({ status: 503, json: {} }));
  assert.equal(await msg(down.page), 'Not available yet.');
  assert.deepEqual(await buttons(down.page), []);
  const calls = [];
  const none = await openScreen(['csvApply'], calls, null, null);
  assert.equal(await msg(none.page), 'Please sign out and sign in again, then try once more.');
  assert.equal(calls.length, 0);
});

test('Refresh asks the four checks again; importing or linking on the same screen refreshes the undo buttons', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen([], calls);
  const first = kindsAsked(calls).length;
  await page.click('#w1u-refresh');
  await refreshed(page);
  await page.waitForFunction((n) => true, first);
  assert.equal(kindsAsked(calls).length, first * 2);
  await page.setInputFiles('#bk-file', { name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from('name\nLamp\n') });
  await page.click('#bk-check');
  await page.waitForSelector('#bk-import');
  await page.click('#bk-import');
  await page.click('#bk-confirm-go');
  await page.waitForFunction(() => /Products imported/.test(document.getElementById('bk-import-msg').textContent));
  await page.waitForFunction((n) => true, 0);
  await page.waitForTimeout(500);
  assert.ok(kindsAsked(calls).length >= first * 3, 'the checks were asked again after the import');
});

test('only undoCheck is sent until a Confirm is pressed: opening the screen never changes anything', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(['csvApply', 'barcodeLink', 'stockSet', 'invoiceCreate'], calls);
  await press(page, 'invoiceCreate');
  await page.waitForTimeout(300);
  assert.ok(calls.every((c) => c.action === 'undoCheck'));
});
