# Sloptris

An offline-first Tetris for phones, built as a PWA. No build step and no dependencies.

- **Play:** serve this folder over HTTPS (GitHub Pages works) and open `index.html`.
  It also runs straight from disk, but installing to the home screen and offline
  caching need `http(s)`.
- **Controls:** drag to move, tap to rotate, flick down to hard drop, press and hold to
  fall faster, swipe up to hold. An on-screen button pad is available in the menu.
  Keyboard: arrows, Z/X, Space, C, P, R.
- **Music and effects** are synthesised in `audio.js` with Web Audio; there are no
  audio files.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup |
| `styles.css` | Styling |
| `game.js` | Game rules, rendering, input |
| `audio.js` | Music playlist and sound effects |
| `sw.js` | Service worker (offline cache) |
| `manifest.webmanifest`, `icons/` | Install metadata and icons |

When you change any cached file, bump `CACHE` in `sw.js` so installed copies update.
