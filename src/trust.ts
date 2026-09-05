import { App, Modal, Setting } from "obsidian";

export interface TrustRequest {
  name: string;
  path: string;
  version: string;
  hostPermissions: string[];
  permissions: string[];
}

/**
 * 安全要求（任务十二）：启用 Extension 前第一次必须显示明确警告。
 * Extension 能够在 host permissions 允许的网站中执行浏览器脚本。
 */
export function confirmExtensionTrust(app: App, req: TrustRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new TrustModal(app, req, resolve);
    modal.open();
  });
}

class TrustModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private req: TrustRequest,
    private resolve: (ok: boolean) => void
  ) {
    super(app);
    this.titleEl.setText("启用 Web Extension");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "此 Extension 将能够在其 host permissions 允许的网站中执行浏览器脚本。请确认你信任该 Extension。",
    });

    new Setting(contentEl).setName("名称").setDesc(this.req.name);
    new Setting(contentEl)
      .setName("路径")
      .setDesc(this.req.path)
      .setClass("mod-monospace");
    new Setting(contentEl)
      .setName("版本")
      .setDesc(this.req.version || "未知");
    new Setting(contentEl)
      .setName("host permissions")
      .setDesc(this.req.hostPermissions?.join(", ") || "（无）")
      .setClass("mod-monospace");
    new Setting(contentEl)
      .setName("requested permissions")
      .setDesc(this.req.permissions?.join(", ") || "（无）")
      .setClass("mod-monospace");

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("确认并启用")
          .setCta()
          .onClick(() => {
            this.resolved = true;
            this.resolve(true);
            this.close();
          })
      )
      .addButton((b) =>
        b
          .setButtonText("取消")
          .onClick(() => {
            this.resolved = true;
            this.resolve(false);
            this.close();
          })
      );
  }

  onClose() {
    if (!this.resolved) this.resolve(false);
  }
}
