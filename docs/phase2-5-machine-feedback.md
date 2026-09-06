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
| test-extension | A | AUTO_INJECT | 是 | 无 |
| GPT-3.5 Translator | C | POPUP_ACTION | 是 | 无 |

## 验收矩阵（第 20 节）—— PENDING 项需真机操作回填

```text
                         Load   Inject   UI Entry   Functional
test-extension            ✓       ✓        N/A         ✓
GPT-3.5 Translator         ✓       ✓        Popup       ?
MouseTooltipTranslator    ?       ?        Auto        ?
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
Popup Host = PENDING（需真机：打开 Popup）
Popup JS = PENDING
runtime = PENDING
storage.local = PENDING
tabs.query = PENDING
Popup → Content = PENDING
```

关键认知：`popup.js` 触发翻译，`content.js` 仅监听 onMessage —— 加载成功 ≠ 页面有行为，
必须用 Popup 才能启动。

### MouseTooltipTranslator（样本已就绪，待导入验证）

```text
分析判定 = MIXED（contentScript.js 主动注入 + background.js + action.default_popup=popup.html）
证据：contentScript.js 含 document.addEventListener×8 / MutationObserver×7 / mouseover×37
构建产物 = F:\ext-samples\mousetooltiptranslator\build（webpack production 构建完成）
Load = PENDING（真机：管理器导入 build 目录）
content injection = PENDING
hover tooltip = PENDING
selection translation = PENDING
```

## 结论口径（不要笼统说 “Chrome extensions supported”）

```text
Electron Extension Compatibility: SUPPORTED IN SUBSET
Execution Model: AUTO_INJECT / POPUP_ACTION / MIXED
Current Functional Coverage:
  AUTO_INJECT    PASS（test-extension）
  POPUP_ACTION   PENDING（Popup Host 待真机）
  MIXED          PENDING（MouseTooltipTranslator 待真机导入）
```

## 待回填检查表

- [ ] Popup Host 视图创建成功（命令「实验：打开当前扩展 Popup」）
- [ ] PROBE_RUNTIME / PROBE_STORAGE / PROBE_TABS 三项结果
- [ ] PING_CONTENT 结果（popup → content）
- [ ] GPT-3.5 popup 内实际触发一次翻译请求
- [ ] MouseTooltipTranslator：Load / hover tooltip / selection translation
- [ ] 回填 docs/popup-host-poc.md 的 PENDING 项

