# Extension 兼容性报告 — Obsidian Web Extension Bridge

> 状态：**模板 + Electron 文档矩阵**。真实翻译扩展测试在 POC 闭环成功后执行，结果回填下方。

## 1. Electron 官方支持矩阵（Electron 43.x 文档）

来源：
- https://www.electronjs.org/docs/latest/api/extensions
- https://www.electronjs.org/docs/latest/api/session

### 支持的 manifest 键
- name / version / author / permissions / content_scripts / default_locale /
  devtools_page / short_name / host_permissions (MV3) / manifest_version /
  background (MV2) / minimum_chrome_version

### Chrome API 支持情况

| API | 状态 | 说明 |
| --- | ---- | ---- |
| chrome.scripting | 支持 | 全部特性 |
| chrome.webRequest | 支持 | 与 Electron webRequest 冲突时后者优先 |
| chrome.storage.local | 支持 | sync / managed 不支持 |
| chrome.runtime | 部分 | lastError/id/getManifest/getURL/sendMessage/connect/reload/onMessage/onInstalled/onStartup 等 |
| chrome.tabs | 部分 | sendMessage/reload/executeScript；query 仅 url/title/audible/active/muted；update 仅 url/muted；不支持 tabId=-1 |
| chrome.extension | 部分 | lastError/getURL/getBackgroundPage |
| chrome.management | 部分 | getAll/get/getSelf/getPermissionWarnings 等 |
| devtools 系列 | 支持 | inspectedWindow / network / panels |
| chrome.identity | 不支持 | 不在支持列表 |
| chrome.sidePanel | 不支持 | 不在支持列表 |
| chrome.contextMenus | 不支持 | 不在支持列表 |

### 加载限制
- 只支持 unpacked 扩展目录（.crx 不支持）。
- 只能加载进 persistent session（in-memory 会抛错）。
- 不跨启动保留，每次启动需重新 loadExtension。
- `allowFileAccess` 默认 false。

## 2. 测试扩展（test-extension）

- Manifest: MV3，仅 name/version/manifest_version/host_permissions/content_scripts。
- Content script：document_start 注入，`<all_urls>`。
- 标记：`document.documentElement.dataset.obsidianExtensionTest === "true"`。
- 标题：加 `[EXT-TEST] ` 前缀。

## 3. 待测场景与结果模板

```text
Extension:      (待回填，推荐 content_scripts + scripting + storage.local 翻译扩展)
Manifest:       (待回填)
Electron:       (待回填)
Obsidian:       (待回填)

content_scripts: PASS/FAIL
scripting:       PASS/FAIL
storage:         PASS/FAIL
tabs:            PASS/PARTIAL/FAIL
webRequest:      PASS/PARTIAL/FAIL

YouTube:   (待回填)
Bilibili:  (待回填)
Google:    (待回填)
SPA:       (待回填)
iframe:    (待回填)

最终评级： (A/B/C/D/F + 说明)
```

## 4. 目标站点清单

- https://example.com（基线）
- https://www.youtube.com
- https://www.bilibili.com
- https://www.google.com
- 普通 https 页面 / SPA / 带 iframe 页面 / 页面跳转 / 重新加载

## 5. 结论

POC 闭环成功并拿到 Electron 行为数据后，回填本报告并给出最终评级。
