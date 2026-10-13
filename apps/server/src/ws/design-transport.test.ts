import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { DesignHostEvent } from "../features/execution/design-run-host-types.js";
import { createDesignTransport } from "./design-transport.js";
import { CanvasEventBuffer } from "./event-buffer.js";

function fixture() {
  const actor = { instanceId: randomUUID(), accessClientId: randomUUID() },
    taskId = randomUUID();
  const frames: { connectionId: string; frame: Record<string, unknown> }[] = [];
  let listener: (event: DesignHostEvent) => void = () => {};
  const policy = {
    taskId,
    projectId: randomUUID(),
    rootDirectory: "/project",
    additionalDirectories: [],
    sandboxMode: "workspace-write",
    scopeGeneration: 1,
    branchGeneration: 1,
    mode: "build",
    planEnabled: false,
    planningEpoch: 0,
    activeRunId: null,
    executionState: "ready",
  };
  const runId = randomUUID();
  const emit = (target = taskId, instanceId = actor.instanceId) =>
    listener({
      instanceId,
      taskId: target,
      canvasId: "persisted",
      event: {
        type: "run.completed",
        runId,
        timestamp: new Date().toISOString(),
      },
    });
  const submit = vi.fn(async (_actor: unknown, input: { inputId: string }) => {
    emit();
    return {
      kind: "running",
      taskId,
      inputId: input.inputId,
      runId,
      sequence: 1,
      request: null,
    };
  });
  const stop = vi.fn(async () => ({ kind: "targetChanged" }));
  const deps = {
    host: {
      submit,
      stop,
      onEvent: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
    },
    tasks: { readPolicy: async () => policy },
    threads: {
      resolveOwnedSessionThread: async () => ({
        sessionId: taskId,
        projectId: policy.projectId,
        threadId: "thread",
        mode: "design",
        canvasId: "persisted",
      }),
    },
    connections: {
      sendTo: (connectionId: string, frame: Record<string, unknown>) => {
        frames.push({ connectionId, frame });
        return true;
      },
    },
    buffer: new CanvasEventBuffer(),
  } as unknown as Parameters<typeof createDesignTransport>[0];
  const transport = createDesignTransport(deps);
  transport.connect("connection", actor);
  const payload = {
    sessionId: taskId,
    taskId,
    conversationId: taskId,
    prompt: "hello",
    inputId: "stable-input",
    scopeGeneration: 1,
    branchGeneration: 1,
    preset: "design" as const,
  };
  return {
    actor,
    taskId,
    frames,
    runId,
    emit,
    submit,
    stop,
    policy,
    transport,
    payload,
  };
}
it("ACK is first even when host emits synchronously during submit; event has actual Task and monotonic seq", async () => {
  const f = fixture();
  const release = f.transport.gate("connection");
  await f.transport.run(f.actor, "connection", f.payload, "request");
  expect(f.frames.map((row) => row.frame.type)).toEqual(["command.ack"]);
  release();
  expect(f.frames[0]?.frame).toMatchObject({
    requestId: "request",
    action: "agent.run",
    payload: {
      taskId: f.taskId,
      inputId: "stable-input",
      runId: f.runId,
      delivery: "running",
    },
  });
  expect(f.frames[1]?.frame).toMatchObject({
    type: "event",
    seq: 1,
    taskId: f.taskId,
    event: { runId: f.runId },
  });
  f.transport.close();
});
it("live Task binding buffers events during next ACK and isolates other Task and instance", async () => {
  const f = fixture();
  await f.transport.resume(f.actor, "connection", f.taskId, 0, "resume");
  f.frames.splice(0);
  const release = f.transport.gate("connection");
  f.emit();
  f.emit(randomUUID());
  f.emit(f.taskId, randomUUID());
  expect(f.frames).toHaveLength(0);
  await f.transport.run(f.actor, "connection", f.payload, "run");
  release();
  expect(f.frames[0]?.frame.type).toBe("command.ack");
  expect(f.frames.filter((row) => row.frame.type === "event")).toHaveLength(2);
  f.transport.close();
});
it("resume confirms active Run before replay and reports volatile-buffer reset", async () => {
  const f = fixture();
  f.emit();
  await f.transport.resume(f.actor, "connection", f.taskId, 99, "resume");
  expect(f.frames[0]?.frame).toMatchObject({
    requestId: "resume",
    action: "task.resume",
    payload: { activeRunId: null, latestSeq: 1, replayed: 1, replayGap: true },
  });
  expect(f.frames[1]?.frame.type).toBe("event");
  f.transport.close();
});
it("invalid Task/epochs and unsupported loop fail before host admission; Plan requires separate durable policy CAS", async () => {
  const f = fixture();
  await expect(
    f.transport.run(f.actor, "connection", { ...f.payload, taskId: undefined }),
  ).rejects.toMatchObject({ code: "design_task_admission_required" });
  await expect(
    f.transport.run(f.actor, "connection", {
      ...f.payload,
      scopeGeneration: 2,
    }),
  ).rejects.toMatchObject({ code: "design_task_policy_changed" });
  await expect(
    f.transport.run(f.actor, "connection", {
      ...f.payload,
      executionMode: "loop",
    }),
  ).rejects.toMatchObject({ code: "design_mode_unsupported" });
  await expect(
    f.transport.run(f.actor, "connection", {
      ...f.payload,
      executionMode: "plan",
    }),
  ).rejects.toMatchObject({ code: "design_plan_update_required" });
  expect(f.submit).not.toHaveBeenCalled();
  f.transport.close();
});
it("cancel keeps the real Task and expected Run identity and returns correlated stale-target ACK", async () => {
  const f = fixture();
  await f.transport.cancel(
    f.actor,
    "connection",
    f.taskId,
    "old-run",
    "cancel",
  );
  expect(f.stop.mock.calls[0]).toEqual([
    f.actor,
    { taskId: f.taskId, expectedRunId: "old-run" },
  ]);
  expect(f.frames[0]?.frame).toMatchObject({
    requestId: "cancel",
    action: "agent.cancel",
    payload: { taskId: f.taskId, runId: "old-run", status: "targetChanged" },
  });
  f.transport.close();
});
