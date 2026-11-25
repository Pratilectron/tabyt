(() => {
  "use strict";

  const ui = globalThis.TabYTUI;
  const C = ui.core;
  const $ = ui.$;
  const state = {
    data: null,
    panel: "tabs",
    loading: false,
    busy: false,
    lastError: null
  };
  let loadSequence = 0;
  let refreshTimer = null;

  const els = {
    monitorText: $("#monitor-text"),
    monitorPill: $("#monitor-pill"),
    errorBanner: $("#error-banner"),
    errorText: $("#error-text"),
    errorRetry: $("#error-retry"),
    memoryTotal: $("#memory-total"),
    sourceBadge: $("#source-badge"),
    statusLine: $("#status-line"),
    memoryRing: $("#memory-ring"),
    ringValue: $("#ring-value"),
    ringLabel: $("#ring-label"),
    statusCard: $("#status-card"),
    progress: $("#status-progress"),
    progressFill: $("#status-progress-fill"),
    tabCount: $("#tab-count"),
    limitLabel: $("#limit-label"),
    closeAll: $("#close-all"),
    closeAllLabel: $("#close-all-label"),
    refresh: $("#refresh"),
    openSettings: $("#open-settings"),
    popupTabbar: $("#popup-tabbar"),
    tabsCount: $("#tabs-count"),
    savedCount: $("#saved-count"),
    tabList: $("#tab-list"),
    tabsEmpty: $("#tabs-empty"),
    savedList: $("#saved-list"),
    savedEmpty: $("#saved-empty"),
    savedFoot: $("#saved-foot"),
    helpAutoClose: $("#help-auto-close"),
    helpVersion: $("#help-version"),
    openDashboard: $("#open-dashboard"),
    confirmDialog: $("#confirm-dialog")
  };

  function hydrateIcons(root) {
    ui.$$("[data-icon]", root || document).forEach((el) => {
      el.innerHTML = ui.icon(el.dataset.icon, Number(el.dataset.size) || 15);
    });
  }

  function showSkeleton() {
    if (!els.tabList) return;
    els.tabList.innerHTML = Array.from({ length: 3 }).map(() => `
      <div class="tab-item" aria-hidden="true">
        <span class="skeleton" style="width:58px;height:34px;border-radius:6px;flex:0 0 auto"></span>
        <span style="flex:1;display:flex;flex-direction:column;gap:6px">
          <span class="skeleton" style="width:78%;height:11px"></span>
          <span class="skeleton" style="width:48%;height:9px"></span>
        </span>
      </div>`).join("");
    els.tabsEmpty.hidden = true;
  }

  function showError(message) {
    state.lastError = message;
    els.errorBanner.hidden = false;
    els.errorText.textContent = message;
    if (!state.data) {
      els.statusLine.textContent = "Could not read your YouTube tabs.";
      els.memoryTotal.textContent = "—";
      els.closeAll.disabled = true;
    }
  }

  function clearError() {
    state.lastError = null;
    els.errorBanner.hidden = true;
  }

  function setRefreshing(active) {
    els.refresh.classList.toggle("spinning", active);
    els.refresh.disabled = active;
  }

  async function load(force) {
    const sequence = ++loadSequence;
    state.loading = true;
    setRefreshing(true);
    try {
      const response = await ui.send("GET_OVERVIEW", { force: force !== false });
      if (sequence !== loadSequence) return;
      state.data = response.state;
      clearError();
      render();
    } catch (error) {
      if (sequence !== loadSequence) return;
      showError(error.message);
      if (!state.data) renderNoData();
    } finally {
      if (sequence === loadSequence) {
        state.loading = false;
        setRefreshing(false);
      }
    }
  }

  function renderNoData() {
    els.tabsCount.textContent = "0";
    els.savedCount.textContent = "0";
    els.tabCount.textContent = "0 tabs · 0 YouTube";
    els.statusLine.textContent = "Could not read your YouTube tabs.";
    els.closeAll.disabled = true;
  }

  function render() {
    if (!state.data) return;
    const { tabs, totals, settings, saved, capabilities, stats } = state.data;
    const tone = ui.toneForMemory(totals.memoryMB, totals.limitMB);
    const count = tabs.length;
    const browserCount = Number(totals.browserTabCount) || 0;
    const browserName = ui.browserLabel(capabilities.browser);
    const limit = Number(totals.limitMB) || 0;
    const pct = limit > 0 ? Math.min(100, Number(totals.percent) || 0) : 0;
    const ringPct = limit > 0 ? pct : count > 0 ? 100 : 0;
    const displayPct = limit > 0 ? Math.round(Number(totals.percent) || 0) : count;

    els.statusCard.dataset.tone = tone === "normal" ? "" : tone;
    els.memoryRing.dataset.tone = tone === "normal" ? "" : tone;
    els.memoryRing.style.setProperty("--pct", String(ringPct));
    els.ringValue.textContent = String(displayPct);
    els.ringLabel.textContent = limit > 0 ? "of limit" : "tabs";

    els.memoryTotal.textContent = ui.formatMemory(totals.memoryMB);
    const source = ui.describeSource(totals);
    els.sourceBadge.textContent = source;
    els.sourceBadge.className = `badge ${totals.source === "process" ? "badge-success" : totals.preciseCount > 0 ? "badge-info" : ""}`;
    els.sourceBadge.title = totals.source === "process"
      ? "Measured with the browser process API."
      : "Estimated from video quality, playback, buffered media and page complexity. Browsers do not expose exact per-tab memory to extensions.";

    if (limit > 0 && totals.overLimit) {
      els.statusLine.textContent = `Over your limit by ${ui.formatMemory(totals.memoryMB - limit)}. Close a tab or raise the limit.`;
    } else if (count) {
      els.statusLine.textContent = `${count} YouTube tab${count === 1 ? "" : "s"} open${limit > 0 ? ` · ${Math.round(Number(totals.percent) || 0)}% of your limit` : ""}.`;
    } else {
      els.statusLine.textContent = limit > 0 ? "No YouTube tabs open. Your limit is ready when you need it." : "Open a YouTube video to start tracking memory.";
    }

    els.progressFill.style.width = `${Math.min(100, pct)}%`;
    els.progress.className = `progress ${tone === "normal" ? "" : tone}`;
    els.tabCount.textContent = `${browserCount} ${browserName} tab${browserCount === 1 ? "" : "s"} · ${count} YouTube`;
    els.limitLabel.textContent = limit > 0 ? `Limit ${ui.formatMemory(limit)}` : "No limit set";
    els.tabsCount.textContent = String(count);
    els.tabsCount.title = `${browserCount} open ${browserName} tabs; ${count} YouTube tabs listed below`;
    els.savedCount.textContent = String(saved.length);
    els.closeAll.disabled = count === 0 || state.busy;
    els.closeAllLabel.textContent = "Save & close all";

    const dot = els.monitorPill.querySelector(".dot");
    if (settings.autoClose) {
      els.monitorText.textContent = `Auto-close · ${settings.inactivityMinutes}m`;
      els.monitorPill.title = `Auto-close is on. Idle YouTube tabs close after ${settings.inactivityMinutes} minutes.`;
      dot.className = "dot live";
    } else {
      els.monitorText.textContent = "Monitoring";
      els.monitorPill.title = "TabYT is monitoring YouTube tab memory. Auto-close is off.";
      dot.className = "dot live";
    }

    els.helpAutoClose.textContent = settings.autoClose
      ? `Auto-close is on: idle YouTube tabs close after ${settings.inactivityMinutes} minutes.${settings.skipPinned ? " Pinned tabs are kept." : ""}${settings.skipPlaying ? " Playing videos are kept." : ""}`
      : "Auto-close is off. Turn it on in Settings to close idle YouTube tabs after a set time.";
    els.helpVersion.textContent = `TabYT v${capabilities.version || "unknown"} · ${stats.closedTotal || 0} tabs closed since install`;

    renderTabs(tabs, settings);
    renderSaved(saved);
    document.title = count ? `TabYT — ${ui.formatMemory(totals.memoryMB)}` : "TabYT";
  }

  function renderTabs(tabs, settings) {
    const sorted = tabs.slice().sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.playing !== b.playing) return a.playing ? -1 : 1;
      return b.memoryMB - a.memoryMB;
    });

    els.tabsEmpty.hidden = sorted.length > 0;
    if (!sorted.length) {
      els.tabList.innerHTML = "";
      return;
    }

    els.tabList.innerHTML = sorted.map((tab) => {
      const status = tab.playing ? "Playing" : tab.videoId ? "Paused" : tab.discarded ? "Sleeping" : "YouTube page";
      const meta = [];
      if (tab.active) meta.push('<span class="mini-badge current">Current</span>');
      if (tab.pinned) meta.push(`<span class="mini-badge" title="Pinned tab">${ui.icon("pin", 9)} Pinned</span>`);
      if (tab.audible) meta.push(`<span class="mini-badge" title="Playing audio">${ui.icon("volume", 9)} Audio</span>`);
      const dotClass = tab.playing ? "live" : tab.discarded ? "" : "warning";
      meta.push(`<span class="mem-pill"><i class="dot ${dotClass}"></i>${ui.esc(status)}</span>`);
      if (tab.videoId && tab.position > 0) {
        meta.push(`<span class="meta-sep">${ui.esc(ui.formatDuration(tab.position))}${tab.duration ? ` / ${ui.esc(ui.formatDuration(tab.duration))}` : ""}</span>`);
      }
      meta.push(`<span class="meta-sep mem-pill" title="${tab.memorySource === "process" ? "Measured memory" : "Estimated memory"}">${ui.esc(ui.formatMemory(tab.memoryMB))}</span>`);
      meta.push(`<span class="meta-sep">${ui.esc(ui.formatRelative(tab.lastActive))}</span>`);

      return `
        <div class="tab-item${tab.active ? " is-active" : ""}" data-tab-id="${tab.tabId}">
          <button class="tab-open" type="button" data-action="focus" title="Switch to this tab">
            ${ui.thumbMarkup(tab.videoId, tab.duration, tab.position)}
            <span class="tab-copy">
              <span class="tab-title">${ui.esc(tab.title || "YouTube tab")}</span>
              <span class="tab-meta">${meta.join("")}</span>
            </span>
          </button>
          <span class="row-actions">
            <button class="icon-btn save" type="button" data-action="save-close" title="Save playback position and close this tab" aria-label="Save and close ${ui.esc(tab.title)}">
              ${ui.icon("bookmarkCheck", 14)}
            </button>
            <button class="icon-btn danger" type="button" data-action="close" title="Close this tab${settings.saveOnClose ? " and save playback" : ""}" aria-label="Close ${ui.esc(tab.title)}">
              ${ui.icon("x", 14)}
            </button>
          </span>
        </div>`;
    }).join("");
  }

  function renderSaved(saved) {
    const shown = saved.slice(0, 40);
    els.savedEmpty.hidden = shown.length > 0;
    els.savedFoot.hidden = saved.length <= 8;
    if (!shown.length) {
      els.savedList.innerHTML = "";
      return;
    }
    els.savedList.innerHTML = shown.map((item) => {
      const position = Number(item.position) || 0;
      const meta = [];
      if (position >= 5) meta.push(`<span class="resume-at">Resume at ${ui.esc(ui.formatDuration(position))}</span>`);
      else meta.push('<span class="resume-at">From start</span>');
      if (item.duration) meta.push(`<span class="meta-sep">${ui.esc(ui.formatDuration(item.duration))}</span>`);
      meta.push(`<span class="meta-sep">${ui.esc(C.reasonLabel(item.reason))}</span>`);
      meta.push(`<span class="meta-sep">${ui.esc(ui.formatRelative(item.savedAt))}</span>`);
      return `
        <div class="saved-item" data-video-id="${ui.esc(item.videoId)}">
          ${ui.thumbMarkup(item.videoId, item.duration, 0)}
          <span class="saved-copy">
            <span class="saved-title">${ui.esc(item.title || "YouTube video")}</span>
            <span class="saved-meta">${meta.join("")}</span>
          </span>
          <span class="saved-actions">
            <button class="icon-btn" type="button" data-action="restore" title="Resume this video" aria-label="Resume ${ui.esc(item.title)}">
              ${ui.icon("playCircle", 15)}
            </button>
            <button class="icon-btn danger" type="button" data-action="delete-saved" title="Remove from saved videos" aria-label="Remove ${ui.esc(item.title)}">
              ${ui.icon("trash", 14)}
            </button>
          </span>
        </div>`;
    }).join("");
  }

  function setPanel(panel) {
    state.panel = panel;
    ui.$$("[data-panel]").forEach((button) => {
      const selected = button.dataset.panel === panel;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.tabIndex = selected ? 0 : -1;
    });
    ["tabs", "saved", "help"].forEach((name) => {
      const panelEl = document.getElementById(`panel-${name}`);
      if (panelEl) panelEl.hidden = name !== panel;
    });
  }

  async function closeAll() {
    if (state.busy || !state.data) return;
    const settings = state.data.settings;
    const count = state.data.tabs.length;
    if (!count) return;
    if (settings.askBeforeCloseAll) {
      const confirmed = await ui.confirmDialog({
        title: `Close ${count} YouTube tab${count === 1 ? "" : "s"}?`,
        message: "TabYT will save each video's title and playback position before closing the tabs. You can resume them from Saved.",
        confirmLabel: "Save & close all",
        danger: true
      });
      if (!confirmed) return;
    }

    state.busy = true;
    els.closeAll.disabled = true;
    ui.setBusy(els.closeAll, true, "Closing…");
    try {
      const response = await ui.send("CLOSE_ALL", { forceSave: true, reason: "close-all" });
      ui.toast(`Closed ${response.closed} tab${response.closed === 1 ? "" : "s"}${response.saved ? ` · ${response.saved} position${response.saved === 1 ? "" : "s"} saved` : ""}.`, "success");
      await load(true);
    } catch (error) {
      ui.toast(error.message, "error");
    } finally {
      state.busy = false;
      ui.setBusy(els.closeAll, false);
      if (state.data) els.closeAll.disabled = state.data.tabs.length === 0;
    }
  }

  async function handleTabAction(button, action, tab) {
    if (state.busy) return;
    if (action === "focus") {
      try {
        await ui.send("FOCUS_TAB", { tabId: tab.tabId });
        window.close();
      } catch (error) {
        ui.toast(error.message, "error");
      }
      return;
    }

    state.busy = true;
    button.disabled = true;
    try {
      if (action === "save-close") {
        const response = await ui.send("CLOSE_TAB", { tabId: tab.tabId, forceSave: true, reason: "save-close" });
        ui.toast(`Saved and closed${response.saved ? " · playback position saved" : ""}.`, "success");
      } else if (action === "close") {
        const response = await ui.send("CLOSE_TAB", { tabId: tab.tabId, forceSave: false, reason: "manual" });
        ui.toast(response.saved ? "Tab closed · playback position saved." : "Tab closed.", "success");
      }
      await load(true);
    } catch (error) {
      ui.toast(error.message, "error");
      button.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  async function handleSavedAction(button, action, videoId) {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    try {
      if (action === "restore") {
        await ui.send("RESTORE_VIDEO", { videoId });
        window.close();
      } else if (action === "delete-saved") {
        await ui.send("DELETE_SAVED", { videoId });
        ui.toast("Removed from saved videos.", "success");
        await load(true);
      }
    } catch (error) {
      ui.toast(error.message, "error");
      button.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  function bind() {
    hydrateIcons(document);
    document.addEventListener("click", async (event) => {
      const actionEl = event.target.closest("[data-action]");
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === "focus" || action === "save-close" || action === "close") {
          const row = actionEl.closest("[data-tab-id]");
          if (row && state.data) {
            const tab = state.data.tabs.find((item) => item.tabId === Number(row.dataset.tabId));
            if (tab) {
              await handleTabAction(actionEl, action, tab);
              return;
            }
          }
        }
        if (action === "restore" || action === "delete-saved") {
          const row = actionEl.closest("[data-video-id]");
          if (row) {
            await handleSavedAction(actionEl, action, row.dataset.videoId);
            return;
          }
        }
        if (action === "refresh") {
          await load(true);
          return;
        }
        if (action === "clear-youtube-cache") {
          const confirmed = await ui.confirmDialog({
            title: "Clear YouTube cache?",
            message: "This removes YouTube’s browser cache and Cache Storage, then reloads the open YouTube tab. Cookies are kept.",
            confirmLabel: "Clear cache"
          });
          if (!confirmed) return;
          try {
            const response = await ui.send("CLEAR_YOUTUBE_CACHE");
            const reloaded = response.result && response.result.reloaded;
            ui.toast(reloaded ? "YouTube cache cleared. The page is reloading." : "YouTube cache cleared.", "success");
          } catch (error) {
            ui.toast(error.message, "error");
          }
          return;
        }
        if (action === "open-settings") {
          try {
            await ui.openDashboard("settings");
          } catch (error) {
            ui.toast(error.message, "error");
          }
          return;
        }
        if (action === "open-dashboard") {
          try {
            await ui.openDashboard("overview");
          } catch (error) {
            ui.toast(error.message, "error");
          }
          return;
        }
        if (action === "open-saved-dashboard") {
          try {
            await ui.openDashboard("saved");
          } catch (error) {
            ui.toast(error.message, "error");
          }
          return;
        }
      }

      const panelButton = event.target.closest("[data-panel]");
      if (panelButton) setPanel(panelButton.dataset.panel);
    });

    els.openSettings.addEventListener("click", async () => {
      try {
        await ui.openDashboard("settings");
      } catch (error) {
        ui.toast(error.message, "error");
      }
    });

    els.openDashboard.addEventListener("click", async () => {
      try {
        await ui.openDashboard("overview");
      } catch (error) {
        ui.toast(error.message, "error");
      }
    });

    els.closeAll.addEventListener("click", closeAll);
    els.refresh.addEventListener("click", () => load(true));
    els.errorRetry.addEventListener("click", () => load(true));

    els.popupTabbar.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const buttons = ui.$$("[data-panel]", els.popupTabbar);
      const current = buttons.findIndex((button) => button.dataset.panel === state.panel);
      const next = event.key === "ArrowRight"
        ? (current + 1) % buttons.length
        : (current - 1 + buttons.length) % buttons.length;
      setPanel(buttons[next].dataset.panel);
      buttons[next].focus();
    });

    const refresh = ui.debounce(() => {
      if (!state.busy && !document.hidden) load(false);
    }, 450);
    ui.onBackgroundChange(refresh);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) load(false);
    });
  }

  function boot() {
    bind();
    showSkeleton();
    load(true);
    setInterval(() => {
      if (!document.hidden && !state.busy) load(false);
    }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
