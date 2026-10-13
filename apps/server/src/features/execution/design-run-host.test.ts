import {
  executionModeSchema,
  runCreateRequestSchema,
  type StreamEvent,
} from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import {
  createExecutionModeService,
  evaluateToolPolicy,
} from "../agent-modes/execution-mode-service.js";
import { createTestDesignModelSelection } from "./design-goals-test-fixture.js";
import { createDesignRunHost } from "./design-run-host.js";
import type { DesignHostStoredInput } from "./design-run-host-types.js";
import { parameterFingerprint } from "./parameter-fingerprint.js";

function fixture(
  settings: { activeGoal?: boolean; planEnabled?: boolean } = {},
) {
  const actor = { instanceId: "instance", accessClientId: "original-client" };
  const rows = new Map<string, DesignHostStoredInput>();
  const byInput = new Map<string, { runId: string; hash: string }>();
  const queue: string[] = [];
  let activeRunId: string | null = null;
  let outcome: string | null = null;
  let generation = 1,
    branchGeneration = 1,
    executionState = "ready",
    restoreOperationId: string | null = null;
  let revoked: (clientId: string) => unknown = () => {};
  let leaseLost: (instanceId: string, taskId: string) => unknown = () => {};
  let ready: (identity: {
    instanceId: string;
    taskId: string;
    ownerKind: "code" | "design";
  }) => Promise<boolean> = async () => false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending: {
    id: string;
    originRunId: string;
    consumed: boolean;
    status: string;
    branchGeneration: number;
    ownerKind: string;
  }[] = [];
  const canceled = new Set<string>();
  const options = new Map<
    string,
    { eventSink: (event: StreamEvent) => Promise<void> }
  >();
  const scope = {
    instanceId: actor.instanceId,
    taskId: "task",
    projectId: "project",
    rootDirectory: "/project",
    generation: 1,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const policy = () => ({
    taskId: "task",
    projectId: "project",
    rootDirectory: "/project",
    additionalDirectories: [],
    sandboxMode: "workspace-write",
    scopeGeneration: generation,
    branchGeneration,
    planningEpoch: 0,
    mode: "build",
    planEnabled: settings.planEnabled ?? false,
    executionState,
    activeRunId,
  });
  const settleRun = vi.fn(
    async (_actor: typeof actor, input: { runId: string; outcome: string }) => {
      if (activeRunId !== input.runId) return false;
      activeRunId = null;
      outcome = input.outcome;
      return true;
    },
  );
  const createRun = vi.fn(
    (
      request: unknown,
      runOptions: {
        runId: string;
        eventSink: (event: StreamEvent) => Promise<void>;
        inputOrigin?: string;
      },
    ) => {
      options.set(runOptions.runId, runOptions);
      if (runOptions.inputOrigin === "backgroundResult")
        for (const work of pending) work.consumed = true;
      return { runId: runOptions.runId };
    },
  );
  const persistInput = vi.fn(async () => {});
  const createAcceptedRun = vi.fn(async () => {});
  const loadLatestActor = vi.fn(async () => ({ actor }));
  const activatedModes: string[] = [];
  const modeService = createExecutionModeService();
  const deps = {
    modelSelection: createTestDesignModelSelection(),
    designGoals: {
      initialize: async () => {},
      readTask: async () =>
        settings.activeGoal ? { claimedRunId: activeRunId } : null,
      observe: async () => ({ stop: false }),
      continuation: async () => null,
      onLost: () => () => {},
    },
    agentModes: {
      activate: async (_thread: string, mode: string) => {
        activatedModes.push(mode);
        await modeService.activate(_thread, executionModeSchema.parse(mode));
      },
      hydrate: async () => "agent",
    },
    repository: {
      loadInput: async (_instance: string, _task: string, runId: string) =>
        rows.get(runId) ?? null,
      loadLatestActor,
      loadOriginActor: async () => ({ actor }),
      listPending: async () => [],
      lastOutcome: async () => outcome,
      persistInput,
      cancelQueuedForClient: vi.fn(async () => {}),
    },
    designTasks: {
      beginRestore: async (
        _actor: typeof actor,
        input: {
          taskId: string;
          expectedScopeGeneration: number;
          expectedBranchGeneration: number;
        },
      ) => {
        if (
          input.expectedScopeGeneration !== generation ||
          input.expectedBranchGeneration !== branchGeneration ||
          executionState === "revoking"
        )
          throw new Error("restore conflict");
        generation++;
        branchGeneration++;
        executionState = "revoking";
        restoreOperationId = "operation";
        queue.splice(0);
        return {
          taskId: input.taskId,
          projectId: "project",
          operationId: restoreOperationId,
          scopeGeneration: generation,
          branchGeneration,
          activeRunId,
          scope: { ...scope, generation },
        };
      },
      finishRestore: async (
        _actor: typeof actor,
        input: {
          operationId: string;
          scopeGeneration: number;
          branchGeneration: number;
          state: string;
        },
      ) => {
        if (
          input.operationId !== restoreOperationId ||
          input.scopeGeneration !== generation ||
          input.branchGeneration !== branchGeneration ||
          activeRunId ||
          executionState !== "revoking"
        )
          return false;
        executionState = input.state;
        restoreOperationId = null;
        return true;
      },
      markRunStarted: async () => true,
      admitInput: async (
        savedActor: typeof actor,
        input: {
          taskId: string;
          inputId: string;
          runId: string;
          captureModelInvocation: () => Promise<
            NonNullable<DesignHostStoredInput["modelInvocation"]>
          >;
          request: unknown;
          scopeGeneration: number;
          branchGeneration: number;
          origin?: DesignHostStoredInput["origin"];
        },
      ) => {
        const { accessToken: _secret, ...request } =
          runCreateRequestSchema.parse(input.request);
        const hash = parameterFingerprint({
          request,
          scopeGeneration: input.scopeGeneration,
          branchGeneration: input.branchGeneration,
        });
        const previous = byInput.get(input.inputId);
        if (previous) {
          if (previous.hash !== hash) throw new Error("input conflict");
          return {
            kind: "duplicate",
            taskId: input.taskId,
            inputId: input.inputId,
            runId: previous.runId,
            sequence: 1,
            request: null,
          };
        }
        if (executionState !== "ready") throw new Error("task frozen");
        byInput.set(input.inputId, { runId: input.runId, hash });
        rows.set(input.runId, {
          modelInvocation: await input.captureModelInvocation(),
          actor: savedActor,
          taskId: input.taskId,
          inputId: input.inputId,
          runId: input.runId,
          scopeGeneration: input.scopeGeneration,
          branchGeneration: input.branchGeneration,
          request,
          origin: input.origin ?? "userInput",
        });
        const kind = activeRunId ? "queued" : "running";
        if (activeRunId) queue.push(input.runId);
        else activeRunId = input.runId;
        return {
          kind,
          taskId: input.taskId,
          inputId: input.inputId,
          runId: input.runId,
          sequence: 1,
          request,
        };
      },
      readPolicy: async () => policy(),
      settleRun,
      recoverInterruptedTasks: vi.fn(async () => 0),
      claimNextInput: async () => {
        if (activeRunId || executionState !== "ready") return null;
        const runId = queue.shift();
        if (!runId) return null;
        activeRunId = runId;
        const row = rows.get(runId)!;
        return {
          kind: "running",
          taskId: row.taskId,
          inputId: row.inputId,
          runId,
          sequence: 2,
          request: row.request,
        };
      },
      requestStop: async (
        _actor: typeof actor,
        input: { expectedRunId?: string },
      ) => {
        if (input.expectedRunId && activeRunId !== input.expectedRunId)
          return { kind: "targetChanged" };
        queue.splice(0);
        return activeRunId
          ? { kind: "stopping", runId: activeRunId }
          : { kind: "idle" };
      },
      onLeaseLost: (fn: typeof leaseLost) => {
        leaseLost = fn;
        return () => {};
      },
    },
    agentRuns: {
      createRun,
      cancelRun: vi.fn((runId: string) => {
        canceled.add(runId);
        release();
      }),
      cancelRunAndWait: async () => {},
      async *streamRun(runId: string) {
        const sink = options.get(runId)!.eventSink;
        await gate;
        if (!canceled.has(runId)) {
          const event: StreamEvent = {
            type: "message.delta",
            runId,
            messageId: `message-${runId}`,
            delta: "answer",
            timestamp: new Date().toISOString(),
          };
          await sink(event);
          yield event;
        }
        const terminal: StreamEvent = {
          type: canceled.has(runId) ? "run.canceled" : "run.completed",
          runId,
          timestamp: new Date().toISOString(),
        };
        await sink(terminal);
        yield terminal;
      },
    },
    metadata: { createAcceptedRun },
    threads: {
      resolveOwnedSessionThread: async () => ({
        mode: "design",
        sessionId: "task",
        threadId: "thread",
        projectId: "project",
        canvasId: "persistent-canvas",
      }),
    },
    executionScopes: {
      openRestoringTask: async (
        _actor: unknown,
        _task: string,
        expectedGeneration: number,
      ) => ({
        preset: "design",
        agentId: "main",
        describe: () => ({ ...scope, generation: expectedGeneration }),
      }),
      openTask: async () => ({
        preset: "design",
        agentId: "main",
        describe: () => ({ ...scope, generation }),
      }),
    },
    localInstance: {
      serviceActor: async () => ({
        instanceId: actor.instanceId,
        accessClientId: null,
      }),
      getContext: async () => ({ instanceId: actor.instanceId }),
    },
    localAccess: {
      onRevoked: (fn: typeof revoked) => {
        revoked = fn;
        return () => {};
      },
    },
    taskWork: {
      closeTask: async () => {},
      onReady: (fn: typeof ready) => {
        ready = fn;
        return () => {};
      },
      list: async () => pending,
    },
  } as unknown as Parameters<typeof createDesignRunHost>[0];
  const host = createDesignRunHost(deps);
  const input = (id: string, prompt = "hello") => ({
    taskId: "task",
    inputId: id,
    scopeGeneration: 1,
    branchGeneration: 1,
    request: {
      sessionId: "task",
      conversationId: "view",
      prompt,
      preset: "design" as const,
      accessToken: "never-persist",
    },
  });
  return {
    host,
    activatedModes,
    modeService,
    setPending: (originRunId: string) =>
      pending.push({
        id: "work",
        originRunId,
        consumed: false,
        status: "completed",
        branchGeneration: 1,
        ownerKind: "design",
      }),
    actor,
    input,
    release,
    createRun,
    createAcceptedRun,
    loadLatestActor,
    settleRun,
    persistInput,
    rows,
    policy,
    revoked: (id: string) => revoked(id),
    leaseLost: () => leaseLost(actor.instanceId, "task"),
    ready: (kind: "code" | "design") =>
      ready({ instanceId: actor.instanceId, taskId: "task", ownerKind: kind }),
  };
}
it("one real foreground, FIFO next Run, original actor and persistent canvas, atomic terminal metadata", async () => {
  const f = fixture();
  const events: StreamEvent[] = [];
  f.host.onEvent(({ event }) => {
    events.push(event);
  });
  const first = await f.host.submit(f.actor, f.input("first"));
  const second = await f.host.submit(f.actor, f.input("second"));
  expect([first.kind, second.kind]).toEqual(["running", "queued"]);
  f.release();
  await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(f.policy().activeRunId).toBeNull());
  expect(f.createRun.mock.calls[0]?.[1]).toMatchObject({
    actor: f.actor,
    inputOrigin: "userInput",
  });
  expect(f.createRun.mock.calls[0]?.[0]).toMatchObject({
    canvasId: "persistent-canvas",
    taskId: "task",
    preset: "design",
  });
  expect(JSON.stringify([...f.rows.values()])).not.toContain("never-persist");
  expect(f.settleRun.mock.calls[0]?.[1]).toMatchObject({
    terminalMetadata: { assistant: { text: "answer" } },
  });
  expect(events.filter((event) => event.type === "run.completed")).toHaveLength(
    2,
  );
  await f.host.close();
});
it("reconnect same input keeps original Run and never executes twice, changed text conflicts", async () => {
  const f = fixture();
  const first = await f.host.submit(f.actor, f.input("same"));
  const duplicate = await f.host.submit(f.actor, f.input("same"));
  expect(duplicate.kind).toBe("duplicate");
  expect(duplicate.runId).toBe(first.runId);
  await expect(
    f.host.submit(f.actor, f.input("same", "changed")),
  ).rejects.toThrow("conflict");
  f.release();
  await vi.waitFor(() => expect(f.policy().activeRunId).toBeNull());
  expect(f.createRun).toHaveBeenCalledTimes(1);
  expect(f.persistInput).toHaveBeenCalledTimes(1);
  await f.host.close();
});
it("late stop targets cannot cancel a newer Run; matching stop cancels queued work", async () => {
  const f = fixture();
  const first = await f.host.submit(f.actor, f.input("first"));
  await f.host.submit(f.actor, f.input("queued"));
  expect(
    await f.host.stop(f.actor, { taskId: "task", expectedRunId: "old" }),
  ).toEqual({ kind: "targetChanged" });
  await f.host.stop(f.actor, { taskId: "task", expectedRunId: first.runId });
  expect(f.policy().activeRunId).toBeNull();
  expect(f.createRun.mock.calls.length).toBeLessThanOrEqual(1);
  expect(await f.ready("design")).toBe(false);
  await f.host.close();
});
it("client revocation and lease loss cancel active work without transport replay", async () => {
  const f = fixture();
  await f.host.submit(f.actor, f.input("first"));
  await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(1));
  await f.revoked(f.actor.accessClientId);
  f.leaseLost();
  await vi.waitFor(() => expect(f.policy().activeRunId).toBeNull());
  expect(f.createRun).toHaveBeenCalledTimes(1);
  await f.host.close();
});
it("forged canvas and reserved background input are rejected before admission", async () => {
  const f = fixture();
  await expect(
    f.host.submit(f.actor, {
      ...f.input("first"),
      request: { ...f.input("first").request, canvasId: "forged" },
    }),
  ).rejects.toMatchObject({ code: "design_task_identity_mismatch" });
  await expect(
    f.host.submit(f.actor, f.input("task-work:forged")),
  ).rejects.toMatchObject({ code: "design_input_reserved" });
  expect(f.rows.size).toBe(0);
  expect(await f.ready("code")).toBe(false);
  await f.host.close();
});

it("TaskWork ready admits one controlled background Run under original live client and no fake user message", async () => {
  const f = fixture();
  const first = await f.host.submit(f.actor, f.input("first"));
  f.release();
  await vi.waitFor(() => expect(f.policy().activeRunId).toBeNull());
  f.setPending(first.runId);
  await f.ready("design");
  await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(f.policy().activeRunId).toBeNull());
  expect(f.createRun.mock.calls[1]?.[1]).toMatchObject({
    actor: f.actor,
    inputOrigin: "backgroundResult",
  });
  expect(f.persistInput).toHaveBeenCalledTimes(1);
  expect(await f.ready("design")).toBe(false);
  await f.host.close();
});

it("restore freezes first, waits foreground, discards old queue and only matching lease can finish without auto Run", async () => {
  const f = fixture();
  await f.host.submit(f.actor, f.input("first"));
  await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(1));
  await f.host.submit(f.actor, f.input("queued"));
  const lease = await f.host.beginRestore(f.actor, {
    taskId: "task",
    expectedScopeGeneration: 1,
    expectedBranchGeneration: 1,
  });
  expect([
    lease.scopeGeneration,
    lease.branchGeneration,
    lease.scope.generation,
    lease.activeRunId,
  ]).toEqual([2, 2, 2, null]);
  expect(f.policy().executionState).toBe("revoking");
  expect(f.policy().activeRunId).toBeNull();
  await expect(
    f.host.submit(f.actor, {
      ...f.input("during"),
      scopeGeneration: 2,
      branchGeneration: 2,
    }),
  ).rejects.toThrow("frozen");
  expect(
    await f.host.finishRestore(f.actor, {
      taskId: "task",
      operationId: "stale",
      scopeGeneration: 2,
      branchGeneration: 2,
      state: "ready",
    }),
  ).toBe(false);
  expect(
    await f.host.finishRestore(f.actor, {
      taskId: "task",
      operationId: lease.operationId,
      scopeGeneration: 2,
      branchGeneration: 2,
      state: "ready",
    }),
  ).toBe(true);
  expect(f.createRun).toHaveBeenCalledTimes(1);
  expect(f.policy().executionState).toBe("ready");
  await f.host.close();
});
it("failed restore stays closed and never starts queued or TaskWork background work", async () => {
  const f = fixture();
  const lease = await f.host.beginRestore(f.actor, {
    taskId: "task",
    expectedScopeGeneration: 1,
    expectedBranchGeneration: 1,
  });
  expect(
    await f.host.finishRestore(f.actor, {
      taskId: "task",
      operationId: lease.operationId,
      scopeGeneration: 2,
      branchGeneration: 2,
      state: "failed",
    }),
  ).toBe(true);
  expect(f.policy().executionState).toBe("failed");
  await expect(
    f.host.submit(f.actor, {
      ...f.input("after-failure"),
      scopeGeneration: 2,
      branchGeneration: 2,
    }),
  ).rejects.toThrow("frozen");
  expect(await f.ready("design")).toBe(false);
  expect(f.createRun).not.toHaveBeenCalled();
  await f.host.close();
});

it("async wake failure is observed, remains an error to close, and cannot masquerade as a successful notification", async () => {
  const f = fixture();
  const failure = new Error("wake database failed");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    f.loadLatestActor.mockRejectedValueOnce(failure);
    await f.host.submit(f.actor, f.input("first"));
    f.release();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    await expect(f.host.close()).rejects.toThrow("Design任务生命周期失败");
    expect(f.createRun).toHaveBeenCalledTimes(1);
    expect(f.policy().activeRunId).toBeNull();
    await f.host.close();
  } finally {
    log.mockRestore();
  }
});
it.each(["solo", "plan"] as const)(
  "active Goal preserves explicit user %s and its real tool policy",
  async (mode) => {
    const f = fixture({ activeGoal: true, planEnabled: mode === "plan" });
    try {
      await f.host.submit(f.actor, {
        ...f.input("user"),
        request: { ...f.input("user").request, executionMode: mode },
      });
      await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(1));
      expect(f.activatedModes).toEqual([mode]);
      expect(f.createRun.mock.calls[0]?.[0]).toMatchObject({
        executionMode: mode,
      });
      const policy = f.modeService.resolveToolPolicy("thread");
      expect(policy.kind).toBe(mode === "solo" ? "deny-all" : "read-only");
      expect(evaluateToolPolicy(policy, "Read").allowed).toBe(mode === "plan");
      for (const tool of [
        "Write",
        "Bash",
        "manipulate_canvas",
        "image_generate",
      ])
        expect(evaluateToolPolicy(policy, tool).allowed).toBe(false);
    } finally {
      f.release();
      await f.host.close();
    }
  },
);
it("active Goal cannot bypass explicit Plan's persisted Task policy", async () => {
  const f = fixture({ activeGoal: true });
  try {
    await f.host.submit(f.actor, {
      ...f.input("plan"),
      request: { ...f.input("plan").request, executionMode: "plan" },
    });
    await vi.waitFor(() => expect(f.settleRun).toHaveBeenCalled());
    expect(f.createRun).not.toHaveBeenCalled();
    expect(f.activatedModes).toEqual([]);
  } finally {
    f.release();
    await f.host.close();
  }
});
it("active Goal still selects Goal for user input without explicit mode", async () => {
  const f = fixture({ activeGoal: true });
  try {
    await f.host.submit(f.actor, f.input("default"));
    await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(1));
    expect(f.activatedModes).toEqual(["goal"]);
  } finally {
    f.release();
    await f.host.close();
  }
});
it("queued mode is activated only after its actual foreground claim, and Design loop remains explicit unsupported", async () => {
  const f = fixture();
  await f.host.submit(f.actor, {
    ...f.input("first"),
    request: { ...f.input("first").request, executionMode: "agent" },
  });
  await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(1));
  await f.host.submit(f.actor, {
    ...f.input("queued"),
    request: { ...f.input("queued").request, executionMode: "creative" },
  });
  expect(f.activatedModes).toEqual(["agent"]);
  await expect(
    f.host.submit(f.actor, {
      ...f.input("loop"),
      request: { ...f.input("loop").request, executionMode: "loop" },
    }),
  ).rejects.toMatchObject({ code: "design_mode_unsupported" });
  f.release();
  await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(2));
  expect(f.activatedModes).toEqual(["agent", "creative"]);
  await f.host.close();
});
