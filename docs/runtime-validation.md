# 运行时验证记录 — Obsidian Web Extension Bridge (POC)

> **本文件只填真机运行得到的真实结果，不写推测。**
> 执行方式：确认 test-extension 已启用后，设置页点击“运行完整验证”，
> 或开启“启动时自动完整验证”后重启 Obsidian；结果写入
> `data.json` 的 `lastValidationRun` / `lastPocResult`（无需开 DevTools）。
> 验证时逐项回填下面各段；标 `(待回填)` 的字段在回填前一律不当作结论。
> 特别提醒：“Extension Session === Web Viewer Session”是设计推论，
> 只有下面 Session/Extension 两段拿到真实证据后才能升级为结论。

## 1. Environment（环境）

| 字段 | 值（待回填） |
| ---- | ------------ |
| Obsidian 版本 | `(待回填)`，如 `1.13.7` |
| Electron 版本 | `(待回填)`，以 `process.versions.electron` 为准 |
| Chrome 版本 | `(待回填)` |
| 平台 | `(待回填)`，如 `win32` |

## 2. Session（相同 partition → 同一 Session 的运行时证据）

| 字段 | 值（待回填） |
| ---- | ------------ |
| `app.getWebviewPartition()` | `(待回填)`，如 `persist:vault-<appId>` |
| persistence | `(待回填)`，如 `persistent` |
| `session.getStoragePath()` | `(待回填)` |
| `require("electron").remote.session.fromPartition` 可用 | `(待回填)` |
| `session.extensions` 对象可用 | `(待回填)` |
| `loadExtension` API 可用 | `(待回填)` |
| Web Viewer `<webview>.partition` | `(待回填)`，与 `getWebviewPartition()` 对比 |
| partition 对比结果 | `(待回填)`，**MATCH** / MISMATCH / UNKNOWN |
| Session 存储路径（持久化落盘） | `(待回填)` |

> 结论规则：`<webview>.partition === getWebviewPartition()` 且扩展事件/注入
> 证据成立，此段才算取得证据；MISMATCH 或拿不到 partition 即 POC FAIL。

## 3. Extension（load / getAllExtensions / 生命周期事件）

| 字段 | 值（待回填） |
| ---- | ------------ |
| loadExtension 是否成功 | `(待回填)` |
| 扩展 id | `(待回填)` |
| 扩展 name / version | `(待回填)` |
| `getAllExtensions()` 返回的 location | `(待回填)` |
| 生命周期事件订阅 | `(待回填)` 成功 / `remote proxy cannot reliably subscribe to Extensions events`（如实记录，不伪造） |
| 观测到的事件（extension-loaded / ready / unloaded） | `(待回填)`，每条带 id/name/version/partition/timestamp |
| 启动恢复（`testExtensionTrusted=true` 时重启后自动 load） | `(待回填)` |

## 4. POC 逐站点（默认四站点，独立记录）

| 站点 | opened | webview | page loaded | extension injected | localStorage 同一上下文 | DOM marker | title 前缀 | 结果 |
| ---- | ------ | ------- | ----------- | ------------------ | ----------------------- | ---------- | ---------- | ---- |
| https://example.com | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` |
| https://www.google.com | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` |
| https://www.youtube.com | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` |
| https://www.bilibili.com | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` | `(待回填)` |

说明：
- `extension injected` = `window.__WEB_EXTENSION_BRIDGE_TEST__` 可读。
- `localStorage 同一上下文` = content script 写入的 `__web_extension_bridge_poc`
  能被 executeJavaScript 读到（辅助证据：同一页面上下文）。
- 每站点独立判 PASS/FAIL，失败时记录其 `{stage, ok:false, error}`。

## 5. 状态机阶段记录（run.steps）

| 阶段 | 结果 | 备注 |
| ---- | ---- | ---- |
| ENVIRONMENT | `(待回填)` | getWebviewPartition 存在 |
| PARTITION | `(待回填)` | 非空、persist |
| SESSION | `(待回填)` | remote.fromPartition 可用 |
| EXTENSION_LOAD | `(待回填)` | loadExtension 成功 |
| EXTENSION_VERIFY | `(待回填)` | getAllExtensions 含该 id |
| WEBVIEW | `(待回填)` | webview 出现 + partition 对比 |
| PAGE_LOAD | `(待回填)` | 30s 内加载 |
| CONTENT_SCRIPT | `(待回填)` | window 标记 |
| LOCALSTORAGE | `(待回填)` | 同页面上下文 |
| DOM_MARKER | `(待回填)` | data-obsidian-extension-test |
| TITLE_MARKER | `(待回填)` | [EXT-TEST] 前缀 |
| PASS / FAIL | `(待回填)` | 结论 |

## 6. 生命周期（load → verify → unload → verify absence → reload）

| 步骤 | 结果（待回填） |
| ---- | -------------- |
| load 后 getAllExtensions 含该 id | `(待回填)` |
| unload 后 getAllExtensions 不含该 id | `(待回填)` |
| 再次 load 后重新出现 | `(待回填)` |
| 期间观测到的 unloaded/loaded 事件 | `(待回填)` |

## 7. 重启恢复

| 字段 | 结果（待回填） |
| ---- | -------------- |
| 设置 `testExtensionTrusted=true` 后重启 | `(待回填)` |
| 启动自动 load 是否成功 | `(待回填)` |
| 重启后的 example.com POC | `(待回填)` |
| lastLoadError（如启动失败） | `(待回填)` |

## 8. 结论

- POC 判定：**PASS / FAIL**（`(待回填)`）。
- 若 FAIL：失败阶段与原因（`(待回填)`）。
- “Extension Session === Web Viewer Session”是否已由运行时证据成立：
  `(待回填)` 已成立 / 未成立（写具体缺失的证据链）。
- 下一步：POC PASS 后进入 Phase 2 ExtensionManager（unpacked 导入 → 启停 →
  manifest 分析 → 真实翻译扩展 → Media Extended 联动）。**POC 未 PASS 前不做 Phase 2。**