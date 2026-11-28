// Run with:  node --test tests/*.test.mjs
// The Settings row that opens the Delete my business screen says what it really does: it deletes the business data, not the login. Only the
// wording changed: the row, its click and the screen are the same. English only here (the other languages keep their own text until translated).
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
