import { randomUUID } from "node:crypto";
import { backgroundJobSchema } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import type { ExecutionScopes } from "../execution/scope-service.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createGenerationTargets } from "./file-targets.js";

const instanceId = randomUUID(),
  projectId = randomUUID(),
  taskId = randomUUID(),
  sessionId = randomUUID();
const canvasId = randomUUID();
function fixture(
  options: {
    kind?: "design" | "code";
    missingSession?: boolean;
    sharedProject?: boolean;
    deletedCanvas?: boolean;
    runOutcome?: "active" | "completed" | "canceled" | "failed" | "unknown";
    missingProject?: boolean;
    generation?: number;
    readonly?: boolean;
    missingTask?: boolean;
    branchGeneration?: number;
  } = {},
) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    const row = sql.includes("public.chat_sessions c")
      ? options.missingSession
        ? null
        : {
            project_id: projectId,
            mode: options.kind ?? "design",
            kind: options.kind ?? "design",
            enabled_modes: options.sharedProject
              ? ["code", "design"]
              : [options.kind ?? "design"],
          }
      : sql.includes("code_ui_sessions child")
        ? options.missingTask
          ? null
          : {
              id: taskId,
              project_id: projectId,
              root_directory: "/fixed/task",
              scope_generation: options.generation ?? 1,
              branch_generation: options.branchGeneration ?? 2,
              state: {
                closedRuns: [],
                snapshots:
                  options.runOutcome === "unknown"
                    ? []
                    : [
                        {
                          control: {
                            phase: "running",
                            activeWorks: [{ foregroundExecutionId: "run-1" }],
                          },
                        },
                      ],
                runOutcomes:
                  options.runOutcome &&
                  options.runOutcome !== "active" &&
                  options.runOutcome !== "unknown"
                    ? [["run-1", options.runOutcome]]
                    : [],
              },
            }
        : sql.includes("public.canvases c")
          ? options.deletedCanvas || values[0] !== canvasId
            ? null
            : {
                id: canvasId,
                project_id: projectId,
                kind: options.kind ?? "design",
                enabled_modes: options.sharedProject
                  ? ["code", "design"]
                  : [options.kind ?? "design"],
              }
          : options.missingProject
            ? null
            : {
                project_id: projectId,
                kind: options.kind ?? "design",
                enabled_modes: options.sharedProject
                  ? ["code", "design"]
                  : [options.kind ?? "design"],
              };
    return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("unused");
    },
    end: async () => {},
  };
  const resolvePath = vi.fn(async () => "/fixed/task");
  const openTask = vi.fn(async () => ({
    preset: "code",
    branchGeneration: options.branchGeneration ?? 2,
    resolvePath,
    describe: () => ({
      instanceId,
      projectId,
      taskId,
      rootDirectory: "/fixed/task",
      sandboxMode: options.readonly ? "read-only" : "workspace-write",
      generation: options.generation ?? 1,
    }),
  }));
  const service = createGenerationTargets({
    persistence: createPersistenceFromRunner(runner),
    executionScopes: { openTask } as unknown as Pick<
      ExecutionScopes,
      "openTask"
    >,
  });
  return { service, calls, openTask, resolvePath };
}
function job(file_target: unknown) {
  return backgroundJobSchema.parse({
    id: randomUUID(),
    instance_id: instanceId,
    project_id: null,
    session_id: null,
    canvas_id: null,
    thread_id: null,
    file_target,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "running",
    payload: {},
    result: null,
    error_code: null,
    error_message: null,
    provider_job_id: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by_client_id: null,
    created_at: "now",
    updated_at: "now",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  });
}
it("只有可信新创建的显式standalone来源可返回独立目标，旧空来源拒绝", async () => {
  const { service } = fixture();
  expect(
    await service.prepareOrigin({
      runId: "run-1",
      actor: { instanceId, accessClientId: null },
    }),
  ).toEqual({ kind: "standalone" });
  expect(await service.resolve(job({ kind: "standalone" }))).toBeNull();
  await expect(service.resolve(job(null))).rejects.toThrow("来源");
  await expect(
    service.resolve({ ...job({ kind: "standalone" }), project_id: projectId }),
  ).rejects.toThrow("不能退回");
});
it("删除后SET NULL仍按冻结原会话和项目复验，不伪造standalone", async () => {
  const source = { kind: "project", projectId, sessionId, canvasId: null };
  await expect(
    fixture({ missingSession: true }).service.resolve(job(source)),
  ).rejects.toThrow("归属");
  await expect(
    fixture({ missingProject: true }).service.resolve(
      job({ ...source, sessionId: null }),
    ),
  ).rejects.toThrow("项目");
  expect(
    await fixture().service.resolve(job({ ...source, sessionId: null })),
  ).toEqual({
    kind: "project",
    projectId,
  });
});
it("无会话Design实际Canvas来源发布为Canvas target，不猜Task或只取Project目录", async () => {
  const current = fixture({ kind: "design" });
  const source = await current.service.prepareOrigin({
    runId: "run-1",
    actor: { instanceId, accessClientId: randomUUID() },
    projectId,
    canvasId,
    interactiveRequest: true,
  });
  expect(source).toMatchObject({ kind: "project", projectId, canvasId });
  expect(await current.service.resolve(job(source))).toEqual({
    kind: "canvas",
    projectId,
    canvasId,
  });
  expect(current.openTask).not.toHaveBeenCalled();
});
it("Code来源必须来自真实Task固定root与原Run代际，不借当前代际续权", async () => {
  const actor = { instanceId, accessClientId: null };
  const current = fixture({ kind: "code" });
  const source = await current.service.prepareOrigin({
    runId: "run-1",
    actor,
    projectId,
    sessionId,
    expectedScopeGeneration: 1,
    expectedBranchGeneration: 2,
  });
  expect(source).toEqual({
    kind: "task",
    taskId,
    projectId,
    sessionId,
    scopeGeneration: 1,
    branchGeneration: 2,
    originRunId: "run-1",
  });
  expect(await current.service.resolve(job(source))).toEqual({
    kind: "task",
    taskId,
  });
  await expect(
    fixture({ kind: "code", generation: 2 }).service.prepareOrigin({
      runId: "run-1",
      actor,
      projectId,
      sessionId,
      expectedScopeGeneration: 1,
      expectedBranchGeneration: 2,
    }),
  ).rejects.toThrow("原Run授权");
  await expect(
    current.service.prepareOrigin({
      runId: "run-1",
      actor,
      projectId,
      sessionId,
    }),
  ).rejects.toThrow("原Run授权");
  await expect(
    current.service.prepareOrigin({
      runId: "run-1",
      actor,
      projectId,
      sessionId,
      canvasId: randomUUID(),
      expectedScopeGeneration: 1,
      expectedBranchGeneration: 2,
    }),
  ).rejects.toThrow();
  expect(current.calls.every((call) => call.values.includes(instanceId))).toBe(
    true,
  );
});

it("只读Code目录在生成调用前拒绝文件来源，不先花费再写失败", async () => {
  await expect(
    fixture({ kind: "code", readonly: true }).service.prepareOrigin({
      runId: "run-1",
      actor: { instanceId, accessClientId: null },
      projectId,
      sessionId,
      expectedScopeGeneration: 1,
      expectedBranchGeneration: 2,
    }),
  ).rejects.toThrow("目录只读");
});

it("仅显式鉴权HTTP来源可使用当前授权，Agent缺原代际仍拒绝", async () => {
  const current = fixture({ kind: "code", generation: 3 });
  const actor = { instanceId, accessClientId: randomUUID() };
  expect(
    await current.service.prepareOrigin({
      runId: "run-1",
      actor,
      projectId,
      sessionId,
      interactiveRequest: true,
    }),
  ).toMatchObject({ scopeGeneration: 3, branchGeneration: 2 });
  expect(current.resolvePath).toHaveBeenCalledWith(".", "write");
  await expect(
    current.service.prepareOrigin({
      runId: "run-1",
      actor: { instanceId, accessClientId: null },
      projectId,
      sessionId,
      interactiveRequest: true,
    }),
  ).rejects.toThrow("已授权");
  await expect(
    current.service.prepareOrigin({
      runId: "run-1",
      actor,
      projectId,
      sessionId,
    }),
  ).rejects.toThrow("原Run授权");
});

it("Design生成冻结真实Task目录和画布，发布时拒绝撤权或代际变化", async () => {
  const input = {
    runId: "run-1",
    actor: { instanceId, accessClientId: randomUUID() },
    sessionId,
    canvasId,
    projectId,
    expectedScopeGeneration: 1,
    expectedBranchGeneration: 2,
  };
  const current = fixture({ kind: "design" });
  const source = await current.service.prepareOrigin(input);
  expect(source).toEqual({
    kind: "task",
    taskId,
    projectId,
    sessionId,
    canvasId,
    scopeGeneration: 1,
    branchGeneration: 2,
    originRunId: "run-1",
  });
  expect(current.openTask).toHaveBeenCalledWith(input.actor, taskId);
  const frozen = {
    ...job(source),
    project_id: projectId,
    session_id: sessionId,
    canvas_id: canvasId,
  };
  expect(await current.service.resolve(frozen)).toEqual({
    kind: "task",
    taskId,
  });
  await expect(
    fixture({ kind: "design", generation: 2 }).service.resolve(frozen),
  ).rejects.toThrow("原Run授权");
  await expect(
    fixture({ kind: "design", branchGeneration: 3 }).service.resolve(frozen),
  ).rejects.toThrow("原Run授权");
  await expect(
    fixture({ kind: "design", missingTask: true }).service.resolve(frozen),
  ).rejects.toThrow("工作域不存在");
  await expect(
    fixture({ kind: "design", readonly: true }).service.prepareOrigin(input),
  ).rejects.toThrow("只读");
  await expect(
    current.service.resolve({ ...frozen, canvas_id: randomUUID() }),
  ).rejects.toThrow("来源不一致");
});

it("共享项目的Code来源可显式选画布，文件成果仍绑定同一个真实Task", async () => {
  const f = fixture({ kind: "code", sharedProject: true });
  const target = await f.service.prepareOrigin({
    runId: "run-1",
    actor: { instanceId, accessClientId: null },
    projectId,
    sessionId,
    canvasId,
    expectedScopeGeneration: 1,
    expectedBranchGeneration: 2,
  });
  expect(target).toEqual({
    kind: "task",
    taskId,
    projectId,
    sessionId,
    canvasId,
    scopeGeneration: 1,
    branchGeneration: 2,
    originRunId: "run-1",
  });
  expect(await f.service.resolve(job(target))).toEqual({
    kind: "task",
    taskId,
  });
  expect(f.openTask).toHaveBeenCalledWith(expect.anything(), taskId);
  expect(
    f.calls.some((entry) => entry.sql.includes("design_task_executions")),
  ).toBe(false);
});

it("文档软删除后迟到Job不能改用项目目录或当前画布", async () => {
  const f = fixture({ kind: "code", sharedProject: true });
  const target = await f.service.prepareOrigin({
    runId: "run-1",
    actor: { instanceId, accessClientId: null },
    projectId,
    sessionId,
    canvasId,
    expectedScopeGeneration: 1,
    expectedBranchGeneration: 2,
  });
  await expect(
    fixture({
      kind: "code",
      sharedProject: true,
      deletedCanvas: true,
    }).service.resolve(job(target)),
  ).rejects.toThrow("画布已删除");
});

it("正常完成的原Run允许迟到成果，取消、失败与未知原Run均拒绝", async () => {
  const f = fixture({ kind: "code", sharedProject: true });
  const target = await f.service.prepareOrigin({
    runId: "run-1",
    actor: { instanceId, accessClientId: null },
    projectId,
    sessionId,
    canvasId,
    expectedScopeGeneration: 1,
    expectedBranchGeneration: 2,
  });
  expect(
    await fixture({
      kind: "code",
      sharedProject: true,
      runOutcome: "completed",
    }).service.resolve(job(target)),
  ).toEqual({ kind: "task", taskId });
  for (const runOutcome of ["canceled", "failed", "unknown"] as const)
    await expect(
      fixture({
        kind: "code",
        sharedProject: true,
        runOutcome,
      }).service.resolve(job(target)),
    ).rejects.toThrow("原Run已停止");
});
