# 架构设计 — Obsidian Web Extension Bridge

> 当前阶段：**Phase 1 POC**。本文给出正式架构蓝图，POC 成功后再进入
> Extension Manager 与真实扩展测试。

## 1. 总体目标

让 Obsidian Core Web Viewer（及 Media Extended v4 复用的同一 Web Viewer）
能加载一部分 Chrome/Chromium Extension：网页翻译、网页增强、content script、
划词工具等。Desktop only。

**约束（不允许违反）：**
- 不修改 Media Extended 源码、不 fork。
- 不修改 Obsidian `app.asar` / 官方安装文件。
- 第一方案必须是 “Core Web Viewer Session → Electron persistent Session →
  `session.extensions.loadExtension()`”，而不是另造浏览器。
- `loadExtension` 只能在主进程调用；通过 Obsidian 内置 `@electron/remote`
  把调用序列化到主进程（不伪造 renderer 实现、不依赖旧的 remote 方案）。

> **关于“Extension Session === Web Viewer Session”**：这是由
> “相同 partition 字符串 → 同一 Electron Session”推导出的**设计推论**，
> 不是已证明的运行时事实。POC 阶段必须把它变成运行时证据：
> 1. `extension-loaded / extension-ready / extension-unloaded` 事件确实
>    出现在我们从 `getWebviewPartition()` 取得的 Session 上；
> 2. `getAllExtensions()` 返回扩展的 id/name/version/**location**；
> 3. Web Viewer 的 `<webview>.partition` 与 `app.getWebviewPartition()`
>    一致（MATCH），不一致即 POC FAIL；
> 4. content script 确实注入 Web Viewer 页面（DOM marker / 标题前缀 /
>    localStorage 同一页面上下文证据）。
> 在真机验证回填（`docs/runtime-validation.md`）之前，不得在文档/UI 中
> 把该等式当作已成立的事实。

## 2. 分层架构

```text
Obsidian Community Plugin (renderer)
  Plugin / SettingTab / TrustModal
    EnvironmentDetector（版本/UA/能力检测）
    SessionBridge（partition → Session 代理）
    ExtensionManager（安装/启用/禁用/reload/分析）[Phase 2]
    ManifestCompatibilityAnalyzer（预检查）[Phase 3]
            |
            | require("electron").remote.session.fromPartition(...)
            v
Electron Main Process
  Session("persist:vault-<appId>")
    ses.extensions.loadExtension(path, { allowFileAccess })
            |
            | 同一 partition
            v
Obsidian Core Web Viewer <webview partition="persist:vault-<appId>">
  （Media Extended v4 复用同一 Web Viewer）
```

## 3. 模块划分（正式阶段）

### 3.1 ExtensionManager
- 安装：只支持 unpacked extension 目录（含 manifest.json）。
- 删除、启用、禁用、reload、状态存储。
- 配置存 Obsidian plugin data.json（结构见任务文档）。
- 启动生命周期：发现 Web Viewer → 取 Session → 读 enabled list →
  逐一 loadExtension → 记录结果（Electron 不跨启动保留扩展）。

### 3.2 ManifestCompatibilityAnalyzer
- 解析 manifest_version / permissions / host_permissions / content_scripts /
  background / action / options_page / commands。
- 扫描源码中常见 API 使用：chrome.scripting / chrome.storage /
  chrome.runtime / chrome.tabs / chrome.webRequest / chrome.identity /
  chrome.sidePanel / chrome.contextMenus。
- 输出 CompatibilityReport（评分 A–F + supported/partial/unsupported/warnings）。
- 注意：manifest 分析只是预检查，真实兼容性以 extension-loaded 事件与
  Electron console warnings 为准。

### 3.3 安全模型
- 首次启用扩展必须显示信任确认：“此 Extension 将能够在其 host permissions
  允许的网站中执行浏览器脚本。请确认你信任该 Extension。”并展示名称/路径/
  host permissions/权限。
- 不自动扫描 vault 中的扩展；不默认开启未知扩展。
- allowFileAccess 默认 false；只有用户显式开启“允许访问本地文件”才传 true。
- Session 隔离：只加载进 persist:vault-<appId>，不污染 defaultSession、
  不污染 Obsidian 主界面/编辑器/Settings/PDF viewer。

### 3.4 日志
- 统一 [WebExtensionBridge] + INFO/WARN/ERROR/DEBUG。
- 关键事件（LOAD_RESULT / POC_RESULT）打结构化 JSON。

## 4. Electron 扩展能力（43.x 文档确认）

| API | 支持 | 备注 |
| --- | ---- | ---- |
| content_scripts | 是 | manifest 注入 |
| host_permissions (MV3) | 是 | |
| chrome.scripting | 是 | 全部 |
| chrome.storage.local | 是 | sync/managed 不支持 |
| chrome.runtime | 部分 | id/manifest/sendMessage/connect/onMessage 等 |
| chrome.tabs | 部分 | sendMessage/reload/executeScript；query 仅 url/title/audible/active/muted；update 仅 url/muted |
| chrome.webRequest | 是 | 与 Electron webRequest 冲突时后者优先 |
| chrome.identity | 否 | 不在支持列表 |
| chrome.sidePanel | 否 | 不在支持列表 |
| chrome.contextMenus | 否 | 不在支持列表 |
| background (MV3 service worker) | 有限 | 文档以 DevTools/内部扩展为主 |
| .crx / Chrome Web Store | 否 | 只支持 unpacked |

> UI 必须明确显示 “Electron Extension Compatibility”，不得宣称
> “100% Chrome Extension Support”。

## 5. 阶段计划

1. **Phase 1（本轮）**：POC——侦察 + test-extension + 最小桥接 + 真机验证。
2. **Phase 2**：ExtensionManager（目录选择、启停、reload、状态、日志）。
3. **Phase 3**：Manifest Compatibility Analyzer + 真实翻译扩展测试
   （content_scripts + scripting + storage.local）。
4. **Phase 4**：Session 隔离矩阵测试（多 Tab / popout / workspace / 重启），
   Media Extended 回归验证。
5. 不实现：Chrome Store、CRX 下载器、sidePanel、identity。
