// Run with:  node --test tests/*.test.mjs
// The inbox screen sends "token" (the logged-in person's access token) in the existing POST body to the Answer Inbox Question door, in both
// places that call it (the answer box and the "send the correction" step of the agent card). Everything else in the body is unchanged. With no
// token readable the answer is still sent as before. The door is faked by the test: nothing leaves the test; the token is a made-up word.
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

test('this test file has only ASCII; the door address is unchanged; both calls get the token from the one helper', () => {
  assert.equal([...fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')].filter((c) => c.charCodeAt(0) > 127).length, 0);
  assert.ok(html.includes("const ANSWER_INBOX_WEBHOOK_URL = 'https://sparklly.site/webhook/answer-inbox-question';"));
  assert.equal((html.match(/fetch\(ANSWER_INBOX_WEBHOOK_URL/g) || []).length, 2, 'still exactly two calls');
  assert.equal((html.match(/w1InboxToken\(\)/g) || []).length, 3, 'the helper and its two uses');
  const h = html.slice(html.indexOf('async function w1InboxToken'), html.indexOf('async function w1InboxToken') + 200);
  assert.ok(!/[^\x00-\x7f]/.test(h) && !/console\./.test(h) && !/localStorage|sessionStorage/.test(h));
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

// `ctl.answer` is what the door answers; `bodies` collects every body sent to it; `alerts` every message shown.
async function open(ctl) {
  ctl = Object.assign({ answer: { success: true } }, ctl || {});
  const bodies = []; const alerts = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(obj) });
    if (/\/webhook\/answer-inbox-question$/.test(u)) { bodies.push(JSON.parse(route.request().postData() || '{}')); return json(200, ctl.answer); }
    return json(200, []);
  });
  await page.goto(base + '/index.html');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    SELLER_CHAT_ID = 'web_s1';
    window.closeInboxDetail = function () {}; window.loadInboxList = async function () {}; window.checkInboxDot = async function () {};
  });
  return { page, bodies, alerts, ctl };
}
const tokenIs = (page, value) => page.evaluate((v) => { window.getValidAuthToken = v === null ? async () => null : v === 'throw' ? async () => { throw new Error('x'); } : async () => v; }, value);
const answerBox = (page, text, file) => page.evaluate(([t, f]) => {
  inboxCurrentQuestion = { id: 'q1' }; inboxSelectedScope = 'this_customer'; inboxAttachedFile = f ? { url: 'https://example.com/a.png', name: 'a.png', isImage: true, isVideo: false } : null;
  document.getElementById('inbox-detail-answer').value = t;
  return submitInboxAnswer();
}, [text, file]);

test('the answer box sends token with the same fields as before', { skip }, async () => {
  const { page, bodies } = await open();
  await tokenIs(page, 'made-up-token');
  await answerBox(page, 'Yes, we have it');
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], { questionId: 'q1', answerText: 'Yes, we have it', scope: 'this_customer', token: 'made-up-token' });
  await page.close();
});

test('the answer box with a file sends token and the file fields as before', { skip }, async () => {
  const { page, bodies } = await open();
  await tokenIs(page, 'made-up-token');
  await answerBox(page, 'See the picture', true);
  assert.deepEqual(bodies[0], { questionId: 'q1', answerText: 'See the picture', scope: 'this_customer', fileUrl: 'https://example.com/a.png', fileName: 'a.png', isImage: true, isVideo: false, token: 'made-up-token' });
  await page.close();
});

test('the agent card "send the correction" step sends token with the same fields as before', { skip }, async () => {
  const { page, bodies } = await open();
  await tokenIs(page, 'made-up-token');
  await page.evaluate(() => {
    inboxCurrentQuestion = { id: 'q2', meta: {}, phone_number: '1' };
    document.getElementById('inbox-agent-adjust-text').value = 'Be shorter';
    document.getElementById('inbox-agent-send').checked = true;
    document.getElementById('inbox-agent-draft').value = 'Sorry about that';
    agentDraftReady = true;
    window.agentSaveResolutions = async function () {}; window.agentCloseCard = async function () {};
    return agentSaveAdjust();
  });
  assert.deepEqual(bodies[0], { questionId: 'q2', answerText: 'Sorry about that', scope: 'this_customer', token: 'made-up-token' });
  await page.close();
});

test('no token can be read: the answer is still sent exactly as before, without a token field', { skip }, async () => {
  for (const mode of [null, 'throw']) {
    const { page, bodies } = await open();
    await tokenIs(page, mode);
    await answerBox(page, 'Plain answer');
    assert.equal(bodies.length, 1, 'still sent');
    assert.deepEqual(bodies[0], { questionId: 'q1', answerText: 'Plain answer', scope: 'this_customer' });
    await page.close();
  }
});

test('the door refusing the login shows its plain words; a good answer shows the normal message', { skip }, async () => {
  const { page, alerts } = await open({ answer: { success: false, error: 'Please sign out and sign in again, then try once more.' } });
  await tokenIs(page, 'made-up-token');
  await answerBox(page, 'Hello');
  assert.ok(alerts.some((a) => a.includes('Please sign out and sign in again, then try once more.')));
  await page.close();
  const ok = await open({ answer: { success: true } });
  await tokenIs(ok.page, 'made-up-token');
  await answerBox(ok.page, 'Hello');
  assert.ok(ok.alerts.some((a) => a.startsWith('Sent to this customer.')));
  await ok.page.close();
});
