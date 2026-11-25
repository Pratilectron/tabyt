import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../src/lib/core.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("normalizeSettings returns defaults and clamps numbers", () => {
  const defaults = core.normalizeSettings({});
  assert.equal(defaults.autoClose, false);
  assert.equal(defaults.memoryLimitMB, 1500);
  assert.equal(defaults.layoutEnabled, true);
  assert.equal(defaults.layoutInfo, true);
  assert.equal(defaults.layoutComments, true);
  assert.equal(defaults.layoutOther, true);
  assert.equal(defaults.layoutRelated, true);
  assert.equal(defaults.layoutAmbient, true);
  assert.equal(defaults.inactivityMinutes, 30);
  assert.equal(defaults.maxSavedVideos, 300);

  const clamped = core.applySettings(defaults, {
    inactivityMinutes: 1,
    maxAutoClosePerRun: 50,
    memoryAction: "explode",
    badKey: true
  });
  assert.equal(clamped.settings.inactivityMinutes, 5);
  assert.equal(clamped.settings.maxAutoClosePerRun, 10);
  assert.equal(clamped.settings.memoryAction, "notify");
  assert.equal(clamped.settings.badKey, undefined);
  assert.ok(clamped.errors.some((error) => error.includes("memoryAction")));

  const booleans = core.applySettings(defaults, { autoClose: "true", skipPinned: 1 });
  assert.equal(booleans.settings.autoClose, true);
  assert.equal(booleans.settings.skipPinned, true);
});

test("YouTube URLs are limited to the supported hosts", () => {
  assert.equal(core.isYouTubeUrl("https://www.youtube.com/watch?v=abc123"), true);
  assert.equal(core.isYouTubeUrl("http://youtube.com/"), true);
  assert.equal(core.isYouTubeUrl("https://m.youtube.com/watch?v=abc123"), true);
  assert.equal(core.isYouTubeUrl("https://music.youtube.com/watch?v=abc123"), true);
  assert.equal(core.isYouTubeUrl("https://gaming.youtube.com/watch?v=abc123"), false);
  assert.equal(core.isYouTubeUrl("https://youtube.com.evil.test/"), false);
  assert.equal(core.isYouTubeUrl("https://youtu.be/abc123"), true);
  assert.equal(core.isYouTubeUrl("ftp://youtube.com/watch?v=abc123"), false);
  assert.equal(core.isYouTubeUrl(null), false);
});

test("parseVideoId handles watch, shorts, live and embeds", () => {
  assert.equal(core.parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(core.parseVideoId("https://www.youtube.com/watch/?v=dQw4w9WgXcQ&t=20"), "dQw4w9WgXcQ");
  assert.equal(core.parseVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(core.parseVideoId("https://www.youtube.com/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(core.parseVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(core.parseVideoId("https://www.youtube.com/playlist?list=PL123"), null);
  assert.equal(core.parseVideoId("https://www.youtube.com/watch?v=short"), null);
  assert.equal(core.parseVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(core.parseVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
});

test("watchUrl carries an optional timestamp", () => {
  assert.equal(core.watchUrl("dQw4w9WgXcQ", 0), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(core.watchUrl("dQw4w9WgXcQ", 95.8), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s");
  assert.equal(core.watchUrl(null, 10), "https://www.youtube.com/");
});

test("cleanTitle removes suffixes, prefixes and whitespace", () => {
  assert.equal(core.cleanTitle("(3) A video - YouTube"), "A video");
  assert.equal(core.cleanTitle("  A   spaced\ttitle  "), "A spaced title");
  assert.equal(core.cleanTitle(""), "");
  assert.equal(core.cleanTitle(null), "");
});

test("duration and memory formatting is readable", () => {
  assert.equal(core.formatDuration(0), "0:00");
  assert.equal(core.formatDuration(65), "1:05");
  assert.equal(core.formatDuration(3661), "1:01:01");
  assert.equal(core.formatDuration(-4), "—");
  assert.equal(core.formatMemory(0), "0 MB");
  assert.equal(core.formatMemory(512), "512 MB");
  assert.equal(core.formatMemory(1536), "1.5 GB");
  assert.equal(core.formatMemory(4096), "4 GB");
});

test("badgeFor reflects the limit", () => {
  assert.deepEqual(core.badgeFor(0, 1500), { text: "", color: "#5b5b66" });
  assert.equal(core.badgeFor(1200, 1500).color, "#b45309");
  assert.equal(core.badgeFor(1600, 1500).color, "#d92d20");
  assert.equal(core.badgeFor(2048, 0).text, "2G");
});

test("estimateMemory is stable and responds to quality and playback", () => {
  const base = core.estimateMemory({ videoId: "dQw4w9WgXcQ", videoHeight: 720 });
  const hd = core.estimateMemory({ videoId: "dQw4w9WgXcQ", videoHeight: 2160, playing: true, bufferedSeconds: 300 });
  assert.ok(base >= 8);
  assert.ok(hd > base);
  assert.equal(core.estimateMemory({ discarded: true }), 4);
  assert.equal(core.estimateMemory({ videoHeight: 720 }), base);
  assert.equal(core.estimateMemory({ videoHeight: 720 }) % 5, 0);
});

test("busy playing tabs estimate at browser process scale", () => {
  const busy = core.estimateMemory({
    videoId: "dQw4w9WgXcQ",
    videoHeight: 2160,
    playing: true,
    audible: true,
    bufferedSeconds: 300,
    domNodes: 20000,
    jsHeapMB: 150
  });
  assert.ok(busy >= 550 && busy <= 650, `busy tab estimate was ${busy} MB`);
  assert.equal(busy % 5, 0);

  const background = readFileSync(join(root, "src", "background.js"), "utf8");
  assert.match(background, /let mb = 80;/);
  assert.match(background, /s\.playing \? 80 : 30/);
  assert.match(background, /\* 0\.25, 0, 70/);
  assert.match(background, /\* 0\.8, 0, 100/);
  assert.doesNotMatch(background, /\* 0\.35, 0, 60/);
});

test("makeHistorySample keeps the top ten tabs and totals", () => {
  const tabs = Array.from({ length: 14 }, (_value, index) => ({
    tabId: index,
    videoId: `video${index}`,
    title: `Tab ${index}`,
    memoryMB: index * 10,
    memorySource: "estimate"
  }));
  const sample = core.makeHistorySample(tabs, 1000);
  assert.equal(sample.t, 1000);
  assert.equal(sample.count, 14);
  assert.equal(sample.total, 910);
  assert.equal(sample.tabs.length, 10);
  assert.equal(sample.tabs[0].memoryMB, 130);
  assert.equal(sample.precise, false);
});

test("history pruning respects retention and sample cap", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 10 * day;
  const samples = [
    { t: now - 9 * day, total: 10 },
    { t: now - 2 * day, total: 20 },
    { t: now - day, total: 30 },
    { t: now, total: 40 }
  ];
  const pruned = core.pruneHistory(samples, now, 7, 100);
  assert.deepEqual(pruned.map((sample) => sample.total), [20, 30, 40]);

  const capped = core.pruneHistory(samples, now, 30, 50);
  assert.equal(capped.length, 4);
});

test("upsertSaved merges duplicates and caps the list", () => {
  const first = core.upsertSaved([], {
    videoId: "abc123",
    title: "First",
    position: 20,
    savedAt: 1000
  }, 25);
  assert.equal(first.length, 1);
  assert.equal(first[0].timesSaved, 1);

  const second = core.upsertSaved(first, {
    videoId: "abc123",
    title: "Updated",
    position: 50,
    savedAt: 2000
  }, 25);
  assert.equal(second.length, 1);
  assert.equal(second[0].title, "Updated");
  assert.equal(second[0].position, 50);
  assert.equal(second[0].timesSaved, 2);
  assert.equal(second[0].firstSavedAt, 1000);

  const many = Array.from({ length: 30 }, (_value, index) => ({
    videoId: `v${index}`,
    savedAt: index
  }));
  assert.equal(core.upsertSaved(many, {}, 25).length, 30);
  const limited = core.upsertSaved(many, { videoId: "new", savedAt: 100 }, 25);
  assert.equal(limited.length, 25);
  assert.equal(limited[0].videoId, "new");
});

test("summarizeHistory and topOffenders aggregate samples", () => {
  const samples = [
    { t: 1000, total: 100, count: 2, tabs: [{ videoId: "a", title: "A", memoryMB: 60 }, { videoId: "b", title: "B", memoryMB: 40 }] },
    { t: 2000, total: 300, count: 3, tabs: [{ videoId: "a", title: "A", memoryMB: 200 }, { videoId: "c", title: "C", memoryMB: 100 }] }
  ];
  const summary = core.summarizeHistory(samples);
  assert.equal(summary.count, 2);
  assert.equal(summary.avgMB, 200);
  assert.equal(summary.peakMB, 300);
  assert.equal(summary.lastMB, 300);

  const offenders = core.topOffenders(samples, 3);
  assert.equal(offenders[0].videoId, "a");
  assert.equal(offenders[0].peakMB, 200);
  assert.equal(offenders[0].appearances, 2);
});

test("downsample preserves the requested point count and peak", () => {
  const samples = Array.from({ length: 1000 }, (_value, index) => ({
    t: index * 1000,
    total: index,
    count: index % 5
  }));
  const points = core.downsample(samples, 50);
  assert.equal(points.length, 50);
  assert.equal(points[49].peak, 999);
  assert.ok(points[49].t > points[0].t);
  assert.equal(core.downsample([{ t: 5, total: 10, count: 1 }], 20).length, 1);
});

test("labels and resume heuristics", () => {
  assert.equal(core.reasonLabel("inactive"), "Auto-closed after inactivity");
  assert.equal(core.reasonLabel("manual"), "Closed manually");
  assert.equal(core.reasonLabel("unknown"), "Saved");
  assert.equal(core.videoStillWorthResuming(10, 100), true);
  assert.equal(core.videoStillWorthResuming(4, 100), false);
  assert.equal(core.videoStillWorthResuming(99, 100), false);
});

test("canAutoClose enforces inactivity and protection rules", () => {
  const now = 10 * 60 * 60 * 1000;
  const base = {
    tabId: 1,
    lastActive: now - 31 * 60 * 1000,
    status: "complete",
    active: false,
    pinned: false,
    audible: false,
    playing: false,
    discarded: false
  };
  const settings = core.normalizeSettings({ inactivityMinutes: 30 });

  assert.equal(core.canAutoClose(base, settings, now), true);
  assert.equal(core.canAutoClose({ ...base, lastActive: now - 60 * 1000 }, settings, now), false);
  assert.equal(core.canAutoClose({ ...base, active: true }, settings, now), false);
  assert.equal(core.canAutoClose({ ...base, incognito: true }, settings, now), false);
  assert.equal(core.canAutoClose({ ...base, pinned: true }, settings, now), false);
  assert.equal(core.canAutoClose({ ...base, pinned: true }, core.normalizeSettings({ skipPinned: false }), now), true);
  assert.equal(core.canAutoClose({ ...base, audible: true }, settings, now), false);
  assert.equal(core.canAutoClose({ ...base, audible: true }, core.normalizeSettings({ skipAudible: false }), now), true);
  assert.equal(core.canAutoClose({ ...base, playing: true }, settings, now), false);
  assert.equal(core.canAutoClose({ ...base, playing: true }, core.normalizeSettings({ skipPlaying: false }), now), true);

  assert.equal(core.canAutoClose({ ...base, status: "loading" }, settings, now), false);
  assert.equal(core.canAutoClose({ ...base, status: "loading", discarded: true }, settings, now), true);
  assert.equal(core.canAutoClose({ ...base, status: undefined }, settings, now), true);

  /* The threshold is clamped to the 5 minute minimum. */
  assert.equal(core.canAutoClose({ ...base, lastActive: now - 6 * 60 * 1000 }, core.normalizeSettings({ inactivityMinutes: 5 }), now), true);
  assert.equal(core.canAutoClose({ ...base, lastActive: now - 4 * 60 * 1000 }, core.applySettings(settings, { inactivityMinutes: 1 }).settings, now), false);
  assert.equal(core.canAutoClose(null, settings, now), false);
});

test("background listener keeps the message channel open synchronously", () => {
  const source = readFileSync(join(root, "src", "background.js"), "utf8");
  assert.doesNotMatch(source, /return\s+handleMessage\s*\(/);
  assert.match(source, /handlePageMessage\(message\)\s*\.then\(\(response\) => sendResponse\(response\)\)/);
  assert.match(source, /PAGE_ACTIONS\.has\(message\.type\) && !isExtensionPage\(sender\)/);
  assert.match(source, /isYouTubeContentSender\(sender\)/);
  assert.match(source, /return true;\s*\n\}\);/);
  assert.doesNotMatch(source, /\*:\/\/\*\.youtube\.com/);
});

test("open tab count is queried live and pushed to open UI pages", () => {
  const source = readFileSync(join(root, "src", "background.js"), "utf8");
  assert.match(source, /function countOpenTabs\(tabs\)/);
  assert.match(source, /const ids = new Set\(\)/);
  assert.match(source, /async function queryOpenTabs\(\)/);
  assert.match(source, /api\.tabs\.query\(\{\}\)/);
  assert.match(source, /browserTabCount = countOpenTabs\(await queryOpenTabs\(\)\)/);
  assert.match(source, /api\.tabs\.onCreated\.addListener\(scheduleTabCountRefresh\)/);
  assert.match(source, /api\.tabs\.onRemoved\.addListener/);
  assert.match(source, /api\.tabs\.onAttached\.addListener\(scheduleTabCountRefresh\)/);
  assert.match(source, /api\.tabs\.onDetached\.addListener\(scheduleTabCountRefresh\)/);
  assert.match(source, /type: "STATE_CHANGED"/);
  assert.match(source, /function detectBrowser\(\)/);
  assert.match(source, /browser: detectBrowser\(\)/);

  const popup = readFileSync(join(root, "src", "ui", "popup.js"), "utf8");
  assert.match(popup, /Number\(totals\.browserTabCount\)/);
  assert.match(popup, /ui\.browserLabel\(capabilities\.browser\)/);

  const dashboard = readFileSync(join(root, "src", "ui", "dashboard.js"), "utf8");
  assert.match(dashboard, /Number\(totals\.browserTabCount\)/);
  assert.match(dashboard, /els\.statTabs\.textContent = String\(browserCount\)/);
  assert.doesNotMatch(dashboard, /els\.statTabs\.textContent = String\(tabs\.length\)/);

  const common = readFileSync(join(root, "src", "ui", "common.js"), "utf8");
  assert.match(common, /function browserLabel\(value\)/);
});

test("player settings defaults and resizing cleanup", () => {
  const defaults = core.normalizeSettings({});
  assert.equal(defaults.playerResize, false);
  assert.equal(defaults.customControls, true);

  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");
  const offBranch = layout.slice(
    layout.indexOf("if (!settings.playerResize)"),
    layout.indexOf('document.documentElement.classList.add("tabyt-player-resize")')
  );
  assert.match(offBranch, /removeProperty\("--ytd-watch-flexy-player-width"\)/);
  assert.match(offBranch, /removeProperty\("--ytd-watch-flexy-player-height"\)/);

  const player = readFileSync(join(root, "src", "player.js"), "utf8");
  assert.match(player, /core\.normalizeSettings\(raw\)/);
});

test("ambient background layers behind a sharp, aspect-preserving video", () => {
  const css = readFileSync(join(root, "src", "layout.css"), "utf8");
  assert.match(css, /#tabyt-ambient\s*\{[^}]*z-index:\s*0\s*!important/s);
  assert.match(css, /#tabyt-ambient canvas\s*\{[^}]*object-fit:\s*cover\s*!important/s);
  assert.match(css, /#tabyt-ambient canvas\s*\{[^}]*filter:\s*blur\([^)]*\)[^;]*!important/s);
  /* The canvas is invisible unless YouTube's opaque boxes are made transparent. */
  assert.match(css, /#player:has\(#tabyt-ambient\)[^}]*background:\s*transparent\s*!important/s);
  assert.match(css, /#player:has\(#tabyt-ambient\) video\.html5-main-video\s*\{[^}]*object-fit:\s*contain\s*!important/s);

  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");
  assert.match(layout, /syncGlow\(\);/);
  assert.match(layout, /placeGlowCanvas\(\)/);
});

test("layout boots before first paint without waiting for storage", () => {
  for (const name of ["chrome", "firefox"]) {
    const manifest = JSON.parse(readFileSync(join(root, "manifests", name + ".json"), "utf8"));
    assert.equal(manifest.content_scripts[0].run_at, "document_start");
  }

  assert.equal(typeof core.readEarlySettings, "function");
  assert.equal(typeof core.writeEarlySettings, "function");
  assert.equal(typeof core.applyEarlyClasses, "function");

  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");
  const beforeStart = layout.slice(0, layout.indexOf("function start()"));
  assert.match(beforeStart, /core\.applyEarlyClasses\(settings\)/);
  assert.match(layout, /Build the rail from the cached snapshot/);

  const player = readFileSync(join(root, "src", "player.js"), "utf8");
  const startBody = player.slice(player.indexOf("function start()"), player.indexOf("function start()") + 700);
  assert.match(startBody, /core\.applyEarlyClasses/);
  assert.match(startBody, /hideNativeControls\(true\)/);
});

test("resize setting disables the handle and every drag interaction", () => {
  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");
  const divider = layout.slice(layout.indexOf("function ensureDivider"), layout.indexOf("function restoreAll"));
  assert.match(divider, /if \(!settings\.playerResize\)/);
  assert.match(divider, /existing\.remove\(\)/);
  assert.match(divider, /cancelDrag\(\)/);
  assert.match(divider, /if \(!settings\.playerResize\) return;/);

  const drag = layout.slice(layout.indexOf("function startDrag"), layout.indexOf("function ensureDivider"));
  assert.match(drag, /if \(!settings\.playerResize \|\| event\.button !== 0\) return;/);
  assert.match(layout, /function cancelDrag\(\)/);
  assert.match(layout, /cancelDrag\(\);\s*\n\s*const parked/);

  const css = readFileSync(join(root, "src", "layout.css"), "utf8");
  assert.match(css, /#tabyt-divider\s*\{[^}]*display:\s*none\s*!important[^}]*pointer-events:\s*none\s*!important/s);
  assert.match(css, /tabyt-player-resize:not\(\.tabyt-fullscreen\) #tabyt-divider/);
});

test("injection survives video replacement and avoids duplicates", () => {
  const player = readFileSync(join(root, "src", "player.js"), "utf8");
  assert.match(player, /function barIsHealthy\(\)/);
  assert.match(player, /bar\.isConnected/);
  assert.match(player, /function ensureInjection\(\)/);
  assert.match(player, /function removeDuplicateBars\(\)/);
  assert.match(player, /\["loadstart", "emptied", "loadedmetadata", "canplay"\]/);
  assert.match(player, /addEventListener\(type, scheduleInjection, true\)/);
  assert.match(player, /if \(customControls\) ensureInjection\(\);/);

  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");
  assert.match(layout, /function ambientHealthy\(\)/);
  assert.match(layout, /function reinjectAmbient\(\)/);
  assert.match(layout, /setInterval\(reinjectAmbient, 1000\)/);
  assert.match(layout, /TabYTPlayer\.on\("ready", reinjectAmbient\)/);
});

test("description more button works in the copied info panel", () => {
  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");
  assert.match(layout, /function stripDeadToggles\(root\)/);
  assert.match(layout, /function addDescriptionToggle\(info, body, descNode, titleText\)/);
  assert.match(layout, /classList\.remove\("tabyt-entering"\)/);
  /* The description is expanded by default — no "more" toggle needed. */
  assert.match(layout, /body\.append\(content\);\s*body\.classList\.add\("tabyt-desc-expanded"\)/);
  assert.match(layout, /info\.__descExpanded = true/);
  assert.match(layout, /info\.__infoVideoKey !== titleText/);
  assert.match(layout, /clone\.tagName === "YTD-TEXT-INLINE-EXPANDER"/);
  assert.match(layout, /function deepFind\(root, selector\)/);
  assert.match(layout, /function descriptionContent\(descNode\)/);
  assert.match(layout, /deepFind\(descNode, "#expanded"\)/);
  assert.match(layout, /deepFind\(descNode, "#collapsed"\)/);
  /* The copy prefers the longest description source, so "more" reveals the full text. */
  assert.match(layout, /let source = descNode;/);
  assert.match(layout, /let node = descNode\.parentElement;/);
  assert.match(layout, /text\.length > nodeText\(source\)\.length/);
  assert.match(layout, /clone\.classList\.add\("tabyt-desc-text"\)/);
  assert.match(layout, /function statsLine\(\)/);
  assert.match(layout, /tabyt-info-meta/);

  const css = readFileSync(join(root, "src", "layout.css"), "utf8");
  assert.match(css, /\.tabyt-desc-content\s*\{[^}]*max-height: none/s);
  assert.match(css, /\.tabyt-info-meta\s*\{/);
});

test("description copy appends the native chapters section", () => {
  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");
  assert.match(layout, /function appendChapters\(content, descNode\)/);
  assert.match(layout, /appendChapters\(content, descNode\);/);
  assert.match(layout, /\/\^chapters\/i\.test\(text\)/);
  assert.match(layout, /classList.*tabyt-desc-chapters|className = "tabyt-desc-chapters"/);
  const css = readFileSync(join(root, "src", "layout.css"), "utf8");
  assert.match(css, /\.tabyt-desc-chapters\s*\{/);
});

test("control bar auto-hides and wakes on mouse movement", () => {
  const player = readFileSync(join(root, "src", "player.js"), "utf8");
  assert.match(player, /BAR_IDLE_MS\s*=\s*3000/);
  assert.match(player, /function armBarIdle\(\)/);
  assert.match(player, /function wakeBar\(\)/);
  assert.match(player, /function pointerOnPlayer\(event\)/);
  assert.match(player, /bar\.classList\.add\("tabyt-bar-hidden"\)/);
  assert.match(player, /bar\.classList\.remove\("tabyt-bar-hidden"\)/);
  assert.match(player, /addEventListener\("mousemove", pointerOnPlayer, true\)/);
  assert.match(player, /armBarIdle\(\);[\s\S]*updateBar\(\);|updateBar\(\);[\s\S]*armBarIdle\(\);/);
  assert.match(player, /clearTimeout\(barIdleTimer\)/);

  const css = readFileSync(join(root, "src", "layout.css"), "utf8");
  assert.match(css, /\.tabyt-player-controls\.tabyt-bar-hidden\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
});

test("layout gate classes are retried until the document element exists", () => {
  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");

  /* Retry loop + MutationObserver watching the document while it loads. */
  assert.match(layout, /function applyEarlyClassesSafe\(\)/);
  assert.match(layout, /earlyRetryTimer = setTimeout\(applyEarlyClassesSafe, 10\)/);
  assert.match(layout, /earlyObserver\.observe\(document, \{ childList: true \}\)/);

  /* Applied at document_start and again in start() before the first sync. */
  assert.match(layout, /^\s*applyEarlyClassesSafe\(\);/m);
  const startBody = layout.slice(layout.indexOf("function start()"));
  assert.match(startBody, /applySavedSide\(\);\s*applyEarlyClassesSafe\(\);[\s\S]*sync\(\);/);

  /* Fresh-load syncs must not count as "booted", so they stay near-immediate. */
  const earlyReturn = layout.match(/if \(!settings\.layoutEnabled \|\| !onWatchPage\(\) \|\| !watchRoot\(\)\) \{[^}]*\}/);
  assert.ok(earlyReturn);
  assert.doesNotMatch(earlyReturn[0], /booted = true/);
});

test("content script syncs data while the page is still loading", () => {
  const content = readFileSync(join(root, "src", "content.js"), "utf8");
  assert.match(
    content,
    /Sync data with the background as early as the page starts loading[\s\S]*markActivity\(true\);\s*\n\s*if \(document\.readyState === "loading"\)/
  );
});

test("watch-page design is native and transitions are smooth", () => {
  const layout = readFileSync(join(root, "src", "layout.js"), "utf8");
  const css = readFileSync(join(root, "src", "layout.css"), "utf8");

  /* No extra brand chrome: the rail stays native to YouTube. */
  assert.doesNotMatch(layout, /tabyt-rail-header/);
  assert.doesNotMatch(css, /tabyt-rail-header/);

  /* Native chrome: the details column is transparent like YouTube's, no border. */
  const rail = css.slice(css.indexOf("html.tabyt-layout-on #tabyt-rail {"));
  assert.match(rail, /background:\s*transparent/);
  assert.match(rail, /border-left:\s*0\b/);

  /* Smooth motion: YouTube's own curve (cubic-bezier(0.05, 0, 0, 1)) and a 200 ms transition on tabs. */
  assert.match(css, /--tabyt-ease:\s*cubic-bezier\(0\.05, 0, 0, 1\)/);
  assert.match(css, /--tabyt-transition:\s*200ms var\(--tabyt-ease\)/);
  assert.match(css, /#tabyt-rail \.tabyt-tab\s*\{[^}]*transition: color var\(--tabyt-transition\)[^}]*transform/s);

  /* fitPlayer bails out when the size is unchanged before gathering nodes. */
  const fit = layout.slice(layout.indexOf("function fitPlayer()"));
  const unchanged = fit.indexOf("if (lastTargetW === targetW && lastTargetH === targetH)");
  const gather = fit.indexOf("overflowTargets.forEach((node) => setImp(node, \"overflow\", \"visible\"))");
  assert.ok(unchanged !== -1 && gather > unchanged);
});
