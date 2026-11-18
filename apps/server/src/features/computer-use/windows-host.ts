/**
 * Windows 桌面后端的常驻进程客户端。
 *
 * 后端脚本以 `-Serve` 启动后循环读取 stdin 的 JSON 行并回写一行结果，C# 只编译一次；
 * 每个动作因此从「重启 PowerShell + 现场编译」降到一次进程内调用。请求串行发送：
 * 后端是单线程 STA，串行也避免多个输入动作互相穿插。
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface WindowsHostResponse {
  ok: boolean;
  id?: number;
  result?: unknown;
  error?: string;
  actionSent?: boolean;
}

export interface WindowsHostCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * PowerShell 5.1 在重定向场景可能带 BOM 或前导杂讯；截取首个 `{` 到末个 `}`
 * 再解析，避免把可用的结果误判成「非 JSON」。
 */
export function parseWindowsResponse<T>(stdout: string): WindowsHostResponse & {
  result?: T;
} {
  const text = stdout.replace(/^\uFEFF/u, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("stdout 中没有 JSON 对象");
  return JSON.parse(text.slice(start, end + 1)) as WindowsHostResponse & {
    result?: T;
  };
}

function excerpt(value: string, maxChars = 200): string {
  const text = value.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(message: string): string {
  return message.match(/^([a-z_]+):/)?.[1] ?? "native_failed";
}

interface Waiter {
  settle(response: WindowsHostResponse): void;
  fail(error: Error): void;
}

export class WindowsHost {
  readonly #spawn: () => ChildProcessWithoutNullStreams;
  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: Interface | null = null;
  #stderr = "";
  #waiters = new Map<number, Waiter>();
  #sequence = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #stopped = false;

  constructor(spawnHost: () => ChildProcessWithoutNullStreams) {
    this.#spawn = spawnHost;
  }

  call<T = unknown>(
    body: Record<string, unknown>,
    options: WindowsHostCallOptions,
  ): Promise<WindowsHostResponse & { result?: T }> {
    if (this.#stopped)
      return Promise.reject(hostError("cancelled", "Windows桌面后端已停止"));
    if (options.signal?.aborted)
      return Promise.reject(hostError("cancelled", "Windows桌面动作已取消"));
    const run = this.#tail.then(() => this.#dispatch<T>(body, options));
    this.#tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#dispose();
    this.#rejectAll(hostError("cancelled", "Windows桌面后端已停止"));
    await this.#tail;
  }

  #dispatch<T>(
    body: Record<string, unknown>,
    options: WindowsHostCallOptions,
  ): Promise<WindowsHostResponse & { result?: T }> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#ensureChild();
    } catch (error) {
      return Promise.reject(
        hostError(
          "native_failed",
          `Windows桌面进程启动失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.#waiters.delete(id);
      };
      const settle = (response: WindowsHostResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response as WindowsHostResponse & { result?: T });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        fail(hostError("cancelled", "Windows桌面动作已取消"));
        if (this.#child === child) this.#dispose();
      };
      const timer = setTimeout(
        () => {
          fail(hostError("native_timeout", "Windows桌面进程超时"));
          if (this.#child === child) this.#dispose();
        },
        Math.max(1, options.timeoutMs),
      );
      this.#waiters.set(id, { settle, fail });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
      } catch {
        fail(hostError("native_failed", "Windows桌面后端写入失败"));
        if (this.#child === child) this.#dispose();
      }
    });
  }

  #ensureChild(): ChildProcessWithoutNullStreams {
    if (this.#child) return this.#child;
    const child = this.#spawn();
    this.#child = child;
    this.#stderr = "";
    const reader = createInterface({ input: child.stdout });
    this.#reader = reader;
    reader.on("line", (line) => {
      if (this.#child !== child) return;
      this.#receive(line);
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.#child !== child) return;
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("error", (error) => {
      if (this.#child !== child) return;
      this.#failAll(
        "native_failed",
        `Windows桌面进程启动失败：${error.message}`,
      );
    });
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      const details = this.#stderr.trim() ? `：${excerpt(this.#stderr)}` : "";
      this.#failAll(
        "native_failed",
        `Windows桌面进程退出：${code ?? signal ?? "unknown"}${details}`,
      );
    });
    return child;
  }

  #receive(line: string): void {
    let response: WindowsHostResponse;
    try {
      response = parseWindowsResponse<unknown>(line);
    } catch {
      return;
    }
    if (typeof response.id === "number") {
      this.#waiters.get(response.id)?.settle(response);
      return;
    }
    if (response.ok === false && response.error)
      this.#failAll(errorCode(response.error), response.error);
  }

  #failAll(code: string, message: string): void {
    const error = hostError(code, message);
    this.#dispose();
    this.#rejectAll(error);
  }

  #rejectAll(error: Error): void {
    for (const waiter of [...this.#waiters.values()]) waiter.fail(error);
    this.#waiters.clear();
  }

  #dispose(): void {
    const child = this.#child;
    const reader = this.#reader;
    this.#child = null;
    this.#reader = null;
    this.#stderr = "";
    reader?.close();
    if (child && !child.killed) child.kill();
  }
}
