(() => {
  'use strict';

  const Pgn = globalThis.Chess2LichessPgn;
  const $ = (id) => document.getElementById(id);
  const els = {
    analyze: $('analyze'),
    status: $('status'),
    statusText: $('status-text'),
    last: $('last'),
    lastLink: $('last-link'),
    manual: $('manual'),
    pgnInput: $('pgn-input'),
    sendManual: $('send-manual'),
  };

  let activeTabId = null;
  let busy = false;

  function setState(state, text) {
    document.body.dataset.state = state;
    els.statusText.textContent = text || '';
    els.status.hidden = !text;
  }

  function setBusy(value) {
    busy = value;
    els.sendManual.disabled = value;
    els.analyze.disabled = value || !els.analyze.dataset.supported;
  }

  async function pingContentScript(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'C2L_PING' });
      return response && response.ok ? response : null;
    } catch (_) {
      return null;
    }
  }

  async function renderLastImport() {
    try {
      const { lastImport } = await chrome.storage.session.get('lastImport');
      if (lastImport && typeof lastImport.url === 'string' && lastImport.url.startsWith('https://lichess.org/')) {
        els.lastLink.href = lastImport.url;
        els.lastLink.textContent = lastImport.url.replace('https://', '');
        els.last.hidden = false;
      }
    } catch (_) {  }
  }

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab ? tab.id : null;

    const ping = activeTabId == null ? null : await pingContentScript(activeTabId);
    if (!ping) {
      setState('idle', 'Open a completed game on chess.com. If one is already open, refresh that tab once.');
    } else if (!ping.supported) {
      setState('idle', 'This Chess.com page is not a game. Open a completed game.');
    } else {
      els.analyze.dataset.supported = 'true';
      els.analyze.disabled = false;
      setState('idle', '');
    }
    renderLastImport();
  }

  async function onAnalyze() {
    if (busy || activeTabId == null) return;
    setBusy(true);
    setState('loading', 'Reading the game from Chess.com…');
    try {
      const response = await chrome.tabs.sendMessage(activeTabId, { type: 'C2L_ANALYZE' });
      if (!response) throw new Error('No response from the page.');
      if (response.ok) {
        setState('success', 'Opened on Lichess.');
      } else {
        setState('error', response.error || 'The export failed.');
        if (response.code !== 'BUSY' && response.code !== 'CANCELLED') els.manual.open = true;
      }
    } catch (_) {
      setState('error', 'Could not reach the Chess.com page. Refresh it and try again.');
      els.manual.open = true;
    } finally {
      setBusy(false);
      renderLastImport();
    }
  }

  async function onSendManual() {
    if (busy) return;
    const check = Pgn.validatePgn(els.pgnInput.value);
    if (!check.valid) {
      setState('error', 'That PGN is not valid: ' + check.errors.join(' '));
      return;
    }
    setBusy(true);
    setState('loading', 'Sending to Lichess…');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'C2L_IMPORT_PGN', pgn: check.normalized });
      if (response && response.ok) setState('success', 'Opened on Lichess.');
      else setState('error', (response && response.error) || 'Lichess import failed.');
    } catch (_) {
      setState('error', 'Could not reach the extension background worker. Try again.');
    } finally {
      setBusy(false);
      renderLastImport();
    }
  }

  els.analyze.addEventListener('click', onAnalyze);
  els.sendManual.addEventListener('click', onSendManual);
  document.addEventListener('DOMContentLoaded', init);
})();
