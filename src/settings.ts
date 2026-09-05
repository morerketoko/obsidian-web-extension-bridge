import { App, PluginSettingTab, Setting } from "obsidian";
import type WebExtensionBridgePlugin from "./main";

export class BridgeSettingTab extends PluginSettingTab {
  private pocUrl = "https://example.com";

  constructor(app: App, private plugin: WebExtensionBridgePlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Web Extension Bridge (POC)" });
    containerEl.createEl("p", {
      text:
        "Desktop only。将 unpacked Chrome/Chromium Extension 加载进 Core Web Viewer 的 Electron Session（Ext 会注入到 host permissions 允许的网页）。不修改 Media Extended / Obsidian 本体。",
    });

    const st = this.plugin.bridge.statusSnapshot;

    new Setting(containerEl)
      .setName("兼容性")
      .setDesc(
        st?.ok
          ? "兼容：已取得 Web Viewer Session"
          : "不兼容：" + (st?.failure ?? "未检测")
      )
      .setHeading();

    new Setting(containerEl).setName("Obsidian 版本").setDesc(this.plugin.env.obsidianVersion);
    new Setting(containerEl)
      .setName("Electron / Chrome")
      .setDesc(`${this.plugin.env.electronVersion} / ${this.plugin.env.chromeVersion}`);
    new Setting(containerEl)
      .setName("Web Viewer Session")
      .setDesc(
        st?.ok
          ? `partition: ${st.partition}（${st.persistence}）`
          : "不可用"
      );
    if (st?.ok) {
      new Setting(containerEl)
        .setName("Session 存储路径")
        .setDesc(st.storagePath ?? "（未知）");
      new Setting(containerEl)
        .setName("Extensions API")
        .setDesc(
          `extensions 对象: ${st.extensionsApiAvailable ? "可用" : "不可用"}；` +
            `loadExtension: ${st.loadExtensionApiAvailable ? "可用" : "不可用"}`
        );
    }

    containerEl.createEl("h3", { text: "测试扩展 (test-extension)" });
    new Setting(containerEl)
      .setName("路径")
      .setDesc(this.plugin.testExtPath)
      .setClass("mod-monospace");
    new Setting(containerEl)
      .setName("状态")
      .setDesc(
        this.plugin.loadedExtensionId
          ? `已加载: ${this.plugin.loadedExtensionId}`
          : "未加载"
      );
    if (this.plugin.settings.lastLoadError) {
      new Setting(containerEl)
        .setName("上次加载错误")
        .setDesc(this.plugin.settings.lastLoadError)
        .setClass("mod-monospace");
    }

    new Setting(containerEl)
      .addButton((b) =>
        b
          .setButtonText("加载测试扩展")
          .setCta()
          .onClick(() => {
            void this.plugin.loadTestExtension().then(() => this.display());
          })
      )
      .addButton((b) =>
        b
          .setButtonText("卸载测试扩展")
          .onClick(() => {
            void this.plugin.unloadTestExtension().then(() => this.display());
          })
      );

    containerEl.createEl("h3", { text: "POC 验证" });
    new Setting(containerEl)
      .setName("测试 URL")
      .setDesc("在 Web Viewer 中打开该页面，检查 content script 是否注入。")
      .addText((t) => {
        t.setValue(this.pocUrl);
        t.setPlaceholder("https://example.com");
        t.onChange((v) => (this.pocUrl = v));
      })
      .addButton((b) =>
        b.setButtonText("运行 POC 测试").setCta().onClick(async () => {
          await this.plugin.runPoc(this.pocUrl.trim() || "https://example.com");
          this.display();
        })
      );

    containerEl.createEl("h3", { text: "完整验证 (Runtime Validation)" });
    new Setting(containerEl)
      .setName("站点列表")
      .setDesc("逗号分隔的 URL；完整验证会按站点独立记录（默认四站点）。")
      .addText((t) => {
        t.setValue(this.plugin.settings.validationSites.join(", "));
        t.setPlaceholder("https://example.com, https://www.google.com");
        t.onChange(async (v) => {
          this.plugin.settings.validationSites = v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .slice(0, 8);
          await this.plugin.saveData(this.plugin.settings);
        });
      });
    new Setting(containerEl)
      .setName("启动时自动完整验证")
      .setDesc("重启后自动执行完整验证并把结果写入 data.json（无需开 DevTools 即可回读）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoRunValidation).onChange(async (v) => {
          this.plugin.settings.autoRunValidation = v;
          await this.plugin.saveData(this.plugin.settings);
        })
      );
    new Setting(containerEl)
      .setName("运行完整验证")
      .setDesc("按状态机执行：会话证据 → 扩展加载/验证 → 逐站点记录（含 webview partition 对比）。")
      .addButton((b) =>
        b.setButtonText("运行完整验证").setCta().onClick(async () => {
          await this.plugin.runValidation();
          this.display();
        })
      );
    const lastRun = this.plugin.settings.lastValidationRun;
    if (lastRun) {
      new Setting(containerEl)
        .setName("上次验证结果")
        .setDesc(
          `${lastRun.ok ? "PASS" : "FAIL@" + lastRun.finalStage} | ` +
            `partition=${lastRun.partition ?? "null"} | webview=${lastRun.webviewPartition ?? "UNKNOWN"} | ` +
            `事件订阅=${lastRun.eventSubscription.ok ? "成功" : "失败"} | ` +
            lastRun.sites.map((s) => `${s.url}:${s.finalStage}`).join(" · ")
        );
      new Setting(containerEl)
        .setName("上次验证错误")
        .setDesc(lastRun.error ?? "（无）")
        .setClass("mod-monospace");
    }

    containerEl.createEl("h3", { text: "选项" });
    new Setting(containerEl)
      .setName("调试日志 (DEBUG)")
      .setDesc("输出 [WebExtensionBridge] DEBUG 级别日志。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debug).onChange(async (v) => {
          this.plugin.settings.debug = v;
          this.plugin.log.setDebug(v);
          await this.plugin.saveData(this.plugin.settings);
        })
      );
    new Setting(containerEl)
      .setName("允许访问本地文件 (file://)")
      .setDesc("默认关闭。仅在明确信任该扩展时才开启。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowFileAccess).onChange(async (v) => {
          this.plugin.settings.allowFileAccess = v;
          await this.plugin.saveData(this.plugin.settings);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("启动时自动 POC 测试")
      .setDesc("留空关闭；填入 URL 后，插件启动会自动打开并检查 content script，结果写入 data.json。")
      .addText((t) => {
        t.setValue(this.plugin.settings.autoRunPocUrl ?? "");
        t.setPlaceholder("https://example.com");
        t.onChange(async (v) => {
          this.plugin.settings.autoRunPocUrl = v.trim() || null;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
  }
}
