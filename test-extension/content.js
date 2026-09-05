// Minimal content script for the Obsidian Web Extension Bridge POC.
// Marks the document and prefixes the title so the bridge can verify that
// Electron actually injected the script into the Web Viewer session.
(function () {
  "use strict";
  function ensureTitle() {
    try {
      var t = document.title || "";
      if (t.indexOf("[EXT-TEST]") !== 0) {
        document.title = "[EXT-TEST] " + t;
      }
    } catch (e) {
      // 忽略 title 变更异常
    }
  }
  try {
    var root = document.documentElement;
    if (root) {
      root.setAttribute("data-obsidian-extension-test", "true");
    }
    ensureTitle();

    // 页面的 <title> 在 document_start 之后解析，可能覆盖我们先写的标题；
    // 用 MutationObserver 维持 [EXT-TEST] 前缀，保证标题证据稳定。
    if (document.documentElement && typeof MutationObserver !== "undefined") {
      new MutationObserver(ensureTitle).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    // 运行时通信证据：暴露一个可被 Web Viewer executeJavaScript 读取的标记
    window.__WEB_EXTENSION_BRIDGE_TEST__ = {
      injected: true,
      href: location.href,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent
    };

    // Session 身份辅助证据：写入页面 localStorage，再由 Web Viewer 读取。
    // 注意：这只能证明 content script 与 executeJavaScript 看到同一个页面
    // 上下文，不能单独证明整个 Electron Session 相同（辅助证据）。
    try {
      window.localStorage.setItem(
        "__web_extension_bridge_poc",
        JSON.stringify({
          injected: true,
          href: location.href,
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent
        })
      );
    } catch (e) {
      console.error("[EXT-TEST] localStorage write failed", e);
    }

    console.log("[EXT-TEST] content script injected in", location.href);
  } catch (err) {
    console.error("[EXT-TEST] content script error", err);
  }
})();
