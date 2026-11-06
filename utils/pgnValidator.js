(function (global) {
  'use strict';

  const MAX_PGN_LENGTH = 500000;

  const HEADER_LINE = /^\[([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\]$/;

  const SAN_MOVE =
    /^(?:O-O(?:-O)?|0-0(?:-0)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?[!?]{0,2}$/;

  const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

  function normalizePgn(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/^\uFEFF/, '')
      .replace(/\u0000/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
  }

  function splitPgn(normalized) {
    const lines = normalized.split('\n');
    const headers = {};
    let headerCount = 0;
    let i = 0;

    for (; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        if (headerCount > 0) { i++; break; }
        continue;
      }
      const match = HEADER_LINE.exec(line);
      if (!match) break;
      headers[match[1]] = match[2].replace(/\\(["\\])/g, '$1');
      headerCount++;
    }
    return { headers, headerCount, movetext: lines.slice(i).join('\n') };
  }

  function parseMovetext(movetext) {
    let text = movetext
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/;[^\n]*/g, ' ')
      .replace(/\$\d+/g, ' ');

    let previous;
    do {
      previous = text;
      text = text.replace(/\([^()]*\)/g, ' ');
    } while (text !== previous);

    const tokens = text
      .replace(/\d+\.(?:\.\.)?/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    const moves = [];
    const unknown = [];
    let result = null;
    for (const token of tokens) {
      if (RESULT_TOKENS.has(token)) result = token;
      else if (SAN_MOVE.test(token)) moves.push(token);
      else unknown.push(token);
    }
    return { moves, unknown, result };
  }

  function validatePgn(text) {
    const errors = [];
    const warnings = [];
    const normalized = normalizePgn(text);
    let headers = {};
    let moveCount = 0;

    if (!normalized) {
      errors.push('The PGN is empty.');
    } else if (normalized.length > MAX_PGN_LENGTH) {
      errors.push('The PGN is too large.');
    } else {
      const parts = splitPgn(normalized);
      headers = parts.headers;
      if (parts.headerCount === 0) warnings.push('No PGN headers (White, Black, Result...) were found.');

      const parsed = parseMovetext(parts.movetext);
      moveCount = parsed.moves.length;
      if (moveCount === 0) errors.push('No moves were found.');
      if (parsed.unknown.length > 0) {
        warnings.push('Unrecognised tokens: ' + parsed.unknown.slice(0, 5).join(' '));
      }
    }

    return { valid: errors.length === 0, errors, warnings, headers, moveCount, normalized };
  }

  function looksLikePgn(text) {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (t.length < 30 || t.length > MAX_PGN_LENGTH) return false;
    return /^\[[A-Za-z]\w*\s+"/.test(t) && /(^|\s)1\.\s*[a-hKQRBNO]/.test(t);
  }

  global.Chess2LichessPgn = Object.freeze({
    MAX_PGN_LENGTH,
    normalizePgn,
    validatePgn,
    looksLikePgn,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
