# TabYT

```
  .================================================.
 /  ▄▄▄   ▄▄▄  ▄▄▄▄▄▄▄▄   ▄▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄  \
 |  ██▀██ ██▀██  ▀██      ██          ██       ██ |
 |  ██  ██████    ██      ██   ▄▄▄▄   ██   ▄▄▄▄█▀ |
 |  ██  ▀██▀██    ██      ██  ██▀██▀██  ██ ██▀▀▀  |
 |  ██   ██  ██   ██      ██  ▀██      ██  ▀▀▀▀██  |
 |  ▀▀   ▀▀  ▀▀   ▀▀      ▀▀          ▀▀      ▀▀  |
 \      ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  /
  '------------------------------------------------'
        ▶ The YouTube extension worth keeping
```

**The local YouTube extension for people who keep too many videos open.**

TabYT watches the memory those tabs cost, closes them without losing your place, and rebuilds the watch page around the player: description, comments, live chat and related videos stay in one rail. No account. No analytics. Nothing leaves your browser except the two lookups you can turn off.

[![tests](https://img.shields.io/badge/tests-33%20passing-blue?style=flat-square&logo=node.js)](test/core.test.mjs)
[![version](https://img.shields.io/badge/v1.0.56-blue?style=flat-square&logo=github-actions)](https://github.com/Pratilectron/tabyt/commits/main)
[![license](https://img.shields.io/github/license/Pratilectron/tabyt?style=flat-square&logo=mit&label=License)](LICENSE)
[![mv3](https://img.shields.io/badge/manifest-v3-blue?style=flat-square&logo=github)](manifests/chrome.json)
[![chrome](https://img.shields.io/badge/Chrome-121%2B-blue?style=flat-square&logo=googlechrome)](manifests/chrome.json)
[![firefox](https://img.shields.io/badge/Firefox-142%2B-orange?style=flat-square&logo=firefoxbrowser)](manifests/firefox.json)

---

## Why TabYT

Most YouTube extensions add a button and a network call. TabYT does two jobs properly.

1. **It keeps a pile of YouTube tabs from eating the machine.** Every open video is ranked, you can close one or all of them, and the title plus the exact timestamp come back when you resume.
2. **It makes the watch page usable.** The player stays on the left. Title, views, channel and likes stay under it. Description, comments, live chat and recommendations live in a rail you can resize, and that width is remembered.

Chrome 121+, Firefox 142+, Brave, Edge. Manifest V3. Plain JavaScript. MIT.

---

## Features

### Memory

- **A reading for every YouTube tab.** Tabs are ranked by an estimated footprint. Playing, active and sleeping videos are called out. The number is an estimate, labeled as one, unless Chrome's Processes API is available.
- **Close one, or close the pile.** Save & close stores the video before it goes. Save & close all does the same for every eligible tab.
- **Resume on the same frame.** Saved entries keep the title, channel, thumbnail and playback position. Resume opens that timestamp, or seeks a tab that is already open.
- **Inactivity cleanup.** Optionally close background YouTube tabs after 5 minutes to 24 hours. Pinned, audible and playing tabs can be left alone. The tab you are looking at is never closed.
- **A memory ceiling.** Set a combined limit (default 1.5 GB). TabYT can notify you, or close the least recently used eligible tabs.
- **History on this device.** Samples every 5–60 minutes, kept for 1–30 days, with a chart, peak, average and the tabs that cost the most.
- **A dashboard and a popup.** Overview, open tabs, saved videos, history, settings and help. The toolbar popup is the short version.
- **Your data, in a file.** Export a JSON copy, or delete everything TabYT stored.

### Watch page

- **Player on the left, everything else on the right.** The page itself does not scroll. Each column does.
- **The video stays the hero.** Title, channel, views and likes sit under the player. The player is rounded, with a soft glow, and it fits the column without adding a scrollbar.
- **Info is the full description.** Chapters are clickable and carry their thumbnail. Sponsor, intro and other skip ranges are marked on the seek bar and listed in Info. Nothing is skipped for you.
- **Comments are a real tab.** The composer stays at the top. Under it: the count, Sort by, then the threads. Each author shows their name, a subscriber pill, and a video count after a pipe.
- **One discussion tab.** In settings, choose whether that tab lists comments or live chat. The label follows the choice.
- **Other videos and Related** stay in their own tabs.
- **The divider is yours.** Drag the split, and TabYT remembers the width. Turn remembering off to return to the default. Corner radius and page motion are settings too, and you can pick which tab opens first.
- **Ambient light from the picture.** A small blurred copy of the current frame sits behind the page. Text and images stay sharp. It pauses while the tab is hidden or the video is paused.
- **TabYT's control bar.** Seek, play and playback rate, in place of YouTube's bar, until you switch it off.

### What it refuses to be

No auto-skip. No second video element for the glow. No runtime CDN. No account. SponsorBlock's data is queried; its code is not copied.

---

## Install

### Chrome, Edge, Brave and other Chromium browsers

1. Run `npm run build`. That writes `manifest.json` in the project folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this folder, the one that contains `manifest.json`. `dist/chrome` is the same extension packed for a store build.
5. Pin TabYT from the puzzle-piece menu if you want the toolbar badge.

If the browser says the manifest is missing, the selected folder is not the one that contains `manifest.json`.

### Firefox

1. Run `npm run build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json` in this folder, or `dist/firefox/manifest.json`.

A temporary add-on is removed when Firefox restarts. A permanent install needs a Mozilla-signed build, or a Firefox build that allows unsigned extensions.

### Updating an unpacked copy

Run `npm run build`, then **Reload** on `chrome://extensions`, or load the add-on again in Firefox. Saved videos and settings stay. Refresh open YouTube tabs so the content script reconnects.

---

## Use

1. Open a few YouTube videos.
2. Click the TabYT icon for the memory overview and the open tabs.
3. **Save & close** a row, or **Save & close all**.
4. Open **Saved** and press **Resume**.
5. On a watch page, use the rail. Drag the divider if you want a different split. The choice is in Settings if you want it kept.

The popup refreshes while it is open. The dashboard refreshes every 30 seconds while it is visible.

---

## Privacy

TabYT is local. It has no servers, no analytics and no accounts.

- It reads YouTube tab titles, URLs and player state. It does not read other sites, cookies, passwords or browsing history.
- Settings, saved videos and memory samples live in `storage.local`. Short-lived tab and resume state uses `storage.session` where the browser has it.
- Incognito tabs are ignored and never saved.
- **Skip segments** send a 4-character prefix of the SHA-256 of the video id to `sponsor.ajay.app`. The full id is not sent. Turn the setting off and the request stops.
- **Comment author stats** load the public channel page on `https://www.youtube.com/` for handles in the comments you are reading, without cookies, and cache the name, subscriber count and video count for that page. The request is how the pill and the video count are filled in.
- **Export my data** downloads a JSON file on this machine. **Delete all local data** wipes what TabYT stored. Removing the extension removes its storage too.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Settings, saved videos, history and session state, on this device. |
| `alarms` | The once-a-minute cleanup and history sample. |
| `notifications` | Memory and auto-close alerts. |
| `scripting` | Reconnect to YouTube tabs that were already open. |
| YouTube host access (`www`, `m`, `music`, and the bare domain) | Player state, tab titles, and public channel pages for comment stats. |
| `https://sponsor.ajay.app/*` | Crowdsourced skip ranges, by hash prefix. |
| `processes` (Chrome, optional) | Measured renderer memory where Chrome exposes it. |

## How memory is measured

Stable browsers do not give extensions an exact per-tab memory figure. TabYT's reading is an **estimate** from the resolution, whether the video is playing, live and Shorts status, buffered media, DOM size and, where available, the JavaScript heap.

It is a guide for spotting heavy tabs, not a replacement for the browser's task manager. On Chrome builds that expose the `processes` API (typically Dev or Canary), Settings → Readings can use measured renderer memory. Firefox stays on estimates.

## Compatibility

- Chrome 121+ (Manifest V3 service worker)
- Firefox 142+ (Manifest V3 event page)
- YouTube desktop, `m.youtube.com` and YouTube Music
- No runtime dependencies

## Development

Node.js 20 or newer.

```bash
npm test        # unit tests
npm run icons   # regenerate PNG icons in src/icons
npm run build   # icons, dist/chrome, dist/firefox, verification
npm run package # build, plus store zips in dist/
npm run verify  # manifests, files, syntax, hosts, build output
```

- `src/` is the extension. Browser manifests live in `manifests/` and are stamped with the `package.json` version at build time.
- `src/lib/core.js` is a dependency-free UMD module shared by the worker, content scripts and pages. It has no DOM and no browser APIs.
- `src/background.js` is a classic script so Firefox's event page and Chrome's service worker can both load it.
- Settings open at `src/ui/dashboard.html#settings`. The welcome flow uses `?welcome=1`.
- Icons are drawn by `scripts/make-icons.mjs`. No image libraries.
- `npm run package` writes `dist/tabyt-chrome-v<version>.zip` and `dist/tabyt-firefox-v<version>.zip`.

### Project layout

```
manifests/          chrome.json, firefox.json
scripts/            make-icons.mjs, build.mjs, verify.mjs
src/
  background.js     service worker / event page
  content.js        player state and resume seeking
  lib/core.js       pure shared helpers
  icons/            generated PNG icons
  ui/               popup, dashboard, shared styles
  authors.js        comment names, subscriber pills, video counts
  layout.js         watch-page layout, rail, player fit, glow
  layout.css        watch-page styles
  page-data.js      MAIN-world description and chapters
  player.js         play, seek, volume, player events
  sponsor.js        SponsorBlock hash-prefix lookup
test/               node tests
dist/               generated builds (git-ignored)
```

## Troubleshooting

- **The popup says the background worker is not responding.** Reload the extension, then try again. After an update, refresh open YouTube tabs.
- **Auto-close is not running.** It has to be enabled, the tab has to be in the background, the timer has to have elapsed, and the tab must not be pinned, audible or playing. The focused tab is never closed.
- **Resume starts at the beginning.** The player may not have been readable yet. Reload the video. TabYT applies a pending position once metadata exists. A video with no saved position, or one watched to the end, starts at the beginning on purpose.
- **Measured readings are unavailable.** Expected on stable Chrome and on Firefox. Estimates stay on.
- **Saved videos disappeared.** The saved-video cap drops the oldest entries. Removing the extension clears its storage.
- **Comment pills are empty.** The channel page did not include a public count, or the request has not finished. Scroll the comments and give it a moment. Counts are cached per channel for that page.

---

## License

MIT. See [LICENSE](LICENSE).
