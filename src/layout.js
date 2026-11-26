/*
 * TabYT watch layout.
 *
 * Runs on every YouTube page the extension matches. The player column is on
 * the left and keeps the title, channel, views and likes under the video.
 * The right rail holds Info (the full description), one discussion tab,
 * other videos and related videos. That tab lists comments or live chat,
 * whichever the user picked in settings.
 * The watch page is a fixed shell: the two columns scroll independently, the
 * document itself does not scroll. A divider resizes the rail. Related links
 * delegate to YouTube's own anchors so navigation stays an SPA.
 * Ambient color behind the player is a small canvas copy of the current
 * frame, blurred twice on that bitmap. It never reads pixels back in JavaScript.
 */
(() => {
  if (window.__tabytLayoutLoaded) return;
  window.__tabytLayoutLoaded = true;

  const SETTINGS_KEY = "tabyt:settings";
  const DEFAULTS = {
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
    // Player resizing is opt-in; off by default so the YouTube player keeps its
    // native dimensions until the user enables it in Settings.
    playerResize: false,
    rememberLayoutSize: true,
    layoutSide: 420,
    layoutRadius: 16,
    layoutMotion: true,
    layoutStartTab: "info",
    // TabYT's own control bar replaces YouTube's native chrome by default.
    customControls: true
  };

  let glow = null;
  let glowVideo = null;

  const api = globalThis.browser || globalThis.chrome;
  const core = window.TabYTCore;
  const earlySettings = core && core.readEarlySettings ? core.readEarlySettings() : null;
  let settings = readStored(earlySettings);
  let activeTab = "info";
  let quiet = false;
  let pendingSync = false;
  let timer = 0;
  let injectionTimer = 0;
  let enterTimer = 0;
  let relatedKey = "";
  let booted = false;
  let fastUntil = 0;
  let earlyRetryTimer = 0;
  let earlyObserver = null;

  /*
   * Apply the gating classes as early as the page loads. Chrome's
   * document_start can run before the parser inserts <html>, and some
   * browsers do not guarantee it at all, so retry until the element exists.
   * Combined with the document_start CSS injection this puts TabYT's layout
   * gate in place before YouTube's first paint instead of letting the native
   * layout flash in.
   */
  function applyEarlyClassesSafe() {
    if (!core || !core.applyEarlyClasses) return;
    if (!document.documentElement) {
      if (!earlyRetryTimer) {
        earlyRetryTimer = setTimeout(applyEarlyClassesSafe, 10);
      }
      if (!earlyObserver) {
        earlyObserver = new MutationObserver(applyEarlyClassesSafe);
        earlyObserver.observe(document, { childList: true });
      }
      return;
    }
    core.applyEarlyClasses(settings);
    applyGlassTier();
    if (earlyRetryTimer) {
      clearTimeout(earlyRetryTimer);
      earlyRetryTimer = 0;
    }
    if (earlyObserver) {
      earlyObserver.disconnect();
      earlyObserver = null;
    }
  }

  /*
   * backdrop-filter on the sticky comment dock is costly when the ambient
   * canvas animates behind it. One light blur on the dock is enough; nested
   * blurs on the composer are avoided in CSS. Lite tier drops blur entirely.
   */
  function applyGlassTier() {
    const root = document.documentElement;
    if (!root) return;
    let lite = false;
    try {
      if (settings.layoutMotion === false) lite = true;
      if (window.matchMedia) {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) lite = true;
        if (window.matchMedia("(prefers-reduced-transparency: reduce)").matches) lite = true;
      }
      const cores = navigator.hardwareConcurrency;
      if (Number.isFinite(cores) && cores <= 4) lite = true;
      const mem = navigator.deviceMemory;
      if (Number.isFinite(mem) && mem <= 4) lite = true;
      const conn = navigator.connection;
      if (conn && (conn.saveData || conn.effectiveType === "2g" || conn.effectiveType === "slow-2g")) {
        lite = true;
      }
    } catch (_error) { /* ignore */ }
    root.classList.toggle("tabyt-glass-lite", lite);
  }

  applyEarlyClassesSafe();

  function saveEarly() {
    if (core && core.writeEarlySettings) core.writeEarlySettings(settings);
  }

  /*
   * Player sizing writes inline !important styles. Keep the original value of
   * every property so disabling the layout (or leaving the watch page) can
   * hand the player back to YouTube untouched.
   */
  const styleBackup = new Map();
  const panelScroll = new Map();
  let mainObserver = null;

  function readStored(raw) {
    const normalized = core && core.normalizeSettings ? core.normalizeSettings(raw || {}) : null;
    const next = Object.assign({}, DEFAULTS);
    const source = normalized || raw;
    if (!source || typeof source !== "object") return next;
    Object.keys(DEFAULTS).forEach((key) => {
      if (source[key] !== undefined) next[key] = source[key];
    });
    return next;
  }

  function preferredTab() {
    const name = settings.layoutStartTab;
    if (name === "live") return "comments";
    if (name === "comments" || name === "other" || name === "related" || name === "info") {
      return name;
    }
    return "info";
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        if (!api || !api.storage || !api.storage.local) {
          resolve(readStored(null));
          return;
        }
        const done = (result) => {
          resolve(readStored(result && result[SETTINGS_KEY]));
        };
        /*
         * Chrome's callback form returns nothing; Firefox's browser.storage
         * ignores the callback and returns a promise. Support both so saved
         * layout settings apply in either browser.
         */
        const pending = api.storage.local.get(SETTINGS_KEY, done);
        if (pending && typeof pending.then === "function") {
          pending.then(done).catch(() => resolve(readStored(null)));
        }
      } catch (_error) {
        resolve(readStored(null));
      }
    });
  }

  function videoId() {
    try {
      const url = new URL(location.href);
      const fromQuery = url.searchParams.get("v");
      if (fromQuery && /^[A-Za-z0-9_-]{6,20}$/.test(fromQuery)) return fromQuery;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && (parts[0] === "live" || parts[0] === "shorts" || parts[0] === "embed")) {
        return /^[A-Za-z0-9_-]{6,20}$/.test(parts[1]) ? parts[1] : "";
      }
    } catch (_error) {
      /* Keep going with the flexy attribute. */
    }
    const flexy = document.querySelector("ytd-watch-flexy[video-id]");
    return (flexy && flexy.getAttribute("video-id")) || "";
  }

  let pageMeta = { videoId: "", description: "", chapters: [] };

  function emptyMeta() {
    return { videoId: "", description: "", chapters: [] };
  }

  function sanitizeMeta(raw) {
    const chapters = [];
    const seen = new Set();
    if (raw && Array.isArray(raw.chapters)) {
      raw.chapters.forEach((chapter) => {
        const title = chapter && typeof chapter.title === "string"
          ? chapter.title.replace(/\s+/g, " ").trim().slice(0, 180)
          : "";
        const seconds = chapter ? Number(chapter.seconds) : NaN;
        if (!title || !Number.isFinite(seconds) || seconds < 0) return;
        const key = Math.round(seconds) + "\n" + title;
        if (seen.has(key)) return;
        seen.add(key);
        chapters.push({ title, seconds: Math.round(seconds) });
      });
    }
    chapters.sort((a, b) => a.seconds - b.seconds);
    return {
      videoId: raw && typeof raw.videoId === "string" ? raw.videoId : "",
      description: raw && typeof raw.description === "string" ? raw.description : "",
      chapters
    };
  }

  function readPageMeta() {
    const raw = document.documentElement && document.documentElement.getAttribute("data-tabyt-meta");
    if (!raw) return emptyMeta();
    try {
      return sanitizeMeta(JSON.parse(raw));
    } catch (_error) {
      return emptyMeta();
    }
  }

  function metaForCurrentVideo() {
    const meta = pageMeta.videoId || pageMeta.description ? pageMeta : readPageMeta();
    const id = videoId();
    if (meta.videoId && id && meta.videoId !== id) return emptyMeta();
    return meta;
  }

  function watchRoot() {
    const root = document.querySelector("ytd-watch-flexy");
    if (!root || root.hidden) return null;
    return root;
  }

  /*
   * ytd-watch-flexy stays in YouTube's SPA DOM on every page, so the layout
   * must follow the route rather than the element's presence.
   */
  function onWatchPage() {
    try {
      const path = new URL(location.href).pathname;
      return path === "/watch" || path === "/live";
    } catch (_error) {
      return false;
    }
  }

  /*
   * Live streams use chat instead of comments. Detect them from the route and
   * YouTube's own live markers so the Comments tab can be hidden only there.
   */
  function isLiveVideo() {
    try {
      const path = new URL(location.href).pathname;
      if (path === "/live" || path.indexOf("/live/") === 0) return true;
    } catch (_error) {
      /* fall through to the DOM checks */
    }
    const root = watchRoot();
    if (root) {
      if ((root.getAttribute("live-status") || "").toLowerCase() === "live") return true;
      if ((root.getAttribute("player-type") || "").toLowerCase() === "live") return true;
    }
    /*
     * The live badge element is in the player on every video. It only means
     * a livestream when YouTube puts it on the live time display.
     */
    const badge = document.querySelector(".ytp-time-display.ytp-live .ytp-live-badge");
    return !!(badge && !badge.hidden && badge.style.display !== "none");
  }

  function secondary() {
    const root = watchRoot();
    if (!root) return null;
    return root.querySelector("#secondary-inner") || root.querySelector("#secondary");
  }

  function firstMatch(selectors, root) {
    const scope = root || document;
    for (let i = 0; i < selectors.length; i += 1) {
      const found = scope.querySelector(selectors[i]);
      if (found) return found;
    }
    return null;
  }

  function park(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute("data-tabyt-parked") && node.__tabytMarker && node.__tabytMarker.isConnected) return;
    if (!node.parentNode) return;
    const marker = document.createComment("tabyt-home");
    node.parentNode.insertBefore(marker, node);
    node.__tabytMarker = marker;
    node.setAttribute("data-tabyt-parked", "1");
  }

  function restore(node) {
    if (!node || !node.hasAttribute("data-tabyt-parked")) return;
    const marker = node.__tabytMarker;
    node.removeAttribute("data-tabyt-parked");
    node.__tabytMarker = null;
    if (!marker) return;
    if (marker.parentNode) {
      marker.parentNode.insertBefore(node, marker);
      marker.remove();
      return;
    }
    /*
     * YouTube replaced the original subtree during SPA navigation. The parked
     * node has no home any more, so drop it instead of leaving a stale copy
     * inside the panel.
     */
    if (node.isConnected) node.remove();
  }

  function destroyGlow() {
    if (glow && typeof glow.destroy === "function") {
      try { glow.destroy(); } catch (_error) { /* The player may already be gone. */ }
    }
    glow = null;
    glowVideo = null;
  }

  /*
   * Two draws of a ~96px bitmap, about 8 times a second. The first keeps the
   * color grade. The second blur melts the patches that a single 8px blur
   * leaves behind when the bitmap is stretched across the page. The scratch
   * canvas stays off the document, so the compositor still has one layer.
   * requestVideoFrameCallback only starts a sample. The loop stops while the
   * tab is hidden or the video is paused, and the last frame stays up.
   */
  function createFrameGlow(video) {
    const canvas = document.createElement("canvas");
    const scratch = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    const src = scratch.getContext("2d", { alpha: false, desynchronized: true });
    let handle = 0;
    let timer = 0;
    let stopped = false;
    const sampleMs = 125;

    const paint = () => {
      if (!ctx || !src || video.readyState < 2) return;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;
      const scale = 96 / Math.max(width, height);
      const cw = Math.max(1, Math.round(width * scale));
      const ch = Math.max(1, Math.round(height * scale));
      if (scratch.width !== cw) scratch.width = cw;
      if (scratch.height !== ch) scratch.height = ch;
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      try {
        src.filter = "blur(5px) saturate(1.35) brightness(0.8)";
        src.drawImage(video, -8, -8, cw + 16, ch + 16);
        src.filter = "none";
        ctx.filter = "blur(8px)";
        ctx.drawImage(scratch, 0, 0, cw, ch);
        ctx.filter = "none";
      } catch (_error) { /* A detached video throws. */ }
    };

    const stopLoop = () => {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      if (handle && typeof video.cancelVideoFrameCallback === "function") {
        try { video.cancelVideoFrameCallback(handle); } catch (_error) { /* already gone */ }
      }
      handle = 0;
    };

    const arm = () => {
      if (stopped || timer || handle) return;
      if (document.hidden || video.paused || video.ended) return;
      const draw = () => {
        handle = 0;
        if (stopped || document.hidden || video.paused || video.ended) return;
        paint();
        timer = setTimeout(() => {
          timer = 0;
          arm();
        }, sampleMs);
      };
      if (typeof video.requestVideoFrameCallback === "function") {
        handle = video.requestVideoFrameCallback(draw);
      } else {
        draw();
      }
    };

    const wake = () => {
      if (stopped || document.hidden) return;
      if (video.paused || video.ended) {
        paint();
        return;
      }
      arm();
    };

    video.addEventListener("play", wake);
    video.addEventListener("loadeddata", wake);
    video.addEventListener("seeked", paint);
    document.addEventListener("visibilitychange", wake);
    wake();

    return {
      canvas,
      destroy() {
        stopped = true;
        stopLoop();
        video.removeEventListener("play", wake);
        video.removeEventListener("loadeddata", wake);
        video.removeEventListener("seeked", paint);
        document.removeEventListener("visibilitychange", wake);
        canvas.remove();
      }
    };
  }

  function playerInner() {
    const root = watchRoot();
    return root && root.querySelector("#primary-inner");
  }

  function ensureAmbient() {
    const parent = document.body;
    if (!parent) return null;
    let host = document.getElementById("tabyt-ambient");
    if (!host) {
      host = document.createElement("div");
      host.id = "tabyt-ambient";
      host.setAttribute("aria-hidden", "true");
    }
    if (host.parentElement !== parent) parent.appendChild(host);
    document.documentElement.classList.add("tabyt-ambient");
    return host;
  }

  function placeGlowCanvas() {
    const host = ensureAmbient();
    const canvas = glow && glow.canvas;
    if (!host || !canvas) return;
    if (canvas.parentElement !== host) host.appendChild(canvas);
  }

  function syncGlow() {
    if (!settings.layoutEnabled || !settings.layoutAmbient) {
      destroyGlow();
      document.documentElement.classList.remove("tabyt-ambient");
      clearAmbientOrigin();
      const stale = document.getElementById("tabyt-ambient");
      if (stale) stale.remove();
      return;
    }
    const video = document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video");
    if (!video || !video.isConnected || !video.parentElement) return;
    if (!glow || glowVideo !== video) {
      destroyGlow();
      try {
        glow = createFrameGlow(video);
        glowVideo = video;
      } catch (_error) {
        glow = null;
        glowVideo = null;
        return;
      }
    }
    placeGlowCanvas();
    placeAmbientOrigin();
  }

  /*
   * The ambient canvas is fixed to the page. A video reload can drop the
   * canvas. Check health rather than trusting a one-time init.
   */
  function ambientHealthy() {
    if (!settings.layoutEnabled || !settings.layoutAmbient) return true;
    const host = document.getElementById("tabyt-ambient");
    if (!document.body || !host || !host.isConnected || host.parentElement !== document.body) return false;
    if (!glow || !glowVideo || !glowVideo.isConnected || !glow.canvas || !glow.canvas.isConnected) {
      return false;
    }
    return true;
  }

  function reinjectAmbient() {
    if (!ambientHealthy()) syncGlow();
  }

  function setImp(node, property, value) {
    if (!node || !node.isConnected) return;
    const current = node.style.getPropertyValue(property);
    const currentPriority = node.style.getPropertyPriority(property);
    if (current === value && currentPriority === "important") return;
    let props = styleBackup.get(node);
    if (!props) {
      props = new Map();
      styleBackup.set(node, props);
    }
    if (!props.has(property)) {
      props.set(property, {
        value: current,
        priority: currentPriority
      });
    }
    node.style.setProperty(property, value, "important");
  }

  function clearFitStyles() {
    styleBackup.forEach((props, node) => {
      props.forEach((old, property) => {
        if (old.value) node.style.setProperty(property, old.value, old.priority || "");
        else node.style.removeProperty(property);
      });
    });
    styleBackup.clear();
  }

  function pruneFitStyles() {
    Array.from(styleBackup.keys()).forEach((node) => {
      if (!node.isConnected) styleBackup.delete(node);
    });
  }

  let dragRafId = 0;
  let dragCleanup = null;
  let lastTargetW = 0;
  let lastTargetH = 0;

  function isFullscreen() {
    const root = watchRoot();
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      (root && (root.hasAttribute("fullscreen") || root.classList.contains("fullscreen")))
    );
  }

  /*
   * Fit the player into the left column so the title and actions sit under it
   * with no scrollbar. A full-width 16:9 box is taller than the viewport once
   * the metadata is added, which is what forced #primary to scroll.
   *
   * The drag handle is still opt-in. This fit runs whenever the layout is on.
   * Sizes are CSS variables, not inline sizes on the player internals, so
   * fullscreen can ignore them and the browser owns the real size.
   */
  function clearPlayerBox() {
    clearFitStyles();
    lastTargetW = 0;
    lastTargetH = 0;
    document.documentElement.classList.remove("tabyt-player-fit");
    document.documentElement.style.removeProperty("--tabyt-player-width");
    document.documentElement.style.removeProperty("--tabyt-player-height");
    const root = watchRoot();
    if (root) {
      root.style.removeProperty("--ytd-watch-flexy-player-width");
      root.style.removeProperty("--ytd-watch-flexy-player-height");
    }
  }

  function fitPlayer() {
    document.documentElement.classList.toggle("tabyt-player-resize", !!settings.playerResize);
    if (isFullscreen()) {
      clearPlayerBox();
      document.documentElement.classList.add("tabyt-fullscreen");
      return;
    }
    document.documentElement.classList.remove("tabyt-fullscreen");
    const root = watchRoot();
    const primary = root && root.querySelector("#primary");
    const player = root && root.querySelector("#player");
    if (!root || !primary || !player) return;

    const primaryStyle = getComputedStyle(primary);
    const padX = (parseFloat(primaryStyle.paddingLeft) || 0) + (parseFloat(primaryStyle.paddingRight) || 0);
    const padY = (parseFloat(primaryStyle.paddingTop) || 0) + (parseFloat(primaryStyle.paddingBottom) || 0);
    const below = root.querySelector("#below");
    const belowH = below ? below.offsetHeight : 0;
    const gap = belowH > 0 ? 8 : 0;
    const availW = Math.floor(primary.clientWidth - padX);
    const availH = Math.floor(primary.clientHeight - padY - belowH - gap);
    if (availW < 160 || availH < 120) return;

    const video = document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");
    const ratio = (video && video.videoWidth > 0 && video.videoHeight > 0)
      ? video.videoWidth / video.videoHeight
      : 16 / 9;

    let targetH = Math.round(availW / ratio);
    let targetW = availW;
    if (targetH > availH) {
      targetH = availH;
      targetW = Math.max(160, Math.round(targetH * ratio));
      if (targetW > availW) {
        targetW = availW;
        targetH = Math.max(120, Math.round(targetW / ratio));
      }
    }

    placeAmbientOrigin();
    if (lastTargetW === targetW && lastTargetH === targetH) return;

    lastTargetW = targetW;
    lastTargetH = targetH;
    document.documentElement.classList.add("tabyt-player-fit");

    const widthPx = targetW + "px";
    const heightPx = targetH + "px";
    document.documentElement.style.setProperty("--tabyt-player-width", widthPx);
    document.documentElement.style.setProperty("--tabyt-player-height", heightPx);
    root.style.setProperty("--ytd-watch-flexy-player-width", widthPx);
    root.style.setProperty("--ytd-watch-flexy-player-height", heightPx);
    ensureAmbient();
  }

  /*
   * The page wash is masked to the player, so the color looks like it is
   * spilling out of the video instead of sitting as a flat wallpaper.
   */
  function placeAmbientOrigin() {
    if (!settings.layoutEnabled || !settings.layoutAmbient || isFullscreen()) return;
    const root = watchRoot();
    const player = root && root.querySelector("#player");
    if (!player) return;
    const rect = player.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const x = ((rect.left + rect.width / 2) / Math.max(window.innerWidth, 1) * 100).toFixed(1) + "%";
    const y = ((rect.top + rect.height / 2) / Math.max(window.innerHeight, 1) * 100).toFixed(1) + "%";
    const rx = Math.round(Math.max(rect.width * 0.9, 280)) + "px";
    const ry = Math.round(Math.max(rect.height * 1.2, 220)) + "px";
    const el = document.documentElement;
    if (el.style.getPropertyValue("--tabyt-glow-x") === x &&
        el.style.getPropertyValue("--tabyt-glow-y") === y &&
        el.style.getPropertyValue("--tabyt-glow-rx") === rx &&
        el.style.getPropertyValue("--tabyt-glow-ry") === ry) return;
    el.style.setProperty("--tabyt-glow-x", x);
    el.style.setProperty("--tabyt-glow-y", y);
    el.style.setProperty("--tabyt-glow-rx", rx);
    el.style.setProperty("--tabyt-glow-ry", ry);
  }

  function clearAmbientOrigin() {
    const el = document.documentElement;
    el.style.removeProperty("--tabyt-glow-x");
    el.style.removeProperty("--tabyt-glow-y");
    el.style.removeProperty("--tabyt-glow-rx");
    el.style.removeProperty("--tabyt-glow-ry");
  }

  function observePrimary() {
    const root = watchRoot();
    const primary = root && root.querySelector("#primary");
    if (!primary || typeof ResizeObserver !== "function") return;
    const below = root.querySelector("#below");
    if (mainObserver && mainObserver.__target === primary) {
      if (below && !below.__tabytObserved) {
        mainObserver.observe(below);
        below.__tabytObserved = true;
      }
      return;
    }
    if (mainObserver) mainObserver.disconnect();
    mainObserver = new ResizeObserver(() => fitPlayer());
    mainObserver.__target = primary;
    mainObserver.observe(primary);
    if (below) {
      mainObserver.observe(below);
      below.__tabytObserved = true;
    }

    const video = document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");
    if (video && !video.__tabytMetaBound) {
      video.__tabytMetaBound = true;
      video.addEventListener("loadedmetadata", () => fitPlayer());
    }
  }

  function sideWidth() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--tabyt-side");
    const width = parseFloat(raw);
    return Number.isFinite(width) ? width : 420;
  }

  function setSide(px, persist) {
    const next = Math.round(Math.min(680, Math.max(280, px)));
    document.documentElement.style.setProperty("--tabyt-side", next + "px");
    if (persist !== false && settings.rememberLayoutSize) persistSide(next);
    fitPlayer();
  }

  function persistSide(px) {
    settings.layoutSide = px;
    saveEarly();
    if (!api || !api.storage || !api.storage.local) return;
    const write = (current) => {
      const base = current && current[SETTINGS_KEY] && typeof current[SETTINGS_KEY] === "object"
        ? current[SETTINGS_KEY]
        : {};
      try {
        api.storage.local.set({ [SETTINGS_KEY]: Object.assign({}, base, { layoutSide: px }) });
      } catch (_error) { /* Storage can reject in private contexts. */ }
    };
    try {
      const pending = api.storage.local.get(SETTINGS_KEY, write);
      if (pending && typeof pending.then === "function") pending.then(write).catch(() => {});
    } catch (_error) { /* Ignore storage failures. */ }
  }

  function applySavedSide() {
    if (settings.rememberLayoutSize === false) {
      document.documentElement.style.removeProperty("--tabyt-side");
      return;
    }
    const width = Math.round(Math.min(680, Math.max(280, Number(settings.layoutSide) || 420)));
    document.documentElement.style.setProperty("--tabyt-side", width + "px");
  }

  function cancelDrag() {
    if (!dragCleanup) return;
    const cleanup = dragCleanup;
    dragCleanup = null;
    cleanup();
  }

  function startDrag(event) {
    // The setting gates the interaction itself, not just the handle's looks.
    if (!settings.playerResize || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const start = sideWidth();
    const detach = () => {
      if (dragRafId) {
        cancelAnimationFrame(dragRafId);
        dragRafId = 0;
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.documentElement.classList.remove("tabyt-dragging");
      if (dragCleanup === detach) dragCleanup = null;
    };
    const move = (moveEvent) => {
      if (!settings.playerResize) return;
      if (dragRafId) cancelAnimationFrame(dragRafId);
      dragRafId = requestAnimationFrame(() => {
        setSide(start - (moveEvent.clientX - startX), false);
      });
    };
    const up = (upEvent) => {
      const persist = settings.playerResize;
      detach();
      if (persist) setSide(start - (upEvent.clientX - startX), true);
    };
    dragCleanup = detach;
    document.documentElement.classList.add("tabyt-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function ensureDivider(column) {
    if (!column || !column.parentElement) return;
    const existing = document.getElementById("tabyt-divider");
    if (!settings.playerResize) {
      // Remove the handle entirely so no pointer or keyboard interaction
      // remains active while the setting is off.
      cancelDrag();
      if (existing) existing.remove();
      return;
    }
    let handle = existing;
    if (!handle) {
      handle = document.createElement("div");
      handle.id = "tabyt-divider";
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", "Resize player and tabs");
      handle.tabIndex = 0;
      handle.addEventListener("pointerdown", startDrag);
      handle.addEventListener("keydown", (event) => {
        if (!settings.playerResize) return;
        if (event.key === "ArrowLeft") setSide(sideWidth() + 24);
        if (event.key === "ArrowRight") setSide(sideWidth() - 24);
      });
    }
    if (handle.parentElement !== column.parentElement || handle.nextElementSibling !== column) {
      column.parentElement.insertBefore(handle, column);
    }
  }

  function restoreAll() {
    cancelDrag();
    const parked = Array.from(document.querySelectorAll("[data-tabyt-parked]"));
    parked.forEach(restore);
    const rail = document.getElementById("tabyt-rail");
    if (rail) rail.remove();
    const handle = document.getElementById("tabyt-divider");
    if (handle) handle.remove();
    const ambient = document.getElementById("tabyt-ambient");
    if (ambient) ambient.remove();
    destroyGlow();
    if (mainObserver) { mainObserver.disconnect(); mainObserver = null; }
    clearFitStyles();
    lastTargetW = 0;
    lastTargetH = 0;
    panelScroll.clear();
    document.documentElement.classList.remove("tabyt-layout-on", "tabyt-dragging", "tabyt-rail-info", "tabyt-fullscreen", "tabyt-player-resize", "tabyt-player-fit", "tabyt-live-stream", "tabyt-entering", "tabyt-ambient");
    if (enterTimer) {
      clearTimeout(enterTimer);
      enterTimer = 0;
    }
    document.documentElement.style.removeProperty("--tabyt-side");
    document.documentElement.style.removeProperty("--tabyt-player-width");
    document.documentElement.style.removeProperty("--tabyt-player-height");
    clearAmbientOrigin();
    const root = watchRoot();
    if (root) {
      root.style.removeProperty("--ytd-watch-flexy-player-width");
      root.style.removeProperty("--ytd-watch-flexy-player-height");
    }
    relatedKey = "";
  }

  function slot(node, container, key) {
    if (!node || !container) return;
    const slots = container.__tabytSlots || (container.__tabytSlots = new Map());
    const previous = slots.get(key);
    if (previous && previous !== node) restore(previous);
    slots.set(key, node);
    if (container.contains(node)) return;
    park(node);
    container.appendChild(node);
  }

  function unslot(container, key) {
    if (!container || !container.__tabytSlots) return;
    const node = container.__tabytSlots.get(key);
    container.__tabytSlots.delete(key);
    if (node) restore(node);
  }

  /* Search a node's light DOM and every open shadow root below it. */
  function deepFind(root, selector) {
    if (!root) return null;
    const seen = new Set();
    const visit = (scope) => {
      if (!scope || seen.has(scope)) return null;
      seen.add(scope);
      try {
        const found = scope.querySelector(selector);
        if (found) return found;
      } catch (_error) { /* stale root */ }
      const hosts = scope.querySelectorAll("*");
      for (const host of hosts) {
        if (host.shadowRoot) {
          const nested = visit(host.shadowRoot);
          if (nested) return nested;
        }
      }
      return null;
    };
    return visit(root);
  }

  function nodeText(node) {
    return node ? (node.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  /*
   * The rail owns its own description toggle. YouTube's "...more" button is in
   * the original component's shadow root, so cloning the component gives us a
   * dead button and both the collapsed and hidden expanded blocks at once. Use
   * YouTube's already-rendered expanded text as the copy instead.
   */
  function stripDeadToggles(root) {
    const dead = [];
    const walk = (node) => {
      if (node.nodeType !== 1) return;
      const label = nodeText(node).toLowerCase();
      const isToggle = /^(…|\.\.\.)?\s*(show\s+)?(read\s+)?(more|less)\.?$/i.test(label) &&
        (/BUTTON|RENDERER/.test(node.tagName) || node.hasAttribute("role") ||
          node.getAttribute("tabindex") === "0");
      if (isToggle) {
        dead.push(node);
        return;
      }
      Array.from(node.children).forEach(walk);
    };
    walk(root);
    dead.forEach((node) => node.remove());
  }

  /*
   * YouTube keeps the full description in #expanded and only shows it after
   * "...more". Click that control once while it is still collapsed. The
   * expander itself is hidden under the player, so the click does not open
   * a second copy there.
   */
  function revealFullDescription(descNode) {
    const expand = deepFind(descNode, "#expand");
    if (!expand || expand.hidden) return;
    try { expand.click(); } catch (_error) { /* The control may already be gone. */ }
  }

  function descriptionContent(descNode) {
    if (!descNode) return null;
    /* Stay inside the description. Walking up pulls in the title and channel. */
    const expanded = deepFind(descNode, "#expanded");
    if (expanded && nodeText(expanded)) return expanded;
    const collapsed = deepFind(descNode, "#collapsed");
    if (collapsed && nodeText(collapsed)) return collapsed;
    const snippet = deepFind(descNode, "#snippet-text") || deepFind(descNode, "#snippet");
    if (snippet && nodeText(snippet)) return snippet;
    return descNode;
  }

  /*
   * YouTube renders chapter cards inside the description (a "Chapters"
   * header plus the chapter list). The expander copy above starts at the
   * text node, so append any chapter sections found inside the description
   * as well: the copy should show the same data the native page shows.
   */
  function appendChapters(content, descNode) {
    if (!descNode || typeof descNode.querySelectorAll !== "function") return;
    const sections = [];
    try {
      descNode.querySelectorAll("*").forEach((el) => {
        const text = nodeText(el);
        if (!text || !/^chapters/i.test(text) || text.length < 8) return;
        // querySelectorAll runs parents-first, so the outermost matches stick.
        if (sections.some((node) => node.contains(el))) return;
        sections.push(el);
      });
    } catch (_error) { return; }
    sections.forEach((node) => {
      const text = nodeText(node);
      if (content.textContent.indexOf(text) !== -1) return;
      const section = document.createElement("div");
      section.className = "tabyt-desc-chapters";
      section.textContent = text;
      content.appendChild(section);
    });
  }

  function addDescriptionToggle(info, body, descNode, titleText) {
    mountDomDescription(body, descNode);
    if (titleText && info) info.__infoVideoKey = info.__infoVideoKey || titleText;
  }

  function formatStamp(total) {
    const seconds = Math.max(0, Math.round(Number(total) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remain = seconds % 60;
    if (hours > 0) return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(remain).padStart(2, "0");
    return minutes + ":" + String(remain).padStart(2, "0");
  }

  function parseStamp(text) {
    const parts = String(text).split(":").map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  function appendDescriptionImages(parent, descNode) {
    if (!parent || !descNode || typeof descNode.querySelectorAll !== "function") return;
    const scope = descNode.closest ? (descNode.closest("#description") || descNode.closest("ytd-watch-metadata") || descNode) : descNode;
    const seen = new Set();
    parent.querySelectorAll("img").forEach((image) => seen.add(image.src));
    const hosts = [scope];
    if (scope.querySelector) {
      const structured = scope.querySelector("#structured-description");
      if (structured) hosts.push(structured);
    }
    hosts.forEach((host) => {
      let images = [];
      try { images = host.querySelectorAll("img"); } catch (_error) { images = []; }
      images.forEach((image) => {
        const src = image.currentSrc || image.getAttribute("src") || "";
        if (src.indexOf("https://") !== 0 || seen.has(src)) return;
        const wide = image.naturalWidth || image.width || 0;
        if (wide && wide < 64) return;
        seen.add(src);
        const copy = document.createElement("img");
        copy.className = "tabyt-desc-image";
        copy.alt = image.alt || "";
        copy.src = src;
        copy.loading = "lazy";
        parent.appendChild(copy);
      });
    });
  }

  function renderChapterRows(parent, chapters) {
    if (!chapters.length) return;
    const list = document.createElement("div");
    list.className = "tabyt-chapter-list";
    chapters.forEach((chapter) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tabyt-chapter";
      button.setAttribute("data-seconds", String(chapter.seconds));
      const imageUrl = typeof chapter.image === "string" && chapter.image.indexOf("https://") === 0
        ? chapter.image
        : "";
      if (imageUrl) {
        const image = document.createElement("img");
        image.className = "tabyt-chapter-thumb";
        image.alt = "";
        image.src = imageUrl;
        image.loading = "lazy";
        button.appendChild(image);
      }
      const copy = document.createElement("span");
      copy.className = "tabyt-chapter-copy";
      const time = document.createElement("span");
      time.className = "tabyt-chapter-time";
      time.textContent = formatStamp(chapter.seconds);
      const label = document.createElement("span");
      label.className = "tabyt-chapter-title";
      label.textContent = chapter.title;
      copy.append(time, label);
      button.appendChild(copy);
      list.appendChild(button);
    });
    parent.appendChild(list);
  }

  /*
   * Chapter rows already list these lines. A description that repeats
   * "0:00 Intro" under the list is the same data twice.
   */
  function proseWithoutChapterDump(text, chapters) {
    if (!chapters.length) return text;
    return String(text || "").split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !/^(?:\d{1,2}:)?\d{1,2}:\d{2}\b/.test(trimmed);
    }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function infoHeading(text) {
    const heading = document.createElement("h3");
    heading.className = "tabyt-info-heading";
    heading.textContent = text;
    return heading;
  }

  function infoCard(title) {
    const section = document.createElement("section");
    section.className = "tabyt-info-section tabyt-info-card";
    if (title) section.appendChild(infoHeading(title));
    return section;
  }

  function infoShell() {
    const content = document.createElement("div");
    content.className = "tabyt-desc-content";
    return content;
  }

  function descriptionScope(descNode) {
    if (!descNode || !descNode.closest) return null;
    return descNode.closest("#description, ytd-watch-metadata, ytd-watch-flexy");
  }

  function linkChip(href) {
    const link = document.createElement("a");
    link.className = "tabyt-info-link";
    link.href = href;
    link.rel = "noreferrer noopener";
    let label = href;
    try {
      const parsed = new URL(href);
      const host = parsed.hostname.replace(/^www\./i, "");
      const slug = parsed.pathname.split("/").filter(Boolean).pop() || "";
      if (/instagram/i.test(host)) label = "Instagram";
      else if (/tiktok/i.test(host)) label = "TikTok";
      else if (/discord/i.test(host)) label = "Discord";
      else if (/spotify/i.test(host)) label = "Spotify";
      else if (/twitter|x\.com/i.test(host)) label = "X";
      else if (/youtu/i.test(host)) label = "YouTube";
      else label = host;
      if (slug && slug.length <= 24) label = label + " · " + slug.replace(/^@/, "@");
    } catch (_error) { /* keep the raw href */ }
    link.textContent = label;
    return link;
  }

  const STRUCTURED_BODY_TAGS = new Set([
    "YTD-EXPANDABLE-VIDEO-DESCRIPTION-BODY-RENDERER",
    "YTD-TEXT-INLINE-EXPANDER",
    "YTD-VIDEO-DESCRIPTION-HEADER-RENDERER"
  ]);

  const STRUCTURED_SECTION_SELECTORS = [
    "ytd-macro-markers-list-renderer",
    "ytd-video-description-infocards-section-renderer",
    "ytd-video-description-transcript-section-renderer",
    "ytd-horizontal-card-list-renderer",
    "yt-video-description-youchat-section-view-model"
  ].join(",");

  function structuredSectionTitle(node) {
    if (!node) return "";
    if (isChapterStructuredNode(node)) return "Chapters";
    const tag = node.tagName || "";
    if (/YOUTUBECHAT/i.test(tag) || /youchat/i.test(tag)) return "";
    if (/people mentioned/i.test(nodeText(node))) return "People mentioned";
    if (/transcript/i.test(nodeText(node)) && tag === "YTD-VIDEO-DESCRIPTION-TRANSCRIPT-SECTION-RENDERER") {
      return "Transcript";
    }
    if (tag === "YTD-HORIZONTAL-CARD-LIST-RENDERER") {
      return isChapterStructuredNode(node) ? "Chapters" : "People mentioned";
    }
    if (tag === "YTD-VIDEO-DESCRIPTION-INFOCARDS-SECTION-RENDERER") return "Links";
    const tagged = node.querySelector("#title, .title, h2, h3");
    const text = nodeText(tagged);
    if (/^chapters$/i.test(text)) return "Chapters";
    if (/^ask$/i.test(text)) return "";
    if (text && text.length <= 32) return text;
    return "";
  }

  function explodeStructuredItem(item) {
    if (!item) return [];
    if (item.id === "items") {
      let pieces = [];
      try {
        pieces = Array.from(item.querySelectorAll(STRUCTURED_SECTION_SELECTORS));
      } catch (_error) { pieces = []; }
      if (pieces.length) return pieces;
    }
    if (item.children && item.children.length > 1) {
      let nested = [];
      try {
        nested = Array.from(item.querySelectorAll(":scope > " + STRUCTURED_SECTION_SELECTORS));
      } catch (_error) { nested = []; }
      if (nested.length > 1) return nested;
    }
    return [item];
  }

  /*
   * YouTube's horizontal chapter scroller absolutely positions each marker.
   * In the narrow rail those nodes paint over later cards unless we drop
   * them when TabYT already rendered chapters from JSON.
   */
  function isChapterStructuredNode(node) {
    if (!node || !node.tagName) return false;
    const tag = node.tagName;
    if (tag === "YTD-MACRO-MARKERS-LIST-RENDERER") return true;
    try {
      if (node.querySelector("ytd-macro-markers-list-item-renderer")) return true;
    } catch (_error) { /* ignore */ }
    const titled = node.querySelector("#title, h2, h3, .title");
    const titleText = nodeText(titled);
    if (/^chapters$/i.test(titleText)) return true;
    return false;
  }

  /*
   * YouTube's structured description holds people mentioned, link cards and
   * the transcript button. Move each block into its own card so the rail
   * does not inherit the player's cramped horizontal layout.
   */
  function mountStructuredCards(content, descNode, skipBody, skipChapters) {
    const scope = descriptionScope(descNode);
    if (!scope || !content) return;
    const structured = scope.querySelector("ytd-structured-description-content-renderer, #structured-description");
    if (!structured) return;
    revealFullDescription(descNode);
    // Moving live nodes keeps shadow roots (avatars, link icons, transcript controls).
    const kids = Array.from(structured.children);
    kids.forEach((item) => {
      if (skipBody && STRUCTURED_BODY_TAGS.has(item.tagName)) {
        item.remove();
        return;
      }
      explodeStructuredItem(item).forEach((piece) => {
        if (skipChapters && isChapterStructuredNode(piece)) {
          piece.remove();
          return;
        }
        const title = structuredSectionTitle(piece);
        if (!title && /youchat/i.test(piece.tagName || "")) {
          piece.remove();
          return;
        }
        if (!nodeText(piece)) {
          piece.remove();
          return;
        }
        const section = infoCard(title);
        section.classList.add("tabyt-info-structured-card");
        const wrap = document.createElement("div");
        wrap.className = "tabyt-info-structured";
        wrap.appendChild(piece);
        section.appendChild(wrap);
        content.appendChild(section);
      });
      if (item.id === "items" && !item.children.length) item.remove();
    });
  }

  function proseFromExpander(descNode) {
    if (!descNode) return "";
    revealFullDescription(descNode);
    const expander = (descNode.matches && descNode.matches("ytd-text-inline-expander"))
      ? descNode
      : (deepFind(descNode, "ytd-text-inline-expander") || descriptionContent(descNode));
    if (!expander) return nodeText(descNode);
    const expanded = deepFind(expander, "#expanded");
    return nodeText(expanded) || nodeText(expander);
  }

  function appendRichText(parent, text) {
    const block = document.createElement("div");
    block.className = "tabyt-desc-text";
    const pattern = /https?:\/\/[^\s<>"]+|(?:\d{1,2}:)?\d{1,2}:\d{2}/g;
    let last = 0;
    let linkRow = null;
    let match = pattern.exec(text);
    while (match) {
      if (match.index > last) {
        block.appendChild(document.createTextNode(text.slice(last, match.index)));
        linkRow = null;
      }
      const token = match[0];
      if (token.charAt(0) === "h") {
        const href = token.replace(/[),.;]+$/, "");
        if (!linkRow) {
          linkRow = document.createElement("div");
          linkRow.className = "tabyt-info-link-row";
          block.appendChild(linkRow);
        }
        linkRow.appendChild(linkChip(href));
        if (href.length < token.length) block.appendChild(document.createTextNode(token.slice(href.length)));
      } else {
        linkRow = null;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tabyt-timestamp";
        button.textContent = token;
        button.setAttribute("data-seconds", String(parseStamp(token)));
        block.appendChild(button);
      }
      last = match.index + token.length;
      match = pattern.exec(text);
    }
    if (last < text.length) block.appendChild(document.createTextNode(text.slice(last)));
    parent.appendChild(block);
  }

  function renderJsonDescription(body, text, chapters, descNode) {
    const content = infoShell();
    if (chapters.length) {
      const section = infoCard("Chapters");
      renderChapterRows(section, chapters);
      content.appendChild(section);
    }
    const prose = proseWithoutChapterDump(text, chapters);
    if (prose) {
      const section = infoCard("Description");
      appendRichText(section, prose);
      content.appendChild(section);
    }
    mountStructuredCards(content, descNode, Boolean(prose), chapters.length > 0);
    body.append(content);
    body.classList.add("tabyt-desc-expanded");
  }

  function mountDomDescription(body, descNode) {
    const content = infoShell();
    const prose = proseFromExpander(descNode);
    if (prose) {
      const section = infoCard("Description");
      appendRichText(section, prose);
      content.appendChild(section);
    }
    mountStructuredCards(content, descNode, true);
    body.append(content);
    body.classList.add("tabyt-desc-expanded");
  }

  function readSkips() {
    const raw = document.documentElement && document.documentElement.getAttribute("data-tabyt-skips");
    if (!raw) return { videoId: "", segments: [] };
    try {
      const parsed = JSON.parse(raw);
      const segments = [];
      (Array.isArray(parsed.segments) ? parsed.segments : []).forEach((segment) => {
        const start = Number(segment && segment.start);
        const end = Number(segment && segment.end);
        const label = segment && typeof segment.label === "string" ? segment.label.slice(0, 80) : "";
        const category = segment && typeof segment.category === "string" ? segment.category.slice(0, 40) : "sponsor";
        const note = segment && typeof segment.note === "string" ? segment.note.slice(0, 180) : "";
        if (!label || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        segments.push({ category, label, start, end, note });
      });
      return {
        videoId: parsed && typeof parsed.videoId === "string" ? parsed.videoId : "",
        segments
      };
    } catch (_error) {
      return { videoId: "", segments: [] };
    }
  }

  function skipsForCurrentVideo() {
    const data = readSkips();
    const id = videoId();
    if (!settings.layoutSkips || (data.videoId && id && data.videoId !== id)) {
      return { videoId: "", segments: [] };
    }
    return data;
  }

  function renderSkips(info) {
    if (!info) return;
    const existing = info.querySelector(":scope > .tabyt-skips");
    const data = skipsForCurrentVideo();
    if (!data.segments.length) {
      if (existing) existing.remove();
      return;
    }
    const key = data.segments.map((segment) => segment.category + segment.start + segment.end).join("|");
    if (existing && existing.getAttribute("data-key") === key) return;
    if (existing) existing.remove();

    const block = document.createElement("section");
    block.className = "tabyt-skips tabyt-info-card";
    block.setAttribute("data-key", key);
    const heading = document.createElement("p");
    heading.className = "tabyt-skips-title";
    heading.textContent = "Skipped by ";
    const credit = document.createElement("a");
    credit.href = "https://sponsor.ajay.app";
    credit.textContent = "SponsorBlock";
    credit.rel = "noreferrer noopener";
    heading.appendChild(credit);
    block.appendChild(heading);

    data.segments.forEach((segment) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tabyt-skip";
      button.setAttribute("data-category", segment.category);
      button.setAttribute("data-seconds", String(segment.start));
      const time = document.createElement("span");
      time.textContent = formatStamp(segment.start) + " – " + formatStamp(segment.end);
      const label = document.createElement("span");
      label.textContent = segment.note ? segment.label + " · " + segment.note : segment.label;
      button.append(time, label);
      block.appendChild(button);
    });
    info.insertBefore(block, info.firstChild);
  }

  function paintSkipMarks() {
    const data = skipsForCurrentVideo();
    const video = document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");
    const fromVideo = video && Number.isFinite(video.duration) ? video.duration : 0;
    const fromSegments = data.segments.reduce((max, segment) => Math.max(max, segment.end), 0);
    const duration = fromVideo || fromSegments;
    document.querySelectorAll(".tabyt-pc-progress, #movie_player .ytp-progress-bar").forEach((bar) => {
      let layer = bar.querySelector(":scope > .tabyt-skip-marks");
      if (!data.segments.length || duration <= 0) {
        if (layer) layer.remove();
        return;
      }
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "tabyt-skip-marks";
        bar.appendChild(layer);
      }
      const key = data.segments.map((segment) => segment.start + ":" + segment.end).join("|") + "@" + Math.round(duration);
      if (layer.getAttribute("data-key") === key) return;
      layer.setAttribute("data-key", key);
      layer.textContent = "";
      data.segments.forEach((segment) => {
        const mark = document.createElement("span");
        mark.className = "tabyt-skip-mark";
        mark.setAttribute("data-category", segment.category);
        mark.style.left = Math.min(100, (segment.start / duration) * 100) + "%";
        mark.style.width = Math.max(0.4, ((segment.end - segment.start) / duration) * 100) + "%";
        layer.appendChild(mark);
      });
    });
  }

  function seekVideo(seconds) {
    const time = Number(seconds);
    if (!Number.isFinite(time) || time < 0) return;
    const video = document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video");
    if (!video) return;
    try { video.currentTime = time; } catch (_error) { /* The media element may not be ready. */ }
  }

  /*
   * The Info tab is only the description. Title, views and likes stay in
   * YouTube's own block under the player. The full text comes from the page
   * JSON when the MAIN-world reader has published it. The DOM copy remains
   * for the moment before that JSON exists.
   */
  function renderInfoCopy(info, titleNode, descNode) {
    if (!info) return;
    const titleText = nodeText(titleNode);
    const meta = metaForCurrentVideo();
    const fromJson = meta.description;
    if (!fromJson) revealFullDescription(descNode);
    const expandedText = fromJson || nodeText(descNode && deepFind(descNode, "#expanded"));
    const descText = expandedText || nodeText(descNode);
    const chapterKey = meta.chapters.map((chapter) => chapter.seconds).join(",");
    const key = (meta.videoId || titleText) + "::" + descText.length + ":" + descText.slice(0, 160) + "::" + chapterKey;
    if (info.__infoKey === key && info.querySelector(".tabyt-info-desc, .tabyt-empty")) return;

    // A new video starts with the description expanded.
    if (info.__infoVideoKey !== titleText) {
      info.__infoVideoKey = titleText;
      info.__descExpanded = true;
    }
    info.__infoKey = key;
    info.textContent = "";

    const descBody = document.createElement("div");
    descBody.className = "tabyt-info-desc";
    if (fromJson || meta.chapters.length) {
      renderJsonDescription(descBody, fromJson || "", meta.chapters, descNode);
    } else if (descNode) {
      mountDomDescription(descBody, descNode);
    }
    if (!descBody.querySelector(".tabyt-info-structured")) {
      appendDescriptionImages(descBody, descNode);
    }
    if (titleText && info) info.__infoVideoKey = info.__infoVideoKey || titleText;
    info.appendChild(descBody);
    if (!nodeText(descBody)) {
      const note = document.createElement("p");
      note.className = "tabyt-empty";
      note.textContent = "The full description appears here when YouTube finishes loading this video.";
      descBody.appendChild(note);
    }
  }

  function makeTab(name, label, selected) {
    const button = document.createElement("button");
    button.className = "tabyt-tab";
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("data-tab", name);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.textContent = label;
    return button;
  }

  function makePanel(name, active) {
    const panel = document.createElement("div");
    panel.className = active ? "tabyt-panel is-active" : "tabyt-panel";
    panel.setAttribute("data-panel", name);
    return panel;
  }

  function buildRail() {
    const rail = document.createElement("section");
    rail.id = "tabyt-rail";
    rail.setAttribute("aria-label", "Video details");

    const tabbar = document.createElement("div");
    tabbar.className = "tabyt-tabbar";
    tabbar.setAttribute("role", "tablist");
    tabbar.setAttribute("aria-label", "Video details");
    tabbar.appendChild(makeTab("info", "Info", true));
    tabbar.appendChild(makeTab("comments", "Comments", false));
    tabbar.appendChild(makeTab("live", "Live", false));
    tabbar.appendChild(makeTab("other", "Other", false));
    const indicator = document.createElement("span");
    indicator.className = "tabyt-tab-indicator";
    indicator.setAttribute("aria-hidden", "true");
    tabbar.appendChild(indicator);
    tabbar.appendChild(makeTab("related", "Related", false));

    const panels = document.createElement("div");
    panels.className = "tabyt-panels";
    panels.appendChild(makePanel("info", true));
    panels.appendChild(makePanel("comments", false));
    panels.appendChild(makePanel("live", false));
    panels.appendChild(makePanel("other", false));
    panels.appendChild(makePanel("related", false));

    rail.appendChild(tabbar);
    rail.appendChild(panels);
    rail.addEventListener("click", (event) => {
      const chapter = event.target.closest("[data-seconds]");
      if (chapter && rail.contains(chapter)) {
        event.preventDefault();
        seekVideo(chapter.getAttribute("data-seconds"));
        return;
      }
      const related = event.target.closest(".tabyt-related-item");
      if (related) {
        event.preventDefault();
        openRelated(related);
        return;
      }
      const button = event.target.closest(".tabyt-tab");
      if (!button || button.hidden) return;
      showTab(button.getAttribute("data-tab"));
    });
    tabbar.addEventListener("keydown", onTabKey);
    return rail;
  }

  function ensureRail(host) {
    let rail = document.getElementById("tabyt-rail");
    if (!rail) rail = buildRail();
    if (rail.parentElement !== host) host.insertBefore(rail, host.firstChild);
    return rail;
  }

  function activePanel(rail) {
    return rail ? rail.querySelector(".tabyt-panel.is-active") : null;
  }

  function showTab(name, focus) {
    const rail = document.getElementById("tabyt-rail");
    if (!rail) return;
    const buttons = Array.from(rail.querySelectorAll(".tabyt-tab"));
    const visible = buttons.filter((button) => !button.hidden);
    const match = visible.find((button) => button.getAttribute("data-tab") === name) || visible[0];
    if (!match) return;

    const before = activePanel(rail);
    if (before) panelScroll.set(before.getAttribute("data-panel"), panelScrollTop(before));

    activeTab = match.getAttribute("data-tab");
    buttons.forEach((button) => {
      const on = button === match;
      button.setAttribute("aria-selected", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
    });
    rail.querySelectorAll(".tabyt-panel").forEach((panel) => {
      const on = panel.getAttribute("data-panel") === activeTab;
      panel.classList.toggle("is-active", on);
      if (on) panel.removeAttribute("aria-hidden");
      else panel.setAttribute("aria-hidden", "true");
    });

    const after = rail.querySelector('.tabyt-panel[data-panel="' + activeTab + '"]');
    if (after) setPanelScrollTop(after, panelScroll.get(activeTab) || 0);
    placeTabIndicator(rail, match);
    if (focus) match.focus();
  }

  function placeTabIndicator(rail, button) {
    const bar = rail.querySelector(".tabyt-tabbar");
    const indicator = bar && bar.querySelector(".tabyt-tab-indicator");
    if (!bar || !indicator || !button) return;
    const barRect = bar.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const inset = Math.min(28, Math.max(14, Math.round(rect.width * 0.22)));
    const width = Math.max(20, rect.width - inset * 2);
    indicator.style.width = width + "px";
    indicator.style.transform = "translateX(" + Math.round(rect.left - barRect.left + inset) + "px)";
  }

  function onTabKey(event) {
    const rail = document.getElementById("tabyt-rail");
    if (!rail) return;
    const buttons = Array.from(rail.querySelectorAll(".tabyt-tab")).filter((button) => !button.hidden);
    if (!buttons.length) return;
    const index = buttons.findIndex((button) => button.getAttribute("data-tab") === activeTab);
    const last = buttons.length - 1;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % buttons.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index < 0 ? last : (index - 1 + buttons.length) % buttons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    showTab(buttons[next].getAttribute("data-tab"), true);
  }

  function resetScroll() {
    panelScroll.clear();
    const root = watchRoot();
    const primary = root && root.querySelector("#primary");
    if (primary) primary.scrollTop = 0;
    document.querySelectorAll(".tabyt-panel").forEach((panel) => {
      setPanelScrollTop(panel, 0);
    });
  }

  function setTabVisible(rail, name, visible) {
    const button = rail.querySelector('.tabyt-tab[data-tab="' + name + '"]');
    if (button) button.hidden = !visible;
  }

  function emptyNote(container, text) {
    let note = container.querySelector(":scope > .tabyt-empty");
    if (!text) {
      if (note) note.remove();
      return;
    }
    if (!note) {
      note = document.createElement("p");
      note.className = "tabyt-empty";
      container.appendChild(note);
    }
    note.textContent = text;
  }

  function relatedItems(currentId) {
    const source = firstMatch([
      "#related",
      "ytd-watch-next-secondary-results-renderer",
      "#secondary"
    ]);
    if (!source) return [];
    const seen = new Set();
    const items = [];
    const anchors = source.querySelectorAll('a[href*="watch?v="], a[href*="/shorts/"]');
    anchors.forEach((anchor) => {
      let id = "";
      let href = "";
      try {
        const url = new URL(anchor.href, location.origin);
        if (url.pathname.indexOf("/shorts/") === 0) {
          id = url.pathname.split("/")[2] || "";
          href = url.origin + url.pathname;
        } else {
          id = url.searchParams.get("v") || "";
          href = url.origin + "/watch?v=" + encodeURIComponent(id);
        }
      } catch (_error) {
        return;
      }
      if (!id || id === currentId || seen.has(id)) return;
      const card = anchor.closest("ytd-compact-video-renderer, ytd-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model") || anchor;
      const titleNode = card.querySelector("#video-title, h3, .yt-lockup-metadata-view-model__title");
      const label = (anchor.getAttribute("title") || anchor.getAttribute("aria-label") || (titleNode && titleNode.textContent) || "").replace(/\s+/g, " ").trim();
      const title = label.split(" by ")[0].trim();
      if (title.length < 2) return;
      const channelNode = card.querySelector("#channel-name, ytd-channel-name, .yt-content-metadata-view-model__metadata-text");
      const channel = channelNode ? channelNode.textContent.replace(/\s+/g, " ").trim().slice(0, 80) : "";
      seen.add(id);
      items.push({
        id,
        href,
        title: title.slice(0, 140),
        channel,
        thumb: "https://i.ytimg.com/vi/" + encodeURIComponent(id) + "/mqdefault.jpg"
      });
    });
    return items.slice(0, 20);
  }

  /*
   * Our related cards are injected anchors, so a plain click would reload the
   * page. Find the matching anchor YouTube rendered and click that one: its
   * router keeps window and player state, which is what makes this feel like
   * an SPA. Only fall back to a normal navigation when no native anchor exists.
   */
  function nativeRelatedAnchor(id, href) {
    if (!id) return null;
    const shorts = href.indexOf("/shorts/") !== -1;
    const needle = shorts ? "/shorts/" + id : "v=" + id;
    const scopes = ["#related", "ytd-watch-next-secondary-results-renderer", "ytd-watch-flexy", "ytd-app"];
    for (let i = 0; i < scopes.length; i += 1) {
      const scope = document.querySelector(scopes[i]);
      if (!scope) continue;
      const anchors = scope.querySelectorAll('a[href*="' + needle + '"]');
      for (let j = 0; j < anchors.length; j += 1) {
        const anchor = anchors[j];
        if (!anchor.isConnected || anchor.closest(".tabyt-related-list")) continue;
        try {
          const url = new URL(anchor.href, location.origin);
          if (shorts) {
            if (url.pathname.indexOf("/shorts/" + id) !== 0) continue;
          } else if ((url.searchParams.get("v") || "") !== id) {
            continue;
          }
        } catch (_error) {
          continue;
        }
        return anchor;
      }
    }
    return null;
  }

  function openRelated(link) {
    const href = link.getAttribute("href") || "";
    const id = link.getAttribute("data-video-id") || "";
    const anchor = nativeRelatedAnchor(id, href);
    if (anchor) {
      anchor.click();
      return;
    }
    if (href) location.assign(href);
  }

  function renderRelated(container, currentId) {
    const items = relatedItems(currentId);
    const key = items.map((item) => item.id).join(",");
    if (key === relatedKey && container.querySelector(".tabyt-related-list")) return;
    relatedKey = key;
    const list = document.createElement("div");
    list.className = "tabyt-related-list";
    if (!items.length) {
      const note = document.createElement("p");
      note.className = "tabyt-empty";
      note.textContent = "Related videos show up here once YouTube loads suggestions for this video.";
      list.appendChild(note);
    }
    items.forEach((item) => {
      const link = document.createElement("a");
      link.className = "tabyt-related-item";
      link.href = item.href;
      link.setAttribute("data-video-id", item.id);
      const image = document.createElement("img");
      image.className = "tabyt-related-thumb";
      image.alt = "";
      image.src = item.thumb;
      const copy = document.createElement("span");
      copy.className = "tabyt-related-copy";
      const title = document.createElement("strong");
      title.textContent = item.title;
      copy.appendChild(title);
      if (item.channel) {
        const channel = document.createElement("span");
        channel.textContent = item.channel;
        copy.appendChild(channel);
      }
      link.appendChild(image);
      link.appendChild(copy);
      list.appendChild(link);
    });
    const previous = container.querySelector(":scope > .tabyt-related-list");
    if (previous) previous.replaceWith(list);
    else container.appendChild(list);
  }

  /*
   * YouTube pins the count inside a short header, so it paints over the first
   * comment. Split the tab into a fixed compose zone (count, sort, composer)
   * and a feed zone (everyone else's threads) that alone scrolls. Ambient mode
   * background-free so the glow shows through; non-ambient may still paint an
   * opaque compose fill in CSS to avoid scroll smear.
   */
  function dedupeCommentDock(dock) {
    if (!dock) return;
    ["#title", "#simple-box"].forEach((selector) => {
      const nodes = dock.querySelectorAll(":scope > " + selector);
      for (let i = nodes.length - 1; i > 0; i -= 1) nodes[i].remove();
    });
    const title = dock.querySelector(":scope > #title");
    const box = dock.querySelector(":scope > #simple-box");
    if (title && box && title.nextElementSibling !== box) dock.insertBefore(title, box);
  }

  let commentFeedScrolling = false;
  let commentFeedScrollTimer = 0;

  function commentFeedZone(panel) {
    if (!panel) return null;
    return panel.querySelector(":scope > .tabyt-comment-feed-zone");
  }

  function panelScrollTop(panel) {
    if (!panel) return 0;
    const feed = commentFeedZone(panel);
    return feed ? feed.scrollTop : panel.scrollTop;
  }

  function setPanelScrollTop(panel, value) {
    if (!panel) return;
    const feed = commentFeedZone(panel);
    if (feed) feed.scrollTop = value;
    else panel.scrollTop = value;
  }

  function ensureCommentFeedScrollWatch() {
    const feed = document.querySelector("#tabyt-rail .tabyt-comment-feed-zone");
    if (!feed || feed.dataset.tabytScrollWatch === "1") return;
    feed.dataset.tabytScrollWatch = "1";
    feed.addEventListener(
      "scroll",
      () => {
        commentFeedScrolling = true;
        clearTimeout(commentFeedScrollTimer);
        commentFeedScrollTimer = setTimeout(() => {
          commentFeedScrolling = false;
        }, 200);
      },
      { passive: true }
    );
  }

  function commentDockNode(panel) {
    return (
      panel.querySelector(":scope > .tabyt-comment-compose-zone > .tabyt-comment-dock") ||
      panel.querySelector(":scope > .tabyt-comment-dock")
    );
  }

  function mountCommentFeedZone(panel, root) {
    if (!panel || !root) return;
    let feed = panel.querySelector(":scope > .tabyt-comment-feed-zone");
    if (!feed) {
      feed = document.createElement("div");
      feed.className = "tabyt-comment-feed-zone";
      panel.appendChild(feed);
    }
    if (root.parentElement !== feed) feed.appendChild(root);
    if (feed.previousElementSibling !== panel.querySelector(":scope > .tabyt-comment-compose-zone")) {
      const compose = panel.querySelector(":scope > .tabyt-comment-compose-zone");
      if (compose) panel.insertBefore(compose, feed);
    }
  }

  function mountCommentDock(panel) {
    if (!panel) return;
    const root =
      panel.querySelector(":scope > .tabyt-comment-feed-zone > ytd-comments#comments") ||
      panel.querySelector("ytd-comments#comments");
    const header = root && root.querySelector("ytd-comments-header-renderer");
    if (!header) return;
    const box = header.querySelector(":scope > #simple-box");
    const title = header.querySelector(":scope > #title");
    panel.classList.add("tabyt-comments-panel");
    let compose = panel.querySelector(":scope > .tabyt-comment-compose-zone");
    if (!compose) {
      compose = document.createElement("div");
      compose.className = "tabyt-comment-compose-zone";
      panel.insertBefore(compose, panel.firstChild);
    }
    let dock = compose.querySelector(":scope > .tabyt-comment-dock");
    if (!dock) {
      dock = document.createElement("div");
      dock.className = "tabyt-comment-dock";
      compose.appendChild(dock);
    }
    if (compose.parentElement !== panel || compose !== panel.firstElementChild) {
      panel.insertBefore(compose, panel.firstChild);
    }
    if (title && title.parentElement !== dock) dock.appendChild(title);
    if (box && box.parentElement !== dock) dock.appendChild(box);
    dedupeCommentDock(dock);
    if (!dock.querySelector(":scope > #title") && !dock.querySelector(":scope > #simple-box")) return;
    mountCommentFeedZone(panel, root);
    ensureCommentFeedScrollWatch();
  }

  function restoreCommentDock(panel) {
    if (!panel) return;
    panel.classList.remove("tabyt-comments-panel");
    const feed = panel.querySelector(":scope > .tabyt-comment-feed-zone");
    const root =
      (feed && feed.querySelector("ytd-comments#comments")) ||
      panel.querySelector("ytd-comments#comments");
    if (feed && root && root.parentElement === feed) panel.appendChild(root);
    const dock = commentDockNode(panel);
    if (!dock) {
      feed?.remove();
      panel.querySelector(":scope > .tabyt-comment-compose-zone")?.remove();
      return;
    }
    const header = root && root.querySelector("ytd-comments-header-renderer");
    if (header) {
      const title = dock.querySelector(":scope > #title");
      const box = dock.querySelector(":scope > #simple-box");
      if (title) header.insertBefore(title, header.firstChild);
      if (box) header.appendChild(box);
    }
    dock.remove();
    panel.querySelector(":scope > .tabyt-comment-compose-zone")?.remove();
    feed?.remove();
  }

  function applyTabs(rail) {
    const currentId = videoId();
    const info = rail.querySelector('[data-panel="info"]');
    const comments = rail.querySelector('[data-panel="comments"]');
    const live = rail.querySelector('[data-panel="live"]');
    const other = rail.querySelector('[data-panel="other"]');
    const related = rail.querySelector('[data-panel="related"]');

    const title = firstMatch([
      "ytd-watch-metadata #title",
      "#above-the-fold #title",
      "h1.ytd-watch-metadata"
    ]);
    const description = firstMatch([
      "ytd-watch-metadata #description-inline-expander",
      "ytd-watch-metadata #description",
      "#description-inline-expander"
    ]);
    const commentNode = firstMatch(["ytd-comments#comments", "ytd-comments"]);
    const otherNode = firstMatch(["#related", "ytd-watch-next-secondary-results-renderer"]);
    const chatNode = firstMatch([
      "ytd-live-chat-frame#chat",
      "#chat-container ytd-live-chat-frame",
      "ytd-live-chat-frame"
    ]);

    /*
     * Comments and live chat share one tab. The setting chooses which list
     * is shown. The old Live tab stays in the bar hidden.
     */
    const discussion = settings.layoutDiscussion === "live" ? "live" : "comments";
    const showDiscussion = !!settings.layoutComments;
    document.documentElement.classList.toggle("tabyt-live-stream", isLiveVideo());

    setTabVisible(rail, "info", settings.layoutInfo);
    setTabVisible(rail, "comments", showDiscussion);
    setTabVisible(rail, "live", false);
    setTabVisible(rail, "other", settings.layoutOther);
    setTabVisible(rail, "related", settings.layoutRelated);
    const discussionTab = rail.querySelector('[data-tab="comments"]');
    if (discussionTab) discussionTab.textContent = discussion === "live" ? "Live" : "Comments";
    if (comments) comments.classList.toggle("tabyt-discussion-live", showDiscussion && discussion === "live");

    /*
     * Leave the title, channel, views and likes in #primary, under the player.
     * Copy only the description into the Info tab. Moving the live nodes made
     * them jump back into #primary whenever YouTube re-rendered.
     */
    document.documentElement.classList.toggle("tabyt-rail-info", !!settings.layoutInfo);
    if (settings.layoutInfo) {
      unslot(info, "title");
      unslot(info, "description");
      renderInfoCopy(info, title, description);
      renderSkips(info);
    } else {
      info.__infoKey = "";
      info.textContent = "";
    }
    paintSkipMarks();

    unslot(live, "chat");
    if (showDiscussion && discussion === "live") {
      restoreCommentDock(comments);
      unslot(comments, "comments");
      if (chatNode) {
        slot(chatNode, comments, "chat");
        emptyNote(comments, "");
      } else {
        unslot(comments, "chat");
        emptyNote(comments, "Live chat appears here when YouTube loads it.");
      }
    } else if (showDiscussion) {
      unslot(comments, "chat");
      if (commentNode) {
        slot(commentNode, comments, "comments");
        mountCommentDock(comments);
        if (window.TabYTAuthors) window.TabYTAuthors.scan(comments);
        emptyNote(comments, "");
      } else {
        restoreCommentDock(comments);
        unslot(comments, "comments");
        emptyNote(comments, "Comments appear here when this video has them.");
      }
    } else {
      restoreCommentDock(comments);
      unslot(comments, "comments");
      unslot(comments, "chat");
    }

    if (settings.layoutOther) {
      slot(otherNode, other, "other");
      emptyNote(other, otherNode ? "" : "Other videos appear here when YouTube loads the sidebar.");
    } else {
      unslot(other, "other");
    }

    if (settings.layoutRelated) renderRelated(related, currentId);
    else {
      const list = related.querySelector(":scope > .tabyt-related-list");
      if (list) list.remove();
      relatedKey = "";
    }

    showTab(activeTab);
  }

  function mutationMatters(records) {
    for (let i = 0; i < records.length; i += 1) {
      const target = records[i].target;
      const el = target && target.nodeType === 1 ? target : target && target.parentElement;
      if (!el || typeof el.closest !== "function") return true;
      if (el.closest("#player, #movie_player")) continue;
      if (el.closest("#tabyt-rail") && !el.closest("#related, ytd-watch-next-secondary-results-renderer")) continue;
      return true;
    }
    return false;
  }

  function sync() {
    if (quiet) return;
    quiet = true;
    try {
      pageMeta = readPageMeta();
      if (!settings.layoutEnabled || !onWatchPage() || !watchRoot()) {
        restoreAll();
        /*
         * Leave `booted` unset here: nothing was applied yet, and the first
         * real sync should still run near-immediately when the watch root
         * appears. Setting it here used to add a 180 ms delay on fresh loads.
         */
        return;
      }
      const root = watchRoot();
      const host = secondary();
      const column = root.querySelector("#secondary");
      const columns = root.querySelector("#columns");
      if (!host || !column || !columns) return;
      const isFull = isFullscreen();
      document.documentElement.classList.toggle("tabyt-fullscreen", isFull);
      if (isFull) {
        fitPlayer();
        return;
      }
      const masthead = document.querySelector("#masthead");
      const mastheadHeight = masthead ? Math.round(masthead.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty("--tabyt-masthead", (mastheadHeight || 56) + "px");
      document.documentElement.classList.add("tabyt-layout-on");
      applyGlassTier();
      ensureDivider(column);
      applyTabs(ensureRail(host));
      /*
       * One short entry shift per page load. Restarting it on every sync kept
       * the class on forever, because YouTube never stops mutating the page.
       */
      if (!booted) {
        document.documentElement.classList.add("tabyt-entering");
        clearTimeout(enterTimer);
        enterTimer = setTimeout(() => {
          document.documentElement.classList.remove("tabyt-entering");
        }, 400);
      }
      if (document.getElementById("tabyt-rail")) booted = true;
      ensureAmbient();
      syncGlow();
      observePrimary();
      fitPlayer();
    } finally {
      quiet = false;
      if (pendingSync) {
        pendingSync = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (quiet) {
      pendingSync = true;
      return;
    }
    clearTimeout(timer);
    // Run near-immediately during boot and for a short window after any
    // YouTube navigation, so the native watch page never renders first. Once
    // booted, add a tiny delay so bursts of mutations from a busy watch page
    // coalesce into one sync instead of queueing a chain of syncs.
    timer = setTimeout(sync, (booted && Date.now() > fastUntil) ? 150 : 0);
  }

  function start() {
    const observer = new MutationObserver((records) => {
      if (!mutationMatters(records)) return;
      schedule();
    });
    /*
     * Child changes still discover comments and related videos as YouTube
     * inserts them. Player, chat and comment mutations are ignored. Fit uses
     * the ResizeObserver on #primary and #below, not this observer.
     * data-tabyt-meta is the only attribute that schedules a sync.
     */
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-tabyt-meta", "data-tabyt-skips"]
    });
    document.addEventListener("yt-navigate-start", () => {
      fastUntil = Date.now() + 3000;
      pageMeta = emptyMeta();
    });
    document.addEventListener("yt-navigate-finish", () => {
      activeTab = preferredTab();
      fastUntil = Date.now() + 3000;
      relatedKey = "";
      lastTargetW = 0;
      lastTargetH = 0;
      pruneFitStyles();
      resetScroll();
      schedule();
    });
    window.addEventListener("popstate", schedule);
    window.addEventListener("resize", schedule);

    /* Re-inject the ambient canvas if YouTube replaces the player on reload. */
    injectionTimer = setInterval(() => {
      reinjectAmbient();
      paintSkipMarks();
      const panel = document.querySelector('#tabyt-rail [data-panel="comments"]');
      if (panel && !panel.classList.contains("tabyt-discussion-live")) {
        if (!commentFeedScrolling) {
          mountCommentDock(panel);
          if (window.TabYTAuthors) window.TabYTAuthors.scan(panel);
        }
      }
    }, 1000);
    if (window.TabYTPlayer && window.TabYTPlayer.on) {
      window.TabYTPlayer.on("ready", reinjectAmbient);
    }
    /*
     * Fullscreen is left entirely to YouTube and the browser. fitPlayer() skips
     * all sizing while fullscreen is active, so the browser's own sizing wins.
     */
    const onFullscreen = () => {
      document.documentElement.classList.toggle("tabyt-fullscreen", isFullscreen());
      fitPlayer();
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("webkitfullscreenchange", onFullscreen);
    if (api && api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[SETTINGS_KEY]) return;
        settings = readStored(changes[SETTINGS_KEY].newValue);
        relatedKey = "";
        saveEarly();
        if (core && core.applyEarlyClasses) core.applyEarlyClasses(settings);
        sync();
      });
    }
    applySavedSide();
    applyEarlyClassesSafe();
    // Build the rail from the cached snapshot before storage responds.
    sync();
    loadSettings().then((next) => {
      settings = next;
      saveEarly();
      if (core && core.applyEarlyClasses) core.applyEarlyClasses(settings);
      sync();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
