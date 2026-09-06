# Phase 2 首轮真机反馈报告（供 AI 讨论）

> 仓库：https://github.com/morerketoko/obsidian-web-extension-bridge
> 提交：62f18f1（Phase 2: Extension Manager with manifest analyzer and managed extension list）
> 日期：2026-09-06

## 一、背景与目标

本项目是 Desktop-only Obsidian 插件，把 unpacked Chrome/Chromium Extension
加载进 **Obsidian Core Web Viewer 的 Electron Session**（partition
`persist:vault-<appId>`），使扩展的 content script 作用于 Web Viewer 页面。

- **Phase 1（POC）已 PASS**（2026-09-06 真机四站点）：example.com / google(.com.hk) /
  youtube.com / bilibili.com 全部注入成功；`<webview>.partition` 与
  `app.getWebviewPartition()` 全部 MATCH；同一 Session 上同时列出 Media Extended
  与 test-extension；`storagePath` 落盘一致。完整数据回填在
  `docs/runtime-validation.md` 与 vault 的 `data.json`（`lastValidationRun`）。
- **Phase 2（Extension Manager）已实现并推送** `62f18f1`：
  - `src/analyzer.ts`：静态兼容分析器（manifest + `chrome.*`/`browser.*` API 扫描，
    评级 A/C/D/F：identity/sidePanel/contextMenus → F；runtime/tabs/webRequest → C；
    storage.sync/MV2 等 → D 警告；纯 content_scripts+scripting+storage.local → A）
  - `src/extension-manager.ts`：导入校验、首次 TrustModal、启用/禁用/重载/移除、
    启动按“已启用且已信任”恢复、旧 `testExtensionTrusted` 自动迁移
  - `src/main.ts`：接入 manager、新增“重载全部已启用扩展”命令、卸载时清理全部
  - `src/settings.ts`：新增“扩展管理”区块（导入路径、列表启停/重载/移除、评级摘要）

## 二、本轮真机操作与运行时证据（来自 vault data.json）

用户在 Obsidian 设置页导入并启用了 **GPT-3.5 Translator**（`F:\ext-samples\gpt35-translator`），
落盘数据如下：

```json
{
  "folder": "F:\\ext-samples\\gpt35-translator",
  "name": "GPT-3.5 Translator",
  "version": "1.0",
  "enabled": true,
  "trusted": true,
  "report": { "score": "C", "contentScripts": 1, "usesScripting": true,
              "usesStorage": true, "usesRuntime": true, "usesTabs": true,
              "partial": ["chrome.runtime", "chrome.tabs"], "warnings": ["storage.sync…"] },
  "lastLoadedId": "ennnoopnplmodedaafeaogfkjknjijdd",
  "lastLoadError": null
}
```

结论一：**Electron `loadExtension` 对真实翻译扩展成功**（返回扩展 id、无错误），
Bridge 的加载链路没有问题；test-extension 迁移记录同步存在且无错误。

## 三、问题：启用后网页没有出现翻译功能

用户观察：打开网页后“扩展功能未实现”。

根因分析（读样本源码后确认）：
1. 该扩展是 **popup 交互型**：`content.js` 只注册 `chrome.runtime.onMessage` 监听，
   等待 action popup 发送 `getSelectedText` 消息才回传选中文本；
2. 翻译动作、API key 输入、结果展示全部在 `popup.html`（action popup）中完成，
   触发入口是浏览器工具栏图标；
3. **Obsidian 没有浏览器工具栏**，也没有任何代码提供 popup 触发入口，
   因此用户在网页里看不到任何行为 —— 这符合“popup 型扩展在非浏览器宿主中的预期”；
4. 这不代表 content script 注入链路失败：Phase 1 POC 已用 test-extension
   （MV3 content_scripts + `<all_urls>`）在四个站点证明注入链路可用。

结论二：**首次样本选型失误**——用户建议的“主要依赖 content_scripts + storage +
scripting 的翻译扩展”应理解为“自动注入型”（content script 主动修改页面/划词浮层），
而非“依赖浏览器 UI 的 popup 型”。加载成功 ≠ 功能可用，二者要分开判断。

## 四、给 AI 讨论的开放问题

1. **注入证据**：在无浏览器 UI（无扩展工具栏、网页里没有扩展自己的 UI）的情况下，
   如何为“任意第三方扩展”拿到 content script 确实注入的运行时证据？
   可选：换自动注入型样本、在受测样本中临时埋探针、用 DevTools 检查 webview、
   由 Bridge 提供“检查当前页面注入标记”的命令。
2. **popup/action 触发**：Electron 的扩展 API 对 `chrome.action` popup 的支持程度？
   Bridge 是否应提供“打开扩展 popup”的等价命令（如新开一个 webview 指向
   `chrome-extension://<id>/popup.html`）？这会影响 Phase 2 对 popup 型扩展的评级。
3. **样本策略**：下一个首选样本应是“自动注入型”翻译扩展（content script 主动
   在页面放划词浮层/整页翻译），以分离“扩展本身不兼容”与“Bridge 有问题”。
   候选：crx-selection-translate（划词浮层）、dadda-translate-crx（划词按钮）、
   MouseTooltipTranslator（悬浮翻译）等，优先取 GitHub Release 现成构建产物。
4. **评级校准**：`chrome.contextMenus` / `declarativeNetRequest` / `storage.sync`
   在 Electron 43 的实际支持度如何？我们目前把 contextMenus 定为 F，可能过严
   （Electron 文档列为支持的 API 之一），需要以真机加载结果校准评级。
5. **下一步**：自动注入型真实翻译扩展真机验证 PASS 后 → 回填 `docs/` →
   再做 Media Extended 联动（Media Extended 复用同一 Web Viewer Session）。

## 五、当前资产

- 托管列表（vault data.json）：test-extension（A 级，注入已验证）、
  gpt35-translator（C 级，popup 型，加载成功）
- 样本目录：`F:\ext-samples\gpt35-translator`、`F:\ext-samples\sc-translator-crx\public`（F 级候补）
- 自动注入型候选：未落地（见开放问题 3）
