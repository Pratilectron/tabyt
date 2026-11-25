/* TabYT shared UI helpers. */
(function () {
  "use strict";

  const ext = globalThis.browser || globalThis.chrome;
  const core = globalThis.TabYTCore;
  const ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    playCircle: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    bookmarkCheck: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="m9 10 2 2 4-4"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.8 1c-.7 1.2-2.9 1.6-2.9 3"/><path d="M12 17h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
    restore: '<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5"/><path d="M12 8v5l3 2"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4.8l2 2.2v2H7v-2z"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    alert: '<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    google: '<path d="M20.3 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h4.7a4 4 0 0 1-1.8 2.6v2.2h2.9c1.7-1.6 2.5-3.9 2.5-6.5z"/><path d="M12 21c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.6-1.9.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H3.9v2.3A9 9 0 0 0 12 21z"/><path d="M6.9 13.7a5.4 5.4 0 0 1 0-3.4V8H3.9a9 9 0 0 0 0 8l3-2.3z"/><path d="M12 6.5c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 3.9 8l3 2.3c.7-2.2 2.7-3.8 5.1-3.8z"/>',
    firefox: '<path d="M12 22a10 10 0 1 0-8.5-15.3c1.4-1 3.1-1.3 4.7-.8-1.8.6-3.2 2.1-3.9 3.9-.7 1.8-.3 3.9.9 5.3 1.3 1.6 3.4 2.3 5.3 1.9 2.6-.6 4.2-3.2 3.6-5.8-.5-2.3-2.7-3.9-5-3.9"/><path d="M12 16.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/>'
  };

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function icon(name, size) {
    const path = ICONS[name] || ICONS.info;
    const px = Number(size) || 16;
    return `<svg class="icon" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  function brandMarkup(subtitle) {
    return `<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg></span><span class="brand-name"><strong>TabYT</strong>${subtitle === false ? "" : `<span>${subtitle || "YouTube tab memory"}</span>`}</span>`;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatMemory(mb) {
    return core ? core.formatMemory(mb) : `${Math.round(Number(mb) || 0)} MB`;
  }

  function formatDuration(seconds) {
    return core ? core.formatDuration(seconds) : "—";
  }

  function formatRelative(timestamp) {
    return core ? core.formatRelative(timestamp) : "—";
  }

  function formatDate(timestamp) {
    try {
      return new Date(timestamp).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    } catch (_error) {
      return "—";
    }
  }

  function timeLabel(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (_error) {
      return "—";
    }
  }

  function percent(value, total) {
    const t = Number(total) || 0;
    if (t <= 0) return 0;
    return Math.max(0, Math.min(999, (Number(value) / t) * 100));
  }

  function toneForMemory(total, limit) {
    if (!limit || Number(limit) <= 0) return "normal";
    if (Number(total) > Number(limit)) return "danger";
    if (Number(total) >= Number(limit) * 0.8) return "warning";
    return "normal";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  async function send(type, payload) {
    const message = Object.assign({ type }, payload || {});
    let response;
    try {
      response = await ext.runtime.sendMessage(message);
    } catch (error) {
      const text = String(error && error.message ? error.message : error);
      if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(text)) {
        throw new Error("TabYT's background worker is not responding. Reload the extension and try again.");
      }
      throw new Error(text || "TabYT could not complete that request.");
    }
    if (!response) throw new Error("TabYT did not receive a response. Try reloading the extension.");
    if (response.ok === false) throw new Error(response.error || "Something went wrong.");
    return response;
  }

  function onBackgroundChange(callback) {
    const listener = (message) => {
      if (message && message.type === "STATE_CHANGED") callback(message);
    };
    ext.runtime.onMessage.addListener(listener);
    return () => {
      try {
        ext.runtime.onMessage.removeListener(listener);
      } catch (_error) {
        /* noop */
      }
    };
  }

  function toast(message, tone) {
    let region = document.getElementById("toast-region");
    if (!region) {
      region = document.createElement("div");
      region.id = "toast-region";
      region.className = "toast-region";
      region.setAttribute("aria-live", "polite");
      document.body.appendChild(region);
    }
    const kind = tone || "default";
    const iconName = kind === "success" ? "check" : kind === "warning" ? "alert" : kind === "error" ? "alert" : "info";
    const el = document.createElement("div");
    el.className = `toast ${kind === "default" ? "" : kind}`;
    el.innerHTML = `${icon(iconName, 15)}<span></span>`;
    el.querySelector("span").textContent = message;
    region.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    }, 3600);
  }

  function confirmDialog(options) {
    const opts = options || {};
    const dialog = document.getElementById("confirm-dialog");
    const message = opts.message || "";
    if (!dialog || typeof dialog.showModal !== "function") {
      return Promise.resolve(window.confirm(message || opts.title || "Continue?"));
    }
    if (dialog.open) dialog.close();
    const titleEl = dialog.querySelector("[data-dialog-title]");
    const messageEl = dialog.querySelector("[data-dialog-message]");
    const confirmEl = dialog.querySelector("[data-dialog-confirm]");
    const cancelEl = dialog.querySelector("[data-dialog-cancel]");
    if (titleEl) titleEl.textContent = opts.title || "Are you sure?";
    if (messageEl) messageEl.textContent = message;
    if (confirmEl) {
      confirmEl.textContent = opts.confirmLabel || "Continue";
      confirmEl.className = `btn ${opts.danger ? "btn-danger" : "btn-primary"}`;
    }
    if (cancelEl) cancelEl.textContent = opts.cancelLabel || "Cancel";

    return new Promise((resolve) => {
      let settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        dialog.removeEventListener("click", onClick);
        dialog.removeEventListener("cancel", onCancel);
        dialog.close();
        resolve(result);
      }
      function onClick(event) {
        if (event.target.closest("[data-dialog-confirm]")) finish(true);
        else if (event.target.closest("[data-dialog-cancel]") || event.target === dialog) finish(false);
      }
      function onCancel(event) {
        event.preventDefault();
        finish(false);
      }
      dialog.addEventListener("click", onClick);
      dialog.addEventListener("cancel", onCancel);
      dialog.showModal();
      if (confirmEl) confirmEl.focus();
    });
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span>${label ? `<span>${esc(label)}</span>` : ""}`;
    } else {
      button.disabled = false;
      if (button.dataset.idleHtml) {
        button.innerHTML = button.dataset.idleHtml;
        delete button.dataset.idleHtml;
      }
    }
  }

  function thumbMarkup(videoId, duration, position) {
    const hue = core ? core.hashHue(videoId || "youtube") : 350;
    const label = position && Number(position) > 5 ? core.formatDuration(position) : duration ? core.formatDuration(duration) : "";
    return `<span class="video-thumb" style="--hue:${hue}" aria-hidden="true">${icon("play", 14)}${label ? `<span class="thumb-time">${esc(label)}</span>` : ""}</span>`;
  }

  function openDashboard(route) {
    return send("OPEN_DASHBOARD", route ? { route } : {}).then(() => {
      try {
        window.close();
      } catch (_error) {
        /* noop */
      }
    });
  }

  function openTab(url) {
    return ext.tabs.create({ url });
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString();
  }

  function describeSource(totals) {
    if (!totals || !totals.count) return "No YouTube tabs";
    if (totals.source === "process") return "Measured";
    if (totals.preciseCount > 0) return "Mixed readings";
    return "Estimated";
  }

  function browserLabel(value) {
    const key = String(value || "").toLowerCase();
    const labels = {
      brave: "Brave",
      chrome: "Chrome",
      firefox: "Firefox",
      edge: "Edge",
      opera: "Opera",
      vivaldi: "Vivaldi"
    };
    return labels[key] || "browser";
  }

  globalThis.TabYTUI = {
    ext,
    core,
    ICONS,
    $,
    $$,
    icon,
    brandMarkup,
    esc,
    formatMemory,
    formatDuration,
    formatRelative,
    formatDate,
    timeLabel,
    percent,
    toneForMemory,
    clamp,
    debounce,
    send,
    onBackgroundChange,
    toast,
    confirmDialog,
    setBusy,
    thumbMarkup,
    openDashboard,
    openTab,
    formatCount,
    describeSource,
    browserLabel
  };
})();
