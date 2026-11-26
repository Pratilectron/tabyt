/*
 * TabYT background service worker – routes messages, manages storage, handles alarms.
 *
 * This runs as a MV3 service worker: no DOM, no window, no content-script APIs.
 * All heavy logic (tab state collection, seek, activity) lives in content.js.
 *
 * The popup and dashboard talk to this worker through handlePageMessage().
 * Every message type those pages send must be routed here; a missing branch
 * used to answer { ok: false } and made the popup say
 * "Could not read your YouTube tabs."
 */
"use strict";

const api = globalThis.browser || globalThis.chrome;
const SETTINGS_KEY = "tabyt:settings";
const HISTORY_KEY = "tabyt:history";
const RESUME_KEY = "tabyt:resume";
const SAVED_KEY = "tabyt:saved";
const STATS_KEY = "tabyt:stats";
const AUTO_CLOSE_ALARM = "tabyt-autoclose";

const VERSION = "1.0.56";
const HISTORY_MAX_SAMPLES = 1500;
const RESUME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const YT_URLS = [
  "*://www.youtube.com/*",
  "*://m.youtube.com/*",
  "*://music.youtube.com/*",
  "*://youtube.com/*"
];

const DEFAULT_SETTINGS = Object.freeze({
  autoClose: false,
  inactivityMinutes: 30,
  skipPinned: true,
  skipAudible: true,
  skipPlaying: true,
  maxAutoClosePerRun: 3,
  autoCloseNotifications: true,
  memoryLimitMB: 1500,
  notifyOverLimit: true,
  memoryAction: "notify",
  notifyCooldownMinutes: 60,
  historySampleMinutes: 10,
  historyRetentionDays: 7,
  maxSavedVideos: 300,
  askBeforeCloseAll: true,
  saveOnClose: true,
  resumeExistingTab: true,
  onboarded: false,
  layoutEnabled: true,
  layoutInfo: true,
  layoutComments: true,
  layoutOther: true,
  layoutRelated: true,
  layoutChat: true,
  layoutLive: true,
  layoutDiscussion: "comments",
  layoutAmbient: true,
  layoutSkips: true,
  playerResize: false,
  rememberLayoutSize: true,
  layoutSide: 420,
  layoutRadius: 16,
  layoutMotion: true,
  layoutStartTab: "info",
  customControls: true
});

const SETTING_SPECS = {
  autoClose: "boolean",
  inactivityMinutes: [5, 1440],
  skipPinned: "boolean",
  skipAudible: "boolean",
  skipPlaying: "boolean",
  maxAutoClosePerRun: [1, 10],
  autoCloseNotifications: "boolean",
  memoryLimitMB: [0, 65536],
  notifyOverLimit: "boolean",
  memoryAction: ["notify", "close"],
  notifyCooldownMinutes: [5, 1440],
  historySampleMinutes: [1, 60],
  historyRetentionDays: [1, 30],
  maxSavedVideos: [25, 1000],
  askBeforeCloseAll: "boolean",
  saveOnClose: "boolean",
  resumeExistingTab: "boolean",
  onboarded: "boolean",
  layoutEnabled: "boolean",
  layoutInfo: "boolean",
  layoutComments: "boolean",
  layoutOther: "boolean",
  layoutRelated: "boolean",
  layoutChat: "boolean",
  layoutLive: "boolean",
  layoutDiscussion: ["comments", "live"],
  layoutAmbient: "boolean",
  layoutSkips: "boolean",
  playerResize: "boolean",
  rememberLayoutSize: "boolean",
  layoutSide: [280, 680],
  layoutRadius: [0, 28],
  layoutMotion: "boolean",
  layoutStartTab: ["info", "comments", "other", "related", "live"],
  customControls: "boolean"
};

/* ------------------------------------------------------------------ */
/* Small utilities                                                      */
/* ------------------------------------------------------------------ */

function logError(scope, error) {
  console.warn(`[TabYT] ${scope}:`, error && error.message ? error.message : error);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isYouTubeUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "youtube.com" || host === "www.youtube.com" ||
      host === "m.youtube.com" || host === "music.youtube.com" || host === "youtu.be";
  } catch (_error) {
    return false;
  }
}

function parseVideoId(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, "https://www.youtube.com/");
    const fromQuery = parsed.searchParams.get("v");
    if (fromQuery && /^[A-Za-z0-9_-]{6,20}$/.test(fromQuery)) return fromQuery;
    if (parsed.hostname.toLowerCase() === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && (parts[0] === "live" || parts[0] === "shorts" || parts[0] === "embed")) {
      return /^[A-Za-z0-9_-]{6,20}$/.test(parts[1]) ? parts[1] : null;
    }
  } catch (_error) {
    /* ignore */
  }
  return null;
}

function thumbnailUrl(videoId) {
  return videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : "";
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/\s*[-|–]\s*YouTube\s*$/i, "")
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/*
 * Count the browser's actual open tabs. query({}) has no URL filter, so pinned,
 * inactive, duplicate-URL and multiple-window tabs are all included. Keying by
 * tab id means a tab can never be counted twice, even if events overlap.
 */
function countOpenTabs(tabs) {
  const ids = new Set();
  (Array.isArray(tabs) ? tabs : []).forEach((tab) => {
    if (tab && Number.isInteger(tab.id) && tab.id >= 0) ids.add(tab.id);
  });
  return ids.size;
}

async function queryOpenTabs() {
  try {
    const tabs = await api.tabs.query({});
    return Array.isArray(tabs) ? tabs : [];
  } catch (error) {
    logError("tabs.query({})", error);
    return [];
  }
}

function detectBrowser() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/Brave\//i.test(ua)) return "brave";
  if (/Firefox\//i.test(ua)) return "firefox";
  if (/Edg\//i.test(ua)) return "edge";
  if (/OPR\//i.test(ua)) return "opera";
  if (/Vivaldi\//i.test(ua)) return "vivaldi";
  if (/Chrome\//i.test(ua)) return "chrome";
  return "unknown";
}

/*
 * Keep this in sync with core.estimateMemory(). It now models the renderer
 * baseline, media pipeline and shared browser services the browser counts, so
 * a busy playing tab lands near its process-scale number instead of ~260 MB.
 */
function estimateMemory(state) {
  const s = state || {};
  if (s.discarded) return 4;
  const hasVideo = Boolean(s.videoId || Number(s.videoHeight) > 0);
  let mb = 80;
  mb += hasVideo ? (s.playing ? 80 : 30) : 25;
  if (hasVideo) mb += 70;
  const height = Number(s.videoHeight) || 0;
  if (height >= 2160) mb += 95;
  else if (height >= 1440) mb += 65;
  else if (height >= 1080) mb += 40;
  else if (height >= 720) mb += 25;
  else if (height > 0) mb += 12;
  if (s.playing) mb += 20;
  if (s.audible) mb += 6;
  if (s.isLive) mb += 20;
  if (s.isShort) mb += 6;
  mb += clamp((Number(s.bufferedSeconds) || 0) * 0.25, 0, 70);
  mb += clamp((Math.max(0, Number(s.domNodes) || 0)) / 180, 0, 55);
  mb += clamp((Math.max(0, Number(s.jsHeapMB) || 0)) * 0.8, 0, 100);
  if (!hasVideo) mb += 10;
  return Math.max(8, Math.round(mb / 5) * 5);
}

function applySettings(current, patch) {
  const next = {};
  const errors = [];
  for (const key of Object.keys(DEFAULT_SETTINGS)) next[key] = DEFAULT_SETTINGS[key];
  if (current && typeof current === "object") {
    for (const key of Object.keys(SETTING_SPECS)) {
      if (Object.prototype.hasOwnProperty.call(current, key) && current[key] !== undefined) {
        next[key] = current[key];
      }
    }
  }
  if (patch && typeof patch === "object") {
    for (const key of Object.keys(patch)) {
      if (!Object.prototype.hasOwnProperty.call(SETTING_SPECS, key)) continue;
      const spec = SETTING_SPECS[key];
      const value = patch[key];
      if (spec === "boolean") {
        next[key] = value === true || value === "true" || value === 1 || value === "1";
      } else if (Array.isArray(spec) && typeof spec[0] === "number") {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          errors.push(`${key} must be a number`);
          continue;
        }
        next[key] = Math.round(clamp(num, spec[0], spec[1]));
      } else if (!Array.isArray(spec) || spec.indexOf(value) === -1) {
        errors.push(`${key} has an unsupported value`);
      } else {
        next[key] = value;
      }
    }
  }
  return { settings: next, errors };
}

function normalizeSettings(raw) {
  return applySettings(DEFAULT_SETTINGS, raw || {}).settings;
}

function makeHistorySample(tabInfos, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const items = [];
  (tabInfos || []).forEach((tab) => {
    if (!tab || tab.incognito) return;
    const mb = Math.max(0, Number(tab.memoryMB) || 0);
    items.push({
      tabId: tab.tabId,
      videoId: tab.videoId || null,
      title: cleanTitle(tab.title || "YouTube tab"),
      url: tab.url || "",
      memoryMB: Math.round(mb),
      source: tab.memorySource || "estimate"
    });
  });
  const total = items.reduce((sum, item) => sum + item.memoryMB, 0);
  const top = items.slice().sort((a, b) => b.memoryMB - a.memoryMB).slice(0, 10);
  return {
    t: at,
    total: Math.round(total),
    count: items.length,
    precise: items.length > 0 && items.every((item) => item.source === "process"),
    tabs: top.map((item) => ({ videoId: item.videoId, title: item.title, memoryMB: item.memoryMB }))
  };
}

function pruneHistory(samples, now, retentionDays, maxSamples) {
  const at = Number.isFinite(now) ? now : Date.now();
  const days = clamp(Number(retentionDays) || 7, 1, 30);
  const cap = clamp(Math.round(Number(maxSamples) || HISTORY_MAX_SAMPLES), 50, HISTORY_MAX_SAMPLES);
  const cutoff = at - days * 24 * 60 * 60 * 1000;
  const list = (Array.isArray(samples) ? samples : []).filter((sample) =>
    sample && Number.isFinite(sample.t) && sample.t >= cutoff);
  list.sort((a, b) => a.t - b.t);
  return list.length > cap ? list.slice(list.length - cap) : list;
}

function upsertSaved(list, entry, maxItems) {
  const existing = Array.isArray(list) ? list.slice() : [];
  if (!entry || !entry.videoId) return existing;
  const limit = clamp(Math.round(Number(maxItems) || 300), 25, 1000);
  const now = Number(entry.savedAt) || Date.now();
  let foundIndex = -1;
  for (let i = 0; i < existing.length; i += 1) {
    if (existing[i] && existing[i].videoId === entry.videoId) {
      foundIndex = i;
      break;
    }
  }
  let merged;
  if (foundIndex !== -1) {
    const old = existing[foundIndex];
    merged = Object.assign({}, old, entry);
    merged.firstSavedAt = old.firstSavedAt || old.savedAt || now;
    merged.savedAt = now;
    merged.timesSaved = (Number(old.timesSaved) || 1) + 1;
    existing.splice(foundIndex, 1);
  } else {
    merged = Object.assign({}, entry, { savedAt: now, firstSavedAt: now, timesSaved: 1 });
  }
  merged.position = Math.max(0, Math.round(Number(merged.position) || 0));
  merged.duration = Math.max(0, Math.round(Number(merged.duration) || 0));
  existing.unshift(merged);
  existing.sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));
  return existing.slice(0, limit);
}

function videoStillWorthResuming(position, duration) {
  const pos = Number(position) || 0;
  const dur = Number(duration) || 0;
  if (pos < 5) return false;
  if (dur > 0 && pos > dur - 3) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Storage helpers                                                      */
/* ------------------------------------------------------------------ */

async function getLocal(key, fallback) {
  try {
    const result = await api.storage.local.get(key);
    return Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
  } catch (error) {
    logError(`storage.get ${key}`, error);
    return fallback;
  }
}

async function setLocal(key, value) {
  try {
    await api.storage.local.set({ [key]: value });
  } catch (error) {
    logError(`storage.set ${key}`, error);
  }
}

async function removeLocal(keys) {
  try {
    await api.storage.local.remove(keys);
  } catch (error) {
    logError("storage.remove", error);
  }
}

/* ------------------------------------------------------------------ */
/* Tab state handling                                                   */
/* ------------------------------------------------------------------ */

const tabStates = new Map();
let tabCountGeneration = 0;

function updateTabState(tabId, state) {
  if (!tabId || !state) return;
  tabStates.set(tabId, { ...state, tabId, updatedAt: Date.now() });
}

function getTabState(tabId) {
  return tabStates.get(tabId) || null;
}

function getAllTabStates() {
  return Array.from(tabStates.values());
}

/*
 * Broadcast an event-driven refresh. Every broadcast starts from a fresh
 * query({}), and the generation guard prevents a slower earlier query from
 * overwriting a newer one. No count is cached in storage.
 */
async function notifyTabCountChanged() {
  const generation = ++tabCountGeneration;
  const tabs = await queryOpenTabs();
  if (generation !== tabCountGeneration) return;
  try {
    await Promise.resolve(api.runtime.sendMessage({
      type: "STATE_CHANGED",
      reason: "tabs",
      count: countOpenTabs(tabs),
      browser: detectBrowser()
    }));
  } catch (_error) {
    /* No popup/dashboard is open; its next load will query tabs itself. */
  }
}

function scheduleTabCountRefresh() {
  notifyTabCountChanged().catch((error) => logError("notifyTabCountChanged", error));
}

/* ------------------------------------------------------------------ */
/* History                                                              */
/* ------------------------------------------------------------------ */

async function recordHistorySample(force) {
  const settings = normalizeSettings(await getLocal(SETTINGS_KEY, {}));
  const now = Date.now();
  const samples = await getLocal(HISTORY_KEY, []);
  const last = samples.length ? samples[samples.length - 1] : null;
  const interval = (Number(settings.historySampleMinutes) || 10) * 60000;
  if (!force && last && now - (Number(last.t) || 0) < interval) return;
  const items = await collectYouTubeTabs();
  const sample = makeHistorySample(items.map((item) => item.info), now);
  const pruned = pruneHistory(samples.concat(sample), now,
    settings.historyRetentionDays, HISTORY_MAX_SAMPLES);
  await setLocal(HISTORY_KEY, pruned);
}

/* ------------------------------------------------------------------ */
/* Resume position                                                      */
/* ------------------------------------------------------------------ */

async function saveResume(videoId, position) {
  if (!videoId || !Number.isFinite(position) || position < 5) return;
  const resumes = await getLocal(RESUME_KEY, {});
  resumes[videoId] = { position, savedAt: Date.now() };
  await setLocal(RESUME_KEY, resumes);
}

async function getResume(videoId) {
  if (!videoId) return null;
  const resumes = await getLocal(RESUME_KEY, {});
  const entry = resumes[videoId];
  if (!entry) return null;
  if (Date.now() - (Number(entry.savedAt) || 0) > RESUME_MAX_AGE_MS) return null;
  return entry;
}

async function clearResume(videoId) {
  if (!videoId) return;
  const resumes = await getLocal(RESUME_KEY, {});
  delete resumes[videoId];
  await setLocal(RESUME_KEY, resumes);
}

/* ------------------------------------------------------------------ */
/* Tab collection / overview                                             */
/* ------------------------------------------------------------------ */

async function collectYouTubeTabs() {
  let tabs = [];
  try {
    tabs = await api.tabs.query({ url: YT_URLS });
  } catch (error) {
    logError("tabs.query", error);
  }
  return tabs.filter((tab) => isYouTubeUrl(tab.url)).map((tab) => {
    const raw = getTabState(tab.id) || {};
    const state = Object.assign({}, raw);
    state.tabId = tab.id;
    state.url = tab.url || state.url || "";
    state.title = state.title || tab.title || "YouTube tab";
    state.active = Boolean(tab.active);
    state.pinned = Boolean(tab.pinned);
    state.audible = Boolean(tab.audible);
    state.discarded = Boolean(tab.discarded);
    state.incognito = Boolean(tab.incognito);
    state.lastActive = Number(raw.at || raw.updatedAt) || Date.now();
    if (!state.videoId) state.videoId = parseVideoId(state.url);
    const memoryMB = estimateMemory(state);
    const info = {
      tabId: tab.id,
      index: tab.index,
      windowId: tab.windowId,
      videoId: state.videoId || null,
      title: cleanTitle(state.title),
      url: state.url,
      channel: state.channel || "",
      thumbnail: state.thumbnail || thumbnailUrl(state.videoId),
      position: Number(state.position) || 0,
      duration: Number(state.duration) || 0,
      playing: Boolean(state.playing),
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      audible: Boolean(tab.audible),
      discarded: Boolean(tab.discarded),
      incognito: Boolean(tab.incognito),
      memoryMB,
      memorySource: "estimate",
      lastActive: state.lastActive,
      videoHeight: Number(state.videoHeight) || 0,
      isLive: Boolean(state.isLive),
      isShort: Boolean(state.isShort)
    };
    return { tab, state, info };
  });
}

async function getCapabilities() {
  let canUsePrecise = false;
  try {
    if (api.permissions && api.permissions.contains) {
      canUsePrecise = await api.permissions.contains({ permissions: ["processes"] });
    }
  } catch (_error) {
    canUsePrecise = false;
  }
  const preciseApi = Boolean(api.processes && api.processes.getProcessInfo);
  return {
    version: VERSION,
    preciseApi,
    canUsePrecise: Boolean(preciseApi && canUsePrecise),
    browser: detectBrowser()
  };
}

async function buildOverview(force) {
  const settings = normalizeSettings(await getLocal(SETTINGS_KEY, {}));
  const items = await collectYouTubeTabs();
  const tabs = items.map((item) => item.info);
  const saved = await getLocal(SAVED_KEY, []);
  const stats = await getLocal(STATS_KEY, {});
  const capabilities = await getCapabilities();
  const browserTabCount = countOpenTabs(await queryOpenTabs());

  const memoryMB = tabs.reduce((sum, tab) => sum + (Number(tab.memoryMB) || 0), 0);
  const limitMB = Number(settings.memoryLimitMB) || 0;
  const preciseCount = tabs.filter((tab) => tab.memorySource === "process").length;
  const totals = {
    memoryMB,
    limitMB,
    percent: limitMB > 0 ? (memoryMB / limitMB) * 100 : 0,
    overLimit: limitMB > 0 && memoryMB > limitMB,
    source: preciseCount > 0 ? (preciseCount === tabs.length ? "process" : "mixed") : "estimate",
    preciseCount,
    browserTabCount,
    count: tabs.length
  };

  if (force) {
    recordHistorySample(true).catch((error) => logError("recordHistorySample", error));
  }

  return {
    ok: true,
    state: {
      tabs,
      totals,
      settings,
      saved: Array.isArray(saved) ? saved : [],
      capabilities,
      stats: stats && typeof stats === "object" ? stats : {}
    }
  };
}

/* ------------------------------------------------------------------ */
/* Saved videos / tab actions                                           */
/* ------------------------------------------------------------------ */

async function incrementClosed(count) {
  const stats = await getLocal(STATS_KEY, {});
  const next = Object.assign({}, stats);
  next.closedTotal = (Number(next.closedTotal) || 0) + (Number(count) || 0);
  next.lastClosedAt = Date.now();
  await setLocal(STATS_KEY, next);
}

async function saveTabForLater(tabId, forceSave, reason) {
  const state = getTabState(tabId);
  if (!state || !state.videoId) return false;
  const settings = normalizeSettings(await getLocal(SETTINGS_KEY, {}));
  if (!forceSave && !settings.saveOnClose) return false;
  if (!videoStillWorthResuming(state.position, state.duration)) return false;
  const saved = await getLocal(SAVED_KEY, []);
  const entry = {
    videoId: state.videoId,
    title: cleanTitle(state.title || "YouTube video"),
    position: Math.max(0, Math.round(Number(state.position) || 0)),
    duration: Math.max(0, Math.round(Number(state.duration) || 0)),
    channel: state.channel || "",
    thumbnail: state.thumbnail || thumbnailUrl(state.videoId),
    reason: reason || "closed",
    savedAt: Date.now()
  };
  await setLocal(SAVED_KEY, upsertSaved(saved, entry, settings.maxSavedVideos));
  await saveResume(state.videoId, entry.position);
  return true;
}

async function closeTab(tabId, forceSave, reason) {
  const saved = await saveTabForLater(tabId, forceSave, reason);
  try {
    await api.tabs.remove(tabId);
  } catch (error) {
    logError("tabs.remove", error);
  }
  tabStates.delete(tabId);
  await incrementClosed(1);
  return { ok: true, saved };
}

async function closeAllTabs(forceSave, reason) {
  const items = await collectYouTubeTabs();
  let savedCount = 0;
  let closed = 0;
  for (const item of items) {
    if (await saveTabForLater(item.tab.id, forceSave, reason)) savedCount += 1;
    try {
      await api.tabs.remove(item.tab.id);
      closed += 1;
    } catch (_error) {
      /* tab may already be gone */
    }
    tabStates.delete(item.tab.id);
  }
  if (closed) await incrementClosed(closed);
  return { ok: true, closed, saved: savedCount };
}

/* ------------------------------------------------------------------ */
/* Auto-close logic                                                     */
/* ------------------------------------------------------------------ */

async function maybeAutoClose() {
  const settings = await getLocal(SETTINGS_KEY, {});
  if (!settings || !settings.autoClose) return;
  const inactivityMs = (Number(settings.inactivityMinutes) || 30) * 60 * 1000;
  const now = Date.now();
  const items = await collectYouTubeTabs();
  let closed = 0;
  const max = clamp(Number(settings.maxAutoClosePerRun) || 3, 1, 10);
  for (const item of items) {
    if (closed >= max) break;
    const state = item.state;
    if (!state || !state.updatedAt) continue;
    if ((settings.skipPinned && item.tab.pinned) ||
        (settings.skipAudible && item.tab.audible) ||
        (settings.skipPlaying && state.playing)) continue;
    if (now - state.updatedAt <= inactivityMs) continue;
    await saveTabForLater(item.tab.id, true, "inactive");
    try {
      await api.tabs.remove(item.tab.id);
      closed += 1;
    } catch (_error) {
      /* ignore */
    }
    tabStates.delete(item.tab.id);
  }
  if (closed) await incrementClosed(closed);
}

/* ------------------------------------------------------------------ */
/* Sender guards                                                        */
/* ------------------------------------------------------------------ */

/*
 * Actions that may only be requested by an extension page, never by a
 * YouTube content script. Keeps the message surface explicit.
 */
const PAGE_ACTIONS = new Set([
  "GET_OVERVIEW", "GET_HISTORY", "CLEAR_HISTORY", "GET_SETTINGS", "SET_SETTINGS",
  "UPDATE_SETTINGS", "GET_CAPABILITIES", "GET_SAVED", "CLEAR_SAVED", "DELETE_SAVED",
  "RESTORE_VIDEO", "CLOSE_TAB", "CLOSE_ALL", "FOCUS_TAB", "OPEN_DASHBOARD",
  "RESET_DATA", "EXPORT_DATA", "CLEAR_YOUTUBE_CACHE"
]);

function isExtensionPage(sender) {
  if (!sender) return false;
  try {
    const prefix = api.runtime.getURL("");
    return typeof sender.url === "string" && sender.url.startsWith(prefix);
  } catch (_error) {
    return false;
  }
}

function isYouTubeContentSender(sender) {
  if (!sender || !sender.tab) return false;
  return isYouTubeUrl(sender.tab.url || sender.url || "");
}

/* ------------------------------------------------------------------ */
/* Message routing                                                      */
/* ------------------------------------------------------------------ */

/*
 * handlePageMessage is called by the test harness directly to verify routing.
 * It must return a Promise<object> in every branch.
 */
async function handlePageMessage(message) {
  if (!message || typeof message.type !== "string") return { ok: false };
  const type = message.type;

  switch (type) {
    case "PING":
      return { ok: true };

    case "GET_TAB_STATE":
    case "GET_ALL_STATES":
      return { ok: true, states: getAllTabStates() };

    case "GET_CAPABILITIES":
      return { ok: true, capabilities: await getCapabilities() };

    case "GET_SETTINGS":
      return { ok: true, settings: normalizeSettings(await getLocal(SETTINGS_KEY, {})) };

    case "SET_SETTINGS":
    case "UPDATE_SETTINGS": {
      const current = normalizeSettings(await getLocal(SETTINGS_KEY, {}));
      const patch = type === "UPDATE_SETTINGS" ? (message.patch || {}) : (message.settings || {});
      const applied = applySettings(current, patch);
      await setLocal(SETTINGS_KEY, applied.settings);
      if (applied.errors.length) return { ok: false, error: applied.errors.join("; ") };
      return { ok: true, settings: applied.settings };
    }

    case "GET_OVERVIEW":
      return buildOverview(message.force !== false);

    case "GET_HISTORY": {
      const settings = normalizeSettings(await getLocal(SETTINGS_KEY, {}));
      const raw = await getLocal(HISTORY_KEY, []);
      const samples = pruneHistory(raw, Date.now(), settings.historyRetentionDays, HISTORY_MAX_SAMPLES);
      return {
        ok: true,
        samples,
        retentionDays: settings.historyRetentionDays,
        sampleMinutes: settings.historySampleMinutes
      };
    }

    case "CLEAR_HISTORY":
      await setLocal(HISTORY_KEY, []);
      return { ok: true };

    case "GET_SAVED": {
      const saved = await getLocal(SAVED_KEY, []);
      return { ok: true, saved: Array.isArray(saved) ? saved : [] };
    }

    case "CLEAR_SAVED":
      await setLocal(SAVED_KEY, []);
      return { ok: true };

    case "DELETE_SAVED": {
      const saved = await getLocal(SAVED_KEY, []);
      const next = (Array.isArray(saved) ? saved : []).filter((item) => item && item.videoId !== message.videoId);
      await setLocal(SAVED_KEY, next);
      await clearResume(message.videoId);
      return { ok: true };
    }

    case "RESTORE_VIDEO": {
      const saved = await getLocal(SAVED_KEY, []);
      const entry = (Array.isArray(saved) ? saved : []).find((item) => item && item.videoId === message.videoId);
      const settings = normalizeSettings(await getLocal(SETTINGS_KEY, {}));
      const position = entry ? Number(entry.position) || 0 : 0;
      if (position > 0) await saveResume(message.videoId, position);
      let url = `https://www.youtube.com/watch?v=${encodeURIComponent(message.videoId)}`;
      try {
        url = `${url}&t=${Math.floor(position)}s`;
      } catch (_error) {
        /* keep the plain watch URL */
      }
      if (settings.resumeExistingTab === false) {
        await api.tabs.create({ url });
      } else {
        const existing = await api.tabs.query({ url: YT_URLS });
        const match = existing.find((tab) => {
          const id = parseVideoId(tab.url || "");
          return id === message.videoId;
        });
        if (match) {
          await api.tabs.update(match.id, { active: true });
          try {
            await Promise.resolve(api.tabs.sendMessage(match.id, { type: "SEEK", position, announce: true }));
          } catch (_error) {
            /* the content script will resume from GET_RESUME instead */
          }
        } else {
          await api.tabs.create({ url });
        }
      }
      return { ok: true };
    }

    case "CLOSE_TAB":
      return closeTab(Number(message.tabId), Boolean(message.forceSave), message.reason || "manual");

    case "CLOSE_ALL":
      return closeAllTabs(Boolean(message.forceSave), message.reason || "close-all");

    case "FOCUS_TAB": {
      const tabId = Number(message.tabId);
      let tab = null;
      try {
        tab = await api.tabs.get(tabId);
      } catch (_error) {
        return { ok: false, error: "That tab is no longer open." };
      }
      if (tab && tab.windowId !== undefined && api.windows) {
        try {
          await api.windows.update(tab.windowId, { focused: true });
        } catch (_error) {
          /* window focus is best-effort */
        }
      }
      await api.tabs.update(tabId, { active: true });
      return { ok: true };
    }

    case "OPEN_DASHBOARD":
      if (api.runtime.openOptionsPage) await api.runtime.openOptionsPage();
      else await api.tabs.create({ url: api.runtime.getURL("ui/dashboard.html") });
      return { ok: true };

    case "CLEAR_YOUTUBE_CACHE": {
      if (api.browsingData && api.browsingData.removeCache) {
        await api.browsingData.removeCache({ since: 0 });
      }
      return { ok: true };
    }

    case "RESET_DATA": {
      const scope = message.scope || "all";
      if (scope === "settings") {
        await setLocal(SETTINGS_KEY, normalizeSettings({}));
      } else {
        await removeLocal([SETTINGS_KEY, HISTORY_KEY, RESUME_KEY, SAVED_KEY, STATS_KEY]);
        tabStates.clear();
      }
      return { ok: true };
    }

    case "EXPORT_DATA": {
      const data = {
        version: VERSION,
        exportedAt: Date.now(),
        settings: normalizeSettings(await getLocal(SETTINGS_KEY, {})),
        history: await getLocal(HISTORY_KEY, []),
        saved: await getLocal(SAVED_KEY, []),
        stats: await getLocal(STATS_KEY, {})
      };
      return { ok: true, data };
    }

    case "GET_RESUME": {
      const entry = await getResume(message.videoId);
      return entry ? { ok: true, position: entry.position } : { ok: false };
    }

    case "CLEAR_RESUME":
      await clearResume(message.videoId);
      return { ok: true };

    case "ACTIVITY":
    case "CHECKPOINT":
      return { ok: true };

    default:
      return { ok: false, error: `Unsupported message type: ${type}` };
  }
}

api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message.type !== "string") {
    sendResponse({ ok: false });
    return false;
  }

  if (PAGE_ACTIONS.has(message.type) && !isExtensionPage(sender)) {
    sendResponse({ ok: false, error: "This action is only available to TabYT pages." });
    return false;
  }
  if (!isExtensionPage(sender) && !isYouTubeContentSender(sender)) {
    sendResponse({ ok: false, error: "Unsupported sender." });
    return false;
  }

  if (message.type === "ACTIVITY" || message.type === "CHECKPOINT") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId && message.state) {
      updateTabState(tabId, message.state);
      if (message.type === "CHECKPOINT") {
        if (message.state.videoId && Number(message.state.position) > 5) {
          saveResume(message.state.videoId, message.state.position).catch((error) =>
            logError("saveResume", error));
        }
        recordHistorySample(false).catch((error) => logError("recordHistorySample", error));
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  handlePageMessage(message).then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true;
});

/* ------------------------------------------------------------------ */
/* Tab cleanup and live count                                           */
/* ------------------------------------------------------------------ */

if (api.tabs && api.tabs.onCreated) {
  api.tabs.onCreated.addListener(scheduleTabCountRefresh);
}
if (api.tabs && api.tabs.onRemoved) {
  api.tabs.onRemoved.addListener((tabId) => {
    tabStates.delete(tabId);
    scheduleTabCountRefresh();
  });
}
if (api.tabs && api.tabs.onAttached) {
  api.tabs.onAttached.addListener(scheduleTabCountRefresh);
}
if (api.tabs && api.tabs.onDetached) {
  api.tabs.onDetached.addListener(scheduleTabCountRefresh);
}

/* ------------------------------------------------------------------ */
/* Alarms                                                               */
/* ------------------------------------------------------------------ */

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_CLOSE_ALARM) {
    maybeAutoClose().catch((error) => logError("maybeAutoClose", error));
  }
});

/* ------------------------------------------------------------------ */
/* Startup                                                              */
/* ------------------------------------------------------------------ */

function createAlarm() {
  api.alarms.create(AUTO_CLOSE_ALARM, { periodInMinutes: 2 });
  scheduleTabCountRefresh();
}

api.runtime.onInstalled.addListener(createAlarm);
api.runtime.onStartup.addListener(createAlarm);
createAlarm();
