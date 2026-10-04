import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { ManagedProcess } from "../process-sandbox/types.js";
import { createTaskWorkManager } from "./service.js";
import { createMemoryTaskWorkStore } from "./test-store.js";
import type {
  TaskWorkContext,
  TaskWorkOutcome,
  TaskWorkRecord,
} from "./types.js";

const context: TaskWorkContext = {
  scope: {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    taskId: "00000000-0000-4000-8000-000000000003",
    generation: 1,
    rootDirectory: "/project",
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  },
  agentId: "main",
  runId: "run-1",
  branchGeneration: 1,
};

it("Task 工作跨前台 Run 存活，空闲终态只唤醒一次，新 Run 在模型边界原子消费", async () => {
  const store = createMemoryTaskWorkStore([context]);
  const manager = createTaskWorkManager({
    store,
    executionHostId: "host",
    resolveMaxConcurrent: async () => 4,
  });
  await manager.initialize();
  const wake = vi.fn(async () => true);
  manager.onReady(wake);
  let finish!: (outcome: TaskWorkOutcome) => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  const leave = await manager.enterForeground(context);
  const work = await manager.start(
    context,
    { kind: "command", label: "build", toolCallId: "call-1" },
    { run: () => completion, stop: async () => {} },
  );
  await leave();
  expect(wake).not.toHaveBeenCalled();
  expect(
    (await manager.find({ ...context, runId: "run-2" }, work.id))?.status,
  ).toBe("running");
  finish({
    status: "completed",
    summary: "build passed",
    outputRef: "/private/output/build.log",
  });
  await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
  const next = { ...context, runId: "run-2" };
  const leaveNext = await manager.enterForeground(next);
  const notes = await manager.consumeNotifications(next);
  expect(notes).toMatchObject([
    {
      id: work.id,
      status: "completed",
      summary: "build passed",
      originRunId: "run-1",
    },
  ]);
  expect(await manager.consumeNotifications(next)).toEqual([]);
  await leaveNext();
  expect(wake).toHaveBeenCalledTimes(1);
  await manager.close("test complete");
});

it("停止先等待真实退出，期间保持running，退出后保留输出与真实截断统计", async () => {
  const manager = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: "host",
    resolveMaxConcurrent: async () => 4,
  });
  let finish!: (outcome: TaskWorkOutcome) => void;
  let confirmExit!: () => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  const exited = new Promise<void>((resolve) => {
    confirmExit = resolve;
  });
  const stop = vi.fn(async () => {
    await exited;
    finish({
      status: "canceled",
      summary: "exited",
      outputRef: "/capture/log",
      outputStats: { retainedBytes: 10, totalBytes: 15, discardedBytes: 5 },
    });
  });
  const work = await manager.start(
    context,
    { kind: "command", label: "long build", toolCallId: "stop-call" },
    { run: () => completion, stop },
  );
  const stopping = manager.stop(context, work.id, "用户停止");
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  expect((await manager.find(context, work.id))?.status).toBe("running");
  confirmExit();
  await stopping;
  expect(await manager.find(context, work.id)).toMatchObject({
    status: "canceled",
    outputRef: "/capture/log",
    outputStats: { retainedBytes: 10, totalBytes: 15, discardedBytes: 5 },
  });
  await manager.close("test complete");
});

it("同一派发键重放只执行一次，同键改变命令参数明确拒绝", async () => {
  const manager = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: "host",
    resolveMaxConcurrent: async () => 4,
  });
  let finish!: (outcome: TaskWorkOutcome) => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn(() => completion);
  const executor = {
    run,
    stop: async () => {
      finish({ status: "canceled", summary: "stopped" });
    },
  };
  const input = {
    kind: "command" as const,
    label: "build",
    toolCallId: "stable-call",
    parameters: { command: "build", cwd: "/project" },
  };
  const first = await manager.start(context, input, executor);
  expect(
    (
      await manager.start(
        context,
        { ...input, parameters: { cwd: "/project", command: "build" } },
        executor,
      )
    ).id,
  ).toBe(first.id);
  expect(run).toHaveBeenCalledTimes(1);
  await expect(
    manager.start(
      context,
      { ...input, parameters: { command: "build", cwd: "/another" } },
      executor,
    ),
  ).rejects.toThrow("参数");
  await manager.close("test complete");
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("并发重复 stop、Task close 与宿主 close 加入同一次真实停止，确认前保持 running", async () => {
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-task-stop-")),
  );
  cleanups.push(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "project");
  await mkdir(root);
  const scope = { ...context.scope, rootDirectory: root };
  const taskContext = { ...context, scope };
  const manager = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: "real-stop-host",
    resolveMaxConcurrent: async () => 4,
  });
  const sandbox = createProcessSandbox({
    captureRoot: join(fixture, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test_cleanup"));
  cleanups.push(() => manager.close("test_cleanup"));
  const release = join(root, "release.txt");
  let spawned!: (child: ManagedProcess) => void;
  const childReady = new Promise<ManagedProcess>((resolve) => {
    spawned = resolve;
  });
  let stopCalls = 0;
  const program = `const fs=require("node:fs");process.on("SIGTERM",()=>{process.stdout.write("terminating\\n");setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},10)});setInterval(()=>{},1000);process.stdout.write("ready\\n")`;
  const record = await manager.start(
    taskContext,
    { kind: "command", label: "真实停止", toolCallId: "real-stop" },
    {
      async run() {
        const child = await sandbox.spawn({
          scope,
          agentId: "worker",
          invocationId: "stop-proof",
          argv: { executable: process.execPath, args: ["-e", program] },
          background: true,
          timeoutMs: null,
          limits: {
            maxOutputBytes: 65536,
            previewMaxChars: 8000,
            yieldMs: 20,
            killGraceMs: 2000,
          },
        });
        spawned(child);
        const exit = await child.waitForExit();
        const snapshot = child.snapshot();
        return {
          status: exit.stopped ? "canceled" : "completed",
          summary: "真实范围已退出",
          outputRef: snapshot.outputPath,
          outputStats: {
            retainedBytes: snapshot.retainedBytes,
            totalBytes: snapshot.totalBytes,
            discardedBytes: snapshot.discardedBytes,
          },
        };
      },
      async stop(reason) {
        stopCalls++;
        expect((await (await childReady).stop(reason)).rangeEmpty).toBe(true);
      },
    },
  );
  const child = await childReady;
  await expect
    .poll(
      async () => (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
    )
    .toContain("ready");
  const first = manager.stop(taskContext, record.id, "用户停止");
  void first.catch(() => {});
  await expect
    .poll(
      async () => (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
    )
    .toContain("terminating");
  const outcomes = Promise.allSettled([
    first,
    manager.stop(taskContext, record.id, "重复停止"),
    manager.closeTask(scope.workspaceId, scope.taskId, "关闭Task"),
    manager.close("关闭宿主"),
  ]);
  try {
    expect((await manager.find(taskContext, record.id))?.status).toBe(
      "running",
    );
    expect(stopCalls).toBe(1);
  } finally {
    await writeFile(release, "exit");
  }
  expect((await outcomes).map((outcome) => outcome.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ]);
  expect(stopCalls).toBe(1);
  expect(await child.waitForExit()).toMatchObject({
    stopped: true,
    rangeEmpty: true,
  });
  expect(await manager.find(taskContext, record.id)).toMatchObject({
    status: "canceled",
    outputRef: child.snapshot().outputPath,
  });
});

it("同一执行宿主只允许一个活实例，第二实例不得恢复仍在运行的旧 owner", async () => {
  const store = createMemoryTaskWorkStore([context]);
  const first = createTaskWorkManager({
    store,
    executionHostId: "same-live-host",
    ownerId: "00000000-0000-4000-8000-000000000010",
    resolveMaxConcurrent: async () => 4,
  });
  const second = createTaskWorkManager({
    store,
    executionHostId: "same-live-host",
    ownerId: "00000000-0000-4000-8000-000000000011",
    resolveMaxConcurrent: async () => 4,
  });
  let finish!: (outcome: TaskWorkOutcome) => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  const record = await first.start(
    context,
    { kind: "command", label: "仍在运行", toolCallId: "live-owner" },
    {
      run: () => completion,
      stop: async () => {
        finish({ status: "canceled", summary: "confirmed" });
      },
    },
  );
  try {
    await expect(second.initialize()).rejects.toMatchObject({
      code: "execution_host_busy",
    });
    expect((await first.find(context, record.id))?.status).toBe("running");
  } finally {
    await Promise.all([first.close("cleanup"), second.close("cleanup")]);
  }
});

it("未接纳的空闲唤醒释放准入锁，用户上下文恢复后并发就绪通知只接纳一次", async () => {
  const manager = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: "admission-host",
    resolveMaxConcurrent: async () => 4,
  });
  let actorAvailable = false;
  let admitted = 0;
  const ready = vi.fn(async () => {
    if (!actorAvailable) return false;
    admitted++;
    return true;
  });
  manager.onReady(ready);
  let finish!: (outcome: TaskWorkOutcome) => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  const record = await manager.start(
    context,
    {
      kind: "command",
      label: "completed while absent",
      toolCallId: "absent-actor",
    },
    {
      run: () => completion,
      stop: async () => {
        finish({ status: "canceled", summary: "stop" });
      },
    },
  );
  finish({ status: "completed", summary: "真实结果" });
  try {
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    actorAvailable = true;
    await Promise.all([
      manager.notifyReady(context.scope.workspaceId, context.scope.taskId),
      manager.notifyReady(context.scope.workspaceId, context.scope.taskId),
      manager.notifyReady(context.scope.workspaceId, context.scope.taskId),
    ]);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(admitted).toBe(1);
    const next = { ...context, runId: "admitted-run" };
    const leave = await manager.enterForeground(next);
    expect(await manager.consumeNotifications(next)).toMatchObject([
      { id: record.id, status: "completed" },
    ]);
    expect(await manager.consumeNotifications(next)).toEqual([]);
    await leave();
    expect(admitted).toBe(1);
  } finally {
    await manager.close("cleanup");
  }
});

it("空Task关闭使用权威代际，旧scope不得复活，同代际revoking完成后的可信新scope可重开", async () => {
  const store = createMemoryTaskWorkStore([context]);
  const manager = createTaskWorkManager({
    store,
    executionHostId: "close-fence-host",
    resolveMaxConcurrent: async () => 4,
  });
  await manager.initialize();
  try {
    await manager.closeTask(
      context.scope.workspaceId,
      context.scope.taskId,
      "关闭空Task",
    );
    await expect(
      manager.enterForeground({ ...context, runId: "late-old-run" }),
    ).rejects.toMatchObject({ code: "task_closed" });
    const reopened = {
      ...context,
      scope: { ...context.scope, generation: 2 },
      runId: "trusted-new-run",
    };
    store.setTask(reopened);
    const leave = await manager.enterForeground(reopened);
    await expect(
      manager.enterForeground({ ...reopened, runId: "concurrent-run" }),
    ).rejects.toMatchObject({ code: "foreground_busy" });
    await leave();
    const rewind = {
      ...reopened,
      scope: { ...reopened.scope, generation: 3 },
      branchGeneration: 2,
      runId: "rewound-run",
    };
    store.setTask(rewind, "revoking");
    await manager.closeTask(
      context.scope.workspaceId,
      context.scope.taskId,
      "回绕旧分支",
    );
    store.setTask(rewind, "ready");
    const leaveRewound = await manager.enterForeground(rewind);
    await leaveRewound();
    await expect(manager.enterForeground(reopened)).rejects.toMatchObject({
      code: "task_closed",
    });
  } finally {
    await manager.close("cleanup");
  }
});

it("发起Run取消前拒绝派发和消费，已接纳的显式后台工作独立存活", async () => {
  const store = createMemoryTaskWorkStore([context]);
  const manager = createTaskWorkManager({
    store,
    executionHostId: "origin-signal-host",
    resolveMaxConcurrent: async () => 4,
  });
  const canceled = new AbortController();
  const reason = new Error("前台已取消");
  canceled.abort(reason);
  let finish!: (outcome: TaskWorkOutcome) => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn(() => completion);
  const executor = {
    run,
    stop: async () => {
      finish({ status: "canceled", summary: "confirmed" });
    },
  };
  try {
    await expect(
      manager.start(
        { ...context, signal: canceled.signal },
        { kind: "command", label: "迟到的派发", toolCallId: "late-canceled" },
        executor,
      ),
    ).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
    const active = new AbortController();
    const origin = { ...context, signal: active.signal };
    const record = await manager.start(
      origin,
      { kind: "command", label: "显式后台", toolCallId: "accepted-background" },
      executor,
    );
    active.abort(new Error("只停止前台"));
    expect((await manager.find(context, record.id))?.status).toBe("running");
    finish({ status: "completed", summary: "后台独立完成" });
    await vi.waitFor(async () =>
      expect((await manager.find(context, record.id))?.status).toBe(
        "completed",
      ),
    );
    await expect(
      manager.consumeNotifications({ ...context, signal: canceled.signal }),
    ).rejects.toBe(reason);
    expect((await manager.find(context, record.id))?.consumed).toBe(false);
    expect(
      await manager.consumeNotifications({ ...context, runId: "fresh-run" }),
    ).toMatchObject([{ id: record.id, status: "completed" }]);
  } finally {
    await manager.close("cleanup");
  }
});

it("宿主重启保留日志并发布恢复事实，旧running与已完成未消费结果均不自动重放", async () => {
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-work-recovery-")),
  );
  cleanups.push(() => rm(fixture, { recursive: true, force: true }));
  const output = join(fixture, "old-output.bin");
  await writeFile(output, "old output\n");
  const store = createMemoryTaskWorkStore([context]);
  const makeRecord = (id: string, host: string): TaskWorkRecord => ({
    id,
    scope: context.scope,
    agentId: "worker",
    kind: "command",
    detached: true,
    label: "旧结果",
    originRunId: "old-run",
    toolCallId: id,
    parameterFingerprint: "recorded-old-parameter-fingerprint",
    branchGeneration: 1,
    status: "running",
    startedAt: "2026-10-02T01:00:00.000Z",
    consumed: false,
    ownerId: "00000000-0000-4000-8000-000000000010",
    executionHostId: host,
  });
  const running = makeRecord(
    "00000000-0000-4000-8000-000000000020",
    "restarted-host",
  );
  const completed = makeRecord(
    "00000000-0000-4000-8000-000000000021",
    "restarted-host",
  );
  const remote = makeRecord(
    "00000000-0000-4000-8000-000000000022",
    "other-live-host",
  );
  await store.create(running);
  await store.create(completed);
  await store.create(remote);
  await store.updateOutput(
    context.scope.workspaceId,
    context.scope.taskId,
    running.id,
    running.ownerId,
    output,
    { retainedBytes: 11, totalBytes: 13, discardedBytes: 2 },
  );
  await store.settle(
    context.scope.workspaceId,
    context.scope.taskId,
    completed.id,
    { status: "completed", summary: "已完成但未消费", outputRef: output },
    "2026-10-02T01:01:00.000Z",
  );
  const manager = createTaskWorkManager({
    store,
    executionHostId: "restarted-host",
    resolveMaxConcurrent: async () => 4,
  });
  const changed: TaskWorkRecord[] = [];
  manager.onChanged(async (record) => {
    changed.push(record);
  });
  const ready = vi.fn(async () => true);
  manager.onReady(ready);
  try {
    const recovered = await manager.initialize();
    expect(recovered.map((record) => record.id).sort()).toEqual([
      running.id,
      completed.id,
    ]);
    expect(changed.map((record) => record.id).sort()).toEqual([
      running.id,
      completed.id,
    ]);
    expect(await manager.find(context, running.id)).toMatchObject({
      status: "interrupted",
      consumed: true,
      outputRef: output,
      outputStats: { retainedBytes: 11, totalBytes: 13, discardedBytes: 2 },
    });
    expect(await manager.find(context, completed.id)).toMatchObject({
      status: "completed",
      consumed: true,
      summary: "已完成但未消费",
    });
    expect(await manager.find(context, remote.id)).toMatchObject({
      status: "running",
      consumed: false,
    });
    expect(await readFile(output, "utf8")).toBe("old output\n");
    await manager.notifyReady(context.scope.workspaceId, context.scope.taskId);
    const leave = await manager.enterForeground({
      ...context,
      runId: "new-after-restart",
    });
    expect(
      await manager.consumeNotifications({
        ...context,
        runId: "new-after-restart",
      }),
    ).toEqual([]);
    await leave();
    expect(ready).not.toHaveBeenCalled();
  } finally {
    await manager.close("cleanup");
  }
});

it("前台子任务持久记录且不重复通知，后台子任务默认detached并只消费一次", async () => {
  const manager = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: "child-lifecycle-host",
    resolveMaxConcurrent: async () => 4,
  });
  const ready = vi.fn(async () => true);
  manager.onReady(ready);
  let finishFore!: (outcome: TaskWorkOutcome) => void;
  const foreResult = new Promise<TaskWorkOutcome>((resolve) => {
    finishFore = resolve;
  });
  const fore = await manager.start(
    context,
    {
      kind: "subagent",
      label: "审查子任务",
      detached: false,
      toolCallId: "fore-child",
      parameters: {
        description: "审查实现",
        responsibility: "只读服务",
        completionCriteria: "返回证据",
      },
    },
    {
      run: () => foreResult,
      stop: async () => {
        finishFore({ status: "canceled", summary: "confirmed" });
      },
    },
  );
  try {
    expect(fore).toMatchObject({
      detached: false,
      consumed: true,
      status: "running",
    });
    finishFore({ status: "completed", summary: "由SDK返回一次" });
    await vi.waitFor(async () =>
      expect((await manager.find(context, fore.id))?.status).toBe("completed"),
    );
    await manager.notifyReady(context.scope.workspaceId, context.scope.taskId);
    expect(await manager.consumeNotifications(context)).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
    let finishBackground!: (outcome: TaskWorkOutcome) => void;
    const backgroundResult = new Promise<TaskWorkOutcome>((resolve) => {
      finishBackground = resolve;
    });
    const run = vi.fn(() => backgroundResult);
    const input = {
      kind: "subagent" as const,
      label: "后台子任务",
      toolCallId: "background-child",
      parameters: {
        description: "检查目录",
        responsibility: "文档",
        completionCriteria: "返回摘要",
      },
    };
    const background = await manager.start(context, input, {
      run,
      stop: async () => {
        finishBackground({ status: "canceled", summary: "confirmed" });
      },
    });
    expect(background).toMatchObject({ detached: true, consumed: false });
    expect(
      (
        await manager.start(
          context,
          { ...input, detached: true },
          { run, stop: async () => {} },
        )
      ).id,
    ).toBe(background.id);
    expect(run).toHaveBeenCalledTimes(1);
    finishBackground({ status: "completed", summary: "mailbox返回一次" });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(
      await manager.consumeNotifications({ ...context, runId: "next-run" }),
    ).toMatchObject([{ id: background.id, detached: true }]);
    expect(
      await manager.consumeNotifications({ ...context, runId: "next-run" }),
    ).toEqual([]);
  } finally {
    await manager.close("cleanup");
  }
});

it("忙碌前台保持排他并在模型边界消费一次，分支墓碑拒绝旧结果迟到唤醒", async () => {
  const store = createMemoryTaskWorkStore([context]);
  const manager = createTaskWorkManager({
    store,
    executionHostId: "busy-branch-host",
    resolveMaxConcurrent: async () => 4,
  });
  const ready = vi.fn(async () => true);
  manager.onReady(ready);
  const leave = await manager.enterForeground(context);
  let finish!: (outcome: TaskWorkOutcome) => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  try {
    await expect(
      manager.enterForeground({ ...context, runId: "concurrent-foreground" }),
    ).rejects.toMatchObject({ code: "foreground_busy" });
    const record = await manager.start(
      context,
      { kind: "command", label: "忙时结果", toolCallId: "busy-result" },
      {
        run: () => completion,
        stop: async () => {
          finish({ status: "canceled", summary: "confirmed" });
        },
      },
    );
    finish({ status: "completed", summary: "下一模型边界送达" });
    await vi.waitFor(async () =>
      expect((await manager.find(context, record.id))?.status).toBe(
        "completed",
      ),
    );
    expect(ready).not.toHaveBeenCalled();
    expect(await manager.consumeNotifications(context)).toMatchObject([
      { id: record.id, status: "completed" },
    ]);
    expect(await manager.consumeNotifications(context)).toEqual([]);
    let finishLate!: (outcome: TaskWorkOutcome) => void;
    const lateCompletion = new Promise<TaskWorkOutcome>((resolve) => {
      finishLate = resolve;
    });
    const late = await manager.start(
      context,
      {
        kind: "command",
        label: "旧分支迟到",
        toolCallId: "late-branch-result",
      },
      {
        run: () => lateCompletion,
        stop: async () => {
          finishLate({ status: "canceled", summary: "confirmed" });
        },
      },
    );
    const branch = {
      ...context,
      scope: { ...context.scope, generation: 2 },
      branchGeneration: 2,
      runId: "new-branch",
    };
    store.setTask(branch);
    finishLate({ status: "completed", summary: "旧分支未消费结果" });
    await vi.waitFor(async () =>
      expect((await manager.find(context, late.id))?.status).toBe("completed"),
    );
    expect((await manager.find(context, late.id))?.consumed).toBe(false);
    await expect(manager.consumeNotifications(context)).rejects.toMatchObject({
      code: "task_closed",
    });
    await leave();
    await manager.notifyReady(context.scope.workspaceId, context.scope.taskId);
    expect(ready).not.toHaveBeenCalled();
    const leaveNew = await manager.enterForeground(branch);
    expect(await manager.consumeNotifications(branch)).toEqual([]);
    await leaveNew();
  } finally {
    await leave();
    await manager.close("cleanup");
  }
});

it("可信新scope在旧Task停止确认前不可重开，确认后旧scope终态不再唤醒", async () => {
  const store = createMemoryTaskWorkStore([context]);
  const manager = createTaskWorkManager({
    store,
    executionHostId: "pending-close-host",
    resolveMaxConcurrent: async () => 4,
  });
  const ready = vi.fn(async () => true);
  manager.onReady(ready);
  let finish!: (outcome: TaskWorkOutcome) => void;
  let confirm!: () => void;
  const completion = new Promise<TaskWorkOutcome>((resolve) => {
    finish = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  const stop = vi.fn(async () => {
    await stopped;
    finish({ status: "canceled", summary: "confirmed" });
  });
  const record = await manager.start(
    context,
    { kind: "command", label: "等待关闭确认", toolCallId: "pending-close" },
    { run: () => completion, stop },
  );
  const closing = manager.closeTask(
    context.scope.workspaceId,
    context.scope.taskId,
    "close",
  );
  void closing.catch(() => {});
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  const next = {
    ...context,
    scope: { ...context.scope, generation: 2 },
    runId: "trusted-reopen",
  };
  store.setTask(next);
  try {
    await expect(manager.enterForeground(next)).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
    expect((await manager.find(context, record.id))?.status).toBe("running");
  } finally {
    confirm();
    await closing;
  }
  try {
    await manager.notifyReady(context.scope.workspaceId, context.scope.taskId);
    expect(ready).not.toHaveBeenCalled();
    const leave = await manager.enterForeground(next);
    expect(await manager.consumeNotifications(next)).toEqual([]);
    await leave();
    expect(ready).not.toHaveBeenCalled();
  } finally {
    await manager.close("cleanup");
  }
});
