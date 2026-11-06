'use strict';

importScripts('../utils/pgnValidator.js');

const Pgn = self.Chess2LichessPgn;

const LICHESS_ORIGIN = 'https://lichess.org';
const LICHESS_IMPORT_ENDPOINT = `${LICHESS_ORIGIN}/api/import`;
const LICHESS_PASTE_URL = `${LICHESS_ORIGIN}/paste`;

const DEDUPE_WINDOW_MS = 15000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

const inFlight = new Map();

class ImportError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Chess2Lichess] installed/updated:', details.reason);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedSender(sender)) {
    sendResponse(fail('UNTRUSTED_SENDER', 'Message rejected: unknown sender.'));
    return false;
  }
  if (!message || message.type !== 'C2L_IMPORT_PGN') return false;

  handleImport(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[Chess2Lichess] unexpected error', err);
      sendResponse(fail('INTERNAL', 'Unexpected error in the extension.'));
    });
  return true;
});

function isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const url = typeof sender.url === 'string' ? sender.url : '';
  if (sender.tab) return url.startsWith('https://www.chess.com/');
  return url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function fail(code, error) {
  return { ok: false, code, error, fallbackUrl: LICHESS_PASTE_URL };
}

async function handleImport(message) {
  if (typeof message.pgn !== 'string') {
    return fail('INVALID_MESSAGE', 'The extension sent an unreadable message.');
  }

  const check = Pgn.validatePgn(message.pgn);
  if (!check.valid) {
    return fail('INVALID_PGN', 'The PGN is not valid: ' + check.errors.join(' '));
  }

  const hash = await sha256Hex(check.normalized);

  const recent = await findRecentImport(hash);
  if (recent) {
    const focused = await focusExistingTab(recent.tabId);
    if (!focused) await openTab(recent.url);
    return { ok: true, url: recent.url, deduped: true };
  }

  if (inFlight.has(hash)) return inFlight.get(hash);
  const job = importToLichess(check.normalized, hash).finally(() => inFlight.delete(hash));
  inFlight.set(hash, job);
  return job;
}

async function importToLichess(pgn, hash) {
  try {
    const data = await postPgnWithRetry(pgn);
    const url = extractLichessUrl(data);
    const tab = await openTab(url);
    await rememberImport({ hash, url, tabId: tab && tab.id, ts: Date.now() });
    return { ok: true, url };
  } catch (err) {
    if (err instanceof ImportError) return fail(err.code, err.message);
    console.error('[Chess2Lichess] import failed', err);
    return fail('IMPORT_FAILED', 'Could not open the game on Lichess.');
  }
}

async function postPgnWithRetry(pgn) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    try {
      return await postPgnOnce(pgn);
    } catch (err) {
      lastError = err;
      if (!(err instanceof ImportError) || !err.retryable) throw err;
    }
  }
  throw lastError;
}

async function postPgnOnce(pgn) {
  let response;
  try {
    response = await fetch(LICHESS_IMPORT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ pgn }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ImportError('NETWORK', 'Could not reach Lichess. Check your connection.', true);
  }

  if (response.ok) {
    try {
      return await response.json();
    } catch (err) {
      throw new ImportError('LICHESS_BAD_RESPONSE', 'Lichess returned an unexpected response.');
    }
  }
  if (response.status === 429) {
    throw new ImportError('RATE_LIMITED', 'Lichess is limiting imports. Wait a minute and try again.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ImportError('LICHESS_AUTH_REQUIRED', 'Lichess refused the anonymous import.');
  }
  if (response.status >= 500) {
    throw new ImportError('LICHESS_UNAVAILABLE', `Lichess had a server error (${response.status}).`, true);
  }
  const detail = await safeReadError(response);
  throw new ImportError('LICHESS_REJECTED', `Lichess rejected the PGN${detail ? ': ' + detail : '.'}`);
}

async function safeReadError(response) {
  try {
    const text = (await response.text()).slice(0, 200);
    try {
      const json = JSON.parse(text);
      if (json && typeof json.error === 'string') return json.error;
    } catch (_) {  }
    return text.trim();
  } catch (_) {
    return '';
  }
}

function extractLichessUrl(data) {
  let candidate = data && typeof data.url === 'string' ? data.url : null;
  if (!candidate && data && typeof data.id === 'string' && /^[A-Za-z0-9]{8,12}$/.test(data.id)) {
    candidate = `${LICHESS_ORIGIN}/${data.id}`;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.origin === LICHESS_ORIGIN) return parsed.href;
  } catch (_) {  }
  throw new ImportError('LICHESS_BAD_RESPONSE', 'Lichess did not return a valid game link.');
}

async function openTab(url) {
  try {
    return await chrome.tabs.create({ url, active: true });
  } catch (err) {
    throw new ImportError('LICHESS_OPEN_FAILED', 'Could not open a new Lichess tab.');
  }
}

async function focusExistingTab(tabId) {
  if (typeof tabId !== 'number') return false;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (!tab) return false;
    await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch (_) {
    return false;
  }
}

async function findRecentImport(hash) {
  try {
    const { lastImport } = await chrome.storage.session.get('lastImport');
    if (lastImport && lastImport.hash === hash && Date.now() - lastImport.ts < DEDUPE_WINDOW_MS) {
      return lastImport;
    }
  } catch (_) {  }
  return null;
}

async function rememberImport(record) {
  try {
    await chrome.storage.session.set({ lastImport: record });
  } catch (_) {  }
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
