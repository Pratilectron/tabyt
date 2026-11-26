/*
 * MAIN-world reader for the watch page's embedded JSON.
 *
 * ytInitialPlayerResponse and ytInitialData live on the page window. An
 * isolated content script cannot see them. This script reads the plain
 * fields and writes them onto the document element, which both worlds share.
 * It does not inject a remote script and it does not fetch anything.
 */
(() => {
  if (window.__tabytPageData) return;
  window.__tabytPageData = true;

  const extract = window.TabYTCore && window.TabYTCore.extractWatchMeta;
  try { delete window.TabYTCore; } catch (_error) { window.TabYTCore = undefined; }
  if (typeof extract !== "function") return;

  let lastJson = "";
  let poll = 0;
  let polls = 0;

  function publish() {
    const root = document.documentElement;
    if (!root) return;
    let json = "";
    try {
      json = JSON.stringify(extract(window.ytInitialPlayerResponse, window.ytInitialData));
    } catch (_error) {
      return;
    }
    if (!json || json === lastJson) return;
    lastJson = json;
    root.setAttribute("data-tabyt-meta", json);
  }

  function arm() {
    lastJson = "";
    publish();
    clearInterval(poll);
    polls = 0;
    poll = setInterval(() => {
      polls += 1;
      publish();
      if (polls >= 15) clearInterval(poll);
    }, 200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", arm, { once: true });
  }
  document.addEventListener("yt-navigate-finish", arm);
  document.addEventListener("yt-page-data-updated", publish);
  arm();
})();
