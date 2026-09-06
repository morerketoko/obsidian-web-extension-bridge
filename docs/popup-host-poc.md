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
| Popup Host 可创建视图 | PENDING | 需真机：命令面板 → 打开 Popup |
| chrome-extension:// 可加载 | PENDING | 需真机：dom-ready / did-fail-load |
| popup JS 执行 | PENDING | 需真机：console-message / 探针 |
| chrome.runtime | PENDING | 需真机：PROBE_RUNTIME |
| chrome.storage.local | PENDING | 需真机：PROBE_STORAGE |
| chrome.tabs.query | PENDING | 需真机：PROBE_TABS |
| popup → content_script message | PENDING | 需真机：PING_CONTENT |
| GPT-3.5 Translator 功能状态 | PENDING | 需真机：以上全部 + 真实翻译请求 |

说明：真机回填见 `docs/phase2-5-machine-feedback.md`，用户操作步骤见文末。

## 真机操作步骤（Obsidian 内）

1. 重载本插件（Community plugins 面板关闭再开启，或重启 Obsidian）
2. 命令面板执行「实验：打开当前扩展 Popup」
3. 在 Popup Host 视图依次点击「探针: runtime/storage/tabs」「PING_CONTENT」「getSelectedText」
4. 关闭 Obsidian 后回读
   `E:\ob仓库\.obsidian\plugins\obsidian-web-extension-bridge\data.json`
   的 `lastPopupProbe` 字段，回填本报告

