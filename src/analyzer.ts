// src/analyzer.ts
// Phase 2：静态兼容分析器。
// 判断一个 unpacked Chrome/Chromium Extension 能否被当前 Bridge 承载：
// 解析 manifest.json + 扫描源码中 chrome.*/browser.* API 用法，
// 输出评分与不支持/警告清单。只做静态分析，不做任何加载。

export type CompatibilityGrade = "A" | "B" | "C" | "D" | "F";

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
  /** 兼容评级（Phase 2.6）：A/B/C/D/F，语义见评级模型。 */
  grade: CompatibilityGrade;
  /** 兼容别名（Phase 2 旧字段，与 grade 同步赋值，旧 data.json 兼容）。 */
  score: CompatibilityGrade;
  /** 静态判定为不支持的 API 总表（含 hard + non-critical）。 */
  unsupported: string[];
  /** 不支持的 API 中，静态判定为非核心/可选能力（不影响核心执行路径）。 */
  nonCriticalUnsupported: string[];
  /** 静态推断可能影响核心路径、但无法 100% 确认的 API（需要运行时证据）。 */
  potentialBlockers: string[];
  /** 明确阻塞核心执行路径的 API（不得仅凭“已声明”判定，需源码实际调用等证据）。 */
  hardBlockers: string[];
  /** 功能风险：LOW / MEDIUM / HIGH / BLOCKED。 */
  functionalRisk: "LOW" | "MEDIUM" | "HIGH" | "BLOCKED";
  supported: boolean;
  /** 部分支持（C 级）的 API 名。 */
  partial: string[];
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
 * Phase 2.6：收集 popup / background 入口脚本（判断初始化路径是否依赖
 * 不支持的 API）。只做静态文件解析，不做任何执行。
 */
function collectEntryScripts(folder: string, manifest: any, fs: any, path: any): string[] {
  const out: string[] = [];
  const pushFile = (rel: string | undefined | null) => {
    if (typeof rel !== "string" || !rel) return;
    const abs = path.isAbsolute(rel) ? rel : path.join(folder, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.push(abs);
    } catch {
      // 忽略不可读文件
    }
  };
  // popup：解析 html 里的 <script src>
  const popupHtml =
    (manifest?.action?.default_popup as string | undefined) ??
    (manifest?.browser_action?.default_popup as string | undefined);
  if (typeof popupHtml === "string" && popupHtml) {
    const htmlAbs = path.isAbsolute(popupHtml) ? popupHtml : path.join(folder, popupHtml);
    try {
      const html = fs.readFileSync(htmlAbs, "utf8");
      const re = /<script[^>]+src\s*=\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        pushFile(m[1]);
      }
    } catch {
      // 忽略：无法读取 popup html
    }
  }
  // background
  if (typeof manifest?.background?.service_worker === "string") {
    pushFile(manifest.background.service_worker);
  }
  if (typeof manifest?.background?.scripts === "object" && Array.isArray(manifest.background.scripts)) {
    for (const sc of manifest.background.scripts) pushFile(sc);
  }
  return out;
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
    grade: "F",
    supported: false,
    partial: [],
    unsupported: [],
    nonCriticalUnsupported: [],
    potentialBlockers: [],
    hardBlockers: [],
    functionalRisk: "BLOCKED",
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
    report.warnings.push("storage.sync：Electron 不跨设备同步（Compatibility Adapter 候选，见 docs/compatibility-adapters.md）");
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

  // ---- Phase 2.6：unsupported 与 hardBlockers 分离 ----
  // 原则：先收集「不支持 API 总表」（unsupported），再区分：
  //   hardBlockers          明确阻塞核心执行路径（需源码实际调用等证据，不凭声明）
  //   potentialBlockers     静态推断可能影响核心路径（需运行时证据）
  //   nonCriticalUnsupported 非核心/可选能力（不直接降级到 F）
  // 不要因单一 unsupported 自动 F（指令第二节）。

  const declaredOnly = (api: string) => report.permissions.includes(api) && !apis.has(api);

  // 1) 明确 hard blockers
  if (report.manifestVersion === 1) {
    report.hardBlockers.push("manifest_version 1：Electron load 不支持");
  }
  if (apis.has("identity")) {
    report.hardBlockers.push("chrome.identity：源码实际调用，Electron 无 OAuth 登录流程（核心鉴权缺失）");
  }
  if (apis.has("sidePanel")) {
    report.hardBlockers.push("chrome.sidePanel：源码实际调用，Electron 无 side panel 上下文（核心 UI 缺失）");
  }
  const hasAnyEntry =
    report.entryPoints.popup || report.entryPoints.background ||
    report.entryPoints.contentScripts || report.entryPoints.action ||
    report.entryPoints.browserAction || report.entryPoints.devtools;
  if (!hasAnyEntry) {
    report.hardBlockers.push("无 manifest 可用执行入口（无 content_scripts / popup / background / action）");
  }

  // 2) unsupported 总表（声明或实际调用任一即记录）
  if (apis.has("identity") || declaredOnly("identity")) report.unsupported.push("chrome.identity");
  if (apis.has("sidePanel") || declaredOnly("sidePanel")) report.unsupported.push("chrome.sidePanel");
  if (apis.has("contextMenus") || declaredOnly("contextMenus")) report.unsupported.push("chrome.contextMenus");
  if (apis.has("storage.sync")) report.unsupported.push("chrome.storage.sync");
  if (apis.has("storage.managed")) report.unsupported.push("chrome.storage.managed");
  if (report.manifestVersion === 1) report.unsupported.push("manifest_version 1");

  // 3) 非核心 unsupported（静态判定为非核心/可选能力）
  if (apis.has("contextMenus") || declaredOnly("contextMenus")) {
    report.nonCriticalUnsupported.push("chrome.contextMenus（右键菜单：非页面翻译核心路径）");
  }
  if (apis.has("storage.managed")) {
    report.nonCriticalUnsupported.push("chrome.storage.managed（企业策略存储：可选）");
  }
  if (declaredOnly("identity")) {
    report.nonCriticalUnsupported.push("chrome.identity（仅声明未发现实际调用：若鉴权是核心才阻塞）");
    report.potentialBlockers.push("chrome.identity 已声明：若登录/鉴权为扩展核心路径，Electron 无 OAuth 流程会阻塞");
  }
  if (declaredOnly("sidePanel")) {
    report.nonCriticalUnsupported.push("chrome.sidePanel（仅声明未发现实际调用）");
  }

  // 4) storage.sync：若出现在 popup/background 入口脚本 → potentialBlocker（指令第十/十二节）
  const entryScripts = collectEntryScripts(folder, manifest, fs, path);
  const syncInEntry = entryScripts.some((f) => {
    try {
      const t = fs.readFileSync(f, "utf8");
      return /storage\.sync\s*\.\s*(get|set|clear|remove|getBytesInUse)/.test(t);
    } catch {
      return false;
    }
  });
  if (apis.has("storage.sync")) {
    report.nonCriticalUnsupported.push("chrome.storage.sync（配置类存储：Electron 不支持，StorageSyncToLocalAdapter 候选）");
    if (syncInEntry) {
      report.potentialBlockers.push(
        "chrome.storage.sync 出现在 popup/background 入口脚本：初始化可能崩溃（真机 GPT-3.5 已证实）"
      );
    }
  }

  // 5) partial（Electron 直接支持子集中的部分可用项）
  if (report.usesRuntime) report.partial.push("chrome.runtime");
  if (report.usesTabs) report.partial.push("chrome.tabs");

  // 6) 评级（指令第二节语义：A/B/C/D/F）
  let grade: CompatibilityGrade;
  if (report.error || report.hardBlockers.length > 0) {
    grade = "F";
  } else if (syncInEntry && !report.entryPoints.contentScripts) {
    // 唯一有效入口初始化依赖 storage.sync（无 content script 兜底）→ 需适配才能保证功能
    grade = "D";
  } else if (report.partial.length > 0 || report.nonCriticalUnsupported.length > 0) {
    grade = "C";
  } else if (report.warnings.length > 0) {
    grade = "B";
  } else {
    grade = "A";
  }
  report.grade = grade;
  report.score = grade;
  report.supported = grade !== "F";

  // 7) 功能风险（与评级一致；不声称“静态可确知第三方核心”）
  if (grade === "F") report.functionalRisk = "BLOCKED";
  else if (grade === "D") report.functionalRisk = "HIGH";
  else if (grade === "C") {
    report.functionalRisk =
      syncInEntry || apis.has("identity") || declaredOnly("identity") ? "HIGH" : "MEDIUM";
  } else {
    report.functionalRisk = "LOW";
  }

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
  if (r.hardBlockers.length > 0) notes.push("硬阻塞:" + r.hardBlockers.join(","));
  if (r.potentialBlockers.length > 0) notes.push("潜在风险:" + r.potentialBlockers.join(","));
  if (r.nonCriticalUnsupported.length > 0) notes.push("非核心不支持:" + r.nonCriticalUnsupported.join(","));
  if (r.partial.length > 0) notes.push("部分:" + r.partial.join(","));
  if (r.warnings.length > 0) notes.push("警告:" + r.warnings.length);
  return [
    `${r.name || "(no name)"}@${r.version} [${r.grade}]`,
    "risk=" + r.functionalRisk,
    "mode=" + r.executionMode,
    "content_scripts=" + r.contentScripts,
    "apis(" + apiText + ")",
    notes.join(" "),
  ]
    .filter((s) => s.length > 0)
    .join(" ");
}
