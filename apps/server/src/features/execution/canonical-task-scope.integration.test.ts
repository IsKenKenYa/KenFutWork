import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRunRepository } from "../agent-runs/repository.js";
import type { AgentTurnBoundary } from "../agent-runs/types.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkStore } from "../task-work/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createScopeRepository } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(kind: "code" | "design" = "code") {
  const database = await createTaskWorkDatabase();
  cleanups.push(() => database.close());
  const original = database.context.scope;
  const sql = database.persistence.forInstance(database.instanceId);
  const threadId = randomUUID();
  await sql.execute(
    "insert into public.chat_sessions(id,instance_id,project_id,mode,created_by_client_id,thread_id) values($1,:instance,$2,'code',$3,$4)",
    [original.taskId, original.projectId, database.actor.accessClientId, threadId],
  );
  await sql.execute(
    "update public.code_ui_sessions set chat_session_id=$1 where instance_id=:instance and id=$1",
    [original.taskId],
  );
  await sql.execute(
    "update public.projects set kind=$2,enabled_modes=array['code','design']::text[] where instance_id=:instance and id=$1",
    [original.projectId, kind],
  );
  const scopeRepository = createScopeRepository(database.persistence);
  const handle = await createExecutionScopes({
    repository: scopeRepository,
    localInstance: database.localInstance,
  }).openTask(database.actor, original.taskId);
  const scope = handle.describe();
  const work = createTaskWorkStore(database.persistence);
  const runs = createAgentRunRepository(database.persistence);
  const runId = randomUUID();
  await runs.insert({ runId, sessionId: scope.taskId, threadId, status: "running" });
  const boundary: AgentTurnBoundary = {
    instanceId: scope.instanceId,
    projectId: scope.projectId,
    taskId: scope.taskId,
    taskKind: "code",
    runId,
    threadId,
    phase: "pre",
    scopeGeneration: scope.generation,
    branchGeneration: handle.branchGeneration,
    inputIdentity: { clientId: "fixture", sourceCommandId: randomUUID() },
    inputOrigin: "userInput",
    inputMessageId: null,
    context: { status: "unavailable", reason: "no-model-request" },
    files: { status: "unavailable", reason: "no-file-operation" },
  };
  const workContext = {
    ...database.context,
    actor: database.actor,
    scope,
    runId,
    ownerKind: "code" as const,
    branchGeneration: handle.branchGeneration,
  };
  const target = {
    instanceId: scope.instanceId,
    projectId: scope.projectId,
    taskId: scope.taskId,
    taskKind: "code" as const,
    runId,
    threadId,
  };
  return { database, original, sql, scopeRepository, handle, scope, work, runs, boundary, workContext, target };
}

describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "canonical Task项目授权与旧Design共存 integration",
  () => {
    it.each(["code", "design"] as const)(
      "%s默认项目的真实CodeUiTask保持同一身份与目录，边界和后台工作不依赖画布；跨项目/实例与旧代际拒绝",
      async (kind) => {
        const f = await fixture(kind);
        expect(f.handle.preset).toBe("code");
        expect(f.scope).toEqual(f.original);
        expect(await f.handle.resolvePath(".", "read")).toBe(f.original.rootDirectory);
        expect(await f.work.isCurrent(f.workContext)).toBe(true);
        expect(await f.runs.recordTurnBoundary(f.boundary)).toBe(true);
        expect((await f.runs.getTurnBoundaries(f.target)).pre).toEqual(f.boundary);

        const otherDirectory = join(f.database.directory, "other-project");
        await mkdir(otherDirectory);
        const { project: other } = await createProjectRepository(f.database.persistence).createProject({
          instanceId: f.scope.instanceId,
          createdByClientId: f.database.actor.accessClientId,
          kind: "code",
          name: "另一个真实项目",
          slug: randomUUID(),
          description: null,
          canvasName: "unused",
          workDir: otherDirectory,
        });
        expect(await f.runs.recordTurnBoundary({ ...f.boundary, projectId: other.id, phase: "post" })).toBe(false);
        expect(await f.runs.getTurnBoundaries({ ...f.target, projectId: other.id })).toEqual({ pre: null, post: null });
        expect(await f.scopeRepository.load(randomUUID(), f.scope.taskId)).toBeNull();
        expect(await f.runs.recordTurnBoundary({ ...f.boundary, instanceId: randomUUID(), phase: "post" })).toBe(false);
        expect(await f.runs.recordTurnBoundary({ ...f.boundary, taskKind: "design", phase: "post" })).toBe(false);

        const changed = await f.scopeRepository.beginUpdate!(f.scope, { sandboxMode: "read-only" });
        expect(changed).toMatchObject({ preset: "code", state: "revoking", scope: { generation: f.scope.generation + 1 } });
        expect(await f.work.isCurrent(f.workContext)).toBe(false);
        await expect(f.handle.resolvePath(".", "read")).rejects.toThrow();
        expect(await f.scopeRepository.finishUpdate!(changed!.scope, "ready")).toBe(true);
        expect(await f.work.isCurrent(f.workContext)).toBe(false);
        expect(await f.runs.recordTurnBoundary({ ...f.boundary, phase: "post" })).toBe(false);
        expect((await f.scopeRepository.load(f.scope.instanceId, f.scope.taskId))?.scope).toMatchObject({
          projectId: f.scope.projectId,
          taskId: f.scope.taskId,
          rootDirectory: f.original.rootDirectory,
          generation: f.scope.generation + 1,
          sandboxMode: "read-only",
        });
      },
    );

    it("Flow项目不能借用原Task、后台工作或历史边界", async () => {
      const f = await fixture();
      expect(await f.runs.recordTurnBoundary(f.boundary)).toBe(true);
      await f.sql.execute(
        "update public.projects set kind='flow',enabled_modes=array['flow']::text[] where instance_id=:instance and id=$1",
        [f.scope.projectId],
      );
      expect(await f.scopeRepository.load(f.scope.instanceId, f.scope.taskId)).toBeNull();
      expect(await f.work.isCurrent(f.workContext)).toBe(false);
      expect(await f.runs.recordTurnBoundary({ ...f.boundary, phase: "post" })).toBe(false);
      expect(await f.runs.getTurnBoundaries(f.target)).toEqual({ pre: null, post: null });
      expect(await f.scopeRepository.beginUpdate!(f.scope, { sandboxMode: "read-only" })).toBeNull();
    });
  },
);
