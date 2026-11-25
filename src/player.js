/*
 * TabYT native player adapter.
 *
 * This module drives the player already on youtube.com. It does NOT create a
 * second, embedded player: the IFrame API libraries (yt-player, youtube-player,
 * react-player, ...) can only control a player on your own page, not the real
 * YouTube tab. Everything here works from an isolated-world content script:
 *
 *   - playback uses the <video> element's native DOM API
 *   - fullscreen / theater use YouTube's own control buttons
 *   - quality / captions / audio track use YouTube's settings menu (clicked
 *     through the open and closed shadow roots the player builds)
 *
 * The result is exposed as window.TabYTPlayer for layout.js and content.js.
 */
(() => {
  if (window.TabYTPlayer) return;

  const api = globalThis.browser || globalThis.chrome;
  const SETTINGS_KEY = "tabyt:settings";
  const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75, 0.5];
  const BAR_IDLE_MS = 3000;

  const events = new Map();
  let boundVideo = null;
  let bar = null;
  let barRefs = null;
  let customControls = true;
  let uiTimer = 0;
  let rebindTimer = 0;
  let barIdleTimer = 0;

  /* ---------------------------------------------------------------- */
  /* Shadow DOM helpers                                               */
  /* ---------------------------------------------------------------- */

  function shadowOf(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.shadowRoot) return node.shadowRoot;
    try {
      const dom = (globalThis.chrome && globalThis.chrome.dom) ||
        (globalThis.browser && globalThis.browser.dom);
      return dom && dom.openOrClosedShadowRoot ? dom.openOrClosedShadowRoot(node) : null;
    } catch (_error) {
      return null;
    }
  }

  /*
   * The player lives either in the light DOM or inside ytd-player's shadow.
   * Discover those roots once and cache them: walking every element's closed
   * shadow root on each 250 ms state poll would be far too expensive.
   */
  let scopeCache = null;
  let scopeStamp = 0;

  function collectScopes() {
    const scopes = [document];
    const hosts = document.querySelectorAll("ytd-player, #movie_player, ytd-watch-flexy, ytd-app");
    for (const host of hosts) {
      const root = shadowOf(host);
      if (root && scopes.indexOf(root) === -1) scopes.push(root);
    }
    const nested = [];
    for (const scope of scopes) {
      if (scope === document) continue;
      const all = scope.querySelectorAll("*");
      for (const node of all) {
        if (node.shadowRoot && scopes.indexOf(node.shadowRoot) === -1 &&
            nested.indexOf(node.shadowRoot) === -1) {
          nested.push(node.shadowRoot);
        }
      }
    }
    return scopes.concat(nested);
  }

  function playerScopes() {
    const now = Date.now();
    /* At document_start no player roots exist yet; keep probing until they do. */
    if (!scopeCache || scopeCache.length <= 1 || now - scopeStamp > 1500) {
      scopeCache = collectScopes();
      scopeStamp = now;
    }
    return scopeCache;
  }

  function invalidateScopes() {
    scopeCache = null;
    scopeStamp = 0;
  }

  function queryAll(selector) {
    const found = [];
    const seen = new Set();
    for (const scope of playerScopes()) {
      if (seen.has(scope)) continue;
      seen.add(scope);
      try {
        scope.querySelectorAll(selector).forEach((node) => found.push(node));
      } catch (_error) {
        /* stale or detached root */
      }
    }
    return found;
  }

  function query(selector) {
    const list = queryAll(selector);
    return list.length ? list[0] : null;
  }

  function click(selector) {
    const node = query(selector);
    if (!node) return false;
    try {
      node.click();
      return true;
    } catch (_error) {
      return false;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ---------------------------------------------------------------- */
  /* Element resolution                                               */
  /* ---------------------------------------------------------------- */

  function getVideo() {
    return document.querySelector("video.html5-main-video") ||
      document.querySelector("video.video-stream") ||
      query("video");
  }

  function getPlayerBox() {
    return document.querySelector("#movie_player") ||
      document.querySelector("ytd-player") ||
      document.querySelector("#player");
  }

  function isFullscreen() {
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.querySelector("ytd-watch-flexy[fullscreen]") ||
      document.querySelector("#movie_player[fullscreen]")
    );
  }

  function isTheater() {
    const flexy = document.querySelector("ytd-watch-flexy");
    return Boolean(flexy && flexy.hasAttribute("theater"));
  }

  /* ---------------------------------------------------------------- */
  /* Tiny event bus                                                   */
  /* ---------------------------------------------------------------- */

  function on(name, handler) {
    if (typeof handler !== "function") return () => {};
    let set = events.get(name);
    if (!set) {
      set = new Set();
      events.set(name, set);
    }
    set.add(handler);
    return () => off(name, handler);
  }

  function off(name, handler) {
    const set = events.get(name);
    if (set) set.delete(handler);
  }

  function emit(name, detail) {
    const set = events.get(name);
    if (!set) return;
    set.forEach((handler) => {
      try {
        handler(detail);
      } catch (_error) {
        /* a listener must never break the player */
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* State                                                            */
  /* ---------------------------------------------------------------- */

  function getState() {
    const video = getVideo();
    const currentTime = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
    let buffered = 0;
    if (video && video.buffered && video.buffered.length) {
      try {
        buffered = video.buffered.end(video.buffered.length - 1);
      } catch (_error) {
        buffered = 0;
      }
    }
    return {
      available: !!video,
      playing: Boolean(video && !video.paused && !video.ended && video.readyState > 2),
      paused: !video || video.paused,
      currentTime,
      duration,
      buffered,
      volume: video ? Number(video.volume) : 1,
      muted: Boolean(video && video.muted),
      playbackRate: video ? Number(video.playbackRate) || 1 : 1,
      quality: currentQuality(),
      captions: Boolean(query(".ytp-subtitles-button[aria-pressed='true']")),
      fullscreen: isFullscreen(),
      theater: isTheater(),
      live: Boolean(video && video.duration === Infinity),
      width: video ? Number(video.videoWidth) || 0 : 0,
      height: video ? Number(video.videoHeight) || 0 : 0
    };
  }

  /* ---------------------------------------------------------------- */
  /* Playback control (native video API)                              */
  /* ---------------------------------------------------------------- */

  function play() {
    const video = getVideo();
    if (!video) return Promise.resolve(false);
    try {
      return Promise.resolve(video.play()).then(() => true).catch(() => false);
    } catch (_error) {
      return Promise.resolve(false);
    }
  }

  function pause() {
    const video = getVideo();
    if (!video) return;
    try { video.pause(); } catch (_error) { /* ignore */ }
  }

  function togglePlay() {
    const video = getVideo();
    if (!video) return;
    if (video.paused || video.ended) play();
    else pause();
  }

  function seekTo(seconds) {
    const video = getVideo();
    if (!video) return;
    let target = Math.max(0, Number(seconds) || 0);
    if (Number.isFinite(video.duration) && video.duration > 2) {
      target = Math.min(target, video.duration - 0.5);
    }
    try { video.currentTime = target; } catch (_error) { /* ignore */ }
  }

  function seekBy(delta) {
    const video = getVideo();
    if (!video) return;
    seekTo(video.currentTime + (Number(delta) || 0));
  }

  function setVolume(value) {
    const video = getVideo();
    if (!video) return;
    const level = Math.min(1, Math.max(0, Number(value) || 0));
    try {
      video.volume = level;
      if (level > 0 && video.muted) video.muted = false;
    } catch (_error) {
      /* ignore */
    }
  }

  function changeVolume(delta) {
    const video = getVideo();
    if (!video) return;
    const amount = Number(delta) || 0;
    setVolume((video.muted ? 0 : video.volume) + amount);
  }

  function toggleMute() {
    const video = getVideo();
    if (!video) return;
    try { video.muted = !video.muted; } catch (_error) { /* ignore */ }
  }

  function setPlaybackRate(rate) {
    const video = getVideo();
    if (!video) return;
    const value = Math.min(2, Math.max(0.25, Number(rate) || 1));
    try { video.playbackRate = value; } catch (_error) { /* ignore */ }
  }

  function cyclePlaybackRate() {
    const video = getVideo();
    if (!video) return 1;
    const current = Number(video.playbackRate) || 1;
    const index = SPEEDS.indexOf(current);
    const next = SPEEDS[(index + 1) % SPEEDS.length];
    setPlaybackRate(next);
    return next;
  }

  function getPlaybackRates() {
    return SPEEDS.slice();
  }

  /* ---------------------------------------------------------------- */
  /* Fullscreen / theater (YouTube's own buttons keep its state in sync) */
  /* ---------------------------------------------------------------- */

  function toggleFullscreen() {
    if (click(".ytp-fullscreen-button")) return true;
    const box = getPlayerBox();
    if (box && box.requestFullscreen) {
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
      } else {
        try { box.requestFullscreen(); } catch (_error) { return false; }
      }
      return true;
    }
    return false;
  }

  function requestFullscreen() {
    if (!isFullscreen()) toggleFullscreen();
  }

  function exitFullscreen() {
    if (isFullscreen()) toggleFullscreen();
  }

  function toggleTheater() {
    return click(".ytp-theater-button") || click("[data-tooltip*='Theater']");
  }

  /* ---------------------------------------------------------------- */
  /* YouTube's settings menu: quality / captions / audio track        */
  /* ---------------------------------------------------------------- */

  function menuItems() {
    return queryAll(".ytp-menuitem");
  }

  function itemLabel(item) {
    const label = item && item.querySelector(".ytp-menuitem-label");
    return String((label || item || {}).textContent || "").replace(/\s+/g, " ").trim();
  }

  function currentQuality() {
    const items = menuItems();
    for (const item of items) {
      if (item.classList.contains("ytp-menuitem-selected")) {
        const label = itemLabel(item);
        if (label) return label;
      }
    }
    return "";
  }

  function openSettings() {
    return click(".ytp-settings-button") || click(".ytp-settings-button *");
  }

  function clickMenuItem(words) {
    const items = menuItems();
    for (const item of items) {
      const label = itemLabel(item).toLowerCase();
      if (!label) continue;
      if (words.some((word) => label.indexOf(word) !== -1)) {
        try { item.click(); return itemLabel(item); } catch (_error) { /* next */ }
      }
    }
    return "";
  }

  /*
   * Opens the settings menu to a category (e.g. "Quality") so YouTube renders
   * its own, up-to-date list of options. The caller decides what to do with it;
   * selectMenuOption() clicks one of those options by label.
   */
  async function openMenu(categoryWords) {
    if (!openSettings()) return false;
    await wait(90);
    return Boolean(clickMenuItem(categoryWords));
  }

  async function selectMenuOption(categoryWords, option) {
    if (!await openMenu(categoryWords)) return false;
    await wait(90);
    const wanted = String(option || "").toLowerCase();
    for (const item of menuItems()) {
      const label = itemLabel(item);
      if (!label) continue;
      if (label.toLowerCase() === wanted || label.toLowerCase().indexOf(wanted) !== -1) {
        try { item.click(); return true; } catch (_error) { /* next */ }
      }
    }
    return false;
  }

  function setQuality(label) {
    return selectMenuOption(["quality", "resolution"], label);
  }

  function openQualityMenu() {
    return openMenu(["quality", "resolution"]);
  }

  function openAudioMenu() {
    return openMenu(["audio track"]);
  }

  function toggleCaptions() {
    return click(".ytp-subtitles-button") ||
      click("[data-tooltip*='Subtitles']") ||
      click("[data-tooltip*='Captions']");
  }

  function listMenuOptions() {
    return menuItems().map(itemLabel).filter(Boolean);
  }

  /* ---------------------------------------------------------------- */
  /* Custom control bar (opt-in)                                      */
  /* ---------------------------------------------------------------- */

  function fmtTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }

  function button(action, label, title) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tabyt-pc-btn";
    el.dataset.action = action;
    el.textContent = label;
    el.title = title;
    el.setAttribute("aria-label", title);
    return el;
  }

  /* Auto-hide the bar after inactivity, like YouTube's own control overlay. */
  function armBarIdle() {
    clearTimeout(barIdleTimer);
    if (!customControls || !bar) return;
    barIdleTimer = setTimeout(() => {
      if (!bar || !barRefs) return;
      // Never hide while the pointer, keyboard focus, or a drag is on the bar.
      if (bar.matches(":hover") || bar.contains(document.activeElement) ||
          bar.querySelector(".tabyt-pc-progress:active")) {
        armBarIdle();
        return;
      }
      bar.classList.add("tabyt-bar-hidden");
    }, BAR_IDLE_MS);
  }

  function wakeBar() {
    if (!bar) return;
    bar.classList.remove("tabyt-bar-hidden");
    armBarIdle();
  }

  function pointerOnPlayer(event) {
    if (!customControls || !bar) return;
    const box = getPlayerBox();
    if (!box || !box.isConnected) return;
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) return;
    wakeBar();
  }

  /* A stale bar is one left behind by a replaced player after a video reload. */
  function barIsHealthy() {
    return Boolean(bar && barRefs && bar.isConnected && document.documentElement.contains(bar));
  }

  function removeDuplicateBars() {
    for (const node of document.querySelectorAll("#tabyt-player-controls")) {
      if (node !== bar) node.remove();
    }
  }

  function buildBar() {
    if (!customControls || barIsHealthy()) return;
    if (bar) {
      try { bar.remove(); } catch (_error) { /* already detached */ }
    }
    bar = null;
    barRefs = null;
    removeDuplicateBars();

    const video = getVideo();
    if (!video) return;

    const host = document.querySelector("#movie_player") ||
      document.querySelector("ytd-player") || video.parentElement;
    if (!host) return;

    const root = document.createElement("div");
    root.id = "tabyt-player-controls";
    root.className = "tabyt-player-controls";
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "TabYT player controls");

    const progress = document.createElement("div");
    progress.className = "tabyt-pc-progress";
    progress.innerHTML =
      '<div class="tabyt-pc-buffered"></div>' +
      '<div class="tabyt-pc-played"></div>' +
      '<div class="tabyt-pc-knob"></div>';
    progress.title = "Seek";
    progress.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const state = getState();
      if (!state.duration) return;
      const rect = progress.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      seekTo(ratio * state.duration);
    });

    const row = document.createElement("div");
    row.className = "tabyt-pc-row";
    const playBtn = button("play", "▶", "Play / pause");
    const backBtn = button("back", "−10", "Back 10 seconds");
    const fwdBtn = button("forward", "+10", "Forward 10 seconds");
    const time = document.createElement("span");
    time.className = "tabyt-pc-time";
    const spacer = document.createElement("span");
    spacer.className = "tabyt-pc-space";
    const muteBtn = button("mute", "🔊", "Mute / unmute");
    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "tabyt-pc-volume";
    volume.min = "0";
    volume.max = "100";
    volume.step = "1";
    volume.title = "Volume";
    volume.setAttribute("aria-label", "Volume");
    volume.addEventListener("input", () => setVolume(Number(volume.value) / 100));
    const speedBtn = button("speed", "1×", "Playback speed");
    const qualityBtn = button("quality", "HQ", "Quality");
    const ccBtn = button("captions", "CC", "Captions");
    const audioBtn = button("audio", "AU", "Audio track");
    const theaterBtn = button("theater", "▭", "Theater mode");
    const fullBtn = button("fullscreen", "⛶", "Fullscreen");

    row.append(playBtn, backBtn, fwdBtn, time, spacer, muteBtn, volume,
      speedBtn, qualityBtn, ccBtn, audioBtn, theaterBtn, fullBtn);
    root.append(progress, row);

    row.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      switch (btn.dataset.action) {
        case "play": togglePlay(); break;
        case "back": seekBy(-10); break;
        case "forward": seekBy(10); break;
        case "mute": toggleMute(); break;
        case "speed": btn.textContent = cyclePlaybackRate() + "×"; break;
        case "quality": openQualityMenu(); break;
        case "captions": toggleCaptions(); break;
        case "audio": openAudioMenu(); break;
        case "theater": toggleTheater(); break;
        case "fullscreen": toggleFullscreen(); break;
        default: break;
      }
      updateBar();
    });

    host.appendChild(root);
    bar = root;
    barRefs = {
      play: playBtn,
      mute: muteBtn,
      volume,
      time,
      played: progress.querySelector(".tabyt-pc-played"),
      buffered: progress.querySelector(".tabyt-pc-buffered"),
      knob: progress.querySelector(".tabyt-pc-knob"),
      speed: speedBtn,
      quality: qualityBtn,
      cc: ccBtn
    };
    document.documentElement.classList.add("tabyt-custom-controls");
    updateBar();
    armBarIdle();
  }

  function updateBar() {
    if (!customControls) return;
    if (!barIsHealthy()) {
      ensureInjection();
      return;
    }
    hideNativeControls(true);
    const state = getState();
    const pct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
    const buf = state.duration > 0 ? (state.buffered / state.duration) * 100 : 0;
    barRefs.played.style.width = pct + "%";
    barRefs.buffered.style.width = Math.min(100, buf) + "%";
    barRefs.knob.style.left = pct + "%";
    barRefs.time.textContent = state.live
      ? `LIVE · ${fmtTime(state.currentTime)}`
      : `${fmtTime(state.currentTime)} / ${fmtTime(state.duration)}`;
    barRefs.play.textContent = state.playing ? "❚❚" : "▶";
    barRefs.mute.textContent = state.muted || state.volume === 0 ? "🔇" : "🔊";
    barRefs.speed.textContent = state.playbackRate + "×";
    if (document.activeElement !== barRefs.volume) {
      barRefs.volume.value = String(Math.round((state.muted ? 0 : state.volume) * 100));
    }
    barRefs.quality.textContent = state.quality || "HQ";
    barRefs.cc.style.opacity = state.captions ? "1" : "0.6";
  }

  /*
   * Content-script CSS cannot reach inside YouTube's shadow roots, so the
   * native chrome is hidden with inline styles on the actual nodes as well.
   */
  function hideNativeControls(hidden) {
    for (const selector of [".ytp-chrome-bottom", ".ytp-gradient-bottom", ".ytp-chrome-top"]) {
      for (const node of queryAll(selector)) {
        try {
          if (hidden) {
            if (node.style.getPropertyValue("display") === "none" &&
                node.style.getPropertyPriority("display") === "important") continue;
            node.style.setProperty("display", "none", "important");
          } else if (node.style.getPropertyValue("display") === "none") {
            node.style.removeProperty("display");
          }
        } catch (_error) {
          /* ignore detached nodes */
        }
      }
    }
  }

  function removeBar() {
    clearTimeout(barIdleTimer);
    if (bar) bar.remove();
    bar = null;
    barRefs = null;
    removeDuplicateBars();
    document.documentElement.classList.remove("tabyt-custom-controls");
    hideNativeControls(false);
  }

  /*
   * Re-inject after the player or <video> is replaced. This is deliberately
   * idempotent: a healthy bar is left alone, stale/detached bars are dropped,
   * and duplicates are removed so reloads can never stack multiple injections.
   */
  function ensureInjection() {
    if (!customControls) return;
    if (barIsHealthy()) {
      removeDuplicateBars();
      return;
    }
    invalidateScopes();
    if (!getVideo()) return;
    if (bar) {
      try { bar.remove(); } catch (_error) { /* already detached */ }
    }
    bar = null;
    barRefs = null;
    removeDuplicateBars();
    buildBar();
  }

  function setCustomControls(enabled) {
    const next = Boolean(enabled);
    if (next === customControls) return;
    customControls = next;
    if (!next) {
      removeBar();
      return;
    }
    hideNativeControls(true);
    ensureInjection();
  }

  /*
   * Settings saved by older versions have no customControls key. Normalize
   * through core so those installs pick up the new default instead of staying
   * on YouTube's native controls forever.
   */
  function enabledFrom(raw) {
    const core = window.TabYTCore;
    const settings = core && core.normalizeSettings ? core.normalizeSettings(raw) : raw;
    return Boolean(settings && settings.customControls);
  }

  function enabledSettings(raw) {
    const core = window.TabYTCore;
    return core && core.normalizeSettings ? core.normalizeSettings(raw) : raw;
  }

  function saveEarly(raw) {
    const core = window.TabYTCore;
    if (core && core.writeEarlySettings) core.writeEarlySettings(enabledSettings(raw));
  }

  function loadSetting() {
    if (!api.storage || !api.storage.local) {
      setCustomControls(true);
      return;
    }
    api.storage.local.get(SETTINGS_KEY).then((result) => {
      const settings = result && result[SETTINGS_KEY];
      saveEarly(settings);
      setCustomControls(enabledFrom(settings));
    }).catch(() => setCustomControls(true));
  }

  /* ---------------------------------------------------------------- */
  /* Binding to the current video                                     */
  /* ---------------------------------------------------------------- */

  function bindVideo(video) {
    if (!video || boundVideo === video) return;
    if (boundVideo) {
      for (const name of ["timeupdate", "play", "pause", "ended", "volumechange",
        "ratechange", "loadedmetadata", "durationchange"]) {
        const handler = boundVideo.__tabytPlayerHandler && boundVideo.__tabytPlayerHandler[name];
        if (handler) boundVideo.removeEventListener(name, handler);
      }
    }
    boundVideo = video;
    const handlers = {
      timeupdate: () => emit("timeupdate", getState()),
      play: () => emit("statechange", getState()),
      pause: () => emit("statechange", getState()),
      ended: () => emit("ended", getState()),
      volumechange: () => emit("volumechange", getState()),
      ratechange: () => emit("ratechange", getState()),
      loadedmetadata: () => { emit("ready", getState()); updateBar(); },
      durationchange: () => emit("statechange", getState())
    };
    video.__tabytPlayerHandler = handlers;
    Object.keys(handlers).forEach((name) => {
      video.addEventListener(name, handlers[name], { passive: true });
    });
    if (customControls) buildBar();
    emit("ready", getState());
  }

  function rebind() {
    const video = getVideo();
    if (video) bindVideo(video);
    if (customControls) ensureInjection();
  }

  function start() {
    // Synchronous snapshot: hide YouTube's chrome before its first paint.
    const core = window.TabYTCore;
    const early = core && core.readEarlySettings ? core.readEarlySettings() : null;
    if (core && core.applyEarlyClasses) core.applyEarlyClasses(early || core.DEFAULT_SETTINGS);
    if (early) setCustomControls(enabledFrom(early));
    if (customControls) hideNativeControls(true);
    loadSetting();
    rebind();

    rebindTimer = setInterval(rebind, 1000);
    // Poll the bar a little less often: updates only change text/widths and the
    // custom bar auto-hides via CSS, so 500ms keeps it in sync without extra churn.
    uiTimer = setInterval(updateBar, 500);

    // Capture phase reaches YouTube's player even through its shadow roots.
    document.addEventListener("mousemove", pointerOnPlayer, true);
    document.addEventListener("pointerdown", pointerOnPlayer, true);

    /*
     * A direct video reload can replace the <video> or the whole player without
     * firing yt-navigate-finish. Capture-phase media events cover that path;
     * the work is debounced and ensureInjection() is idempotent, so no duplicate
     * bars or listeners are created.
     */
    let injectionTimer = 0;
    const scheduleInjection = () => {
      clearTimeout(injectionTimer);
      injectionTimer = setTimeout(() => {
        invalidateScopes();
        rebind();
        hideNativeControls(true);
      }, 80);
    };
    for (const type of ["loadstart", "emptied", "loadedmetadata", "canplay"]) {
      document.addEventListener(type, scheduleInjection, true);
    }

    document.addEventListener("yt-navigate-finish", () => setTimeout(() => {
      removeBar();
      boundVideo = null;
      invalidateScopes();
      rebind();
      if (customControls) hideNativeControls(true);
    }, 300));

    document.addEventListener("fullscreenchange", () => emit("fullscreenchange", getState()));
    document.addEventListener("webkitfullscreenchange", () => emit("fullscreenchange", getState()));

    if (api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[SETTINGS_KEY]) {
          const settings = changes[SETTINGS_KEY].newValue;
          saveEarly(settings);
          if (core && core.applyEarlyClasses) core.applyEarlyClasses(enabledSettings(settings));
          setCustomControls(enabledFrom(settings));
        }
      });
    }

    if (api.runtime && api.runtime.onMessage) {
      api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message.type !== "string") return false;
        const control = {
          PLAYER_PLAY: play,
          PLAYER_PAUSE: pause,
          PLAYER_TOGGLE: togglePlay,
          PLAYER_SEEK: () => seekTo(message.position),
          PLAYER_SEEK_BY: () => seekBy(message.delta),
          PLAYER_VOLUME: () => setVolume(message.value),
          PLAYER_MUTE: toggleMute,
          PLAYER_RATE: () => setPlaybackRate(message.value),
          PLAYER_FULLSCREEN: toggleFullscreen,
          PLAYER_THEATER: toggleTheater,
          PLAYER_CAPTIONS: toggleCaptions,
          PLAYER_QUALITY: () => setQuality(message.value),
          PLAYER_STATE: getState
        };
        const action = control[message.type];
        if (!action) return false;
        let result;
        try { result = action(); } catch (error) { result = null; }
        sendResponse({ ok: true, value: result === undefined ? null : result });
        return false;
      });
    }
  }

  window.TabYTPlayer = {
    on,
    off,
    getState,
    isReady: () => Boolean(getVideo()),
    play,
    pause,
    togglePlay,
    seekTo,
    seekBy,
    setVolume,
    changeVolume,
    toggleMute,
    setPlaybackRate,
    cyclePlaybackRate,
    getPlaybackRates,
    toggleFullscreen,
    requestFullscreen,
    exitFullscreen,
    isFullscreen,
    toggleTheater,
    setQuality,
    openQualityMenu,
    openAudioMenu,
    toggleCaptions,
    listMenuOptions,
    getVideo,
    getPlayerBox,
    setCustomControls
  };

  start();
})();
