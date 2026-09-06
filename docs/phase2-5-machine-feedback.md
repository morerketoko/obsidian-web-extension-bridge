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
    Popup Host = PARTIAL（activationStatus 已标 POPUP_AVAILABLE，但 lastPopupProbe 被 MouseTooltip 覆盖，需单独重测）
Popup JS = PENDING
runtime = PENDING
storage.local = PENDING
tabs.query = PENDING
Popup → Content = PENDING
```

关键认知：`popup.js` 触发翻译，`content.js` 仅监听 onMessage —— 加载成功 ≠ 页面有行为，
必须用 Popup 才能启动。

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

- [ ] Popup Host 视图创建成功（命令「实验：打开当前扩展 Popup」）
- [x] Popup Host 视图创建成功（真机 2026-09-06T07:38Z）
- [ ] 重测 PROBE_RUNTIME / PROBE_STORAGE / PROBE_TABS（修复回写后）
- [ ] 重测 PING_CONTENT（popup → content）
更详细的首次真机记录与探针回写缺陷说明见上方章节（首轮 probes:{} 为回写缺陷，已修复）。
- [ ] PROBE_RUNTIME / PROBE_STORAGE / PROBE_TABS 三项结果
- [ ] PING_CONTENT 结果（popup → content）
- [ ] GPT-3.5 popup 内实际触发一次翻译请求
- [ ] MouseTooltipTranslator：Load / hover tooltip / selection translation
- [ ] 回填 docs/popup-host-poc.md 的 PENDING 项
