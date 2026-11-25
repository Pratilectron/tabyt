/*
 * TabYT core — pure helpers shared by the background service worker,
 * content script and extension pages. No DOM or browser APIs in here.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TabYTCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VERSION = "1.0.23";
  var HISTORY_MAX_SAMPLES = 1500;
  var RESUME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  var DEFAULT_SETTINGS = Object.freeze({
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
    layoutAmbient: true,
    playerResize: false,
    customControls: true
  });

  var SETTING_SPECS = {
    autoClose: { type: "boolean" },
    inactivityMinutes: { type: "number", min: 5, max: 1440 },
    skipPinned: { type: "boolean" },
    skipAudible: { type: "boolean" },
    skipPlaying: { type: "boolean" },
    maxAutoClosePerRun: { type: "number", min: 1, max: 10 },
    autoCloseNotifications: { type: "boolean" },
    memoryLimitMB: { type: "number", min: 0, max: 65536 },
    notifyOverLimit: { type: "boolean" },
    memoryAction: { type: "enum", values: ["notify", "close"] },
    notifyCooldownMinutes: { type: "number", min: 5, max: 1440 },
    historySampleMinutes: { type: "number", min: 1, max: 60 },
    historyRetentionDays: { type: "number", min: 1, max: 30 },
    maxSavedVideos: { type: "number", min: 25, max: 1000 },
    askBeforeCloseAll: { type: "boolean" },
    saveOnClose: { type: "boolean" },
    resumeExistingTab: { type: "boolean" },
    onboarded: { type: "boolean" },
    layoutEnabled: { type: "boolean" },
    layoutInfo: { type: "boolean" },
    layoutComments: { type: "boolean" },
    layoutOther: { type: "boolean" },
    layoutRelated: { type: "boolean" },
    layoutChat: { type: "boolean" },
    layoutLive: { type: "boolean" },
    layoutAmbient: { type: "boolean" },
    playerResize: { type: "boolean" },
    customControls: { type: "boolean" }
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function applySettings(current, patch) {
    var next = {};
    var key;
    for (key in DEFAULT_SETTINGS) next[key] = DEFAULT_SETTINGS[key];
    if (current && typeof current === "object") {
      for (key in SETTING_SPECS) {
        if (Object.prototype.hasOwnProperty.call(current, key) && current[key] !== undefined) {
          next[key] = current[key];
        }
      }
    }
    var errors = [];
    if (patch && typeof patch === "object") {
      for (key in patch) {
        if (!Object.prototype.hasOwnProperty.call(SETTING_SPECS, key)) continue;
        var spec = SETTING_SPECS[key];
        var value = patch[key];
        if (spec.type === "boolean") {
          next[key] = value === true || value === "true" || value === 1 || value === "1";
        } else if (spec.type === "number") {
          var num = Number(value);
          if (!Number.isFinite(num)) {
            errors.push(key + " must be a number");
            continue;
          }
          next[key] = Math.round(clamp(num, spec.min, spec.max));
        } else if (spec.type === "enum") {
          if (spec.values.indexOf(value) === -1) {
            errors.push(key + " has an unsupported value");
            continue;
          }
          next[key] = value;
        }
      }
    }
    return { settings: next, errors: errors };
  }

  function normalizeSettings(raw) {
    return applySettings(DEFAULT_SETTINGS, raw || {}).settings;
  }

  function isYouTubeUrl(url) {
    if (!url || typeof url !== "string") return false;
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      var host = parsed.hostname.toLowerCase();
      return host === "youtube.com" ||
        host === "www.youtube.com" ||
        host === "m.youtube.com" ||
        host === "music.youtube.com" ||
        host === "youtu.be";
    } catch (_error) {
      return false;
    }
  }

  function parseVideoId(url) {
    if (!url || typeof url !== "string") return null;
    if (!isYouTubeUrl(url)) return null;
    var parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return null;
    }
    var candidate = null;
    if (parsed.hostname.toLowerCase() === "youtu.be") {
      candidate = parsed.pathname.slice(1).split("/")[0];
    } else if (parsed.pathname === "/watch" || parsed.pathname === "/watch/") {
      candidate = parsed.searchParams.get("v");
    } else {
      var parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        if (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed" || parts[0] === "v") {
          candidate = parts[1];
        } else if (parts[0] === "playlist") {
          candidate = null;
        }
      }
    }
    if (!candidate) return null;
    candidate = String(candidate).trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(candidate)) return null;
    return candidate;
  }

  function watchUrl(videoId, positionSeconds) {
    if (!videoId) return "https://www.youtube.com/";
    var url = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
    var pos = Number(positionSeconds);
    if (Number.isFinite(pos) && pos >= 1) url += "&t=" + Math.floor(pos) + "s";
    return url;
  }

  function thumbnailUrl(videoId) {
    if (!videoId) return "";
    return "https://i.ytimg.com/vi/" + encodeURIComponent(videoId) + "/mqdefault.jpg";
  }

  function cleanTitle(title) {
    if (!title) return "";
    var text = String(title)
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/\s*[-–—]\s*YouTube\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 300);
  }

  function formatDuration(totalSeconds) {
    var seconds = Math.floor(Number(totalSeconds));
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return m + ":" + String(s).padStart(2, "0");
  }

  function formatRelative(timestamp, now) {
    var then = Number(timestamp);
    if (!Number.isFinite(then) || then <= 0) return "—";
    var current = Number.isFinite(now) ? now : Date.now();
    var diff = Math.max(0, current - then);
    var minute = 60000;
    var hour = 60 * minute;
    var day = 24 * hour;
    if (diff < 45000) return "just now";
    if (diff < hour) return Math.max(1, Math.round(diff / minute)) + "m ago";
    if (diff < day) return Math.round(diff / hour) + "h ago";
    if (diff < 7 * day) return Math.round(diff / day) + "d ago";
    try {
      return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (_error) {
      return new Date(then).toDateString();
    }
  }

  /*
   * Stable, explainable estimate. Browsers do not expose exact per-tab memory
   * to extensions, so this models the parts the browser counts that the old
   * page-only formula missed: renderer baseline, media pipeline and shared
   * browser services. It tracks process-scale numbers without pretending to
   * be a process measurement.
   */
  function estimateMemory(state) {
    var s = state || {};
    if (s.discarded) return 4;
    var hasVideo = Boolean(s.videoId || Number(s.videoHeight) > 0);
    var mb = 80;
    mb += hasVideo ? (s.playing ? 80 : 30) : 25;
    if (hasVideo) mb += 70;

    var height = Number(s.videoHeight) || 0;
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
    mb += clamp(Math.max(0, Number(s.domNodes) || 0) / 180, 0, 55);
    mb += clamp(Math.max(0, Number(s.jsHeapMB) || 0) * 0.8, 0, 100);

    if (!hasVideo) mb += 10;

    return Math.max(8, Math.round(mb / 5) * 5);
  }

  function formatMemory(mb, options) {
    var value = Number(mb);
    var opts = options || {};
    if (!Number.isFinite(value) || value <= 0) return opts.zero === false ? "0 MB" : "0 MB";
    if (value >= 1024) {
      var gb = value / 1024;
      return gb.toFixed(1).replace(/\.0$/, "") + " GB";
    }
    return Math.round(value) + " MB";
  }

  function badgeFor(totalMB, limitMB) {
    var total = Math.max(0, Number(totalMB) || 0);
    var limit = Math.max(0, Number(limitMB) || 0);
    var text = "";
    if (total > 0) {
      text = total >= 999.5 ? (total / 1024).toFixed(1).replace(/\.0$/, "") + "G" : Math.round(total) + "M";
    }
    var color = "#5b5b66";
    if (limit > 0 && total > limit) color = "#d92d20";
    else if (limit > 0 && total >= limit * 0.8) color = "#b45309";
    return { text: text, color: color };
  }

  function makeHistorySample(tabInfos, now) {
    var at = Number.isFinite(now) ? now : Date.now();
    var items = [];
    (tabInfos || []).forEach(function (tab) {
      if (!tab || tab.incognito) return;
      var mb = Math.max(0, Number(tab.memoryMB) || 0);
      items.push({
        tabId: tab.tabId,
        videoId: tab.videoId || null,
        title: cleanTitle(tab.title || tab.stateTitle || "YouTube tab").slice(0, 160),
        url: tab.url || "",
        memoryMB: Math.round(mb),
        source: tab.memorySource || "estimate"
      });
    });
    var total = items.reduce(function (sum, item) { return sum + item.memoryMB; }, 0);
    var top = items.slice().sort(function (a, b) { return b.memoryMB - a.memoryMB; }).slice(0, 10);
    return {
      t: at,
      total: Math.round(total),
      count: items.length,
      precise: items.length > 0 && items.every(function (item) { return item.source === "process"; }),
      tabs: top.map(function (item) {
        return { videoId: item.videoId, title: item.title, memoryMB: item.memoryMB };
      })
    };
  }

  function pruneHistory(samples, now, retentionDays, maxSamples) {
    var at = Number.isFinite(now) ? now : Date.now();
    var days = clamp(Number(retentionDays) || 7, 1, 30);
    var cap = clamp(Math.round(Number(maxSamples) || HISTORY_MAX_SAMPLES), 50, HISTORY_MAX_SAMPLES);
    var cutoff = at - days * 24 * 60 * 60 * 1000;
    var list = (Array.isArray(samples) ? samples : []).filter(function (sample) {
      return sample && Number.isFinite(sample.t) && sample.t >= cutoff;
    });
    list.sort(function (a, b) { return a.t - b.t; });
    if (list.length > cap) list = list.slice(list.length - cap);
    return list;
  }

  function upsertSaved(list, entry, maxItems) {
    var existing = Array.isArray(list) ? list.slice() : [];
    if (!entry || !entry.videoId) return existing;
    var limit = clamp(Math.round(Number(maxItems) || 300), 25, 1000);
    var now = Number(entry.savedAt) || Date.now();
    var foundIndex = -1;
    for (var i = 0; i < existing.length; i += 1) {
      if (existing[i] && existing[i].videoId === entry.videoId) {
        foundIndex = i;
        break;
      }
    }
    var merged;
    if (foundIndex !== -1) {
      var old = existing[foundIndex];
      merged = Object.assign({}, old, entry);
      merged.firstSavedAt = old.firstSavedAt || old.savedAt || now;
      merged.savedAt = now;
      merged.timesSaved = (Number(old.timesSaved) || 1) + 1;
      existing.splice(foundIndex, 1);
    } else {
      merged = Object.assign({}, entry, {
        savedAt: now,
        firstSavedAt: now,
        timesSaved: 1
      });
    }
    merged.position = Math.max(0, Math.round(Number(merged.position) || 0));
    merged.duration = Math.max(0, Math.round(Number(merged.duration) || 0));
    existing.unshift(merged);
    existing.sort(function (a, b) { return (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0); });
    return existing.slice(0, limit);
  }

  function summarizeHistory(samples) {
    var list = Array.isArray(samples) ? samples : [];
    if (!list.length) {
      return { count: 0, avgMB: 0, peakMB: 0, lastMB: 0, firstAt: 0, lastAt: 0 };
    }
    var total = 0;
    var peak = 0;
    list.forEach(function (sample) {
      var value = Math.max(0, Number(sample.total) || 0);
      total += value;
      if (value > peak) peak = value;
    });
    return {
      count: list.length,
      avgMB: total / list.length,
      peakMB: peak,
      lastMB: Math.max(0, Number(list[list.length - 1].total) || 0),
      firstAt: Number(list[0].t) || 0,
      lastAt: Number(list[list.length - 1].t) || 0
    };
  }

  function topOffenders(samples, limit) {
    var list = Array.isArray(samples) ? samples : [];
    var max = clamp(Math.round(Number(limit) || 8), 1, 30);
    var map = new Map();
    list.forEach(function (sample) {
      (sample && Array.isArray(sample.tabs) ? sample.tabs : []).forEach(function (tab) {
        if (!tab) return;
        var key = tab.videoId || ("title:" + (tab.title || "Unknown"));
        var row = map.get(key);
        var mb = Math.max(0, Number(tab.memoryMB) || 0);
        if (!row) {
          row = {
            key: key,
            videoId: tab.videoId || null,
            title: tab.title || "YouTube tab",
            sumMB: 0,
            peakMB: 0,
            appearances: 0,
            lastSeen: 0
          };
          map.set(key, row);
        }
        row.sumMB += mb;
        row.peakMB = Math.max(row.peakMB, mb);
        row.appearances += 1;
        row.lastSeen = Math.max(row.lastSeen, Number(sample.t) || 0);
        if (tab.title) row.title = tab.title;
      });
    });
    var totalSamples = Math.max(1, list.length);
    return Array.from(map.values())
      .map(function (row) {
        return {
          key: row.key,
          videoId: row.videoId,
          title: row.title,
          avgMB: row.appearances ? row.sumMB / row.appearances : 0,
          peakMB: row.peakMB,
          appearances: row.appearances,
          score: row.sumMB / totalSamples,
          lastSeen: row.lastSeen
        };
      })
      .sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return b.peakMB - a.peakMB;
      })
      .slice(0, max);
  }

  function downsample(samples, maxPoints) {
    var list = Array.isArray(samples) ? samples : [];
    var max = Math.max(2, Math.round(Number(maxPoints) || 120));
    if (list.length <= max) {
      return list.map(function (sample) {
        return {
          t: Number(sample.t) || 0,
          total: Math.max(0, Number(sample.total) || 0),
          count: Math.max(0, Number(sample.count) || 0),
          peak: Math.max(0, Number(sample.total) || 0)
        };
      });
    }
    var result = [];
    var bucketSize = list.length / max;
    for (var i = 0; i < max; i += 1) {
      var start = Math.floor(i * bucketSize);
      var end = Math.max(start + 1, Math.floor((i + 1) * bucketSize));
      var bucket = list.slice(start, end);
      var sum = 0;
      var peak = 0;
      var count = 0;
      bucket.forEach(function (sample) {
        var total = Math.max(0, Number(sample.total) || 0);
        sum += total;
        peak = Math.max(peak, total);
        count += Math.max(0, Number(sample.count) || 0);
      });
      result.push({
        t: Number(bucket[bucket.length - 1].t) || 0,
        total: sum / bucket.length,
        count: count / bucket.length,
        peak: peak
      });
    }
    return result;
  }

  function reasonLabel(reason) {
    var labels = {
      manual: "Closed manually",
      "save-close": "Saved & closed",
      inactive: "Auto-closed after inactivity",
      limit: "Closed to reduce memory",
      "close-all": "Closed with all tabs",
      closed: "Tab closed",
      "window-close": "Window closed",
      navigated: "Video left behind"
    };
    return labels[reason] || "Saved";
  }

  function hashHue(value) {
    var text = String(value || "");
    var hash = 0;
    for (var i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) % 360;
    }
    return hash;
  }

  function videoStillWorthResuming(position, duration) {
    var pos = Number(position) || 0;
    var dur = Number(duration) || 0;
    if (pos < 5) return false;
    if (dur > 0 && pos > dur - 3) return false;
    return true;
  }

  /*
   * Automatic cleanup guards, shared by the inactivity sweep and the memory
   * limit enforcement. Kept pure so the protection rules are testable.
   */
  function canAutoClose(info, settings, now) {
    if (!info || info.incognito) return false;
    if (info.active) return false;
    if (info.status && info.status !== "complete" && !info.discarded) return false;
    var config = settings || DEFAULT_SETTINGS;
    if (config.skipPinned && info.pinned) return false;
    if (config.skipAudible && info.audible) return false;
    if (config.skipPlaying && info.playing) return false;
    var minutes = Number(config.inactivityMinutes);
    if (!isFinite(minutes) || minutes < 5) minutes = 5;
    var threshold = minutes * 60000;
    return (Number(now) || Date.now()) - (Number(info.lastActive) || 0) >= threshold;
  }

  /*
   * chrome.storage is async. Content scripts read this synchronous snapshot at
   * document_start so the TabYT layout is applied before YouTube's first paint
   * instead of flashing in after the page has already rendered natively.
   */
  var EARLY_SETTINGS_KEY = "tabyt:early-settings";
  function readEarlySettings() {
    try {
      if (typeof sessionStorage === "undefined") return null;
      var raw = sessionStorage.getItem(EARLY_SETTINGS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  function writeEarlySettings(settings) {
    try {
      if (typeof sessionStorage === "undefined" || !settings) return;
      sessionStorage.setItem(EARLY_SETTINGS_KEY, JSON.stringify(settings));
    } catch (_error) {
      /* Private mode or quota: the async storage read still works. */
    }
  }
  function applyEarlyClasses(settings) {
    try {
      if (typeof document === "undefined" || !document.documentElement) return;
      var root = document.documentElement;
      var config = settings || DEFAULT_SETTINGS;
      root.classList.toggle("tabyt-layout-on", config.layoutEnabled !== false);
      root.classList.toggle("tabyt-player-resize", config.playerResize === true);
      root.classList.toggle("tabyt-custom-controls", config.customControls !== false);
    } catch (_error) {
      /* Ignore non-DOM contexts such as the background worker. */
    }
  }

  return {
    VERSION: VERSION,
    readEarlySettings: readEarlySettings,
    writeEarlySettings: writeEarlySettings,
    applyEarlyClasses: applyEarlyClasses,
    HISTORY_MAX_SAMPLES: HISTORY_MAX_SAMPLES,
    RESUME_MAX_AGE_MS: RESUME_MAX_AGE_MS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SETTING_SPECS: SETTING_SPECS,
    clamp: clamp,
    applySettings: applySettings,
    normalizeSettings: normalizeSettings,
    isYouTubeUrl: isYouTubeUrl,
    parseVideoId: parseVideoId,
    watchUrl: watchUrl,
    thumbnailUrl: thumbnailUrl,
    cleanTitle: cleanTitle,
    formatDuration: formatDuration,
    formatRelative: formatRelative,
    estimateMemory: estimateMemory,
    formatMemory: formatMemory,
    badgeFor: badgeFor,
    makeHistorySample: makeHistorySample,
    pruneHistory: pruneHistory,
    upsertSaved: upsertSaved,
    summarizeHistory: summarizeHistory,
    topOffenders: topOffenders,
    downsample: downsample,
    reasonLabel: reasonLabel,
    hashHue: hashHue,
    videoStillWorthResuming: videoStillWorthResuming,
    canAutoClose: canAutoClose
  };
});
