# Obsidian Web Extension Bridge

Desktop-only Obsidian 插件（**Phase 1 POC**）：把 unpacked Chrome/Chromium
Extension 加载进 **Obsidian Core Web Viewer 的 Electron Session**，使
content script（网页翻译、网页增强、划词工具等）作用于 Web Viewer 页面。
Media Extended v4 复用同一个 Core Web Viewer，因此扩展同样能作用于
Media Extended 打开的网页 —— 本插件不修改 Media Extended 源码。

## 原理

```text
App.getWebviewPartition()  ->  "persist:vault-<appId>"（持久化 Session）
  -> electron.remote.session.fromPartition(partition)（主进程 Session 代理）
  -> session.extensions.loadExtension(extensionPath, { allowFileAccess })
```

Obsidian 自带 `@electron/remote`（其“清除数据”对话框正是这样访问 Web Viewer
Session）。`loadExtension` 是主进程 API，这里通过 remote 代理序列化到主进程，
不是伪造 renderer 端实现。详见 `docs/poc-session-report.md`。

## 用法（POC）

1. `npm install` 然后 `npm run build`，或直接使用已构建的 `main.js`。
2. 把 `main.js`、`manifest.json`、`versions.json` 与 `test-extension/` 目录
   复制到 `<vault>/.obsidian/plugins/obsidian-web-extension-bridge/`。
3. 在 Obsidian 设置 → 社区插件 中启用本插件。
4. 设置页 → “加载测试扩展” → 首次启用会弹信任确认。
5. “运行 POC 测试”打开测试 URL，检查网页标题是否带 `[EXT-TEST]` 前缀、
   `data-obsidian-extension-test="true"`（控制台可见结构化
   `[WebExtensionBridge]` 日志）。
6. 需要完整验证时：设置页 → “运行完整验证”（默认四站点：example.com /
   google.com / youtube.com / bilibili.com）。它会按状态机记录
   Session/extensions/`<webview>.partition` 对比等运行时证据，结果写入
   `data.json` 的 `lastValidationRun`，真机记录回填见
   `docs/runtime-validation.md`。

## 日志

统一前缀 `[WebExtensionBridge]`，级别 INFO/WARN/ERROR/DEBUG（设置页开启 DEBUG）。
关键事件输出结构化 JSON：Obsidian/Electron 版本、Web Viewer 可用性、partition、
session 持久性、扩展路径、扩展 id、加载结果、warnings、失败原因。

## 兼容性说明

- 目标：Obsidian 1.13.7 / Electron 43.x（已在环境中确认运行版本 1.13.7）。
- **POC 状态：PASS**（2026-09-06 真机验证：四站点注入、`<webview>.partition`
  MATCH、同一 Session 上列出 Media Extended 与 test-extension，详见
  `docs/runtime-validation.md`）。
- 显示 “Electron Extension Compatibility”，**不承诺** 100% Chrome 扩展兼容。
- 只支持 unpacked 扩展；不支持 CRX / Chrome Web Store / identity / sidePanel。
- 不修改 Obsidian `app.asar`、不修改官方安装文件、不修改 Media Extended。
- 所有内部 API 均有 feature detect，不兼容时安全退出并提示
  “Web Extension Bridge is not compatible with this Obsidian/Electron version.”。
- “Extension Session === Web Viewer Session” 已在被测环境由真机运行时证据
  成立（详见 `docs/runtime-validation.md`），但仍限定版本：Obsidian/Electron
  升级后需重跑验证再确认。

## 授权

仅用于研究与个人使用。Chrome Extension 可执行网页脚本，启用前请确认信任来源。
