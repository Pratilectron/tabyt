/*
 * TabYT content script — reads the current YouTube player state and reports
 * user activity. It never changes the page except to seek to a saved position
 * when the user explicitly resumes a video from TabYT.
 */
(() => {
  if (window.__tabytContentLoaded) return;
  window.__tabytContentLoaded = true;

  const C = window.TabYTCore;
  const api = globalThis.browser || globalThis.chrome;
  const SEND_INTERVAL = 45000;
  const CHECKPOINT_INTERVAL = 60000;

  let lastHref = location.href;
  let lastActivitySent = 0;
  let resumeAppliedFor = null;
  let toastTimer = null;
  let checkpointTimer = null;

  function getVideo() {
    return document.querySelector("video.html5-main-video") ||
      document.querySelector("video.video-stream") ||
      document.querySelector("video");
  }

  function getVideoId() {
    const fromUrl = C.parseVideoId(location.href);
    if (fromUrl) return fromUrl;
    const flexy = document.querySelector("ytd-watch-flexy[video-id]");
    if (flexy) {
      const id = flexy.getAttribute("video-id");
      if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) return id;
    }
    return null;
  }

  function metaContent(selector) {
    const el = document.querySelector(selector);
    return el ? el.getAttribute("content") || "" : "";
  }

  function getTitle(videoId) {
    const selectors = [
      "ytd-watch-metadata h1 yt-formatted-string",
      "h1.ytd-watch-metadata",
      "#title h1 yt-formatted-string",
      "ytmusic-player-bar .title",
      "ytmusic-player-bar yt-formatted-string.title",
      "yt-formatted-string.ytmusic-player-bar"
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = (el.getAttribute("title") || el.textContent || "").trim();
        if (text) return C.cleanTitle(text);
      }
    }
    const og = metaContent('meta[property="og:title"]') || metaContent('meta[name="title"]');
    if (og) return C.cleanTitle(og);
    return C.cleanTitle(document.title || "YouTube video") || (videoId ? "YouTube video" : "YouTube tab");
  }

  function getChannel() {
    const selectors = [
      "ytd-video-owner-renderer #channel-name a",
      "#owner #channel-name a",
      "ytmusic-player-bar .byline a",
      "ytmusic-player-bar .subtitle a"
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent) return el.textContent.replace(/\s+/g, " ").trim().slice(0, 120);
    }
    return metaContent('meta[itemprop="author"]') || metaContent('link[itemprop="name"]');
  }

  function bufferedSeconds(video) {
    if (!video || !video.buffered || !video.buffered.length) return 0;
    try {
      let max = 0;
      for (let i = 0; i < video.buffered.length; i += 1) {
        max = Math.max(max, video.buffered.end(i) - video.buffered.start(i));
      }
      return max;
    } catch (_error) {
      return 0;
    }
  }

  function collect() {
    const video = getVideo();
    const videoId = getVideoId();
    const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
    const position = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const playing = !!(video && !video.paused && !video.ended && video.readyState > 2);
    let jsHeapMB = 0;
    try {
      if (performance && performance.memory && performance.memory.usedJSHeapSize) {
        jsHeapMB = performance.memory.usedJSHeapSize / (1024 * 1024);
      }
    } catch (_error) {
      jsHeapMB = 0;
    }
    const liveBadge = document.querySelector(".ytp-live-badge:not([hidden])");
    return {
      videoId: videoId || null,
      url: location.href,
      title: getTitle(videoId),
      channel: getChannel(),
      thumbnail: videoId ? C.thumbnailUrl(videoId) : metaContent('meta[property="og:image"]'),
      position,
      duration,
      playing,
      paused: !video || video.paused,
      ended: !!(video && video.ended),
      muted: !!(video && video.muted),
      bufferedSeconds: bufferedSeconds(video),
      videoHeight: video ? Number(video.videoHeight) || 0 : 0,
      videoWidth: video ? Number(video.videoWidth) || 0 : 0,
      isLive: !!(video && video.duration === Infinity) || !!liveBadge,
      isShort: location.pathname.startsWith("/shorts/"),
      // The document-wide node scan is O(DOM); only pay it for visible tabs.
      domNodes: document.visibilityState === "visible" ? document.getElementsByTagName("*").length : 0,
      jsHeapMB,
      visible: document.visibilityState === "visible",
      at: Date.now()
    };
  }

  function send(message) {
    try {
      return Promise.resolve(api.runtime.sendMessage(message)).catch(() => undefined);
    } catch (_error) {
      return Promise.resolve(undefined);
    }
  }

  function markActivity(force) {
    const now = Date.now();
    if (!force && now - lastActivitySent < SEND_INTERVAL) return;
    lastActivitySent = now;
    send({ type: "ACTIVITY", ready: force, state: collect() });
  }

  function checkpoint(force) {
    const state = collect();
    if (!state.videoId && !force) return;
    if (!state.playing && !state.visible && !force) return;
    send({ type: "CHECKPOINT", state });
  }

  function showToast(text) {
    let el = document.getElementById("__tabyt_toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "__tabyt_toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.style.cssText = [
        "position:fixed",
        "right:24px",
        "top:72px",
        "z-index:2147483647",
        "max-width:min(360px,calc(100vw - 40px))",
        "padding:11px 15px 11px 13px",
        "border-radius:10px",
        "border-left:3px solid #ff2d4b",
        "background:#18181b",
        "color:#f4f4f5",
        "font:600 13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
        "box-shadow:0 10px 32px rgba(0,0,0,.45)",
        "opacity:0",
        "transform:translateY(-8px)",
        "transition:opacity .18s ease,transform .18s ease",
        "pointer-events:none"
      ].join(";");
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(() => el.remove(), 220);
    }, 4200);
  }

  function waitForVideo(timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const video = getVideo();
        if (video) {
          clearInterval(timer);
          resolve(video);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 250);
    });
  }

  function applySeek(video, position, announce) {
    if (!video) return;
    let target = Math.max(0, Number(position) || 0);
    if (Number.isFinite(video.duration) && video.duration > 2) {
      target = Math.min(target, video.duration - 1.5);
    }
    try {
      if (Math.abs(video.currentTime - target) > 2) video.currentTime = target;
    } catch (_error) {
      /* Ignore seek failures; YouTube will keep playing from its own position. */
    }
    if (announce) showToast(`Resumed at ${C.formatDuration(target)}`);
  }

  async function seek(position, announce) {
    const video = await waitForVideo(8000);
    if (!video) return false;
    if (video.readyState >= 1) {
      applySeek(video, position, announce !== false);
    } else {
      video.addEventListener("loadedmetadata", () => applySeek(video, position, announce !== false), { once: true });
    }
    return true;
  }

  async function maybeResume(videoId) {
    if (!videoId || resumeAppliedFor === videoId) return;
    resumeAppliedFor = videoId;
    const response = await send({ type: "GET_RESUME", videoId });
    const position = response && Number(response.position);
    if (!position || position < 5) return;
    const applied = await seek(position, true);
    if (applied) send({ type: "CLEAR_RESUME", videoId });
  }

  function checkNavigation() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const videoId = getVideoId();
    if (videoId !== resumeAppliedFor) resumeAppliedFor = null;
    markActivity(true);
    if (videoId) {
      setTimeout(() => maybeResume(videoId), 400);
    }
  }

  function init() {
    markActivity(true);
    setTimeout(() => {
      const videoId = getVideoId();
      if (videoId) maybeResume(videoId);
    }, 600);

    const activityEvents = ["pointerdown", "keydown", "scroll", "touchstart"];
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, () => markActivity(false), {
        capture: true,
        passive: eventName === "scroll" || eventName === "touchstart"
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        markActivity(false);
        checkpoint(true);
      }
    });
    document.addEventListener("play", () => markActivity(false), true);
    document.addEventListener("pause", () => {
      markActivity(false);
      setTimeout(() => checkpoint(true), 300);
    }, true);

    document.addEventListener("yt-navigate-finish", checkNavigation);
    window.addEventListener("popstate", checkNavigation);
    setInterval(checkNavigation, 2000);

    checkpointTimer = setInterval(() => checkpoint(false), CHECKPOINT_INTERVAL);
    window.addEventListener("pagehide", () => checkpoint(true));
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "GET_TAB_STATE" || message.type === "PING") {
      sendResponse({ ok: true, state: collect() });
      return false;
    }
    if (message.type === "SEEK") {
      seek(message.position, message.announce !== false)
        .then((applied) => sendResponse({ ok: applied }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    return false;
  });

  /*
   * Sync data with the background as early as the page starts loading: the
   * first activity record goes out while YouTube is still parsing, so the
   * background has state by the time the player appears.
   */
  markActivity(true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
