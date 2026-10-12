import { expect, it, vi } from "vitest";
import type { DesignRunHost } from "../execution/design-run-host-types.js";
import type {
  ExecutionScopeHandle,
  ExecutionScopes,
} from "../execution/scope-service.js";
import { createDesignTaskRestore } from "./design-task-restore.js";

const actor = { instanceId: "instance", accessClientId: "client" };
const identity = {
  instanceId: "instance",
  projectId: "project",
  taskId: "task",
  generation: 4,
};

function fixture() {
  const host = {
    beginRestore: vi.fn(async () => ({
      taskId: "task",
      projectId: "project",
      operationId: "operation",
      scopeGeneration: 5,
      branchGeneration: 8,
      scope: { ...identity, generation: 5 },
      activeRunId: null,
    })),
    finishRestore: vi.fn(async () => true),
  };
  const restoring = {
    preset: "design",
    branchGeneration: 8,
    describe: () => ({ ...identity, generation: 5 }),
  } as unknown as ExecutionScopeHandle;
  const executionScopes = {
    openRestoringTask: vi.fn(async () => restoring),
  } as unknown as ExecutionScopes;
  const scope = {
    preset: "design",
    branchGeneration: 7,
    describe: () => identity,
  } as unknown as ExecutionScopeHandle;
  return {
    adapter: createDesignTaskRestore({
      host: host as unknown as DesignRunHost,
      executionScopes,
    }),
    host,
    restoring,
    executionScopes,
    scope,
  };
}

it("starts and finishes restore through the Design host lease", async () => {
  const f = fixture();
  const restoring = await f.adapter.begin(f.scope, actor);
  expect(restoring).toBe(f.restoring);
  expect(f.host.beginRestore).toHaveBeenCalledWith(actor, {
    taskId: "task",
    expectedScopeGeneration: 4,
    expectedBranchGeneration: 7,
  });

  await f.adapter.finish(restoring, actor, true);
  expect(f.host.finishRestore).toHaveBeenCalledWith(actor, {
    taskId: "task",
    operationId: "operation",
    scopeGeneration: 5,
    branchGeneration: 8,
    state: "ready",
  });
});

it("settles a failed lease when the restored scope does not match", async () => {
  const f = fixture();
  const badScope = {
    ...f.restoring,
    describe: () => ({ ...identity, projectId: "other", generation: 5 }),
  } as ExecutionScopeHandle;
  vi.mocked(f.executionScopes.openRestoringTask).mockResolvedValue(badScope);

  await expect(f.adapter.begin(f.scope, actor)).rejects.toThrow(
    "恢复工作域与 Design Task 不匹配",
  );
  expect(f.host.finishRestore).toHaveBeenCalledWith(actor, {
    taskId: "task",
    operationId: "operation",
    scopeGeneration: 5,
    branchGeneration: 8,
    state: "failed",
  });
});
