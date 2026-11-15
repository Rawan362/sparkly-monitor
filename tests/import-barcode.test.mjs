// Run with:  node --test tests/*.test.mjs
// Import and barcodes screen (build chat W1). The stock door is answered by the test: nothing leaves the test and nothing is saved.
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
  const start = html.indexOf('w1-import-barcode:' + kind + ':start');
  const end = html.indexOf('w1-import-barcode:' + kind + ':end');
  assert.ok(start > 0 && end > start, 'marked block missing: ' + kind);
  return html.slice(start, end);
}
test('the new Import and barcodes code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') };
  for (const k of ['css', 'html', 'row', 'js']) files['block ' + k] = marked(html, k);
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is at least v74, the new row is added, and the old Products screen and the old CSV button are untouched', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 74);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('onclick="openImportBarcode()"'));
  assert.ok(html.includes('<div class="settings-row" onclick="openProductsPanel()">'));
  assert.ok(html.includes('<button id="bc-csv-btn" onclick="document.getElementById(\'bc-csv-input\').click()">Bulk-add products from a CSV</button>'));
  assert.ok(html.includes('function bulkImportProductsFromCsv('));
});

// ---- Browser tests ----
const CHECK = (o) => Object.assign({
  ok: true, digest: 'a'.repeat(32), total: 5, willImport: 3, skipped: 1, errors: 1,
  problems: [{ line: 3, status: 'skipped', reason: 'already_exists', message: 'raw' }, { line: 5, status: 'error', reason: 'bad_number', message: 'raw' }], problemsCut: false,
  sample: [{ product_name: 'Lamp', product_category: 'home', wholesale_price: 5, retail_price: 9.5, stock_quantity: 4 }, { product_name: 'Desk', barcode: '12345678' }],
  ignoredColumns: []
}, o || {});
const CSV = 'name,price\nLamp,9.5\nDesk,20\n';

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

async function openScreen(answer, calls, token, init) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  if (init) await page.addInitScript(init);
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-stock-invoices$/.test(u)) {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const a = (answer && answer(body)) || defaults(body);
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
  await page.waitForSelector('#bk-file');
  return { page, errors };
}
function defaults(body) {
  if (body.action === 'csvCheck') return { json: CHECK() };
  if (body.action === 'csvApply') return { json: { ok: true, message: 'x', imported: 3, skipped: 1, errors: 1 } };
  if (body.action === 'barcodeFind') return { json: { ok: true, found: false } };
  if (body.action === 'barcodeLink') return { json: { ok: true, message: 'x', product: { id: 'p1', name: 'Lamp' } } };
  if (body.action === 'stockList') return { json: { ok: true, products: [{ id: 'p1', name: 'Lamp', quantity: 3, threshold: 5, low: true }], untracked: [{ id: 'p2', name: 'Desk' }], defaultThreshold: 5 } };
  return { json: { ok: false, error: 'bad_action', message: 'x' } };
}
const actionsOf = (calls) => calls.map((c) => c.action);
const importMsg = (page) => page.$eval('#bk-import-msg', (e) => e.textContent);
const barcodeMsg = (page) => page.$eval('#bk-barcode-msg', (e) => e.textContent);
const file = (page, csv, name) => page.setInputFiles('#bk-file', { name: name || 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(csv || CSV) });
const check = async (page) => { await page.click('#bk-check'); await page.waitForFunction(() => document.getElementById('bk-counts') || /\S/.test(document.getElementById('bk-import-msg').textContent) && !/^Checking/.test(document.getElementById('bk-import-msg').textContent)); };

test('a missing login is refused and no file is read; choosing no file asks for one', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(null, calls, null);
  await page.click('#bk-check');
  assert.equal(await importMsg(page), 'Choose a file first.');
  await file(page);
  await check(page);
  assert.equal(await importMsg(page), 'Please sign out and sign in again, then try once more.');
  assert.equal(calls.length, 0);
});

test('Check the file sends csvCheck with the file text and shows the counts, the problems by line, the sample and the Import button', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openScreen(null, calls);
  await file(page);
  await check(page);
  assert.deepEqual(calls, [{ token: 'test-token', action: 'csvCheck', csv: CSV }]);
  const counts = await page.$$eval('#bk-counts .bk-count', (e) => e.map((x) => x.textContent));
  assert.deepEqual(counts, ['3Will import', '1Skipped', '1Refused', '5Lines']);
  const problems = await page.$$eval('#bk-problems li', (e) => e.map((x) => x.textContent));
  assert.deepEqual(problems, ['Line 3 (Skipped): You already have an active product with this name.', 'Line 5 (Refused): A price or quantity is not a plain number.']);
  const sample = await page.$$eval('#bk-sample tr:not(:first-child)', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  assert.deepEqual(sample[0], ['Lamp', 'home', '5', '9.5', '-', '4', '-', '-']);
  assert.deepEqual(sample[1], ['Desk', '-', '-', '-', '-', '-', '-', '12345678']);
  assert.equal(await page.$eval('#bk-import', (b) => b.textContent), 'Import 3 products');
  assert.ok(calls.every((c) => !('sellerId' in c)));
  assert.deepEqual(errors, []);
});

test('a file that is too big is not sent; a file with nothing to import cannot be imported', { skip }, async () => {
  const calls = [];
  const a = await openScreen(null, calls);
  await file(a.page, 'name\n' + 'x'.repeat(200001));
  await a.page.click('#bk-check');
  await a.page.waitForFunction(() => /too big/.test(document.getElementById('bk-import-msg').textContent));
  assert.equal(calls.length, 0);
  const b = await openScreen((x) => x.action === 'csvCheck' ? { json: CHECK({ willImport: 0, skipped: 2, errors: 0, problems: [], sample: [] }) } : null, []);
  await file(b.page);
  await check(b.page);
  assert.equal(await b.page.$eval('#bk-import', (e) => e.disabled), true);
});

test('unused columns can be mapped by the seller; Check again sends only the choices made', { skip }, async () => {
  const calls = [];
  const reply = (b) => b.action === 'csvCheck' ? { json: CHECK({ ignoredColumns: b.mapping ? [] : ['Nom', 'Prix'] }) } : null;
  const { page } = await openScreen(reply, calls);
  await file(page, 'Nom,Prix\nLampe,9\n');
  await check(page);
  assert.equal(await page.$$eval('#bk-mapping select', (s) => s.length), 2);
  assert.deepEqual(await page.$$eval('#bk-mapping select:first-of-type option', (o) => o.map((x) => x.textContent)).then((l) => l.slice(0, 3)), ['Not used', 'Product name', 'Category']);
  await page.selectOption('#bk-mapping select[data-header="Nom"]', 'product_name');
  await page.click('#bk-check-again');
  await page.waitForFunction(() => !document.getElementById('bk-mapping'));
  assert.deepEqual(calls[1], { token: 'test-token', action: 'csvCheck', csv: 'Nom,Prix\nLampe,9\n', mapping: { Nom: 'product_name' } });
});

test('Import opens the confirm panel; nothing is saved until Confirm; Cancel sends nothing', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(null, calls);
  await file(page);
  await check(page);
  await page.click('#bk-import');
  await page.waitForSelector('#bk-confirm', { state: 'visible' });
  assert.match(await page.$eval('#bk-confirm-summary', (e) => e.textContent), /Import 3 products from this file\? Lines that were skipped or refused are not imported\./);
  assert.match(await page.$eval('#bk-confirm', (e) => e.textContent), /Nothing changes until you press Confirm\. A safety copy is saved first\./);
  assert.deepEqual(actionsOf(calls), ['csvCheck']);
  await page.click('#bk-confirm-cancel');
  await page.waitForTimeout(200);
  assert.deepEqual(actionsOf(calls), ['csvCheck']);
  assert.equal(await page.$eval('#bk-confirm', (e) => e.style.display), 'none');
});

test('Confirm sends csvApply once with the same file and the digest of the check, then shows the counts', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(null, calls);
  await file(page);
  await check(page);
  await page.click('#bk-import');
  await page.evaluate(() => { const b = document.getElementById('bk-confirm-go'); b.click(); b.click(); bkPressConfirm(); });
  await page.waitForFunction(() => /Products imported: 3/.test(document.getElementById('bk-import-msg').textContent));
  const applies = calls.filter((c) => c.action === 'csvApply');
  assert.equal(applies.length, 1);
  assert.deepEqual(applies[0], { token: 'test-token', action: 'csvApply', csv: CSV, digest: 'a'.repeat(32) });
  assert.equal(await importMsg(page), 'Products imported: 3 Skipped: 1 Refused: 1');
  assert.equal(await page.$eval('#bk-confirm', (e) => e.style.display), 'none');
  assert.equal(await page.$('#bk-import'), null, 'the same check cannot be imported twice');
});

test('if the file or the products changed since the check, the seller is told to check again and cannot import', { skip }, async () => {
  const { page } = await openScreen((b) => b.action === 'csvApply' ? { json: { ok: false, error: 'changed', message: 'raw' } } : null, []);
  await file(page);
  await check(page);
  await page.click('#bk-import');
  await page.click('#bk-confirm-go');
  await page.waitForFunction(() => /Check the file again/.test(document.getElementById('bk-import-msg').textContent));
  assert.equal(await importMsg(page), 'The file or your products changed since the check. Check the file again and confirm what it shows.');
  assert.equal(await page.$eval('#bk-import', (e) => e.disabled), true);
});

test('door refusals for the check and the import are shown in plain words', { skip }, async () => {
  const checks = [
    ['csv_empty', 'The file is empty. It needs a line of column names and at least one product line.'],
    ['no_name_column', 'No column holds the product name. Choose the name column.'],
    ['no_barcode_field', 'Your products have no barcode field yet, so barcodes cannot be used. Nothing was changed.'],
    ['bad_mapping', 'The column choice is not valid.'],
    ['too_many_rows', 'The file has too many lines. Split it into smaller files.'],
    ['strange', 'Something went wrong. Check your products before you try again.']
  ];
  for (const [error, expected] of checks) {
    const { page } = await openScreen((b) => b.action === 'csvCheck' ? { json: { ok: false, error, message: 'raw' } } : null, []);
    await file(page);
    await check(page);
    assert.equal(await importMsg(page), expected, error);
    await page.close();
  }
  const down = await openScreen((b) => b.action === 'csvCheck' ? { status: 503, json: {} } : null, []);
  await file(down.page);
  await check(down.page);
  assert.equal(await importMsg(down.page), 'This screen is not available yet. Please try again later.');
  const applies = [
    [{ error: 'undo_unavailable' }, 'Nothing was changed, because a safe copy of the old data could not be saved. Try again later.'],
    [{ error: 'too_many_to_import' }, 'More than 500 products would be imported at once. Split the file into smaller files.'],
    [{ error: 'nothing_to_import' }, 'There is nothing to import: no line passed the check.'],
    [{ error: 'save_failed', saved: { products: 0 } }, 'The change could not be saved. Check your products before you try again. (0)']
  ];
  for (const [json, expected] of applies) {
    const { page } = await openScreen((b) => b.action === 'csvApply' ? { json: Object.assign({ ok: false, message: 'raw' }, json) } : null, []);
    await file(page);
    await check(page);
    await page.click('#bk-import');
    await page.click('#bk-confirm-go');
    await page.waitForFunction(() => /\S/.test(document.getElementById('bk-import-msg').textContent));
    assert.equal(await importMsg(page), expected, json.error);
    await page.close();
  }
});

test('barcode: a code that is not valid sends nothing; a code that belongs to a product shows it with its prices and stock', { skip }, async () => {
  const calls = [];
  const reply = (b) => b.action === 'barcodeFind' ? { json: { ok: true, found: true, product: { id: 'p1', name: 'Lamp', wholesalePrice: 5, retailPrice: 9.5, trackStock: true, stockQuantity: 4 } } } : null;
  const { page } = await openScreen(reply, calls);
  await page.fill('#bk-code', 'ab');
  await page.click('#bk-find');
  assert.equal(await barcodeMsg(page), 'The barcode must be 4 to 64 letters, digits, dots, dashes or underscores.');
  assert.equal(calls.length, 0);
  await page.fill('#bk-code', ' 12345678 ');
  await page.click('#bk-find');
  await page.waitForSelector('#bk-barcode-result .bk-p');
  assert.deepEqual(calls, [{ token: 'test-token', action: 'barcodeFind', code: '12345678' }]);
  assert.equal(await page.$eval('#bk-barcode-result', (e) => e.textContent), 'This barcode belongs to: LampWholesale 5 - Retail 9.5 - Stock 4');
});

test('barcode: more than one product with the code is told plainly', { skip }, async () => {
  const { page } = await openScreen((b) => b.action === 'barcodeFind' ? { json: { ok: true, found: true, ambiguous: true, count: 2 } } : null, []);
  await page.fill('#bk-code', '12345678');
  await page.click('#bk-find');
  await page.waitForFunction(() => /More than one/.test(document.getElementById('bk-barcode-msg').textContent));
  assert.equal(await barcodeMsg(page), 'More than one of your products has this barcode (2).');
});

test('barcode not found: the products are listed, Link stays disabled until one is chosen, and the link needs the confirm panel and one Confirm', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(null, calls);
  await page.fill('#bk-code', 'ABC-1234');
  await page.click('#bk-find');
  await page.waitForSelector('#bk-product');
  assert.deepEqual(await page.$$eval('#bk-product option', (o) => o.map((x) => x.textContent)), ['Choose a product', 'Lamp', 'Desk']);
  assert.equal(await page.$eval('#bk-link', (b) => b.disabled), true);
  await page.selectOption('#bk-product', 'p2');
  assert.equal(await page.$eval('#bk-link', (b) => b.disabled), false);
  await page.click('#bk-link');
  await page.waitForSelector('#bk-confirm', { state: 'visible' });
  assert.equal(await page.$eval('#bk-confirm-summary', (e) => e.textContent), 'Link the barcode ABC-1234 to Desk?');
  assert.deepEqual(actionsOf(calls), ['barcodeFind', 'stockList']);
  await page.evaluate(() => { const b = document.getElementById('bk-confirm-go'); b.click(); b.click(); });
  await page.waitForFunction(() => /Barcode linked\./.test(document.getElementById('bk-barcode-msg').textContent));
  assert.deepEqual(calls.filter((c) => c.action === 'barcodeLink'), [{ token: 'test-token', action: 'barcodeLink', code: 'ABC-1234', productId: 'p2' }]);
});

test('barcode refusals are shown in plain words; a code already linked to that product says so', { skip }, async () => {
  const cases = [
    [{ ok: false, error: 'barcode_in_use' }, 'This barcode is already linked to another product. Nothing was changed.'],
    [{ ok: false, error: 'no_barcode_field' }, 'Your products have no barcode field yet, so barcodes cannot be used. Nothing was changed.'],
    [{ ok: false, error: 'no_product' }, 'That product was not found (it may have been removed). Refresh and try again.'],
    [{ ok: false, error: 'undo_unavailable' }, 'Nothing was changed, because a safe copy of the old data could not be saved. Try again later.'],
    [{ ok: true, unchanged: true }, 'This barcode was already linked to that product.']
  ];
  for (const [json, expected] of cases) {
    const { page } = await openScreen((b) => b.action === 'barcodeLink' ? { json: Object.assign({ message: 'raw' }, json) } : null, []);
    await page.fill('#bk-code', 'ABC-1234');
    await page.click('#bk-find');
    await page.waitForSelector('#bk-product');
    await page.selectOption('#bk-product', 'p1');
    await page.click('#bk-link');
    await page.click('#bk-confirm-go');
    await page.waitForFunction(() => /\S/.test(document.getElementById('bk-barcode-msg').textContent));
    assert.equal(await barcodeMsg(page), expected, JSON.stringify(json));
    await page.close();
  }
  const noField = await openScreen((b) => b.action === 'barcodeFind' ? { json: { ok: false, error: 'no_barcode_field', message: 'raw' } } : null, []);
  await noField.page.fill('#bk-code', '12345678');
  await noField.page.click('#bk-find');
  await noField.page.waitForFunction(() => /no barcode field/.test(document.getElementById('bk-barcode-msg').textContent));
});

test('the camera button is hidden when the browser cannot scan, and typing a code always works', { skip }, async () => {
  const { page } = await openScreen(null, [], 'test-token', () => { delete window.BarcodeDetector; });
  assert.equal(await page.$('#bk-scan'), null);
  await page.fill('#bk-code', '12345678');
  await page.click('#bk-find');
  await page.waitForSelector('#bk-product');
});

test('with a camera and a detector, Scan with the camera fills the code and stops the camera; a camera that cannot open says so', { skip }, async () => {
  const init = () => {
    window.BarcodeDetector = class { async detect() { return [{ rawValue: ' 98765432 ' }]; } };
    const media = { getUserMedia: async () => { const c = document.createElement('canvas'); c.width = 4; c.height = 4; window.__stopped = 0; const s = c.captureStream(); s.getTracks().forEach((t) => { const orig = t.stop.bind(t); t.stop = () => { window.__stopped++; orig(); }; }); return s; } };
    Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true });
  };
  const { page } = await openScreen(null, [], 'test-token', init);
  await page.click('#bk-scan');
  await page.waitForFunction(() => document.getElementById('bk-code').value === '98765432', null, { timeout: 8000 });
  assert.equal(await page.$('#bk-video'), null, 'the picture is closed after a code is read');
  assert.ok(await page.evaluate(() => window.__stopped) >= 1, 'the camera was stopped');
  const bad = await openScreen(null, [], 'test-token', () => {
    window.BarcodeDetector = class { async detect() { return []; } };
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => { throw new Error('denied'); } }, configurable: true });
  });
  await bad.page.click('#bk-scan');
  await bad.page.waitForFunction(() => /camera could not be opened/.test(document.getElementById('bk-barcode-msg').textContent));
});

test('nothing is written without the confirm panel: only csvCheck, barcodeFind and stockList are sent before a Confirm', { skip }, async () => {
  const calls = [];
  const { page } = await openScreen(null, calls);
  await file(page);
  await check(page);
  await page.fill('#bk-code', 'ABC-1234');
  await page.click('#bk-find');
  await page.waitForSelector('#bk-product');
  await page.selectOption('#bk-product', 'p1');
  await page.click('#bk-link');
  await page.waitForSelector('#bk-confirm', { state: 'visible' });
  assert.ok(actionsOf(calls).every((a) => ['csvCheck', 'barcodeFind', 'stockList'].includes(a)));
  assert.ok(calls.every((c) => !('sellerId' in c)));
});

test('the back arrow returns to Settings and closes the panel', { skip }, async () => {
  const { page } = await openScreen(null, []);
  await page.click('#bk-header-row button');
  assert.equal(await page.$eval('#bk-tab-content', (e) => e.style.display), 'none');
  assert.equal(await page.$eval('#settings-tab-content', (e) => e.style.display), 'block');
});
