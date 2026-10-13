import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createJobRepository } from "../jobs/repository.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";

it("来源prepare之后撤权，真实insert事务复验旧代际并拒绝落库", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return { rowCount: 0, rows: [] };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("unused");
    },
    end: async () => {},
  };
  const instanceId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    sessionId = randomUUID();
  await expect(
    createJobRepository(createPersistenceFromRunner(runner)).insert({
      instanceId,
      projectId,
      sessionId,
      jobType: "image_generation",
      queueName: "image_generation_jobs",
      createdByClientId: null,
      payload: {},
      fileTarget: {
        kind: "task",
        taskId,
        projectId,
        sessionId,
        scopeGeneration: 7,
        branchGeneration: 3,
      },
    }),
  ).rejects.toThrow("原Run授权");
  const guard = calls.find((call) =>
    call.sql.includes("public.code_ui_sessions"),
  );
  expect(guard?.sql).toContain("for share");
  expect(guard?.values).toEqual([taskId, projectId, 7, 3, instanceId]);
  expect(
    calls.some((call) =>
      call.sql.includes("insert into public.background_jobs"),
    ),
  ).toBe(false);
});

it("画布来源锁通过Project父链约束实例，不能跨实例借用canvas", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return sql.includes("public.canvases")
      ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [{ id: "owned-project" }] };
  };
  const runner: PostgresQueryRunner = {
    query,
    acquire: async () => ({ query, release() {} }),
    acquireSession: async () => {
      throw new Error("unused");
    },
    end: async () => {},
  };
  const instanceId = randomUUID(),
    projectId = randomUUID(),
    canvasId = randomUUID();
  await expect(
    createJobRepository(createPersistenceFromRunner(runner)).insert({
      instanceId,
      projectId,
      canvasId,
      jobType: "image_generation",
      queueName: "image_generation_jobs",
      createdByClientId: null,
      payload: {},
      fileTarget: { kind: "project", projectId, sessionId: null, canvasId },
    }),
  ).rejects.toThrow("原画布");
  const guard = calls.find((call) => call.sql.includes("public.canvases"));
  expect(guard?.sql).toContain("join public.projects");
  expect(guard?.sql).toContain("p.instance_id=");
  expect(guard?.values).toEqual([canvasId, projectId, instanceId]);
  expect(
    calls.some((call) =>
      call.sql.includes("insert into public.background_jobs"),
    ),
  ).toBe(false);
});
