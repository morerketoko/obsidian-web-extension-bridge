import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type WebExtensionBridgePlugin from "./main";
import type { ManagedExtension } from "./extension-manager";

export class BridgeSettingTab extends PluginSettingTab {
  private pocUrl = "https://example.com";
  private importPath = "";

  constructor(app: App, private plugin: WebExtensionBridgePlugin) {
    super(app, plugin);
  }

  /**
   * 指令十六：每个扩展的最终状态块。
   * Compatibility / Execution / Load / Popup / Runtime / Storage / Tabs / Functional / Reason / Unsupported / Hard Blocker。
   */
  private formatExtensionStatus(item: ManagedExtension): string {
    const rep = item.report;
    const probe = this.plugin.settings.lastPopupProbe;
    const selfProbe =
      probe && item.lastLoadedId && probe.extensionId === item.lastLoadedId ? probe : null;

    const probeVal = (name: string): string => {
      const raw = selfProbe?.probes?.[name];
      if (!raw) return "—";
      try {
        const o = JSON.parse(raw) as {
          status?: string;
          ok?: boolean;
          error?: string;
          runtimeOk?: boolean;
        };
        if (o.runtimeOk !== undefined) return o.runtimeOk ? "PASS" : "FAIL(runtimeOk=false)";
        if (o.status === "RESPONSE") return "PASS";
        if (o.ok === false) return "FAIL(" + (o.error ?? "") + ")";
        if (o.status === "ERROR" || o.status === "THROW" || o.status === "TIMEOUT") {
          return "FAIL(" + o.status + (o.error ? ":" + o.error : "") + ")";
        }
        return "PARTIAL";
      } catch {
        return raw.length > 100 ? raw.slice(0, 100) + "…" : raw;
      }
    };

    const load = item.lastLoadError
      ? "FAIL(" + item.lastLoadError + ")"
      : item.lastLoadedId
        ? "PASS"
        : item.enabled
          ? "未加载"
          : "DISABLED";

    const lines: string[] = [item.folder];
    lines.push(`Compatibility: ${rep?.grade ?? "?"}`);
    lines.push(`Execution: ${item.executionMode ?? rep?.executionMode ?? "UNKNOWN"}`);
    lines.push(`Load: ${load}`);
    if (item.activationStatus) lines.push(`Activation: ${item.activationStatus}`);
    lines.push(
      `Popup: ${
        selfProbe?.popupAvailable || item.activationStatus === "POPUP_AVAILABLE"
          ? "PASS"
          : "—"
      }`
    );
    lines.push(`Runtime: ${probeVal("runtime")}`);
    lines.push(`Storage: ${probeVal("storage.local")}`);
    lines.push(`Tabs: ${probeVal("tabs.query")}`);
    if (selfProbe?.probes?.["PING_CONTENT"] !== undefined) {
      lines.push(`PING_CONTENT: ${probeVal("PING_CONTENT")}`);
    }
    if (selfProbe?.probes?.["getSelectedText"] !== undefined) {
      lines.push(`getSelectedText: ${probeVal("getSelectedText")}`);
    }
    lines.push(`Functional: ${rep?.functionalRisk ?? "UNKNOWN"}`);
    if (rep && rep.potentialBlockers.length > 0) {
      lines.push(`Reason: ${rep.potentialBlockers.join(" | ")}`);
    } else if (rep && rep.nonCriticalUnsupported.length > 0) {
      lines.push(`Reason: ${rep.nonCriticalUnsupported.join(" | ")}`);
    }
    if (rep && rep.unsupported.length > 0) {
      lines.push(`Unsupported: ${rep.unsupported.join(", ")}`);
    }
    lines.push(
      `Hard Blocker: ${rep && rep.hardBlockers.length > 0 ? rep.hardBlockers.join(", ") : "none"}`
    );
    if (item.lastLoadError) lines.push(`上次错误: ${item.lastLoadError}`);
    return lines.join("\n");
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

    containerEl.createEl("h3", { text: "扩展管理 (Extension Manager)" });
    new Setting(containerEl)
      .setName("导入 unpacked 扩展")
      .setDesc("填入扩展目录的绝对路径（含 manifest.json 的文件夹）。导入只做静态分析，不会立即加载。")
      .addText((t) => {
        t.setPlaceholder("F:\\path\\to\\extension");
        t.setValue(this.importPath);
        t.onChange((v) => (this.importPath = v.trim()));
      })
      .addButton((b) =>
        b.setButtonText("导入 / 分析").setCta().onClick(async () => {
          if (!this.importPath) {
            new Notice("Web Extension Bridge：请先填入扩展目录路径。");
            return;
          }
          const r = await this.plugin.manager.import(this.importPath);
          if (!r.ok) {
            new Notice("Web Extension Bridge：导入失败 - " + (r.error ?? "未知错误"), 8000);
          } else {
            new Notice(
              "Web Extension Bridge：导入成功 - " +
                (r.item ? `${r.item.name}@${r.item.version} [${r.item.report?.score ?? "?"}]` : this.importPath),
              6000
            );
          }
          this.display();
        })
      );

    const items = this.plugin.manager.list;
    if (items.length === 0) {
      new Setting(containerEl).setName("托管列表").setDesc("（暂无扩展，导入后会自动出现在这里）");
    } else {
      for (const item of items) {
        const grade = item.report?.grade ?? item.report?.score ?? "?";
        new Setting(containerEl)
          .setName(`${item.name}@${item.version} [${grade}]`)
          .setDesc(this.formatExtensionStatus(item))
          .addToggle((t) =>
            t
              .setValue(item.enabled)
              .setTooltip("启用后该扩展将注入 Web Viewer 站点")
              .onChange(async (v) => {
                if (v) {
                  await this.plugin.manager.enable(item.folder);
                } else {
                  await this.plugin.manager.disable(item.folder);
                }
                this.display();
              })
          )
          .addButton((b) =>
            b.setButtonText("重新加载").setTooltip("重新分析 + 卸载旧实例后重新加载").onClick(async () => {
              await this.plugin.manager.reload(item.folder);
              this.display();
            })
          )
          .addButton((b) =>
            b
              .setButtonText("打开 Popup")
              .setTooltip("实验：在 Popup Host 视图中打开该扩展 popup（需已加载）")
              .onClick(async () => {
                await this.plugin.openPopupFor(item.folder);
                this.display();
              })
          )
          .addButton((b) =>
            b.setButtonText("移除").onClick(async () => {
              await this.plugin.manager.remove(item.folder);
              this.display();
            })
          );
      }
    }

    new Setting(containerEl)
      .setName("测试当前页面 Extension Injection")
      .setDesc("轻量诊断（第 15 节）：区分 Bridge 失败与扩展自身功能失败，只聚合已有运行证据，不做代测。")
      .addButton((b) =>
        b.setButtonText("运行诊断").setCta().onClick(() => {
          new Notice(this.plugin.diagnoseInjection().join("\n"), 12000);
        })
      );

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
