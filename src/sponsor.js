/*
 * SponsorBlock skip ranges for the watch page.
 *
 * The request sends the first four characters of the SHA-256 of the video id,
 * not the id itself. Segment data is CC BY-NC-SA from SponsorBlock contributors.
 * This file does not include SponsorBlock's code. Nothing is fetched when
 * Skip segments is turned off.
 */
(() => {
  if (window.__tabytSponsorLoaded) return;
  window.__tabytSponsorLoaded = true;

  const SETTINGS_KEY = "tabyt:settings";
  const api = globalThis.browser || globalThis.chrome;
  const cache = new Map();
  let enabled = true;
  let ticket = 0;

  const LABELS = {
    sponsor: "Sponsor",
    selfpromo: "Self promotion",
    interaction: "Interaction reminder",
    intro: "Intro",
    outro: "Outro",
    preview: "Preview",
    music_offtopic: "Non-music section",
    filler: "Filler",
    exclusive_access: "Exclusive access"
  };

  function videoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname !== "/watch" && url.pathname !== "/live") return "";
      const fromQuery = url.searchParams.get("v") || "";
      if (/^[A-Za-z0-9_-]{6,20}$/.test(fromQuery)) return fromQuery;
    } catch (_error) { /* fall through */ }
    const flexy = document.querySelector("ytd-watch-flexy[video-id]");
    const id = (flexy && flexy.getAttribute("video-id")) || "";
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : "";
  }

  function publish(id, segments) {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute("data-tabyt-skips", JSON.stringify({ videoId: id, segments }));
  }

  function normalize(rows) {
    const out = [];
    const seen = new Set();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row || (row.actionType !== "skip" && row.actionType !== "full")) return;
      const span = row.segment;
      const start = Array.isArray(span) ? Number(span[0]) : NaN;
      const end = Array.isArray(span) ? Number(span[1]) : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      const category = LABELS[row.category] ? row.category : "sponsor";
      const key = category + ":" + Math.round(start) + ":" + Math.round(end);
      if (seen.has(key)) return;
      seen.add(key);
      const note = typeof row.description === "string" ? row.description.replace(/\s+/g, " ").trim().slice(0, 180) : "";
      out.push({
        category,
        label: LABELS[category],
        start: Math.max(0, start),
        end,
        note
      });
    });
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  async function hashPrefix(id) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 4);
  }

  async function refresh() {
    const id = videoId();
    const mine = ++ticket;
    if (!enabled || !id) {
      publish("", []);
      return;
    }
    if (cache.has(id)) {
      publish(id, cache.get(id));
      return;
    }
    try {
      const prefix = await hashPrefix(id);
      if (mine !== ticket) return;
      const response = await fetch("https://sponsor.ajay.app/api/skipSegments/" + prefix);
      if (mine !== ticket) return;
      let segments = [];
      if (response.ok) {
        const rows = await response.json();
        const match = Array.isArray(rows) ? rows.find((item) => item && item.videoID === id) : null;
        segments = normalize(match && match.segments);
      }
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      cache.set(id, segments);
      publish(id, segments);
    } catch (_error) {
      if (mine !== ticket) return;
      publish(id, []);
    }
  }

  function readEnabled(raw) {
    if (raw && typeof raw.layoutSkips === "boolean") enabled = raw.layoutSkips;
  }

  function loadSetting() {
    try {
      if (!api || !api.storage || !api.storage.local) {
        refresh();
        return;
      }
      const done = (result) => {
        readEnabled(result && result[SETTINGS_KEY]);
        refresh();
      };
      const pending = api.storage.local.get(SETTINGS_KEY, done);
      if (pending && typeof pending.then === "function") {
        pending.then(done).catch(() => refresh());
      }
    } catch (_error) {
      refresh();
    }
  }

  document.addEventListener("yt-navigate-finish", () => refresh());
  if (api && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[SETTINGS_KEY]) return;
      readEnabled(changes[SETTINGS_KEY].newValue);
      if (!enabled) cache.clear();
      refresh();
    });
  }
  loadSetting();
})();
