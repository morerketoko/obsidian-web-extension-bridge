import { Notice, Plugin } from "obsidian";
import * as path from "path";
import { BridgeLogger } from "./logger";
import { detectEnvironment, EnvironmentInfo } from "./env";
import {
  LoadResult,
  WebViewerSessionBridge,
} from "./session-bridge";
import { confirmExtensionTrust } from "./trust";
import { PocTester, DEFAULT_VALIDATION_SITES } from "./poc";
import type { PocResult, ValidationRun } from "./poc";
import { BridgeSettingTab } from "./settings";

interface BridgeSettings {
  debug: boolean;
  /** 用户是否已明确信任并启用过 test-extension（安全闸门）。 */
  testExtensionTrusted: boolean;
  /** 只有用户明确开启才允许 extension 访问 file://（默认 false）。 */
  allowFileAccess: boolean;
  /** 最近一次成功加载的扩展 id（用于启动恢复）。 */
  lastLoadedId: string | null;
  /** 最近一次加载失败的结构化原因（持久化，便于无终端排查）。 */
  lastLoadError: string | null;
  /** 启动时自动运行一次单 URL POC（留空则关闭）。 */
  autoRunPocUrl: string | null;
  /** 最近一次单 URL POC 结果。 */
  lastPocResult: PocResult | null;
  /** 启动时自动运行完整验证（状态机 + 四站点）。 */
  autoRunValidation: boolean;
  /** 完整验证站点列表（默认四站点）。 */
  validationSites: string[];
  /** 最近一次完整验证结果（会话证据 + 状态机步骤 + 逐站点记录）。 */
  lastValidationRun: ValidationRun | null;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  debug: false,
  testExtensionTrusted: false,
  allowFileAccess: false,
  lastLoadedId: null,
  lastLoadError: null,
  autoRunPocUrl: null,
  lastPocResult: null,
  autoRunValidation: false,
  validationSites: [...DEFAULT_VALIDATION_SITES],
  lastValidationRun: null,
};

const POC_URL = "https://example.com";

export default class WebExtensionBridgePlugin extends Plugin {
  log = new BridgeLogger();
  env: EnvironmentInfo = detectEnvironment();
  bridge = new WebViewerSessionBridge(this.app, this.log);
  poc = new PocTester(this.app, this.bridge, this.log);
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  testExtPath = "";
  loadedExtensionId: string | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 兼容旧 data.json：没有 validationSites 时补默认值
    if (!Array.isArray(this.settings.validationSites) || this.settings.validationSites.length === 0) {
      this.settings.validationSites = [...DEFAULT_VALIDATION_SITES];
    }
    this.log.setDebug(this.settings.debug);
    this.env = detectEnvironment();
    this.testExtPath = path.join((this.manifest as any).dir || "", "test-extension");

    this.log.info(
      "插件加载。",
      "Obsidian", this.env.obsidianVersion,
      "| Electron", this.env.electronVersion,
      "| Chrome", this.env.chromeVersion,
      "| Platform", this.env.platform
    );

    // 环境与 Session 检测（feature detect；失败不崩溃，只提示不兼容）
    const st = await this.bridge.detect();
    if (!st.ok) {
      new Notice("Web Extension Bridge is not compatible with this Obsidian/Electron version.");
      this.addSettingTab(new BridgeSettingTab(this.app, this));
      return;
    }

    // 状态驱动启动流程：等 layout 就绪后再恢复扩展与自动验证，
    // 避免 workspace 未就绪时 getLeaf(true) 抛 "No tab group found."。
    this.app.workspace.onLayoutReady(() => {
      const doStartup = async () => {
        // Electron 不跨启动保留扩展；用户已确认过时启动自动恢复
        if (this.settings.testExtensionTrusted) {
          const res = await this.loadTestExtension(true);
          if (res.ok) {
            this.log.info("启动恢复：test-extension 已重新加载。");
          } else {
            this.log.warn("启动恢复失败：", res.error ?? "");
          }
        }

        // 诊断模式 1：启动后自动跑单 URL POC（结果写 lastPocResult）
        const autoUrl = this.settings.autoRunPocUrl;
        if (autoUrl) {
          void this.runPoc(autoUrl);
        }

        // 诊断模式 2：启动后自动跑完整验证（结果写 lastValidationRun）
        if (this.settings.autoRunValidation) {
          void this.runValidation();
        }
      };
      void doStartup();
    });

    this.addSettingTab(new BridgeSettingTab(this.app, this));
    this.addCommand({
      id: "run-poc-example",
      name: "运行 Web Extension Bridge POC 测试（example.com）",
      callback: () => {
        void this.runPoc(POC_URL);
      },
    });
    this.addCommand({
      id: "run-validation",
      name: "运行 Web Extension Bridge 完整验证（4 站点）",
      callback: () => {
        void this.runValidation();
      },
    });
  }

  onunload() {
    // 可逆性：卸载我们加载的扩展，避免污染 Web Viewer Session
    if (this.loadedExtensionId) {
      void this.bridge.unloadExtension(this.loadedExtensionId);
      this.log.info("onunload：已请求卸载", this.loadedExtensionId);
    }
  }

  /** 安全闸门 + 加载 test-extension 到 Web Viewer Session。 */
  async loadTestExtension(skipConfirm = false): Promise<LoadResult> {
    if (!this.bridge.statusSnapshot?.ok) {
      new Notice("Web Extension Bridge：Session 不可用，无法加载扩展。");
      return { ok: false, error: "Session 不可用", warnings: [] };
    }

    if (!skipConfirm && !this.settings.testExtensionTrusted) {
      const manifest = this.readTestExtensionManifest();
      const confirmed = await confirmExtensionTrust(this.app, {
        name: manifest?.name ?? "Obsidian WebView Extension Test",
        path: this.testExtPath,
        version: manifest?.version ?? "",
        hostPermissions: manifest?.host_permissions ?? [],
        permissions: manifest?.permissions ?? [],
      });
      if (!confirmed) {
        new Notice("Web Extension Bridge：已取消启用 test-extension。");
        return { ok: false, error: "用户取消", warnings: ["用户未确认信任"] };
      }
      this.settings.testExtensionTrusted = true;
    }

    const res = await this.bridge.loadExtension(
      this.testExtPath,
      this.settings.allowFileAccess
    );

    if (res.ok && res.extension) {
      this.loadedExtensionId = res.extension.id;
      this.settings.lastLoadedId = res.extension.id;
      this.settings.lastLoadError = null;
      await this.saveData(this.settings);
      new Notice(`Web Extension Bridge：已加载 ${res.extension.name}（${res.extension.id}）`);
    } else {
      this.settings.lastLoadError = res.error ?? "loadExtension 失败（详见 warnings）";
      await this.saveData(this.settings);
      new Notice("Web Extension Bridge：扩展加载失败，详见控制台日志。");
    }

    this.logLoadResult(res);
    return res;
  }

  async unloadTestExtension(): Promise<boolean> {
    if (!this.loadedExtensionId) return false;
    const ok = await this.bridge.unloadExtension(this.loadedExtensionId);
    if (ok) {
      this.loadedExtensionId = null;
      this.settings.lastLoadedId = null;
      await this.saveData(this.settings);
      new Notice("Web Extension Bridge：已卸载 test-extension。");
    } else {
      new Notice("Web Extension Bridge：卸载失败，详见控制台日志。");
    }
    return ok;
  }

  /** 单 URL POC：打开 URL → 等加载 → 检查 content script 是否生效。 */
  async runPoc(url: string): Promise<void> {
    new Notice("Web Extension Bridge：开始 POC 测试，请观察新打开的 Web Viewer 标签页。");
    const result = await this.poc.run(url);
    this.settings.lastPocResult = result;
    await this.saveData(this.settings);
    const lines = [
      `Web Extension Bridge POC: ${result.url}`,
      `页面打开: ${result.opened ? "是" : "否"}`,
      `页面加载完成: ${result.pageLoaded ? "是" : "否"}`,
      `DOM 标记 data-obsidian-extension-test="true": ${result.markerFound ? "是" : "否"}`,
      `标题已加 [EXT-TEST] 前缀: ${result.titlePrefixed ? "是" : "否"}`,
      `当前标题: ${result.title}`,
    ];
    if (result.error) lines.push(`错误: ${result.error}`);
    new Notice(lines.join("\n"), 12000);
  }

  /** 完整验证：状态机 + 四站点 + 生命周期事件证据，结果持久化到 data.json。 */
  async runValidation(): Promise<void> {
    new Notice("Web Extension Bridge：开始完整验证（默认 4 站点），请观察新打开的 Web Viewer 标签页。");
    const sites =
      this.settings.validationSites.length > 0
        ? this.settings.validationSites
        : DEFAULT_VALIDATION_SITES;
    const run = await this.poc.runValidation({
      sites,
      extensionPath: this.testExtPath,
      allowFileAccess: this.settings.allowFileAccess,
      alreadyLoadedId: this.loadedExtensionId,
    });
    this.settings.lastValidationRun = run;
    await this.saveData(this.settings);

    const siteLines = run.sites.map((s) => {
      const parts = [
        s.url,
        `open=${s.opened ? "Y" : "N"}`,
        `webview=${s.webviewAvailable ? "Y" : "N"}`,
        `load=${s.pageLoaded ? "Y" : "N"}`,
        `inject=${s.extensionInjected ? "Y" : "N"}`,
        `dom=${s.domMarkerFound ? "Y" : "N"}`,
        `title=${s.titlePrefixed ? "Y" : "N"}`,
      ];
      if (s.error) parts.push(`err=${s.error}`);
      return parts.join(" ");
    });
    const lines = [
      `Web Extension Bridge 完整验证: ${run.ok ? "PASS" : "FAIL@" + run.finalStage}`,
      `partition=${run.partition ?? "null"} | webview=${run.webviewPartition ?? "UNKNOWN"}`,
      `事件订阅: ${run.eventSubscription.ok ? "成功" : run.eventSubscription.error ?? "失败"}`,
      `扩展: ${run.extensionIds.join(",") || "(无)"}`,
      ...siteLines,
    ];
    if (run.error) lines.push(`错误: ${run.error}`);
    new Notice(lines.join("\n"), 20000);
  }

  private readTestExtensionManifest(): any {
    try {
      const fs = require("fs");
      const raw = fs.readFileSync(path.join(this.testExtPath, "manifest.json"), "utf8");
      return JSON.parse(raw);
    } catch (e) {
      this.log.warn("读取 test-extension manifest 失败:", String(e));
      return null;
    }
  }

  private logLoadResult(res: LoadResult) {
    const st = this.bridge.statusSnapshot;
    this.log.info(
      "LOAD_RESULT",
      JSON.stringify({
        obsidianVersion: this.env.obsidianVersion,
        electronVersion: this.env.electronVersion,
        chromeVersion: this.env.chromeVersion,
        webViewerAvailability: st?.ok ? "available" : "unavailable",
        partitionName: this.bridge.partition,
        sessionPersistence: st?.persistence ?? null,
        sessionStoragePath: st?.storagePath ?? null,
        extensionPath: this.testExtPath,
        extensionId: res.extension?.id ?? this.settings.lastLoadedId ?? null,
        extensionLoadResult: res.ok ? "OK" : "FAIL",
        extensionWarnings: res.warnings ?? [],
        failureReason: res.error ?? null,
      })
    );
  }
}
