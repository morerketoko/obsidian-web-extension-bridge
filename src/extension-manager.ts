// src/extension-manager.ts
// Phase 2：Extension Manager —— 托管 unpacked 扩展的导入/启用/禁用/重载/移除。
import { App } from "obsidian";
import * as path from "path";
import { BridgeLogger } from "./logger";
import { LoadResult, WebViewerSessionBridge } from "./session-bridge";
import { confirmExtensionTrust } from "./trust";
import { analyzeExtension, CompatibilityReport } from "./analyzer";

export interface ManagedExtension {
  /** 唯一键：扩展目录的绝对路径。 */
  folder: string;
  manifestId: string | null;
  name: string;
  version: string;
  enabled: boolean;
  /** 用户是否已明确确认信任（安全闸门，首次启用必须弹窗确认）。 */
  trusted: boolean;
  /** 仅信任该扩展时才允许访问 file://（默认 false）。 */
  allowFileAccess: boolean;
  /** 最近一次静态兼容分析结果。 */
  report: CompatibilityReport | null;
  /** 最近一次成功加载后 Electron 返回的扩展 id。 */
  lastLoadedId: string | null;
  /** 最近一次加载失败原因。 */
  lastLoadError: string | null;
  addedAt: string;
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  /** true 表示该目录已在托管列表里（本次为幂等更新）。 */
  alreadyManaged?: boolean;
  item?: ManagedExtension;
  report?: CompatibilityReport;
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

/** 规范化目录路径：去除首尾空白与尾部分隔符。 */
function normalizeFolder(folder: string): string {
  const f = String(folder ?? "").trim();
  if (!f) return "";
  return f.replace(/[\\/]+$/, "");
}

function readManifestId(folder: string): string | null {
  try {
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
    return typeof m.id === "string" && m.id ? m.id : null;
  } catch {
    return null;
  }
}

/**
 * Extension Manager：
 * - 以 folder（绝对路径）为唯一键托管多条扩展记录；
 * - 导入 = 校验 manifest + 静态兼容分析（不做加载）；
 * - 启用 = 首次必须 TrustModal 确认，之后走 bridge.loadExtension；
 * - 禁用/移除可逆，始终与 Electron 已加载状态同步。
 */
export class ExtensionManager {
  private items: ManagedExtension[] = [];
  /** folder -> Electron 当前已加载的扩展 id。 */
  private loadedByFolder = new Map<string, string>();

  constructor(
    private app: App,
    private bridge: WebViewerSessionBridge,
    private log: BridgeLogger,
    private onChanged?: () => void
  ) {}

  get list(): ManagedExtension[] {
    return this.items.slice();
  }

  setList(items: ManagedExtension[]) {
    this.items = Array.isArray(items) ? items : [];
  }

  get loadedCount(): number {
    return this.loadedByFolder.size;
  }

  get loadedFolders(): string[] {
    return Array.from(this.loadedByFolder.keys());
  }

  isLoaded(folder: string): boolean {
    return this.loadedByFolder.has(normalizeFolder(folder));
  }

  findByFolder(folder: string): ManagedExtension | undefined {
    const f = normalizeFolder(folder);
    return this.items.find((i) => i.folder === f);
  }

  findLoadedEntry(extensionId: string): ManagedExtension | undefined {
    for (const [folder, id] of this.loadedByFolder) {
      if (id === extensionId) {
        return this.items.find((i) => i.folder === folder);
      }
    }
    return undefined;
  }

  /** 导入：校验目录 + manifest + 静态分析。同一目录幂等更新，且保留 trusted/enabled/allowFileAccess。 */
  async import(folder: string): Promise<ImportResult> {
    const f = normalizeFolder(folder);
    if (!f) {
      return { ok: false, error: "路径为空" };
    }
    const fs = require("fs");
    let isDir = false;
    try {
      isDir = fs.statSync(f).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return { ok: false, error: "目录不存在: " + f };
    }

    const report = analyzeExtension(f);
    if (report.error) {
      return { ok: false, error: report.error, report };
    }

    const existing = this.findByFolder(f);
    if (existing) {
      existing.name = report.name || existing.name;
      existing.version = report.version || existing.version;
      existing.manifestId = readManifestId(f) ?? existing.manifestId;
      existing.report = report;
      this.emitChanged();
      return { ok: true, alreadyManaged: true, item: { ...existing }, report };
    }

    const item: ManagedExtension = {
      folder: f,
      manifestId: readManifestId(f),
      name: report.name || "未命名扩展",
      version: report.version || "",
      enabled: false,
      trusted: false,
      allowFileAccess: false,
      report,
      lastLoadedId: null,
      lastLoadError: null,
      addedAt: new Date().toISOString(),
    };
    this.items.push(item);
    this.emitChanged();
    this.log.info("ExtensionManager 导入:", item.name, "@", item.version, "|", f);
    return { ok: true, item: { ...item }, report };
  }

  /** 启用：首次必须信任确认；已加载同目录时先卸载再加载（保证 manifest 最新）。 */
  async enable(folder: string, opts?: { skipConfirm?: boolean }): Promise<LoadResult> {
    const item = this.findByFolder(folder);
    if (!item) {
      return { ok: false, error: "扩展不在托管列表（请先导入）", warnings: [] };
    }
    if (!this.bridge.statusSnapshot?.ok) {
      return { ok: false, error: "Session 不可用", warnings: [] };
    }

    if (!opts?.skipConfirm && !item.trusted) {
      const confirmed = await confirmExtensionTrust(this.app, {
        name: item.name,
        path: item.folder,
        version: item.version,
        hostPermissions: item.report?.hostPermissions ?? [],
        permissions: item.report?.permissions ?? [],
      });
      if (!confirmed) {
        item.lastLoadError = "用户取消信任确认";
        this.emitChanged();
        return { ok: false, error: "用户取消", warnings: ["用户未确认信任"] };
      }
      item.trusted = true;
    }

    const alreadyLoaded = this.loadedByFolder.get(item.folder);
    if (alreadyLoaded) {
      await this.bridge.unloadExtension(alreadyLoaded);
      this.loadedByFolder.delete(item.folder);
    }

    const res = await this.bridge.loadExtension(item.folder, item.allowFileAccess);
    if (res.ok && res.extension) {
      item.enabled = true;
      item.lastLoadedId = res.extension.id;
      item.lastLoadError = null;
      this.loadedByFolder.set(item.folder, res.extension.id);
      this.log.info("ExtensionManager 已启用:", item.name, "|", res.extension.id);
    } else {
      item.enabled = false;
      item.lastLoadedId = null;
      item.lastLoadError = res.error ?? "loadExtension 失败（详见 warnings）";
      this.log.error("ExtensionManager 启用失败:", item.folder, res.error ?? "");
    }
    this.emitChanged();
    return res;
  }

  /** 禁用：卸载已加载的扩展（未加载时直接标记为禁用）。 */
  async disable(folder: string): Promise<boolean> {
    const item = this.findByFolder(folder);
    if (!item) return false;
    const id = this.loadedByFolder.get(item.folder);
    if (!id) {
      item.enabled = false;
      this.emitChanged();
      return true;
    }
    const ok = await this.bridge.unloadExtension(id);
    if (ok) {
      this.loadedByFolder.delete(item.folder);
      item.enabled = false;
      item.lastLoadedId = null;
      this.log.info("ExtensionManager 已禁用:", item.name);
    } else {
      this.log.error("ExtensionManager 禁用失败:", item.folder);
    }
    this.emitChanged();
    return ok;
  }

  /** 重新加载：先更新分析报告，再卸载旧实例并按旧状态重新加载。 */
  async reload(folder: string): Promise<LoadResult> {
    const existed = !!this.findByFolder(folder);
    if (existed) {
      await this.import(folder);
    }
    const item = this.findByFolder(folder);
    if (!item) {
      return { ok: false, error: "扩展不在托管列表", warnings: [] };
    }
    const wasTrusted = item.trusted;
    const loadedId = this.loadedByFolder.get(item.folder);
    if (loadedId) {
      await this.bridge.unloadExtension(loadedId);
      this.loadedByFolder.delete(item.folder);
    }
    return this.enable(item.folder, { skipConfirm: wasTrusted });
  }

  /** 重载全部已启用扩展（常用于测试更新后的扩展）。 */
  async reloadAll(): Promise<{ loaded: number; failed: number }> {
    const folders = Array.from(this.loadedByFolder.keys());
    for (const f of folders) {
      try {
        await this.disable(f);
      } catch {
        // 忽略单条卸载异常
      }
    }
    let loaded = 0;
    let failed = 0;
    for (const i of this.items) {
      if (!i.enabled || !i.trusted) continue;
      const res = await this.enable(i.folder, { skipConfirm: true });
      if (res.ok) {
        loaded++;
      } else {
        failed++;
        this.log.error("reloadAll 失败:", i.folder, res.error ?? "");
      }
    }
    return { loaded, failed };
  }

  /** 移除：先从托管列表删除（会先卸载已加载实例）。 */
  async remove(folder: string): Promise<boolean> {
    const norm = normalizeFolder(folder);
    const idx = this.items.findIndex((i) => i.folder === norm);
    if (idx < 0) return false;
    await this.disable(this.items[idx].folder);
    this.items.splice(idx, 1);
    this.loadedByFolder.delete(norm);
    this.emitChanged();
    return true;
  }

  /** 启动恢复：按 enabled && trusted 列表加载（Electron 不跨启动保留扩展）。 */
  async startup(): Promise<{ loaded: number; failed: number }> {
    let loaded = 0;
    let failed = 0;
    for (const i of this.items) {
      if (!i.enabled || !i.trusted) continue;
      const res = await this.enable(i.folder, { skipConfirm: true });
      if (res.ok) {
        loaded++;
      } else {
        failed++;
        i.lastLoadError = res.error ?? "启动恢复失败";
        this.log.warn("启动恢复失败:", i.folder, res.error ?? "");
      }
    }
    this.emitChanged();
    return { loaded, failed };
  }

  /** 按需修改托管记录（迁移旧配置 / 设置页切换 allowFileAccess 等）。 */
  patchItem(folder: string, changes: Partial<ManagedExtension>): ManagedExtension | undefined {
    const item = this.findByFolder(folder);
    if (!item) return undefined;
    Object.assign(item, changes);
    this.emitChanged();
    return item;
  }

  /** 卸载全部已加载扩展（插件 unload 时恢复现场）。 */
  async unloadAll(): Promise<void> {
    for (const f of Array.from(this.loadedByFolder.keys())) {
      try {
        await this.disable(f);
      } catch {
        // 忽略单条卸载异常
      }
    }
  }

  private emitChanged() {
    if (this.onChanged) {
      try {
        this.onChanged();
      } catch (e) {
        this.log.error("ExtensionManager onChanged 回调异常:", errorMessage(e));
      }
    }
  }
}
