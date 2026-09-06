import { Notice, Plugin } from "obsidian";
import * as path from "path";
import { BridgeLogger } from "./logger";
import { detectEnvironment, EnvironmentInfo } from "./env";
import {
  LoadResult,
  WebViewerSessionBridge,
} from "./session-bridge";
import { PocTester, DEFAULT_VALIDATION_SITES } from "./poc";
import type { PocResult, ValidationRun } from "./poc";
import { ExtensionManager, ManagedExtension } from "./extension-manager";
import { PopupHost, PopupProbeReport, registerPopupHostView } from "./popup-host";
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
  /** 托管扩展列表（Extension Manager，Phase 2）。 */
  managedExtensions: ManagedExtension[];
  /** 最近一次 Popup Host 探针报告（Phase 2.5）。 */
  lastPopupProbe: PopupProbeReport | null;
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
  managedExtensions: [],
  lastPopupProbe: null,
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
  manager!: ExtensionManager;
  popupHost!: PopupHost;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 兼容旧 data.json：没有 validationSites 时补默认值
    if (!Array.isArray(this.settings.validationSites) || this.settings.validationSites.length === 0) {
      this.settings.validationSites = [...DEFAULT_VALIDATION_SITES];
    }
    this.log.setDebug(this.settings.debug);
    this.env = detectEnvironment();
    this.testExtPath = this.resolveTestExtensionPath();

    // Extension Manager：托管记录任何变更都立即回写 data.json
    this.manager = new ExtensionManager(this.app, this.bridge, this.log, () => {
      this.settings.managedExtensions = this.manager.list;
      void this.saveData(this.settings);
    });
    this.manager.setList(this.settings.managedExtensions);

    // Phase 2.5：旧 data.json 缺 executionMode/activationStatus 时补默认
    for (const item of this.manager.list) {
      if (!item.executionMode) {
        item.executionMode = item.report?.executionMode ?? "UNKNOWN";
      }
      if (!item.activationStatus) {
        item.activationStatus =
          item.report?.executionMode === "POPUP_ACTION" ? "LOADED_NO_UI_ENTRY" : "UNKNOWN";
      }
    }
    this.settings.managedExtensions = this.manager.list;
    void this.saveData(this.settings);

    // Popup Host（Phase 2.5 实验）
    this.popupHost = new PopupHost(this.app, this.log);
    registerPopupHostView(
      (type, creator) => this.registerView(type, creator),
      this.log
    );

    this.log.info(
      "插件加载。",
      "Obsidian", this.env.obsidianVersion,
      "| Electron", this.env.electronVersion,
      "| Chrome", this.env.chromeVersion,
      "| Platform", this.env.platform,
      "| testExtPath", this.testExtPath
    );

    // 环境与 Session 检测（feature detect；失败不崩溃，只提示不兼容）
    const st = await this.bridge.detect();
    if (!st.ok) {
      new Notice("Web Extension Bridge is not compatible with this Obsidian/Electron version.");
      this.addSettingTab(new BridgeSettingTab(this.app, this));
      return;
    }

    // 迁移旧版 testExtensionTrusted（Phase 1 data.json）→ 托管列表
    if (this.settings.testExtensionTrusted && this.testExtPath) {
      if (!this.manager.findByFolder(this.testExtPath)) {
        const mig = await this.manager.import(this.testExtPath);
        if (mig.ok) {
          this.manager.patchItem(this.testExtPath, {
            trusted: true,
            enabled: true,
            allowFileAccess: this.settings.allowFileAccess,
          });
          this.log.info("已迁移 testExtensionTrusted → 扩展管理列表:", this.testExtPath);
        } else {
          this.log.warn("迁移 test-extension 失败:", mig.error ?? "");
        }
      }
    }

    // 状态驱动启动流程：等 layout 就绪后再恢复扩展与自动验证，
    // 避免 workspace 未就绪时 getLeaf(true) 抛 "No tab group found."。
    this.app.workspace.onLayoutReady(() => {
      const doStartup = async () => {
        // Electron 不跨启动保留扩展；按托管列表恢复所有已启用且已信任的扩展
        const startupRes = await this.manager.startup();
        if (startupRes.loaded > 0 || startupRes.failed > 0) {
          this.log.info("启动恢复完成:", JSON.stringify(startupRes));
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
    this.addCommand({
      id: "reload-all-extensions",
      name: "重载全部已启用扩展",
      callback: () => {
        void (async () => {
          const r = await this.manager.reloadAll();
          new Notice(`Web Extension Bridge：重载完成（成功 ${r.loaded}，失败 ${r.failed}）`);
        })();
      },
    });
    this.addCommand({
      id: "open-popup-experiment",
      name: "实验：打开当前扩展 Popup",
      callback: () => {
        void this.openFirstPopup();
      },
    });
  }

  onunload() {
    // 可逆性：卸载我们加载的扩展，避免污染 Web Viewer Session
    if (this.popupHost) {
      this.popupHost.onunload();
    }
    if (this.manager) {
      void this.manager.unloadAll();
      this.log.info("onunload：已请求卸载全部托管扩展。");
    }
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

    if (!this.testExtPath) {
      return { ok: false, error: "test-extension 路径为空", warnings: [] };
    }
    if (!this.manager.findByFolder(this.testExtPath)) {
      const imp = await this.manager.import(this.testExtPath);
      if (!imp.ok) {
        new Notice("Web Extension Bridge：导入 test-extension 失败：" + (imp.error ?? ""));
        return { ok: false, error: imp.error ?? "导入失败", warnings: [] };
      }
    }

    const res = await this.manager.enable(this.testExtPath, { skipConfirm });

    // 兼容旧字段：确认信任后回写旧 testExtensionTrusted
    if (this.manager.findByFolder(this.testExtPath)?.trusted) {
      this.settings.testExtensionTrusted = true;
    }

    if (res.ok && res.extension) {
      this.loadedExtensionId = res.extension.id;
      this.settings.lastLoadedId = res.extension.id;
      this.settings.lastLoadError = null;
      await this.saveData(this.settings);
      new Notice(`Web Extension Bridge：已加载 ${res.extension.name}（${res.extension.id}）`);
    } else {
      this.loadedExtensionId = null;
      this.settings.lastLoadError = res.error ?? "loadExtension 失败（详见 warnings）";
      await this.saveData(this.settings);
      new Notice("Web Extension Bridge：扩展加载失败，详见控制台日志。");
    }

    this.logLoadResult(res);
    return res;
  }

  async unloadTestExtension(): Promise<boolean> {
    if (!this.testExtPath) return false;
    const ok = await this.manager.disable(this.testExtPath);
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

  /** 打开第一个已加载的 POPUP_ACTION/MIXED 扩展的 popup（最小 POC 入口）。 */
  async openFirstPopup(): Promise<void> {
    const candidates = this.manager.list.filter(
      (i) =>
        i.lastLoadedId &&
        (i.report?.executionMode === "POPUP_ACTION" || i.report?.executionMode === "MIXED")
    );
    const target = candidates[0];
    if (!target) {
      new Notice("Web Extension Bridge：未找到已加载且带 popup 的扩展。");
      return;
    }
    await this.openPopupFor(target.folder);
  }

  /** 打开指定托管扩展的 popup（Popup Host 实验）。 */
  async openPopupFor(folder: string): Promise<void> {
    const item = this.manager.findByFolder(folder);
    if (!item || !item.lastLoadedId) {
      new Notice("Web Extension Bridge：扩展未加载，无法打开 Popup。");
      return;
    }
    const popupPath = this.getPopupPath(item.folder);
    if (!popupPath) {
      new Notice("Web Extension Bridge：该扩展没有 default_popup。");
      return;
    }
    const rep = await this.popupHost.open(item.lastLoadedId, popupPath, this.bridge.partition);
    this.settings.lastPopupProbe = rep;
    await this.saveData(this.settings);
    if (rep.domReady && !rep.loadFailed) {
      this.manager.patchItem(item.folder, { activationStatus: "POPUP_AVAILABLE" });
    }
    new Notice(
      `Web Extension Bridge：Popup ${rep.popupAvailable ? "已打开" : "打开失败"}（${rep.url}）`,
      8000
    );
  }

  private getPopupPath(folder: string): string | null {
    try {
      const fs = require("fs");
      const m = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
      const p = m?.action?.default_popup ?? m?.browser_action?.default_popup;
      return typeof p === "string" && p ? p : null;
    } catch {
      return null;
    }
  }

  /**
   * 第 15 节轻量诊断：区分 "Bridge 失败" 与 "扩展自身功能失败"。
   * 只聚合已有运行证据，不做代测、不发起翻译请求。
   */
  diagnoseInjection(): string[] {
    const managed = this.manager.list;
    const anyLoaded = managed.some((i) => i.enabled && !!i.lastLoadedId);
    const poc = this.settings.lastPocResult;
    const popup = this.settings.lastPopupProbe;
    return [
      `Extension load: ${anyLoaded ? "PASS" : "FAIL"}`,
      `Content script detected: ${
        poc ? (poc.markerFound ? "PASS" : "FAIL") : "N/A（需先运行 POC）"
      }`,
      `Extension UI detected: ${
        popup ? (popup.popupAvailable ? "PASS" : "FAIL") : "N/A（需先打开 Popup）"
      }`,
      "Network translation: UNKNOWN（翻译 API 属扩展自身证据，Bridge 不做代测）",
    ];
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

  /**
   * 解析 test-extension 的绝对路径。
   * 注意：manifest.dir 是 Obsidian 运行时字段，常见为 vault 相对路径
   * （如 ".obsidian/plugins/<id>"），Electron 的 loadExtension 只接受绝对路径，
   * 因此必须用 vault adapter.getBasePath() 拼出绝对路径。
   */
  private resolveTestExtensionPath(): string {
    let basePath = "";
    try {
      const adapter = (this.app.vault as any).adapter;
      if (adapter && typeof adapter.getBasePath === "function") {
        basePath = String(adapter.getBasePath() ?? "");
      }
    } catch {
      basePath = "";
    }
    const dirRaw = (this.manifest as any).dir ?? "";

    // 1) dir 已是绝对路径 → 直接用
    if (dirRaw && path.isAbsolute(dirRaw)) {
      return path.join(dirRaw, "test-extension");
    }
    // 2) dir 是 vault 相对路径 → 拼接 basePath
    if (dirRaw && basePath) {
      return path.join(basePath, dirRaw, "test-extension");
    }
    // 3) 兜底：标准 vault 插件目录
    if (basePath) {
      return path.join(basePath, ".obsidian", "plugins", this.manifest.id, "test-extension");
    }
    return path.join(dirRaw || this.manifest.id || "", "test-extension");
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
