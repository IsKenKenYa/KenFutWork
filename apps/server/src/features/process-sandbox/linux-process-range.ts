import { execFile } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { executionEnvironment } from "./environment.js";
import type { ProcessLimits } from "./types.js";
import { ProcessSandboxError } from "./types.js";

interface RangeSnapshot {
  memberCount: number;
  activeCount: number;
}
interface OpenSnapshot {
  gone?: boolean;
  pending?: boolean;
  namespacePid?: number;
  namespaceIno?: number;
  leaderBirth?: number;
}
const execute = promisify(execFile);

/** 固定 namespace FD 防 inode 复用；原生 pidfd 签发信号，范围包含嵌套 PID namespace。 */
export class LinuxProcessRange {
  private stopping: Promise<void> | undefined;
  private constructor(
    private readonly binary: string,
    private readonly namespace: FileHandle | null,
    private readonly limits: ProcessLimits,
  ) {}

  static async open(
    binary: string,
    leader: number,
    limits: ProcessLimits,
  ): Promise<LinuxProcessRange> {
    const started = Date.now();
    let leaderBirth: number | undefined;
    for (;;) {
      const snapshot = await LinuxProcessRange.call<OpenSnapshot>(
        binary,
        ["open", String(leader)],
        limits,
      );
      if (snapshot === null || typeof snapshot !== "object")
        throw new ProcessSandboxError(
          "enforcement_unavailable",
          "Linux inspector 返回无效范围身份。",
        );
      if (snapshot.gone === true)
        return new LinuxProcessRange(binary, null, limits);
      if (
        !Number.isSafeInteger(snapshot.leaderBirth) ||
        (snapshot.leaderBirth ?? 0) < 1 ||
        (leaderBirth !== undefined && leaderBirth !== snapshot.leaderBirth)
      )
        throw new ProcessSandboxError(
          "enforcement_unavailable",
          "Linux leader 身份改变，拒绝签发范围。",
        );
      leaderBirth = snapshot.leaderBirth;
      if (
        Number.isSafeInteger(snapshot.namespacePid) &&
        Number.isSafeInteger(snapshot.namespaceIno) &&
        (snapshot.namespacePid ?? 0) > 1 &&
        (snapshot.namespaceIno ?? 0) > 0
      ) {
        let namespace: FileHandle;
        try {
          namespace = await open(`/proc/${snapshot.namespacePid}/ns/pid`, "r");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if ((await namespace.stat()).ino !== snapshot.namespaceIno) {
          await namespace.close();
          continue;
        }
        return new LinuxProcessRange(binary, namespace, limits);
      }
      if (Date.now() - started >= limits.killGraceMs)
        throw new ProcessSandboxError(
          "enforcement_unavailable",
          "Linux command 没有确认独立 PID namespace。",
        );
      await delay(limits.yieldMs);
    }
  }

  private static async call<T>(
    binary: string,
    args: string[],
    limits: ProcessLimits,
  ): Promise<T> {
    try {
      const result = await execute(binary, args, {
        env: executionEnvironment(process.env),
        timeout: limits.killGraceMs,
      });
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new ProcessSandboxError(
        "stop_unconfirmed",
        `Linux namespace 范围尚未确认：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async query(signal?: NodeJS.Signals): Promise<RangeSnapshot> {
    if (!this.namespace)
      return Promise.resolve({ memberCount: 0, activeCount: 0 });
    const snapshot = await LinuxProcessRange.call<RangeSnapshot>(
      this.binary,
      [
        "scan",
        `/proc/${process.pid}/fd/${this.namespace.fd}`,
        ...(signal ? [String(constants.signals[signal])] : []),
      ],
      this.limits,
    );
    if (
      snapshot === null ||
      !Number.isSafeInteger(snapshot.memberCount) ||
      snapshot.memberCount < 0 ||
      !Number.isSafeInteger(snapshot.activeCount) ||
      snapshot.activeCount < 0 ||
      snapshot.activeCount > snapshot.memberCount
    )
      throw new ProcessSandboxError(
        "stop_unconfirmed",
        "Linux inspector 返回无效范围扫描。",
      );
    return snapshot;
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopNamespace();
    return this.stopping;
  }

  private async freeze(): Promise<void> {
    const started = Date.now();
    for (;;) {
      if ((await this.query("SIGSTOP")).activeCount === 0) return;
      if (Date.now() - started >= this.limits.killGraceMs)
        throw new ProcessSandboxError(
          "stop_unconfirmed",
          "无法冻结 Linux namespace 全部进程。",
        );
      await delay(this.limits.yieldMs);
    }
  }

  private async emptyWithin(): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if ((await this.query()).memberCount === 0) return true;
      if (Date.now() - started >= this.limits.killGraceMs) return false;
      await delay(this.limits.yieldMs);
    }
  }

  private async stopNamespace(): Promise<void> {
    if ((await this.query()).memberCount) {
      await this.freeze();
      // TERM 先到叶子命令，保留 namespace reaper / launcher，让 handler 能完成清理。
      await this.query("SIGTERM");
      await this.query("SIGCONT");
      if (!(await this.emptyWithin())) {
        await this.freeze();
        await this.query("SIGKILL");
        if (!(await this.emptyWithin()))
          throw new ProcessSandboxError(
            "stop_unconfirmed",
            "Linux PID namespace 仍有进程，停止未确认。",
          );
      }
    }
    await this.namespace?.close();
  }
}
