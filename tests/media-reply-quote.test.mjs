// Run with:  node --test tests/*.test.mjs
// Reads the REAL sendReply / sendAttachment / reply-mode / double-click code out of index.html and runs it against a tiny fake
// page. No network, no real tokens, no real messages: everything below is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

function cut(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  assert.ok(a > 0, 'missing: ' + startMarker);
  const b = html.indexOf(endMarker, a);
  assert.ok(b > a, 'missing end for: ' + startMarker);
  return html.slice(a, b + endMarker.length);
}
const code = {
  escapeHtml: html.match(/function escapeHtml\(s\) \{[\s\S]*?\n\}/)[0],
  enqueueSend: cut('function enqueueSend(phone, job) {', '\n}\n'),
  sendAttachment: cut('async function sendAttachment(', '\n}\n'),
  sendReply: cut('window.sendReply = async function(phone) {', '\n};\n'),
  startReplyMode: cut('window.startReplyMode = function(', '\n};\n'),
  cancelReplyMode: cut('window.cancelReplyMode = function() {', '\n};\n'),
  dblclick: cut("document.addEventListener('dblclick', (e) => {", '\n  });')
};

function world() {
  const calls = []; // every fetch: { url, body }
  const elements = {
    'reply-text': { value: '', focus() {} },
    'reply-preview-bar': { classList: { add() {}, remove() {} } },
    'reply-preview-snippet': { textContent: '' }
  };
  let dbl = null;
  const document = {
    getElementById: (id) => elements[id] || null,
    createElement() {
      return {
        set textContent(v) { this._t = String(v); },
        get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
      };
    },
    addEventListener: (ev, fn) => { if (ev === 'dblclick') dbl = fn; }
  };
  const window = { _stagedAttachment: null, _isSending: false };
  const ctx = vm.createContext({
    document, window, Object, String, Array, Math, Promise, JSON, setTimeout,
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ success: true }) }; },
    alert() {}, logSystemError() {}, t: (k) => k
  });
  const script = `
    const SELLER_SEND_MEDIA_WEBHOOK = 'https://example.test/media';
    const SELLER_SEND_TEXT_WEBHOOK = 'https://example.test/text';
    const SELLER_CHAT_ID = 'seller-test';
    let activePhone = '000';
    let replyingTo = null;
    const drafts = {};
    const _sendPending = {}, _sendChains = {}, _needsReload = {};
    async function loadConversations() {}
    async function loadThread() {}
    async function getValidAuthToken() { return 'fake-token'; }
    function closeMessageActionMenu() {}
    function appendOptimisticBubble() { return 'tmp1'; }
    function markOptimisticSent() {}
    function markOptimisticFailed() {}
    function hideAttachmentPreviewBar() {}
    function toggleComposerButtons() {}
    ${code.escapeHtml}
    ${code.enqueueSend}
    ${code.sendAttachment}
    ${code.sendReply}
    ${code.startReplyMode}
    ${code.cancelReplyMode}
    var cancelReplyMode = window.cancelReplyMode, startReplyMode = window.startReplyMode;
    ${code.dblclick}
    ({ sendReply: window.sendReply, startReplyMode: window.startReplyMode, sendAttachment, replying: () => replyingTo, flush: () => Promise.all(Object.values(_sendChains)) })
  `;
  const api = vm.runInContext(script, ctx);
  let row_;
  const dblclickOn = (ds, text) => {
    row_ = {
      dataset: ds,
      closest() { return this; },
      querySelector: () => (text === null ? null : { textContent: text })
    };
    // the handler checks e.target.closest('.msg-row') and row.closest('#messages')
    dbl({ target: row_ });
  };
  return { api, calls, elements, window, dblclickOn };
}
const stage = (w, kind, mime, name) => { w.window._stagedAttachment = { dataUrl: 'data:' + mime + ';base64,AAAA', mimeType: mime, kind, fileName: name }; };
const KINDS = [['image', 'image/jpeg', 'p.jpg'], ['video', 'video/mp4', 'v.mp4'], ['document', 'application/pdf', 'f.pdf']];
const TARGETS = [['text message', 'wamid.TEXT1', 'hello customer'], ['voice note', 'wamid.VOICE1', ''], ['image', 'wamid.IMG1', '']];

for (const [tname, waId, ttext] of TARGETS) {
  for (const [kind, mime, name] of KINDS) {
    test(`reply to a ${tname} with a ${kind} (menu): the quote id and text reach the media request`, async () => {
      const w = world();
      w.api.startReplyMode('7', ttext, waId); // what the message menu does
      stage(w, kind, mime, name);
      w.elements['reply-text'].value = 'my caption';
      await w.api.sendReply('000');
      await w.api.flush();
      assert.equal(w.calls.length, 1);
      assert.equal(w.calls[0].url, 'https://example.test/media');
      assert.equal(w.calls[0].body.replyToWaId, waId);
      assert.equal(w.calls[0].body.replyToText, ttext);
      assert.equal(w.calls[0].body.attachmentKind, kind);
      assert.equal(w.calls[0].body.message, 'my caption');
      assert.equal(w.api.replying(), null, 'the reply bar is cleared after sending');
    });
  }
}

test('double-click on a row starts a reply WITH the WhatsApp id (text, voice, image rows)', async () => {
  for (const [, waId, ttext] of TARGETS) {
    const w = world();
    w.dblclickOn({ msgId: '9', waId, table: 'conversations' }, ttext === '' ? null : ttext);
    assert.equal(w.api.replying().waId, waId);
    assert.equal(w.api.replying().text, ttext);
    stage(w, 'image', 'image/jpeg', 'p.jpg');
    await w.api.sendReply('000');
    await w.api.flush();
    assert.equal(w.calls[0].body.replyToWaId, waId);
  }
});

test('double-click on a row without an id behaves as before (empty id)', () => {
  const w = world();
  w.dblclickOn({ msgId: '9', table: 'conversations' }, 'old message');
  assert.equal(w.api.replying().waId, '');
  assert.equal(w.api.replying().text, 'old message');
});

test('double-click on a call recording does nothing, as before', () => {
  const w = world();
  w.dblclickOn({ msgId: '9', waId: 'wamid.X', table: 'call_recordings' }, 'x');
  assert.equal(w.api.replying(), null);
});

test('PLAIN media (no reply) is unchanged: empty quote fields, same request', async () => {
  for (const [kind, mime, name] of KINDS) {
    const w = world();
    stage(w, kind, mime, name);
    w.elements['reply-text'].value = '';
    await w.api.sendReply('000');
    await w.api.flush();
    assert.deepEqual(w.calls[0].body, {
      phone: '000', sellerChatId: 'seller-test', token: 'fake-token', message: '',
      attachmentBase64: 'data:' + mime + ';base64,AAAA', attachmentMimeType: mime, attachmentKind: kind,
      attachmentFileName: name, replyToWaId: '', replyToText: ''
    });
  }
});

test('the quote is used once: the next media send after a quoted one has no quote', async () => {
  const w = world();
  w.api.startReplyMode('7', 'hello', 'wamid.T');
  stage(w, 'image', 'image/jpeg', 'p.jpg');
  await w.api.sendReply('000');
  stage(w, 'image', 'image/jpeg', 'p.jpg');
  await w.api.sendReply('000');
  await w.api.flush();
  assert.equal(w.calls[0].body.replyToWaId, 'wamid.T');
  assert.equal(w.calls[1].body.replyToWaId, '');
});

test('plain TEXT and quoted TEXT sends are unchanged', async () => {
  let w = world();
  w.elements['reply-text'].value = 'hi';
  await w.api.sendReply('000');
  await w.api.flush();
  assert.deepEqual(w.calls[0].body, { phone: '000', message: 'hi', sellerChatId: 'seller-test', token: 'fake-token', replyToWaId: '', replyToText: '' });
  assert.equal(w.calls[0].url, 'https://example.test/text');
  w = world();
  w.api.startReplyMode('7', 'quoted words', 'wamid.Q');
  w.elements['reply-text'].value = 'answer';
  await w.api.sendReply('000');
  await w.api.flush();
  assert.equal(w.calls[0].body.replyToWaId, 'wamid.Q');
  assert.equal(w.calls[0].body.replyToText, 'quoted words');
});

test('sendAttachment called without a quote still falls back to the open reply bar (older callers)', async () => {
  const w = world();
  w.api.startReplyMode('7', 'hello', 'wamid.F');
  await w.api.sendAttachment('data:image/jpeg;base64,AAAA', 'image/jpeg', 'image', 'p.jpg', '', '000');
  assert.equal(w.calls[0].body.replyToWaId, 'wamid.F');
  assert.equal(w.api.replying(), null);
});

test('service worker cache version is v57 or newer', () => {
  const m = sw.match(/CACHE_NAME = 'sparkly-shell-v(\d+)'/);
  assert.ok(m && Number(m[1]) >= 57);
});
