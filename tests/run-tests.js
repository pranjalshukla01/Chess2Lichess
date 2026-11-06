const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '\n      ', e.message); process.exitCode = 1; }
}

const SAMPLE = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.01.01"]
[White "alice"]
[Black "bob"]
[Result "1-0"]
[TimeControl "600"]

1. e4 {[%clk 0:09:58.9]} 1... e5 {[%clk 0:09:57.1]} 2. Qh5 {[%clk 0:09:50]} 2... Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

function loadValidator() {
  const ctx = vm.createContext({});
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(root, 'utils/pgnValidator.js'), 'utf8'), ctx);
  return ctx.Chess2LichessPgn;
}

function loadBackground({ fetchImpl }) {
  const calls = { tabsCreate: [], tabsUpdate: [], fetch: [] };
  let listener = null;
  const sessionStore = {};
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, Uint8Array, Array, Promise,
    AbortSignal, crypto: require('crypto').webcrypto, Date,
    chrome: {
      runtime: { id: 'testid', onInstalled: { addListener() {} }, onMessage: { addListener: (fn) => { listener = fn; } } },
      storage: { session: {
        get: async (k) => ({ [k]: sessionStore[k] }),
        set: async (o) => Object.assign(sessionStore, o),
      } },
      tabs: {
        create: async (o) => { calls.tabsCreate.push(o); return { id: 100 + calls.tabsCreate.length, windowId: 1 }; },
        update: async (id, o) => { calls.tabsUpdate.push([id, o]); if (id === 999) throw new Error('closed'); return { id, windowId: 1 }; },
      },
      windows: { update: async () => ({}) },
    },
    fetch: async (url, opts) => { calls.fetch.push({ url, opts }); return fetchImpl(calls.fetch.length); },
  });
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = (rel) => {
    const file = path.join(root, 'background', rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), ctx);
  const send = (message, sender) => new Promise((resolve) => {
    const keep = listener(message, sender, resolve);
    if (keep === false) resolve(undefined);
  });
  return { send, calls, sessionStore };
}

const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const status = (code, body = '') => ({ ok: false, status: code, json: async () => ({}), text: async () => body });
const contentSender = { id: 'testid', tab: { id: 1 }, url: 'https://www.chess.com/game/live/123' };
const popupSender = { id: 'testid', url: 'chrome-extension://testid/popup/popup.html' };

(async () => {
  console.log('PGN validator');
  const P = loadValidator();
  await test('accepts a Chess.com style PGN with clock comments', () => {
    const r = P.validatePgn(SAMPLE);
    assert.ok(r.valid, r.errors.join());
    assert.strictEqual(r.moveCount, 7);
    assert.strictEqual(r.headers.White, 'alice');
  });
  await test('rejects empty / whitespace', () => {
    assert.ok(!P.validatePgn('').valid);
    assert.ok(!P.validatePgn('   \n ').valid);
    assert.ok(!P.validatePgn(null).valid);
  });
  await test('rejects headers with no moves', () => assert.ok(!P.validatePgn('[Event "x"]\n[White "a"]\n').valid));
  await test('rejects garbage text', () => assert.ok(!P.validatePgn('hello world this is not chess').valid));
  await test('accepts bare movetext with a warning', () => {
    const r = P.validatePgn('1. e4 e5 2. Nf3 Nc6 3. O-O');
    assert.ok(r.valid); assert.ok(r.warnings.length > 0);
  });
  await test('handles promotion, castling, CRLF and variations', () => {
    const r = P.validatePgn('[Event "x"]\r\n\r\n1. e4 e5 (1... c5 2. Nf3) 2. O-O-O e8=Q+ 1/2-1/2');
    assert.ok(r.valid, r.errors.join());
  });
  await test('rejects oversized input', () => assert.ok(!P.validatePgn('[A "b"]\n\n' + '1. e4 '.repeat(100000)).valid));
  await test('looksLikePgn distinguishes PGN from other text', () => {
    assert.ok(P.looksLikePgn(SAMPLE));
    assert.ok(!P.looksLikePgn('https://www.chess.com/game/live/123456789'));
    assert.ok(!P.looksLikePgn('[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]'));
  });

  console.log('Service worker');
  await test('imports, POSTs form-encoded PGN, opens verified tab', async () => {
    const bg = loadBackground({ fetchImpl: () => okJson({ id: 'AbCdEfGh', url: 'https://lichess.org/AbCdEfGh' }) });
    const r = await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(bg.calls.tabsCreate[0].url, 'https://lichess.org/AbCdEfGh');
    const body = bg.calls.fetch[0].opts.body;
    assert.strictEqual(new URLSearchParams(body).get('pgn'), SAMPLE.trim());
    assert.strictEqual(bg.calls.fetch[0].opts.credentials, 'omit');
  });
  await test('rejects untrusted senders', async () => {
    const bg = loadBackground({ fetchImpl: () => okJson({}) });
    let r = await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, { id: 'evil', tab: { id: 1 }, url: 'https://www.chess.com/' });
    assert.strictEqual(r.code, 'UNTRUSTED_SENDER');
    r = await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, { id: 'testid', tab: { id: 1 }, url: 'https://evil.example/' });
    assert.strictEqual(r.code, 'UNTRUSTED_SENDER');
    assert.strictEqual(bg.calls.fetch.length, 0);
  });
  await test('accepts popup sender', async () => {
    const bg = loadBackground({ fetchImpl: () => okJson({ url: 'https://lichess.org/AbCdEfGh' }) });
    assert.ok((await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, popupSender)).ok);
  });
  await test('rejects malformed messages and invalid PGN without calling Lichess', async () => {
    const bg = loadBackground({ fetchImpl: () => okJson({}) });
    assert.strictEqual((await bg.send({ type: 'C2L_IMPORT_PGN', pgn: 42 }, contentSender)).code, 'INVALID_MESSAGE');
    assert.strictEqual((await bg.send({ type: 'C2L_IMPORT_PGN', pgn: 'nonsense' }, contentSender)).code, 'INVALID_PGN');
    assert.strictEqual(await bg.send({ type: 'SOMETHING_ELSE' }, contentSender), undefined);
    assert.strictEqual(bg.calls.fetch.length, 0);
  });
  await test('two simultaneous requests share one fetch', async () => {
    const bg = loadBackground({ fetchImpl: async () => { await new Promise((r) => setTimeout(r, 50)); return okJson({ url: 'https://lichess.org/AbCdEfGh' }); } });
    const [a, b] = await Promise.all([
      bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender),
      bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender),
    ]);
    assert.ok(a.ok && b.ok);
    assert.strictEqual(bg.calls.fetch.length, 1);
    assert.strictEqual(bg.calls.tabsCreate.length, 1);
  });
  await test('repeat within window re-focuses tab, no second POST', async () => {
    const bg = loadBackground({ fetchImpl: () => okJson({ url: 'https://lichess.org/AbCdEfGh' }) });
    await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender);
    const r = await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender);
    assert.ok(r.ok && r.deduped);
    assert.strictEqual(bg.calls.fetch.length, 1);
    assert.strictEqual(bg.calls.tabsCreate.length, 1);
    assert.strictEqual(bg.calls.tabsUpdate.length, 1);
  });
  await test('retries a 500 then succeeds', async () => {
    const bg = loadBackground({ fetchImpl: (n) => (n === 1 ? status(503) : okJson({ url: 'https://lichess.org/AbCdEfGh' })) });
    const r = await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender);
    assert.ok(r.ok); assert.strictEqual(bg.calls.fetch.length, 2);
  });
  await test('does not retry a 400; surfaces Lichess message and fallback URL', async () => {
    const bg = loadBackground({ fetchImpl: () => status(400, '{"error":"Invalid PGN"}') });
    const r = await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender);
    assert.strictEqual(r.code, 'LICHESS_REJECTED');
    assert.ok(r.error.includes('Invalid PGN'));
    assert.strictEqual(r.fallbackUrl, 'https://lichess.org/paste');
    assert.strictEqual(bg.calls.fetch.length, 1);
  });
  await test('maps 401 and 429 to specific codes', async () => {
    let bg = loadBackground({ fetchImpl: () => status(401) });
    assert.strictEqual((await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender)).code, 'LICHESS_AUTH_REQUIRED');
    bg = loadBackground({ fetchImpl: () => status(429) });
    assert.strictEqual((await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender)).code, 'RATE_LIMITED');
  });
  await test('refuses to open a non-lichess URL from the response', async () => {
    const bg = loadBackground({ fetchImpl: () => okJson({ url: 'https://evil.example/x' }) });
    const r = await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender);
    assert.strictEqual(r.code, 'LICHESS_BAD_RESPONSE');
    assert.strictEqual(bg.calls.tabsCreate.length, 0);
  });
  await test('network failure becomes NETWORK after retries', async () => {
    const bg = loadBackground({ fetchImpl: () => { throw new Error('offline'); } });
    const r = await bg.send({ type: 'C2L_IMPORT_PGN', pgn: SAMPLE }, contentSender);
    assert.strictEqual(r.code, 'NETWORK');
    assert.strictEqual(bg.calls.fetch.length, 3);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', with FAILURES' : ''}`);
})();
