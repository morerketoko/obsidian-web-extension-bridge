import { Notice, Plugin } from "obsidian";
import * as path from "path";
import { BridgeLogger } from "./logger";
import { detectEnvironment, EnvironmentInfo } from "./env";
import {
  LoadResult,
  WebViewerSessionBridge,
} from "./session-bridge";
import { confirmExtensionTrust } from "./trust";
import { PocTester } from "./poc";
import type { PocResult } from "./poc";
import { BridgeSettingTab } from "./settings";

interface BridgeSettings {
  debug: boolean;
  /** 用户是否已明确信任并启用过 test-extension（安全闸门）。 */
  testExtensionTrusted: boolean;
  /** 只有用户明确开启才允许 extension 访问 file://（默认 false）。 */
  allowFileAccess: boolean;
  /** 最近一次成功加载的扩展 id（用于启动恢复）。 */
  lastLoadedId: string | null;
  /** 启动时自动运行一次 POC（诊断/自动化验证用，留空则关闭）。 */
  autoRunPocUrl: string | null;
  /** 最近一次 POC 测试结果（写入 data.json 便于无终端验证）。 */
  lastPocResult: PocResult | null;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  debug: false,
  testExtensionTrusted: false,
  allowFileAccess: false,
  lastLoadedId: null,
  autoRunPocUrl: null,
  lastPocResult: null,
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

    // Electron 不跨启动保留扩展；如果用户已确认过，启动时自动恢复
    if (this.settings.testExtensionTrusted) {
      const res = await this.loadTestExtension(true);
      if (res.ok) {
        this.log.info("启动恢复：test-extension 已重新加载。");
      } else {
        this.log.warn("启动恢复失败：", res.error ?? "");
      }
    }

    // 诊断模式：启动后自动打开一个 URL 做 POC 检查（结果写入 lastPocResult）
    const autoUrl = this.settings.autoRunPocUrl;
    if (autoUrl) {
      setTimeout(() => {
        void this.runPoc(autoUrl);
      }, 3000);
    }

    this.addSettingTab(new BridgeSettingTab(this.app, this));
    this.addCommand({
      id: "run-poc-example",
      name: "运行 Web Extension Bridge POC 测试（example.com）",
      callback: () => {
        void this.runPoc(POC_URL);
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
      await this.saveData(this.settings);
      new Notice(`Web Extension Bridge：已加载 ${res.extension.name}（${res.extension.id}）`);
    } else {
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

  /** 一键 POC：打开 URL → 等待加载 → 检查 content script 是否生效。 */
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
