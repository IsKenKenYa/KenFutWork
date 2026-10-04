import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProcessOutputCapture } from "./output-capture.js";
import type { ManagedProcessSnapshot, ProcessSpawnRequest } from "./types.js";
import { ProcessSandboxError } from "./types.js";
import type {
  NativeLaunch,
  NativeProcessEvent,
  WindowsTaskBroker,
} from "./windows-broker.js";
import { WindowsManagedProcess } from "./windows-process.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Broker implements Pick<WindowsTaskBroker, "rpc" | "listen"> {
  readonly calls: Record<string, unknown>[] = [];
  readonly initial = deferred<unknown>();
  private listener: ((event: NativeProcessEvent) => void) | undefined;
  stopError: Error | undefined;
  constructor(pending = false) {
    if (!pending) this.initial.resolve({ pid: 123 });
  }
  listen(_id: string, listener: (event: NativeProcessEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async rpc(input: Record<string, unknown>): Promise<unknown> {
    this.calls.push(input);
    if (input.method === "spawn") return this.initial.promise;
    if (input.method === "stop" && this.stopError) throw this.stopError;
    return null;
  }
  emit(event: NativeProcessEvent) {
    this.listener?.(event);
  }
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(pending = false, live = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-win-owner-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const capture = new ProcessOutputCapture(join(root, "output"), 4);
  cleanups.push(async () => {
    capture.close();
  });
  const broker = new Broker(pending);
  const request: ProcessSpawnRequest = {
    scope: {
      workspaceId: "workspace",
      projectId: "project",
      taskId: "task",
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "read-only",
    },
    agentId: "agent",
    invocationId: "invocation",
    argv: { executable: process.execPath, args: [] },
    background: true,
    timeoutMs: null,
    ...(live ? { stdio: "stream" as const } : {}),
    limits: {
      maxOutputBytes: 4,
      previewMaxChars: 8000,
      yieldMs: 50,
      killGraceMs: 2000,
    },
  };
  const snapshot: ManagedProcessSnapshot = {
    id: "process",
    ownerTaskId: "task",
    agentId: "agent",
    invocationId: "invocation",
    generation: 1,
    state: "starting",
    pid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    enforcement: {
      backend: "windows-task-broker",
      filesystem: "enforced",
      processRange: "job-object",
      permissionsGeneration: 1,
    },
    exit: null,
    retainedBytes: 0,
    totalBytes: 0,
    discardedBytes: 0,
    outputPath: capture.path,
  };
  const launch: NativeLaunch = {
    processId: "process",
    taskId: "task",
    generation: 1,
    command: [process.execPath],
    cwd: root,
    env: {},
    readRoots: [root],
    writeRoots: [],
    denyRoots: [],
    yieldMs: 50,
    killGraceMs: 2000,
    chunkBytes: 4,
    liveStreams: live,
    pty: null,
  };
  const frames: Array<{
    sequence: number;
    data: string;
    stream?: "stdout" | "stderr";
  }> = [];
  const owner = new WindowsManagedProcess(
    broker,
    request,
    capture,
    snapshot,
    launch,
    () => {},
    (sequence, data, _offset, _next, stream) => {
      frames.push({ sequence, data, ...(stream ? { stream } : {}) });
    },
  );
  return { owner, broker, capture, frames };
}
function output(
  broker: Broker,
  stream: "stdout" | "stderr",
  sequence: number,
  data: string,
) {
  broker.emit({
    event: "output",
    processId: "process",
    stream,
    sequence,
    data: Buffer.from(data).toString("base64"),
  });
}

test("Windows adapter将完整双流送到helper，capture上限不截协议且EOF幂等", async () => {
  const { owner, broker, frames } = await fixture();
  await owner.ready.promise;
  output(broker, "stdout", 1, "stdout-long");
  output(broker, "stderr", 1, "stderr-long");
  expect(frames.map((frame) => frame.data)).toEqual([
    "stdout-long",
    "stderr-long",
  ]);
  expect(owner.output(0, 4).data).toBe("stdo");
  expect(owner.snapshot().discardedBytes).toBe(18);
  await owner.acknowledgeOutput(1, "stdout");
  await owner.acknowledgeOutput(1, "stderr");
  expect(
    broker.calls
      .filter((call) => call.method === "outputack")
      .map((call) => call.stream),
  ).toEqual(["stdout", "stderr"]);
  await owner.endStdin();
  broker.emit({ event: "stream-end", processId: "process", stream: "stdout" });
  broker.emit({ event: "stream-end", processId: "process", stream: "stderr" });
  broker.emit({
    event: "exit",
    processId: "process",
    exitCode: 0,
    rangeEmpty: true,
  });
  expect(await owner.wait()).toMatchObject({ exitCode: 0, rangeEmpty: true });
  await owner.endStdin();
  expect(
    broker.calls.filter((call) => call.method === "endstdin"),
  ).toHaveLength(1);
});

test("启动回执未到时stop已发给native，只有实际Job事件才完成", async () => {
  const { owner, broker } = await fixture(true);
  const stopped = owner.stop("cancelled");
  let complete = false;
  void stopped.then(() => {
    complete = true;
  });
  await Promise.resolve();
  expect(broker.calls.some((call) => call.method === "stop")).toBe(true);
  expect(complete).toBe(false);
  broker.emit({
    event: "failure",
    processId: "process",
    code: "output_failed",
    message: "controller cancelled",
  });
  broker.emit({
    event: "exit",
    processId: "process",
    exitCode: null,
    rangeEmpty: true,
    failure: "controller cancelled",
  });
  expect(await stopped).toMatchObject({
    stopped: true,
    rangeEmpty: true,
    reason: "cancelled",
  });
  broker.initial.reject(
    new ProcessSandboxError("enforcement_unavailable", "cancelled"),
  );
  await expect(owner.ready.promise).rejects.toThrow("cancelled");
  expect(owner.snapshot().state).toBe("stopped");
});

test("SDK stop reply失败不等于gone，后续物理范围事件仍可确认安全清空", async () => {
  const { owner, broker } = await fixture();
  await owner.ready.promise;
  broker.stopError = new ProcessSandboxError(
    "stop_unconfirmed",
    "controller closing",
  );
  const stopped = owner.stop("revoke");
  let complete = false;
  void stopped.then(() => {
    complete = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(complete).toBe(false);
  broker.emit({
    event: "exit",
    processId: "process",
    exitCode: -1,
    rangeEmpty: true,
  });
  expect((await stopped).rangeEmpty).toBe(true);
});

test("未证实Job为空或broker失联必须拒绝stop，不能借输出结束解锁", async () => {
  for (const kind of ["range", "disconnect"] as const) {
    const { owner, broker } = await fixture();
    await owner.ready.promise;
    const stopped = owner.stop("revoke");
    if (kind === "range")
      broker.emit({
        event: "exit",
        processId: "process",
        exitCode: -1,
        rangeEmpty: false,
      });
    else
      broker.emit({
        event: "failure",
        processId: "process",
        code: "stop_unconfirmed",
        message: "broker lost",
      });
    await expect(stopped).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(owner.snapshot().exit).toBeNull();
  }
});
