import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { HelperLifecycle } from "./helper-lifecycle.js";
import { createProcessSandbox } from "./service.js";
import type { ProcessSandbox, ProcessSpawnRequest } from "./types.js";

const STDERR_MARKER = "PRIVATE_HELPER_STDERR_MARKER";
const ENV_MARKER = "PRIVATE_HELPER_ENV_VALUE";
const COMMAND_MARKER = "PRIVATE_HELPER_COMMAND_VALUE";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rejected(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("该操作必须拒绝，不能把未知退出状态报告为成功");
}

async function assertCloseFails(sandbox: ProcessSandbox) {
  const failure = await rejected(sandbox.close("helper_lifecycle_cleanup"));
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw failure;
  expect(failure.errors).toHaveLength(1);
  const inner = failure.errors[0];
  expect(inner).toMatchObject({ code: "stop_unconfirmed" });
  if (!(inner instanceof Error)) throw new Error("关闭失败丢失真实Error");
  expect(inner.message).not.toContain(STDERR_MARKER);
  return inner;
}

async function readJournal(captureRoot: string, taskId: string, id: string) {
  const path = join(
    captureRoot,
    createHash("sha256").update(taskId).digest("hex"),
    "helpers",
    `${id}.json`,
  );
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function request(root: string): ProcessSpawnRequest {
  return {
    scope: {
      instanceId: "lifecycle-instance",
      projectId: "lifecycle-project",
      taskId: "lifecycle-task",
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    },
    agentId: "main",
    invocationId: "synthetic-handle",
    argv: { executable: process.execPath, args: ["-e", COMMAND_MARKER] },
    env: { LIFECYCLE_PRIVATE: ENV_MARKER },
    background: true,
    timeoutMs: null,
    limits: {
      maxOutputBytes: 65536,
      previewMaxChars: 8000,
      yieldMs: 20,
      killGraceMs: 2000,
    },
  };
}

/** 独立控制通道只控制本测试helper，不占用或伪造Task IPC生命周期协议。 */
async function controlChannel() {
  const ready = deferred<number>();
  const disconnected = deferred<void>();
  const closed = deferred<void>();
  let socket: Socket | undefined;
  const server = createServer((connection) => {
    socket = connection;
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (data: string) => {
      buffer += data;
      for (
        let end = buffer.indexOf("\n");
        end !== -1;
        end = buffer.indexOf("\n")
      ) {
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (event.kind === "ready") ready.resolve(event.pid);
        if (event.kind === "disconnected") disconnected.resolve();
      }
    });
    connection.on("close", () => closed.resolve());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("合成helper控制通道没有本机端口");
  return {
    port: address.port,
    ready: ready.promise,
    disconnected: disconnected.promise,
    releaseExit() {
      if (socket && !socket.destroyed && !socket.writableEnded)
        socket.write("exit\n");
    },
    async confirmExited(pid: number) {
      await closed.promise;
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH")
                return true;
              throw error;
            }
          },
          { timeout: 5000 },
        )
        .toBe(true);
    },
    async close() {
      socket?.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function syntheticHelper(port: number, outputPath: string) {
  return `import net from "node:net";
const control = net.createConnection({host:"127.0.0.1",port:${port}});
control.on("connect",()=>control.write(JSON.stringify({kind:"ready",pid:process.pid})+"\\n"));
let buffer="";
control.setEncoding("utf8");
control.on("data",data=>{
  buffer+=data;
  if(buffer.includes("exit\\n"))process.exit(23);
});
process.on("message",message=>{
  if(message.method==="initialize") {
    process.send({id:message.id,ok:true,value:null});
  } else if(message.method==="spawn") {
    const request=message.request;
    // 仅建立公共RPC句柄；没有真实命令，pid/exit/enforcement不伪装成OS事实。
    process.send({id:message.id,ok:true,value:{
      id:"synthetic-process",ownerTaskId:request.scope.taskId,agentId:request.agentId,
      invocationId:request.invocationId,generation:request.scope.generation,
      state:"running",pid:null,startedAt:new Date().toISOString(),finishedAt:null,
      enforcement:null,exit:null,retainedBytes:0,totalBytes:0,discardedBytes:0,
      outputPath:${JSON.stringify(outputPath)}
    }});
  } else if(message.method==="wait") {
    process.stderr.write(${JSON.stringify(`${STDERR_MARKER}\n`)},()=>{
      process.disconnect();
      control.write(JSON.stringify({kind:"disconnected"})+"\\n");
    });
  }
});
`;
}

test("helper运行中先断连后退出：后续RPC保留首因、私有日志补齐退出，不能伪造范围已清空", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-helper-life-")),
  );
  const control = await controlChannel();
  const captureRoot = join(root, "capture");
  const helperPath = join(root, "synthetic-helper.mjs");
  await mkdir(captureRoot);
  await writeFile(
    helperPath,
    syntheticHelper(control.port, join(root, "unused.bin")),
  );
  const sandbox = createProcessSandbox({
    helperPath,
    helperExecArgv: [],
    nodePath: process.execPath,
    captureRoot,
    network: { allowedDomains: [], deniedDomains: [] },
  });
  const input = request(root);
  let pid: number | undefined;
  let closeChecked = false;
  const failures: unknown[] = [];
  try {
    const child = await sandbox.spawn(input);
    pid = await control.ready;
    const waiting = rejected(child.waitForExit());
    await control.disconnected;
    const firstFailure = await waiting;
    const laterFailure = await rejected(child.stop("after_disconnect"));
    expect(firstFailure).toMatchObject({ code: "stop_unconfirmed" });
    expect(laterFailure).toMatchObject({ code: "stop_unconfirmed" });
    // 先锁公共RPC的诊断cause，不能靠journal文件存在把原因丢失的实现测绿。
    expect(laterFailure.cause).toMatchObject({
      diagnosticId: expect.any(String),
      firstEvent: { kind: "disconnect" },
    });
    const cause = laterFailure.cause as { diagnosticId: string };
    expect(firstFailure.cause).toMatchObject({
      diagnosticId: cause.diagnosticId,
      firstEvent: { kind: "disconnect" },
    });
    const taskCloseFailure = await rejected(
      sandbox.closeTask(input.scope.taskId, "after_disconnect"),
    );
    expect(taskCloseFailure).toMatchObject({ code: "stop_unconfirmed" });
    expect(taskCloseFailure.cause).toMatchObject({
      diagnosticId: cause.diagnosticId,
      firstEvent: { kind: "disconnect" },
    });
    await expect(
      sandbox.spawn({
        ...input,
        scope: { ...input.scope, generation: 2 },
        invocationId: "must-not-reopen",
      }),
    ).rejects.toMatchObject({ code: "stop_unconfirmed" });
    const closeFailure = await assertCloseFails(sandbox);
    closeChecked = true;
    expect(closeFailure.cause).toMatchObject({
      diagnosticId: cause.diagnosticId,
      firstEvent: { kind: "disconnect" },
    });
    for (const error of [
      firstFailure,
      laterFailure,
      taskCloseFailure,
      closeFailure,
    ])
      expect(error.message).not.toContain(STDERR_MARKER);

    control.releaseExit();
    await control.confirmExited(pid);
    await expect
      .poll(
        () => readJournal(captureRoot, input.scope.taskId, cause.diagnosticId),
        { timeout: 5000 },
      )
      .toMatchObject({
        helperPid: pid,
        identity: {
          taskId: input.scope.taskId,
          instanceId: input.scope.instanceId,
        },
        firstEvent: { kind: "disconnect" },
        exit: { code: 23, signal: null },
        stderrTail: expect.stringContaining(STDERR_MARKER),
      });
    const journal = await readJournal(
      captureRoot,
      input.scope.taskId,
      cause.diagnosticId,
    );
    const kinds = journal.events.map((event: { kind: string }) => event.kind);
    expect(kinds).toContain("disconnect");
    expect(kinds).toContain("exit");
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(journal.processes).toContainEqual(
      expect.objectContaining({
        id: "synthetic-process",
        pid: null,
        state: "running",
        exit: null,
      }),
    );
    expect(JSON.stringify(journal)).not.toContain(ENV_MARKER);
    expect(JSON.stringify(journal.processes)).not.toContain(COMMAND_MARKER);
    const afterExit = await rejected(child.stop("after_helper_exit"));
    expect(afterExit.cause).toMatchObject({
      diagnosticId: cause.diagnosticId,
      firstEvent: { kind: "disconnect" },
      exit: { code: 23, signal: null },
    });
    expect(afterExit.message).not.toContain(STDERR_MARKER);
  } catch (error) {
    failures.push(error);
  } finally {
    control.releaseExit();
    try {
      if (pid !== undefined) await control.confirmExited(pid);
      if (!closeChecked) await assertCloseFails(sandbox);
    } catch (error) {
      failures.push(error);
    } finally {
      await control.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "helper生命周期断言或自身fixture清理失败",
    );
});

test("fork执行体不存在：真实ENOENT首因保留给后续关闭，公开错误不暴露私有stderr", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-helper-enoent-")),
  );
  const captureRoot = join(root, "capture");
  const sandbox = createProcessSandbox({
    helperPath: join(root, "unused-helper.mjs"),
    helperExecArgv: [],
    nodePath: join(root, "missing-node-executable"),
    captureRoot,
    network: { allowedDomains: [], deniedDomains: [] },
  });
  const input = request(root);
  let closeChecked = false;
  const failures: unknown[] = [];
  try {
    const first = await rejected(sandbox.spawn(input));
    const closed = await assertCloseFails(sandbox);
    closeChecked = true;
    expect(closed.cause).toMatchObject({
      diagnosticId: expect.any(String),
      firstEvent: { kind: "error" },
    });
    const cause = closed.cause as { diagnosticId: string; firstEvent: unknown };
    expect(JSON.stringify(cause.firstEvent)).toContain("ENOENT");
    expect(first).toMatchObject({ code: "stop_unconfirmed" });
    expect(first.cause).toMatchObject({ diagnosticId: cause.diagnosticId });
    await expect
      .poll(
        () => readJournal(captureRoot, input.scope.taskId, cause.diagnosticId),
        { timeout: 5000 },
      )
      .toMatchObject({ helperPid: null, firstEvent: { kind: "error" } });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (!closeChecked) await assertCloseFails(sandbox);
    } catch (error) {
      failures.push(error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "ENOENT诊断断言或预期关闭失败未满足");
});

test("诊断consumer修改Error.cause不能改写后续首因或私有证据", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-helper-cause-")),
  );
  try {
    const input = request(root);
    const lifecycle = new HelperLifecycle(root, input.scope, 80, () => []);
    lifecycle.observe({ kind: "disconnect" });
    const error = lifecycle.failure();
    const cause = error.cause;
    if (!cause || typeof cause !== "object" || !("firstEvent" in cause))
      throw new Error("缺少首因");
    if (!cause.firstEvent || typeof cause.firstEvent !== "object")
      throw new Error("首因不是对象");
    Object.assign(cause.firstEvent, { kind: "consumer-mutation" });
    lifecycle.observe({ kind: "exit", code: 23, signal: null });
    const later = lifecycle.failure();
    expect(later.cause).toMatchObject({ firstEvent: { kind: "disconnect" } });
    const diagnostic = later.cause as { diagnosticId: string };
    expect(
      await readJournal(root, input.scope.taskId, diagnostic.diagnosticId),
    ).toMatchObject({ firstEvent: { kind: "disconnect" }, exit: { code: 23 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("私有诊断限制stderr尾部、冻结创建身份并保持文件权限", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-helper-private-")),
  );
  try {
    const input = request(root);
    const originalTaskId = input.scope.taskId;
    const lifecycle = new HelperLifecycle(root, input.scope, 8, () => []);
    input.scope.taskId = "caller-mutated-task";
    input.scope.instanceId = "caller-mutated-instance";
    lifecycle.stderr(Buffer.from("PRIVATE_PREFIX_1234567890"));
    lifecycle.observe({ kind: "disconnect" });
    const failure = lifecycle.failure();
    const cause = failure.cause as { diagnosticId: string };
    const journal = await readJournal(root, originalTaskId, cause.diagnosticId);
    expect(journal).toMatchObject({
      identity: { taskId: originalTaskId, instanceId: "lifecycle-instance" },
      stderrTail: "34567890",
    });
    expect(failure.message).not.toContain("34567890");
    expect(JSON.stringify(failure.cause)).not.toContain("34567890");
    if (process.platform !== "win32") {
      const path = join(
        root,
        createHash("sha256").update(originalTaskId).digest("hex"),
        "helpers",
        `${cause.diagnosticId}.json`,
      );
      const { stat } = await import("node:fs/promises");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("诊断目录不可写不能替代执行故障或让生命周期监听器抛错", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-helper-journal-")),
  );
  try {
    const blocked = join(root, "ordinary-file");
    await writeFile(blocked, "not a directory");
    const lifecycle = new HelperLifecycle(
      blocked,
      request(root).scope,
      80,
      () => [],
    );
    expect(() =>
      lifecycle.observe({ kind: "exit", code: 23, signal: null }),
    ).not.toThrow();
    expect(lifecycle.failure()).toMatchObject({
      code: "stop_unconfirmed",
      cause: {
        firstEvent: { kind: "exit", code: 23 },
        captureError: { code: expect.any(String) },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
