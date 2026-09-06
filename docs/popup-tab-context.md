# WebViewerTabContext（Phase 2.5 设计记录，非实现）

## 问题

`POPUP_ACTION` 型扩展在 Popup 中调用 `chrome.tabs.query({active:true,currentWindow:true})`
时，期望拿到「当前标签页」。Obsidian 没有 Chrome Tab 概念，只有工作区里的 Web Viewer
视图；本轮实验先探测其真实返回值（PROBE_TABS），再决定是否需要抽象。

## 设计（仅接口，不注入 shim）

```ts
interface WebViewerTabContext {
  url: string | null;      // 当前 Web Viewer 页面 URL
  title: string | null;    // 当前 Web Viewer 页面标题
  isActive: boolean;       // 该 Web Viewer 是否为当前活动视图
}
```

## 约束（第 19 节）

- 本轮不允许修改 `chrome.tabs` API 行为（不注入兼容 shim、不拦截 tabs.query）
- 若 PROBE_TABS 返回空/异常，先记录为 `tabs.query = PARTIAL/FAIL` 证据
- 只有当 popup 因缺失当前 tab 上下文而无法工作、且 POC 证据充分时，
  才在后续阶段（Phase 3 候选）设计 WebViewerTabAdapter，并在本文件追加设计

## 决策触发条件

1. PROBE_TABS 的 `first` 为空或 `url` 非 Web Viewer 页面
2. 某个 POPUP_ACTION/MIXED 扩展的功能依赖当前 tab（activeTab、getSelectedText 等）
3. 已有至少一个扩展到「无法工作」的具体证据（不是猜测）

