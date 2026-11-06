# Chess2Lichess

A small Chrome extension that sends a finished Chess.com game to Lichess for analysis.

I got tired of the usual routine: open Share on Chess.com, copy the PGN, go to Lichess, paste it, hit import. This does it in one click. On a game page you get an "Analyze on Lichess" button in the bottom-right corner. Click it and the game opens on Lichess in a new tab.

## Install

It isn't on the Chrome Web Store, so you load it by hand:

1. Go to `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and pick this folder (the one with `manifest.json` in it).
3. Open a finished game on chess.com and refresh the tab.

After you change any file, hit the reload icon on the extension's card and refresh the Chess.com tab too. Open tabs keep running the old script.

## How it works

The content script opens Chess.com's Share dialog, reads the PGN out of it, checks that it looks like a real game, and closes the dialog again. It then hands the PGN to the background service worker, which POSTs it to Lichess's import endpoint (`https://lichess.org/api/import`) and opens the link Lichess sends back. The PGN goes in a form body, not the URL, so long games aren't a problem.

A few details worth knowing:

- Chess.com is a single-page app, so the script watches for URL changes and adds or removes the button as you move between pages. Navigating away mid-export cancels it.
- Clicking twice, or importing the same game twice within 15 seconds, reuses the first request instead of making a second one.
- Network errors and server errors are retried a couple of times. Anything else fails straight away with a message.
- If the PGN can't be read automatically, you get a small panel to paste it yourself. The toolbar popup has the same paste box.

## When it breaks

Chess.com's page markup isn't a public API and it changes without warning, so this is the part most likely to stop working. Everything that depends on it sits in the `CONFIG` object at the top of `content/content.js`: which URLs count as game pages, how the
