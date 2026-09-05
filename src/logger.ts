// 统一的结构化日志：所有日志带 [WebExtensionBridge] 前缀与级别。
export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export const LOG_PREFIX = "[WebExtensionBridge]";

export class BridgeLogger {
  private debugEnabled = false;

  setDebug(enabled: boolean) {
    this.debugEnabled = enabled;
  }

  info(...args: unknown[]) {
    this.write("INFO", args);
  }

  warn(...args: unknown[]) {
    this.write("WARN", args);
  }

  error(...args: unknown[]) {
    this.write("ERROR", args);
  }

  debug(...args: unknown[]) {
    if (this.debugEnabled) this.write("DEBUG", args);
  }

  private write(level: LogLevel, args: unknown[]) {
    const fn =
      level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.info;
    fn(LOG_PREFIX, level, ...args);
  }
}
