import { App, WorkspaceLeaf } from "obsidian";
import { BridgeLogger } from "./logger";
import { WebViewerSessionBridge } from "./session-bridge";

// 来自 Obsidian 内部（app.js 常量 A4）的 Core Web Viewer 视图类型。
const WEBVIEWER_VIEW_TYPE = "webviewer";

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

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * POC 验证：在 Web Viewer 中打开 URL，等待加载，然后用
 * executeJavaScript 检查 test-extension 的 content script 是否真的执行。
 */
export class PocTester {
  constructor(
    private app: App,
    private bridge: WebViewerSessionBridge,
    private log: BridgeLogger
  ) {}

  async run(url: string, timeoutMs = 25000): Promise<PocResult> {
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
      const leaf = this.openWebViewer(url);
      base.opened = true;
      this.log.info("POC 已打开 Web Viewer:", url);

      const webview = await this.waitForWebview(leaf, 8000);
      if (!webview) {
        base.error = "webview 元素在超时时间内未出现";
        return base;
      }

      base.pageLoaded = await this.waitForPageLoad(webview, timeoutMs);
      // 给 content script（document_start 注入）留出执行时间
      await sleep(1500);

      const raw = await webview.executeJavaScript(
        "JSON.stringify({marker: document.documentElement.getAttribute('data-obsidian-extension-test'), title: document.title})"
      );
      let parsed: any = null;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        parsed = { raw: String(raw) };
      }
      base.markerValue = parsed.marker ?? null;
      base.markerFound = parsed.marker === "true";
      base.title = parsed.title ?? String(raw);
      base.titlePrefixed = typeof parsed.title === "string" && parsed.title.startsWith("[EXT-TEST]");
      this.log.info("POC 检查结果:", JSON.stringify(base));
      return base;
    } catch (e) {
      base.error = String((e as any)?.message ?? e);
      this.log.error("POC 执行异常:", base.error);
      return base;
    }
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
      const view = (leaf.view as any);
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
        // isLoading 不可用时不阻塞
        return true;
      }
      await sleep(500);
    }
    return false;
  }
}
