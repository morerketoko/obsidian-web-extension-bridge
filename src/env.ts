// 运行环境信息检测：Obsidian / Electron / Chrome / Node 版本。
export interface EnvironmentInfo {
  obsidianVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  userAgent: string;
}

export function detectEnvironment(): EnvironmentInfo {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const obsidianMatch = ua.match(/Obsidian\/([\d.]+)/);
  const proc = (globalThis as any).process ?? {};
  const versions = proc.versions ?? {};
  return {
    obsidianVersion: obsidianMatch ? obsidianMatch[1] : "unknown",
    electronVersion: versions.electron ?? "unknown",
    chromeVersion: versions.chrome ?? "unknown",
    nodeVersion: versions.node ?? "unknown",
    platform: proc.platform ?? "unknown",
    userAgent: ua,
  };
}
