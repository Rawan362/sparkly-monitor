// Run with:  node --test tests/*.test.mjs
// Ads screen extras (build chat W1): the detailed report with a choice of metrics (read only) and Ad settings (default metrics, daily digest,
// alert rules). The Seller Ads door is answered by the test: nothing leaves the test and nothing reaches Meta.
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
  const start = html.indexOf('w1-ads-extras:' + kind + ':start');
  const end = html.indexOf('w1-ads-extras:' + kind + ':end');
  assert.ok(start > 0 && end > start, 'marked block missing: ' + kind);
  return html.slice(start, end);
}
test('the new Ads extras code and this test file contain only ASCII characters', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = { 'this test file': fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'), css: marked(html, 'css'), js: marked(html, 'js') };
  for (const [name, text] of Object.entries(files)) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127).length;
    assert.equal(bad, 0, name + ' has ' + bad + ' non-ASCII characters');
  }
});

test('the cache name is at least v73 and the Ads screen has one new one-line hook', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(Number((sw.match(/sparkly-shell-v(\d+)'/) || [])[1]) >= 73);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(html.split('\n').filter((l) => l.includes("typeof w1AdsSettingsAndReports === 'function'")).length, 1);
});

test('the honest alert words are in the page, so no promise of an alert can be shown', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const block = marked(html, 'js');
  assert.ok(block.includes('No automatic check of these rules was found, so no alert will be sent for now.'));
  assert.ok(!/we will alert you|you will be alerted|we will notify you/i.test(block));
});

// ---- Browser tests ----
const OVERVIEW = { ok: true, currency: 'CUR', dailyCap: 100, totalActiveDailyBudget: 50, activeWithUnknownBudget: 0, objects: [{ id: 'c1', name: 'Campaign A', level: 'campaign', campaignId: null, status: 'ACTIVE', dailyBudget: 30, lifetimeBudget: false }] };
const PREPARED = (summary, warning) => ({ ok: true, needsConfirm: true, confirmToken: 'tok-1', expiresAt: new Date(Date.now() + 300000).toISOString(), preview: Object.assign({ summary: summary || 'Do it.' }, warning ? { warning } : {}) });
const REPORT = (o) => Object.assign({
  ok: true, label: 'Last 7 days', level: 'campaign', metrics: ['spend', 'ctr', 'cpa', 'messages_started'], moneyMetrics: ['spend', 'cpa'], currency: 'CUR', savedMetricsUsed: false, ignoredMetrics: [],
  rows: [
    { name: 'Campaign A', values: { spend: '12.50', ctr: '3.2', cpa: 4.1, messages_started: 5 } },
    { name: 'Campaign B', values: { spend: '7', ctr: '1.1', cpa: null }, cpaSpendSoFar: 7 }
  ]
}, o || {});

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

async function openAds(answer, calls) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (/\/webhook\/seller-ads$/.test(u)) {
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
      await page.evaluate(() => {
        SELLER_CHAT_ID = 'seller-test';
        document.getElementById('app').style.display = 'flex';
        document.querySelectorAll('[id*="land"], [class*="land-"]').forEach((el) => { el.style.display = 'none'; });
        window.getValidAuthToken = async () => 'test-token';
        document.getElementById('settings-tab-content').style.display = 'block';
      });
      break;
    } catch (e) { if (attempt === 5) throw e; await page.waitForTimeout(500); }
  }
  await page.evaluate(() => { const r = document.getElementById('ax-menu-row'); (r.closest('.dx-zone') || r).style.display = ''; }); await page.evaluate(() => { const r = document.getElementById('ax-menu-row'); (r.closest('.dx-zone') || r).style.display = ''; }); await page.evaluate(() => { const r = document.getElementById('ax-menu-row'); (r.closest('.dx-zone') || r).style.display = ''; }); await page.click('#ax-menu-row');
  await page.waitForSelector('#ag-show');
  return { page, errors };
}
function defaults(body) {
  if (body.action === 'overview') return { json: OVERVIEW };
  if (body.action === 'prepare') return { json: PREPARED() };
  if (body.action === 'confirm') return { json: { ok: true, applied: 'x', verified: true, currency: 'CUR' } };
  if (body.action === 'report_metrics') return { json: REPORT() };
  return { json: { ok: false, code: 'bad_action', message: 'x' } };
}
const actionsOf = (calls) => calls.map((c) => c.action);
const prepares = (calls) => calls.filter((c) => c.action === 'prepare').map((c) => c.change);
const reports = (calls) => calls.filter((c) => c.action === 'report_metrics');
const out = (page) => page.$eval('#ag-report-out', (e) => e.textContent);
const runReport = async (page) => { await page.click('#ag-show'); await page.waitForFunction(() => { const t = document.getElementById('ag-report-out').textContent; return t !== '' && !/^Loading/.test(t); }); };
const tick = async (page, scope, ...keys) => { for (const k of keys) await page.check('#' + scope + ' input[value="' + k + '"]'); };

test('the report sends report_metrics with the period, the level and the chosen metrics, never a seller id', { skip }, async () => {
  const calls = [];
  const { page, errors } = await openAds(null, calls);
  await tick(page, 'ag-report-ticks', 'spend', 'ctr');
  await runReport(page);
  assert.deepEqual(reports(calls), [{ token: 'test-token', action: 'report_metrics', reportMetrics: { range: 'last_7d', level: 'campaign', metrics: ['spend', 'ctr'] } }]);
  await page.selectOption('#ag-range', 'last_90d');
  await page.selectOption('#ag-level', 'ad');
  await page.fill('#ag-one', ' Spring ');
  await page.uncheck('#ag-report-ticks input[value="spend"]');
  await page.uncheck('#ag-report-ticks input[value="ctr"]');
  await runReport(page);
  assert.deepEqual(reports(calls)[1].reportMetrics, { range: 'last_90d', level: 'ad', nameHint: 'Spring' }, 'no metrics ticked: the field is left out');
  assert.ok(calls.every((c) => !('sellerId' in c)));
  assert.deepEqual(errors, []);
});

test('the table shows plain metric names, money with the seller currency, no purchases yet with the spend so far, and a dash for a metric Meta did not give', { skip }, async () => {
  const { page } = await openAds(null, []);
  await runReport(page);
  const head = await page.$$eval('#ag-table th', (e) => e.map((x) => x.textContent));
  assert.deepEqual(head, ['Name', 'Spend', 'Click rate (%)', 'Cost per purchase', 'Conversations started']);
  const rows = await page.$$eval('#ag-table tr:not(:first-child)', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  assert.deepEqual(rows[0], ['Campaign A', '12.50 CUR', '3.2', '4.1 CUR', '5']);
  assert.deepEqual(rows[1], ['Campaign B', '7 CUR', '1.1', 'no purchases yet (spend so far 7 CUR)', '-']);
});

test('no currency word is invented when the door sends none; saved and ignored metrics are explained', { skip }, async () => {
  const { page } = await openAds((b) => b.action === 'report_metrics' ? { json: REPORT({ currency: null, savedMetricsUsed: true, ignoredMetrics: ['old_one'] }) } : null, []);
  await runReport(page);
  const t = await out(page);
  assert.ok(!/CUR|undefined|null|NaN/.test(t));
  assert.match(t, /Showing your saved metrics\./);
  assert.match(t, /Left out because they are not known: old_one/);
});

test('a custom period needs two valid dates; nothing is sent until they are right', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  await page.selectOption('#ag-range', 'custom');
  await page.click('#ag-show');
  assert.equal(await out(page), 'Choose a period, or two dates.');
  await page.fill('#ag-since', '2026-03-10'); await page.fill('#ag-until', '2026-03-01');
  await page.click('#ag-show');
  assert.equal(await out(page), 'Choose a period, or two dates.');
  assert.equal(reports(calls).length, 0);
  await page.fill('#ag-until', '2026-03-20');
  await runReport(page);
  assert.deepEqual(reports(calls)[0].reportMetrics, { range: 'custom', level: 'campaign', since: '2026-03-10', until: '2026-03-20' });
});

test('report refusals are shown in plain words; a read problem offers Try again; ambiguous names are buttons', { skip }, async () => {
  const cases = [
    [{ code: 'ads_not_connected' }, 'Your ads account is not connected yet.'],
    [{ code: 'not_found' }, 'We could not find that item.'],
    [{ code: 'no_data' }, 'No data for this period.'],
    [{ code: 'meta_error', message: 'Meta says no.' }, 'Meta could not give this report: Meta says no.'],
    [{ code: 'bad_metric', message: 'That metric is not valid.' }, 'That metric is not valid.'],
    [{ code: 'relogin' }, 'Please sign out and sign in again, then try once more.'],
    [{ code: 'strange' }, 'Something went wrong. Please try again.']
  ];
  for (const [json, expected] of cases) {
    const { page } = await openAds((b) => b.action === 'report_metrics' ? { json: Object.assign({ ok: false, message: 'raw' }, json) } : null, []);
    await runReport(page);
    assert.equal(await out(page), expected, json.code);
    await page.close();
  }
  const calls = [];
  const down = await openAds((b) => b.action === 'report_metrics' ? { json: { ok: false, code: 'meta_unavailable', message: 'x' } } : null, calls);
  await runReport(down.page);
  assert.match(await out(down.page), /We could not read your data\. Try again in a moment\./);
  await down.page.click('#ag-retry');
  await down.page.waitForFunction(() => document.getElementById('ag-retry'));
  assert.equal(reports(calls).length, 2);
  const amb = await openAds((b) => b.action === 'report_metrics' ? (b.reportMetrics.nameHint === 'Spring ad 2' ? { json: REPORT() } : { json: { ok: false, code: 'ambiguous', message: 'x', names: ['Spring ad 1', 'Spring ad 2'] } }) : null, []);
  await amb.page.fill('#ag-one', 'Spring');
  await runReport(amb.page);
  assert.match(await out(amb.page), /More than one matches: Spring ad 1, Spring ad 2\. Pick one\./);
  await amb.page.click('.ag-pick:nth-of-type(2)');
  await amb.page.waitForSelector('#ag-table');
  assert.equal(await amb.page.$eval('#ag-one', (e) => e.value), 'Spring ad 2');
});

test('the report only reads: no confirm panel opens and only overview and report_metrics are sent', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  await runReport(page);
  assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
  assert.deepEqual([...new Set(actionsOf(calls))].sort(), ['overview', 'report_metrics']);
});

test('default metrics: none ticked asks for at least one and sends nothing; ticked metrics go to prepare and need Confirm; they stay ticked after', { skip }, async () => {
  const calls = [];
  const { page } = await openAds((b) => b.action === 'prepare' ? { json: PREPARED('Save your default metrics: Spend, Clicks.') } : null, calls);
  await page.click('#ag-save-metrics');
  assert.equal(await page.$eval('#ag-msg-metrics', (e) => e.textContent), 'Choose at least one metric from the list.');
  assert.deepEqual(actionsOf(calls), ['overview']);
  await tick(page, 'ag-metrics-ticks', 'spend', 'clicks');
  await page.click('#ag-save-metrics');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'set_metrics', metrics: ['spend', 'clicks'] }]);
  assert.match(await page.$eval('#ax-confirm-summary', (e) => e.textContent), /Save your default metrics/);
  assert.equal(actionsOf(calls).includes('confirm'), false);
  await page.click('#ax-confirm-go');
  await page.waitForFunction(() => /Done\./.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || '') && document.querySelector('#ag-metrics-ticks input[value="spend"]'));
  assert.equal(actionsOf(calls).filter((a) => a === 'confirm').length, 1);
  assert.deepEqual(await page.$$eval('#ag-metrics-ticks input:checked', (i) => i.map((x) => x.value)), ['spend', 'clicks']);
});

test('daily digest: ticked metrics go to prepare as set_digest; Cancel changes nothing and remembers nothing', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  assert.deepEqual(await page.$$eval('#ag-digest-ticks input', (i) => i.map((x) => x.value)), ['spend', 'clicks', 'ctr', 'cpc', 'cpm', 'reach', 'frequency', 'messages_started', 'actions', 'cpa', 'cost_per_message', 'roas']);
  await tick(page, 'ag-digest-ticks', 'spend', 'roas');
  await page.click('#ag-save-digest');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'set_digest', metrics: ['spend', 'roas'] }]);
  await page.click('#ax-confirm-cancel');
  await page.waitForTimeout(200);
  assert.equal(actionsOf(calls).includes('confirm'), false);
  assert.equal(await page.evaluate(() => AG_state.savedDigest), null);
});

test('alert rules: the honest words are always visible, a rule goes through prepare and Confirm, and the door warning is shown in full in the panel', { skip }, async () => {
  const calls = [];
  const warning = 'No automatic check of these rules was found, so no alert will be sent for now.';
  const { page } = await openAds((b) => b.action === 'prepare' ? { json: PREPARED('Add the alert rule: Click rate (%) below 2.', warning) } : null, calls);
  assert.match(await page.$eval('#ag-honest', (e) => e.textContent), /No automatic check of these rules was found, so no alert will be sent for now\./);
  await page.fill('#ag-rule-number', 'abc');
  await page.click('#ag-add-rule');
  assert.equal(await page.$eval('#ag-msg-rules', (e) => e.textContent), 'Enter a number.');
  assert.deepEqual(actionsOf(calls), ['overview']);
  await page.selectOption('#ag-rule-metric', 'ctr');
  await page.selectOption('#ag-rule-condition', 'below');
  await page.fill('#ag-rule-number', '2');
  await page.click('#ag-add-rule');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'add_alert_rule', alert: { metric: 'ctr', condition: 'below', threshold: 2 } }]);
  assert.equal(await page.$eval('#ag-warning', (e) => e.textContent), warning);
  assert.equal(await page.$eval('#ag-warning', (e) => e.getAttribute('role')), 'alert');
  assert.equal(actionsOf(calls).includes('confirm'), false);
  assert.ok(!(await page.$eval('#ax-confirm', (e) => e.textContent)).match(/we will alert|you will be alerted/i));
  await page.click('#ax-confirm-go');
  await page.waitForFunction(() => document.querySelectorAll('#ag-rule-list li').length === 1);
  assert.equal(await page.$eval('#ag-rule-list li', (e) => e.textContent), 'Click rate (%) below 2');
  assert.match(await page.$eval('#ag-honest', (e) => e.textContent), /no alert will be sent for now/);
});

test('a rule that is cancelled is not listed; the warning of one panel does not stay in the next', { skip }, async () => {
  const calls = [];
  const reply = (b) => b.action === 'prepare' ? { json: b.change.type === 'add_alert_rule' ? PREPARED('Add the rule.', 'No automatic check was found.') : PREPARED('Pause it.') } : null;
  const { page } = await openAds(reply, calls);
  await page.fill('#ag-rule-number', '5');
  await page.click('#ag-add-rule');
  await page.waitForSelector('#ag-warning');
  await page.click('#ax-confirm-cancel');
  assert.equal(await page.$$eval('#ag-rule-list li', (e) => e.length), 0);
  await page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.equal(await page.$('#ag-warning'), null, 'no warning on a panel that has none');
});

test('settings refusals are shown in plain words', { skip }, async () => {
  const cases = [
    ['set_metrics', { metrics: ['spend'] }, { code: 'bad_metrics', message: 'x' }, 'Choose at least one metric from the list.', 'ag-msg-metrics'],
    ['add_alert_rule', { alert: { metric: 'ctr', condition: 'below', threshold: 2 } }, { code: 'bad_alert', message: 'The condition must be above or below.' }, 'The condition must be above or below.', 'ag-msg-rules'],
    ['add_alert_rule', { alert: { metric: 'ctr', condition: 'below', threshold: 2 } }, { code: 'too_many_rules', message: 'x' }, 'You can have at most 50 alert rules.', 'ag-msg-rules'],
    ['set_digest', { metrics: ['spend'] }, { code: 'undo_copy_failed', message: 'x' }, 'Nothing was changed. Try again.', 'ag-msg-digest'],
    ['set_digest', { metrics: ['spend'] }, { code: 'unavailable', message: 'x' }, 'Nothing was changed. Try again.', 'ag-msg-digest']
  ];
  for (const [type, extra, reply, expected, msgId] of cases) {
    const { page } = await openAds((b) => b.action === 'prepare' ? { json: Object.assign({ ok: false }, reply) } : null, []);
    await page.evaluate(([t, e]) => { return agPrepare(Object.assign({ type: t }, e), t === 'set_metrics' ? 'ag-msg-metrics' : t === 'set_digest' ? 'ag-msg-digest' : 'ag-msg-rules'); }, [type, extra]);
    await page.waitForFunction((id) => document.getElementById(id).textContent !== '', msgId);
    assert.equal(await page.$eval('#' + msgId, (e) => e.textContent), expected, reply.code);
    assert.equal(await page.$eval('#ax-confirm', (e) => e.style.display), 'none');
    await page.close();
  }
});

test('at Confirm, a failed save of a setting says nothing was changed, while the older limit message for other changes is unchanged', { skip }, async () => {
  const notSaved = (b) => b.action === 'confirm' ? { json: { ok: false, code: 'not_saved', message: 'x' } } : null;
  const a = await openAds(notSaved, []);
  await tick(a.page, 'ag-digest-ticks', 'spend');
  await a.page.click('#ag-save-digest');
  await a.page.click('#ax-confirm-go');
  await a.page.waitForFunction(() => /Nothing was changed\. Try again\./.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || ''));
  const b = await openAds(notSaved, []);
  await b.page.click('[data-ax-id="c1"] .ax-actions button:first-child');
  await b.page.click('#ax-confirm-go');
  await b.page.waitForFunction(() => /The limit could not be saved\. Nothing was changed\./.test((document.querySelector('[data-ax-msg="top"]') || {}).textContent || ''));
});

test('Undo last change is still on the screen and works for these settings (it prepares undo_last and needs Confirm)', { skip }, async () => {
  const calls = [];
  const { page } = await openAds((b) => b.action === 'prepare' ? { json: PREPARED('Undo the last change: put the digest back to off.') } : null, calls);
  await page.click('#ae-undo-last');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  assert.deepEqual(prepares(calls), [{ type: 'undo_last' }]);
  assert.equal(actionsOf(calls).includes('confirm'), false);
});

test('nothing is saved without the confirm panel: before Confirm only overview, report_metrics and prepare are sent', { skip }, async () => {
  const calls = [];
  const { page } = await openAds(null, calls);
  await runReport(page);
  await tick(page, 'ag-metrics-ticks', 'spend');
  await page.click('#ag-save-metrics');
  await page.waitForSelector('#ax-confirm', { state: 'visible' });
  await page.waitForTimeout(500);
  assert.ok(actionsOf(calls).every((a) => ['overview', 'report_metrics', 'prepare'].includes(a)));
  assert.ok(calls.every((c) => !('sellerId' in c)));
});
