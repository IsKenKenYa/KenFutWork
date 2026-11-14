import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { processOwnerKey } from "./process-identity.js";
import {
  type SandboxProcessScope as CodeExecutionScope,
  type SandboxProcessSnapshot as ManagedProcessSnapshot,
  ProcessSandboxError,
} from "./types.js";

type ExitObservation = { code: number | null; signal: string | null };
type ErrorObservation = { name: string; message: string; code?: string };
type Observation =
  | { kind: "error"; error: Error }
  | { kind: "disconnect" }
  | ({ kind: "exit" | "close" } & ExitObservation);
type LifecycleEvent =
  | { kind: "error"; at: string; error: ErrorObservation }
  | { kind: "disconnect"; at: string }
  | ({ kind: "exit" | "close"; at: string } & ExitObservation);

function describeError(error: Error): ErrorObservation {
  return {
    name: error.name,
    message: error.message,
    ...("code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
  };
}

/** 只保留父端实际观察；不把 helper 退出当作命令范围清空。 */
export class HelperLifecycle {
  private readonly diagnosticId = randomUUID();
  private readonly events: LifecycleEvent[] = [];
  private readonly directory: string;
  private readonly identity: {
    instanceId: string;
    projectId: string;
    taskId?: string;
    projectOwner?: CodeExecutionScope;
    initialGeneration: number;
  };
  private helperPid: number | null = null;
  private exit: ExitObservation | undefined;
  private stderrTail = "";
  private closeAcknowledgedAt: string | null = null;
  private captureError: ErrorObservation | undefined;
  private projectCloseFinalized = false;

  constructor(
    captureRoot: string,
    scope: CodeExecutionScope,
    private readonly maxStderrChars: number,
    private readonly snapshots: () => Iterable<ManagedProcessSnapshot>,
  ) {
    this.identity = {
      instanceId: scope.instanceId,
      projectId: scope.projectId,
      ...("kind" in scope ? { projectOwner: scope } : { taskId: scope.taskId }),
      initialGeneration: scope.generation,
    };
    this.directory = join(
      captureRoot,
      createHash("sha256").update(processOwnerKey(scope)).digest("hex"),
      "helpers",
    );
  }

  stderr(data: Buffer): void {
    this.stderrTail = (this.stderrTail + data.toString("utf8")).slice(
      -this.maxStderrChars,
    );
    if (this.events.length > 0) this.persist();
  }

  acknowledgeClose(): void {
    this.closeAcknowledgedAt = new Date().toISOString();
    if (this.events.length > 0) this.persist();
  }

  async finalizeProjectClose(): Promise<void> {
    if (!this.identity.projectOwner) return;
    if (
      !this.closeAcknowledgedAt ||
      !this.events.some((event) => event.kind === "close")
    )
      throw this.failure();
    // close 是父端最后的 helper/stdio 观察；之后的迟到通知不能重建租约目录。
    this.projectCloseFinalized = true;
    try {
      await rm(dirname(this.directory), { recursive: true, force: true });
    } catch (error) {
      this.projectCloseFinalized = false;
      this.persist();
      throw error;
    }
  }

  observe(observation: Observation, pid?: number): void {
    if (pid !== undefined) this.helperPid = pid;
    if (this.events.some((event) => event.kind === observation.kind)) return;
    const at = new Date().toISOString();
    const event: LifecycleEvent =
      observation.kind === "error"
        ? { kind: "error", at, error: describeError(observation.error) }
        : { ...observation, at };
    this.events.push(event);
    if (event.kind === "exit")
      this.exit = { code: event.code, signal: event.signal };
    this.persist();
  }

  failure(): ProcessSandboxError {
    const suffix = this.exit
      ? `任务执行服务已退出（${this.exit.signal ?? this.exit.code}），命令退出状态尚未确认。`
      : "任务执行服务连接已断开，命令退出状态尚未确认。";
    return new ProcessSandboxError("stop_unconfirmed", suffix, {
      cause: {
        diagnosticId: this.diagnosticId,
        firstEvent: structuredClone(this.events[0]),
        ...(this.exit ? { exit: { ...this.exit } } : {}),
        ...(this.captureError
          ? { captureError: { ...this.captureError } }
          : {}),
      },
    });
  }

  private persist(): void {
    if (this.projectCloseFinalized) return;
    const partial = join(this.directory, `${this.diagnosticId}.partial`);
    let created = false;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const descriptor = openSync(partial, "wx", 0o600);
      created = true;
      try {
        writeFileSync(descriptor, JSON.stringify(this.record(), null, 2));
      } finally {
        closeSync(descriptor);
      }
      renameSync(partial, join(this.directory, `${this.diagnosticId}.json`));
      created = false;
      this.captureError = undefined;
    } catch (error) {
      this.captureError = describeError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      if (created) {
        try {
          unlinkSync(partial);
        } catch {
          // 诊断写入失败不能替代原始执行失败或伪造退出证明。
        }
      }
    }
  }

  private record() {
    return {
      diagnosticId: this.diagnosticId,
      identity: this.identity,
      helperPid: this.helperPid,
      firstEvent: this.events[0],
      events: this.events,
      ...(this.exit ? { exit: this.exit } : {}),
      closeAcknowledgedAt: this.closeAcknowledgedAt,
      stderrTail: this.stderrTail,
      processes: Array.from(this.snapshots(), (snapshot) => ({
        id: snapshot.id,
        invocationId: snapshot.invocationId,
        pid: snapshot.pid,
        generation: snapshot.generation,
        state: snapshot.state,
        exit: snapshot.exit,
      })),
    };
  }
}
