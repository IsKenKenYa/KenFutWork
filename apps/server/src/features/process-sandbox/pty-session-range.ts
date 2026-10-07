import { execFile } from "node:child_process";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { executionEnvironment } from "./environment.js";
import type { ProcessLimits } from "./types.js";
import { ProcessSandboxError } from "./types.js";

interface SessionSnapshot {
  sessionId: number;
  startSec: number;
  startUsec: number;
  members: Array<{
    pid: number;
    groupId: number;
    startSec: number;
    startUsec: number;
    state: "active" | "stopped" | "zombie";
  }>;
}
const execute = promisify(execFile);

/** 以原生 SID/birth 签发范围；TTY 名称复用不会把其它会话纳入。 */
export class PtySessionRange {
  private stopping: Promise<void> | undefined;
  private constructor(
    private readonly binary: string,
    private readonly identity: SessionSnapshot,
    private readonly limits: ProcessLimits,
  ) {}

  static async open(
    binary: string,
    leader: number,
    limits: ProcessLimits,
  ): Promise<PtySessionRange> {
    const identity = await PtySessionRange.call(
      binary,
      ["open", String(leader), "0", "0"],
      limits,
    );
    if (identity.sessionId !== leader)
      throw new ProcessSandboxError(
        "stop_unconfirmed",
        "PTY leader 未签发相同的 session 身份。",
      );
    return new PtySessionRange(binary, identity, limits);
  }

  private static async call(
    binary: string,
    args: string[],
    limits: ProcessLimits,
  ): Promise<SessionSnapshot> {
    try {
      const result = await execute(binary, args, {
        env: executionEnvironment(process.env),
        timeout: limits.killGraceMs,
        maxBuffer: limits.previewMaxChars,
      });
      const snapshot = JSON.parse(result.stdout) as SessionSnapshot;
      if (
        !Number.isSafeInteger(snapshot.sessionId) ||
        snapshot.sessionId < 2 ||
        !Array.isArray(snapshot.members)
      )
        throw new Error("native inspector 返回无效身份");
      return snapshot;
    } catch (error) {
      throw new ProcessSandboxError(
        "stop_unconfirmed",
        `PTY session 范围尚未确认：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private query(signal?: NodeJS.Signals): Promise<SessionSnapshot> {
    const identity = this.identity;
    const args = [
      signal ? "signal" : "scan",
      String(identity.sessionId),
      String(identity.startSec),
      String(identity.startUsec),
    ];
    if (signal) args.push(String(constants.signals[signal]));
    return PtySessionRange.call(this.binary, args, this.limits);
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopSession();
    return this.stopping;
  }

  private async freeze(): Promise<void> {
    const started = Date.now();
    for (;;) {
      const snapshot = await this.query("SIGSTOP");
      if (snapshot.members.every((member) => member.state !== "active")) return;
      if (Date.now() - started >= this.limits.killGraceMs)
        throw new ProcessSandboxError(
          "stop_unconfirmed",
          "无法冻结全部 PTY session 作业，停止尚未确认。",
        );
      await delay(this.limits.yieldMs);
    }
  }

  private async emptyWithin(): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if ((await this.query()).members.length === 0) return true;
      if (Date.now() - started >= this.limits.killGraceMs) return false;
      await delay(this.limits.yieldMs);
    }
  }

  private async stopSession(): Promise<void> {
    if ((await this.query()).members.length === 0) return;
    await this.freeze();
    await this.query("SIGTERM");
    await this.query("SIGCONT");
    if (await this.emptyWithin()) return;
    await this.freeze();
    await this.query("SIGKILL");
    if (!(await this.emptyWithin()))
      throw new ProcessSandboxError(
        "stop_unconfirmed",
        "PTY session 仍有存活作业，不能确认范围为空。",
      );
  }
}
