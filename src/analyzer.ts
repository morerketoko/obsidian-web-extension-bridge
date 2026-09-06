// src/analyzer.ts
// Phase 2：静态兼容分析器。
// 判断一个 unpacked Chrome/Chromium Extension 能否被当前 Bridge 承载：
// 解析 manifest.json + 扫描源码中 chrome.*/browser.* API 用法，
// 输出评分与不支持/警告清单。只做静态分析，不做任何加载。

export type CompatibilityGrade = "A" | "C" | "D" | "F";

/**
 * 扩展的主要执行模式（Phase 2.5 Capability Model）。
 * 只描述“入口形态”，与兼容评级（A/C/D/F）无关。
 */
export type ExtensionExecutionMode =
  | "AUTO_INJECT"
  | "POPUP_ACTION"
  | "BACKGROUND_ONLY"
  | "DEVTOOLS"
  | "MIXED"
  | "UNKNOWN";

/** manifest 声明的各类入口。 */
export interface ExtensionEntryPoints {
  contentScripts: boolean;
  popup: boolean;
  action: boolean;
  browserAction: boolean;
  background: boolean;
  commands: boolean;
  devtools: boolean;
}

export interface CompatibilityReport {
  /** manifest_version（null 表示解析失败）。 */
  manifestVersion: number | null;
  name: string;
  version: string;
  permissions: string[];
  hostPermissions: string[];
  /** manifest 中声明的 content_scripts 条数。 */
  contentScripts: number;
  /** 源码中出现的 chrome.<api>. / browser.<api>. 去重清单。 */
  chromeApisFound: string[];
  usesScripting: boolean;
  usesStorage: boolean;
  usesRuntime: boolean;
  usesTabs: boolean;
  usesWebRequest: boolean;
  usesIdentity: boolean;
  usesSidePanel: boolean;
  usesContextMenus: boolean;
  usesAction: boolean;
  usesI18n: boolean;
  /** A：可直接承载；C：部分支持；D：有警告但可用；F：不支持。 */
  score: CompatibilityGrade;
  supported: boolean;
  /** 部分支持（C 级）的 API 名。 */
  partial: string[];
  /** 不支持（F 级）的原因列表。 */
  unsupported: string[];
  warnings: string[];
  /** manifest 解析或目录读取错误。 */
  error: string | null;
  /** 扩展的主要执行模式（入口判定，与兼容评级无关）。 */
  executionMode: ExtensionExecutionMode;
  /** manifest 声明的各类入口。 */
  entryPoints: ExtensionEntryPoints;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg"]);
const SCAN_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".html"]);
// 匹配 chrome.xxx. / browser.xxx. 的 API 调用（大小写不敏感收集）。
const API_RE = /\b(?:chrome|browser)\.([A-Za-z_][A-Za-z0-9_]*)\s*\./g;

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

/** 递归收集可扫描源码文件（跳过 node_modules/.git 等目录）。 */
function collectFiles(dir: string, fs: any, path: any, out: string[]): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: any = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectFiles(full, fs, path, out);
    } else if (stat.isFile() && SCAN_EXTS.has(path.extname(entry).toLowerCase())) {
      out.push(full);
    }
  }
}

/** 扫描单个文件中的 chrome.* / browser.* API 用法（捕获首个命名空间）。 */
function scanFile(apis: Set<string>, file: string, fs: any): void {
  let text = "";
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 4 * 1024 * 1024) return;
    text = buf.toString("utf8");
  } catch {
    return;
  }
  let m: RegExpExecArray | null;
  API_RE.lastIndex = 0;
  while ((m = API_RE.exec(text)) !== null) {
    apis.add(m[1].toLowerCase());
  }
  // storage.sync / storage.managed 是 storage 的子命名空间，额外捕获
  if (text.includes("storage.sync")) apis.add("storage.sync");
  if (text.includes("storage.managed")) apis.add("storage.managed");
}

/** 是否为 host permission 匹配模式（MV2 时 host 混在 permissions 里）。 */
function isHostPattern(p: string): boolean {
  return (
    p.includes("://") ||
    p.startsWith("*.") ||
    p.startsWith("http") ||
    (p.startsWith("*") && p.includes("/"))
  );
}

/** 解析 manifest 中声明的入口点。 */
function parseEntryPoints(manifest: any): ExtensionEntryPoints {
  const action = manifest.action ?? null;
  const browserAction = manifest.browser_action ?? null;
  const popup =
    (typeof action?.default_popup === "string" && action.default_popup.length > 0) ||
    (typeof browserAction?.default_popup === "string" && browserAction.default_popup.length > 0);
  return {
    contentScripts: Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0,
    popup,
    action: !!action,
    browserAction: !!browserAction,
    background: !!manifest.background,
    commands:
      !!manifest.commands &&
      typeof manifest.commands === "object" &&
      Object.keys(manifest.commands).length > 0,
    devtools: typeof manifest.devtools_page === "string" && manifest.devtools_page.length > 0,
  };
}

/** content script 是否为“实际页面入口”（主动修改页面），而非仅被动响应消息。 */
function isActiveContentScript(file: string, fs: any): boolean {
  try {
    const text = fs.readFileSync(file, "utf8");
    return /document\.|addEventListener\s*\(|MutationObserver\s*\(|createElement|innerHTML|setInterval|on[A-Za-z]+\s*=/.test(
      text
    );
  } catch {
    return true; // 读不到时保守视为主动
  }
}

/**
 * 判定扩展的执行模式（Phase 2.5）：
 * content_scripts 是实际页面入口（主动）且有 popup/action/background → MIXED；
 * 仅主动 content_scripts → AUTO_INJECT；
 * 仅 popup → POPUP_ACTION（obsidian 无工具栏，需 Popup Host）；
 * 仅 background → BACKGROUND_ONLY；仅 devtools_page → DEVTOOLS。
 */
function determineExecutionMode(
  folder: string,
  manifest: any,
  ep: ExtensionEntryPoints,
  fs: any,
  path: any
): ExtensionExecutionMode {
  let activeContentScript = false;
  if (ep.contentScripts) {
    for (const cs of (manifest.content_scripts as any[]) ?? []) {
      for (const jf of (Array.isArray(cs?.js) ? cs.js : []) as string[]) {
        const abs = path.isAbsolute(jf) ? jf : path.join(folder, jf);
        if (isActiveContentScript(abs, fs)) {
          activeContentScript = true;
          break;
        }
      }
      if (activeContentScript) break;
    }
  }

  if (ep.devtools && !activeContentScript && !ep.popup && !ep.background) return "DEVTOOLS";
  if (activeContentScript && (ep.popup || ep.action || ep.browserAction || ep.background)) {
    return "MIXED";
  }
  if (activeContentScript) return "AUTO_INJECT";
  if (ep.popup) return "POPUP_ACTION";
  if (ep.background) return "BACKGROUND_ONLY";
  if (ep.devtools) return "DEVTOOLS";
  return "UNKNOWN";
}

/**
 * 分析一个 unpacked 扩展目录。返回完整报告（失败时 error 有值，score 为 F）。
 */
export function analyzeExtension(folder: string): CompatibilityReport {
  const fs = require("fs");
  const path = require("path");

  const report: CompatibilityReport = {
    manifestVersion: null,
    name: "",
    version: "",
    permissions: [],
    hostPermissions: [],
    contentScripts: 0,
    chromeApisFound: [],
    usesScripting: false,
    usesStorage: false,
    usesRuntime: false,
    usesTabs: false,
    usesWebRequest: false,
    usesIdentity: false,
    usesSidePanel: false,
    usesContextMenus: false,
    usesAction: false,
    usesI18n: false,
    score: "F",
    supported: false,
    partial: [],
    unsupported: [],
    warnings: [],
    error: null,
    executionMode: "UNKNOWN",
    entryPoints: {
      contentScripts: false,
      popup: false,
      action: false,
      browserAction: false,
      background: false,
      commands: false,
      devtools: false,
    },
  };

  let manifestRaw: string;
  try {
    manifestRaw = fs.readFileSync(path.join(folder, "manifest.json"), "utf8");
  } catch (e) {
    report.error = "无法读取 manifest.json: " + errorMessage(e);
    return report;
  }

  let manifest: any;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (e) {
    report.error = "manifest.json 解析失败: " + errorMessage(e);
    return report;
  }

  report.manifestVersion = typeof manifest.manifest_version === "number" ? manifest.manifest_version : null;
  report.name = String(manifest.name ?? "");
  report.version = String(manifest.version ?? "");
  const declared = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
  report.permissions = declared.filter((p: string) => !isHostPattern(p));
  report.hostPermissions = Array.isArray(manifest.host_permissions)
    ? manifest.host_permissions.map(String)
    : declared.filter((p: string) => isHostPattern(p));
  report.contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts.length : 0;
  report.entryPoints = parseEntryPoints(manifest);
  report.executionMode = determineExecutionMode(folder, manifest, report.entryPoints, fs, path);

  // 源码扫描
  const files: string[] = [];
  collectFiles(folder, fs, path, files);
  const apis = new Set<string>();
  for (const f of files) scanFile(apis, f, fs);
  report.chromeApisFound = Array.from(apis).sort();

  const has = (name: string) => apis.has(name) || report.permissions.includes(name);
  report.usesScripting = has("scripting");
  report.usesStorage = has("storage");
  report.usesRuntime = has("runtime");
  report.usesTabs = has("tabs");
  report.usesWebRequest = has("webRequest");
  report.usesIdentity = has("identity");
  report.usesSidePanel = has("sidePanel");
  report.usesContextMenus = has("contextMenus");
  report.usesAction = has("action") || has("browserAction");
  report.usesI18n = has("i18n");

  // warnings（非致命）
  if (report.manifestVersion === 2) {
    report.warnings.push("manifest_version 2：Electron 仍兼容，但 Manifest V2 生态已进入维护期");
  } else if (report.manifestVersion !== 3) {
    report.warnings.push("manifest_version 非常规（" + String(report.manifestVersion) + "），Electron 支持不确定");
  }
  if (apis.has("storage.sync")) {
    report.warnings.push("storage.sync：Electron 中不会真正跨设备同步，仅本地生效");
  }
  if (apis.has("storage.managed")) {
    report.warnings.push("storage.managed：依赖企业策略，Electron 不保证可用");
  }
  if (report.contentScripts === 0) {
    report.warnings.push("没有 content_scripts：扩展可能依赖后台页/弹窗，Web Viewer 注入场景受限");
  }
  if (report.hostPermissions.length === 0 && !report.permissions.includes("activeTab")) {
    report.warnings.push("无 host permissions / activeTab：content script 默认无法注入任意网站");
  }

  // unsupported（F 级）
  if (report.usesIdentity) report.unsupported.push("chrome.identity");
  if (report.usesSidePanel) report.unsupported.push("chrome.sidePanel");
  if (report.usesContextMenus) report.unsupported.push("chrome.contextMenus");
  if (report.manifestVersion === 1) report.unsupported.push("manifest_version 1");

  // 评分
  if (report.error) {
    report.score = "F";
  } else if (report.unsupported.length > 0) {
    report.score = "F";
  } else if (report.usesRuntime || report.usesTabs || report.usesWebRequest) {
    report.score = "C";
    if (report.usesRuntime) report.partial.push("chrome.runtime");
    if (report.usesTabs) report.partial.push("chrome.tabs");
    if (report.usesWebRequest) report.partial.push("chrome.webRequest");
  } else if (report.warnings.length > 0) {
    report.score = "D";
  } else {
    report.score = "A";
  }
  report.supported = report.score !== "F";

  return report;
}

/** 一行摘要（设置页 / 日志用）。 */
export function reportSummary(r: CompatibilityReport): string {
  if (r.error) {
    return `${r.name || "(unknown)"} [F] 分析失败: ${r.error}`;
  }
  const apiText =
    r.chromeApisFound.length > 0 ? r.chromeApisFound.join(",") : "(无 chrome/browser API)";
  const notes: string[] = [];
  if (r.unsupported.length > 0) notes.push("不支持:" + r.unsupported.join(","));
  if (r.partial.length > 0) notes.push("部分:" + r.partial.join(","));
  if (r.warnings.length > 0) notes.push("警告:" + r.warnings.length);
  return [
    `${r.name || "(no name)"}@${r.version} [${r.score}]`,
    "mode=" + r.executionMode,
    "content_scripts=" + r.contentScripts,
    "apis(" + apiText + ")",
    notes.join(" "),
  ]
    .filter((s) => s.length > 0)
    .join(" ");
}
