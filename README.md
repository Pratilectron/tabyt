# TabYT

**A local-only YouTube tab memory manager for Chrome and Firefox.**

TabYT shows how much memory your open YouTube tabs are using, lets you close one tab or all of them in a click, saves the video title and playback position before closing, and brings you back to exactly where you stopped.

Everything stays on your device. TabYT has no servers, no analytics, no accounts and makes no network requests.

[![tests](https://img.shields.io/badge/tests-29%20passing-blue?style=flat-square&logo=node.js)](test/core.test.mjs)
[![version](https://img.shields.io/badge/v1.0.23-blue?style=flat-square&logo=github-actions)](https://github.com/Pratilectron/tabyt/commits/main)
[![license](https://img.shields.io/github/license/Pratilectron/tabyt?style=flat-square&logo=mit&label=License)](LICENSE)
[![mv3](https://img.shields.io/badge/manifest-v3-blue?style=flat-square&logo=github)](manifests/chrome.json)

---

## Features

- **Per-tab memory readings** — every open YouTube tab is ranked by an estimated memory footprint, with the active tab, playing videos and sleeping tabs called out.
- **One-click cleanup** — close a single tab or use **Save & close all**.
- **Save and resume** — closing through TabYT stores the video title, channel, thumbnail and playback timestamp. Resume opens the video at the saved position, or switches to an already-open tab and seeks it.
- **Inactive tab cleanup** — optionally close background YouTube tabs after 5 minutes to 24 hours of inactivity. Pinned, audible and playing tabs can be protected.
- **Memory limits** — set a combined limit (default 1.5 GB), get a notification when you cross it, and optionally let TabYT close the least recently used eligible tabs.
- **Local memory history** — sampling every 5–60 minutes, kept for 1–30 days, with a chart, peak/average readings and a "biggest offenders" ranking.
- **Full dashboard** — overview, tabs, saved videos, history, settings and help, plus a compact popup for quick actions.
- **Watch-page layout** — a fixed two-column shell for YouTube videos: title, description, comments and related videos move into a right rail with its own scrollbars, while the player keeps the whole column visible. Switching tabs or opening a related video never reloads the page.
- **Custom player controls** — TabYT's own control bar replaces YouTube's, with a seek bar, playback rate cycling and tooltips.
- **Export and delete** — download a JSON copy of your data or remove everything at any time.

---

## Screenshots

The watch page becomes a two-column layout — the left column is the player and the right rail carries the Info, Comments, Other videos and Related tabs.

---

## Install

No build tools are required to use a release build. The unpacked builds are produced by `npm run build`.

### Chrome, Edge, Brave and other Chromium browsers

1. Run `npm run build` (or unzip a release package). This writes `manifest.json` in the project folder and the icons the manifest points at.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this project folder (`tabyt`, the folder that contains `manifest.json`). `dist/chrome` is the same extension packaged for a store build.
5. Pin TabYT from the puzzle-piece menu if you want the toolbar badge.

If Chrome reports **Manifest file is missing or unreadable**, the selected folder is not the one that contains `manifest.json`. Select the project folder again, or select `dist/chrome` after a build.

### Firefox

1. Run `npm run build` (or unzip a release package).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json` in this project folder, or `dist/firefox/manifest.json` after a build.

Temporary add-ons in Firefox are removed when the browser restarts. For a permanent install, the build must be signed by Mozilla or loaded in a Firefox version that allows unsigned extensions.

### Updating

- **Store installs** update automatically when a new version is published.
- **Unpacked installs**: run `npm run build` (or `npm run package`), then click **Reload** on `chrome://extensions`, or load the add-on again in Firefox. Saved videos and settings remain in extension storage.
- TabYT reconnects to YouTube tabs that were already open when the extension was installed or updated. If a reading looks stale, click **Refresh**.

---

## Use

1. Open one or more YouTube videos.
2. Click the TabYT toolbar icon to see the memory overview and the open tabs.
3. Use **Save & close** on a row, or **Save & close all** to tidy up.
4. Open **Saved** and press **Resume** to return to a video at its saved timestamp.
5. Open the dashboard for history, limits and automatic cleanup.

The popup refreshes while it is open. The dashboard refreshes every 30 seconds when visible.

---

## Development

Requirements: Node.js 20 or newer.

```bash
npm test        # unit tests for the pure helpers and listener regression
npm run icons   # regenerate PNG icons in src/icons
npm run build   # icons + dist/chrome + dist/firefox + verification
npm run package # build plus store-ready ZIPs in dist/
npm run verify  # validate manifests, files, syntax and build output
```

Useful details:

- `src/` is the extension root after copying; the browser-specific manifest lives in `manifests/` and is written to each build with the `package.json` version.
- `src/lib/core.js` is a dependency-free UMD module used by the background worker, content script and pages. It has no DOM or browser API access and is covered by tests.
- `src/background.js` uses a classic script because Firefox MV3 background pages and Chrome service workers load scripts differently.
- The options page is `src/ui/dashboard.html#settings`; the welcome flow opens `?welcome=1`.
- Icons are generated programmatically by `scripts/make-icons.mjs` (no image libraries).
- `npm run package` creates `dist/tabyt-chrome-v<version>.zip` and `dist/tabyt-firefox-v<version>.zip`.

### Project layout

```
manifests/          chrome.json, firefox.json
scripts/            make-icons.mjs, build.mjs, verify.mjs
src/
  background.js     service worker / event page
  content.js        YouTube player state and resume seeking
  lib/core.js       pure shared helpers
  icons/            generated PNG icons
  ui/               popup, dashboard and shared styles/scripts
  layout.js         watch-page layout: tabs rail, related list, custom player controls
  layout.css        watch-page styles
  player.js         native player adapter (play, seek, volume, queue watch events)
  vendor/video-ambient-glow.js  bundled ambient canvas library
test/               Node test files
dist/               generated builds and packages (git-ignored)
```

---

## Privacy

- TabYT reads only YouTube tab titles, URLs and player state; it does not read other sites, cookies, passwords or browsing history.
- Settings, saved videos and memory samples are stored in the browser's local extension storage (`storage.local`). Short-lived tab and resume state uses `storage.session` where available.
- Incognito tabs are ignored and never saved.
- No analytics, telemetry, remote logging or network requests are made by the extension.
- **Export my data** downloads a JSON file locally. **Delete all local data** removes everything TabYT stored.
- Removing the extension also removes its local storage.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Save settings, saved videos, history and session state locally. |
| `alarms` | Run the once-per-minute cleanup and sampling check. |
| `notifications` | Memory and auto-close alerts. |
| `scripting` | Reconnect to YouTube tabs that were open before installation or after an update. |
| YouTube host access (`www`, `m`, `music`, bare domain) | Read player state and tab titles on YouTube only. |
| `processes` (Chrome, optional) | Use measured renderer memory where Chrome exposes the Processes API. |

TabYT requests no access to other websites.

## How memory is measured

Browsers do not expose exact per-tab memory to extensions on stable channels. TabYT's reading is an **estimate** built from signals available in the page:

- video resolution and whether it is playing;
- live-stream and Shorts status;
- buffered media;
- DOM node count and, where available, the JavaScript heap.

The result is rounded and meant as a relative guide for spotting heavy tabs, not a replacement for the browser Task Manager. On Chrome builds that expose the `processes` API (typically Dev/Canary), you can enable **measured renderer memory** in Settings → Readings. Firefox uses estimates because it does not provide per-tab memory to extensions.

## Compatibility

- Chrome 121+ (Manifest V3 service worker)
- Firefox 142+ (Manifest V3 event page)
- YouTube desktop, mobile web (`m.youtube.com`) and YouTube Music pages
- No build-time or runtime dependencies; plain JavaScript, HTML and CSS

## Troubleshooting

- **The popup says the background worker is not responding.** Reload the extension on `chrome://extensions` or in `about:debugging`, then try again. After an update, open YouTube tabs may need a refresh so the content script reconnects.
- **Auto-close is not running.** Confirm it is enabled, the tab is a background tab, the inactivity threshold has passed, and the tab is not protected as pinned, audible or playing. The current tab in a focused window is never auto-closed.
- **A resume starts at the beginning.** YouTube may not have had a readable player yet when the tab opened. Reload the video; TabYT's content script will apply the pending position once metadata is available. Videos with no saved position (or watched to the end) intentionally start from the beginning.
- **Measured readings are unavailable.** That is expected on stable Chrome and Firefox. Estimates remain active.
- **Saved videos disappeared.** Check the maximum saved videos setting; the oldest entries are removed when it is reached. Removing the extension also clears its storage.

---

## License

MIT. See [LICENSE](LICENSE).
