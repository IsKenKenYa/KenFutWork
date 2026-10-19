import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { getSystemErrorName } from "node:util";
import {
  type PosixSessionIdentity,
  PtySessionRange,
} from "./pty-session-range.js";
import type { ProcessLimits } from "./types.js";
import { ProcessSandboxError } from "./types.js";

export interface PipeLaunchAdmission {
  signal?: AbortSignal;
  assertReady?: () => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function launchFailure(message: string) {
  return new ProcessSandboxError("spawn_failed", `命令启动失败：${message}`);
}

/** 固定 native wrapper 的 fd3；不进入 stdout/stderr 或用户协议。 */
export class PipeSessionLaunch {
  readonly ready: Promise<void>;
  private readonly owned = deferred<PtySessionRange | undefined>();
  readonly ownership = this.owned.promise;
  private readonly hello = deferred<PosixSessionIdentity>();
  private readonly ended = deferred<void>();
  private readonly channel: Duplex;
  private failure: unknown;
  private pending = Buffer.alloc(0);
  private receivedBytes = 0;
  private helloReceived = false;
  private released = false;
  private releaseMayHaveBeenSent = false;

  constructor(
    child: ChildProcess,
    inspector: string,
    env: NodeJS.ProcessEnv,
    limits: ProcessLimits,
    private readonly admission: PipeLaunchAdmission,
  ) {
    // spawn 的固定额外 pipe 是双向 socket；不允许目标自行提供这个句柄。
    this.channel = child.stdio[3] as Duplex;
    this.channel.on("data", (data: Buffer) => this.receive(data, child.pid));
    this.channel.on("error", (error: Error) => this.cancel(error));
    this.channel.on("end", () => {
      if (this.pending.length || !this.released || !this.releaseMayHaveBeenSent)
        this.cancel(launchFailure("原生启动握手未完成。"));
      else this.ended.resolve();
    });
    this.channel.on("close", () => {
      if (!this.channel.readableEnded)
        this.cancel(launchFailure("原生启动通道提前关闭。"));
    });
    void this.hello.promise.catch(() => {});
    void this.ended.promise.catch(() => {});
    this.ready = this.initialize(inspector, env, limits);
  }

  cancel(reason: unknown = launchFailure("启动已取消。")): void {
    this.failure ??= reason;
    this.hello.reject(this.failure);
    this.ended.reject(this.failure);
    // 未放行 wrapper 只读此通道，EOF 自行退出；绝不猜 PID/PGID 发送信号。
    if (!this.channel.destroyed && !this.channel.writableEnded)
      this.channel.end();
  }

  private receive(data: Buffer, pid: number | undefined): void {
    if (this.failure) return;
    this.receivedBytes += data.length;
    if (this.receivedBytes > 1024) {
      this.cancel(launchFailure("原生启动握手过长。"));
      return;
    }
    this.pending = Buffer.concat([this.pending, data]);
    try {
      for (;;) {
        const end = this.pending.indexOf(10);
        if (end < 0) return;
        const line = new TextDecoder("utf-8", { fatal: true }).decode(
          this.pending.subarray(0, end),
        );
        this.pending = this.pending.subarray(end + 1);
        this.receiveLine(JSON.parse(line), pid);
      }
    } catch (error) {
      this.cancel(
        error instanceof ProcessSandboxError
          ? error
          : launchFailure("原生启动握手无效。"),
      );
    }
  }

  private receiveLine(value: unknown, pid: number | undefined): void {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw launchFailure("原生启动握手无效。");
    const frame = value as Record<string, unknown>;
    if (!this.helloReceived) {
      const { sessionId, startSec, startUsec } = frame;
      if (
        Object.keys(frame).length !== 3 ||
        sessionId !== pid ||
        typeof sessionId !== "number" ||
        !Number.isSafeInteger(sessionId) ||
        sessionId < 2 ||
        typeof startSec !== "number" ||
        !Number.isSafeInteger(startSec) ||
        startSec < 0 ||
        typeof startUsec !== "number" ||
        !Number.isSafeInteger(startUsec) ||
        startUsec < 0 ||
        startUsec >= 1_000_000
      )
        throw launchFailure("原生启动身份不匹配。");
      this.helloReceived = true;
      this.hello.resolve({ sessionId, startSec, startUsec });
      return;
    }
    if (Object.keys(frame).length !== 1 || !this.releaseMayHaveBeenSent)
      throw launchFailure("原生启动握手次序无效。");
    if (frame.released === true && !this.released) {
      this.released = true;
      return;
    }
    if (
      this.released &&
      typeof frame.exec_failed === "number" &&
      Number.isSafeInteger(frame.exec_failed) &&
      frame.exec_failed > 0
    ) {
      throw launchFailure(`exec ${getSystemErrorName(-frame.exec_failed)}。`);
    }
    throw launchFailure("原生启动握手次序无效。");
  }

  private async initialize(
    inspector: string,
    env: NodeJS.ProcessEnv,
    limits: ProcessLimits,
  ): Promise<void> {
    let range: PtySessionRange | undefined;
    const abort = () => this.cancel(this.admission.signal?.reason);
    // 启动握手必须有界，长期运行的 timeoutMs:null 不得取消这道上限。
    const deadline = setTimeout(
      () => this.cancel(launchFailure("原生启动握手超时。")),
      limits.killGraceMs,
    );
    this.admission.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (this.admission.signal?.aborted) abort();
      const identity = await this.hello.promise;
      range = await PtySessionRange.adopt(inspector, identity, limits);
      this.owned.resolve(range);
      if (this.failure) throw this.failure;
      this.admission.signal?.throwIfAborted();
      this.admission.assertReady?.();
      const environment = this.environmentFrame(env);
      // write 的回调失败也不证明 R 没有到达；所有后续收尾均按可能已执行处理。
      this.releaseMayHaveBeenSent = true;
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          this.channel.write(environment, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
        // 背压时 write 回调可一直不来；取消/超时仍须进入范围停止流程。
        this.ended.promise,
      ]);
      await this.ended.promise;
    } catch (error) {
      this.cancel(error);
      throw this.failure;
    } finally {
      this.owned.resolve(range);
      clearTimeout(deadline);
      this.admission.signal?.removeEventListener("abort", abort);
    }
  }

  private environmentFrame(env: NodeJS.ProcessEnv): Buffer {
    const entries: string[] = [];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      if (
        !key ||
        key.includes("=") ||
        key.includes("\0") ||
        value.includes("\0")
      )
        throw launchFailure("执行环境包含无效变量。");
      entries.push(`${key}=${value}\0`);
    }
    const payload = Buffer.from(entries.join(""), "utf8");
    const header = Buffer.alloc(5);
    header[0] = 82;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }
}
