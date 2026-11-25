## TabYT 1.0.4 - Final Summary

### Core Fixes (1.0.3/1.0.4)
- **Live MutationObserver guard** - Re-applies `overflow: visible !important` when YouTube player JS resets it. Fixed `ReferenceError: overflowTargets is not defined`.
- **Control bar clamping** - `.ytp-chrome-bottom` / `.ytp-gradient-bottom` forced to `bottom: 0` via aggressive `overflow: visible !important`.
- **Shadow DOM traversal** - Walks closed shadow roots via `chrome.dom.openOrClosedShadowRoot` + fallback walk. Works with or without DevTools open.
- **DevTools clue resolved** - The guard uses closed shadow root traversal so it works both with and without DevTools.

### New Feature (1.0.4)
- **`playerResize: false` setting** - Player resizing is opt-in, off by default
- **Dashboard toggle** - "Player resizing" switch in Settings (off → on)
- When off: YouTube player keeps native dimensions
- When enabled: Player fills left column in 16:9 theater mode

### Build Status
- `npm run verify` ✅ Pass
- `npm test` 14/16 pass (2 pre-existing test failures unchanged)
- `dist/chrome` + `dist/firefox` built v1.0.4

### To Activate
1. `brave://extensions` → **Reload** TabYT
2. Hard-reload YouTube: `Ctrl+F5`
3. (Optional) Enable player resizing: Dashboard → Settings → toggle "Player resizing" on
4. Default: player stays at native dimensions, no theater mode forced resizing

### Library Plan
Created `PLAN_libraries.md` evaluating 5 libraries (Dexie.js, uPlot, Preact/Alpine.js, webextension-polyfill, SortableJS) with priorities and risks.