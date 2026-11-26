/*
 * Comment author names, subscriber pills and video counts.
 * The comment row only has an @handle. The public channel page has the
 * display name, subscriber count and video count. One request per channel,
 * cached for the page, with no cookies.
 */
(() => {
  if (window.__tabytAuthorsLoaded) return;
  window.__tabytAuthorsLoaded = true;

  const core = window.TabYTCore;
  const cache = new Map();
  const queue = [];
  let active = 0;

  function channelPath(href) {
    if (!href) return "";
    let path = "";
    try {
      const url = new URL(href, "https://www.youtube.com/");
      if (url.hostname !== "www.youtube.com" && url.hostname !== "youtube.com") return "";
      const parts = url.pathname.split("/").filter(Boolean);
      if (!parts.length) return "";
      if (parts[0].charAt(0) === "@" && parts[0].length > 1) path = parts[0];
      else if ((parts[0] === "channel" || parts[0] === "c" || parts[0] === "user") && parts[1]) {
        path = parts[0] + "/" + parts[1];
      }
    } catch (_error) {
      return "";
    }
    if (!path || path.indexOf("..") !== -1) return "";
    return path.split("/").map((part) => encodeURIComponent(part)).join("/");
  }

  function authorHeader(thread) {
    return thread.querySelector("#header-author") || thread.querySelector("#header");
  }

  function authorLink(header) {
    if (!header) return null;
    return header.querySelector("#author-text, a[href*='/@'], a[href*='/channel/'], a[href*='/c/'], a[href*='/user/']");
  }

  function markDone(thread) {
    thread.dataset.tabytAuthorDone = "1";
    const view = thread.matches("ytd-comment-view-model")
      ? thread
      : thread.querySelector("ytd-comment-view-model");
    if (view) view.dataset.tabytAuthorDone = "1";
  }

  function stat(value, label) {
    const el = document.createElement("span");
    el.className = "tabyt-author-stat";
    const num = document.createElement("strong");
    num.textContent = value;
    const word = document.createElement("span");
    word.textContent = label;
    el.appendChild(num);
    el.appendChild(word);
    return el;
  }

  /*
   * The username and the date stay on YouTube's own line. The counts sit on
   * the next line, labeled, so "79 | 20" is not read as part of the timestamp.
   */
  function paint(thread, stats, final) {
    const header = authorHeader(thread);
    if (!header) return;
    const subs = (stats && stats.subs) || "";
    const videos = (stats && stats.videos) || "";
    const link = authorLink(header);
    if (link && link.parentElement) link.parentElement.classList.remove("tabyt-author-swapped");
    header.classList.remove("tabyt-author-swapped");
    thread.querySelectorAll(".tabyt-author-pill").forEach((node) => node.remove());
    if (!subs && !videos) {
      if (final) markDone(thread);
      return;
    }
    const row = header.id === "header-author"
      ? header
      : (header.querySelector("#header-author") || header);
    let meta = row.querySelector(":scope > .tabyt-author-meta");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "tabyt-author-meta";
      row.appendChild(meta);
    }
    meta.textContent = "";
    if (subs) meta.appendChild(stat(subs, "subs"));
    if (subs && videos) {
      const sep = document.createElement("span");
      sep.className = "tabyt-author-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "|";
      meta.appendChild(sep);
    }
    if (videos) meta.appendChild(stat(videos, "videos"));
    meta.classList.toggle("tabyt-author-ready", Boolean(subs || videos));
    meta.setAttribute(
      "aria-label",
      [subs ? subs + " subscribers" : "", videos ? videos + " videos" : ""].filter(Boolean).join(", ")
    );
    if (final) markDone(thread);
  }

  function pump() {
    if (active || !queue.length) return;
    const job = queue.shift();
    active = 1;
    fetch("https://www.youtube.com/" + job.path + "?hl=en", { credentials: "omit" })
      .then((res) => (res.ok ? res.text() : ""))
      .then((html) => {
        const stats = core && core.parseChannelStats
          ? core.parseChannelStats(html)
          : { name: "", subs: "", videos: "" };
        cache.set(job.path, stats);
        job.threads.forEach((thread) => {
          if (thread.isConnected) paint(thread, stats, true);
        });
      })
      .catch(() => {
        const empty = { name: "", subs: "", videos: "" };
        cache.set(job.path, empty);
        job.threads.forEach((thread) => {
          if (thread.isConnected) paint(thread, empty, true);
        });
      })
      .then(() => {
        active = 0;
        pump();
      });
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document.getElementById("tabyt-rail");
    if (!scope) return;
    const threads = scope.querySelectorAll("ytd-comment-thread-renderer, ytd-comment-view-model");
    const groups = new Map();
    threads.forEach((thread) => {
      if (thread.dataset.tabytAuthorDone === "1") return;
      const link = authorLink(authorHeader(thread));
      const path = channelPath(link && (link.getAttribute("href") || link.href));
      if (!path) {
        paint(thread, null, true);
        return;
      }
      paint(thread, null, false);
      if (cache.has(path)) {
        paint(thread, cache.get(path), true);
        return;
      }
      const list = groups.get(path) || [];
      list.push(thread);
      groups.set(path, list);
    });
    let added = 0;
    groups.forEach((list, path) => {
      const pending = queue.find((job) => job.path === path);
      if (pending) {
        list.forEach((thread) => {
          if (pending.threads.indexOf(thread) === -1) pending.threads.push(thread);
        });
        return;
      }
      if (added >= 8) return;
      added += 1;
      queue.push({ path: path, threads: list });
    });
    pump();
  }

  window.TabYTAuthors = { scan: scan };
})();
