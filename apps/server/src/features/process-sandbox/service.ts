import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { executionEnvironment } from "./environment.js";
import { LiveOutputConsumer } from "./live-output.js";
import type { HelperRequest, HelperResponse } from "./protocol.js";
import { createProcessRestoreCoordinator } from "./restore-barrier.js";
import type {
  ManagedProcessSnapshot,
  ManagedStdioProcess,
  ManagedTerminalProcess,
  ProcessExit,
  ProcessOutput,
  ProcessOutputStream,
  ProcessPtySpawnRequest,
  ProcessSandbox,
  ProcessSandboxOptions,
  ProcessSpawnRequest,
} from "./types.js";
import { ProcessSandboxError } from "./types.js";

type RpcInput = HelperRequest extends infer Request
  ? Request extends HelperRequest
    ? Omit<Request, "id">
    : never
  : never;

class TaskConnection {
  private readonly child: ChildProcess;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  readonly snapshots = new Map<string, ManagedProcessSnapshot>();
  private closed = false;
  private diagnostics = "";
  private closePromise: Promise<void> | undefined;
  private readonly liveOutput = new Map<string, LiveOutputConsumer>();

  constructor(
    private readonly options: ProcessSandboxOptions,
    initial: ProcessSpawnRequest,
  ) {
    const development = import.meta.url.endsWith(".ts");
    const helper =
      options.helperPath ??
      fileURLToPath(
        new URL(
          development ? "./task-helper.ts" : "./task-helper.js",
          import.meta.url,
        ),
      );
    if (isSea() && (!options.nodePath || options.nodePath === process.execPath))
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        "SEA 服务必须配置随包的独立 Node binary，不能拿服务本体启动 helper。",
      );
    this.child = fork(helper, [], {
      execPath: options.nodePath ?? process.execPath,
      execArgv:
        options.helperExecArgv ??
        (helper.endsWith(".ts")
          ? ["--import", import.meta.resolve("tsx")]
          : []),
      cwd: initial.scope.rootDirectory,
      env: executionEnvironment(process.env),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    this.child.stderr?.on("data", (data: Buffer) => {
      this.diagnostics = (this.diagnostics + data.toString("utf8")).slice(
        -initial.limits.previewMaxChars,
      );
    });
    this.child.on("message", (message: HelperResponse) => {
      if ("event" in message) {
        if (
          message.event === "pty-output" ||
          message.event === "stdio-output"
        ) {
          this.outputConsumer(
            message.processId,
            message.event === "stdio-output" ? message.stream : undefined,
          ).receive(message);
          return;
        }
        this.snapshots.set(message.snapshot.id, message.snapshot);
        options.onSnapshot?.(structuredClone(message.snapshot));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else
        pending.reject(
          new ProcessSandboxError(
            message.error.code as ProcessSandboxError["code"],
            message.error.message,
          ),
        );
    });
    this.child.on("error", (error) => this.disconnect(error.message));
    this.child.on("exit", (code, signal) =>
      this.disconnect(`helper 退出（${signal ?? code}）：${this.diagnostics}`),
    );
    this.child.on("disconnect", () =>
      this.disconnect("进程 helper IPC 已断开。"),
    );
  }

  outputConsumer(
    processId: string,
    stream?: ProcessOutputStream,
  ): LiveOutputConsumer {
    const key = JSON.stringify([processId, stream ?? "terminal"]);
    let consumer = this.liveOutput.get(key);
    if (!consumer) {
      consumer = new LiveOutputConsumer(
        (sequence) =>
          this.rpc({
            method: "outputack",
            processId,
            sequence,
            ...(stream ? { stream } : {}),
          }),
        () =>
          this.rpc({
            method: "stop",
            processId,
            reason: "output_consumer_failed",
          }),
        (active) =>
          this.rpc({
            method: "outputreader",
            processId,
            active,
            ...(stream ? { stream } : {}),
          }),
      );
      this.liveOutput.set(key, consumer);
    }
    return consumer;
  }

  initialize(initial: ProcessSpawnRequest): Promise<unknown> {
    return this.rpc({
      method: "initialize",
      taskId: initial.scope.taskId,
      initial,
      options: {
        captureRoot: this.options.captureRoot,
        network: this.options.network,
        ...(this.options.runtimeReadRoots
          ? { runtimeReadRoots: this.options.runtimeReadRoots }
          : {}),
        ...(this.options.windowsBrokerPath
          ? { windowsBrokerPath: this.options.windowsBrokerPath }
          : {}),
      },
    });
  }

  async rpc(input: RpcInput): Promise<unknown> {
    if (this.closed || !this.child.connected)
      throw new ProcessSandboxError(
        "stop_unconfirmed",
        "进程 helper 不可达，尚无管理范围退出证据。",
      );
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.child.send({ ...input, id }, (error) => {
      if (!error) return;
      this.pending
        .get(id)
        ?.reject(new ProcessSandboxError("spawn_failed", error.message));
      this.pending.delete(id);
    });
    return promise;
  }

  close(reason: string): Promise<void> {
    this.closePromise ??= (async () => {
      await this.rpc({ method: "close", reason });
      if (this.child.connected) this.child.disconnect();
    })();
    return this.closePromise;
  }

  private disconnect(detail: string): void {
    this.closed = true;
    for (const pending of this.pending.values())
      pending.reject(new ProcessSandboxError("stop_unconfirmed", detail));
    this.pending.clear();
  }
}

interface TaskEntry {
  connection: Promise<TaskConnection>;
  initialized: Promise<unknown>;
  generation: number;
  workspaceId: string;
  projectId: string;
  rootDirectory: string;
  phase: "ready" | "revoking" | "failed" | "closed";
  closeConfirmed: boolean;
  barrier: Promise<void>;
  closePromise?: Promise<void>;
}

function validateRequest(request: ProcessSpawnRequest): void {
  if (request.stdio && (!request.argv || request.pty))
    throw new ProcessSandboxError(
      "invalid_process_request",
      "完整 stdio 必须使用精确 argv，不能混用 PTY。",
    );
  const tokens = request.argv
    ? [request.argv.executable, ...request.argv.args]
    : [request.command ?? ""];
  if (
    Boolean(request.argv) === Boolean(request.command) ||
    !tokens[0]?.trim() ||
    tokens.some((token) => token.includes("\0")) ||
    !request.agentId ||
    !request.invocationId
  ) {
    throw new ProcessSandboxError(
      "invalid_process_request",
      "命令或执行身份无效。",
    );
  }
  if (
    request.pty &&
    (!request.argv ||
      !Number.isSafeInteger(request.pty.cols) ||
      request.pty.cols < 2 ||
      !Number.isSafeInteger(request.pty.rows) ||
      request.pty.rows < 1)
  )
    throw new ProcessSandboxError(
      "invalid_process_request",
      "PTY 必须使用精确 argv 与有效列行尺寸。",
    );
  // Win32 COORD is signed 16-bit; native capability checks still decide actual support.
  if (
    process.platform === "win32" &&
    request.pty &&
    (request.pty.cols > 0x7fff || request.pty.rows > 0x7fff)
  )
    throw new ProcessSandboxError(
      "invalid_process_request",
      "ConPTY 尺寸超出 COORD 范围。",
    );
  for (const value of Object.values(request.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ProcessSandboxError(
        "invalid_process_request",
        "进程治理限额必须是正整数。",
      );
  }
  if (
    request.timeoutMs !== undefined &&
    request.timeoutMs !== null &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
  ) {
    throw new ProcessSandboxError(
      "invalid_process_request",
      "命令 deadline 必须是正整数或 null。",
    );
  }
}

export function createProcessSandbox(
  options: ProcessSandboxOptions,
): ProcessSandbox {
  const tasks = new Map<string, TaskEntry>();
  const restore = createProcessRestoreCoordinator();
  const closedTasks = new Map<string, number>();
  const minimumGenerations = new Map<string, number>();
  let closed = false;

  const rejectStaleGeneration = (taskId: string, generation: number): void => {
    const floor = Math.max(
      tasks.get(taskId)?.generation ?? 0,
      minimumGenerations.get(taskId) ?? 0,
      closedTasks.get(taskId) ?? 0,
    );
    if (generation < floor)
      throw new ProcessSandboxError(
        "scope_revoked",
        "旧代际操作不能影响新的 Task 执行范围。",
      );
  };

  const ensureTask = (request: ProcessSpawnRequest): TaskEntry => {
    if (closed)
      throw new ProcessSandboxError("process_closed", "Task 执行资源已关闭。");
    const closedAt = closedTasks.get(request.scope.taskId);
    if (closedAt !== undefined) {
      if (request.scope.generation <= closedAt)
        throw new ProcessSandboxError(
          "process_closed",
          "旧代际 Task 执行资源已关闭。",
        );
      const previous = tasks.get(request.scope.taskId);
      if (previous && !previous.closeConfirmed)
        throw new ProcessSandboxError(
          "stop_unconfirmed",
          "旧 Task 执行范围尚未确认关闭，不能重开 helper。",
        );
      tasks.delete(request.scope.taskId);
      closedTasks.delete(request.scope.taskId);
    }
    if (
      request.scope.generation <
      (minimumGenerations.get(request.scope.taskId) ?? request.scope.generation)
    )
      throw new ProcessSandboxError(
        "scope_revoked",
        "旧 Task 授权版本不能启动命令。",
      );
    let entry = tasks.get(request.scope.taskId);
    if (!entry) {
      const connection = (async () => {
        const network = options.resolveNetwork
          ? await options.resolveNetwork(request.scope)
          : options.network;
        return new TaskConnection(
          {
            ...options,
            network,
            onSnapshot: (snapshot) => {
              restore.observe(snapshot);
              options.onSnapshot?.(snapshot);
            },
          },
          request,
        );
      })();
      entry = {
        connection,
        initialized: connection.then((helper) => helper.initialize(request)),
        generation: request.scope.generation,
        workspaceId: request.scope.workspaceId,
        projectId: request.scope.projectId,
        rootDirectory: request.scope.rootDirectory,
        phase: "ready",
        closeConfirmed: false,
        barrier: Promise.resolve(),
      };
      tasks.set(request.scope.taskId, entry);
      const created = entry;
      void created.initialized.catch(() => {
        if (created.phase !== "closed") created.phase = "failed";
      });
    }
    if (
      entry.workspaceId !== request.scope.workspaceId ||
      entry.projectId !== request.scope.projectId ||
      entry.rootDirectory !== request.scope.rootDirectory
    )
      throw new ProcessSandboxError(
        "invalid_process_request",
        "Task 执行身份或主目录不可被调用方替换。",
      );
    if (entry.phase !== "ready" || request.scope.generation < entry.generation)
      throw new ProcessSandboxError(
        "scope_revoked",
        "Task 执行授权已失效或正在撤销。",
      );
    return entry;
  };

  const runBarrier = (
    entry: TaskEntry,
    operation: (connection: TaskConnection) => Promise<unknown>,
  ): Promise<void> => {
    if (entry.phase === "closed")
      return Promise.reject(
        new ProcessSandboxError("process_closed", "Task 已关闭。"),
      );
    entry.phase = "revoking";
    const current = entry.barrier.then(async () => {
      await entry.initialized;
      await operation(await entry.connection);
    });
    entry.barrier = current;
    return current.then(
      () => {
        if (entry.barrier === current && entry.phase !== "closed")
          entry.phase = "ready";
      },
      (error: unknown) => {
        if (entry.phase !== "closed") entry.phase = "failed";
        throw error;
      },
    );
  };

  const closeTask = async (
    taskId: string,
    reason: string,
    generation?: number,
  ): Promise<void> => {
    if (generation !== undefined) rejectStaleGeneration(taskId, generation);
    const entry = tasks.get(taskId);
    const floor = Math.max(
      closedTasks.get(taskId) ?? 0,
      minimumGenerations.get(taskId) ?? 0,
      entry?.generation ?? 0,
      generation ?? 0,
    );
    closedTasks.set(taskId, floor);
    minimumGenerations.set(taskId, floor);
    if (!entry) return;
    entry.phase = "closed";
    entry.closePromise ??= (async () => {
      await entry.barrier.catch(() => {});
      const connection = await entry.connection;
      await connection.close(reason);
      entry.closeConfirmed = true;
    })();
    await entry.closePromise;
  };

  const spawn = async (
    request: ProcessSpawnRequest,
    internalWriteRoots: readonly string[] = [],
  ): Promise<ManagedTerminalProcess & ManagedStdioProcess> => {
    validateRequest(request);
    const admission = restore.reserve(request);
    let dispatched = false;
    let entry: TaskEntry;
    let connection: TaskConnection;
    let snapshot: ManagedProcessSnapshot;
    try {
      entry = ensureTask(request);
      await restore.admit(admission);
      await entry.initialized;
      if (entry.phase !== "ready")
        throw new ProcessSandboxError(
          "scope_revoked",
          "Task 正在撤销执行资源。",
        );
      connection = await entry.connection;
      dispatched = true;
      snapshot = (await connection.rpc({
        method: "spawn",
        request,
        internalWriteRoots,
      })) as ManagedProcessSnapshot;
    } catch (error) {
      // IPC/启动结果不确定时保留写域；停止失败或helper失联绝不当作gone。
      if (
        !dispatched ||
        (error instanceof ProcessSandboxError &&
          error.code !== "stop_unconfirmed" &&
          error.code !== "spawn_failed")
      )
        restore.discardUnlaunched(admission);
      throw error;
    }
    const observed = connection.snapshots.get(snapshot.id);
    if (!observed?.finishedAt) connection.snapshots.set(snapshot.id, snapshot);
    restore.observe(observed ?? snapshot);
    const processId = snapshot.id;
    const child: ManagedTerminalProcess & ManagedStdioProcess = {
      id: processId,
      readOutput: async ({ offset, maxBytes, stream }) => {
        const output = (await connection.rpc({
          method: "output",
          processId,
          offset,
          maxBytes,
          ...(stream ? { stream } : {}),
        })) as ProcessOutput;
        if (request.pty)
          await connection.outputConsumer(processId).consumeCaptured();
        return output;
      },
      onOutput: (listener) => {
        if (!request.pty)
          throw new ProcessSandboxError(
            "invalid_process_request",
            "该命令没有实时 PTY 输出。",
          );
        return connection.outputConsumer(processId).onOutput(listener);
      },
      onStdout: (listener) => {
        if (!request.stdio)
          throw new ProcessSandboxError(
            "invalid_process_request",
            "该命令没有完整 stdio stdout 流。",
          );
        return connection
          .outputConsumer(processId, "stdout")
          .onOutput(listener);
      },
      onStderr: (listener) => {
        if (!request.stdio)
          throw new ProcessSandboxError(
            "invalid_process_request",
            "该命令没有完整 stdio stderr 流。",
          );
        return connection
          .outputConsumer(processId, "stderr")
          .onOutput(listener);
      },
      writeStdin: async (data) => {
        if (entry.phase !== "ready")
          throw new ProcessSandboxError(
            "scope_revoked",
            "Task 正在撤销执行授权，命令不接受 stdin。",
          );
        await connection.rpc({ method: "stdin", processId, data });
      },
      resize: async (cols, rows) => {
        if (entry.phase !== "ready")
          throw new ProcessSandboxError(
            "scope_revoked",
            "Task 正在撤销执行授权，终端不接受 resize。",
          );
        await connection.rpc({ method: "resize", processId, cols, rows });
      },
      endStdin: async () => {
        await connection.rpc({ method: "endstdin", processId });
      },
      stop: async (reason) =>
        (connection.snapshots.get(processId)?.exit ??
          (await connection.rpc({
            method: "stop",
            processId,
            reason,
          }))) as ProcessExit,
      waitForExit: async () => {
        const exit = (connection.snapshots.get(processId)?.exit ??
          (await connection.rpc({ method: "wait", processId }))) as ProcessExit;
        if (request.pty) await connection.outputConsumer(processId).drain();
        if (request.stdio)
          await Promise.all([
            connection.outputConsumer(processId, "stdout").drain(),
            connection.outputConsumer(processId, "stderr").drain(),
          ]);
        return exit;
      },
      snapshot: () =>
        structuredClone(connection.snapshots.get(processId) ?? snapshot),
    };
    return child;
  };

  return {
    acquireRestoreBarrier: (scope, roots) => restore.acquire(scope, roots),
    get readonlyExecution() {
      return (
        ["darwin", "linux", "win32"].includes(process.platform) &&
        !options.resolveNetwork &&
        options.network.allowedDomains.length === 0
      );
    },
    spawn: (request) => spawn(request),
    spawnPty: (request: ProcessPtySpawnRequest) => spawn(request),
    spawnStdio: (request) => spawn({ ...request, stdio: "stream" }),
    async spawnCheckpoint(request) {
      if (!options.resolveInternalWriteRoots || !request.argv)
        throw new ProcessSandboxError(
          "invalid_process_request",
          "没有注册 checkpoint 私有目录执行 authority，或未使用精确 argv。",
        );
      const internalWriteRoots = await Promise.all(
        (
          await options.resolveInternalWriteRoots(request.scope, "checkpoint")
        ).map((root) => realpath(root)),
      );
      if (internalWriteRoots.length === 0)
        throw new ProcessSandboxError(
          "invalid_process_request",
          "checkpoint 私有目录未初始化。",
        );
      return spawn(request, internalWriteRoots);
    },
    async applyScopeChange(previous, next, reason) {
      if (
        previous.taskId !== next.taskId ||
        previous.workspaceId !== next.workspaceId ||
        previous.projectId !== next.projectId
      )
        throw new ProcessSandboxError(
          "invalid_process_request",
          "作用域更新不能改变 Task 的归属身份。",
        );
      rejectStaleGeneration(next.taskId, next.generation);
      minimumGenerations.set(
        next.taskId,
        Math.max(minimumGenerations.get(next.taskId) ?? 0, next.generation),
      );
      const entry = tasks.get(next.taskId);
      if (!entry) return;
      entry.generation = Math.max(entry.generation, next.generation);
      await runBarrier(entry, (connection) =>
        connection.rpc({ method: "scopechange", next, reason }),
      );
    },
    async revokeTask(taskId, generation, reason) {
      rejectStaleGeneration(taskId, generation);
      minimumGenerations.set(
        taskId,
        Math.max(minimumGenerations.get(taskId) ?? generation, generation),
      );
      const entry = tasks.get(taskId);
      if (!entry) return;
      entry.generation = Math.max(entry.generation, generation);
      await runBarrier(entry, (connection) =>
        connection.rpc({ method: "revoke", generation, reason }),
      );
    },
    closeTask,
    async close(reason) {
      closed = true;
      const results = await Promise.allSettled(
        [...tasks.keys()].map((taskId) => closeTask(taskId, reason)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "部分 Task 的命令退出尚未确认。");
    },
  };
}
