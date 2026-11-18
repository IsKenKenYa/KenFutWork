import { createHash } from "node:crypto";
import { afterEach, test as baseTest, beforeEach, expect, vi } from "vitest";
import type { ProcessOwner } from "./managed-process.js";
import type {
  ManagedProcessSnapshot,
  ProcessExit,
  ProcessSpawnRequest,
} from "./types.js";

const test = baseTest.skipIf(!["darwin", "linux"].includes(process.platform));

const fixture = vi.hoisted(() => ({
  cwdGates: new Map<string, Promise<void>>(),
  cwdEntered: [] as string[],
  readyGate: undefined as Promise<void> | undefined,
  stopGate: undefined as Promise<void> | undefined,
  sandboxGate: undefined as Promise<void> | undefined,
  sandboxFailure: false,
  proofWaitGate: undefined as Promise<void> | undefined,
  proofFinalizeGate: undefined as Promise<void> | undefined,
  sandboxEntered: 0,
  events: [] as string[],
  stopCalls: 0,
  rangeEmpty: true,
  stopRejectAfterEmpty: false,
  owners: [] as ProcessOwner[],
  releases: [] as Array<() => void>,
}));

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(async () => undefined),
  mkdtemp: vi.fn(async () => "/private/tmp/kfw-helper-cancel-fixture"),
  realpath: vi.fn(async (path: string) => path),
  rm: vi.fn(async (path: string) => {
    if (path === "/private/tmp/kfw-helper-cancel-fixture")
      fixture.events.push("temporary_removed");
  }),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    checkDependenciesAsync: vi.fn(async () => ({ errors: [] })),
    isSupportedPlatform: vi.fn(() => true),
    initialize: vi.fn(async () => {
      fixture.sandboxEntered++;
      fixture.events.push("sdk_initialize_started");
      await fixture.sandboxGate;
      fixture.events.push("sdk_initialize_finished");
      if (fixture.sandboxFailure)
        throw new Error("fixture initialization failed");
    }),
    wrapWithSandboxArgv: vi.fn(async () => ({
      argv: ["fixture-command"],
      env: {},
    })),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(async () => {
      fixture.events.push("sdk_reset");
    }),
  },
}));

vi.mock("./policy.js", () => ({
  commandDirectory: vi.fn(async (_scope, cwd?: string) => {
    fixture.cwdEntered.push(cwd ?? ".");
    await fixture.cwdGates.get(cwd ?? ".");
    return "/fixture/project";
  }),
  unixPolicy: vi.fn(async () => ({})),
  pathWithin: vi.fn(() => true),
}));

vi.mock("./pty-native-runtime.js", () => ({
  preparePtySessionInspector: vi.fn(async () => "/fixture/session-inspector"),
  prepareLinuxProcessInspector: vi.fn(async () => "/fixture/linux-inspector"),
}));

vi.mock("./linux-launch.js", () => ({
  prepareLinuxSandboxArgv: vi.fn((argv: string[]) => argv),
}));

vi.mock("./output-capture.js", () => ({
  ProcessOutputCapture: class {
    path = "/fixture/capture";
    retainedBytes = 0;
    totalBytes = 0;
    discardedBytes = 0;
  },
}));

vi.mock("./unix-process.js", () => ({
  UnixManagedProcess: class {
    readonly scope;
    readonly ready;
    private value: ManagedProcessSnapshot;
    private stopping: Promise<ProcessExit> | undefined;
    private finishStop!: () => void;
    private readonly stopped = new Promise<void>((resolve) => {
      this.finishStop = resolve;
    });
    private readonly probe: boolean;

    constructor(
      _descriptor: unknown,
      request: ProcessSpawnRequest,
      _cwd: string,
      _capture: unknown,
      initial: ManagedProcessSnapshot,
      private readonly changed: (snapshot: ManagedProcessSnapshot) => void,
    ) {
      this.scope = request.scope;
      this.value = structuredClone(initial);
      this.probe = request.invocationId.startsWith("probe:");
      this.ready = { promise: fixture.readyGate ?? Promise.resolve() };
      fixture.owners.push(this);
      fixture.events.push(`owner:${request.invocationId}`);
    }

    snapshot() {
      return structuredClone(this.value);
    }

    async stop(reason: string): Promise<ProcessExit> {
      fixture.stopCalls++;
      this.stopping ??= (async () => {
        await fixture.stopGate;
        const exit = {
          exitCode: 0,
          signal: null,
          stopped: true,
          rangeEmpty: fixture.rangeEmpty,
          reason,
        };
        this.value.exit = exit;
        this.value.state = "stopped";
        this.value.finishedAt = new Date().toISOString();
        this.changed(this.snapshot());
        fixture.events.push(`stopped:${this.value.invocationId}`);
        this.finishStop();
        if (fixture.stopRejectAfterEmpty)
          throw new Error("startup failed after range was cleared");
        return exit;
      })();
      return this.stopping;
    }

    async wait(): Promise<ProcessExit> {
      if (this.probe) {
        if (fixture.proofWaitGate)
          await Promise.race([fixture.proofWaitGate, this.stopped]);
        await fixture.proofFinalizeGate;
        fixture.events.push("proof_finished");
      }
      if (this.value.exit) return this.value.exit;
      return {
        exitCode: 0,
        signal: null,
        stopped: false,
        rangeEmpty: true,
        reason: null,
      };
    }

    output() {
      return {
        data: "",
        offset: 0,
        nextOffset: 0,
        retainedBytes: 0,
        totalBytes: 0,
        discardedBytes: 0,
        truncated: false,
        done: true,
      };
    }

    async stdin() {}
    async endStdin() {}
  },
}));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.releases.push(release);
  return { promise, release };
}

function request(invocationId = "cancel-call"): ProcessSpawnRequest {
  return {
    scope: {
      instanceId: "cancel-instance",
      projectId: "cancel-project",
      taskId: "cancel-task",
      generation: 4,
      rootDirectory: "/fixture/project",
      additionalDirectories: [],
      sandboxMode: "danger-full-access",
    },
    agentId: "main",
    invocationId,
    argv: { executable: "/fixture/target", args: ["original"] },
    background: false,
    timeoutMs: null,
    limits: {
      maxOutputBytes: 65536,
      previewMaxChars: 8000,
      yieldMs: 20,
      killGraceMs: 2000,
    },
  };
}

function fingerprint(
  input: ProcessSpawnRequest,
  internalWriteRoots: string[] = [],
) {
  return createHash("sha256")
    .update(JSON.stringify({ request: input, internalWriteRoots }))
    .digest("hex");
}

function cancellation(input: ProcessSpawnRequest) {
  return {
    method: "cancelspawn",
    taskId: input.scope.taskId,
    generation: input.scope.generation,
    invocationId: input.invocationId,
    fingerprint: fingerprint(input),
    reason: "run_cancelled",
  };
}

interface Reply {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

type Harness = Awaited<ReturnType<typeof helperHarness>>;
let active: Harness | undefined;

/** 运行原 helper 的 message handler；仅准备过程和 owner 为可控夹具，不签发 OS 证据。 */
async function helperHarness(automaticInitialize = true) {
  vi.resetModules();
  const sent = new Map<string, Reply>();
  const pending = new Map<string, (response: Reply) => void>();
  let sequence = 0;
  let dispatch: ((message: Record<string, unknown>) => void) | undefined;
  const originalOn = process.on.bind(process);
  const originalOnce = process.once.bind(process);
  const descriptors = new Map(
    ["send", "connected", "disconnect"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(process, key),
    ]),
  );
  const environment = {
    HOME: process.env.HOME,
    CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR,
  };
  Object.defineProperty(process, "connected", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process, "disconnect", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(process, "send", {
    configurable: true,
    value: (message: Reply, callback?: () => void) => {
      if (message.id) {
        sent.set(message.id, message);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
      callback?.();
      return true;
    },
  });
  const on = vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "message") {
      dispatch = listener;
      return process;
    }
    if (event === "disconnect") return process;
    return originalOn(event, listener);
  });
  const once = vi
    .spyOn(process, "once")
    .mockImplementation((event, listener) => {
      if (event === "SIGTERM" || event === "SIGINT") return process;
      return originalOnce(event, listener);
    });
  try {
    await import("./task-helper.js");
  } finally {
    on.mockRestore();
    once.mockRestore();
  }
  function send(input: Record<string, unknown>) {
    const id = `fixture-${++sequence}`;
    const response = new Promise<Reply>((resolve) => pending.set(id, resolve));
    if (!dispatch) throw new Error("原 helper 没有登记 message handler");
    dispatch({ ...input, id });
    return { id, response };
  }
  function initialize(initial = request()) {
    return send({
      method: "initialize",
      taskId: initial.scope.taskId,
      initial,
      options: {
        captureRoot: "/fixture/capture",
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });
  }
  if (automaticInitialize)
    expect(await initialize().response).toMatchObject({
      ok: true,
      value: null,
    });
  return {
    send,
    initialize,
    sent,
    spawn(input: ProcessSpawnRequest) {
      return send({ method: "spawn", request: input, internalWriteRoots: [] });
    },
    async restore() {
      for (const release of fixture.releases) release();
      const closing = send({ method: "close", reason: "fixture_cleanup" });
      await closing.response;
      // Complete queued continuations before restoring the worker's real IPC function.
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(process, key, descriptor);
        else Reflect.deleteProperty(process, key);
      }
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

beforeEach(() => {
  fixture.cwdGates.clear();
  fixture.cwdEntered.splice(0);
  fixture.owners.splice(0);
  fixture.releases.splice(0);
  fixture.readyGate = undefined;
  fixture.stopGate = undefined;
  fixture.sandboxGate = undefined;
  fixture.sandboxFailure = false;
  fixture.proofWaitGate = undefined;
  fixture.proofFinalizeGate = undefined;
  fixture.sandboxEntered = 0;
  fixture.events.splice(0);
  fixture.stopCalls = 0;
  fixture.rangeEmpty = true;
  fixture.stopRejectAfterEmpty = false;
});

afterEach(async () => {
  await active?.restore();
  active = undefined;
});

test("未知调用、错误 Task/代际/指纹的 cancel 不能停止已有正确命令", async () => {
  active = await helperHarness();
  const input = request();
  const originalArgv = input.argv;
  if (!originalArgv) throw new Error("取消夹具缺少精确 argv");
  expect(await active.spawn(input).response).toMatchObject({ ok: true });
  for (const identity of [
    { invocationId: "unknown-call" },
    { taskId: "another-task" },
    { generation: input.scope.generation - 1 },
    {
      fingerprint: fingerprint({
        ...input,
        argv: { ...originalArgv, args: ["conflict"] },
      }),
    },
  ]) {
    expect(
      await active.send({ ...cancellation(input), ...identity }).response,
    ).toMatchObject({ ok: false, error: { code: "invalid_process_request" } });
  }
  expect(fixture.stopCalls).toBe(0);
  expect(fixture.owners).toHaveLength(1);
});

test("无 owner 时 cancel 立即 ACK；准备解锁和同参重放均不能重新执行", async () => {
  active = await helperHarness();
  const preparation = gate();
  fixture.cwdGates.set("pending-cwd", preparation.promise);
  const input = { ...request(), cwd: "pending-cwd" };
  const spawning = active.spawn(input);
  await expect.poll(() => fixture.cwdEntered).toContain("pending-cwd");
  const cancel = active.send(cancellation(input));
  await expect
    .poll(() => active?.sent.get(cancel.id))
    .toMatchObject({
      ok: true,
      value: null,
    });
  const replay = active.spawn(input);
  await expect
    .poll(() => active?.sent.get(replay.id))
    .toMatchObject({
      ok: false,
      error: { code: "process_closed" },
    });
  expect(await active.send(cancellation(input)).response).toMatchObject({
    ok: true,
    value: null,
  });
  preparation.release();
  expect(await spawning.response).toMatchObject({
    ok: false,
    error: { code: "process_closed" },
  });
  expect(fixture.owners).toHaveLength(0);
  expect(
    await active.spawn({ ...input, env: { CHANGED: "value" } }).response,
  ).toMatchObject({ ok: false, error: { code: "invalid_process_request" } });
});

test("取消一个调用不取消共享沙箱/只读证明，另一次调用仍可启动", async () => {
  active = await helperHarness();
  const preparation = gate();
  fixture.sandboxGate = preparation.promise;
  const first = request("first-readonly");
  first.scope.sandboxMode = "read-only";
  const second = { ...first, invocationId: "second-readonly" };
  const spawning = active.spawn(first);
  await expect.poll(() => fixture.sandboxEntered).toBe(1);
  const other = active.spawn(second);
  expect(await active.send(cancellation(first)).response).toMatchObject({
    ok: true,
    value: null,
  });
  expect(active.sent.has(other.id)).toBe(false);
  preparation.release();
  expect(await spawning.response).toMatchObject({ ok: false });
  expect(await other.response).toMatchObject({
    ok: true,
    value: { invocationId: second.invocationId },
  });
  expect(fixture.sandboxEntered).toBe(1);
  expect(
    fixture.owners.map((owner) => owner.snapshot().invocationId),
  ).not.toContain(first.invocationId);
});

test("owner 已登记但 ready 未结束，cancel 不等 child 且必须等 stop 确认；重复取消只停一次", async () => {
  active = await helperHarness();
  const ready = gate();
  const stopping = gate();
  fixture.readyGate = ready.promise;
  fixture.stopGate = stopping.promise;
  const input = request();
  const spawning = active.spawn(input);
  await expect.poll(() => fixture.owners.length).toBe(1);
  const first = active.send(cancellation(input));
  const second = active.send(cancellation(input));
  await expect.poll(() => fixture.stopCalls).toBe(1);
  expect(active.sent.has(first.id)).toBe(false);
  expect(active.sent.has(second.id)).toBe(false);
  stopping.release();
  await expect
    .poll(() => active?.sent.get(first.id))
    .toMatchObject({
      ok: true,
      value: { invocationId: input.invocationId, exit: { rangeEmpty: true } },
    });
  expect(await second.response).toMatchObject({
    ok: true,
    value: { invocationId: input.invocationId, exit: { rangeEmpty: true } },
  });
  expect(active.sent.has(spawning.id)).toBe(false);
  ready.release();
  expect(await spawning.response).toMatchObject({
    ok: false,
    error: { code: "process_closed" },
  });
  expect(await active.spawn(input).response).toMatchObject({
    ok: false,
    error: { code: "process_closed" },
  });
  expect(fixture.owners).toHaveLength(1);
});

test("stop 抛出启动错误但最终快照已确认清空时，cancel 返回真实清空快照", async () => {
  active = await helperHarness();
  const input = request();
  expect(await active.spawn(input).response).toMatchObject({ ok: true });
  fixture.stopRejectAfterEmpty = true;
  expect(await active.send(cancellation(input)).response).toMatchObject({
    ok: true,
    value: { invocationId: input.invocationId, exit: { rangeEmpty: true } },
  });
});

test("停止未确认保留 stop_unconfirmed，取消墓碑不能降格为无 owner ACK", async () => {
  active = await helperHarness();
  const input = request();
  expect(await active.spawn(input).response).toMatchObject({ ok: true });
  fixture.rangeEmpty = false;
  for (let iteration = 0; iteration < 2; iteration++)
    expect(await active.send(cancellation(input)).response).toMatchObject({
      ok: false,
      error: { code: "stop_unconfirmed" },
    });
  expect(fixture.stopCalls).toBe(1);
  expect(
    await active.send({ method: "close", reason: "unconfirmed_cleanup" })
      .response,
  ).toMatchObject({ ok: false, error: { code: "stop_unconfirmed" } });
  expect(fixture.events).not.toContain("sdk_reset");
  expect(fixture.events).not.toContain("temporary_removed");
});

test.each([false, true])(
  "取消快返后 close 等待共享准备（失败=%s），禁止迟到 probe、reset 和目录删除越过屏障",
  async (failure) => {
    active = await helperHarness();
    const preparation = gate();
    fixture.sandboxGate = preparation.promise;
    fixture.sandboxFailure = failure;
    const input = request("cancel-before-close");
    input.scope.sandboxMode = "read-only";
    const spawning = active.spawn(input);
    await expect.poll(() => fixture.sandboxEntered).toBe(1);
    expect(await active.send(cancellation(input)).response).toMatchObject({
      ok: true,
      value: null,
    });
    const closing = active.send({
      method: "close",
      reason: "close_during_prepare",
    });
    const late = active.spawn(request("late-after-close"));
    expect(await late.response).toMatchObject({ ok: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(active.sent.has(closing.id)).toBe(false);
    expect(fixture.events).not.toContain("sdk_reset");
    expect(fixture.events).not.toContain("temporary_removed");
    preparation.release();
    expect(await closing.response).toMatchObject({ ok: true, value: null });
    expect(await spawning.response).toMatchObject({ ok: false });
    expect(fixture.owners).toHaveLength(0);
    expect(fixture.events.indexOf("sdk_reset")).toBeGreaterThan(
      fixture.events.indexOf("sdk_initialize_finished"),
    );
    expect(fixture.events.indexOf("temporary_removed")).toBeGreaterThan(
      fixture.events.indexOf("sdk_reset"),
    );
  },
);

test("初始化中的 proof owner 先停止，proof 收束后才 reset；close 不等待初始化才能发停止", async () => {
  active = await helperHarness(false);
  const waiting = gate();
  const finalizing = gate();
  fixture.proofWaitGate = waiting.promise;
  fixture.proofFinalizeGate = finalizing.promise;
  const initial = request("initialize-readonly");
  initial.scope.sandboxMode = "read-only";
  const initializing = active.initialize(initial);
  await expect
    .poll(() =>
      fixture.owners.some((owner) =>
        owner.snapshot().invocationId.startsWith("probe:"),
      ),
    )
    .toBe(true);
  const closing = active.send({
    method: "close",
    reason: "close_initial_proof",
  });
  await expect.poll(() => fixture.stopCalls).toBe(1);
  expect(active.sent.has(closing.id)).toBe(false);
  expect(fixture.events).not.toContain("sdk_reset");
  finalizing.release();
  await initializing.response;
  expect(await closing.response).toMatchObject({ ok: true, value: null });
  expect(fixture.events.indexOf("sdk_reset")).toBeGreaterThan(
    fixture.events.indexOf("proof_finished"),
  );
  expect(
    fixture.events.filter((event) => event.startsWith("owner:")),
  ).toHaveLength(1);
});
