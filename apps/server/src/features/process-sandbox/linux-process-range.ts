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

  /**
   * 尽力冻结（SIGSTOP）范围内进程，返回是否全部停住。
   *
   * 冻结不彻底**不是**停止失败：处于不可中断睡眠（D）的进程收不到 SIGSTOP，
   * 但 SIGKILL 仍然有效。把它当致命错误抛出会让整条停止流程在 TERM/KILL 之前就中止，
   * 真正的保证在后面的「SIGKILL 后范围归零」那一步（做不到才报 stop_unconfirmed）。
   */
  private async freeze(): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if ((await this.query("SIGSTOP")).activeCount === 0) return true;
      if (Date.now() - started >= this.limits.killGraceMs) return false;
      await delay(this.limits.yieldMs);
    }
  }

  /** 返回仍未清空的最后一次扫描（含计数，报错要能看出还剩几个）；清空则返回 null。 */
  private async remainingWithin(): Promise<RangeSnapshot | null> {
    const started = Date.now();
    for (;;) {
      const snapshot = await this.query();
      if (snapshot.memberCount === 0) return null;
      if (Date.now() - started >= this.limits.killGraceMs) return snapshot;
      await delay(this.limits.yieldMs);
    }
  }

  private async stopNamespace(): Promise<void> {
    if ((await this.query()).memberCount) {
      await this.freeze();
      // TERM 先到叶子命令，保留 namespace reaper / launcher，让 handler 能完成清理。
      await this.query("SIGTERM");
      await this.query("SIGCONT");
      if (await this.remainingWithin()) {
        await this.freeze();
        await this.query("SIGKILL");
        const left = await this.remainingWithin();
        if (left)
          throw new ProcessSandboxError(
            "stop_unconfirmed",
            `Linux PID namespace 在 SIGKILL 后 ${this.limits.killGraceMs}ms 内仍有 ${left.memberCount} 个进程（活跃 ${left.activeCount}），停止未确认——若活跃数为 0 则是没人回收的僵尸，容器 PID 1 必须是会 reap 的 init。`,
          );
      }
    }
    await this.namespace?.close();
  }
}
