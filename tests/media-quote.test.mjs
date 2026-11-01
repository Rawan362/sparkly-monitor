// Run with:  node --test tests/*.test.mjs
// Reads the REAL quote code out of index.html (between the <media-quote> markers) and runs it against a tiny fake page.
// No network, no real tokens, no real messages: everything below is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

const region = (() => {
  const a = html.indexOf('// <media-quote>');
  const b = html.indexOf('// </media-quote>');
  assert.ok(a > 0 && b > a, 'media-quote markers are missing');
  return html.slice(a, b);
})();

// A fake page: the real escapeHtml works through a div's textContent/innerHTML, which escapes & < > (not quotes), like a browser.
class FakeBox {
  constructor(waId) { this.attrs = new Map([['data-quote-wa', waId], ['hidden', '']]); this.innerHTML = ''; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  get hidden() { return this.attrs.has('hidden'); }
}
function load(boxes = []) {
  const document = {
    body: null,
    addEventListener() {},
    createElement() {
      return {
        set textContent(v) { this._t = String(v); },
        get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
      };
    },
    querySelectorAll: (sel) => (sel === '.msg-reply-quote-media[hidden]' ? boxes.filter((b) => b.hidden) : [])
  };
  const window = {};
  const ctx = vm.createContext({ document, window, Object, String, Array, Math, MutationObserver: class { observe() {} } });
  const escapeHtml = html.match(/function escapeHtml\(s\) \{[\s\S]*?\n\}/)[0];
  const api = vm.runInContext(
    `${escapeHtml}\n${region}\n({ replyQuoteHtmlFor, rememberMessageForQuotes, quoteInfoFromMessage, quoteInnerHtml, fillMediaQuotes, store: () => window._quoteSource })`,
    ctx
  );
  return { api, boxes };
}

const PHOTO = String.fromCodePoint(0x1f5bc, 0xfe0f);
const VIDEO = String.fromCodePoint(0x1f3a5);
const FILE = String.fromCodePoint(0x1f4c4);
const VOICE = String.fromCodePoint(0x1f3a4);
const PIN = String.fromCodePoint(0x1f4cd);

test('a TEXT quote is drawn exactly as before (byte for byte)', () => {
  const { api } = load();
  assert.equal(
    api.replyQuoteHtmlFor({ reply_to_wa_id: 'wamid.X', reply_to_text: 'hello there' }),
    `<div class="msg-reply-quote" onclick="event.stopPropagation(); jumpToQuoted('wamid.X')">hello there</div>`
  );
  // the older, optimistic spelling and the 80-character cut and the escaping are unchanged too
  assert.equal(
    api.replyQuoteHtmlFor({ reply_to_wa_id: 'wamid.X', replyToText: 'a'.repeat(100) }),
    `<div class="msg-reply-quote" onclick="event.stopPropagation(); jumpToQuoted('wamid.X')">${'a'.repeat(80)}</div>`
  );
  assert.equal(
    api.replyQuoteHtmlFor({ reply_to_wa_id: 'wamid.X', reply_to_text: '<b>&' }),
    `<div class="msg-reply-quote" onclick="event.stopPropagation(); jumpToQuoted('wamid.X')">&lt;b&gt;&amp;</div>`
  );
  // text but no id: still drawn, with an empty jump target, as before
  assert.equal(
    api.replyQuoteHtmlFor({ reply_to_text: 'orphan' }),
    `<div class="msg-reply-quote" onclick="event.stopPropagation(); jumpToQuoted('')">orphan</div>`
  );
});

test('no quote at all: nothing is drawn, as before', () => {
  const { api } = load();
  assert.equal(api.replyQuoteHtmlFor({}), '');
  assert.equal(api.replyQuoteHtmlFor({ message: 'x', reply_to_wa_id: '', reply_to_text: '' }), '');
  assert.equal(api.replyQuoteHtmlFor({ reply_to_wa_id: null, reply_to_text: null }), '');
});

test('a quote id with no quote text (a quoted photo, video, voice note or file) is a hidden placeholder', () => {
  const { api } = load();
  assert.equal(
    api.replyQuoteHtmlFor({ reply_to_wa_id: 'wamid.P', reply_to_text: null }),
    `<div class="msg-reply-quote msg-reply-quote-media" data-quote-wa="wamid.P" hidden onclick="event.stopPropagation(); jumpToQuoted('wamid.P')"></div>`
  );
});

test('every kind of media message is described in words', () => {
  const { api } = load();
  const q = api.quoteInfoFromMessage;
  assert.deepEqual({ ...q(`${PHOTO} Photo: https://f.test/a.jpg`) }, { label: 'Photo', thumb: 'https://f.test/a.jpg' });
  assert.deepEqual({ ...q(`${PHOTO} Photo: https://f.test/a.jpg | nice dress`) }, { label: 'Photo: nice dress', thumb: 'https://f.test/a.jpg' });
  assert.deepEqual({ ...q(`${VIDEO} Video: https://f.test/v.mp4`) }, { label: 'Video', thumb: '' });
  assert.deepEqual({ ...q(`${VIDEO} Video: https://f.test/v.mp4 | clip`) }, { label: 'Video: clip', thumb: '' });
  assert.deepEqual({ ...q(`${FILE} File: invoice.pdf | https://f.test/d.pdf`) }, { label: 'invoice.pdf', thumb: '' });
  assert.deepEqual({ ...q(`${VOICE} Voice: https://f.test/v.ogg`) }, { label: 'Voice note', thumb: '' });
  assert.deepEqual({ ...q('[Voice note sent]') }, { label: 'Voice note', thumb: '' });
  assert.deepEqual({ ...q(`${PIN} Location: 33.3,44.4`) }, { label: 'Location', thumb: '' });
  assert.deepEqual({ ...q('[Photo sent]') }, { label: 'Photo', thumb: '' });
  assert.deepEqual({ ...q('[Photo] a caption') }, { label: 'Photo', thumb: '' });
  assert.deepEqual({ ...q('[File sent: report.xlsx]') }, { label: 'report.xlsx', thumb: '' });
  // plain text and nothing are not media
  assert.equal(q('just words'), null);
  assert.equal(q(''), null);
  assert.equal(q(undefined), null);
  // long captions and names are cut
  assert.equal(q(`${PHOTO} Photo: https://f.test/a.jpg | ${'c'.repeat(100)}`).label, `Photo: ${'c'.repeat(40)}…`);
});

test('a thumbnail is used only for a plain http(s) address', () => {
  const { api } = load();
  assert.equal(api.quoteInfoFromMessage(`${PHOTO} Photo: javascript:alert(1)`).thumb, '');
  assert.equal(api.quoteInfoFromMessage(`${PHOTO} Photo: data:image/png;base64,AAAA`).thumb, '');
  assert.equal(api.quoteInfoFromMessage(`${PHOTO} Photo: https://f.test/a"onerror="x`).thumb, '');
  assert.equal(api.quoteInnerHtml({ label: 'Photo', thumb: '' }), '<span>Photo</span>');
  assert.equal(
    api.quoteInnerHtml({ label: '<img src=x onerror=1>', thumb: 'https://f.test/a.jpg' }),
    '<img class="msg-reply-quote-thumb" src="https://f.test/a.jpg" alt="" loading="lazy"><span>&lt;img src=x onerror=1&gt;</span>'
  );
});

test('a placeholder is filled from the message it quotes, and shown', () => {
  const boxes = [new FakeBox('wamid.P'), new FakeBox('wamid.V'), new FakeBox('wamid.T'), new FakeBox('wamid.GONE')];
  const { api } = load(boxes);
  api.rememberMessageForQuotes({ wa_message_id: 'wamid.P', message: `${PHOTO} Photo: https://f.test/a.jpg` });
  api.rememberMessageForQuotes({ wa_message_id: 'wamid.V', message: `${VOICE} Voice: https://f.test/v.ogg` });
  api.rememberMessageForQuotes({ wa_message_id: 'wamid.T', message: 'a plain text message' });
  api.fillMediaQuotes();
  assert.equal(boxes[0].hidden, false);
  assert.match(boxes[0].innerHTML, /^<img class="msg-reply-quote-thumb" src="https:\/\/f\.test\/a\.jpg"/);
  assert.match(boxes[0].innerHTML, /<span>Photo<\/span>$/);
  assert.equal(boxes[1].hidden, false);
  assert.equal(boxes[1].innerHTML, '<span>Voice note</span>');
  // a quoted text message, or one that is not on the page, leaves the box hidden: exactly what the app did before
  assert.equal(boxes[2].hidden, true);
  assert.equal(boxes[3].hidden, true);
  assert.equal(boxes[3].innerHTML, '');
});

test('filling is safe to repeat and picks up a message that is drawn later', () => {
  const boxes = [new FakeBox('wamid.LATER')];
  const { api } = load(boxes);
  api.fillMediaQuotes();
  assert.equal(boxes[0].hidden, true);
  api.rememberMessageForQuotes({ wa_message_id: 'wamid.LATER', message: `${VIDEO} Video: https://f.test/v.mp4` });
  api.fillMediaQuotes();
  api.fillMediaQuotes();
  assert.equal(boxes[0].hidden, false);
  assert.equal(boxes[0].innerHTML, '<span>Video</span>');
});

test('remembering messages draws nothing, ignores rows without an id or text, and stays small', () => {
  const { api } = load();
  api.rememberMessageForQuotes({ message: 'no id' });
  api.rememberMessageForQuotes({ wa_message_id: 'wamid.E', message: '' });
  api.rememberMessageForQuotes(null);
  assert.equal(api.store(), undefined);
  api.rememberMessageForQuotes({ wa_message_id: 'wamid.A', message: 'x'.repeat(5000) });
  assert.equal(api.store()['wamid.A'].length, 2000);
  for (let i = 0; i < 3100; i++) api.rememberMessageForQuotes({ wa_message_id: `wamid.${i}`, message: 'm' });
  assert.ok(Object.keys(api.store()).length <= 3000);
});

test('the page really uses it: renderBubble calls the helper and the old inline quote code is gone', () => {
  const start = html.indexOf('function renderBubble(m) {');
  const end = html.indexOf('window.openAhmadChat', start);
  const body = html.slice(start, end);
  assert.match(body, /rememberMessageForQuotes\(m\);\s*const replyQuoteHtml = replyQuoteHtmlFor\(m\);/);
  assert.doesNotMatch(body, /const quoteSrc = /);
  assert.match(html, /\.msg-reply-quote-media\[hidden\] \{ display: none; \}/);
});

test('the service worker cache version was bumped so devices load this version', () => {
  assert.match(sw, /const CACHE_NAME = 'sparkly-shell-v\d+';/);
  assert.ok(Number(sw.match(/sparkly-shell-v(\d+)/)[1]) >= 56);
});
