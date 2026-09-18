/**
 * 面板内**悬浮控制台**的数据层：把 CDP 的控制台事件折成一行行可上屏的文本。
 *
 * 为什么不用页面里的 Eruda 当控制台：那东西在页面的 **shadow root** 里、只能铺在页面底部，
 * 既拖不动也关不掉（用户口径：「不能做成悬浮窗的形式吗，并且可以拖动，可以关闭」）。
 * 我们自己的悬浮窗要在**自己的 DOM** 里，所以消息得从 CDP 这条线搬过来——
 * 这里就是搬运时的格式折叠（纯函数，好测）。
 *
 * 覆盖面：页面里的 `console.*`（consoleAPICalled）、未捕获异常（exceptionThrown）、
 * 浏览器自己的日志（Log.entryAdded，网络错误/CSP 违规这类走它），以及用户在悬浮窗里
 * 自己敲的表达式（`Runtime.evaluate` 的结果）。
 */

export type ConsoleLevel = "log" | "info" | "warn" | "error";

export interface ConsoleMessage {
  /** 单调递增序号：客户端按它增量拉取（`since=上一批最后的 seq`）。 */
  seq: number;
  level: ConsoleLevel;
  text: string;
  /** ISO 时间（客户端显示到秒）。 */
  at: string;
  /** 来源：页面里的 console / 未捕获异常 / 浏览器日志 / 用户输入。 */
  source: "console" | "exception" | "log" | "input";
}

/** CDP 的 RemoteObject（只取我们用到的那几个字段）。 */
export interface RemoteObjectLike {
  type?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  className?: string;
  preview?: {
    properties?: Array<{
      name?: string;
      type?: string;
      value?: unknown;
      valuePreview?: { description?: string };
    }>;
    overflow?: boolean;
  };
}

/** 把一个 CDP 值折成一行文本（与 DevTools 控制台的观感一致：字符串不加引号，对象给预览）。 */
export function formatRemoteValue(arg: RemoteObjectLike | undefined): string {
  if (!arg) return "undefined";
  if (arg.unserializableValue) return arg.unserializableValue;
  const { type, value } = arg;
  if (type === "string") return typeof value === "string" ? value : "";
  if (type === "number" || type === "boolean" || type === "bigint") {
    return value === undefined ? (arg.description ?? type) : String(value);
  }
  if (type === "undefined") return "undefined";
  if (type === "symbol" || type === "function") {
    return arg.description ?? type;
  }
  // 对象 / 数组：先用预览折成 `{ a: 1, b: "x" }` 这种一行，没有预览就用 description
  const preview = arg.preview?.properties;
  if (preview && preview.length > 0) {
    const body = preview
      .slice(0, 6)
      .map((property) => {
        const name = property.name ?? "?";
        // 字符串在对象里带引号（与 DevTools 一致：`{ a: "x" }` 而不是 `{ a: x }`）
        const value =
          property.valuePreview?.description ??
          (property.type === "string" && typeof property.value === "string"
            ? JSON.stringify(property.value)
            : property.value === undefined
              ? (property.type ?? "")
              : String(property.value));
        return `${name}: ${value}`;
      })
      .join(", ");
    const more = preview.length > 6 || arg.preview?.overflow ? ", …" : "";
    return `{ ${body}${more} }`;
  }
  return arg.description ?? arg.className ?? type ?? "undefined";
}

/** `console.*` 的一行（`console.log("a", {b:1})` → `a { b: 1 }`）。 */
export function formatConsoleCall(
  params: {
    type?: string;
    args?: RemoteObjectLike[];
  },
  at: string,
): Omit<ConsoleMessage, "seq"> {
  const args = params.args ?? [];
  return {
    level: consoleLevel(params.type),
    text: args.map((arg) => formatRemoteValue(arg)).join(" "),
    at,
    source: "console",
  };
}

/** CDP 的 console 类型 → 我们的四档。 */
export function consoleLevel(type: string | undefined): ConsoleLevel {
  switch (type) {
    case "warning":
      return "warn";
    case "error":
    case "assert":
      return "error";
    case "info":
    case "debug":
      return "info";
    default:
      return "log";
  }
}

/** 未捕获异常（含 Promise 里的）→ 一行错误；优先给带调用栈的 description。 */
export function formatExceptionThrown(
  params: {
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string };
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    };
  },
  at: string,
): Omit<ConsoleMessage, "seq"> {
  const details = params.exceptionDetails;
  const stack = details?.exception?.description;
  const where =
    details?.url && details.lineNumber !== undefined
      ? `（${details.url}:${(details.lineNumber ?? 0) + 1}）`
      : "";
  return {
    level: "error",
    text: `${stack ?? details?.text ?? "未捕获异常"}${where ? `\n${where}` : ""}`,
    at,
    source: "exception",
  };
}

/** 浏览器侧日志（网络错误、CSP 违规、混合内容这类）。 */
export function formatLogEntry(
  params: {
    entry?: {
      level?: string;
      text?: string;
      url?: string;
      lineNumber?: number;
    };
  },
  at: string,
): Omit<ConsoleMessage, "seq"> {
  const entry = params.entry;
  const url = entry?.url ? ` (${entry.url})` : "";
  return {
    level:
      entry?.level === "error"
        ? "error"
        : entry?.level === "warning"
          ? "warn"
          : "info",
    text: `${entry?.text ?? "浏览器日志"}${url}`,
    at,
    source: "log",
  };
}

/** 用户在悬浮窗里敲的表达式的结果（`Runtime.evaluate` 的返回）。 */
export function formatEvalResult(
  result: {
    result?: RemoteObjectLike;
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string };
    };
  },
  at: string,
): Omit<ConsoleMessage, "seq"> {
  if (result.exceptionDetails) {
    return {
      level: "error",
      text:
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "执行出错",
      at,
      source: "input",
    };
  }
  return {
    level: "log",
    text: formatRemoteValue(result.result),
    at,
    source: "input",
  };
}

/** 控制台**缓存**：进程内环形缓冲（seq 单调递增，客户端按 seq 增量取）。 */
export interface ConsoleBuffer {
  push(message: Omit<ConsoleMessage, "seq">): ConsoleMessage;
  /** 取 `seq > since` 的消息（最多 `limit` 条）。 */
  since(seq: number, limit?: number): ConsoleMessage[];
  latestSeq(): number;
  clear(): void;
}

export function createConsoleBuffer(limit = 300): ConsoleBuffer {
  const messages: ConsoleMessage[] = [];
  let seq = 0;
  return {
    push(message) {
      seq += 1;
      const full = { ...message, seq };
      messages.push(full);
      if (messages.length > limit) messages.splice(0, messages.length - limit);
      return full;
    },
    since(from, take = 200) {
      return messages.filter((m) => m.seq > from).slice(0, take);
    },
    latestSeq() {
      return seq;
    },
    clear() {
      messages.length = 0;
    },
  };
}
