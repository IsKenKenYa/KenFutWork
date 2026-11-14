import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { HelperRequest } from "./protocol.js";
import {
  type ProcessExit,
  type ProcessLimits,
  type ProcessOutput,
  ProcessSandboxError,
  type ProjectReadProcessLease,
  type ProjectReadProcessScope,
  type ProjectReadSandboxScope,
  type SandboxProcessRequest,
  type SandboxProcessSnapshot,
} from "./types.js";

type RpcInput = HelperRequest extends infer Request
  ? Request extends HelperRequest
    ? Omit<Request, "id">
    : never
  : never;

export interface ProjectLeaseConnection {
  readonly snapshots: ReadonlyMap<string, SandboxProcessSnapshot>;
  initialize(initial: SandboxProcessRequest): Promise<unknown>;
  rpc(input: RpcInput): Promise<unknown>;
  close(reason: string): Promise<void>;
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new ProcessSandboxError(
      "invalid_process_request",
      "项目读取目录必须是绝对路径。",
    );
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory())
    throw new ProcessSandboxError(
      "invalid_process_request",
      "项目读取目标必须是目录。",
    );
  return canonical;
}

async function collectOutput(
  connection: ProjectLeaseConnection,
  processId: string,
  stream: "stdout" | "stderr",
  maxBytes: number,
): Promise<string> {
  let offset = 0;
  const parts: string[] = [];
  while (offset < maxBytes) {
    const page = (await connection.rpc({
      method: "output",
      processId,
      stream,
      offset,
      maxBytes: maxBytes - offset,
      preserveNul: true,
    })) as ProcessOutput;
    parts.push(page.data);
    if (page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  return parts.join("");
}

async function prepareScope(
  input: ProjectReadProcessScope,
): Promise<ProjectReadSandboxScope> {
  for (const identity of [
    input.instanceId,
    input.projectId,
    input.connectionId,
    input.revision,
  ]) {
    if (!identity.trim() || identity.includes("\0"))
      throw new ProcessSandboxError(
        "invalid_process_request",
        "项目读取身份或修订无效。",
      );
  }
  const rootDirectory = await canonicalDirectory(input.rootDirectory);
  const additionalDirectories = await Promise.all(
    input.additionalDirectories.map(async (path) => ({
      path: await canonicalDirectory(path),
      access: "read-only" as const,
    })),
  );
  return {
    ...input,
    rootDirectory,
    additionalDirectories,
    kind: "project-read",
    leaseId: randomUUID(),
    sandboxMode: "read-only",
    generation: 1,
  };
}

async function verifyDirectories(
  scope: ProjectReadSandboxScope,
): Promise<void> {
  for (const root of [
    scope.rootDirectory,
    ...scope.additionalDirectories.map((entry) => entry.path),
  ]) {
    if ((await canonicalDirectory(root)) !== root)
      throw new ProcessSandboxError(
        "scope_revoked",
        "项目读取目录的真实路径已改变。",
      );
  }
}

async function executeCommand(options: {
  scope: ProjectReadSandboxScope;
  limits: ProcessLimits;
  connection: ProjectLeaseConnection;
  command: Parameters<ProjectReadProcessLease["exec"]>[0];
  assertOpen(): void;
  validateRequest(request: SandboxProcessRequest): void;
}) {
  const { scope, limits, connection, command, assertOpen } = options;
  assertOpen();
  await verifyDirectories(scope);
  assertOpen();
  const request: SandboxProcessRequest = {
    scope,
    agentId: "human-project-git",
    invocationId: randomUUID(),
    argv: command.argv,
    background: false,
    limits,
    ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
    ...(command.timeoutMs !== undefined
      ? { timeoutMs: command.timeoutMs }
      : {}),
    ...(command.env !== undefined ? { env: command.env } : {}),
  };
  options.validateRequest(request);
  const started = (await connection.rpc({
    method: "spawn",
    request,
    internalWriteRoots: [],
  })) as SandboxProcessSnapshot;
  assertOpen();
  if (command.input !== undefined)
    await connection.rpc({
      method: "stdin",
      processId: started.id,
      data: command.input,
    });
  await connection.rpc({ method: "endstdin", processId: started.id });
  const exit = (await connection.rpc({
    method: "wait",
    processId: started.id,
  })) as ProcessExit;
  if (!exit.rangeEmpty)
    throw new ProcessSandboxError(
      "stop_unconfirmed",
      "项目读取进程尚未确认退出。",
    );
  const stdout = await collectOutput(
    connection,
    started.id,
    "stdout",
    limits.maxOutputBytes,
  );
  const stderr = await collectOutput(
    connection,
    started.id,
    "stderr",
    limits.maxOutputBytes,
  );
  await verifyDirectories(scope);
  assertOpen();
  const snapshot = connection.snapshots.get(started.id);
  if (!snapshot?.exit?.rangeEmpty)
    throw new ProcessSandboxError(
      "stop_unconfirmed",
      "项目读取缺少最终退出记录。",
    );
  return { exit, stdout, stderr, discardedBytes: snapshot.discardedBytes };
}

/** 只协调既有 helper 的短期读取，不向 Task 进程集合或持久快照登记。 */
export function createProjectReadLease(
  input: { scope: ProjectReadProcessScope; limits: ProcessLimits },
  options: {
    signal?: AbortSignal;
    createConnection(initial: SandboxProcessRequest): ProjectLeaseConnection;
    validateRequest(request: SandboxProcessRequest): void;
    closed(): void;
  },
): { lease: ProjectReadProcessLease; ready: Promise<ProjectLeaseConnection> } {
  const original = structuredClone(input);
  let connection: ProjectLeaseConnection | undefined;
  let scope: ProjectReadSandboxScope;
  let stopped = false;
  let closing: Promise<void> | undefined;
  let queue = Promise.resolve();
  const assertOpen = () => {
    options.signal?.throwIfAborted();
    if (stopped)
      throw new ProcessSandboxError("process_closed", "项目读取连接已关闭。");
  };
  const ready = Promise.resolve().then(async () => {
    assertOpen();
    scope = await prepareScope(original.scope);
    assertOpen();
    const initial: SandboxProcessRequest = {
      scope,
      agentId: "human-project-git",
      invocationId: randomUUID(),
      argv: { executable: process.execPath, args: [] },
      background: false,
      limits: original.limits,
    };
    options.validateRequest(initial);
    connection = options.createConnection(initial);
    await connection.initialize(initial);
    assertOpen();
    return connection;
  });
  const close = (reason: string): Promise<void> => {
    stopped = true;
    closing ??= (async () => {
      // 初始化中的权限探针也必须先收到 close，不能等待初始化完成才取消。
      await connection?.close(reason);
      await ready.catch(() => {});
      await queue;
      options.signal?.removeEventListener("abort", abort);
      options.closed();
    })();
    return closing;
  };
  const abort = () => {
    // open/exec 的失败路径及 Consumer finally 都会等待同一个关闭结果。
    void close("项目读取已取消").catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const execute = async (
    command: Parameters<ProjectReadProcessLease["exec"]>[0],
  ) => {
    const active = await ready;
    return executeCommand({
      scope,
      limits: original.limits,
      connection: active,
      command,
      assertOpen,
      validateRequest: options.validateRequest,
    });
  };
  const lease: ProjectReadProcessLease = {
    exec(command) {
      const frozen = structuredClone(command);
      const running = queue.then(() => execute(frozen));
      queue = running.then(
        () => {},
        () => {},
      );
      return running.catch(async (error: unknown) => {
        await close("项目读取失败");
        throw error;
      });
    },
    close,
  };
  return { lease, ready };
}
