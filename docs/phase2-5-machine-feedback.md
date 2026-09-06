# Phase 2.5 真机反馈（Machine Feedback）

> 数据来源：Obsidian vault `data.json`（`E:\ob仓库\.obsidian\plugins\obsidian-web-extension-bridge\data.json`）
> 采集时间：2026-09-06（Asia/Shanghai）

## 已确认证据（Phase 1/2 回填）

```text
Session: partition=persist:vault-6940bf99bf765a13 (persistent)
Session 存储: C:\Users\DIY\AppData\Roaming\obsidian\Partitions\vault-6940bf99bf765a13
extensions API: 可用 / loadExtension: 可用
事件订阅: 成功
单 URL POC (https://example.com):
  opened=PASS pageLoaded=PASS markerFound=PASS titlePrefixed=PASS
完整验证: PASS (finalStage=PASS, 4 站点)
```

现场 Session 里已确认存在 2 个已加载扩展：

| id | 名称 | location |
| --- | --- | --- |
| `ldijlodomnneibinbnmodkfggmbgopol` | Obsidian WebView Extension Test | `…\test-extension` |
| `fhpegbaffnmjbhhnpgcknjmjhmmbmkoc` | Media Extended | `%TEMP%\mx-extension-…` |

## 当前托管列表（Extension Manager）

| 扩展 | 评级 | 执行模式 | 启用 | 最近加载错误 |
| --- | --- | --- | --- | --- |
| test-extension | A | AUTO_INJECT（旧数据待重新分析，下次启动自动补齐） | 是 | 无 |
| GPT-3.5 Translator | C | POPUP_ACTION（旧数据待重新分析，下次启动自动补齐） | 是 | 无 |
| MouseTooltipTranslator | F（contextMenus 未支持） | MIXED | 是 | 无 |

## 验收矩阵（第 20 节）—— PENDING 项需真机操作回填

```text
                         Load   Inject   UI Entry   Functional
test-extension            ✓       ✓        N/A         ✓
GPT-3.5 Translator         ✓       ✓        Popup       ?（探针待重测）
MouseTooltipTranslator    ✓       ?        Auto        ?
```

### test-extension

```text
Load = PASS（AUTO_INJECT，content script 主动打标记）
Injection = PASS（POC markerFound=true，标题 [EXT-TEST] 前缀）
```

### GPT-3.5 Translator（当前状态）

```text
Load = PASS（POPUP_ACTION；lastLoadedId=ennnoopnplmodedaafeaogfkjknjijdd，无加载错误）
Layout/评级 = C（uses runtime/scripting/storage/tabs；storage.sync 警告：不跨设备同步）
Popup Host = PASS（真机 07:47Z：popup 打开成功，popupAvailable=true）
Popup JS = PARTIAL（popup.js 崩溃：storage.sync 不可用 → apiKey 读取失败；Uncaught TypeError×4）
runtime = PASS（真机：{"runtimeOk":true,"id":"ennnoopnplmodedaafeaogfkjknjijdd","manifestName":"GPT-3.5 Translator"}）
storage.local = 首轮 FAIL（Script failed to execute，探针 Promise 求值问题，已改同步调度+轮询读回，待重测）
tabs.query = 首轮 FAIL（同上；popup.js 自身亦报 tabs 主机权限受限）
Popup → Content = 首轮 FAIL（同上 PING_CONTENT，待重测）
```

关键认知（第 15 节）：`Extension load = PASS` 不等于 `Functional = PASS`。
GPT-3.5 实测：加载 OK、runtime OK，但 popup.js 因 Electron 不支持 storage.sync 而崩溃，
翻译功能需扩展侧适配后才有望可用。
### MouseTooltipTranslator（真机进展 2026-09-06T07:38Z）

```text
真机：已导入 F:\ext-samples\mousetooltiptranslator\build 并启用
Load = PASS（lastLoadedId=leinnanhfdlmceihjlalcjofeeamcplo，无加载错误）
Popup Host = PASS（domReady=true，popupAvailable=true —— 本次打开的正是 MouseTooltip 的 popup）
探针 = 首轮 probes:{} 为回写缺陷（已修复，需重测）
content injection = PENDING（需在 Web Viewer 页面观察悬浮翻译）
hover tooltip = PENDING
selection translation = PENDING
```

## 结论口径（不要笼统说 “Chrome extensions supported”）

```text
Electron Extension Compatibility: SUPPORTED IN SUBSET
Execution Model: AUTO_INJECT / POPUP_ACTION / MIXED
Current Functional Coverage:
  AUTO_INJECT    PASS（test-extension）
  POPUP_ACTION   PARTIAL（Popup Host 加载能力 PASS，探针待重测）
  MIXED          PARTIAL（Load PASS + Popup Host PASS，注入/悬浮翻译待重测）
```

## 待回填检查表

- [x] Popup Host 视图创建成功（真机 2026-09-06T07:38Z）
- [ ] 重测 PROBE_RUNTIME / PROBE_STORAGE / PROBE_TABS（探针已重构为同步调度+轮询读回）
- [ ] 重测 PING_CONTENT（popup → content）
- [ ] GPT-3.5 popup 内实际触发一次翻译请求（popup.js 需先适配 storage.sync 不可用）
- [ ] MouseTooltipTranslator：content injection / hover tooltip / selection translation
- [ ] 回填 docs/popup-host-poc.md 的 PENDING*/首轮 FAIL 项
