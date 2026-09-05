import type { App } from "obsidian";
import { BridgeLogger } from "./logger";

// Web Viewer 使用的 Electron Session 前缀（来自 Obsidian 内部实现）。
// app.getWebviewPartition() 返回 "persist:vault-<appId>"。禁止假设一定存在，
// 必须先 feature detect（见 detect()）。
const PERSIST_PREFIX = "persist:";

// Electron Session.extensions 生命周期事件（Electron 43 文档确认存在）。
// 注意：@electron/remote 代理可能无法可靠订阅，失败时会如实记录。
const EXTENSION_EVENTS = [
  "extension-loaded",
  "extension-ready",
  "extension-unloaded",
] as const;
export type ExtensionEventType = (typeof EXTENSION_EVENTS)[number] | string;

export interface BridgeStatus {
  ok: boolean;
  partition: string | null;
  persistence: "persistent" | "in-memory" | "default" | "unknown" | null;
  storagePath: string | null;
  remoteAvailable: boolean;
  extensionsApiAvailable: boolean;
  loadExtensionApiAvailable: boolean;
  failure: string | null;
}

export interface LoadedExtension {
  id: string;
  name: string;
  version: string;
  path: string;
  manifest: unknown;
}

/** 更完整的已加载扩展记录（诊断 / 运行时证据用）。 */
export interface FullExtensionInfo extends LoadedExtension {
  /** Electron 提供的扩展位置（unpacked 目录路径等），拿不到时回退 path 或空串。 */
  location: string;
  /** 记录查询到该记录时所在的 partition（同一 Partition 推导同一 Session 的运行时证据）。 */
  partition: string | null;
}

export interface ExtensionEventRecord {
  type: ExtensionEventType;
  id: string;
  name: string;
  version: string;
  partition: string | null;
  timestamp: string;
  /** remote 代理传不了原始 message 时为空串；绝不伪造。 */
  raw: string;
}

export interface LoadResult {
  ok: boolean;
  extension?: LoadedExtension;
  error?: string;
  fallbackApiUsed?: boolean;
  warnings: string[];
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
 * 桥接 Obsidian Core Web Viewer 的 Electron Session。
 *
 * 核心链路（不许跳过 feature detection）：
 *   App.getWebviewPartition()                     （renderer, 内部 API）
 *   -> electron.remote.session.fromPartition(...)  （主进程 Session 代理）
 *   -> session.extensions.loadExtension(path)      （主进程 Extensions API）
 *
 * loadExtension 只能在 Electron Main Process 调用；此处通过 Obsidian 内置的
 * @electron/remote 把调用序列化到主进程执行，而不是伪造 renderer 端的实现。
 *
 * 设计注意（不是结论）：“Extension Session === Web Viewer Session” 由
 * “相同 partition 字符串 => 同一 Session 实例” 推导而来。该推论必须靠
 * 运行时证据（extension-loaded 事件发生在该 Session、getAllExtensions
 * 返回的 location、webview.partition 与 getWebviewPartition 一致、
 * content script 确实注入 Web Viewer 页面）才能升级为结论。
 */
export class WebViewerSessionBridge {
  private electron: any = null;
  private remote: any = null;
  private session: any = null;
  private partitionName: string | null = null;
  private status: BridgeStatus | null = null;

  /** 生命周期事件记录（最多保留 200 条），供 POC 审计与运行时证据。 */
  private eventRecords: ExtensionEventRecord[] = [];
  /** 已注册的 [target, type, handler] 三元组，便于反订阅。 */
  private eventHandlers: Array<{ target: any; type: string; handler: (...a: any[]) => void }> = [];
  private eventSubscriptionError: string | null = null;

  constructor(private app: App, private log: BridgeLogger) {}

  get partition(): string | null {
    return this.partitionName;
  }

  get statusSnapshot(): BridgeStatus | null {
    return this.status;
  }

  get extensionEventRecords(): ExtensionEventRecord[] {
    return this.eventRecords.slice();
  }

  get extensionEventSubscriptionError(): string | null {
    return this.eventSubscriptionError;
  }

  get extensionEventCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const r of this.eventRecords) {
      counts[r.type] = (counts[r.type] ?? 0) + 1;
    }
    return counts;
  }

  /** 发现 Web Viewer Session 并做能力检测（只读，不做任何 patch）。 */
  async detect(): Promise<BridgeStatus> {
    const appAny = this.app as any;
    const fail = (msg: string): BridgeStatus => {
      this.status = {
        ok: false,
        partition: null,
        persistence: null,
        storagePath: null,
        remoteAvailable: false,
        extensionsApiAvailable: false,
        loadExtensionApiAvailable: false,
        failure: msg,
      };
      this.log.error("环境检测失败:", msg);
      return this.status;
    };

    // 1) App.getWebviewPartition —— Obsidian 内部 API，必须存在
    if (appAny == null || typeof appAny.getWebviewPartition !== "function") {
      return fail("app.getWebviewPartition 不存在；该 Obsidian 版本不支持此桥接。");
    }

    let partition: string;
    try {
      partition = String(appAny.getWebviewPartition() ?? "");
    } catch (e) {
      return fail("app.getWebviewPartition() 抛错: " + errorMessage(e));
    }
    if (!partition) {
      return fail("app.getWebviewPartition() 返回空 partition。");
    }
    this.partitionName = partition;

    // 2) require("electron") —— Obsidian 插件运行时提供（官方代码同样这么用）
    try {
      this.electron = require("electron");
    } catch (e) {
      return fail("require('electron') 不可用: " + errorMessage(e));
    }
    this.remote = this.electron?.remote;
    if (!this.remote || !this.remote.session || typeof this.remote.session.fromPartition !== "function") {
      return fail("electron.remote.session.fromPartition 不可用（Obsidian 未启用 @electron/remote）。");
    }

    // 3) 取得与 Web Viewer 同一个 partition 的 Session。
    //    Electron 保证同 partition 返回同一 Session 实例；但“扩展确实装进
    //    该 Session”仍需运行时证据确认。
    try {
      this.session = this.remote.session.fromPartition(partition);
    } catch (e) {
      return fail("session.fromPartition 失败: " + errorMessage(e));
    }

    // 4) persistence / storagePath / extensions API 可用性
    const persistence: BridgeStatus["persistence"] = partition.startsWith(PERSIST_PREFIX)
      ? "persistent"
      : partition === ""
        ? "default"
        : "in-memory";
    let storagePath: string | null = null;
    try {
      if (typeof this.session.getStoragePath === "function") {
        storagePath = this.session.getStoragePath() ?? null;
      }
    } catch {
      storagePath = null;
    }

    let extensionsApiAvailable = false;
    let loadExtensionApiAvailable = false;
    try {
      const extObj = this.session.extensions;
      extensionsApiAvailable = !!extObj;
      loadExtensionApiAvailable =
        (extObj && typeof extObj.loadExtension === "function") ||
        typeof this.session.loadExtension === "function";
    } catch (e) {
      this.log.warn("检测 session.extensions 时异常:", errorMessage(e));
    }

    this.status = {
      ok: true,
      partition,
      persistence,
      storagePath,
      remoteAvailable: true,
      extensionsApiAvailable,
      loadExtensionApiAvailable,
      failure: null,
    };
    this.log.info(
      "Bridge 就绪:",
      JSON.stringify({
        partition,
        persistence,
        storagePath,
        extensionsApiAvailable,
        loadExtensionApiAvailable,
      })
    );
    return this.status;
  }

  /**
   * 将 unpacked extension 加载进 Web Viewer Session。
   * allowFileAccess 默认 false（安全要求：只有用户明确开启才传 true）。
   */
  async loadExtension(extPath: string, allowFileAccess = false): Promise<LoadResult> {
    const warnings: string[] = [];
    if (!this.status?.ok || !this.session) {
      const s = await this.detect();
      if (!s.ok) {
        return { ok: false, error: s.failure ?? "Session 未就绪", warnings };
      }
    }
    if (!this.status!.loadExtensionApiAvailable) {
      return {
        ok: false,
        error: "当前 Electron Session 没有可用的 loadExtension API。",
        warnings,
      };
    }

    const toLoaded = (ext: any, path: string): LoadedExtension => ({
      id: ext?.id ?? String(path),
      name: ext?.name ?? "",
      version: ext?.version ?? "",
      path,
      manifest: ext?.manifest ?? null,
    });

    try {
      const extObj = this.session.extensions;
      if (extObj && typeof extObj.loadExtension === "function") {
        const ext = await extObj.loadExtension(extPath, { allowFileAccess });
        const loaded = toLoaded(ext, extPath);
        this.log.info("Extension 加载成功:", loaded.id, loaded.name, loaded.version);
        return { ok: true, extension: loaded, warnings };
      }
    } catch (e) {
      this.log.error("extensions.loadExtension 失败:", errorMessage(e));
      warnings.push("extensions.loadExtension 失败: " + errorMessage(e));
    }

    // 回退：较旧 Electron 的 ses.loadExtension（新版推荐 ses.extensions.*）
    if (typeof this.session.loadExtension === "function") {
      try {
        const ext = await this.session.loadExtension(extPath, { allowFileAccess });
        const loaded = toLoaded(ext, extPath);
        this.log.warn("使用已废弃的 ses.loadExtension 成功加载:", loaded.id);
        return { ok: true, extension: loaded, fallbackApiUsed: true, warnings };
      } catch (e) {
        const msg = "ses.loadExtension 回退也失败: " + errorMessage(e);
        this.log.error(msg);
        warnings.push(msg);
      }
    }

    return {
      ok: false,
      error: warnings[0] ?? "loadExtension 调用失败（无具体错误信息）。",
      warnings,
    };
  }

  /** 卸载扩展（可逆操作，插件 unload 时用于恢复现场）。 */
  async unloadExtension(id: string): Promise<boolean> {
    if (!this.status?.ok || !this.session) return false;
    try {
      const extObj = this.session.extensions;
      if (extObj && typeof extObj.removeExtension === "function") {
        await extObj.removeExtension(id);
        this.log.info("Extension 已卸载:", id);
        return true;
      }
    } catch (e) {
      this.log.error("extensions.removeExtension 失败:", errorMessage(e));
    }
    if (typeof this.session.removeExtension === "function") {
      try {
        await this.session.removeExtension(id);
        this.log.info("Extension 已卸载（legacy API）:", id);
        return true;
      } catch (e) {
        this.log.error("ses.removeExtension 失败:", errorMessage(e));
      }
    }
    return false;
  }

  /**
   * 订阅 Session 扩展生命周期事件（尽力而为）。
   * @electron/remote 的 EventEmitter 代理并不保证可用：失败时如实记录
   * “remote proxy cannot reliably subscribe to Extensions events”，绝不伪造。
   */
  subscribeToExtensionEvents(): { ok: boolean; error: string | null } {
    this.unsubscribeFromExtensionEvents();
    const target = this.session?.extensions ?? this.session;
    if (!target || typeof target.on !== "function") {
      const msg =
        "session.extensions 无 .on 方法（remote 代理不可靠，无法订阅 Extensions events）";
      this.eventSubscriptionError = msg;
      this.log.warn("EXT_EVENTS", msg);
      return { ok: false, error: msg };
    }
    try {
      for (const type of EXTENSION_EVENTS) {
        const handler = (ext: any) => {
          this.recordExtensionEvent(type, ext);
        };
        (target as any).on(type, handler);
        this.eventHandlers.push({ target, type, handler });
      }
      this.log.info("EXT_EVENTS", "生命周期事件订阅成功:", EXTENSION_EVENTS.join(","));
      return { ok: true, error: null };
    } catch (e) {
      this.unsubscribeFromExtensionEvents();
      const msg =
        "remote proxy cannot reliably subscribe to Extensions events: " + errorMessage(e);
      this.eventSubscriptionError = msg;
      this.log.warn("EXT_EVENTS", msg);
      return { ok: false, error: msg };
    }
  }

  unsubscribeFromExtensionEvents(): void {
    for (const h of this.eventHandlers) {
      try {
        if (h.target && typeof h.target.removeListener === "function") {
          h.target.removeListener(h.type, h.handler);
        }
      } catch {
        // 忽略反订阅异常
      }
    }
    this.eventHandlers = [];
  }

  private recordExtensionEvent(type: string, ext: any) {
    const rec: ExtensionEventRecord = {
      type,
      id: ext?.id ?? "",
      name: ext?.name ?? "",
      version: ext?.version ?? "",
      partition: this.partitionName,
      timestamp: new Date().toISOString(),
      raw: "",
    };
    this.eventRecords.push(rec);
    if (this.eventRecords.length > 200) {
      this.eventRecords.shift();
    }
    this.log.info("EXT_EVENT", JSON.stringify(rec));
  }

  /** 查询已加载扩展完整记录（含 location / partition，运行时证据）。 */
  async getLoadedExtensions(): Promise<FullExtensionInfo[]> {
    if (!this.status?.ok || !this.session) return [];
    try {
      const extObj = this.session.extensions;
      const list =
        extObj && typeof extObj.getAllExtensions === "function"
          ? await extObj.getAllExtensions()
          : typeof this.session.getAllExtensions === "function"
            ? await this.session.getAllExtensions()
            : [];
      const arr = (Array.isArray(list) ? list : []) as any[];
      return arr.map((e) => ({
        id: e?.id ?? "",
        name: e?.name ?? "",
        version: e?.version ?? "",
        path: e?.path ?? "",
        location:
          typeof e?.location === "string"
            ? e.location
            : typeof e?.path === "string"
              ? e.path
              : "",
        manifest: e?.manifest ?? null,
        partition: this.partitionName,
      }));
    } catch (e) {
      this.log.warn("查询已加载扩展失败:", errorMessage(e));
      return [];
    }
  }
}
