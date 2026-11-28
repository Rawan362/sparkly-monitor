// Run with:  node --test tests/*.test.mjs
// The Settings row that opens the Delete my business screen says what it really does: it deletes the business data, not the login. Only the
// wording changed: the row, its click and the screen are the same. All 15 languages say it (the other languages are written with Unicode escapes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('this test file is ASCII; the row says "Delete my business data" in the page and in the English texts, and no English text still says "Delete my account"', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  assert.ok(html.includes('<span id="settings-label-delete">Delete my business data</span>'));
  assert.ok(html.includes("delete_account:'Delete my business data'"));
  assert.ok(!html.includes('Delete my account'), 'no English text promises to delete the account any more');
});

test('the row still opens the same screen, and the key is still set for the 15 languages', () => {
  assert.ok(html.includes('<div class="settings-row danger" onclick="confirmDeleteAccount()">'));
  assert.ok(html.includes("set('settings-label-delete', 'delete_account');"));
  assert.equal((html.match(/delete_account:'/g) || []).length, 15);
  assert.ok(html.includes('window.confirmDeleteAccount = function() {') && html.includes('openDeleteScreen()'));
});

// English first, then the 14 other languages in the order of the text tables (Arabic first).
const EXPECTED = [
  'Delete my business data',
  '\u062d\u0630\u0641 \u0628\u064a\u0627\u0646\u0627\u062a \u0639\u0645\u0644\u064a',
  'Eliminar los datos de mi negocio',
  'Supprimer les donn\u00e9es de mon entreprise',
  '\u0130\u015fletme verilerimi sil',
  '\u0645\u06cc\u0631\u06d2 \u06a9\u0627\u0631\u0648\u0628\u0627\u0631 \u06a9\u0627 \u0688\u06cc\u0679\u0627 \u062d\u0630\u0641 \u06a9\u0631\u06cc\u06ba',
  '\u092e\u0947\u0930\u0947 \u0935\u094d\u092f\u0935\u0938\u093e\u092f \u0915\u093e \u0921\u0947\u091f\u093e \u0939\u091f\u093e\u090f\u0902',
  '\u5220\u9664\u6211\u7684\u4e1a\u52a1\u6570\u636e',
  'Excluir os dados do meu neg\u00f3cio',
  'Meine Gesch\u00e4ftsdaten l\u00f6schen',
  '\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0434\u0430\u043d\u043d\u044b\u0435 \u043c\u043e\u0435\u0433\u043e \u0431\u0438\u0437\u043d\u0435\u0441\u0430',
  'Hapus data bisnis saya',
  '\u062d\u0630\u0641 \u062f\u0627\u062f\u0647\u200c\u0647\u0627\u06cc \u06a9\u0633\u0628\u200c\u0648\u06a9\u0627\u0631 \u0645\u0646',
  'Futa data ya biashara yangu',
  '\u0986\u09ae\u09be\u09b0 \u09ac\u09cd\u09af\u09ac\u09b8\u09be\u09b0 \u09a1\u09c7\u099f\u09be \u09ae\u09c1\u099b\u09c1\u09a8'
];
test('all 15 languages say "delete my business data" (not the account), in table order, written with Unicode escapes', () => {
  const found = [...html.matchAll(/delete_account:'([^']*)'/g)].map((m) => m[1]);
  assert.equal(found.length, 15);
  const esc = (x) => [...x].map((c) => (c.charCodeAt(0) < 128 ? c : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))).join('');
  assert.deepEqual(found, EXPECTED.map(esc));
  assert.ok(!/[^\x00-\x7f]/.test(found.join('')), 'the new texts hold no raw non-English characters');
});
