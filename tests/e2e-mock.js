const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const EXT = path.join(__dirname, '..');
const PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.01.01"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. e4 {[%clk 0:09:58.9]} 1... e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

const html = (withShare) => `<!doctype html><html><body><main id="board">board</main>
${withShare ? '<button id="share" aria-label="Share">icon</button>' : ''}
<script>
  window.shareClicks = 0;
  const PGN = ${JSON.stringify(PGN)};
  const share = document.getElementById('share');
  if (share) share.addEventListener('click', () => {
    window.shareClicks++;
    if (document.querySelector('[role=dialog]')) return;
    setTimeout(() => {
      const d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.innerHTML = '<button aria-label="Close" id="x">x</button><div role="tab">Link</div><div role="tab" id="pgntab">PGN</div><div id="panel"></div>';
      document.body.appendChild(d);
      d.querySelector('#x').onclick = () => d.remove();
      d.querySelector('#pgntab').onclick = () => setTimeout(() => {
        const t = document.createElement('textarea'); t.value = PGN; d.querySelector('#panel').appendChild(t);
      }, 100);
    }, 300);
  });
</script></body></html>`;

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2l-'));
  const context = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log('  ok  ', name); } catch (e) { failures++; console.error('  FAIL', name, '\n      ', e.message); }
  };

  await context.route('https://www.chess.com/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    route.fulfill({ contentType: 'text/html', body: html(p.startsWith('/game/')) });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  console.log('service worker started:', sw.url().split('/').slice(-2).join('/'));

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('https://www.chess.com/game/live/123456789');
  await page.waitForSelector('#c2l-root .c2l-button', { timeout: 5000 });

  await check('button injected exactly once on a game page', async () => {
    assert.strictEqual(await page.locator('#c2l-root').count(), 1);
  });

  await check('rapid double click opens Share only once (duplicate-click guard)', async () => {
    const b = page.locator('#c2l-root .c2l-button');
    await b.dblclick();
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => window.shareClicks), 1);
  });

  await check('PGN is extracted, validated, sent; failure path shows panel with the PGN', async () => {
    await page.waitForSelector('#c2l-root .c2l-panel:not([hidden])', { timeout: 20000 });
    const value = await page.locator('#c2l-root .c2l-textarea').inputValue();
    assert.ok(value.startsWith('[Event "Live Chess"]'), 'panel should be prefilled with the extracted PGN');
    assert.ok(value.includes('4. Qxf7#'));
    const status = await page.locator('#c2l-root .c2l-status').innerText();
    console.log('       status shown:', JSON.stringify(status));
  });

  await check('Share dialog was closed after extraction', async () => {
    assert.strictEqual(await page.locator('[role=dialog]').count(), 0);
  });

  await check('SPA navigation away removes the button; returning restores exactly one', async () => {
    await page.evaluate(() => history.pushState({}, '', '/home'));
    await page.waitForFunction(() => !document.getElementById('c2l-root'), null, { timeout: 4000 });
    await page.evaluate(() => history.pushState({}, '', '/game/live/987654321'));
    await page.waitForSelector('#c2l-root .c2l-button', { timeout: 4000 });
    assert.strictEqual(await page.locator('#c2l-root').count(), 1);
  });

  await check('button re-injected if the site removes it', async () => {
    await page.evaluate(() => document.getElementById('c2l-root').remove());
    await page.waitForSelector('#c2l-root .c2l-button', { timeout: 3000 });
    assert.strictEqual(await page.locator('#c2l-root').count(), 1);
  });

  await check('navigating mid-extraction cancels quietly (no error panel)', async () => {
    await page.evaluate(() => { window.shareClicks = 0; });
    await page.locator('#c2l-root .c2l-button').click();
    await page.evaluate(() => history.pushState({}, '', '/home'));
    await page.waitForTimeout(2500);
    assert.strictEqual(await page.locator('#c2l-root').count(), 0);
    await page.evaluate(() => history.pushState({}, '', '/game/live/55555'));
    await page.waitForSelector('#c2l-root .c2l-button');
    const hidden = await page.locator('#c2l-root .c2l-panel').evaluate((el) => el.hidden);
    assert.ok(hidden, 'panel must be hidden after cancel');
    assert.strictEqual(await page.locator('#c2l-root .c2l-button').isDisabled(), false, 'button must be usable again');
  });

  await context.route('https://www.chess.com/game/live/424242', (r) => r.fulfill({ contentType: 'text/html', body: html(false) }));
  await check('no Share button on page -> clear error + manual paste panel', async () => {
    await page.goto('https://www.chess.com/game/live/424242');
    await page.waitForSelector('#c2l-root .c2l-button');
    await page.locator('#c2l-root .c2l-button').click();
    await page.waitForSelector('#c2l-root .c2l-panel:not([hidden])', { timeout: 5000 });
    const status = await page.locator('#c2l-root .c2l-status').innerText();
    assert.ok(/Share button/i.test(status), status);
    assert.strictEqual(await page.locator('#c2l-root .c2l-textarea').inputValue(), '');
  });

  await check('no button on a non-game page', async () => {
    await page.goto('https://www.chess.com/home');
    await page.waitForTimeout(800);
    assert.strictEqual(await page.locator('#c2l-root').count(), 0);
  });

  await check('no uncaught page errors', () => assert.deepStrictEqual(errors, []));

  await context.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall e2e checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
