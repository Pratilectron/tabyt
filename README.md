# TabYT

**A local-only YouTube tab memory manager for Chrome and Firefox.**

TabYT shows how much memory your open YouTube tabs are using, lets you close one tab or all of them in a click, saves the video title and playback position before closing, and brings you back to exactly where you stopped.

Everything stays on your device. TabYT has no servers, no analytics, no accounts and makes no network requests.

---

## Features

- **Per-tab memory readings** — every open YouTube tab is ranked by an estimated memory footprint, with the active tab, playing videos and sleeping tabs called out.
- **One-click cleanup** — close a single tab or use **Save & close all**.
- **Save and resume** — closing through TabYT stores the video title, channel, thumbnail reference and playback timestamp. Resume opens the video at the saved position, or switches to an already-open tab and seeks it.
- **Inactive tab cleanup** — optionally close background YouTube tabs after 5 minutes to 24 hours of inactivity. Pinned, audible and playing tabs can be protected.
- **Memory limits** — set a combined limit (default 1.5 GB), get a notification when you cross it, and optionally let TabYT close the least recently used eligible tabs.
- **Local memory history** — sampling every 5–60 minutes, kept for 1–30 days, with a chart, peak/average readings and a "biggest offenders" ranking.
- **Full dashboard** — overview, tabs, saved videos, history, settings and help, plus a compact popup for quick actions.
- **Watch-page layout** — a fixed app shell for YouTube videos: the player and metadata scroll in the left column, while title/description, comments, sidebar videos and related clips become tabs in a right rail with their own scrollbars. Switching tabs or opening a related video never reloads the page.
- **Export and delete** — download a JSON copy of your data or remove everything at any time.

## Install

No build tools are required to use a release build. The unpacked builds are produced by `npm run build`.

### Chrome / Edge / Brave

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

## Use

1. Open one or more YouTube videos.
2. Click the TabYT toolbar icon to see the memory overview and the open tabs.
3. Use **Save & close** on a row, or **Save & close all** to tidy up.
4. Open **Saved** and press **Resume** to return to a video at its saved timestamp.
5. Open the dashboard for history, limits and automatic cleanup.

The popup refreshes while it is open. The dashboard refreshes every 30 seconds when visible.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Memory limit | 1500 MB | Combined ceiling for all open YouTube tabs. `0` turns limits and limit alerts off. |
| Notify over limit | on | Browser notification when the combined reading crosses the limit. |
| When over the limit | notify only | Optionally close the least recently used eligible tabs. |
| Notification cooldown | 60 min | Minimum time between memory notifications. |
| Auto-close inactive tabs | off | Check once per minute and close eligible background tabs. |
| Close after | 30 min | Inactivity threshold (5–1440 minutes). |
| Keep pinned / audio / playing | on | Protections from automatic closing. |
| Maximum closures per check | 3 | Caps how many tabs one cleanup run can close. |
| Sample every | 10 min | Memory history sampling interval. |
| Keep history for | 7 days | History retention window. |
| Maximum saved videos | 300 | Oldest entries are dropped past this limit. |
| Save on close | on | Normal close buttons save the playback position. “Save & close” always saves. |
| Reuse an open tab | on | Resume switches to an existing tab for the same video instead of duplicating it. |
| Ask before closing all | on | Confirmation before closing every YouTube tab. |
| Watch layout | on | Turn the watch page into a fixed two-column shell. Below 980 px wide the page stacks and scrolls normally. |
| Rail tabs | all on | Show Info, Comments, Other videos and Related in the right rail. Each panel keeps its own scroll position per video. |
| Ambient player background | on | Blurred colour glow behind the player, sampled from the video. |
| Live chat | on | Keep the chat frame above the rail tabs when a video has chat. |

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

## Development

Requirements: Node.js 20 or newer. There are no npm dependencies to install.

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
test/               Node test files
dist/               generated builds and packages (git-ignored)
```

## Troubleshooting

- **The popup says the background worker is not responding.** Reload the extension on `chrome://extensions` or in `about:debugging`, then try again. After an update, open YouTube tabs may need a refresh so the content script reconnects.
- **Auto-close is not running.** Confirm it is enabled, the tab is a background tab, the inactivity threshold has passed, and the tab is not protected as pinned, audible or playing. The current tab in a focused window is never auto-closed.
- **A resume starts at the beginning.** YouTube may not have had a readable player yet when the tab opened. Reload the video; TabYT's content script will apply the pending position once metadata is available. Videos with no saved position (or watched to the end) intentionally start from the beginning.
- **Measured readings are unavailable.** That is expected on stable Chrome and Firefox. Estimates remain active.
- **Saved videos disappeared.** Check the maximum saved videos setting; the oldest entries are removed when it is reached. Removing the extension also clears its storage.

## License

MIT. See [LICENSE](LICENSE).
