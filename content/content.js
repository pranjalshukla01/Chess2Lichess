(() => {
  'use strict';

  if (window.__chess2lichessLoaded) return;
  window.__chess2lichessLoaded = true;

  const Pgn = globalThis.Chess2LichessPgn;
  if (!Pgn) {
    console.error('[Chess2Lichess] pgnValidator.js did not load; content script stopped.');
    return;
  }

  const CONFIG = {
    debug: false,

    gamePathPatterns: [
      /^\/game\/(?:live|daily)\/\d+/,
      /^\/analysis\/game\/(?:live|daily)\/\d+/,
      /^\/(?:live|daily)\/game\/\d+/,
    ],

    shareButtonSelectors: [
      'button[aria-label*="share" i]',
      '[role="button"][aria-label*="share" i]',
      '[data-cy*="share" i]',
      'button[title*="share" i]',
    ],
    shareButtonTextPattern: /^share$/i,

    dialogSelectors: '[role="dialog"], [aria-modal="true"], [class*="modal" i]',
    pgnTabTextPattern: /^pgn$/i,
    pgnSourceSelectors:
      'textarea, input[type="text"], pre, code, [contenteditable="true"], [data-cy*="pgn" i], [class*="pgn" i]',
    closeButtonSelectors: '[aria-label*="close" i], [title*="close" i], button[class*="close" i]',

    modalTimeoutMs: 6000,
    successMessageMs: 6000,
  };

  const UI_ID = 'c2l-root';
  const PASTE_URL = 'https://lichess.org/paste';

  const MANUAL_PASTE_CODES = new Set([
    'SHARE_BUTTON_NOT_FOUND', 'MODAL_NOT_OPENED', 'PGN_NOT_FOUND', 'INVALID_PGN', 'TIMEOUT',
  ]);

  class ExtractionError extends Error {
    constructor(code, message, details) {
      super(message);
      this.code = code;
      this.details = details || {};
    }
  }

  const state = {
    busy: false,
    abort: null,
    lastHref: location.href,
    statusTimer: null,
  };

  let ui = null;

  const log = (...args) => { if (CONFIG.debug) console.log('[Chess2Lichess]', ...args); };

  function isGamePage() {
    return CONFIG.gamePathPatterns.some((pattern) => pattern.test(location.pathname));
  }

  function isInsideOurUi(el) {
    return Boolean(el.closest && el.closest('#' + UI_ID));
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function labelOf(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  }

  function findShareButton() {
    for (const selector of CONFIG.shareButtonSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!isInsideOurUi(el) && isVisible(el)) {
          log('share button via selector', selector, el);
          return el;
        }
      }
    }
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      if (!isInsideOurUi(el) && CONFIG.shareButtonTextPattern.test(labelOf(el)) && isVisible(el)) {
        log('share button via text', el);
        return el;
      }
    }
    return null;
  }

  function findDialog() {
    for (const el of document.querySelectorAll(CONFIG.dialogSelectors)) {
      if (!isInsideOurUi(el) && isVisible(el)) return el;
    }
    return null;
  }

  function readText(el) {
    return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
      ? el.value
      : el.textContent;
  }

  function readPgnFromDom() {
    const dialog = findDialog();
    const scopes = dialog ? [dialog, document] : [document];
    for (const scope of scopes) {
      let best = null;
      for (const el of scope.querySelectorAll(CONFIG.pgnSourceSelectors)) {
        if (isInsideOurUi(el)) continue;
        const text = readText(el);
        if (Pgn.looksLikePgn(text) && (!best || text.length > best.length)) {
          best = text;
          log('PGN source element', el);
        }
      }
      if (best) return best;
    }
    return null;
  }

  function clickPgnTab() {
    const dialog = findDialog();
    if (!dialog) return false;
    for (const el of dialog.querySelectorAll('button, [role="tab"], [role="button"], a, li, span')) {
      if (CONFIG.pgnTabTextPattern.test((el.textContent || '').trim()) && isVisible(el)) {
        log('clicking PGN tab', el);
        el.click();
        return true;
      }
    }
    return false;
  }

  function closeDialog() {
    const dialog = findDialog();
    if (!dialog) return;
    const closeButton = dialog.querySelector(CONFIG.closeButtonSelectors);
    if (closeButton && isVisible(closeButton)) {
      closeButton.click();
    } else {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
      );
    }
  }

  function waitFor(check, { timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let debounceTimer = null;
      const observer = new MutationObserver(() => schedule());
      const pollTimer = setInterval(schedule, 300);
      const timeoutTimer = setTimeout(
        () => finish(reject, new ExtractionError('TIMEOUT', 'Timed out waiting for Chess.com.')),
        timeoutMs
      );

      function cleanup() {
        observer.disconnect();
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        clearTimeout(debounceTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      }
      function onAbort() {
        finish(reject, new ExtractionError('CANCELLED', 'You moved to another game.'));
      }
      function schedule() {
        if (settled || debounceTimer) return;
        debounceTimer = setTimeout(run, 50);
      }
      function run() {
        debounceTimer = null;
        if (settled) return;
        try {
          const result = check();
          if (result) finish(resolve, result);
        } catch (err) {
          finish(reject, err);
        }
      }

      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      observer.observe(document.body, { childList: true, subtree: true });
      run();
    });
  }

  async function extractPgn(signal) {
    let openedByUs = false;

    if (!findDialog()) {
      const shareButton = findShareButton();
      if (!shareButton) {
        throw new ExtractionError(
          'SHARE_BUTTON_NOT_FOUND',
          'Could not find the Share button. Chess.com may have changed its layout, or the game is still loading.'
        );
      }
      shareButton.click();
      openedByUs = true;
    }

    const ctx = { sawDialog: false, tabAttempts: 0 };
    try {
      return await waitFor(() => {
        const pgn = readPgnFromDom();
        if (pgn) return pgn;
        if (findDialog()) {
          ctx.sawDialog = true;
          if (ctx.tabAttempts < 3) { ctx.tabAttempts++; clickPgnTab(); }
        }
        return null;
      }, { timeoutMs: CONFIG.modalTimeoutMs, signal });
    } catch (err) {
      if (err instanceof ExtractionError && err.code === 'TIMEOUT') {
        throw ctx.sawDialog
          ? new ExtractionError('PGN_NOT_FOUND', 'The Share dialog opened, but no readable PGN was found in it.')
          : new ExtractionError('MODAL_NOT_OPENED', 'The Share dialog did not open.');
      }
      throw err;
    } finally {
      if (openedByUs) closeDialog();
    }
  }

  async function sendToBackground(pgn) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'C2L_IMPORT_PGN', pgn });
        if (response) return response;
        lastError = new Error('empty response');
      } catch (err) {
        if (/context invalidated/i.test(err.message)) {
          throw new ExtractionError(
            'EXTENSION_RELOADED',
            'The extension was updated. Refresh this Chess.com tab and try again.'
          );
        }
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new ExtractionError(
      'MESSAGING_FAILED',
      'Could not reach the extension background worker. Try again.',
      { cause: String(lastError && lastError.message) }
    );
  }

  function result(ok, code, error, extra) {
    return Object.assign({ ok, code, error }, extra);
  }

  async function analyzeCurrentGame() {
    if (state.busy) return result(false, 'BUSY', 'An export is already running.');
    if (!isGamePage()) {
      return result(false, 'NOT_GAME_PAGE', 'Open a completed Chess.com game first.');
    }

    state.busy = true;
    state.abort = new AbortController();
    const { signal } = state.abort;
    const startHref = location.href;
    setBusyUi(true);
    hideFallbackPanel();

    try {
      setStatus('loading', 'Reading the game from Chess.com…');
      const rawPgn = await extractPgn(signal);

      if (signal.aborted || location.href !== startHref) {
        throw new ExtractionError('CANCELLED', 'You moved to another game.');
      }

      const check = Pgn.validatePgn(rawPgn);
      if (!check.valid) {
        throw new ExtractionError('INVALID_PGN', 'The PGN looks invalid: ' + check.errors.join(' '));
      }
      log('PGN ok:', check.moveCount, 'moves', check.warnings);

      setStatus('loading', 'Sending to Lichess…');
      const response = await sendToBackground(check.normalized);
      if (!response.ok) {
        throw new ExtractionError(response.code || 'IMPORT_FAILED', response.error || 'Lichess import failed.', {
          pgn: check.normalized,
        });
      }

      setStatus('success', 'Opened on Lichess.', CONFIG.successMessageMs);
      return result(true, 'OK', '', { url: response.url });
    } catch (err) {
      return handleFailure(err);
    } finally {
      state.busy = false;
      state.abort = null;
      setBusyUi(false);
    }
  }

  function handleFailure(err) {
    const error = err instanceof ExtractionError
      ? err
      : new ExtractionError('UNEXPECTED', 'Something unexpected went wrong: ' + (err && err.message));
    if (!(err instanceof ExtractionError)) console.error('[Chess2Lichess]', err);

    if (error.code === 'CANCELLED') {
      setStatus('idle', '');
      return result(false, error.code, error.message);
    }

    setStatus('error', error.message);
    if (MANUAL_PASTE_CODES.has(error.code)) {
      showFallbackPanel(
        'Paste the PGN instead',
        'On Chess.com, open Share, copy the PGN, and paste it below.',
        ''
      );
    } else if (error.details.pgn) {
      showFallbackPanel(
        'Import on Lichess yourself',
        'The PGN was read correctly. Copy it, then paste it on the Lichess import page.',
        error.details.pgn
      );
    }
    return result(false, error.code, error.message);
  }

  async function sendManualPgn() {
    if (state.busy) return;
    const check = Pgn.validatePgn(ui.textarea.value);
    if (!check.valid) {
      setStatus('error', 'That PGN is not valid: ' + check.errors.join(' '));
      return;
    }
    state.busy = true;
    setBusyUi(true);
    try {
      setStatus('loading', 'Sending to Lichess…');
      const response = await sendToBackground(check.normalized);
      if (response.ok) {
        setStatus('success', 'Opened on Lichess.', CONFIG.successMessageMs);
        hideFallbackPanel();
      } else {
        setStatus('error', response.error || 'Lichess import failed.');
      }
    } catch (err) {
      setStatus('error', err.message);
    } finally {
      state.busy = false;
      setBusyUi(false);
    }
  }

  async function copyPanelPgn() {
    const text = ui.textarea.value;
    if (!text.trim()) { setStatus('error', 'There is no PGN to copy yet.'); return; }
    try {
      await navigator.clipboard.writeText(text);
      setStatus('success', 'PGN copied.', 3000);
    } catch (_) {
      ui.textarea.select();
      setStatus('error', 'Copy blocked. The PGN is selected: press Ctrl+C (Cmd+C on Mac).');
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function actionButton(label, className, onClick) {
    const button = el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function buildUi() {
    const root = el('div');
    root.id = UI_ID;

    const mainButton = actionButton('Analyze on Lichess', 'c2l-button', () => { analyzeCurrentGame(); });

    const status = el('div', 'c2l-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    const panel = el('div', 'c2l-panel');
    panel.hidden = true;
    const panelTitle = el('p', 'c2l-panel-title');
    const panelMessage = el('p', 'c2l-panel-message');
    const textarea = el('textarea', 'c2l-textarea');
    textarea.rows = 6;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', 'PGN');
    textarea.placeholder = '[Event "Live Chess"]\n…\n\n1. e4 e5 2. Nf3 …';
    const buttons = el('div', 'c2l-row');
    buttons.append(
      actionButton('Send to Lichess', 'c2l-small c2l-small-primary', sendManualPgn),
      actionButton('Copy PGN', 'c2l-small', copyPanelPgn),
      actionButton('Open Lichess import', 'c2l-small', () => window.open(PASTE_URL, '_blank', 'noopener')),
      actionButton('Close', 'c2l-small', hideFallbackPanel)
    );
    panel.append(panelTitle, panelMessage, textarea, buttons);

    root.append(panel, status, mainButton);
    ui = { root, mainButton, status, panel, panelTitle, panelMessage, textarea };
    return root;
  }

  function ensureUi() {
    if (!document.body) return;
    if (document.getElementById(UI_ID)) return;
    document.body.appendChild(buildUi());
  }

  function removeUi() {
    const root = document.getElementById(UI_ID);
    if (root) root.remove();
    ui = null;
  }

  function syncUi() {
    if (isGamePage()) ensureUi();
    else removeUi();
  }

  function setStatus(kind, text, autoHideMs) {
    clearTimeout(state.statusTimer);
    if (!ui) return;
    ui.status.dataset.kind = kind;
    ui.status.textContent = text;
    ui.status.hidden = !text;
    if (autoHideMs) {
      state.statusTimer = setTimeout(() => { if (ui) ui.status.hidden = true; }, autoHideMs);
    }
  }

  function setBusyUi(busy) {
    if (!ui) return;
    ui.mainButton.disabled = busy;
    ui.mainButton.dataset.busy = String(busy);
  }

  function showFallbackPanel(title, message, pgn) {
    if (!ui) return;
    ui.panelTitle.textContent = title;
    ui.panelMessage.textContent = message;
    ui.textarea.value = pgn;
    ui.panel.hidden = false;
  }

  function hideFallbackPanel() {
    if (ui) ui.panel.hidden = true;
  }

  function onPossibleNavigation() {
    if (location.href === state.lastHref) return;
    state.lastHref = location.href;
    if (state.abort) state.abort.abort();
    setStatus('idle', '');
    hideFallbackPanel();
    syncUi();
  }

  const urlPollTimer = setInterval(() => { if (!document.hidden) onPossibleNavigation(); }, 1000);
  window.addEventListener('popstate', onPossibleNavigation);
  document.addEventListener('visibilitychange', onPossibleNavigation);

  let reinjectTimer = null;
  const bodyObserver = new MutationObserver(() => {
    if (reinjectTimer) return;
    reinjectTimer = setTimeout(() => { reinjectTimer = null; syncUi(); }, 250);
  });
  bodyObserver.observe(document.body, { childList: true });

  window.addEventListener('pagehide', () => {
    bodyObserver.disconnect();
    clearInterval(urlPollTimer);
    clearTimeout(reinjectTimer);
    if (state.abort) state.abort.abort();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === 'C2L_PING') {
      sendResponse({ ok: true, supported: isGamePage() });
      return false;
    }
    if (message.type === 'C2L_ANALYZE') {
      analyzeCurrentGame().then(sendResponse);
      return true;
    }
    return false;
  });

  syncUi();
  log('content script ready on', location.href);
})();
