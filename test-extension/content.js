// Minimal content script for the Obsidian Web Extension Bridge POC.
// Marks the document and prefixes the title so the bridge can verify that
// Electron actually injected the script into the Web Viewer session.
(function () {
  "use strict";
  try {
    var root = document.documentElement;
    if (root) {
      root.setAttribute("data-obsidian-extension-test", "true");
    }
    var oldTitle = document.title || "";
    if (oldTitle.indexOf("[EXT-TEST]") !== 0) {
      document.title = "[EXT-TEST] " + oldTitle;
    }
    console.log("[EXT-TEST] content script injected in", location.href);
  } catch (err) {
    console.error("[EXT-TEST] content script error", err);
  }
})();
