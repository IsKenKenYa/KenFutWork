import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { backgroundJobSchema } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createJobService } from "../jobs/job-service.js";
import { createJobRepository } from "../jobs/repository.js";
import { createProjectService } from "../projects/project-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createGenerationTargets } from "./file-targets.js";

describe.skipIf(process.env.KENFUTWORK_GENERATION_FILES_TEST_PG !== "1")(
  "生成来源真实数据库边界",
  () => {
    it("Design生成使用项目固定目录，普通更新拒绝换根，撤权阻止接纳和发布", async () => {
      const db = await createTaskWorkDatabase();
      try {
        const { project } = await createProjectRepository(
          db.persistence,
        ).createProject({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          kind: "design",
          name: "generation",
          slug: randomUUID(),
          canvasName: "generation",
          description: null,
          workDir: db.context.scope.rootDirectory,
          // 夹具库已用同一目录建隔离项目；按现行目录契约显式独立创建。
          directoryChoice: "independent",
        });
        await db.persistence
          .forInstance(db.instanceId)
          .execute(
            "update public.projects set enabled_modes=array['design','code']::text[] where id=$1 and instance_id=:instance",
            [project.id],
          );
        const canvas = await createCanvasRepository(db.persistence).create({
          instanceId: db.instanceId,
          projectId: project.id,
          canvasId: randomUUID(),
          name: "generation",
        });
        if (!canvas) throw new Error("缺少画布");
        const session = { id: randomUUID() };
        const runId = randomUUID();
        const host = createCodeUiConversation({
          sessionId: session.id,
          workspacePath: db.context.scope.rootDirectory,
          config: {
            provider: "zcode",
            model: "test",
            thought: "",
            followupMode: "queue",
          },
          workContext: { preset: "design", canvasId: canvas.id },
        });
        host.startTurn({
          runId,
          commandId: randomUUID(),
          text: "实际生成",
          workContext: { preset: "design", canvasId: canvas.id },
        });
        await createCodeUiRepository(db.persistence).createRoot(db.instanceId, {
          sessionId: session.id,
          projectId: project.id,
          scope: {
            ...db.context.scope,
            projectId: project.id,
            taskId: session.id,
          },
          createdByClientId: db.actor.accessClientId,
          threadId: randomUUID(),
          state: host.exportState(),
          command: {
            clientId: "fixture",
            commandId: randomUUID(),
            fingerprint: randomUUID(),
          },
        });
        const scopes = createExecutionScopes({
          repository: createScopeRepository(db.persistence),
          localInstance: db.localInstance,
        });
        // 现行 updateTask 契约要求至少注册一个撤销监听才允许改授权。
        scopes.onRevoke(async () => {});
        const targets = createGenerationTargets({
          persistence: db.persistence,
          executionScopes: scopes,
        });
        const source = await targets.prepareOrigin({
          actor: db.actor,
          runId,
          sessionId: session.id,
          canvasId: canvas.id,
          projectId: project.id,
          expectedScopeGeneration: 1,
          expectedBranchGeneration: 1,
        });
        expect(source).toMatchObject({
          kind: "task",
          taskId: session.id,
          canvasId: canvas.id,
        });
        const repo = createJobRepository(db.persistence);
        const input = {
          instanceId: db.instanceId,
          projectId: project.id,
          sessionId: session.id,
          canvasId: canvas.id,
          jobType: "image_generation" as const,
          queueName: "image_generation_jobs" as const,
          createdByClientId: db.actor.accessClientId,
          payload: {},
          fileTarget: source,
        };
        const created = await repo.insert(input);
        if (!created) throw new Error("未接纳生成任务");
        const nextDirectory = `${db.directory}/another-project-directory`;
        await mkdir(nextDirectory);
        const projects = createProjectService({
          repository: createProjectRepository(db.persistence),
          localInstance: db.localInstance,
          blob: createLocalFsBlobStore({
            rootDir: `${db.directory}/blob`,
            signingSecret: "generation-test-signature",
            publicBaseUrl: "http://localhost/api/blobs",
          }),
        });
        await expect(
          projects.updateProject(db.actor, project.id, {
            work_dir: nextDirectory,
          }),
        ).rejects.toThrow("项目目录固定");
        expect((await projects.getProject(db.actor, project.id)).work_dir).toBe(
          db.context.scope.rootDirectory,
        );
        expect(
          (await scopes.openTask(db.actor, session.id)).describe()
            .rootDirectory,
        ).toBe(db.context.scope.rootDirectory);
        const frozenJob = backgroundJobSchema.parse(created);
        expect(await targets.resolve(frozenJob)).toEqual({
          kind: "task",
          taskId: session.id,
        });
        await scopes.updateTask(db.actor, session.id, {
          sandboxMode: "read-only",
        });
        await expect(targets.resolve(frozenJob)).rejects.toThrow("原Run授权");
        await expect(repo.insert(input)).rejects.toThrow("原Run授权");
      } finally {
        await db.close();
      }
    });
    it("项目删除使关联SET NULL，持久来源仍在且不能变成standalone", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = database.context.scope.instanceId;
        const projectId = randomUUID();
        const scoped = database.persistence.forInstance(instanceId);
        await scoped.execute(
          "insert into public.projects (id, instance_id, name, slug, kind, additional_directories) values ($1, :instance, 'generation-source', $2, 'design', '[]'::jsonb)",
          [projectId, `generation-${projectId}`],
        );
        const repository = createJobRepository(database.persistence);
        const created = await repository.insert({
          instanceId,
          projectId,
          jobType: "image_generation",
          queueName: "image_generation_jobs",
          createdByClientId: null,
          payload: {},
          fileTarget: {
            kind: "project",
            projectId,
            sessionId: null,
            canvasId: null,
          },
        });
        expect(created?.file_target).toEqual({
          kind: "project",
          projectId,
          sessionId: null,
          canvasId: null,
        });
        await scoped.execute(
          "delete from public.projects where instance_id=:instance and id=$1",
          [projectId],
        );
        const row = await repository.findByIdInInstance(
          instanceId,
          created!.id,
        );
        expect(row?.project_id).toBeNull();
        expect(row?.file_target?.kind).toBe("project");
        const service = createJobService({ repository, queue: {} as never });
        const job = await service.getJobForWorker(created!.id);
        const targets = createGenerationTargets({
          persistence: database.persistence,
          executionScopes: {} as never,
        });
        await expect(targets.resolve(job)).rejects.toThrow("项目不存在");
      } finally {
        await database.close();
      }
    });
    it("来源准备后Task授权改变，真实INSERT事务拒绝旧Run代际", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const scope = database.context.scope;
        const scoped = database.persistence.forInstance(scope.instanceId);
        await scoped.execute(
          "update public.code_ui_sessions set scope_generation=scope_generation+1 where instance_id=:instance and id=$1",
          [scope.taskId],
        );
        const repository = createJobRepository(database.persistence);
        await expect(
          repository.insert({
            instanceId: scope.instanceId,
            projectId: scope.projectId,
            sessionId: scope.taskId,
            jobType: "image_generation",
            queueName: "image_generation_jobs",
            createdByClientId: null,
            payload: {},
            fileTarget: {
              kind: "task",
              taskId: scope.taskId,
              projectId: scope.projectId,
              sessionId: scope.taskId,
              scopeGeneration: scope.generation,
              branchGeneration: 1,
            },
          }),
        ).rejects.toThrow("原Run授权");
        expect(
          await repository.listForInstance(scope.instanceId, {}),
        ).toHaveLength(0);
      } finally {
        await database.close();
      }
    });
  },
);
