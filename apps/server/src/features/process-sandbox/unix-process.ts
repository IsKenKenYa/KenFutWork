import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type * as NodePty from "node-pty";
import type { IPty } from "node-pty";
import { LinuxProcessRange } from "./linux-process-range.js";
import type { ProcessOutputCapture } from "./output-capture.js";
import { PipeOutputRelay } from "./pipe-output.js";
import { PtySessionRange } from "./pty-session-range.js";
import type {
  ManagedProcessSnapshot,
  ProcessExit,
  ProcessOutputStream,
  ProcessSpawnRequest,
} from "./types.js";
import { ProcessSandboxError } from "./types.js";

/** Task 私有、经结构校验适配过的 node-pty；不扩散到 public interface。 */
interface TaskPty extends IPty {
  __kfwHoldExitWhilePaused?: boolean;
  on(event: "__kfwNativeExit", listener: () => void): void;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function groupExists(pid: number): boolean | null {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // Darwin 在本 helper 的未 reap zombie 窗口会报 EPERM；仅 ESRCH 证明范围为空。
    if ((error as NodeJS.ErrnoException).code === "EPERM") return null;
    throw new ProcessSandboxError(
      "stop_unconfirmed",
      `无法检查进程组 ${pid}：${(error as NodeJS.ErrnoException).code}`,
    );
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      throw new ProcessSandboxError(
        "stop_unconfirmed",
        `无法向进程组 ${pid} 发送 ${signal}：${(error as NodeJS.ErrnoException).code}`,
      );
  }
}

export class UnixManagedProcess {
  readonly scope: ProcessSpawnRequest["scope"];
  private readonly child: ChildProcess | undefined;
  private readonly pty: TaskPty | undefined;
  private readonly settled = deferred<ProcessExit>();
  private readonly closed = deferred<void>();
  readonly ready = deferred<void>();
  private captureFinished = false;
  private stopPromise: Promise<ProcessExit> | undefined;
  private requestedReason: string | null = null;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private snapshotValue: ManagedProcessSnapshot;
  private outputSequence = 0;
  private liveOutputOffset = 0;
  private pendingOutput: number | null = null;
  private liveOutputClosed = false;
  private ptyRange: Promise<PtySessionRange> | undefined;
  private linuxRange: Promise<LinuxProcessRange> | undefined;
  private outputReader = false;
  private nativeExited = false;
  private readonly pipeOutput = new Map<ProcessOutputStream, PipeOutputRelay>();

  constructor(
    descriptor: { argv: string[]; env: NodeJS.ProcessEnv },
    private readonly request: ProcessSpawnRequest,
    cwd: string,
    private readonly capture: ProcessOutputCapture,
    initial: ManagedProcessSnapshot,
    private readonly changed: (snapshot: ManagedProcessSnapshot) => void,
    private readonly cleanup: () => void,
    private readonly ptyModule?: typeof NodePty,
    private readonly sendOutput?: (
      sequence: number,
      data: string,
      offset: number,
      nextOffset: number,
      stream?: ProcessOutputStream,
    ) => void,
    private readonly sessionInspector?: string,
    private readonly linuxInspector?: string,
  ) {
    this.scope = structuredClone(request.scope);
    this.snapshotValue = initial;
    const executable = descriptor.argv[0];
    if (!executable)
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        "沙箱 launcher 未生成可执行入口。",
      );

    if (request.pty)
      this.pty = this.startPty(
        executable,
        descriptor.argv.slice(1),
        cwd,
        descriptor.env,
      );
    else
      this.child = this.startPipe(
        executable,
        descriptor.argv.slice(1),
        cwd,
        descriptor.env,
      );
    if (request.timeoutMs !== undefined && request.timeoutMs !== null) {
      this.deadline = setTimeout(() => {
        void this.stop("deadline_exceeded").catch(() => {});
      }, request.timeoutMs);
    }
    // 消费端可以稍后 wait；先安装 rejection handler 防止启动失败形成未处理 Promise。
    void this.settled.promise.catch(() => {});
    void this.ready.promise.catch(() => {});
  }

  private append(stream: ProcessOutputStream, data: Buffer): void {
    try {
      this.capture.append(data, stream);
      this.publish();
      this.flushCapturedOutput();
    } catch {
      void this.stop("output_failed").catch(() => {});
      this.snapshotValue.state = "failed";
      this.publish();
    }
  }

  private startPty(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): TaskPty {
    const size = this.request.pty;
    if (!size)
      throw new ProcessSandboxError(
        "invalid_process_request",
        "缺少 PTY 尺寸。",
      );
    let pty: TaskPty;
    try {
      const module = this.ptyModule;
      if (!module) throw new Error("Task 私有 PTY native runtime 未准备。");
      pty = module.spawn(executable, args, {
        cwd,
        env: { ...env, TERM: "xterm-256color" },
        cols: size.cols,
        rows: size.rows,
        name: "xterm-256color",
      }) as TaskPty;
    } catch (error) {
      this.capture.close();
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        `真实 PTY 不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    pty.on("__kfwNativeExit", () => {
      this.nativeExited = true;
      if (!this.outputReader) {
        // 没有 live reader 时仍读尽到有界 capture；首个 pending frame 留在宿主供晚订阅。
        this.liveOutputClosed = true;
        pty.resume();
      }
    });
    pty.onData((data) => {
      const offset = this.capture.totalBytes;
      this.append("stdout", Buffer.from(data));
      if (this.liveOutputClosed || !this.sendOutput) return;
      pty.pause();
      this.pendingOutput = ++this.outputSequence;
      this.liveOutputOffset = this.capture.totalBytes;
      this.sendOutput(this.outputSequence, data, offset, this.liveOutputOffset);
    });
    pty.onExit(({ exitCode, signal }) => {
      const name = (Object.entries(constants.signals).find(
        ([, value]) => value === signal,
      )?.[0] ?? null) as NodeJS.Signals | null;
      this.exited(exitCode, name);
    });
    this.snapshotValue.pid = pty.pid;
    if (process.platform === "linux") {
      this.openLinuxRange(pty.pid, () => pty.kill("SIGKILL"));
      return pty;
    }
    if (!this.sessionInspector)
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        "缺少原生 PTY session inspector。",
      );
    this.ptyRange = PtySessionRange.open(
      this.sessionInspector,
      pty.pid,
      this.request.limits,
    );
    void this.ptyRange.then(
      () => {
        if (this.snapshotValue.exit === null && this.requestedReason === null)
          this.snapshotValue.state = "running";
        this.publish();
        this.ready.resolve();
      },
      (error: unknown) => {
        try {
          pty.kill("SIGKILL");
        } catch {
          /* 原范围未确认事实仍由 ready rejection 保留。 */
        }
        this.snapshotValue.state = "failed";
        this.publish();
        this.ready.reject(error);
      },
    );
    return pty;
  }

  private startPipe(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): ChildProcess {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const [stream, input] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      if (!input) continue;
      if (this.request.stdio && this.sendOutput) {
        this.pipeOutput.set(
          stream,
          new PipeOutputRelay(
            input,
            stream,
            (source, data) => this.append(source, data),
            (sequence, data, offset, nextOffset, source) =>
              this.sendOutput?.(sequence, data, offset, nextOffset, source),
          ),
        );
      } else input.on("data", (data: Buffer) => this.append(stream, data));
    }
    child.on("spawn", () => {
      this.snapshotValue.pid = child.pid ?? null;
      if (process.platform === "linux" && child.pid)
        this.openLinuxRange(child.pid, () => child.kill("SIGKILL"));
      else {
        this.snapshotValue.state = "running";
        this.publish();
        this.ready.resolve();
      }
    });
    child.on("error", (error) => {
      this.closed.resolve();
      this.snapshotValue.state = "failed";
      this.publish();
      const failure = new ProcessSandboxError(
        "spawn_failed",
        `命令启动失败：${error.message}`,
      );
      this.settled.reject(failure);
      this.ready.reject(failure);
      this.finishCapture();
    });
    child.on("close", (exitCode, signal) => this.exited(exitCode, signal));
    return child;
  }

  private openLinuxRange(pid: number, kill: () => unknown): void {
    if (!this.linuxInspector) {
      kill();
      this.ready.reject(
        new ProcessSandboxError(
          "enforcement_unavailable",
          "Linux namespace inspector 未准备。",
        ),
      );
      return;
    }
    this.linuxRange = LinuxProcessRange.open(
      this.linuxInspector,
      pid,
      this.request.limits,
    );
    void this.linuxRange.then(
      () => {
        if (this.snapshotValue.exit === null && this.requestedReason === null)
          this.snapshotValue.state = "running";
        this.publish();
        this.ready.resolve();
      },
      (error: unknown) => {
        kill();
        this.snapshotValue.state = "failed";
        this.publish();
        this.ready.reject(error);
      },
    );
  }

  private exited(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.closed.resolve();
    void this.finish(exitCode, signal).catch((error: unknown) =>
      this.settled.reject(error),
    );
  }

  snapshot(): ManagedProcessSnapshot {
    return structuredClone(this.snapshotValue);
  }
  output(offset: number, maxBytes: number, stream?: ProcessOutputStream) {
    return this.capture.read(
      offset,
      maxBytes,
      this.snapshotValue.exit !== null,
      stream,
    );
  }
  wait(): Promise<ProcessExit> {
    return this.settled.promise;
  }

  async stdin(data: string): Promise<void> {
    if (this.pty) {
      if (
        this.requestedReason !== null ||
        this.snapshotValue.state !== "running"
      )
        throw new ProcessSandboxError(
          "process_closed",
          "终端已停止或退出，不能继续输入。",
        );
      this.pty.write(data);
      return;
    }
    const stdin = this.child?.stdin;
    if (
      this.requestedReason !== null ||
      this.snapshotValue.state !== "running" ||
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded
    ) {
      throw new ProcessSandboxError(
        "process_closed",
        "命令已经停止或退出，无法继续写入 stdin。",
      );
    }
    await new Promise<void>((resolveWrite, reject) => {
      stdin.write(data, (error) => {
        if (error) reject(error);
        else resolveWrite();
      });
    });
  }

  setOutputReader(active: boolean, stream?: ProcessOutputStream): void {
    if (stream) {
      if (!this.pipeOutput.has(stream))
        throw new ProcessSandboxError(
          "invalid_process_request",
          "该命令没有完整 stdio 流。",
        );
      return;
    }
    this.outputReader = active;
    const pty = this.pty;
    if (!pty)
      throw new ProcessSandboxError(
        "invalid_process_request",
        "该命令没有 PTY reader。",
      );
    pty.__kfwHoldExitWhilePaused = active;
    if (!active && this.nativeExited) {
      this.liveOutputClosed = true;
      pty.resume();
    }
    this.flushCapturedOutput();
  }

  acknowledgeOutput(sequence: number, stream?: ProcessOutputStream): void {
    if (stream) {
      const relay = this.pipeOutput.get(stream);
      if (!relay)
        throw new ProcessSandboxError(
          "invalid_process_request",
          "该命令没有完整 stdio 流。",
        );
      relay.acknowledge(sequence);
      return;
    }
    if (
      sequence > this.outputSequence ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    )
      throw new ProcessSandboxError(
        "invalid_process_request",
        "PTY 输出 ACK 序号无效。",
      );
    if (this.pendingOutput !== sequence) return;
    this.pendingOutput = null;
    if (!this.liveOutputClosed) this.pty?.resume();
    else this.flushCapturedOutput();
  }

  /** native退出后无reader的尾部已落有界日志；晚reader继续原游标，逐帧ACK后才补下一帧。 */
  private flushCapturedOutput(): void {
    if (
      !this.liveOutputClosed ||
      !this.outputReader ||
      this.pendingOutput !== null ||
      !this.sendOutput ||
      this.liveOutputOffset >= this.capture.retainedBytes
    )
      return;
    const output = this.capture.read(
      this.liveOutputOffset,
      this.capture.retainedBytes - this.liveOutputOffset,
      this.captureFinished,
    );
    if (!output.data) return;
    this.pendingOutput = ++this.outputSequence;
    this.liveOutputOffset = output.nextOffset;
    this.sendOutput(
      this.outputSequence,
      output.data,
      output.offset,
      output.nextOffset,
    );
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (
      !Number.isSafeInteger(cols) ||
      cols < 2 ||
      !Number.isSafeInteger(rows) ||
      rows < 1
    )
      throw new ProcessSandboxError(
        "invalid_process_request",
        "PTY 尺寸无效。",
      );
    if (
      !this.pty ||
      this.requestedReason !== null ||
      this.snapshotValue.state !== "running"
    )
      throw new ProcessSandboxError(
        "process_closed",
        "终端已停止或退出，无法调整尺寸。",
      );
    this.pty.resize(cols, rows);
  }

  async endStdin(): Promise<void> {
    if (this.pty)
      throw new ProcessSandboxError(
        "invalid_process_request",
        "PTY 没有独立 stdin EOF；请发送原始 Ctrl+D 或显式停止终端。",
      );
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    await new Promise<void>((resolveEnd, reject) => {
      stdin.end((error?: Error | null) => {
        if (error) reject(error);
        else resolveEnd();
      });
    });
  }

  stop(reason: string): Promise<ProcessExit> {
    this.stopPromise ??= this.stopOwnedRange(reason);
    return this.stopPromise;
  }

  private async stopOwnedRange(reason: string): Promise<ProcessExit> {
    if (this.snapshotValue.exit !== null) return this.snapshotValue.exit;
    this.requestedReason = reason;
    this.liveOutputClosed = true;
    this.pty?.resume();
    this.child?.stdin?.destroy();
    for (const relay of this.pipeOutput.values()) relay.close();
    if (this.ptyRange || this.linuxRange) {
      await (await (this.ptyRange ?? this.linuxRange))?.stop();
      await this.closed.promise;
      return this.wait();
    }
    const pid = this.child?.pid ?? this.pty?.pid;
    if (pid === undefined) {
      this.child?.kill("SIGKILL");
      return this.wait();
    }
    signalGroup(pid, "SIGTERM");
    if (!(await this.waitGroup(pid, this.request.limits.killGraceMs))) {
      signalGroup(pid, "SIGKILL");
      if (!(await this.waitGroup(pid, this.request.limits.killGraceMs))) {
        this.snapshotValue.state = "failed";
        this.publish();
        throw new ProcessSandboxError(
          "stop_unconfirmed",
          "无法确认命令管理范围已退出；权限撤销仍未完成。",
        );
      }
    }
    await this.closed.promise;
    return this.wait();
  }

  private async waitGroup(pid: number, timeoutMs?: number): Promise<boolean> {
    const started = Date.now();
    while (groupExists(pid) !== false) {
      if (timeoutMs !== undefined && Date.now() - started >= timeoutMs)
        return false;
      await delay(this.request.limits.yieldMs);
    }
    return true;
  }

  private async finish(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.snapshotValue.exit !== null) return;
    if (this.ptyRange || this.linuxRange)
      await (await (this.ptyRange ?? this.linuxRange))?.stop();
    else {
      const pid = this.child?.pid ?? this.pty?.pid;
      if (pid !== undefined) await this.waitGroup(pid);
    }
    const exit: ProcessExit = {
      exitCode,
      signal,
      reason: this.requestedReason,
      stopped: this.requestedReason !== null,
      rangeEmpty: true,
    };
    this.snapshotValue.exit = exit;
    this.snapshotValue.finishedAt = new Date().toISOString();
    this.snapshotValue.state = exit.stopped ? "stopped" : "exited";
    this.finishCapture();
    this.publish();
    this.settled.resolve(exit);
  }

  private finishCapture(): void {
    if (this.captureFinished) return;
    this.captureFinished = true;
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.capture.close();
    this.flushCapturedOutput();
    this.cleanup();
  }

  private publish(): void {
    this.snapshotValue.retainedBytes = this.capture.retainedBytes;
    this.snapshotValue.totalBytes = this.capture.totalBytes;
    this.snapshotValue.discardedBytes =
      this.capture.totalBytes - this.capture.retainedBytes;
    this.changed(this.snapshot());
  }
}
