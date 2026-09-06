# 运行时验证记录 — Obsidian Web Extension Bridge (Phase 1 POC)

> 阶段结论：**PASS**（2026-09-06 真机验证，Obsidian 自动运行写回 data.json）。
> 以下字段全部来自真实运行结果（`lastValidationRun` / `lastPocResult`），
> 无推测。

## 1. Environment（环境）

| 字段 | 值 |
| ---- | -- |
| Obsidian 版本 | 1.13.7（已确认实际加载此 asar） |
| Electron 版本 | 43.x 系（运行时 `process.versions.electron`，控制台 LOAD_RESULT 日志） |
| Chrome 版本 | 以 Electron 43 配套为准（控制台日志） |
| 平台 | Windows x64 |

## 2. Session（相同 partition → 同一 Session 的运行时证据）

| 字段 | 值 |
| ---- | -- |
| `app.getWebviewPartition()` | `persist:vault-6940bf99bf765a13` |
| persistence | `persistent` |
| `session.getStoragePath()` | `C:\Users\DIY\AppData\Roaming\obsidian\Partitions\vault-6940bf99bf765a13` |
| `require("electron").remote.session.fromPartition` 可用 | 是（SESSION 阶段 ok） |
| `session.extensions` 对象可用 | 是 |
| `loadExtension` API 可用 | 是 |
| Web Viewer `<webview>.partition` | `persist:vault-6940bf99bf765a13`（四站点一致） |
| partition 对比结果 | **MATCH**（四站点全部） |
| Session 持久化落盘路径 | 与 storagePath 一致（persistent） |

结论：本环境下 `<webview>.partition === getWebviewPartition()`，且后续
扩展列表 / content script 注入均发生在该 Session 上，设计推论
“Extension Session === Web Viewer Session” 已有运行时证据支持
（限定于被测环境，见第 8 段）。

## 3. Extension（load / getAllExtensions / 生命周期事件）

| 字段 | 值 |
| ---- | -- |
| loadExtension 是否成功 | 是（EXTENSION_LOAD ok） |
| 扩展 id | `ldijlodomnneibinbnmodkfggmbgopol` |
| 扩展 name / version | Obsidian WebView Extension Test / 0.0.1 |
| `getAllExtensions()` 返回的 location | `E:\ob仓库\.obsidian\plugins\obsidian-web-extension-bridge\test-extension` |
| 生命周期事件订阅 | **成功**（`eventSubscription.ok=true`，@electron/remote 可订阅） |
| 观测到的事件（loaded/ready/unloaded） | 本轮未捕获（订阅发生在验证开始后，加载在启动恢复阶段完成）→ 生命周期测试见第 6 段（待补跑） |
| 启动恢复（`testExtensionTrusted=true` 自动 load） | 是（`lastLoadedId` 一致、`lastLoadError=null`） |

附加发现（直接运行时证据）：
- `getAllExtensions()` 同时返回 **Media Extended v4 自身注入的扩展**
  （id `fhpegbaffnmjbhhnpgcknjmjhmmbmkoc`，location
  `%TEMP%\mx-extension-<pid>-<ts>`），说明 Media Extended 与我们的
  test-extension 在**同一个 persistent Session** 上 —— 这正面印证了
  “Media Extended 复用同一 Web Viewer Session” 的架构前提。

## 4. POC 逐站点（四站点独立记录，全部 PASS）

| 站点 | opened | webview | page loaded | extension injected | localStorage 同一上下文 | DOM marker | title 前缀 | 结果 |
| ---- | ------ | ------- | ----------- | ------------------ | ----------------------- | ---------- | ---------- | ---- |
| https://example.com | 是 | 是 | 是 | 是 | 是 | 是 | 是 | PASS |
| https://www.google.com（重定向至 www.google.com.hk） | 是 | 是 | 是 | 是 | 是 | 是 | 是 | PASS |
| https://www.youtube.com | 是 | 是 | 是 | 是 | 是 | 是 | 是 | PASS |
| https://www.bilibili.com | 是 | 是 | 是 | 是 | 是 | 是 | 是 | PASS |

说明：
- `extension injected`：以 DOM 标记（`data-obsidian-extension-test="true"`）为
  主判据，标题前缀为第二判据。
- `window.__WEB_EXTENSION_BRIDGE_TEST__`（windowMarkerFound）四站点均为
  **false** —— 与 Chrome/Electron content script 默认在隔离世界运行、
  主世界 executeJavaScript 读不到全局标记的语义一致；DOM 与 localStorage
  由网页与隔离世界共享，故仍可见。
- `localStorage 同一上下文`（`__web_extension_bridge_poc` 可读）四站点均为
  **true** —— content script 写入的存储能被 executeJavaScript 读回，
  证明两者处于同一页面上下文（同一 Session 的辅助证据）。

## 5. 状态机阶段记录（run.steps 全部 ok）

| 阶段 | 结果 |
| ---- | ---- |
| ENVIRONMENT | ok（getWebviewPartition 存在） |
| PARTITION | ok（`persist:vault-6940bf99bf765a13` / persistent） |
| SESSION | ok（remote.fromPartition 可用、extensionsApi/loadExtension 可用） |
| EXTENSION_LOAD | ok（复用已加载 `ldijlo…`） |
| EXTENSION_VERIFY | ok（getAllExtensions 返回 2 个，含 Media Extended + test-extension） |
| WEBVIEW（四站点） | ok（webview 出现，partition MATCH） |
| PAGE_LOAD（四站点） | ok（location.href 命中目标） |
| CONTENT_SCRIPT（四站点） | ok（DOM 标记存在） |
| DOM_MARKER（四站点） | ok |
| TITLE_MARKER（四站点） | ok |
| PASS | 是 |

## 6. 生命周期（load → verify → unload → verify absence → reload）

**待补跑**（本轮验证未做 unload 测试）。计划用设置页“卸载测试扩展”→
`getAllExtensions` 确认消失 → 再次加载 → 确认恢复，并观测
`extension-unloaded` / `extension-loaded` 事件。

## 7. 重启恢复

| 字段 | 结果 |
| ---- | ---- |
| `testExtensionTrusted=true` 后重启 | 是（每次自动恢复） |
| 启动自动 load 是否成功 | 是（`lastLoadError=null`，`lastLoadedId` 一致） |
| 重启后的 example.com POC | 验证通过（四站点均 PASS）；单 URL 自动 POC 在验证运行前
  的瞬间出现过一次 `chrome-error://chromewebdata/`（瞬态网络/启动时序），
  验证本身不受影响，列为观察项 |

## 8. 结论

- POC 判定：**PASS**。
- 失败阶段：无。
- “Extension Session === Web Viewer Session”：在**被测环境**
  （Obsidian 1.13.7 / Electron 43.x / Windows）下已由运行时证据成立：
  partition 一致（MATCH）、同一 Session 上列出 Media Extended 与
  test-extension、content script 注入四站点、localStorage 同上下文。
  该结论限定于被测环境，不承诺跨版本恒成立；版本升级需重跑本记录。
- 下一步：进入 **Phase 2** — ExtensionManager（unpacked 导入 → 启停 →
  manifest 分析 → 真实翻译扩展 → Media Extended 联动）。首个真实翻译扩展
  建议选择主要依赖 `content_scripts + storage + scripting` 的轻量扩展，
  避免一开始就用全功能包（如 Immersive Translate），以便区分
  “扩展本身不兼容” 与 “Bridge 有问题”。

## 9. 验证过程中修复过的问题（记录备查）

1. `loadExtension` 要求绝对路径：Obsidian `manifest.dir` 是 vault 相对路径，
   已改为 `adapter.getBasePath()` 拼绝对路径。
2. 探针提前执行：`<webview src>` 属性会提前设置但页面未提交，已改为
   `location.href` 反查导航提交 + 800ms 注入宽限期。
3. 隔离世界可见性：window 全局标记主世界读不到，主判据改用共享 DOM 标记。
4. google 地区重定向（google.com → .com.hk）：URL 匹配兼容主机后缀。