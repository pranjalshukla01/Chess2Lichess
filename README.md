# Chess2Lichess

One click on a completed Chess.com game opens it on the Lichess analysis board.

## How it works

```
Chess.com tab                        Service worker                     Lichess
─────────────                        ──────────────                     ───────
[Analyze on Lichess] clicked
  open Share dialog, read PGN
  validate PGN
  ── message C2L_IMPORT_PGN ──────▶  verify sender, re-validate
                                     POST https://lichess.org/api/import
                                     (form field "pgn", anonymous)   ─▶  returns { url }
                                     check url is on lichess.org
                                     open it in a new tab
  ◀── { ok, url } ────────────────
```

| File | Responsibility |
|---|---|
| `manifest.json` | Permissions (`storage`, host access to lichess.org), scripts, popup |
| `content/content.js` | Injected button, Share dialog automation, PGN extraction, SPA handling |
| `background/background.js` | Message validation, Lichess import, retries, de-duplication, tab opening |
| `popup/*` | Toolbar popup: status, manual PGN paste |
| `utils/pgnValidator.js` | PGN validation shared by all three contexts |
| `styles/injected.css` | Styles for the injected button and fallback panel |
| `tests/` | `run-tests.js` (logic) and `e2e-mock.js` (Chromium against a mock page) |

## Install locally

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and choose this folder (the one containing `manifest.json`).
3. Open a finished game on `https://www.chess.com/game/live/...` or `/game/daily/...`.
4. Click the floating **Analyze on Lichess** button (or the toolbar icon, then the same button).

After editing code: click the reload icon on the extension card **and** refresh the Chess.com tab.

## Fixing it when Chess.com changes (read this first)

Chess.com's markup is not a public API. Everything that depends on it lives in the `CONFIG`
object at the top of `content/content.js`:

* `gamePathPatterns`: which URLs count as game pages.
* `shareButtonSelectors` / `shareButtonTextPattern`: how the Share button is found.
* `dialogSelectors`, `pgnTabTextPattern`, `pgnSourceSelectors`: how the dialog and PGN are found.

To debug: set `debug: true`, reload the extension, refresh the game page, and read the console
(`[Chess2Lichess] share button via ...`). To find better selectors, right-click the Share button
→ Inspect, prefer `aria-label`, `data-*`, `role`, and visible text over class names, and test them
with `document.querySelectorAll('...')` in the Console.

If the Share dialog only offers a **Copy** button and no readable text, automatic extraction
cannot work without clipboard permissions. The extension then shows a paste box so the
user can paste the PGN and send it.

## Tests

```
node tests/run-tests.js      # validator + service worker (mocked chrome and fetch)
node tests/e2e-mock.js       # loads the extension in Chromium against a MOCK Chess.com page
```

Neither touches the real Chess.com, so a green run does not prove the real selectors work.
Test on real games (live, daily, long games, games you only reviewed) before publishing.

## Privacy

The PGN of the game you export is sent to `https://lichess.org/api/import` and nowhere else.
No analytics, no accounts, no stored game data (only the last Lichess link, in session memory).

## Package for the Chrome Web Store

1. Raise `"version"` in `manifest.json` (every upload needs a higher number).
2. Replace the placeholder icons in `icons/` with your real logo (16, 48, 128 px PNG).
3. Zip the *contents* so `manifest.json` is at the zip root, leaving out tests and dev files:
   ```
   zip -r chess2lichess.zip manifest.json background content popup styles utils icons
   ```
4. Upload it at the Chrome Web Store Developer Dashboard (one-time registration fee applies).
5. Prepare: a single-purpose description, at least one 1280×800 screenshot, a privacy policy
   URL (you transmit game data to Lichess, so declare it), and a justification for each
   permission: `storage` = remembering the last import for de-duplication,
   `lichess.org` host access = sending the PGN to the import endpoint,
   Chess.com content script = adding the button and reading the PGN.
