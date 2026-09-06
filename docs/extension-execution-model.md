# Extension Execution Model

> Phase 2.5：区分「扩展加载成功」与「扩展可用」。
> 「Load = PASS」绝不直接等于「Functional = PASS」。

## 执行模式定义

### AUTO_INJECT

`content_scripts` 会自动注入并主动修改 Web Viewer 页面（DOM 监听 / 元素创建 /
事件绑定）。无需 User 额外操作即可生效。

判定：manifest 声明 `content_scripts`，且至少一个脚本在源码层面是「主动型」
（见下方 `isActiveContentScript` 特征）。

### POPUP_ACTION

扩展依赖 `action/browser_action.default_popup` 作为主要入口：Obsidian 没有 Chrome
工具栏，因此没有工具栏图标可点。Bridge 提供实验性 Popup Host（Phase 2.5）来承载
`chrome-extension://<id>/<popupPath>`。

判定：无主动 content_scripts（或 content script 仅被动响应消息），但有 popup。

### BACKGROUND_ONLY

无自动页面 UI，主要逻辑在 background（service worker）。页面上没有表现。

判定：只有 `background`，没有主动 content scripts / popup。

### DEVTOOLS

需要 `devtools_page` 上下文才会出现 UI。Obsidian 不提供 DevTools 扩展面板，
本轮不可用。

判定：只有 `devtools_page`，无其他入口。

### MIXED

上述模式的组合（例如：主动 content_scripts + popup + background）。

判定：主动 content_scripts 存在，且同时有 popup/action/background 任一入口。

### UNKNOWN

无法从 manifest 判定（读取失败或没有已知入口）。

## 判定来源（代码）

- `src/analyzer.ts`：`parseEntryPoints()` + `determineExecutionMode()`
- 主动型特征（`isActiveContentScript()`）正则：
  `document\.|addEventListener(|MutationObserver(|createElement|innerHTML|setInterval|onXxx=`

## 已导入扩展的执行模式

| 扩展 | 执行模式 | 依据 |
| --- | --- | --- |
| test-extension | AUTO_INJECT | 仅 content script，主动打 DOM 标记 |
| GPT-3.5 Translator | POPUP_ACTION | popup.js 触发翻译；content.js 仅监听 onMessage |
| MouseTooltipTranslator | MIXED | contentScript.js 主动注入（addEventListener/MutationObserver）+ background + action.default_popup |

## 与激活状态的关系

`ActivationStatus`（`src/extension-manager.ts`）：

```text
READY                已导入且数据完整
LOADED_NO_UI_ENTRY   已加载，但没有需要用户操作的 UI 入口
POPUP_AVAILABLE      Popup Host 已验证可打开该扩展的 popup
AUTO_INJECT          已加载且以主动 content script 方式注入
UNSUPPORTED          分析判定不可用
UNKNOWN              未知
```

## 结论口径

```text
Electron Extension Compatibility: SUPPORTED IN SUBSET
Execution Model: AUTO_INJECT / POPUP_ACTION / MIXED
Current Functional Coverage: 见 docs/phase2-5-machine-feedback.md
```
