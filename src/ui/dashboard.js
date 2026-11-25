/*
 * TabYT dashboard.
 *
 * Renders the full-page memory overview, tab list, saved videos, history and
 * settings. All data comes from the background worker; this page never talks
 * to the network.
 */
(() => {
  "use strict";

  const ui = globalThis.TabYTUI;
  const C = ui.core;
  const $ = ui.$;
  const $$ = ui.$$;
  const ext = ui.ext;

  const ROUTES = {
    overview: {
      title: "Overview",
      subtitle: "Which YouTube tabs are using memory right now."
    },
    tabs: {
      title: "YouTube tabs",
      subtitle: "Every open YouTube tab, ranked by memory."
    },
    saved: {
      title: "Saved videos",
      subtitle: "Pick up exactly where you left off."
    },
    history: {
      title: "Memory history",
      subtitle: "How your YouTube tab memory has changed over time."
    },
    settings: {
      title: "Settings",
      subtitle: "Alerts, automatic cleanup and local data."
    },
    help: {
      title: "Help",
      subtitle: "How TabYT measures memory and keeps your place."
    }
  };

  const NUMERIC_SETTINGS = new Set([
    "inactivityMinutes",
    "maxAutoClosePerRun",
    "memoryLimitMB",
    "notifyCooldownMinutes",
    "historySampleMinutes",
    "historyRetentionDays",
    "maxSavedVideos"
  ]);

  const state = {
    data: null,
    samples: [],
    historyInfo: { retentionDays: 7, sampleMinutes: 10 },
    route: "overview",
    range: "24h",
    tabQuery: "",
    tabSort: "memory",
    savedQuery: "",
    savedSort: "recent",
    loading: false,
    busy: false,
    lastError: null,
    applyingSettings: false
  };

  let loadSequence = 0;
  let refreshTimer = null;
  let statusTimer = null;
  let resizeTimer = null;
  let settingsTimer = null;
  let pendingSettings = {};

  const els = {};

  function cacheElements() {
    const ids = [
      "sidebar-version", "page-title", "page-subtitle", "memory-pill",
      "memory-pill-dot", "memory-pill-text", "settings-status", "global-refresh",
      "top-error", "top-error-text", "top-error-retry", "welcome-slot",
      "overview-alert", "stat-tabs", "stat-tabs-note", "stat-memory",
      "stat-memory-source", "stat-memory-note", "stat-limit-pct",
      "stat-limit-badge", "stat-limit-progress", "stat-limit-fill",
      "stat-limit-note", "stat-saved", "stat-saved-note", "largest-list",
      "recent-saved", "trend-sub", "trend-peak", "trend-chart", "stats-line",
      "nav-tabs-count", "nav-saved-count", "tab-search", "tab-sort",
      "tabs-refresh", "tabs-close-all", "tabs-table", "saved-search",
      "saved-sort", "saved-clear", "saved-grid", "history-range",
      "history-sample-info", "history-clear", "history-peak",
      "history-average", "history-count", "history-range-note", "chart-sub",
      "history-chart", "offenders-table", "samples-table", "retention-note",
      "limit-badge", "auto-close-badge", "layout-badge", "precise-badge", "precise-note",
      "precise-row", "precise-button", "precise-description", "storage-saved",
      "storage-history", "storage-limit", "help-version", "footer-version",
      "confirm-dialog", "main"
    ];
    ids.forEach((id) => {
      els[id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = document.getElementById(id);
    });
  }

  function hydrateIcons(root) {
    ui.$$("[data-icon]", root || document).forEach((el) => {
      el.innerHTML = ui.icon(el.dataset.icon, Number(el.dataset.size) || 15);
    });
  }

  function readRoute() {
    const hash = String(location.hash || "").replace(/^#/, "").trim();
    if (hash && ROUTES[hash]) return hash;
    return "overview";
  }

  function navigate(route, replace) {
    const next = ROUTES[route] ? route : "overview";
    if (readRoute() === next && state.route === next) {
      renderRoute();
      return;
    }
    if (replace) {
      try {
        history.replaceState(null, "", `#${next}`);
      } catch (_error) {
        location.hash = next;
        return;
      }
      state.route = next;
      renderRoute();
    } else {
      location.hash = next;
    }
  }

  function renderRoute() {
    const next = readRoute();
    const changed = state.route !== next;
    state.route = next;
    $$("[data-view]").forEach((view) => {
      view.hidden = view.dataset.view !== state.route;
    });
    $$(".nav-item[data-route]").forEach((button) => {
      if (button.dataset.route === state.route) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });
    const meta = ROUTES[state.route] || ROUTES.overview;
    els.pageTitle.textContent = meta.title;
    els.pageSubtitle.textContent = meta.subtitle;
    document.title = `TabYT — ${meta.title}`;
    renderCurrentView();
    if (changed) {
      try {
        window.scrollTo(0, 0);
      } catch (_error) {
        /* Scrolling is best effort. */
      }
    }
    try {
      els.main.focus({ preventScroll: true });
    } catch (_error) {
      /* noop */
    }
  }

  function render() {
    if (!state.data) return;
    const settings = state.data.settings;
    const totals = state.data.totals;
    const count = totals.count;
    const browserCount = Number(totals.browserTabCount) || 0;
    const browserName = ui.browserLabel((state.data.capabilities || {}).browser);
    const limit = Number(totals.limitMB) || 0;

    els.memoryPillText.textContent = count
      ? `${ui.formatMemory(totals.memoryMB)} · ${count} tab${count === 1 ? "" : "s"}`
      : "No YouTube tabs";
    const tone = ui.toneForMemory(totals.memoryMB, limit);
    els.memoryPill.dataset.tone = tone === "normal" ? "" : tone;
    els.navTabsCount.textContent = String(count);
    els.navTabsCount.title = `${browserCount} open ${browserName} tabs; ${count} YouTube tabs listed`;
    els.navSavedCount.textContent = String(state.data.saved.length);

    const version = (state.data.capabilities && state.data.capabilities.version) || C.VERSION;
    els.sidebarVersion.textContent = `v${version}`;
    els.footerVersion.textContent = `v${version}`;
    els.helpVersion.textContent = `TabYT v${version} · Local-only YouTube tab memory manager`;

    renderWelcome(settings);
    renderCurrentView(settings);
  }

  function renderCurrentView(settings) {
    if (!state.data) return;
    const active = settings || state.data.settings;
    if (state.route === "overview") renderOverview(active);
    else if (state.route === "tabs") renderTabsView(active);
    else if (state.route === "saved") renderSavedView(active);
    else if (state.route === "history") renderHistoryView(active);
    else if (state.route === "settings") renderSettingsView(active);
  }

  /* ------------------------------------------------------------------ */
  /* Overview                                                            */
  /* ------------------------------------------------------------------ */

  function renderWelcome(settings) {
    const slot = els.welcomeSlot;
    if (!slot) return;
    if (settings.onboarded) {
      slot.innerHTML = "";
      return;
    }
    slot.innerHTML = `
      <div class="welcome-banner">
        <div class="welcome-icon">${ui.icon("playCircle", 22)}</div>
        <div class="welcome-copy">
          <h2>Welcome to TabYT</h2>
          <p>See which YouTube tabs use the most memory, close them without losing your place, and bring any video back with its timestamp intact.</p>
          <div class="welcome-steps">
            <span class="welcome-step"><span>1</span> Review tabs</span>
            <span class="welcome-step"><span>2</span> Save &amp; close</span>
            <span class="welcome-step"><span>3</span> Resume later</span>
          </div>
        </div>
        <div class="welcome-actions">
          <button class="btn btn-sm btn-primary" type="button" data-action="welcome-done">Got it</button>
          <button class="btn btn-sm btn-ghost" type="button" data-route="help">How it works</button>
        </div>
      </div>`;
    hydrateIcons(slot);
  }

  function renderOverview(settings) {
    const { tabs, totals, saved, stats, capabilities } = state.data;
    const limit = Number(totals.limitMB) || 0;
    const tone = ui.toneForMemory(totals.memoryMB, limit);
    const nowPanel = document.querySelector(".now-panel");
    if (nowPanel) nowPanel.dataset.tone = tone === "normal" ? "" : tone;
    const playing = tabs.filter((tab) => tab.playing).length;
    const sleeping = tabs.filter((tab) => tab.discarded).length;

    const browserCount = Number(totals.browserTabCount) || 0;
    const browserName = ui.browserLabel((capabilities || {}).browser);
    els.statTabs.textContent = String(browserCount);
    els.statTabsNote.textContent = tabs.length
      ? `${tabs.length} YouTube${playing ? ` · ${playing} playing` : ""}${sleeping ? ` · ${sleeping} sleeping` : ""}`
      : `${browserName === "browser" ? "Browser" : `${browserName} browser`} · no YouTube tabs`;

    els.statMemory.textContent = ui.formatMemory(totals.memoryMB);
    els.statMemorySource.textContent = ui.describeSource(totals);
    els.statMemorySource.className = `badge ${totals.source === "process" ? "badge-success" : totals.preciseCount > 0 ? "badge-info" : ""}`;
    els.statMemoryNote.textContent = totals.preciseCount
      ? `${totals.preciseCount} measured · ${totals.estimateCount} estimated`
      : `Across ${tabs.length} open YouTube tab${tabs.length === 1 ? "" : "s"}`;

    if (limit > 0) {
      const pct = Math.min(999, Number(totals.percent) || 0);
      els.statLimitPct.textContent = `${Math.round(pct)}%`;
      els.statLimitBadge.textContent = totals.overLimit ? "Over limit" : pct >= 80 ? "Near limit" : "Within limit";
      els.statLimitBadge.className = `badge ${totals.overLimit ? "badge-danger" : pct >= 80 ? "badge-warning" : "badge-success"}`;
      els.statLimitFill.style.width = `${Math.min(100, pct)}%`;
      els.statLimitProgress.className = `progress thin ${tone === "normal" ? "" : tone}`;
      els.statLimitNote.textContent = totals.overLimit
        ? `Over by ${ui.formatMemory(totals.memoryMB - limit)}`
        : `${ui.formatMemory(Math.max(0, limit - totals.memoryMB))} below your limit`;
    } else {
      els.statLimitPct.textContent = "—";
      els.statLimitBadge.textContent = "No limit";
      els.statLimitBadge.className = "badge";
      els.statLimitFill.style.width = "0%";
      els.statLimitProgress.className = "progress thin";
      els.statLimitNote.textContent = "Set a limit in Settings";
    }

    els.statSaved.textContent = String(saved.length);
    els.statSavedNote.textContent = saved.length
      ? "Titles and positions kept locally"
      : "Closed videos will appear here";

    els.overviewAlert.innerHTML = buildOverviewAlert(totals, settings);
    hydrateIcons(els.overviewAlert);

    renderLargest(tabs);
    renderRecentSaved(saved);
    renderSparkline();
    renderStatsLine(stats, capabilities);
  }

  function buildOverviewAlert(totals, settings) {
    const limit = Number(totals.limitMB) || 0;
    if (!limit || !totals.overLimit) return "";
    const canClose = settings.memoryAction === "close";
    return `
      <div class="overview-alert danger">
        ${ui.icon("alert", 17)}
        <div>
          <strong>You are over your ${ui.formatMemory(limit)} memory limit.</strong>
          YouTube tabs are using about ${ui.formatMemory(totals.memoryMB)}. Review the list and close a few tabs, or raise the limit.
        </div>
        <div class="alert-actions">
          <button class="btn btn-sm" type="button" data-route="tabs">Review tabs</button>
          <button class="btn btn-sm btn-ghost" type="button" data-route="settings">Settings</button>
        </div>
      </div>`;
  }

  function renderLargest(tabs) {
    const list = tabs.slice()
      .sort((a, b) => b.memoryMB - a.memoryMB)
      .slice(0, 5);
    if (!list.length) {
      els.largestList.innerHTML = '<div class="mini-empty">No YouTube tabs open right now. Open a video and refresh to see its memory reading.</div>';
      return;
    }
    const max = Math.max(1, ...list.map((tab) => Number(tab.memoryMB) || 0));
    els.largestList.innerHTML = list.map((tab, index) => {
      const width = Math.max(3, Math.round(((Number(tab.memoryMB) || 0) / max) * 100));
      const meta = [];
      meta.push(tab.playing ? "Playing" : tab.discarded ? "Sleeping" : tab.videoId ? "Paused" : "YouTube page");
      if (tab.active) meta.push("Current");
      meta.push(ui.formatRelative(tab.lastActive));
      return `
        <div class="rank-row" data-tab-id="${tab.tabId}">
          <span class="rank-number">${index + 1}</span>
          <div class="rank-main">
            <div class="rank-title">
              <span class="title">${ui.esc(tab.title || "YouTube tab")}</span>
              ${tab.pinned ? ui.icon("pin", 11) : ""}
            </div>
            <div class="rank-meta">${meta.map((item) => `<span>${ui.esc(item)}</span>`).join("<span>·</span>")}</div>
            <div class="rank-bar"><span style="width:${width}%"></span></div>
          </div>
          <span class="rank-memory">${ui.esc(ui.formatMemory(tab.memoryMB))}</span>
          <span class="rank-actions">
            <button class="icon-btn" type="button" data-action="focus-tab" data-tab-id="${tab.tabId}" title="Switch to this tab" aria-label="Switch to ${ui.esc(tab.title)}">${ui.icon("arrowRight", 13)}</button>
          </span>
        </div>`;
    }).join("");
    hydrateIcons(els.largestList);
  }

  function renderRecentSaved(saved) {
    if (!saved.length) {
      els.recentSaved.innerHTML = '<div class="mini-empty">No saved videos yet. Close a YouTube tab with TabYT and it will show up here.</div>';
      return;
    }
    els.recentSaved.innerHTML = saved.slice(0, 4).map((item) => {
      const position = Number(item.position) || 0;
      return `
        <div class="recent-save" data-video-id="${ui.esc(item.videoId)}">
          ${ui.thumbMarkup(item.videoId, item.duration, position)}
          <div class="saved-copy">
            <div class="saved-title">${ui.esc(item.title || "YouTube video")}</div>
            <div class="saved-meta">${position >= 5 ? `Resume at ${ui.esc(ui.formatDuration(position))}` : "From start"} · ${ui.esc(ui.formatRelative(item.savedAt))}</div>
          </div>
          <button class="icon-btn" type="button" data-action="restore" data-video-id="${ui.esc(item.videoId)}" title="Resume this video" aria-label="Resume ${ui.esc(item.title)}">${ui.icon("playCircle", 14)}</button>
        </div>`;
    }).join("");
    hydrateIcons(els.recentSaved);
  }

  function renderStatsLine(stats, capabilities) {
    const version = capabilities && capabilities.version ? ` · v${capabilities.version}` : "";
    els.statsLine.textContent = `${stats.closedTotal || 0} tab${stats.closedTotal === 1 ? "" : "s"} closed · ${stats.savedTotal || 0} saved · peak ${ui.formatMemory(stats.peakMB || 0)}${version}`;
  }

  /* ------------------------------------------------------------------ */
  /* Charts                                                              */
  /* ------------------------------------------------------------------ */

  function samplesInRange() {
    const now = Date.now();
    if (state.range === "24h") {
      const cutoff = now - 24 * 60 * 60 * 1000;
      return state.samples.filter((sample) => sample && Number(sample.t) >= cutoff);
    }
    if (state.range === "7d") {
      const cutoff = now - 7 * 24 * 60 * 60 * 1000;
      return state.samples.filter((sample) => sample && Number(sample.t) >= cutoff);
    }
    return state.samples.slice();
  }

  function renderSparkline() {
    const now = Date.now();
    const recent = state.samples.filter((sample) => sample && Number(sample.t) >= now - 24 * 60 * 60 * 1000);
    const limit = Number(state.data.totals.limitMB) || 0;
    const summary = C.summarizeHistory(recent);
    els.trendSub.textContent = recent.length
      ? `Last 24 hours · ${recent.length} sample${recent.length === 1 ? "" : "s"}`
      : "Last 24 hours";
    els.trendPeak.textContent = recent.length ? `Peak ${ui.formatMemory(summary.peakMB)}` : "No samples yet";
    els.trendPeak.className = `badge ${limit > 0 && summary.peakMB > limit ? "badge-danger" : ""}`;

    if (!recent.length) {
      els.trendChart.innerHTML = `
        <div class="empty compact">
          <div class="empty-icon">${ui.icon("activity", 15)}</div>
          <strong>No history yet</strong>
          <p>TabYT starts sampling memory after you open the dashboard or leave it running for a few minutes.</p>
        </div>`;
      return;
    }

    const width = Math.max(320, (els.trendChart.clientWidth || 760) - 20);
    const height = 128;
    const points = C.downsample(recent, 90);
    els.trendChart.innerHTML = chartSvg(points, {
      width,
      height,
      limit,
      compact: true,
      startAt: now - 24 * 60 * 60 * 1000,
      endAt: now
    });
  }

  function chartSvg(points, options) {
    const opts = options || {};
    const width = opts.width;
    const height = opts.height;
    const compact = !!opts.compact;
    const pad = compact
      ? { top: 10, right: 10, bottom: 16, left: 36 }
      : { top: 14, right: 14, bottom: 24, left: 46 };
    const plotW = Math.max(10, width - pad.left - pad.right);
    const plotH = Math.max(10, height - pad.top - pad.bottom);
    const limit = Math.max(0, Number(opts.limit) || 0);
    const peak = Math.max(0, ...points.map((point) => Math.max(0, Number(point.total) || 0)));
    const yMax = Math.max(100, peak * 1.12, limit > 0 ? limit * 1.06 : 0);
    const startAt = Number(opts.startAt) || (points.length ? points[0].t : Date.now());
    const endAt = Number(opts.endAt) || (points.length ? points[points.length - 1].t : Date.now());
    const span = Math.max(1, endAt - startAt);

    const xFor = (point, index) => {
      if (opts.startAt && opts.endAt) {
        return pad.left + ((Number(point.t) - startAt) / span) * plotW;
      }
      return pad.left + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
    };
    const yFor = (value) => pad.top + plotH - (Math.max(0, Math.min(yMax, value)) / yMax) * plotH;

    const xy = points.map((point, index) => ({
      x: xFor(point, index),
      y: yFor(Number(point.total) || 0),
      point
    }));

    const line = smoothPath(xy);
    const area = xy.length
      ? `${line} L${xy[xy.length - 1].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} L${xy[0].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`
      : "";

    let grid = "";
    const rows = compact ? 2 : 4;
    for (let i = 0; i <= rows; i += 1) {
      const value = (yMax / rows) * i;
      const y = yFor(value);
      grid += `<line class="${compact ? "sparkline-grid" : "chart-grid"}" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${y.toFixed(1)}"></line>`;
      if (!compact || i === rows) {
        grid += `<text class="${compact ? "sparkline-label" : "chart-axis-label"}" x="${pad.left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${ui.esc(ui.formatMemory(value))}</text>`;
      }
    }

    let labels = "";
    const labelCount = compact ? 2 : Math.min(4, Math.max(2, Math.floor(plotW / 150)));
    for (let i = 0; i < labelCount; i += 1) {
      const ratio = labelCount === 1 ? 0.5 : i / (labelCount - 1);
      const t = startAt + span * ratio;
      const x = pad.left + plotW * ratio;
      const text = chartAxisLabel(t, endAt, ratio, span);
      labels += `<text class="${compact ? "sparkline-label" : "chart-axis-label"}" x="${x.toFixed(1)}" y="${(pad.top + plotH + 14).toFixed(1)}" text-anchor="${i === 0 ? "start" : i === labelCount - 1 ? "end" : "middle"}">${ui.esc(text)}</text>`;
    }

    const limitLine = limit > 0
      ? `<line class="${compact ? "sparkline-limit" : "chart-limit"}" x1="${pad.left}" y1="${yFor(limit).toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${yFor(limit).toFixed(1)}"></line>`
      : "";

    const dots = compact || xy.length > 60 ? "" : xy.map((item) => (
      `<circle class="chart-dot" cx="${item.x.toFixed(1)}" cy="${item.y.toFixed(1)}" r="2.6"></circle>`
    )).join("");

    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="YouTube tab memory over time">
      ${grid}
      ${area ? `<path class="${compact ? "sparkline-area" : "chart-area"}" d="${area}"></path>` : ""}
      <path class="${compact ? "sparkline-line" : "chart-line"}" d="${line}"></path>
      ${limitLine}
      ${dots}
      ${labels}
    </svg>`;
  }

  function smoothPath(points) {
    if (!points.length) return "";
    if (points.length === 1) {
      const p = points[0];
      return `M${p.x.toFixed(1)} ${p.y.toFixed(1)} L${(p.x + 1).toFixed(1)} ${p.y.toFixed(1)}`;
    }
    let d = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 1; i < points.length; i += 1) {
      d += ` L${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}`;
    }
    return d;
  }

  function shortDate(timestamp) {
    try {
      return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (_error) {
      return "—";
    }
  }

  function chartAxisLabel(timestamp, endAt, ratio, span) {
    if (span > 36 * 60 * 60 * 1000) return shortDate(timestamp);
    if (span >= 20 * 60 * 60 * 1000) {
      if (ratio <= 0.001) return "24h ago";
      if (ratio >= 0.999) return "now";
      const hours = Math.max(1, Math.round((endAt - timestamp) / (60 * 60 * 1000)));
      return `${hours}h ago`;
    }
    return ui.timeLabel(timestamp);
  }

  function renderFullChart(samples) {
    const limit = Number(state.data.settings.memoryLimitMB) || 0;
    els.chartSub.textContent = `Combined ${state.data.totals.source === "process" ? "measured" : "estimated"} memory of YouTube tabs`;
    if (!samples.length) {
      els.historyChart.innerHTML = `
        <div class="empty compact">
          <div class="empty-icon">${ui.icon("activity", 15)}</div>
          <strong>No samples in this range</strong>
          <p>TabYT samples memory while the extension is running. Choose a wider range or keep YouTube open for a few minutes.</p>
        </div>`;
      return;
    }

    const now = Date.now();
    const startAt = state.range === "24h"
      ? now - 24 * 60 * 60 * 1000
      : state.range === "7d"
        ? now - 7 * 24 * 60 * 60 * 1000
        : Number(samples[0].t) || now;
    const width = Math.max(360, (els.historyChart.clientWidth || 900) - 16);
    const height = window.matchMedia && window.matchMedia("(max-width: 720px)").matches ? 240 : 290;
    const points = C.downsample(samples, 140);
    els.historyChart.innerHTML = `${chartSvg(points, {
      width,
      height,
      limit,
      startAt,
      endAt: now
    })}<div class="chart-hover" id="chart-hover" hidden></div>`;
    attachChartHover(points, { width, height, startAt, endAt: now, limit });
  }

  function attachChartHover(points, options) {
    const wrap = els.historyChart;
    const svg = wrap.querySelector("svg");
    const tooltip = wrap.querySelector("#chart-hover");
    if (!svg || !tooltip || !points.length) return;
    const pad = { top: 14, right: 14, bottom: 24, left: 46 };
    const plotW = Math.max(10, options.width - pad.left - pad.right);
    const plotH = Math.max(10, options.height - pad.top - pad.bottom);
    const peak = Math.max(0, ...points.map((point) => Math.max(0, Number(point.total) || 0)));
    const yMax = Math.max(100, peak * 1.12, options.limit > 0 ? options.limit * 1.06 : 0);
    const span = Math.max(1, options.endAt - options.startAt);

    function position(index) {
      const point = points[index];
      const x = pad.left + ((Number(point.t) - options.startAt) / span) * plotW;
      const y = pad.top + plotH - (Math.max(0, Number(point.total) || 0) / yMax) * plotH;
      return { x, y, point };
    }

    function show(event) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const px = ((event.clientX - rect.left) / rect.width) * options.width;
      let nearest = 0;
      let distance = Infinity;
      for (let i = 0; i < points.length; i += 1) {
        const item = position(i);
        const d = Math.abs(item.x - px);
        if (d < distance) {
          distance = d;
          nearest = i;
        }
      }
      const item = position(nearest);
      const percent = ((item.x / options.width) * 100).toFixed(2);
      tooltip.style.left = `clamp(84px, ${percent}%, calc(100% - 84px))`;
      tooltip.style.top = `${Math.max(54, item.y - 8)}px`;
      tooltip.innerHTML = `
        <strong>${ui.esc(ui.formatMemory(item.point.total))}</strong>
        <span>${ui.esc(ui.formatDate(item.point.t))}</span>
        <div class="hover-top">${Math.round(Number(item.point.count) || 0)} tab${Number(item.point.count) === 1 ? "" : "s"} · ${options.limit > 0 ? ui.esc(Math.round((Number(item.point.total) / options.limit) * 100)) + "% of limit" : "No limit set"}</div>`;
      tooltip.hidden = false;
    }

    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Tabs                                                                */
  /* ------------------------------------------------------------------ */

  function renderTabsView(settings) {
    const tabs = state.data.tabs;
    const query = state.tabQuery.trim().toLowerCase();
    let list = tabs.filter((tab) => {
      if (!query) return true;
      return `${tab.title || ""} ${tab.channel || ""} ${tab.url || ""}`.toLowerCase().includes(query);
    });

    if (state.tabSort === "lastActive") {
      list = list.sort((a, b) => a.lastActive - b.lastActive);
    } else if (state.tabSort === "title") {
      list = list.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
    } else {
      list = list.sort((a, b) => (Number(b.memoryMB) || 0) - (Number(a.memoryMB) || 0));
    }

    const closeAll = els.tabsCloseAll;
    closeAll.disabled = tabs.length === 0 || state.busy;
    closeAll.innerHTML = `${ui.icon("bookmarkCheck", 14)} Save &amp; close all${tabs.length ? ` (${tabs.length})` : ""}`;

    if (!tabs.length) {
      els.tabsTable.innerHTML = `
        <div class="table-empty">
          <strong>No YouTube tabs open</strong>
          <p>Open a video on YouTube, then refresh this page to see its memory reading.</p>
        </div>`;
      return;
    }
    if (!list.length) {
      els.tabsTable.innerHTML = `
        <div class="table-empty">
          <strong>No matching tabs</strong>
          <p>Try a different search term.</p>
        </div>`;
      return;
    }

    const maxMemory = Math.max(1, ...list.map((tab) => Number(tab.memoryMB) || 0));
    els.tabsTable.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col">YouTube tab</th>
            <th scope="col">Status</th>
            <th scope="col">Memory</th>
            <th scope="col">Last active</th>
            <th scope="col" style="text-align:right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((tab) => {
            const status = tab.active
              ? { label: "Current", cls: "current" }
              : tab.playing
                ? { label: "Playing", cls: "playing" }
                : tab.discarded
                  ? { label: "Sleeping", cls: "sleeping" }
                  : tab.videoId
                    ? { label: "Paused", cls: "" }
                    : { label: "YouTube page", cls: "" };
            const width = Math.max(3, Math.round(((Number(tab.memoryMB) || 0) / maxMemory) * 100));
            const detail = [];
            if (tab.channel) detail.push(tab.channel);
            if (tab.videoId && tab.position > 0) {
              detail.push(`At ${ui.formatDuration(tab.position)}${tab.duration ? ` / ${ui.formatDuration(tab.duration)}` : ""}`);
            } else if (tab.discarded) {
              detail.push("Discarded by the browser");
            }
            return `
              <tr data-tab-id="${tab.tabId}">
                <td>
                  <div class="cell-tab">
                    ${ui.thumbMarkup(tab.videoId, tab.duration, tab.position)}
                    <div class="cell-title">
                      <strong title="${ui.esc(tab.title)}">${ui.esc(tab.title || "YouTube tab")}</strong>
                      <span>${ui.esc(detail.join(" · ") || tab.url || "YouTube")}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="tag-row">
                    <span class="status-badge ${status.cls}">${ui.esc(status.label)}</span>
                    ${tab.pinned ? `<span class="status-badge" title="Pinned tab">${ui.icon("pin", 9)} Pinned</span>` : ""}
                    ${tab.audible ? `<span class="status-badge" title="Playing audio">${ui.icon("volume", 9)} Audio</span>` : ""}
                  </div>
                </td>
                <td>
                  <div class="cell-memory">
                    <div class="memory-cell-value" title="${tab.memorySource === "process" ? "Measured renderer memory" : "Estimated from player and page signals"}">${ui.esc(ui.formatMemory(tab.memoryMB))}</div>
                    <div class="memory-cell-bar"><span style="width:${width}%"></span></div>
                  </div>
                </td>
                <td title="${ui.esc(ui.formatDate(tab.lastActive))}">${ui.esc(ui.formatRelative(tab.lastActive))}</td>
                <td>
                  <div class="table-actions">
                    <button class="icon-btn" type="button" data-action="focus-tab" data-tab-id="${tab.tabId}" title="Switch to this tab" aria-label="Switch to ${ui.esc(tab.title)}">${ui.icon("arrowRight", 14)}</button>
                    <button class="icon-btn" type="button" data-action="save-close-tab" data-tab-id="${tab.tabId}" title="Save playback position and close" aria-label="Save and close ${ui.esc(tab.title)}">${ui.icon("bookmarkCheck", 14)}</button>
                    <button class="icon-btn danger" type="button" data-action="close-tab" data-tab-id="${tab.tabId}" title="Close this tab" aria-label="Close ${ui.esc(tab.title)}">${ui.icon("x", 14)}</button>
                  </div>
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>`;
    hydrateIcons(els.tabsTable);
  }

  /* ------------------------------------------------------------------ */
  /* Saved                                                               */
  /* ------------------------------------------------------------------ */

  function renderSavedView() {
    const all = state.data.saved;
    const query = state.savedQuery.trim().toLowerCase();
    let list = all.filter((item) => {
      if (!query) return true;
      return `${item.title || ""} ${item.channel || ""}`.toLowerCase().includes(query);
    });
    if (state.savedSort === "position") {
      list = list.sort((a, b) => (Number(b.position) || 0) - (Number(a.position) || 0));
    } else if (state.savedSort === "title") {
      list = list.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
    } else {
      list = list.sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));
    }

    els.savedClear.disabled = all.length === 0;

    if (!all.length) {
      els.savedGrid.innerHTML = `
        <div class="empty" style="grid-column:1/-1">
          <div class="empty-icon">${ui.icon("bookmark", 20)}</div>
          <strong>No saved videos yet</strong>
          <p>Close a YouTube tab with TabYT, or use “Save &amp; close”, and the title plus playback position will wait here.</p>
        </div>`;
      return;
    }
    if (!list.length) {
      els.savedGrid.innerHTML = `
        <div class="empty" style="grid-column:1/-1">
          <div class="empty-icon">${ui.icon("search", 20)}</div>
          <strong>No matching saved videos</strong>
          <p>Try a different search term.</p>
        </div>`;
      return;
    }

    els.savedGrid.innerHTML = list.map((item) => {
      const hue = C.hashHue(item.videoId || item.title || "youtube");
      const position = Number(item.position) || 0;
      const duration = Number(item.duration) || 0;
      const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : position > 0 ? 100 : 0;
      const coverTime = position > 5 ? ui.formatDuration(position) : duration > 0 ? ui.formatDuration(duration) : "";
      return `
        <article class="card saved-card" data-video-id="${ui.esc(item.videoId)}">
          <div class="saved-cover" role="button" tabindex="0" data-action="restore" data-video-id="${ui.esc(item.videoId)}" aria-label="Resume ${ui.esc(item.title)}" style="--hue:${hue}">
            <span class="cover-saved">${ui.esc(C.reasonLabel(item.reason))}</span>
            <span class="cover-play">${ui.icon("play", 18)}</span>
            ${coverTime ? `<span class="cover-time">${ui.esc(coverTime)}</span>` : ""}
          </div>
          <div class="saved-card-body">
            <div class="saved-card-title" title="${ui.esc(item.title)}">${ui.esc(item.title || "YouTube video")}</div>
            <div class="saved-card-channel">${ui.esc(item.channel || (item.videoId ? `youtube.com/watch?v=${item.videoId}` : "YouTube"))}</div>
            <div class="saved-card-meta">
              <span>${ui.esc(ui.formatRelative(item.savedAt))}</span>
              ${item.timesSaved > 1 ? `<span>· saved ${item.timesSaved}×</span>` : ""}
              ${item.isLive ? "<span>· live</span>" : ""}
            </div>
            <div class="saved-position">
              <div class="progress thin"><span style="width:${pct}%"></span></div>
              <span>${position >= 5 ? `Resume at ${ui.esc(ui.formatDuration(position))}` : "From start"}</span>
            </div>
            <div class="saved-card-actions">
              <button class="btn btn-primary btn-sm" type="button" data-action="restore" data-video-id="${ui.esc(item.videoId)}">${ui.icon("restore", 13)} Resume</button>
              <button class="icon-btn danger" type="button" data-action="delete-saved" data-video-id="${ui.esc(item.videoId)}" title="Remove from saved videos" aria-label="Remove ${ui.esc(item.title)}">${ui.icon("trash", 14)}</button>
            </div>
          </div>
        </article>`;
    }).join("");
    hydrateIcons(els.savedGrid);
  }

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  function renderHistoryView() {
    const info = state.historyInfo;
    els.historySampleInfo.textContent = `Samples every ${info.sampleMinutes} min`;
    els.retentionNote.textContent = `${info.retentionDays} day${Number(info.retentionDays) === 1 ? "" : "s"}`;
    $$("[data-range]", els.historyRange).forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.range === state.range ? "true" : "false");
    });

    const samples = samplesInRange();
    const summary = C.summarizeHistory(samples);
    els.historyPeak.textContent = samples.length ? ui.formatMemory(summary.peakMB) : "—";
    els.historyAverage.textContent = samples.length ? ui.formatMemory(summary.avgMB) : "—";
    els.historyCount.textContent = String(samples.length);

    let rangeLabel = "No samples yet";
    if (samples.length) {
      const spans = { "24h": "24 hours", "7d": "7 days", all: "all time" };
      rangeLabel = `${spans[state.range]} · ${ui.formatRelative(summary.firstAt)} to ${ui.formatRelative(summary.lastAt)}`;
    }
    els.historyRangeNote.textContent = rangeLabel;

    renderFullChart(samples);
    renderOffenders(samples);
    renderSamplesTable(samples);
  }

  function renderOffenders(samples) {
    const rows = C.topOffenders(samples, 8);
    if (!rows.length) {
      els.offendersTable.innerHTML = `
        <div class="table-empty">
          <strong>No readings yet</strong>
          <p>TabYT needs a few samples before it can rank heavy tabs.</p>
        </div>`;
      return;
    }
    els.offendersTable.innerHTML = `
      <table class="data-table">
        <thead>
          <tr><th scope="col">Video</th><th scope="col">Average</th><th scope="col">Peak</th><th scope="col">Seen</th></tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>
                <div class="offender-title">
                  <strong title="${ui.esc(row.title)}">${ui.esc(row.title || "YouTube tab")}</strong>
                  <span>${row.videoId ? ui.esc(row.videoId) : "Untitled tab"}</span>
                </div>
              </td>
              <td><span class="avg-badge">${ui.esc(ui.formatMemory(row.avgMB))}</span></td>
              <td>${ui.esc(ui.formatMemory(row.peakMB))}</td>
              <td>${row.appearances} sample${row.appearances === 1 ? "" : "s"}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function renderSamplesTable(samples) {
    const rows = samples.slice(-12).reverse();
    if (!rows.length) {
      els.samplesTable.innerHTML = `
        <div class="table-empty">
          <strong>No readings yet</strong>
          <p>The first sample appears shortly after the extension starts.</p>
        </div>`;
      return;
    }
    els.samplesTable.innerHTML = `
      <table class="data-table">
        <thead>
          <tr><th scope="col">When</th><th scope="col">Tabs</th><th scope="col">Memory</th><th scope="col">Source</th></tr>
        </thead>
        <tbody>
          ${rows.map((sample) => `
            <tr>
              <td title="${ui.esc(ui.formatDate(sample.t))}">${ui.esc(ui.formatRelative(sample.t))}</td>
              <td>${Number(sample.count) || 0}</td>
              <td>${ui.esc(ui.formatMemory(sample.total))}</td>
              <td>${sample.precise ? "Measured" : "Estimated"}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */

  function renderSettingsView(settings) {
    const caps = state.data.capabilities || {};
    els.limitBadge.textContent = settings.memoryLimitMB > 0 ? ui.formatMemory(settings.memoryLimitMB) : "Off";
    els.autoCloseBadge.textContent = settings.autoClose ? "On" : "Off";
    els.autoCloseBadge.className = `badge ${settings.autoClose ? "badge-success" : ""}`;
    if (els.layoutBadge) {
      els.layoutBadge.textContent = settings.layoutEnabled ? "On" : "Off";
      els.layoutBadge.className = `badge ${settings.layoutEnabled ? "badge-success" : ""}`;
    }

    els.storageSaved.textContent = String(state.data.saved.length);
    els.storageHistory.textContent = String(state.samples.length);
    els.storageLimit.textContent = settings.memoryLimitMB > 0 ? ui.formatMemory(settings.memoryLimitMB) : "Off";

    els.preciseBadge.textContent = caps.canUsePrecise ? "Measured" : "Estimated";
    els.preciseBadge.className = `badge ${caps.canUsePrecise ? "badge-success" : ""}`;

    if (!caps.preciseApi) {
      els.preciseButton.hidden = true;
      els.preciseButton.disabled = true;
      els.preciseDescription.textContent = "This browser does not expose the Processes API to extensions, so TabYT uses estimates.";
      els.preciseNote.textContent = "Browsers do not expose exact per-tab memory to extensions. TabYT estimates memory from video quality, playback, buffered media and page complexity.";
    } else if (caps.canUsePrecise) {
      els.preciseButton.hidden = false;
      els.preciseButton.disabled = false;
      els.preciseButton.textContent = "Disable";
      els.preciseDescription.textContent = "Measured renderer memory is active. Readings come from the browser's process information.";
      els.preciseNote.textContent = "TabYT is using measured process memory where the browser reports it, and estimates for tabs it cannot map.";
    } else {
      els.preciseButton.hidden = false;
      els.preciseButton.disabled = false;
      els.preciseButton.textContent = "Enable";
      els.preciseDescription.textContent = "Chrome builds that expose the Processes API can use measured renderer memory instead of estimates.";
      els.preciseNote.textContent = "Browsers do not expose exact per-tab memory to extensions. TabYT estimates memory from video quality, playback, buffered media and page complexity.";
    }
  }

  function applySettingsToControls() {
    if (!state.data) return;
    const settings = state.data.settings;
    state.applyingSettings = true;
    $$("[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      if (!Object.prototype.hasOwnProperty.call(settings, key)) return;
      if (input.type === "checkbox") input.checked = !!settings[key];
      else input.value = String(settings[key]);
    });
    state.applyingSettings = false;
  }

  function updateLimitBadge() {
    if (!state.data) return;
    const value = state.data.settings.memoryLimitMB;
    if (els.limitBadge) els.limitBadge.textContent = value > 0 ? ui.formatMemory(value) : "Off";
  }

  function showSettingsStatus() {
    if (!els.settingsStatus) return;
    els.settingsStatus.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      els.settingsStatus.hidden = true;
    }, 1600);
  }

  function queueSetting(key, value) {
    pendingSettings[key] = value;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => flushSettings(), 420);
  }

  async function flushSettings() {
    const patch = pendingSettings;
    pendingSettings = {};
    if (!patch || !Object.keys(patch).length) return;
    try {
      const response = await ui.send("UPDATE_SETTINGS", { patch });
      state.data.settings = response.settings;
      if (state.data.capabilities && response.capabilities) state.data.capabilities = response.capabilities;
      showSettingsStatus();
      if (response.errors && response.errors.length) {
        ui.toast(response.errors.join(". "), "warning");
      }
      /*
       * A newer change may have arrived while this request was in flight.
       * Leave its controls alone and let the next flush apply the merged
       * settings returned by the background.
       */
      if (!Object.keys(pendingSettings).length) {
        applySettingsToControls();
        updateLimitBadge();
        renderSettingsView(state.data.settings);
        renderOverview(state.data.settings);
        renderWelcome(state.data.settings);
      }
    } catch (error) {
      ui.toast(error.message, "error");
      applySettingsToControls();
    }
  }

  async function saveSetting(key, rawValue) {
    if (state.applyingSettings || !state.data) return;
    const input = $$("[data-setting]").find((el) => el.dataset.setting === key);
    let value = rawValue;
    if (input && input.type === "checkbox") value = !!input.checked;
    else if (NUMERIC_SETTINGS.has(key)) {
      value = Number(rawValue);
      if (!Number.isFinite(value)) {
        applySettingsToControls();
        return;
      }
    }
    if (key === "autoClose") {
      els.autoCloseBadge.textContent = value ? "On" : "Off";
      els.autoCloseBadge.className = `badge ${value ? "badge-success" : ""}`;
    }
    if (key === "memoryLimitMB" && els.limitBadge) {
      els.limitBadge.textContent = Number(value) > 0 ? ui.formatMemory(value) : "Off";
    }
    queueSetting(key, value);
  }

  function setPreset(key, value) {
    const input = $$("[data-setting]").find((el) => el.dataset.setting === key);
    if (input) input.value = String(value);
    if (state.data) state.data.settings[key] = Number(value);
    queueSetting(key, Number(value));
    updateLimitBadge();
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  function setLoading(active) {
    state.loading = active;
    if (els.globalRefresh) {
      els.globalRefresh.classList.toggle("spinning", active);
      els.globalRefresh.disabled = active;
    }
    if (els.tabsRefresh) els.tabsRefresh.disabled = active;
  }

  function showError(message) {
    state.lastError = message;
    els.topError.hidden = false;
    els.topErrorText.textContent = message;
    if (!state.data) {
      els.memoryPillText.textContent = "Could not read tabs";
    }
  }

  function clearError() {
    state.lastError = null;
    if (els.topError) els.topError.hidden = true;
  }

  async function loadAll(force) {
    const sequence = ++loadSequence;
    setLoading(true);
    try {
      const overview = await ui.send("GET_OVERVIEW", { force: force !== false });
      if (sequence !== loadSequence) return;
      const history = await ui.send("GET_HISTORY");
      if (sequence !== loadSequence) return;
      state.data = overview.state;
      state.samples = Array.isArray(history.samples) ? history.samples : [];
      state.historyInfo = {
        retentionDays: history.retentionDays || 7,
        sampleMinutes: history.sampleMinutes || 10
      };
      clearError();
      applySettingsToControls();
      render();
    } catch (error) {
      if (sequence !== loadSequence) return;
      showError(error.message);
      if (!state.data) renderNoData();
    } finally {
      if (sequence === loadSequence) setLoading(false);
    }
  }

  function renderNoData() {
    els.statTabs.textContent = "—";
    els.statMemory.textContent = "—";
    els.statSaved.textContent = "—";
    els.largestList.innerHTML = '<div class="mini-empty">Could not read your YouTube tabs. Try the Retry button above.</div>';
    els.recentSaved.innerHTML = '<div class="mini-empty">Could not load saved videos.</div>';
  }

  async function closeAllTabs() {
    if (state.busy || !state.data || !state.data.tabs.length) return;
    const count = state.data.tabs.length;
    if (state.data.settings.askBeforeCloseAll) {
      const confirmed = await ui.confirmDialog({
        title: `Close ${count} YouTube tab${count === 1 ? "" : "s"}?`,
        message: "TabYT will save each video's title and playback position first. You can resume every video from Saved videos.",
        confirmLabel: "Save & close all",
        danger: true
      });
      if (!confirmed) return;
    }
    state.busy = true;
    els.tabsCloseAll.disabled = true;
    els.tabsCloseAll.innerHTML = '<span class="spinner"></span> Closing…';
    try {
      const response = await ui.send("CLOSE_ALL", { forceSave: true, reason: "close-all" });
      ui.toast(
        `Closed ${response.closed} tab${response.closed === 1 ? "" : "s"}${response.saved ? ` · ${response.saved} position${response.saved === 1 ? "" : "s"} saved` : ""}.`,
        "success"
      );
      await loadAll(true);
    } catch (error) {
      ui.toast(error.message, "error");
    } finally {
      state.busy = false;
      if (state.data) renderTabsView(state.data.settings);
      else els.tabsCloseAll.disabled = true;
    }
  }

  async function closeTab(tabId, forceSave, reason) {
    if (!state.data) return;
    const tab = state.data.tabs.find((item) => item.tabId === tabId);
    if (!tab) return;
    try {
      const response = await ui.send("CLOSE_TAB", { tabId, forceSave: !!forceSave, reason });
      if (response.saved) ui.toast("Tab closed · playback position saved.", "success");
      else ui.toast("Tab closed.", "success");
      await loadAll(true);
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function focusTab(tabId) {
    try {
      await ui.send("FOCUS_TAB", { tabId });
      ui.toast("Switched to the YouTube tab.", "success");
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function restoreVideo(videoId) {
    const entry = state.data && state.data.saved.find((item) => item.videoId === videoId);
    if (!entry) return;
    try {
      const response = await ui.send("RESTORE_VIDEO", { videoId });
      if (response.result && response.result.reused) {
        ui.toast("Switched to the open tab and restored the position.", "success");
      } else {
        ui.toast(
          Number(entry.position) >= 5
            ? `Opening video at ${ui.formatDuration(entry.position)}.`
            : "Opening video from the start.",
          "success"
        );
      }
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function deleteSaved(videoId) {
    try {
      await ui.send("DELETE_SAVED", { videoId });
      ui.toast("Removed from saved videos.", "success");
      await loadAll(false);
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function clearSaved() {
    const count = state.data ? state.data.saved.length : 0;
    if (!count) return;
    const confirmed = await ui.confirmDialog({
      title: "Clear all saved videos?",
      message: `This removes all ${count} saved titles and playback positions. It cannot be undone.`,
      confirmLabel: "Clear saved videos",
      danger: true
    });
    if (!confirmed) return;
    try {
      await ui.send("CLEAR_SAVED");
      ui.toast("Saved videos cleared.", "success");
      await loadAll(false);
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function clearYouTubeCache() {
    const confirmed = await ui.confirmDialog({
      title: "Clear YouTube cache?",
      message: "This removes YouTube’s browser cache and Cache Storage, then reloads the open YouTube tab. Cookies are kept, so you stay signed in.",
      confirmLabel: "Clear cache"
    });
    if (!confirmed) return;
    try {
      const response = await ui.send("CLEAR_YOUTUBE_CACHE");
      const reloaded = response.result && response.result.reloaded;
      ui.toast(reloaded ? "YouTube cache cleared. The page is reloading." : "YouTube cache cleared. Open a YouTube tab to load it fresh.", "success");
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function clearHistory() {
    const confirmed = await ui.confirmDialog({
      title: "Clear memory history?",
      message: "This removes every recorded memory sample and resets the peak reading. Saved videos are not affected.",
      confirmLabel: "Clear history",
      danger: true
    });
    if (!confirmed) return;
    try {
      await ui.send("CLEAR_HISTORY");
      ui.toast("Memory history cleared.", "success");
      await loadAll(false);
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function resetSettings() {
    const confirmed = await ui.confirmDialog({
      title: "Reset all settings?",
      message: "Settings return to their defaults. Saved videos and memory history stay on this device.",
      confirmLabel: "Reset settings",
      danger: true
    });
    if (!confirmed) return;
    try {
      await ui.send("RESET_DATA", { scope: "settings" });
      ui.toast("Settings reset to defaults.", "success");
      await loadAll(false);
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function deleteAllData() {
    const confirmed = await ui.confirmDialog({
      title: "Delete all local data?",
      message: "This removes TabYT settings, saved videos and memory history from this browser. It cannot be undone. Export a copy first if you want a backup.",
      confirmLabel: "Delete all data",
      danger: true
    });
    if (!confirmed) return;
    try {
      await ui.send("RESET_DATA", { scope: "all" });
      ui.toast("All local TabYT data deleted.", "success");
      await loadAll(false);
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function exportData() {
    try {
      const response = await ui.send("EXPORT_DATA");
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      anchor.href = url;
      anchor.download = `tabyt-export-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      ui.toast("Export downloaded.", "success");
    } catch (error) {
      ui.toast(error.message, "error");
    }
  }

  async function togglePrecise() {
    if (!state.data || !state.data.capabilities) return;
    const caps = state.data.capabilities;
    if (!caps.preciseApi || !ext.permissions) {
      ui.toast("Measured memory is not available in this browser.", "warning");
      return;
    }
    try {
      if (caps.canUsePrecise) {
        await ext.permissions.remove({ permissions: ["processes"] });
        ui.toast("Switched back to estimated readings.", "success");
      } else {
        const granted = await ext.permissions.request({ permissions: ["processes"] });
        if (!granted) {
          ui.toast("Permission was not granted. Estimates remain active.", "warning");
          return;
        }
        ui.toast("Measured memory enabled.", "success");
      }
      const response = await ui.send("GET_CAPABILITIES");
      state.data.capabilities = response.capabilities;
      renderSettingsView(state.data.settings);
      await loadAll(true);
    } catch (error) {
      ui.toast(error.message || "The browser did not allow that permission.", "error");
    }
  }

  async function markOnboarded() {
    els.welcomeSlot.innerHTML = "";
    if (!state.data) return;
    state.data.settings.onboarded = true;
    try {
      await ui.send("UPDATE_SETTINGS", { patch: { onboarded: true } });
    } catch (_error) {
      /* Hiding the banner is enough; it will show again if saving failed. */
    }
  }

  function handleAction(actionEl, action) {
    const tabId = Number(actionEl.dataset.tabId);
    const videoId = actionEl.dataset.videoId;
    if (action === "refresh") {
      loadAll(true);
      return true;
    }
    if (action === "close-all") {
      closeAllTabs();
      return true;
    }
    if (action === "focus-tab" && Number.isFinite(tabId)) {
      focusTab(tabId);
      return true;
    }
    if (action === "close-tab" && Number.isFinite(tabId)) {
      closeTab(tabId, false, "manual");
      return true;
    }
    if (action === "save-close-tab" && Number.isFinite(tabId)) {
      closeTab(tabId, true, "save-close");
      return true;
    }
    if (action === "restore" && videoId) {
      restoreVideo(videoId);
      return true;
    }
    if (action === "delete-saved" && videoId) {
      deleteSaved(videoId);
      return true;
    }
    if (action === "clear-saved") {
      clearSaved();
      return true;
    }
    if (action === "clear-history") {
      clearHistory();
      return true;
    }
    if (action === "clear-youtube-cache") {
      clearYouTubeCache();
      return true;
    }
    if (action === "export") {
      exportData();
      return true;
    }
    if (action === "reset-settings") {
      resetSettings();
      return true;
    }
    if (action === "delete-all") {
      deleteAllData();
      return true;
    }
    if (action === "welcome-done") {
      markOnboarded();
      return true;
    }
    if (action === "toggle-precise") {
      togglePrecise();
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Binding                                                             */
  /* ------------------------------------------------------------------ */

  function bind() {
    document.addEventListener("click", (event) => {
      const routeEl = event.target.closest("[data-route]");
      if (routeEl) {
        event.preventDefault();
        navigate(routeEl.dataset.route);
        return;
      }
      const actionEl = event.target.closest("[data-action]");
      if (actionEl && handleAction(actionEl, actionEl.dataset.action)) {
        event.preventDefault();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const cover = event.target.closest(".saved-cover[data-action]");
      if (cover) {
        event.preventDefault();
        restoreVideo(cover.dataset.videoId);
      }
    });

    window.addEventListener("hashchange", () => {
      if (readRoute() !== state.route) renderRoute();
    });

    els.globalRefresh.addEventListener("click", () => loadAll(true));
    els.topErrorRetry.addEventListener("click", () => loadAll(true));
    els.tabsRefresh.addEventListener("click", () => loadAll(true));
    els.tabsCloseAll.addEventListener("click", closeAllTabs);
    els.historyClear.addEventListener("click", clearHistory);
    els.savedClear.addEventListener("click", clearSaved);
    els.preciseButton.addEventListener("click", togglePrecise);

    els.tabSearch.addEventListener("input", ui.debounce(() => {
      state.tabQuery = els.tabSearch.value;
      renderTabsView();
    }, 120));
    els.tabSort.addEventListener("change", () => {
      state.tabSort = els.tabSort.value;
      renderTabsView();
    });
    els.savedSearch.addEventListener("input", ui.debounce(() => {
      state.savedQuery = els.savedSearch.value;
      renderSavedView();
    }, 120));
    els.savedSort.addEventListener("change", () => {
      state.savedSort = els.savedSort.value;
      renderSavedView();
    });

    els.historyRange.addEventListener("click", (event) => {
      const button = event.target.closest("[data-range]");
      if (!button) return;
      state.range = button.dataset.range;
      renderHistoryView();
    });

    $$("[data-setting]").forEach((input) => {
      input.addEventListener("change", () => {
        if (state.applyingSettings) return;
        const key = input.dataset.setting;
        const value = input.type === "checkbox" ? input.checked : input.value;
        saveSetting(key, value);
      });
    });

    $$("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        setPreset(button.dataset.preset, Number(button.dataset.value));
      });
    });

    const refresh = ui.debounce(() => {
      if (Object.keys(pendingSettings).length) return;
      if (!state.busy && !document.hidden) loadAll(false);
    }, 500);
    ui.onBackgroundChange(refresh);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !state.busy) loadAll(false);
    });

    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.data) return;
        if (state.route === "overview") renderSparkline();
        if (state.route === "history") renderHistoryView();
      }, 220);
    });

    setInterval(() => {
      if (document.hidden || state.busy || state.loading) return;
      if (state.route === "overview" || state.route === "tabs" || state.route === "history") {
        loadAll(false);
      }
    }, 30000);
  }

  function boot() {
    cacheElements();
    hydrateIcons(document);
    bind();
    state.route = readRoute();
    renderRoute();
    loadAll(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
