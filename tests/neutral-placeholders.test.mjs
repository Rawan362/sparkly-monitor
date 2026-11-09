// Run with:  node --test tests/*.test.mjs
// The Business Profile placeholders must not suggest one country or currency (Sparkly sells worldwide).
// Only the example texts changed: the currency symbol list and the no-decimals list (which still contain IQD) are not touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const field = (id) => (html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>')) || [''])[0];

test('the invoice phone placeholder is a neutral example, still wired to the same field', () => {
  const el = field('biz-invoice-phone');
  assert.match(el, /placeholder="e\.g\. \+1 555 010 0100"/);
  assert.match(el, /data-key="invoice_phone"/);
  assert.match(el, /data-table="seller_sales_config"/);
  assert.match(el, /onchange="saveBizField\(this\)"/);
  assert.doesNotMatch(el, /964/);
});

test('the currency placeholder names no single market, still wired to the same field', () => {
  const el = field('biz-currency-label');
  assert.match(el, /placeholder="e\.g\. USD, EUR, GBP"/);
  assert.match(el, /data-key="currency_label"/);
  assert.match(el, /data-table="seller_sales_config"/);
  assert.doesNotMatch(el, /IQD/);
});

test('the currency lists are unchanged: IQD is still a supported currency (symbols and no-decimals)', () => {
  assert.match(html, /IQD: 'IQD', AED: 'AED'/);
  assert.match(html, /\['IQD','SYP','LBP','IRR','VND','IDR','KRW','JPY','UZS'\]/);
});
