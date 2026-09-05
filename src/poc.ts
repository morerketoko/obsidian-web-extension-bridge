import { App, WorkspaceLeaf } from "obsidian";
import { BridgeLogger } from "./logger";
import {
  ExtensionEventRecord,
  FullExtensionInfo,
  WebViewerSessionBridge,
} from "./session-bridge";

// 来自 Obsidian 内部（app.js 常量 A4）的 Core Web Viewer 视图类型。
const WEBVIEWER_VIEW_TYPE = "webviewer";

/** 完整验证默认站点（可在设置里改为其它列表）。 */
export const DEFAULT_VALIDATION_SITES = [
  "https://example.com",
  "https://www.google.com",
  "https://www.youtube.com",
  "https://www.bilibili.com",
];

/**
 * POC 状态机阶段。任何一步失败即记录 {stage, ok:false, error}，
 * 不得把设计推论当作结论。
 */
export type PocStage =
  | "ENVIRONMENT"
  | "PARTITION"
  | "SESSION"
  | "EXTENSION_LOAD"
  | "EXTENSION_VERIFY"
  | "WEBVIEW"
  | "PAGE_LOAD"
  | "CONTENT_SCRIPT"
  | "LOCALSTORAGE"
  | "DOM_MARKER"
  | "TITLE_MARKER"
  | "PASS"
  | "FAIL";

export interface StageResult {
  stage: PocStage;
  ok: boolean;
  error: string | null;
  detail?: unknown;
}

export interface SiteResult {
  url: string;
  opened: boolean;
  webviewAvailable: boolean;
  webviewPartitionMatch: "MATCH" | "MISMATCH" | "UNKNOWN";
  webviewPartition: string | null;
  pageLoaded: boolean;
  extensionInjected: boolean;
  localStorageShared: boolean;
  domMarkerFound: boolean;
  titlePrefixed: boolean;
  title: string;
  finalStage: PocStage;
  error: string | null;
}

export interface ValidationOptions {
  sites: string[];
  extensionPath: string;
  allowFileAccess: boolean;
  /** 已加载好的扩展 id（复用避免重复 load）；为空时本流程会先 load。 */
  alreadyLoadedId?: string | null;
}

export interface ValidationRun {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  finalStage: PocStage;
  error: string | null;
  partition: string | null;
  sessionPersistence: string | null;
  sessionStoragePath: string | null;
  webviewPartition: string | null;
  extensionIds: string[];
  extensionLocations: string[];
  eventSubscription: { ok: boolean; error: string | null };
  eventRecords: ExtensionEventRecord[];
  eventCounts: Record<string, number>;
  steps: StageResult[];
  sites: SiteResult[];
}

/** 兼容旧接口的单 URL POC 结果（写入 data.json 便于无终端验证）。 */
export interface PocResult {
  url: string;
  opened: boolean;
  pageLoaded: boolean;
  markerFound: boolean;
  titlePrefixed: boolean;
  title: string;
  markerValue: string | null;
  error: string | null;
}

const MAX_PAGE_WAIT_MS = 30000;
const MAX_WEBVIEW_WAIT_MS = 8000;
const MAX_LAYOUT_WAIT_MS = 10000;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
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

/**
 * POC 验证：状态驱动的运行时证据收集。
 *
 * 待验证的设计推论（不是结论）：“Extension Session === Web Viewer Session”。
 * 本轮用以下运行时证据去验证它：
 *   1. extension-loaded / extension-ready / extension-unloaded 何时出现在我们从
 *      getWebviewPartition 取得的 Session 上（生命周期事件）；
 *   2. getAllExtensions 返回的扩展记录（含 location / partition）；
 *   3. <webview>.partition 与 app.getWebviewPartition() 是否一致（MATCH/MISMATCH）；
 *   4. content script 确实注入 Web Viewer 页面（DOM marker / 标题前缀 / localStorage）。
 * 任何一环拿不到真实证据，就如实记录失败，不把推论当结论。
 */
export class PocTester {
  constructor(
    private app: App,
    private bridge: WebViewerSessionBridge,
    private log: BridgeLogger
  ) {}

  /** 完整验证入口：会话级证据 + 四站点独立记录。 */
  async runValidation(opts: ValidationOptions): Promise<ValidationRun> {
    const startedAt = new Date().toISOString();
    const steps: StageResult[] = [];
    const sites: SiteResult[] = [];
    const push = (stage: PocStage, ok: boolean, error: string | null = null, detail?: unknown) =>
      steps.push({ stage, ok, error, detail });

    const finish = (
      ok: boolean,
      finalStage: PocStage,
      error: string | null,
      partition: string | null,
      persistence: string | null,
      storagePath: string | null,
      webviewPartition: string | null,
      extIds: string[],
      extLocations: string[]
    ): ValidationRun => {
      const run: ValidationRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        ok,
        finalStage,
        error,
        partition,
        sessionPersistence: persistence,
        sessionStoragePath: storagePath,
        webviewPartition,
        extensionIds: extIds,
        extensionLocations: extLocations,
        eventSubscription: this.bridge.extensionEventSubscriptionError
          ? { ok: false, error: this.bridge.extensionEventSubscriptionError }
          : { ok: true, error: null },
        eventRecords: this.bridge.extensionEventRecords.map((r) => ({ ...r })),
        eventCounts: { ...this.bridge.extensionEventCounts },
        steps,
        sites,
      };
      return run;
    };

    const failNow = (
      stage: PocStage,
      error: string,
      partition: string | null = null,
      persistence: string | null = null,
      storagePath: string | null = null,
      detail?: unknown
    ): ValidationRun => {
      push(stage, false, error, detail);
      this.log.error("VALIDATION", stage, error);
      return finish(false, stage, error, partition, persistence, storagePath, null, [], []);
    };

    // ---- 阶段 1: ENVIRONMENT ----
    const appAny = this.app as any;
    if (appAny == null || typeof appAny.getWebviewPartition !== "function") {
      return failNow("ENVIRONMENT", "app.getWebviewPartition 不存在");
    }
    push("ENVIRONMENT", true);

    // ---- 阶段 2: PARTITION ----
    let partition: string;
    try {
      partition = String(appAny.getWebviewPartition() ?? "");
    } catch (e) {
      return failNow("PARTITION", "getWebviewPartition() 抛错: " + errorMessage(e));
    }
    if (!partition) {
      return failNow("PARTITION", "getWebviewPartition() 返回空 partition");
    }
    const persistence = partition.startsWith("persist:")
      ? "persistent"
      : partition === ""
        ? "default"
        : "in-memory";
    push("PARTITION", true, null, { partition, persistence });

    // ---- 阶段 3: SESSION ----
    const st = await this.bridge.detect();
    if (!st.ok) {
      return failNow("SESSION", st.failure ?? "Session 检测失败", partition, persistence);
    }
    push("SESSION", true, null, {
      storagePath: st.storagePath,
      remoteAvailable: st.remoteAvailable,
      extensionsApiAvailable: st.extensionsApiAvailable,
      loadExtensionApiAvailable: st.loadExtensionApiAvailable,
    });

    // 订阅生命周期事件（尽力而为；失败只如实记录，不阻塞后续验证）。
    const eventSub = this.bridge.subscribeToExtensionEvents();
    push("SESSION", true, null, { eventSubscription: eventSub });

    // ---- 阶段 4: EXTENSION_LOAD ----
    let extId: string | null = opts.alreadyLoadedId ?? null;
    if (!extId) {
      const res = await this.bridge.loadExtension(opts.extensionPath, opts.allowFileAccess);
      if (!res.ok || !res.extension) {
        return failNow(
          "EXTENSION_LOAD",
          res.error ?? "loadExtension 失败",
          partition,
          persistence,
          st.storagePath,
          {
            path: opts.extensionPath,
            warnings: res.warnings ?? [],
            message: res.error ?? null,
          }
        );
      }
      extId = res.extension.id;
      push("EXTENSION_LOAD", true, null, {
        id: extId,
        name: res.extension.name,
        version: res.extension.version,
      });
    } else {
      push("EXTENSION_LOAD", true, null, { reusedId: extId });
    }

    // ---- 阶段 5: EXTENSION_VERIFY（getAllExtensions 运行时证据） ----
    const allExts = await this.bridge.getLoadedExtensions();
    const found = allExts.find((e) => e.id === extId);
    if (!found) {
      return failNow(
        "EXTENSION_VERIFY",
        "loadExtension 声称成功，但 getAllExtensions 未返回 " + extId,
        partition,
        persistence,
        st.storagePath
      );
    }
    const extIds = allExts.map((e) => e.id);
    const extLocations = allExts.map((e) => e.location || e.path || "(unknown)");
    push("EXTENSION_VERIFY", true, null, {
      count: allExts.length,
      list: allExts.map((e: FullExtensionInfo) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        location: e.location || e.path || "(unknown)",
      })),
    });

    // ---- 逐站点验证（独立记录，互不影响） ----
    let webviewPartition: string | null = null;
    for (const url of opts.sites) {
      const site = await this.validateSite(url, partition, extId ?? "");
      if (site.webviewPartition != null && site.webviewPartition !== "") {
        webviewPartition = site.webviewPartition;
      }
      sites.push(site);
    }

    const allSitePass = sites.length > 0 && sites.every((s) => s.finalStage === "PASS" && s.error == null);
    if (!allSitePass) {
      const msg = "存在失败站点，详见 sites";
      push("FAIL", false, msg);
      this.log.error("VALIDATION", msg);
      return finish(false, "FAIL", msg, partition, persistence, st.storagePath, webviewPartition, extIds, extLocations);
    }
    push("PASS", true);
    this.log.info("VALIDATION", "PASS");
    return finish(true, "PASS", null, partition, persistence, st.storagePath, webviewPartition, extIds, extLocations);
  }

  /** 单 URL 快捷验证（旧接口兼容，结果仍写 data.json）。 */
  async run(url: string, timeoutMs = MAX_PAGE_WAIT_MS): Promise<PocResult> {
    const base: PocResult = {
      url,
      opened: false,
      pageLoaded: false,
      markerFound: false,
      titlePrefixed: false,
      title: "",
      markerValue: null,
      error: null,
    };
    try {
      const opened = await this.openWebViewerFor(url);
      if (!opened.leaf || !opened.webview) {
        base.error = opened.error ?? "webview 元素未出现";
        if (opened.leaf) base.opened = true;
        return base;
      }
      base.opened = true;
      const wvPart = this.readWebviewPartition(opened.leaf, opened.webview);
      this.log.info(
        "POC partition 对比:",
        "app=" + (this.bridge.partition ?? "null"),
        "webview=" + (wvPart ?? "unknown")
      );
      base.pageLoaded = await this.waitForPageLoad(opened.webview, timeoutMs);
      if (!base.pageLoaded) {
        base.error = "页面加载超时";
        return base;
      }
      await sleep(800);
      const probe = await this.probePage(opened.webview);
      base.markerValue = probe.marker === "true" ? "true" : probe.marker;
      base.markerFound = probe.marker === "true";
      base.title = probe.title;
      base.titlePrefixed = typeof probe.title === "string" && probe.title.startsWith("[EXT-TEST]");
      this.log.info("POC 检查结果:", JSON.stringify(base));
      return base;
    } catch (e) {
      base.error = errorMessage(e);
      this.log.error("POC 执行异常:", base.error);
      return base;
    }
  }

  /** 单站点验证：WEBVIEW → PAGE_LOAD → CONTENT_SCRIPT → LOCALSTORAGE → DOM_MARKER → TITLE_MARKER。 */
  private async validateSite(
    url: string,
    expectedPartition: string | null,
    extId: string
  ): Promise<SiteResult> {
    const site: SiteResult = {
      url,
      opened: false,
      webviewAvailable: false,
      webviewPartitionMatch: "UNKNOWN",
      webviewPartition: null,
      pageLoaded: false,
      extensionInjected: false,
      localStorageShared: false,
      domMarkerFound: false,
      titlePrefixed: false,
      title: "",
      finalStage: "WEBVIEW",
      error: null,
    };
    const fail = (stage: PocStage, error: string) => {
      site.finalStage = stage;
      site.error = error;
      this.log.warn("VALIDATION_SITE", url, stage, error);
      return site;
    };

    const opened = await this.openWebViewerFor(url);
    if (!opened.leaf) return fail("WEBVIEW", opened.error ?? "打开 Web Viewer 失败");
    site.opened = true;
    if (!opened.webview) return fail("WEBVIEW", opened.error ?? "webview 元素在超时时间内未出现");
    site.webviewAvailable = true;

    // 运行时证据：<webview>.partition 与 getWebviewPartition 比对（MATCH/MISMATCH/UNKNOWN）
    const wvPart = this.readWebviewPartition(opened.leaf, opened.webview);
    site.webviewPartition = wvPart;
    if (expectedPartition == null || wvPart == null || wvPart === "") {
      site.webviewPartitionMatch = "UNKNOWN";
    } else {
      site.webviewPartitionMatch = wvPart === expectedPartition ? "MATCH" : "MISMATCH";
    }
    if (site.webviewPartitionMatch === "MISMATCH") {
      return fail(
        "WEBVIEW",
        "webview.partition=" + (wvPart ?? "null") + " 与 getWebviewPartition=" + (expectedPartition ?? "null") + " 不一致"
      );
    }

    const loaded = await this.waitForPageLoad(opened.webview, MAX_PAGE_WAIT_MS);
    if (!loaded) return fail("PAGE_LOAD", "页面加载超时（30s）");
    site.pageLoaded = true;

    const probe = await this.probePage(opened.webview);
    site.finalStage = "CONTENT_SCRIPT";
    if (!probe.winMarkerInjected) {
      return fail("CONTENT_SCRIPT", "window.__WEB_EXTENSION_BRIDGE_TEST__ 未注入");
    }
    site.extensionInjected = true;

    site.finalStage = "LOCALSTORAGE";
    if (!probe.localStorageShared) {
      return fail("LOCALSTORAGE", "content script 写入的 localStorage 不可读（同页面上下文证据缺失）");
    }
    site.localStorageShared = true;

    site.finalStage = "DOM_MARKER";
    if (probe.marker !== "true") {
      return fail("DOM_MARKER", "data-obsidian-extension-test 未找到");
    }
    site.domMarkerFound = true;

    site.finalStage = "TITLE_MARKER";
    if (!probe.title.startsWith("[EXT-TEST]")) {
      return fail("TITLE_MARKER", "标题未加 [EXT-TEST] 前缀");
    }
    site.titlePrefixed = true;
    site.title = probe.title;

    site.finalStage = "PASS";
    site.error = null;
    this.log.info(
      "VALIDATION_SITE",
      "PASS",
      url,
      "ext",
      extId,
      "partitionMatch",
      site.webviewPartitionMatch
    );
    return site;
  }

  /** 打开 Web Viewer：等 layout 就绪 → 新 leaf → 等 webview 元素出现。 */
  private async openWebViewerFor(url: string): Promise<{
    leaf: WorkspaceLeaf | null;
    webview: any | null;
    error: string | null;
  }> {
    const layoutOk = await this.waitForLayoutReady(MAX_LAYOUT_WAIT_MS);
    if (!layoutOk) {
      return { leaf: null, webview: null, error: "workspace 布局未就绪（layout ready 超时）" };
    }
    let leaf: WorkspaceLeaf;
    try {
      leaf = this.openWebViewer(url);
    } catch (e) {
      return { leaf: null, webview: null, error: "打开 Web Viewer 失败: " + errorMessage(e) };
    }
    const webview = await this.waitForWebview(leaf, MAX_WEBVIEW_WAIT_MS);
    if (!webview) {
      return { leaf, webview: null, error: "webview 元素在超时时间内未出现" };
    }
    return { leaf, webview, error: null };
  }

  /** 等待 workspace onLayoutReady（Obsidian 文档：已就绪时立即回调）。 */
  private async waitForLayoutReady(timeoutMs: number): Promise<boolean> {
    const ws = (this.app as any).workspace;
    if (!ws || typeof ws.onLayoutReady !== "function") return true; // 兼容未知版本
    return new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(false);
        }
      }, timeoutMs);
      try {
        ws.onLayoutReady(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true);
        });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(true); // 回调注册失败不阻塞验证
        }
      }
    });
  }

  /** 与 Obsidian 的 webviewer:open 命令一致：新 leaf + setViewState。 */
  private openWebViewer(url: string): WorkspaceLeaf {
    const leaf = this.app.workspace.getLeaf(true);
    leaf.setViewState({
      type: WEBVIEWER_VIEW_TYPE,
      state: { url, navigate: true },
    });
    return leaf;
  }

  private async waitForWebview(leaf: WorkspaceLeaf, timeoutMs: number): Promise<any | null> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const view = leaf.view as any;
      if (view && view.webview && typeof view.webview.executeJavaScript === "function") {
        return view.webview;
      }
      await sleep(250);
    }
    return null;
  }

  private async waitForPageLoad(webview: any, timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (typeof webview.isLoading !== "function" || !webview.isLoading()) {
          return true;
        }
      } catch {
        return true; // isLoading 不可用时不阻塞
      }
      await sleep(500);
    }
    return false;
  }

  /** 读取 <webview> 的 partition（运行时证据，与 getWebviewPartition 比对）。 */
  private readWebviewPartition(leaf: WorkspaceLeaf, webview: any): string | null {
    const found: string[] = [];
    try {
      if (typeof webview.getAttribute === "function") {
        const v = webview.getAttribute("partition");
        if (v) found.push(String(v));
      }
    } catch {
      // ignore
    }
    try {
      const view = leaf.view as any;
      const el = view?.containerEl?.querySelector?.("webview");
      if (el) {
        const v = el.getAttribute("partition");
        if (v) found.push(String(v));
      }
    } catch {
      // ignore
    }
    if (found.length === 0) return null;
    return found[0];
  }

  /** executeJavaScript 探针：一次性读取所有标记（含辅助的 localStorage 证据）。 */
  private async probePage(webview: any): Promise<{
    marker: string | null;
    title: string;
    winMarkerInjected: boolean;
    localStorageShared: boolean;
    raw: string;
  }> {
    const script = `(() => {
      const marker = (document.documentElement && document.documentElement.getAttribute("data-obsidian-extension-test")) || null;
      const winMarker = window.__WEB_EXTENSION_BRIDGE_TEST__ || null;
      let lsValue = null;
      try {
        lsValue = window.localStorage.getItem("__web_extension_bridge_poc");
      } catch (e) {
        lsValue = "__localStorage_read_error__";
      }
      return JSON.stringify({
        marker: marker,
        winInjected: !!(winMarker && winMarker.injected),
        lsShared: !!lsValue,
        title: document.title || "",
        href: location.href
      });
    })()`;
    let raw = "";
    try {
      raw = String(await webview.executeJavaScript(script));
    } catch (e) {
      this.log.warn("probePage executeJavaScript 失败:", errorMessage(e));
      raw = "";
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw };
    }
    return {
      marker: parsed?.marker ?? null,
      title: parsed?.title ?? "",
      winMarkerInjected: !!parsed?.winInjected,
      localStorageShared: !!parsed?.lsShared,
      raw,
    };
  }
}
