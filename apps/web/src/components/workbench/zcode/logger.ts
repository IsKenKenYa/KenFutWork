/**
 * zcode 移植层宿主适配：logger（references/zcode packages/ui/src/logger.ts 的最小等价）。
 * 生产与开发都直接落 console；不带桌面桥（我们无 Electron 桥）。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const consoleFns = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
} as const;

function log(level: LogLevel, ...args: unknown[]) {
  consoleFns[level]("[zcode-ui]", ...args);
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
  lifecycle: {
    info: (...args: unknown[]) => log("info", ...args),
    warn: (...args: unknown[]) => log("warn", ...args),
    error: (...args: unknown[]) => log("error", ...args),
  },
  /** 带 traceId 前缀的日志，用于全链路追踪 */
  trace: (traceId: string, level: LogLevel, ...args: unknown[]) => {
    log(level, `[trace:${traceId}]`, ...args);
  },
};

export function logMemoryDiagnostics(line: string): void {
  console.info("[zcode-ui]", line);
}
