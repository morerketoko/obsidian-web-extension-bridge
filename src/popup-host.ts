// src/popup-host.ts
// Phase 2.5 最小 Popup Host（POC）：
// 证明“已加载扩展的 popup.html 能在同一个 Extension Session 中运行”。
// 用 Obsidian ItemView + <webview partition="persist:vault-<appId>"> 加载
// chrome-extension://<id>/<popupPath>；禁止 nodeIntegration / preload；
// 拦截非 chrome-extension:// 的导航，不自动跳转普通网页。
import { App, ItemView, View, WorkspaceLeaf } from "obsidian";
import { BridgeLogger } from "./logger";

export const POPUP_HOST_VIEW_TYPE = "ob-web-extension-bridge-popup-host";

/** Popup Host 探针报告（写入 data.json，供无终端回读）。 */
export interface PopupProbeReport {
  extensionId: string;
  popupPath: string;
  url: string;
  openedAt: string;
  domReady: boolean;
  loadFailed: boolean;
  loadFailureDetail: string | null;
  consoleMessages: string[];
  /** 名称 -> JSON 字符串（探针结果）。 */
  probes: Record<string, string>;
  /** 探针最后更新时刻（ISO）。 */
  lastProbeAt: string | null;
  /** popup 是否可用（domReady 且未加载失败）。 */
  popupAvailable: boolean;
  error: string | null;
}

function emptyReport(extensionId: string, popupPath: string): PopupProbeReport {
  return {
    extensionId,
    popupPath,
    url: "chrome-extension://" + extensionId + "/" + popupPath,
    openedAt: new Date().toISOString(),
    domReady: false,
    loadFailed: false,
    loadFailureDetail: null,
    consoleMessages: [],
    probes: {},
    lastProbeAt: null,
    popupAvailable: false,
    error: null,
  };
}

function errorMessage(err: unknown): string {
  if (err == null) return "unknown error";
  const e = err as any;
  if (typeof e === "string") return e;
  if (e instanceof Error || (e && e.message)) return String(e.message);
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ---------- 探针脚本（executeJavaScript 在 popup 页面执行） ----------

/** 读取探针暂存对象（同步求值，非 Promise，规避 executeJavaScript 失败）。 */
const READ_PROBE_OUT = `JSON.stringify(window.__obWebProbeOut || {})`;

/**
 * 生成「同步调度 + 暂存结果」探针脚本：
 * 调度阶段只做同步求值（立即返回 SCHEDULED），异步回调把结果写入
 * window.__obWebProbeOut[slot]，probe() 再轮询读回。
 * 规避 Electron webview.executeJavaScript 对返回 Promise 的脚本报
 * "Script failed to execute, this normally means an error was thrown"。
 */
function buildProbeScript(key: string, apiCall: string): string {
  return `(() => {
  try {
    const out = (window.__obWebProbeOut = window.__obWebProbeOut || {});
    const slot = "__obProbe_" + ${JSON.stringify(key)};
    const finish = (v) => {
      clearTimeout(timer);
      try { out[slot] = JSON.stringify(v); } catch (e) { out[slot] = JSON.stringify({ status: "SERIALIZE", error: String(e) }); }
    };
    const timer = setTimeout(() => finish({ status: "TIMEOUT" }), 5000);
    try {
      ${apiCall}
    } catch (e) {
      finish({ status: "THROW", error: String(e) });
    }
    return "SCHEDULED";
  } catch (e) {
    return "ENV:" + String(e);
  }
})()`;
}

/** chrome.runtime / 全局 API 可用性。 */
const PROBE_RUNTIME = buildProbeScript("runtime", `
    finish({
      runtimeOk: typeof chrome !== "undefined" && !!chrome.runtime,
      id: (() => { try { return chrome.runtime.id ?? null; } catch (e) { return null; } })(),
      manifestName: (() => {
        try {
          return chrome.runtime && chrome.runtime.getManifest
            ? (chrome.runtime.getManifest().name ?? null)
            : null;
        } catch (e) { return null; }
      })(),
    });`);

/** chrome.storage.local 异步读写。 */
const PROBE_STORAGE = buildProbeScript("storage.local", `
    chrome.storage.local.get(null, (data) => {
      try {
        if (chrome.runtime.lastError) {
          finish({ status: "ERROR", ok: false, error: chrome.runtime.lastError.message });
        } else {
          finish({ status: "RESPONSE", ok: true, keyCount: Object.keys(data || {}).length, keys: Object.keys(data || {}).slice(0, 20) });
        }
      } catch (e) { finish({ status: "CB_THROW", error: String(e) }); }
    });`);

/** chrome.tabs.query({active:true,currentWindow:true}) 语义探测。 */
const PROBE_TABS = buildProbeScript("tabs.query", `
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      try {
        if (chrome.runtime.lastError) {
          finish({ status: "ERROR", ok: false, error: chrome.runtime.lastError.message });
        } else {
          const arr = tabs || [];
          const first = arr[0] || null;
          finish({
            status: "RESPONSE", ok: true, count: arr.length,
            first: first ? { active: first.active, url: first.url ?? null, title: first.title ?? null } : null,
          });
        }
      } catch (e) { finish({ status: "CB_THROW", error: String(e) }); }
    });`);

/** 消息链：从 popup 向 content script 发送 PING_CONTENT。 */
const PROBE_PING = buildProbeScript("PING_CONTENT", `
    chrome.runtime.sendMessage({ action: "PING_CONTENT" }, (resp) => {
      try {
        if (chrome.runtime.lastError) {
          finish({ status: "ERROR", error: chrome.runtime.lastError.message });
        } else {
          finish({ status: "RESPONSE", response: resp ?? null });
        }
      } catch (e) { finish({ status: "CB_THROW", error: String(e) }); }
    });`);

/** 消息链：使用扩展自身协议 getSelectedText（gpt-3.5-translator 支持）。 */
const PROBE_GET_SELECTED = buildProbeScript("getSelectedText", `
    chrome.runtime.sendMessage({ action: "getSelectedText" }, (resp) => {
      try {
        if (chrome.runtime.lastError) {
          finish({ status: "ERROR", error: chrome.runtime.lastError.message });
        } else {
          finish({ status: "RESPONSE", response: resp ?? null });
        }
      } catch (e) { finish({ status: "CB_THROW", error: String(e) }); }
    });`);
/**
 * 最小 Popup Host：创建/关闭 PopupHostView，收集探针报告。
 * 不注入兼容 shim、不修改第三方扩展源码、不提供完整工具栏。
 */
export class PopupHost {
  private view: PopupHostView | null = null;

  constructor(
    private app: App,
    private log: BridgeLogger,
    /** 报告变化回调（探针/加载事件后推送最新报告，用于持久化）。 */
    private onReport?: (rep: PopupProbeReport) => void
  ) {}

  get isOpen(): boolean {
    return this.view != null;
  }

  /** 打开 popup。partition 使用 Web Viewer 的 partition（与扩展同一 Session）。 */
  async open(
    extensionId: string,
    popupPath: string,
    partition: string | null
  ): Promise<PopupProbeReport> {
    if (!extensionId || !popupPath) {
      const rep = emptyReport(extensionId ?? "", popupPath ?? "");
      rep.error = "extensionId/popupPath 为空";
      return rep;
    }
    this.close();
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: POPUP_HOST_VIEW_TYPE, active: true });
    const view = leaf.view as unknown as PopupHostView;
    if (!view) {
      const rep = emptyReport(extensionId, popupPath);
      rep.error = "PopupHostView 未创建";
      return rep;
    }
    this.view = view;
    view.setTarget({ extensionId, popupPath, partition });
    view.onReport = (rep) => this.onReport?.(rep);
    const rep = await view.waitReady(8000);
    this.log.info("Popup Host 报告:", JSON.stringify(rep));
    return rep;
  }

  /** 对当前 popup 执行探针脚本（需先 open）。 */
  async probe(name: string, code: string): Promise<void> {
    if (!this.view) return;
    await this.view.probe(name, code);
  }

  close(): void {
    if (!this.view) return;
    const leaf = this.view.leaf;
    this.view = null;
    try {
      this.app.workspace.detachLeavesOfType(POPUP_HOST_VIEW_TYPE);
    } catch (e) {
      this.log.warn("关闭 Popup Host 失败:", errorMessage(e));
    }
  }

  onunload(): void {
    this.close();
  }
}

/** 注册 Popup Host 视图类型（main onload 时调用，走 Plugin.registerView）。 */
export function registerPopupHostView(
  registerView: (type: string, creator: (leaf: WorkspaceLeaf) => View) => void,
  log: BridgeLogger
): void {
  registerView(POPUP_HOST_VIEW_TYPE, (leaf) => new PopupHostView(leaf, log));
}

/**
 * PopupHostView：显示扩展 popup 的最小宿主视图。
 * 安全约束：webview 不设 preload、不启用 nodeIntegration（webview 默认隔离）；
 * 监听 will-navigate 并阻止离开 chrome-extension:// 的导航。
 */
class PopupHostView extends ItemView {
  private extId = "";
  private popupPath = "";
  private partition: string | null = null;
  private report: PopupProbeReport;
  /** 外部报告回调：report 每次变化后推送（用于写回 data.json）。 */
  onReport: ((rep: PopupProbeReport) => void) | null = null;
  private webview: any = null;
  private resultEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private readyWaiters: Array<() => void> = [];
  private readyFired = false;

  constructor(leaf: WorkspaceLeaf, private extLog: BridgeLogger) {
    super(leaf);
    this.report = emptyReport("", "");
  }

  getViewType(): string {
    return POPUP_HOST_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Web Extension Bridge · Popup Host";
  }

  getIcon(): string {
    return "puzzle";
  }

  setTarget(target: { extensionId: string; popupPath: string; partition: string | null }) {
    this.extId = target.extensionId;
    this.popupPath = target.popupPath;
    this.partition = target.partition;
    this.report = emptyReport(target.extensionId, target.popupPath);
    this.loadPopup();
  }

  waitReady(timeoutMs: number): Promise<PopupProbeReport> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.report.domReady || this.report.loadFailed) {
          resolve({ ...this.report });
          return;
        }
        if (Date.now() - Date.parse(this.report.openedAt) > timeoutMs) {
          resolve({ ...this.report });
          return;
        }
        setTimeout(check, 100);
      };
      setTimeout(check, 100);
    });
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const header = contentEl.createDiv({ cls: "web-extension-bridge-popup-header" });
    this.statusEl = header.createEl("span", { text: "加载中…", cls: "mod-monospace" });

    const btnGroup = header.createDiv({ cls: "web-extension-bridge-popup-buttons" });
    btnGroup.createEl("button", { text: "刷新" }).addEventListener("click", () => this.loadPopup());
    btnGroup.createEl("button", { text: "探针: runtime/storage/tabs" }).addEventListener("click", () => {
      void this.runAllProbes();
    });
    btnGroup.createEl("button", { text: "PING_CONTENT" }).addEventListener("click", () => {
      void this.probe("PING_CONTENT", PROBE_PING);
    });
    btnGroup
      .createEl("button", { text: "getSelectedText" })
      .addEventListener("click", () => {
        void this.probe("getSelectedText", PROBE_GET_SELECTED);
      });
    btnGroup.createEl("button", { text: "关闭" }).addEventListener("click", () => {
      try {
        this.app.workspace.detachLeavesOfType(POPUP_HOST_VIEW_TYPE);
      } catch {
        // ignore
      }
    });

    const holder = contentEl.createDiv({ cls: "web-extension-bridge-popup-holder" });
    this.resultEl = contentEl.createDiv({
      cls: "mod-monospace web-extension-bridge-popup-result",
      attr: { style: "white-space: pre-wrap;" },
    });
  }

  async onClose(): Promise<void> {
    this.report = emptyReport("", "");
    this.webview = null;
  }

  private loadPopup() {
    if (!this.statusEl) return;
    if (this.webview) {
      try {
        (this.webview as any).src = "about:blank";
      } catch {
        // ignore
      }
      this.webview = null;
    }

    const holder = this.contentEl.querySelector(".web-extension-bridge-popup-holder");
    if (!holder) return;
    holder.empty();
    this.report = emptyReport(this.extId, this.popupPath);
    this.readyFired = false;
    if (this.statusEl) this.statusEl.setText("加载中… " + this.report.url);
    if (this.resultEl) this.resultEl.setText("");

    const wv = document.createElement("webview") as any as HTMLElement;
    wv.setAttribute("partition", this.partition ?? "");
    wv.setAttribute("style", "width:100%; height:100%; border:none;");
    holder.appendChild(wv);
    this.webview = wv;

    (wv as any).addEventListener("dom-ready", () => {
     this.report.domReady = true;
     this.report.popupAvailable = !this.report.loadFailed;
     this.readyFired = true;
     this.updateStatus("DOM ready");
      this.emitReport();
     this.extLog.info("Popup Host dom-ready:", this.report.url);
    });
    (wv as any).addEventListener("did-fail-load", (e: any) => {
      this.report.loadFailed = true;
      this.report.loadFailureDetail =
        `code=${e?.errorCode} ${e?.errorDescription ?? ""} url=${e?.validatedURL ?? ""}`;
     this.report.popupAvailable = false;
     this.updateStatus("加载失败: " + this.report.loadFailureDetail);
      this.emitReport();
     this.extLog.error("Popup Host did-fail-load:", this.report.loadFailureDetail);
    });
    (wv as any).addEventListener("console-message", (e: any) => {
      const msg = `[${e?.level ?? "?"}] ${e?.message ?? ""}`;
      if (this.report.consoleMessages.length < 20) {
        this.report.consoleMessages.push(msg);
      }
      this.extLog.debug("Popup Host console:", msg);
    });
    // 安全约束：不允许 Popup Host 自动导航到普通网页
    (wv as any).addEventListener("will-navigate", (e: any) => {
      const url = String(e?.url ?? "");
      if (url && !url.startsWith("chrome-extension://")) {
        e.preventDefault();
       this.report.error = "已阻止外部导航: " + url;
       this.updateStatus("已阻止外部导航: " + url);
        this.emitReport();
       this.extLog.warn("Popup Host 阻止外部导航:", url);
      }
    });

    (wv as any).src = this.report.url;
  }

  private updateStatus(text: string) {
    if (this.statusEl) this.statusEl.setText(text);
  }

  private emitReport() {
    this.onReport?.({ ...this.report });
  }

  async probe(name: string, code: string) {
    const wv = this.webview as any;
    if (!wv || typeof wv.executeJavaScript !== "function") {
      this.appendResult(name + " => 不可用（webview.executeJavaScript 缺失）");
      return;
    }
    // 阶段 1：同步调度（立即返回 SCHEDULED / ENV:... / THREW:...）
    let step1 = "";
    try {
      step1 = String((await Promise.resolve(wv.executeJavaScript(code))) ?? "");
    } catch (e) {
      step1 = "THREW:" + errorMessage(e);
    }
    // 阶段 2：轮询读取暂存结果（最多 8s，间隔 300ms）
    const slot = "__obProbe_" + name;
    let picked: string | null = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const raw = String((await Promise.resolve(wv.executeJavaScript(READ_PROBE_OUT))) ?? "");
        const obj = JSON.parse(raw || "{}") as Record<string, unknown>;
        if (typeof obj[slot] === "string") {
          picked = obj[slot];
          break;
        }
      } catch {
        // 读取失败：继续轮询
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const text =
      picked ??
      (step1.startsWith("SCHEDULED")
        ? JSON.stringify({ status: "NO_RESULT", detail: "已调度但 8s 内未取到回调结果" })
        : step1);
    this.report.probes[name] = text;
    this.report.lastProbeAt = new Date().toISOString();
    this.appendResult(name + " => " + text);
    this.emitReport();
    if (step1.startsWith("ENV") || step1.startsWith("THREW") || picked) {
      this.extLog.info("Popup Host probe", name, text);
    } else {
      this.extLog.warn("Popup Host probe 未取到结果", name, text);
    }
  }
  private async runAllProbes() {
    await this.probe("runtime", PROBE_RUNTIME);
    await this.probe("storage.local", PROBE_STORAGE);
    await this.probe("tabs.query", PROBE_TABS);
  }

  private appendResult(text: string) {
    if (!this.resultEl) return;
    this.resultEl.setText((this.resultEl.getText() ? this.resultEl.getText() + "\n" : "") + text);
  }
}
