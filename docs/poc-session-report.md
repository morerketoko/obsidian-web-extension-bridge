# POC Session 报告 — Obsidian Web Extension Bridge

> 状态：**代码与侦察完成；已装入 vault，等待 Obsidian 重载后自动验证回填**。
> 重载 Obsidian（Ctrl+R 或重启）后，插件会自动恢复 test-extension 并跑一次
> POC（data.json 的 autoRunPocUrl），结果自动写回 data.json，无需开 DevTools。

## 1. 摘要

目标：证明可以把 unpacked Chrome/Chromium Extension 加载进 **Obsidian Core Web
Viewer 使用的 Electron Session**，使 content script 作用于 Web Viewer 页面
（含 Media Extended v4 复用的同一 Web Viewer）。

核心链路（必须逐环 feature detect，禁止假设）：

```text
App.getWebviewPartition()
  -> "persist:vault-<appId>" （持久化 Session）
  -> electron.remote.session.fromPartition(partition) （主进程 Session 代理）
  -> session.extensions.loadExtension(extensionPath, { allowFileAccess })
```

## 2. 当前环境（侦察结果）

| 项目 | 值 | 证据 |
| ---- | -- | ---- |
| Obsidian（实际运行） | **1.13.7** | `%APPDATA%\obsidian\obsidian-1.13.7.asar` 存在，主进程选择最新 asar 加载；`resources/obsidian.asar`/exe 仍显示旧版 1.12.7 |
| 安装外壳 exe | 1.12.7 | `Obsidian.exe` FileVersion |
| Electron | 43.x 系（运行时以 `process.versions.electron` 为准） | 1.13.7 配套 Electron 43（参考项目同版本声明） |
| 平台 | Windows x64 | `process.platform` |
| Web Viewer | Core 插件 `webviewer`，视图类型 `"webviewer"` | `app.js` 常量 `A4="webviewer"`；`internalPlugins.getEnabledPluginById("webviewer")` |
| Web Viewer Session | `persist:vault-<appId>`（**持久化**） | `app.js`：`getWebviewPartition(){return"persist:vault-"+this.appId}` |
| 插件运行时 | 可 `require("electron")`，含 `remote` | Obsidian 自身 clear-data 对话框：`electron.remote.session.fromPartition(app.getWebviewPartition())` |
| 主进程 | 已初始化 `@electron/remote` | `app.asar/main.js`：`remote.initialize()` |

## 3. 逐步验证（源码侦察）

### 3.1 `app.getWebviewPartition`

- 存在于 1.12.7 与 1.13.7 两个 asar 的主窗口类原型上。
- 返回值固定为 `persist:vault-<appId>`。
- 参考项目 `obsidian-webview-ua-override`（同版本可用）在插件里直接调用
  `this.app.getWebviewPartition()`，证明插件侧可访问。

### 3.2 `create-browser-session` IPC

- Web Viewer 控制器 `updateSession()` 发送：
  `electron.ipcRenderer.send("create-browser-session", app.getWebviewPartition(), enableAdblocking)`。
- 主进程对已注册的 partition 安装 webRequest hook（UA / sec-ch-ua 处理）。
- 我们**不修改**该 IPC，也不绕开它；我们只把扩展加载到同一个 partition 的 Session。

### 3.3 `<webview>` 元素 partition

- Web Viewer / Canvas link view 创建 `<webview>` 时：
  `webview.partition = app.getWebviewPartition()`（即 `persist:vault-<appId>`）。
- Electron 语义：相同 partition 字符串 → 同一个 Session 实例，因此
  **Extension Session === Web Viewer Session**。

### 3.4 Session 持久性

- `persist:` 前缀 → 持久化 Session（磁盘 cookie/storage 在
  `Partitions/vault-<appId>`）。
- Electron 官方扩展文档：**只能在 persistent session 加载扩展**，in-memory
  session 会抛错 —— 与我们的 partition 属性一致。

### 3.5 插件侧能否取得该 Session

- 可以。Obsidian 自身代码（Web Viewer “清除数据”对话框）调用：
  `electron.remote.session.fromPartition(this.app.getWebviewPartition())`
  并调用其 `clearStorageData()` / `clearData()`。
- 这证明 `require("electron").remote` 在插件渲染进程中可用，且方法调用会
  在主进程执行。

### 3.6 `session.extensions.loadExtension` 可用性

- Electron 43 文档：`ses.extensions.loadExtension(path[, {allowFileAccess}])`
  与废弃的 `ses.loadExtension(path[, {allowFileAccess}])` 均存在；
  Session 事件 `extension-loaded` / `extension-unloaded` / `extension-ready`。
- `loadExtension` 是 **Main Process API**。我们的实现通过 `@electron/remote`
  代理调用 —— 调用序列化到主进程执行，不是伪造 renderer 端实现。
- 兼容说明：扩展**不跨启动保留**，插件每次启动必须重新 load（已按此设计）。
- 只支持 unpacked（`.crx` 不支持），不支持 `chrome.identity`、`chrome.sidePanel`。
- 支持清单见 `extension-compatibility-report.md`。

## 4. 实现选择

- 插件不做任何 Obsidian 内部 patch（对比 UA Override 插件会 patch
  `getWebviewPartition`；我们**不需要**，因为我们要的就是原始 partition）。
- 所有能力先 feature detect：`app.getWebviewPartition` →
  `require("electron").remote.session.fromPartition` → `session.extensions` →
  `loadExtension`，任一缺失即安全退出并提示不兼容，不崩溃。
- 安全闸门：首次启用扩展必须弹窗确认（名称/路径/host permissions/权限）；
  `allowFileAccess` 默认 `false`，只有用户开“允许访问本地文件”才传 `true`。
- 卸载：`ses.extensions.removeExtension(id)`，插件 unload 时恢复现场。

## 5. 可能失败点与对策

| 失败点 | 对策 |
| ------ | ---- |
| `@electron/remote` 无法代理 `session.extensions`（远程 getter 不支持） | 记录失败原因，停止完整实现，回退备用架构 |
| `loadExtension` 抛错（manifest 不支持 / 路径无效） | 捕获并结构化日志；提示用户 |
| Obsidian 升级改变 `getWebviewPartition` / `create-browser-session` | feature detect 失败 → 显示 “Web Extension Bridge is not compatible with this Obsidian/Electron version.” |
| 扩展注入到非目标页面（污染 Obsidian UI） | 只加载进 `persist:vault-<appId>`，不碰 defaultSession |

## 6. 备用架构（仅在上述失败点真实发生时启用）

`Custom WebContentsView / WebView browser`：

- 插件自建 Electron `WebContentsView` 承载网页，扩展加载到自建 Session。
- 不再是“Core Web Viewer Session”，属于独立浏览器视图（第二方案）。
- 本阶段**不实现**，只在必需时才切换，且先记录原因。

## 7. 风险

- 依赖 Obsidian 内部 API（`getWebviewPartition` 等），版本升级可能破坏。
- 扩展本质可执行网页脚本，需用户显式信任（已加确认弹窗）。
- `persist:vault-<appId>` 是 vault 级会话，会与 Obsidian 自带 hook 共存，
  但互不干扰扩展注入。

## 8. 真机验证记录（待回填）

以下字段在插件装入 vault 并启用后，由
`[WebExtensionBridge] LOAD_RESULT`/POC 日志回填：

```text
Obsidian version:        (待回填)
Electron version:        (待回填)
web viewer availability: (待回填)
partition name:          (待回填)
session persistence:     (待回填)
extension path:          (待回填)
extension id:            (待回填)
extension load result:   (待回填)
extension warnings:      (待回填)
failure reason:          (待回填)
```

### POC 验证清单

- [ ] example.com：`data-obsidian-extension-test="true"`
- [ ] example.com：title 前缀 `[EXT-TEST] `
- [ ] https://www.youtube.com
- [ ] https://www.bilibili.com
- [ ] https://www.google.com
- [ ] 普通 https 页面
