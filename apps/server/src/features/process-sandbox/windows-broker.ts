import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { ProcessSpawnRequest } from "./types.js";
import { ProcessSandboxError } from "./types.js";

export type NativeProcessEvent =
  | {
      event: "output";
      processId: string;
      stream: "stdout" | "stderr";
      data: string;
      sequence: number | null;
    }
  | { event: "native-exit"; processId: string }
  | { event: "stream-end"; processId: string; stream: "stdout" | "stderr" }
  | {
      event: "exit";
      processId: string;
      exitCode: number | null;
      rangeEmpty: boolean;
      failure?: string | null;
    }
  | { event: "failure"; processId: string; code: string; message: string };

export interface NativeLaunch {
  processId: string;
  taskId: string;
  generation: number;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  readRoots: string[];
  writeRoots: string[];
  denyRoots: string[];
  yieldMs: number;
  killGraceMs: number;
  chunkBytes: number;
  liveStreams: boolean;
  pty: { cols: number; rows: number } | null;
}

export function windowsCommand(request: ProcessSpawnRequest): string[] {
  if (request.argv) return [request.argv.executable, ...request.argv.args];
  if (!request.command)
    throw new ProcessSandboxError("invalid_process_request", "没有提供命令。");
  const shell = request.shell ?? process.env.ComSpec ?? process.env.COMSPEC;
  if (!shell)
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      "没有配置 Windows 执行 shell。",
    );
  if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell))
    return [shell, "/d", "/s", "/c", request.command];
  if (/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell))
    return [shell, "-NoLogo", "-NoProfile", "-Command", request.command];
  if (/(?:^|[\\/])(?:bash|sh)(?:\.exe)?$/i.test(shell))
    return [shell, "-lc", request.command];
  throw new ProcessSandboxError(
    "invalid_process_request",
    "不支持的 Windows shell；请使用 cmd、PowerShell 或 Git Bash。",
  );
}

/** 每 Task 一个原生 broker；每次 spawn 是独立 PSEC 内核读取域/Job，不使用共享 ACL 组。 */
export class WindowsTaskBroker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private readonly listeners = new Map<
    string,
    (event: NativeProcessEvent) => void
  >();
  private closed = false;

  constructor(path: string, env: Record<string, string>) {
    this.child = spawn(path, [], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on(
      "line",
      (line) => {
        let message:
          | NativeProcessEvent
          | {
              id: string;
              ok: boolean;
              value?: unknown;
              error?: { code: string; message: string };
            };
        try {
          message = JSON.parse(line);
        } catch {
          this.disconnected("原生 broker 输出不是有效 IPC。");
          return;
        }
        if ("event" in message) {
          this.listeners.get(message.processId)?.(message);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else
          pending.reject(
            new ProcessSandboxError(
              (message.error?.code ??
                "enforcement_unavailable") as ProcessSandboxError["code"],
              message.error?.message ?? "原生 broker 执行失败。",
            ),
          );
      },
    );
    // 仅用于 broker 自身异常，不把无上下文诊断当作已确认的命令退出。
    this.child.stderr.resume();
    this.child.on("error", (error) => this.disconnected(error.message));
    this.child.on("exit", () =>
      this.disconnected("原生 broker 已退出，命令退出状态尚未确认。"),
    );
  }

  listen(
    processId: string,
    listener: (event: NativeProcessEvent) => void,
  ): () => void {
    this.listeners.set(processId, listener);
    return () => this.listeners.delete(processId);
  }

  async rpc(input: Record<string, unknown>): Promise<unknown> {
    if (this.closed)
      throw new ProcessSandboxError("stop_unconfirmed", "原生 broker 不可达。");
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.child.stdin.write(`${JSON.stringify({ ...input, id })}\n`, (error) => {
      if (!error) return;
      this.pending
        .get(id)
        ?.reject(new ProcessSandboxError("spawn_failed", error.message));
      this.pending.delete(id);
    });
    return promise;
  }

  async close(): Promise<void> {
    await this.rpc({ method: "close" });
    this.child.stdin.end();
  }

  private disconnected(message: string): void {
    this.closed = true;
    for (const pending of this.pending.values())
      pending.reject(new ProcessSandboxError("stop_unconfirmed", message));
    this.pending.clear();
    for (const [processId, listener] of this.listeners)
      listener({
        event: "failure",
        processId,
        code: "stop_unconfirmed",
        message,
      });
  }
}
