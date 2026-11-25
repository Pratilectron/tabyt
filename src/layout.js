/*
 * TabYT watch layout.
 *
 * Runs on every YouTube page the extension matches. Title, description,
 * comments, sidebar videos, and live chat sit in tabs beside the player.
 * Live streams get a Live tab for chat, and the Comments tab is hidden for them.
 * The watch page is a fixed shell: the left column and the right rail scroll
 * independently, the document itself does not scroll. A divider resizes the
 * rail. Related links delegate to YouTube's own anchors so navigation stays
 * an SPA instead of reloading the page.
 * Ambient color behind the player comes from video-ambient-glow.
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
    layoutAmbient: true,
    // Player resizing is opt-in; off by default so the YouTube player keeps its
    // native dimensions until the user enables it in Settings.
    playerResize: false,
    // TabYT's own control bar replaces YouTube's native chrome by default.
    customControls: true
  };

  const SIDE_KEY = "tabyt-side";
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
    if (earlyRetryTimer) {
      clearTimeout(earlyRetryTimer);
      earlyRetryTimer = 0;
    }
    if (earlyObserver) {
      earlyObserver.disconnect();
      earlyObserver = null;
    }
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
  let playerAttrObserver = null;

  function readStored(raw) {
    const next = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== "object") return next;
    Object.keys(DEFAULTS).forEach((key) => {
      if (typeof raw[key] === "boolean") next[key] = raw[key];
    });
    return next;
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
      if (new URL(location.href).pathname.indexOf("/live/") === 0) return true;
    } catch (_error) {
      /* fall through to the DOM checks */
    }
    const root = watchRoot();
    if (root) {
      if (root.hasAttribute("is-live") || root.hasAttribute("live")) return true;
      if ((root.getAttribute("live-status") || "").toLowerCase() === "live") return true;
      if ((root.getAttribute("player-type") || "").toLowerCase() === "live") return true;
    }
    const badge = document.querySelector(".ytp-live-badge");
    if (badge && !badge.hidden) {
      try {
        if (getComputedStyle(badge).display !== "none") return true;
      } catch (_error) {
        return true;
      }
    }
    return false;
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

  function glowCtor() {
    const lib = window.VideoAmbientGlow;
    return lib && typeof lib.AmbientGlow === "function" ? lib.AmbientGlow : null;
  }

  function playerInner() {
    const root = watchRoot();
    return root && root.querySelector("#primary-inner");
  }

  function ensureAmbient() {
    const root = watchRoot();
    const player = root && root.querySelector("#player");
    if (!player) return null;
    let host = document.getElementById("tabyt-ambient");
    if (!host) {
      host = document.createElement("div");
      host.id = "tabyt-ambient";
      host.setAttribute("aria-hidden", "true");
    }
    if (host.parentElement !== player) player.insertBefore(host, player.firstChild);
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
      const stale = document.getElementById("tabyt-ambient");
      if (stale) stale.remove();
      return;
    }
    const Ctor = glowCtor();
    const video = document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video");
    if (!Ctor || !video || !video.isConnected || !video.parentElement) return;
    if (!glow || glowVideo !== video) {
      destroyGlow();
      try {
        glow = new Ctor(video, {
          blur: 72,
          opacity: 0.95,
          brightness: 1.15,
          saturate: 1.6,
          scale: 1.35,
          responsiveness: 0.28
        });
        glowVideo = video;
      } catch (_error) {
        glow = null;
        glowVideo = null;
        return;
      }
    }
    placeGlowCanvas();
  }

  /*
   * The ambient canvas is injected into #player. A direct video reload can
   * replace either the <video> or the player container, leaving the canvas in a
   * detached node. Check health rather than trusting a one-time init.
   */
  function ambientHealthy() {
    if (!settings.layoutEnabled || !settings.layoutAmbient) return true;
    const root = watchRoot();
    const player = root && root.querySelector("#player");
    const host = document.getElementById("tabyt-ambient");
    if (!player || !host || !host.isConnected || host.parentElement !== player) return false;
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

  /*
   * Walk a DOM node (and its open/closed shadow root) collecting all element nodes.
   * Used to find every node that could clip overflow on the player chain.
   */
  function gatherOverflowNodes(rootNode) {
    const collection = new Set();
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      collection.add(node);
      node.childNodes.forEach(walk);
      if (node.shadowRoot) walk(node.shadowRoot);
      try {
        const dom = (globalThis.chrome && globalThis.chrome.dom) || (globalThis.browser && globalThis.browser.dom);
        if (dom && dom.openOrClosedShadowRoot) {
          const sr = dom.openOrClosedShadowRoot(node);
          if (sr) walk(sr);
        }
      } catch (_e) {}
      try { node.assignedNodes && node.assignedNodes({ flatten: true }).forEach(walk); } catch (_e) {}
    };
    walk(rootNode);
    return collection;
  }

  // Shared overflow target set, populated by fitPlayer() and watched by ovObserver in start().
  // Initialized as soon as the module loads so observers can reference it immediately.
  const overflowTargets = new Set();
  // Live guard: YouTube's player JS may flip overflow:hidden after our setImp runs.
  // Two observers (fitPlayer + start) both create this, guarded by if (!ovObserver).
  let ovObserver = null;

  function isFullscreen() {
    const root = watchRoot();
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      (root && (root.hasAttribute("fullscreen") || root.classList.contains("fullscreen")))
    );
  }

  /*
   * Theater-style sizing: the player fills the left column at 16:9, exactly like
   * YouTube's theater mode. A 16:9 box means the metadata below it starts after
   * the video instead of sliding underneath, and videos of another shape are
   * letterboxed inside it by object-fit: contain, never cropped.
   *
   * Sizes are written as CSS variables, never as inline pixel sizes on the
   * player internals: author !important inline sizes beat the browser's
   * fullscreen layout and used to break fullscreen. During fullscreen the CSS
   * that consumes these variables is scoped out, so the browser always owns
   * the real size.
   */
  function fitPlayer() {
    // If player resizing is disabled in settings, hand the player back to YouTube.
    // The class gate in layout.css makes sure none of the player-sizing rules
    // apply, so the video keeps its native dimensions and cannot be collapsed.
    if (!settings.playerResize) {
      clearFitStyles();
      lastTargetW = 0;
      lastTargetH = 0;
      document.documentElement.classList.remove("tabyt-player-resize", "tabyt-fullscreen");
      document.documentElement.style.removeProperty("--tabyt-player-width");
      document.documentElement.style.removeProperty("--tabyt-player-height");
      /*
       * These two were written directly onto ytd-watch-flexy when resizing was
       * on, so styleBackup/clearFitStyles() does not know about them. Leaving
       * them behind makes YouTube keep the old player size even after the
       * setting is switched off in the same tab.
       */
      const offRoot = watchRoot();
      if (offRoot) {
        offRoot.style.removeProperty("--ytd-watch-flexy-player-width");
        offRoot.style.removeProperty("--ytd-watch-flexy-player-height");
      }
      return;
    }
    document.documentElement.classList.add("tabyt-player-resize");
    if (isFullscreen()) {
      clearFitStyles();
      lastTargetW = 0;
      lastTargetH = 0;
      document.documentElement.classList.add("tabyt-fullscreen");
      const root = watchRoot();
      if (root) {
        root.style.removeProperty("--ytd-watch-flexy-player-width");
        root.style.removeProperty("--ytd-watch-flexy-player-height");
      }
      return;
    }
    document.documentElement.classList.remove("tabyt-fullscreen");
    const root = watchRoot();
    if (!root) {
      clearFitStyles();
      return;
    }

    const player = root.querySelector("#player");
    const parent = player && player.parentElement;
    if (!player || !parent) return;

    /*
     * Measure the parent's content box so the player never overflows it when
     * YouTube leaves padding on #primary-inner. This is cheap, so it runs
     * before any gathering: when the size is unchanged we can bail out
     * without walking the player's shadow DOM or rewriting styles, which is
     * what used to lag while resizing.
     */
    const parentStyle = getComputedStyle(parent);
    const availableWidth = Math.floor(
      parent.clientWidth -
      (parseFloat(parentStyle.paddingLeft) || 0) -
      (parseFloat(parentStyle.paddingRight) || 0)
    );
    if (availableWidth < 160) return;

    // Use actual video aspect ratio, fall back to 16:9
    const video = document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");
    const ratio = (video && video.videoWidth > 0 && video.videoHeight > 0)
      ? video.videoWidth / video.videoHeight
      : 16 / 9;

    const targetW = availableWidth;
    const targetH = Math.max(120, Math.round(targetW / ratio));

    if (lastTargetW === targetW && lastTargetH === targetH) {
      ensureAmbient();
      return;
    }

    /*
     * YouTube's player JS sets overflow:hidden on #movie_player / ytd-player,
     * which clips the bottom control bar when the player box is exactly sized.
     * Inline !important beats stylesheet rules, but we clear it on fullscreen.
     * Reach into ytd-player's shadow root too: in Chromium the real player lives
     * there and a document-level query misses it. Only run when the size
     * changed — the common resize path now bails out above.
     */
    const playerHost = root.querySelector("ytd-player");
    [
      "#player-container-outer", "#player-container-inner", "#player-container",
      "ytd-player", "#movie_player", ".html5-video-player"
    ].forEach((sel) => {
      root.querySelectorAll(sel).forEach((node) => overflowTargets.add(node));
    });

    // Player host and its shadow root
    if (playerHost) {
      const playerSR = playerHost.shadowRoot;
      if (playerSR) gatherOverflowNodes(playerSR).forEach((node) => overflowTargets.add(node));
    }

    // Also walk the light-DOM chain from #player down
    const lightPlayer = root.querySelector("#player");
    if (lightPlayer) gatherOverflowNodes(lightPlayer).forEach((node) => overflowTargets.add(node));

    const controls = root.querySelector(".ytp-chrome-bottom") ||
      (playerHost && playerHost.shadowRoot && playerHost.shadowRoot.querySelector(".ytp-chrome-bottom"));
    const gradient = root.querySelector(".ytp-gradient-bottom") ||
      (playerHost && playerHost.shadowRoot && playerHost.shadowRoot.querySelector(".ytp-gradient-bottom"));
    if (controls) {
      setImp(controls, "bottom", "0px");
      let node = controls.parentElement;
      while (node && node !== root) {
        overflowTargets.add(node);
        if (node.id === "movie_player" || node.id === "player") break;
        node = node.parentElement;
      }
    }
    if (gradient) setImp(gradient, "bottom", "0px");
    overflowTargets.forEach((node) => setImp(node, "overflow", "visible"));

    // Start a live guard that re-applies overflow:visible whenever YouTube resets it.
    if (!ovObserver) {
      ovObserver = new MutationObserver(() => {
        overflowTargets.forEach((node) => setImp(node, "overflow", "visible"));
        const ph = root.querySelector("ytd-player");
        if (ph && ph.shadowRoot) {
          gatherOverflowNodes(ph.shadowRoot).forEach((node) => setImp(node, "overflow", "visible"));
        }
      });
      const targetNodes = [root.querySelector("#player"), root.querySelector("ytd-player"), playerHost].filter(Boolean);
      targetNodes.forEach((n) => {
        if (n) ovObserver.observe(n, { attributes: true, subtree: true, attributeFilter: ["style", "class"] });
      });
    }

    lastTargetW = targetW;
    lastTargetH = targetH;

    const widthPx = targetW + "px";
    const heightPx = targetH + "px";

    document.documentElement.style.setProperty("--tabyt-player-width", widthPx);
    document.documentElement.style.setProperty("--tabyt-player-height", heightPx);
    root.style.setProperty("--ytd-watch-flexy-player-width", widthPx);
    root.style.setProperty("--ytd-watch-flexy-player-height", heightPx);

    ensureAmbient();
  }

  function observePrimary() {
    const root = watchRoot();
    const primary = root && root.querySelector("#primary");
    if (!primary || typeof ResizeObserver !== "function") return;
    if (mainObserver && mainObserver.__target === primary) return;
    if (mainObserver) mainObserver.disconnect();
    mainObserver = new ResizeObserver(() => fitPlayer());
    mainObserver.__target = primary;
    mainObserver.observe(primary);

    const player = root.querySelector("#player");
    if (player) mainObserver.observe(player);

    if (playerAttrObserver) playerAttrObserver.disconnect();
    playerAttrObserver = new MutationObserver(() => fitPlayer());
    if (player) playerAttrObserver.observe(player, { attributes: true, attributeFilter: ["style", "class"], subtree: true });
    const playerHost = root.querySelector("ytd-player");
    const sr = playerHost && (playerHost.shadowRoot || (() => { try { const dom = (globalThis.chrome && globalThis.chrome.dom) || (globalThis.browser && globalThis.browser.dom); return dom && dom.openOrClosedShadowRoot ? dom.openOrClosedShadowRoot(playerHost) : null; } catch (_e) { return null; } })());
    if (sr) playerAttrObserver.observe(sr, { attributes: true, attributeFilter: ["style", "class"], subtree: true });

    // ovObserver is shared with fitPlayer(); only create once, fitPlayer populates overflowTargets.

    const video = document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");
    if (video && !video.__tabytMetaBound) {
      video.__tabytMetaBound = true;
      video.addEventListener("loadedmetadata", () => fitPlayer());
      video.addEventListener("canplay", () => fitPlayer());
    }
  }

  function sideWidth() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--tabyt-side");
    const width = parseFloat(raw);
    return Number.isFinite(width) ? width : 420;
  }

  function setSide(px, persist) {
    const next = Math.round(Math.min(680, Math.max(280, px)));
    const value = next + "px";
    document.documentElement.style.setProperty("--tabyt-side", value);
    if (persist !== false) {
      try { sessionStorage.setItem(SIDE_KEY, value); } catch (_error) { /* Private mode can block storage. */ }
    }
    fitPlayer();
  }

  function applySavedSide() {
    try {
      const saved = sessionStorage.getItem(SIDE_KEY);
      if (saved) document.documentElement.style.setProperty("--tabyt-side", saved);
    } catch (_error) { /* Ignore storage failures. */ }
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
    if (playerAttrObserver) { playerAttrObserver.disconnect(); playerAttrObserver = null; }
    if (ovObserver) { ovObserver.disconnect(); ovObserver = null; }
    clearFitStyles();
    lastTargetW = 0;
    lastTargetH = 0;
    panelScroll.clear();
    document.documentElement.classList.remove("tabyt-layout-on", "tabyt-dragging", "tabyt-rail-info", "tabyt-fullscreen", "tabyt-player-resize", "tabyt-live-stream", "tabyt-entering");
    if (enterTimer) {
      clearTimeout(enterTimer);
      enterTimer = 0;
    }
    document.documentElement.style.removeProperty("--tabyt-side");
    document.documentElement.style.removeProperty("--tabyt-player-width");
    document.documentElement.style.removeProperty("--tabyt-player-height");
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

  /* Views, upload date and likes stay visible in the Info tab. */
  function statsLine() {
    const parts = [];
    const info = deepFind(document, "ytd-watch-metadata #info") ||
      firstMatch(["ytd-watch-flexy #info", "#info"]);
    const infoText = nodeText(info);
    if (infoText) parts.push(infoText);

    const likeButton = deepFind(document, "ytd-watch-metadata #top-level-buttons-computed like-button-view-model button") ||
      firstMatch(["#top-level-buttons-computed like-button-view-model button", "like-button-view-model button"]);
    let likeText = "";
    if (likeButton) {
      const label = likeButton.getAttribute("aria-label") || "";
      const exact = label.match(/([\d,.]+)\s*other people/i);
      likeText = exact ? exact[1] : nodeText(likeButton);
    }
    if (likeText) parts.push(likeText + " likes");
    return parts.join("  ·  ");
  }

  function descriptionContent(descNode) {
    if (!descNode) return null;
    /* #expanded exists even before the native toggle is clicked. */
    const expanded = deepFind(descNode, "#expanded");
    if (expanded && nodeText(expanded)) return expanded;
    const collapsed = deepFind(descNode, "#collapsed");
    if (collapsed && nodeText(collapsed)) return collapsed;
    /*
     * The expander may hold only a snippet of the description; the component
     * hosts above it carry the full text. Use the ancestor with the longest
     * text so the copy and the "more" toggle show the real description.
     */
    let source = descNode;
    let node = descNode.parentElement;
    let guard = 0;
    while (node && guard < 6) {
      const text = nodeText(node);
      if (text && text.length > nodeText(source).length) source = node;
      node = node.parentElement;
      guard += 1;
    }
    return source;
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

  function addDescriptionToggle(info, body, descNode) {
    const content = document.createElement("div");
    content.className = "tabyt-desc-content";
    const source = descriptionContent(descNode);
    let clone = source ? source.cloneNode(true) : null;
    if (clone) {
      clone.removeAttribute("id");
      clone.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));

      /* Unwrap any remaining component shell so no shadow toggle can linger. */
      const unwrap = (node) => {
        const plain = document.createElement("div");
        while (node.firstChild) plain.appendChild(node.firstChild);
        return plain;
      };
      if (clone.tagName === "YTD-TEXT-INLINE-EXPANDER") {
        clone = unwrap(clone);
      } else {
        for (const expander of clone.querySelectorAll("ytd-text-inline-expander")) {
          expander.replaceWith(unwrap(expander));
        }
      }
      stripDeadToggles(clone);
      clone.classList.add("tabyt-desc-text");
      content.appendChild(clone);
    }

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tabyt-desc-toggle";

    const apply = () => {
      const expanded = Boolean(info.__descExpanded);
      body.classList.toggle("tabyt-desc-expanded", expanded);
      toggle.textContent = expanded ? "Show less" : "…more";
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    };
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      info.__descExpanded = !info.__descExpanded;
      apply();
    });

    body.append(content, toggle);
    appendChapters(content, descNode);
    apply();
  }

  /*
   * Build the Info panel from a copy of YouTube's title and description. The
   * copy is only rebuilt when the source text changes, so it stays put while
   * YouTube re-renders the real nodes in the left column (which we hide).
   */
  function renderInfoCopy(info, titleNode, descNode) {
    if (!info) return;
    const titleText = nodeText(titleNode);
    const descText = nodeText(descNode);
    const metaText = statsLine();
    const key = titleText + "::" + descText.length + ":" + descText.slice(0, 120) + "::" + metaText;
    if (info.__infoKey === key && info.querySelector(".tabyt-info-title, .tabyt-info-desc, .tabyt-empty")) return;

    // A new video gets a fresh collapsed state; expanding our copy must not be
    // undone by an incidental rebuild of the same description.
    if (info.__infoVideoKey !== titleText) {
      info.__infoVideoKey = titleText;
      info.__descExpanded = false;
    }
    info.__infoKey = key;
    info.textContent = "";

    if (titleText) {
      const heading = document.createElement("h1");
      heading.className = "tabyt-info-title";
      heading.textContent = titleText;
      info.appendChild(heading);
    }
    if (metaText) {
      const meta = document.createElement("p");
      meta.className = "tabyt-info-meta";
      meta.textContent = metaText;
      info.appendChild(meta);
    }
    if (descNode) {
      const body = document.createElement("div");
      body.className = "tabyt-info-desc";
      addDescriptionToggle(info, body, descNode);
      info.appendChild(body);
    }
    if (!titleText && !descNode) {
      const note = document.createElement("p");
      note.className = "tabyt-empty";
      note.textContent = "Title and description appear here when YouTube finishes loading this video.";
      info.appendChild(note);
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
    tabbar.appendChild(makeTab("other", "Other videos", false));
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
    if (before) panelScroll.set(before.getAttribute("data-panel"), before.scrollTop);

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
    if (after) after.scrollTop = panelScroll.get(activeTab) || 0;
    if (focus) match.focus();
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
      panel.scrollTop = 0;
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
     * A live stream swaps comments for live chat: the Comments tab is hidden
     * and the Live tab carries YouTube's own chat frame. Regular videos keep
     * the Comments tab exactly as before.
     */
    const liveStream = isLiveVideo();
    const showComments = !!settings.layoutComments && !liveStream;
    const showLive = !!settings.layoutLive && (liveStream || (!!settings.layoutChat && !!chatNode));
    document.documentElement.classList.toggle("tabyt-live-stream", liveStream);

    setTabVisible(rail, "info", settings.layoutInfo);
    setTabVisible(rail, "comments", showComments);
    setTabVisible(rail, "live", showLive);
    setTabVisible(rail, "other", settings.layoutOther);
    setTabVisible(rail, "related", settings.layoutRelated);

    /*
     * Do not move YouTube's title/description nodes into the rail: YouTube's
     * own rendering keeps re-inserting them into #primary, which made them
     * twitch between the two sides. Instead render a stable copy in the rail
     * and hide the originals with CSS while the Info tab is on.
     */
    document.documentElement.classList.toggle("tabyt-rail-info", !!settings.layoutInfo);
    if (settings.layoutInfo) {
      unslot(info, "title");
      unslot(info, "description");
      renderInfoCopy(info, title, description);
    } else {
      info.__infoKey = "";
      info.textContent = "";
    }

    if (showComments) {
      slot(commentNode, comments, "comments");
      emptyNote(comments, commentNode ? "" : "Comments appear here when this video has them.");
    } else {
      unslot(comments, "comments");
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

    if (showLive && settings.layoutChat && chatNode) {
      slot(chatNode, live, "chat");
      emptyNote(live, "");
    } else {
      unslot(live, "chat");
      emptyNote(live, showLive
        ? "Live chat appears here when YouTube loads it."
        : "Live chat appears here when this video is a live stream.");
    }

    showTab(activeTab);
  }

  function sync() {
    if (quiet) return;
    quiet = true;
    try {
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
      ensureDivider(column);
      applyTabs(ensureRail(host));
      if (document.getElementById("tabyt-rail")) booted = true;
      /*
       * Animated entry: the rail shell (tab bar, panels, related list) is in
       * place immediately; applyTabs fills the panels and the info copy slides
       * in over ~400ms so YouTube's native layout never appears.
       */
      document.documentElement.classList.add("tabyt-entering");
      clearTimeout(enterTimer);
      enterTimer = setTimeout(() => {
        document.documentElement.classList.remove("tabyt-entering");
      }, 1200);
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
    timer = setTimeout(sync, (booted && Date.now() > fastUntil) ? 30 : 0);
  }

  function start() {
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("yt-navigate-start", () => { fastUntil = Date.now() + 3000; });
    document.addEventListener("yt-navigate-finish", () => {
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
    injectionTimer = setInterval(reinjectAmbient, 1000);
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
