import { describe, expect, it, vi } from "vitest";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { PersistenceService } from "../persistence/types.js";
import { createDesignTasksService } from "./design-tasks.js";

vi.mock("./design-task-lease.js", () => ({
  createDesignTaskLeases: () => ({
    ownerId: "test-owner",
    withTask: async (
      _instance: string,
      _task: string,
      fn: () => Promise<unknown>,
    ) => fn(),
    acquire: async () => true,
    release: async () => {},
    close: async () => {},
    onLost: () => () => {},
  }),
}));
const actor = { instanceId: "instance", accessClientId: "client" };
const task = {
  task_id: "task",
  canvas_id: "canvas",
  runtime_owner_id: "test-owner",
  project_id: "project",
  root_directory: "/project",
  additional_directories: [],
  sandbox_mode: "workspace-write",
  scope_generation: 1,
  branch_generation: 1,
  permission_mode: "build",
  plan_enabled: false,
  planning_epoch: 0,
  active_run_id: null,
  execution_state: "ready",
  run_state: "idle",
  next_input_seq: 1,
};
function fixture(
  rows: unknown[],
  projectState: "open" | "closing" | "failed" = "open",
) {
  const taskRows = rows.filter(
    (row) => row !== null && typeof row === "object" && "task_id" in row,
  );
  const inputRows = rows.filter(
    (row) => row === null || typeof row !== "object" || !("task_id" in row),
  );
  const queryOne = vi.fn(async (text: string, _params?: readonly unknown[]) => {
    if (text.includes("select p.id from public.projects"))
      return projectState === "open" ? { id: task.project_id } : null;
    if (
      text.includes(
        "select d.*, c.canvas_id from public.design_task_executions",
      )
    )
      return taskRows.shift() ?? null;
    if (text.includes("public.design_task_inputs"))
      return inputRows.shift() ?? null;
    throw new Error(`Design Task fixture未登记SQL：${text}`);
  });
  const execute = vi.fn(
    async (_sql: string, _params?: readonly unknown[]) => 1,
  );
  const sql = {
    instanceId: actor.instanceId,
    queryOne,
    execute,
    query: vi.fn(),
  };
  const persistence = {
    forInstance: () => sql,
    transaction: async (
      fn: (tx: { forInstance(): typeof sql }) => Promise<unknown>,
    ) => fn({ forInstance: () => sql }),
  } as unknown as PersistenceService;
  const localInstance = {
    resolve: vi.fn(async () => ({ instanceId: actor.instanceId })),
    beginAdmission: () => () => {},
  } as unknown as LocalInstanceService;
  return {
    service: createDesignTasksService({
      persistence,
      localInstance,
      sandboxRoot: "/tmp",
    }),
    queryOne,
    execute,
  };
}
const input = {
  taskId: "task",
  inputId: "input",
  runId: "run",
  scopeGeneration: 1,
  branchGeneration: 1,
  request: {
    sessionId: "task",
    conversationId: "conversation",
    prompt: "hello",
    accessToken: "private",
    preset: "design" as const,
  },
};

describe("Design Task durable admission", () => {
  it.each(["closing", "failed"] as const)(
    "closed project %s blocks new Run/restore/claim before Task mutation",
    async (state) => {
      const f = fixture([task], state);
      await expect(f.service.admitInput(actor, input)).rejects.toMatchObject({
        code: "design_task_unavailable",
      });
      await expect(
        f.service.beginRestore(actor, {
          taskId: "task",
          expectedScopeGeneration: 1,
          expectedBranchGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: "design_task_unavailable" });
      expect(await f.service.claimNextInput(actor, "task")).toBeNull();
      expect(f.execute).not.toHaveBeenCalled();
      expect(
        f.queryOne.mock.calls.every(
          ([sql]) =>
            sql.includes("p.archive_state='open'") &&
            sql.includes("for share of p"),
        ),
      ).toBe(true);
    },
  );
  it("stores only parsed request fields and never access credentials", async () => {
    const f = fixture([
      task,
      null,
      null,
      {
        input_id: "input",
        run_id: "run",
        admission_seq: 1,
        request: { prompt: "hello" },
      },
    ]);
    const result = await f.service.admitInput(actor, input);
    expect(result.kind).toBe("running");
    const inserted = f.queryOne.mock.calls.find(([sql]) =>
      String(sql).includes("insert into public.design_task_inputs"),
    );
    expect(JSON.parse(String(inserted?.[1]?.[6]))).toEqual({
      sessionId: "task",
      conversationId: "conversation",
      prompt: "hello",
      preset: "design",
    });
    expect(JSON.stringify(f.queryOne.mock.calls)).not.toContain("private");
  });
  it("rejects stale authorization before enqueue", async () => {
    const f = fixture([{ ...task, scope_generation: 2 }, null]);
    await expect(f.service.admitInput(actor, input)).rejects.toThrow(
      "权限已变更",
    );
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("queues behind existing FIFO even if the current lease is free", async () => {
    const f = fixture([
      task,
      null,
      { input_id: "older" },
      { input_id: "input", run_id: "run", admission_seq: 1, request: {} },
    ]);
    expect((await f.service.admitInput(actor, input)).kind).toBe("queued");
    expect(f.execute.mock.calls[0]?.[1]).toEqual(["task", false, "run"]);
  });
  it("late stop cannot cancel a newer Run or its queued input", async () => {
    const f = fixture([
      { ...task, active_run_id: "newer", run_state: "running" },
    ]);
    expect(
      await f.service.requestStop(actor, {
        taskId: "task",
        expectedRunId: "old",
      }),
    ).toEqual({ kind: "targetChanged" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("stop keeps the lease until its matching terminal arrives", async () => {
    const f = fixture([
      { ...task, active_run_id: "run", run_state: "running" },
    ]);
    expect(
      await f.service.requestStop(actor, {
        taskId: "task",
        expectedRunId: "run",
      }),
    ).toEqual({ kind: "stopping", runId: "run" });
    expect(f.execute.mock.calls[1]?.[0]).toContain("run_state='stopping'");
    expect(f.execute.mock.calls[1]?.[0]).not.toContain("active_run_id=null");
  });
  it("late terminal cannot release a newer lease", async () => {
    const f = fixture([
      { ...task, active_run_id: "newer", run_state: "running" },
    ]);
    expect(
      await f.service.settleRun(actor, {
        taskId: "task",
        runId: "old",
        outcome: "completed",
      }),
    ).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("does not claim queued inputs during revocation", async () => {
    const f = fixture([{ ...task, execution_state: "revoking" }]);
    expect(await f.service.claimNextInput(actor, "task")).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });
});
