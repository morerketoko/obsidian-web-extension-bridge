# Popup Host POC（Phase 2.5）

## 目的

证明「已加载扩展的 `popup.html` 能在同一个 Extension Session（partition）中运行」，
弥补 Obsidian 没有 Chrome 工具栏导致的 `POPUP_ACTION` 型扩展无入口问题。

本 POC 不仿制 Chrome 工具栏，不做大规模 UI，不修改第三方扩展源码。

## 实现（src/popup-host.ts）

- `PopupHost`：创建/关闭 `PopupHostView`，返回 `PopupProbeReport`（写入 `data.json` 的
  `lastPopupProbe`，无需终端即可回读）。
- `PopupHostView`：Obsidian `ItemView` 内嵌 `<webview>`，partition 与 Web Viewer 相同
  （同一 Electron Session，扩展与 popup 共享 runtime/storage 上下文）。
- 安全约束：
  - webview 不设 preload、不启用 nodeIntegration（webview 默认隔离）
  - `will-navigate` 阻止任何非 `chrome-extension://` 导航
- 视图按钮：刷新 / 探针(runtime+storage+tabs) / PING_CONTENT / getSelectedText / 关闭
- 命令：`open-popup-experiment`（实验：打开当前扩展 Popup）

## 探针清单

| 探针 | 脚本 | 验证目标 |
| --- | --- | --- |
| runtime | PROBE_RUNTIME | chrome.runtime 可用、id、manifest.name |
| storage.local | PROBE_STORAGE | 异步读写、key 枚举（5s 超时） |
| tabs.query | PROBE_TABS | `{active,currentWindow}` 语义（5s 超时） |
| PING_CONTENT | PROBE_PING | popup → content_script 消息链（6s 超时） |
| getSelectedText | PROBE_GET_SELECTED | 扩展自身协议（GPT-3.5 Translator 支持） |

## 验收记录

| 项 | 结果 | 证据 |
| --- | --- | --- |
| Popup Host 可创建视图 | PASS | 真机 2026-09-06T07:38Z（命令「实验：打开当前扩展 Popup」） |
| chrome-extension:// 可加载 | PASS | MouseTooltip popup：domReady=true，loadFailed=false，popupAvailable=true |
| popup JS 执行 | PARTIAL* | 真机 07:47Z：GPT-3.5 popup.js 崩溃（`sync` 不可用致 apiKey 读取失败 + Uncaught TypeError×4） |
| chrome.runtime | PASS | 真机 07:47Z：`{"runtimeOk":true,"id":"ennnoopnplmodedaafeaogfkjknjijdd","manifestName":"GPT-3.5 Translator"}` |
| chrome.storage.local | PENDING* | 首轮失败：`GUEST_VIEW_MANAGER_CALL: Script failed to execute`（executeJavaScript 对返回 Promise 的脚本），已改同步调度+轮询读回，待重测 |
| chrome.tabs.query | PENDING* | 同上；且 popup.js 自身报 tabs 权限受限（manifest 仅 api.openai.com 主机权限） |
| popup → content_script message | PENDING* | 同上（PING_CONTENT） |
| GPT-3.5 Translator 功能状态 | PARTIAL* | runtime PASS；popup.js 崩溃需扩展侧修复（storage.sync 在 Electron 不可用）；真实翻译待重测 |

* 注 1：首轮 `probes:{}` 为空是回写缺陷（已修复：PopupHost 报告回调即时写回 data.json）。
* 注 2：二轮（07:47Z）runtime 已 PASS；storage/tabs/PING/getSelectedText 的 `Script failed to execute` 已定位为探针返回 Promise 的求值问题，已重构为同步调度 + `window.__obWebProbeOut` 暂存 + 轮询读回。
* 注：首轮真机 `probes:{}` 为空是回写缺陷（探针只更新视图内存，未同步 data.json）。
已修复（PopupHost 增加报告回调，探针/加载事件后即时回写 `lastPopupProbe`），
重新加载插件后重测即可回填。

说明：真机回填见 `docs/phase2-5-machine-feedback.md`，用户操作步骤见文末。

## 真机操作步骤（Obsidian 内）

1. 重载本插件（Community plugins 面板关闭再开启，或重启 Obsidian）
2. 命令面板执行「实验：打开当前扩展 Popup」
3. 在 Popup Host 视图依次点击「探针: runtime/storage/tabs」「PING_CONTENT」「getSelectedText」
4. 关闭 Obsidian 后回读
   `E:\ob仓库\.obsidian\plugins\obsidian-web-extension-bridge\data.json`
   的 `lastPopupProbe` 字段，回填本报告
