// Run with:  node --test tests/*.test.mjs
// Real-browser tests of the "Business name" field in Settings and of the business-name warning above the create buttons (Settings > Message
// templates, and the Start a new conversation panel). The REAL index.html runs in Chromium; Supabase and the template door are answered by the
// test, so nothing leaves the test and no real seller data is touched. If Playwright is not installed (it is installed in CI), these tests are skipped.
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

const LANGS = [{ code: 'en', label: 'English', defaultText: 'Hello! This is {{1}}. We are happy to help you with anything you need.' }];
const MSG_EMPTY = 'Please type your business name. It cannot be empty.';
const MSG_COMMA = 'The business name cannot contain a comma. Write only the short name, for example "Corner Shop". The rest of your business details is kept as it is.';
const MSG_LONG = 'The business name is too long. Please use 60 characters or fewer.';
const WARN_EMPTY = 'You have not set a business name yet, so your message would read oddly. Set a short business name first.';
const WARN_ODD = 'Your business name looks too long or unclear, so your message would read oddly. Set a short business name first.';

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

// `store.value` is the stored business_name_location; `store.patches` collects every write the app makes to the sellers row.
// `doorName` is the business name the template door reports (the part before the first comma, trimmed).
async function openScreen(store, doorName, o = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-message-templates$/.test(u)) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ ok: true, connected: true, templates: o.templates || [], languages: LANGS, businessName: doorName }) });
    }
    if (/\/rest\/v1\/sellers\?/.test(u)) {
      if (req.method() === 'PATCH') {
        store.patches.push({ url: u, body: JSON.parse(req.postData() || '{}') });
        if (store.failWrite) return route.fulfill({ status: 500, contentType: 'application/json', headers: h, body: '{}' });
        store.value = store.patches[store.patches.length - 1].body.business_name_location;
        return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify([{ chat_id: 'seller-test' }]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify([{ business_name_location: store.value }]) });
    }
    if (/seller_sales_config/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify([{ default_language: 'English' }]) });
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
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
        window._nctPollMs = 60000;
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  return { page, errors };
}
async function openSettings(store, doorName, o) {
  const r = await openScreen(store, doorName, o);
  await r.page.evaluate(() => { document.getElementById('business-tab-content').style.display = 'flex'; });
  await r.page.evaluate(() => bnLoad());
  return r;
}
const text = (page, id) => page.$eval('#' + id, (e) => e.textContent);
const shown = (page, id) => page.$eval('#' + id, (e) => getComputedStyle(e).display !== 'none');
const disabled = (page, id) => page.$eval('#' + id, (e) => e.disabled);
const openTemplates = async (page) => { await page.click('#tpl-box > summary'); await page.waitForFunction(() => document.getElementById('tpl-preview').textContent.startsWith('Preview:')); };
const newStore = (value) => ({ value, patches: [] });

test('a stored value with a comma: the field shows only the part before the first comma, trimmed', { skip }, async () => {
  const { page, errors } = await openSettings(newStore('  Corner Shop , 12 Example Street, Springfield'), 'Corner Shop');
  await page.waitForFunction(() => document.getElementById('bn-input').value === 'Corner Shop');
  assert.equal(await text(page, 'settings-label-bname'), 'Business name');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a stored value with no comma: the field shows the whole value', { skip }, async () => {
  const { page } = await openSettings(newStore('Corner Shop'), 'Corner Shop');
  await page.waitForFunction(() => document.getElementById('bn-input').value === 'Corner Shop');
  await page.close();
});

test('saving keeps everything from the first comma onward exactly, writes only that one field, and updates the template preview', { skip }, async () => {
  const store = newStore('Corner Shop, 12 Example Street,  Springfield (open daily)');
  const { page, errors } = await openSettings(store, 'Corner Shop');
  await openTemplates(page);
  assert.match(await text(page, 'tpl-preview'), /^Preview: Hello! This is Corner Shop\./);
  await page.fill('#bn-input', '  Daily Market  ');
  await page.click('#bn-save');
  await page.waitForFunction(() => document.getElementById('bn-msg').textContent.startsWith('Saved.'));
  assert.equal(store.patches.length, 1);
  assert.deepEqual(store.patches[0].body, { business_name_location: 'Daily Market, 12 Example Street,  Springfield (open daily)' });
  assert.match(store.patches[0].url, /sellers\?chat_id=eq\.seller-test/);
  assert.equal(await text(page, 'bn-msg'), 'Saved. Your business name is now "Daily Market".');
  assert.equal(await page.$eval('#bn-input', (e) => e.value), 'Daily Market');
  assert.equal(await text(page, 'tpl-preview'), 'Preview: Hello! This is Daily Market. We are happy to help you with anything you need.');
  assert.deepEqual(errors, []);
  await page.close();
});

test('saving a value that had no comma writes just the new name', { skip }, async () => {
  const store = newStore('Corner Shop');
  const { page } = await openSettings(store, 'Corner Shop');
  await page.fill('#bn-input', 'Daily Market');
  await page.click('#bn-save');
  await page.waitForFunction(() => document.getElementById('bn-msg').textContent.startsWith('Saved.'));
  assert.deepEqual(store.patches.map((p) => p.body), [{ business_name_location: 'Daily Market' }]);
  await page.close();
});

test('an empty name is refused in plain words and nothing is written', { skip }, async () => {
  const store = newStore('Corner Shop, Example Street');
  const { page } = await openSettings(store, 'Corner Shop');
  await page.fill('#bn-input', '   ');
  await page.click('#bn-save');
  assert.equal(await text(page, 'bn-msg'), MSG_EMPTY);
  assert.equal(store.patches.length, 0);
  await page.close();
});

test('a name with a comma is refused in plain words and nothing is written', { skip }, async () => {
  const store = newStore('Corner Shop, Example Street');
  const { page } = await openSettings(store, 'Corner Shop');
  await page.fill('#bn-input', 'Corner Shop, Springfield');
  await page.click('#bn-save');
  assert.equal(await text(page, 'bn-msg'), MSG_COMMA);
  assert.equal(store.patches.length, 0);
  await page.close();
});

test('a name over 60 characters is refused, 60 is accepted', { skip }, async () => {
  const store = newStore('Corner Shop');
  const { page } = await openSettings(store, 'Corner Shop');
  await page.fill('#bn-input', 'A'.repeat(61));
  await page.click('#bn-save');
  assert.equal(await text(page, 'bn-msg'), MSG_LONG);
  assert.equal(store.patches.length, 0);
  await page.fill('#bn-input', 'A'.repeat(60));
  await page.click('#bn-save');
  await page.waitForFunction(() => document.getElementById('bn-msg').textContent.startsWith('Saved.'));
  assert.equal(store.patches.length, 1);
  await page.close();
});

test('if the save fails the seller is told in plain words and the stored text is not changed', { skip }, async () => {
  const store = newStore('Corner Shop, Example Street'); store.failWrite = true;
  const { page } = await openSettings(store, 'Corner Shop');
  await page.fill('#bn-input', 'Daily Market');
  await page.click('#bn-save');
  await page.waitForFunction(() => document.getElementById('bn-msg').textContent.startsWith('Could not save'));
  assert.equal(await text(page, 'bn-msg'), 'Could not save your business name. Check your internet connection and try again.');
  assert.equal(store.value, 'Corner Shop, Example Street');
  await page.close();
});

test('Settings warning: empty business name warns, the create button waits for "Create it anyway"', { skip }, async () => {
  const { page } = await openSettings(newStore(''), '');
  await page.click('#tpl-box > summary');
  await page.waitForFunction(() => document.getElementById('tpl-text').value !== '');
  assert.equal(await shown(page, 'tpl-name-warning'), true);
  assert.equal(await text(page, 'tpl-name-warning-text'), WARN_EMPTY);
  assert.equal(await text(page, 'tpl-name-fix'), 'Set business name');
  assert.equal(await disabled(page, 'tpl-save'), true);
  await page.check('#tpl-name-confirm');
  assert.equal(await disabled(page, 'tpl-save'), false);
  await page.uncheck('#tpl-name-confirm');
  assert.equal(await disabled(page, 'tpl-save'), true);
  await page.click('#tpl-name-fix');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bn-input');
  await page.close();
});

test('Settings warning: a very long name and a whole sentence warn; a normal name does not; a text without {{1}} does not', { skip }, async () => {
  const cases = [
    ['A'.repeat(41), WARN_ODD],
    ['We sell the best shoes in the whole town.', WARN_ODD],
    ['Corner Shop', null],
    ['A'.repeat(40), null]
  ];
  for (const [name, expected] of cases) {
    const { page } = await openSettings(newStore(name), name);
    await page.click('#tpl-box > summary');
    await page.waitForFunction(() => document.getElementById('tpl-text').value !== '');
    assert.equal(await shown(page, 'tpl-name-warning'), expected !== null, name);
    if (expected) { assert.equal(await text(page, 'tpl-name-warning-text'), expected); assert.equal(await disabled(page, 'tpl-save'), true); }
    else assert.equal(await disabled(page, 'tpl-save'), false, 'a normal name leaves the create button available');
    await page.close();
  }
  const { page } = await openSettings(newStore(''), '');
  await page.click('#tpl-box > summary');
  await page.waitForFunction(() => document.getElementById('tpl-text').value !== '');
  await page.fill('#tpl-text', 'Hello! Thank you for contacting us.');
  assert.equal(await shown(page, 'tpl-name-warning'), false, 'the name is not used when the text has no {{1}}');
  assert.equal(await disabled(page, 'tpl-save'), false);
  await page.close();
});

test('Settings warning goes away after the seller saves a good business name', { skip }, async () => {
  const { page } = await openSettings(newStore(', Example Street'), '');
  await page.click('#tpl-box > summary');
  await page.waitForFunction(() => document.getElementById('tpl-text').value !== '');
  assert.equal(await shown(page, 'tpl-name-warning'), true);
  await page.fill('#bn-input', 'Daily Market');
  await page.click('#bn-save');
  await page.waitForFunction(() => document.getElementById('bn-msg').textContent.startsWith('Saved.'));
  assert.equal(await shown(page, 'tpl-name-warning'), false);
  assert.equal(await disabled(page, 'tpl-save'), false);
  await page.close();
});

async function openStartPanel(doorName) {
  const r = await openScreen(newStore(doorName), doorName);
  await r.page.evaluate(() => window.openNewConversationModal());
  await r.page.waitForFunction(() => document.getElementById('nct-title').textContent !== 'Checking your message templates...');
  return r;
}

test('Start a new conversation: empty, very long and sentence-like names warn and hold the create button; a normal name does not', { skip }, async () => {
  for (const [name, expected] of [['', WARN_EMPTY], ['A'.repeat(45), WARN_ODD], ['We are a family shop that sells many things.', WARN_ODD], ['Corner Shop', null]]) {
    const { page, errors } = await openStartPanel(name);
    assert.equal(await shown(page, 'nct-create'), true);
    assert.equal(await shown(page, 'nct-name-warning'), expected !== null, name);
    if (expected) {
      assert.equal(await text(page, 'nct-name-warning-text'), expected);
      assert.equal(await text(page, 'nct-name-fix'), 'Set business name');
      assert.equal(await disabled(page, 'nct-create'), true);
      await page.check('#nct-name-confirm');
      assert.equal(await disabled(page, 'nct-create'), false, 'available only after the seller confirms');
    } else assert.equal(await disabled(page, 'nct-create'), false);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('Start a new conversation: the warning button closes the panel and takes the seller to the Business name field', { skip }, async () => {
  const { page } = await openStartPanel('');
  await page.evaluate(() => { document.getElementById('business-tab-content').style.display = 'flex'; window.openBusinessPanel = async () => {}; });
  await page.click('#nct-name-fix');
  await page.waitForFunction(() => document.getElementById('new-conversation-modal').style.display === 'none');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'bn-input');
  await page.close();
});

test('the example texts of the new field are neutral (no country, currency or language)', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const block = html.slice(html.indexOf('id="settings-label-bname"'), html.indexOf('id="settings-label-templates"'));
  assert.match(block, /placeholder="e\.g\. Corner Shop"/);
  assert.doesNotMatch(block, /Iraq|Baghdad|Erbil|IQD|964|Arabic|Kurd/i);
});
