# Compatibility Adapter（兼容适配层设计）

> Phase 2.6 研究产出：**只做设计，不实现**。
> 定位：让「加载成功但个别 API 不可用」的扩展在本地仍可工作的**可选兼容层**，
> 不是 `native Chrome API support`，不改变 Electron 默认行为。

## 设计链路

```text
Extension
   ↓
Capability Analysis（analyzer 静态评级）
   ↓
Unsupported API（unsupported / nonCriticalUnsupported）
   ↓
Optional Adapter（按扩展启用，默认关闭）
```

原则：**分析先行**。一个扩展只有在 analyzer 确认某个 API 为
`nonCriticalUnsupported` / `potentialBlocker` 时，才被列为 Adapter 候选；
任何 API 都不会被默认改写。

## 第一候选：StorageSyncToLocalAdapter

**目标 API**：`chrome.storage.sync`

**问题**：Electron 的 `chrome.storage.sync` 不存在（真机实测 GPT-3.5
popup.js 直接崩溃：`Unchecked runtime.lastError: "sync" is not available in
this instance of Chrome`），而多数翻译扩展仅用 sync 存配置。

**方案**：为指定扩展提供 `storage.sync` → `storage.local` 的**本地回退**，
仅在扩展自身的 extension context 内生效。

**边界（必须遵守）**：

```text
⚠ Compatibility Adapter active

chrome.storage.sync
→ local storage fallback

No cross-device sync.
```

- ✅ 按扩展启用 / 按 API 启用 / 可关闭 / 可记录 / 可审计
- ✅ 未来 UI 对启用 Adapter 的扩展显示 `⚠ Compatibility Adapter active`
- ❌ 禁止全局 shim：`Object.defineProperty(chrome.storage, "sync", ...)`
- ❌ 禁止修改整个 Web Viewer 的 `window.chrome`
- ❌ 禁止改变默认 Chrome API 语义（未启用 Adapter 的扩展行为不变）
- ❌ 禁止让所有扩展自动使用 storage.local 替代 storage.sync
- ❌ 禁止修改第三方扩展源码

## 实现落点（未来，不在本轮实现）

1. `analyzer` 输出 `storage.sync` 的调用面（`get/set/clear/remove/getBytesInUse/onChanged`），
   决定回退只覆盖实际调用的方法。
2. Adapter 以「per-extension context 代理」形式注入该扩展的 popup/background/content 脚本
   （注入发生在扩展脚本执行前，且仅当该扩展启用了 Adapter）。
3. 数据落在与扩展 id 隔离的 `storage.local` 命名空间，不做跨设备同步。
4. 打开/关闭、调用计数、错误日志全部记录到 `data.json`（可审计）。
5. 若扩展调用 `getBytesInUse` / `onChanged` 且 Adapter 无法忠实地映射，
   明确标记 `PARTIAL` 而不是假装支持。

## 评级联动

- `storage.sync` 由「自动 F」修正为：**非核心 unsupported（C 级）**；
  若出现在 popup/background 入口脚本（无 content script 兜底）→ `D` 级
  （potentialBlocker，需要 Adapter 才能保证功能）。
- 修正后 analyzer 只对 evidence-backed 的 hard blocker（identity/sidePanel
  实际调用、manifest V1、无入口）给 F。

## 验证口径（不改变）

```text
Electron Extension Compatibility: SUPPORTED IN SUBSET
（AUTO_INJECT / POPUP_ACTION / MIXED 各自按真实运行结果汇报；Adapter 默认关闭）
```