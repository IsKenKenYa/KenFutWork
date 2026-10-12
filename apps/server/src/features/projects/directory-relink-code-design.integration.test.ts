import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerProjectDirectoryRelinkRoutes } from "../../http/project-directory-relink.js";
import { createCanvasFileStore } from "../canvas/file-store.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createCheckpointRepository } from "../checkpoints/repository.js";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createDesignGoals } from "../execution/design-goals.js";
import { createTestDesignModelSelection } from "../execution/design-goals-test-fixture.js";
import { createDesignTasksService } from "../execution/design-tasks.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGoalService } from "../goals/service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import { createProjectFileRepository } from "../project-files/repository.js";
import { createProjectFileService } from "../project-files/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createProjectDirectoryRelinkService } from "./directory-relink.js";
import { createProjectRepository } from "./repository.js";

async function fixture() {
  const db = await createTaskWorkDatabase();
  const app = Fastify();
  const oldRoot = join(db.directory, "old-project"),
    nextRoot = join(db.directory, "selected-project");
  await mkdir(oldRoot);
  const internalGrant = join(oldRoot, "readonly-child"),
    externalGrant = join(db.directory, "external-grant");
  await mkdir(internalGrant);
  await mkdir(externalGrant);
  const projects = createProjectRepository(db.persistence);
  const { project, canvas } = await projects.createProject({
    instanceId: db.instanceId,
    createdByClientId: db.actor.accessClientId,
    kind: "design",
    name: "缺失项目",
    slug: randomUUID(),
    description: null,
    canvasName: "Canvas",
    workDir: oldRoot,
    additionalDirectories: [
      { path: internalGrant, access: "read-only" },
      { path: externalGrant, access: "read-write" },
    ],
  });
  if (!canvas) throw new Error("Canvas缺失");
  const tasks = createDesignTasksService({
    persistence: db.persistence,
    localInstance: db.localInstance,
  });
  const prepared = await tasks.prepareCreation(db.actor, canvas.id);
  if (!prepared) throw new Error("Task准备缺失");
  const task = await createChatRepository(db.persistence).createSession(
    db.instanceId,
    {
      canvasId: canvas.id,
      threadId: randomUUID(),
      createdByClientId: db.actor.accessClientId,
      designTaskPreparation: prepared,
    },
  );
  if (!task) throw new Error("Task缺失");
  const scopes = createExecutionScopes({
    repository: createScopeRepository(db.persistence),
    localInstance: db.localInstance,
  });
  const handle = await scopes.openTask(db.actor, task.id);
  const files = createProjectFileService({
    repository: createProjectFileRepository(db.persistence),
    localInstance: db.localInstance,
    canvases: createCanvasRepository(db.persistence),
    projects: {
      getProject: async (actor, id) => {
        const row = await projects.findActiveById(actor.instanceId, id);
        if (!row) throw new Error("项目缺失");
        return row;
      },
    },
    executionScopes: scopes,
  });
  const bytes = Buffer.from("用户选择目录中的真实原素材");
  const assetId = randomUUID(),
    version = createHash("sha256").update(bytes).digest("hex");
  await files.prepareWrite(db.actor, {
    target: { kind: "canvas", projectId: project.id, canvasId: canvas.id },
    assetId,
    relativePath: "image.png",
    mimeType: "image/png",
    writeFingerprint: version,
  });
  await files.namespaceProvider.upload(
    `${db.instanceId}/project-files/${assetId}`,
    bytes,
    { contentType: "image/png", upsert: true },
  );
  const layout = await createCanvasFileStore({ projectRoot: oldRoot }).save(
    canvas.id,
    {
      elements: [],
      appState: {},
      files: { image: { assetId, relativePath: "image.png", version } },
    },
    null,
  );
  await createCanvasRepository(db.persistence).recordFileIndex(
    db.instanceId,
    canvas.id,
  );
  const pure = createGoalService();
  const goals = createDesignGoals({
    modelSelection: createTestDesignModelSelection(),
    persistence: db.persistence,
    localInstance: db.localInstance,
    goals: pure,
    permissions: createPermissionService(),
  });
  const goal = await goals.create(db.actor, {
    taskId: task.id,
    objective: `保留目标 ${oldRoot}`,
    tokenBudget: 37,
  });
  const closed: string[] = [];
  let failClose = false;
  const service = createProjectDirectoryRelinkService({
    persistence: db.persistence,
    localInstance: db.localInstance,
    goals: pure,
    closeResources: async (_actor, id) => {
      closed.push(id);
      if (failClose) throw new Error("真实资源关闭失败");
    },
  });
  await registerProjectDirectoryRelinkRoutes(app, {
    localAccess: { authenticate: async () => db.actor },
    relink: service,
  });
  const url = `/api/projects/${project.id}/relink-directory`;
  return {
    db,
    app,
    oldRoot,
    nextRoot,
    project,
    canvas,
    tasks,
    task,
    handle,
    files,
    bytes,
    assetId,
    layout,
    goal,
    goals,
    service,
    url,
    closed,
    failClose: (value: boolean) => {
      failClose = value;
    },
    move: () => rename(oldRoot, nextRoot),
    close: async () => {
      await app.close();
      await goals.close();
      await tasks.close();
      await db.close();
    },
  };
}
describe.skipIf(process.env.KENFUTWORK_LOCAL_ROOT_PG_TEST !== "1")(
  "Project缺失目录受控重新关联真实PG",
  () => {
    it("Code根及真实Git检查点显式映射，保留Goal身份/预算与历史文字，不重放", async () => {
      const db = await createTaskWorkDatabase();
      try {
        const oldRoot = join(db.directory, "old-code"),
          nextRoot = join(db.directory, "new-code");
        await mkdir(oldRoot);
        await writeFile(join(oldRoot, "note.txt"), "历史真实字节");
        const { project } = await createProjectRepository(
          db.persistence,
        ).createProject({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          kind: "code",
          name: "Code关联",
          slug: randomUUID(),
          description: null,
          canvasName: "unused",
          workDir: oldRoot,
        });
        const taskId = randomUUID(),
          pure = createGoalService();
        const host = createCodeUiConversation({
          sessionId: taskId,
          workspacePath: oldRoot,
          config: {
            provider: "fixture",
            model: "fixture",
            thought: "",
            followupMode: "queue",
          },
        });
        const childId = randomUUID();
        host.registerChildDispatch({
          parentSessionId: taskId,
          parentRunId: randomUUID(),
          toolCallId: randomUUID(),
          childSessionId: childId,
          role: "explore",
          title: "原子目录关联子任务",
          at: Date.now(),
        });
        const state = host.exportState();
        state.goalRecord = pure.create(null, {
          goalId: randomUUID(),
          objective: `目标文字中的原路径 ${oldRoot}`,
          tokenBudget: 11,
          branchGeneration: 1,
          at: Date.now(),
        });
        await createCodeUiRepository(db.persistence).createRoot(db.instanceId, {
          sessionId: taskId,
          projectId: project.id,
          scope: {
            instanceId: db.instanceId,
            projectId: project.id,
            taskId,
            generation: 1,
            rootDirectory: oldRoot,
            additionalDirectories: [],
            sandboxMode: "workspace-write",
          },
          createdByClientId: db.actor.accessClientId,
          threadId: randomUUID(),
          state,
          command: {
            clientId: "relink-code-fixture",
            commandId: randomUUID(),
            fingerprint: "relink-code-create",
          },
        });
        const hash = (value: string) =>
          createHash("sha256").update(value).digest("hex");
        const gitDir = join(
          (await db.localInstance.getContext()).dataDir,
          "checkpoints",
          db.instanceId,
          project.id,
          `${taskId}.git`,
          hash(oldRoot),
        );
        await mkdir(gitDir, { recursive: true });
        const run = promisify(execFile);
        const git = (args: string[]) =>
          run("git", args, {
            cwd: oldRoot,
            env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: oldRoot },
          });
        await git(["init", gitDir]);
        await writeFile(join(gitDir, "excludes"), ".git\n");
        await git(["config", "core.worktree", oldRoot]);
        await git(["config", "core.excludesFile", join(gitDir, "excludes")]);
        await git(["add", "--all"]);
        await git([
          "-c",
          "user.name=Relink Regression",
          "-c",
          "user.email=relink@example.test",
          "commit",
          "-m",
          "original",
        ]);
        const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
        const checkpointId = randomUUID();
        await createCheckpointRepository(db.persistence).insert({
          id: checkpointId,
          instanceId: db.instanceId,
          taskId,
          taskKind: "code",
          projectId: project.id,
          rootDirectory: oldRoot,
          directorySnapshots: [{ rootDirectory: oldRoot, shadowCommit: sha }],
          runId: null,
          kind: "turn",
          label: "历史检查点",
          shadowCommit: sha,
          filesChanged: 1,
          insertions: 1,
          deletions: 0,
          createdAt: new Date().toISOString(),
        });
        await rename(oldRoot, nextRoot);
        const closed: string[] = [];
        const relink = createProjectDirectoryRelinkService({
          persistence: db.persistence,
          localInstance: db.localInstance,
          goals: pure,
          closeResources: async (_actor, id) => {
            closed.push(id);
          },
        });
        const snapshot = await relink.snapshot(db.actor, project.id);
        const receipt = await relink.relink(db.actor, project.id, {
          expectedWorkDir: snapshot.workDir,
          expectedTasks: snapshot.tasks,
          nextWorkDir: nextRoot,
        });
        expect(new Set(receipt.affectedTaskIds)).toEqual(
          new Set([taskId, childId]),
        );
        expect(receipt.tasks.map((task) => task.taskId)).toEqual([taskId]);
        const child = await createCodeUiRepository(db.persistence).find(
          db.instanceId,
          childId,
        );
        expect(child?.root_directory).toBe(nextRoot);
        expect(Number(child?.scope_generation)).toBe(2);
        expect(Number(child?.branch_generation)).toBe(2);
        const row = await createCodeUiRepository(db.persistence).find(
          db.instanceId,
          taskId,
        );
        expect(row).toMatchObject({
          id: taskId,
          root_directory: nextRoot,
          execution_state: "ready",
          active_run_id: null,
        });
        expect(Number(row?.scope_generation)).toBe(2);
        expect(Number(row?.branch_generation)).toBe(2);
        expect(row?.state?.goalRecord).toMatchObject({
          goalId: state.goalRecord.goalId,
          objective: state.goalRecord.objective,
          tokenBudget: 11,
          tokensUsed: 0,
          status: "paused",
        });
        expect(closed).toEqual([taskId]);
        const checkpoint = await createCheckpointRepository(
          db.persistence,
        ).getById(db.instanceId, checkpointId);
        expect(checkpoint).toMatchObject({
          id: checkpointId,
          rootDirectory: nextRoot,
          shadowCommit: sha,
          directorySnapshots: [{ rootDirectory: nextRoot, shadowCommit: sha }],
        });
        const movedGit = join(
          (await db.localInstance.getContext()).dataDir,
          "checkpoints",
          db.instanceId,
          project.id,
          `${taskId}.git`,
          hash(nextRoot),
        );
        expect(
          (await run("git", ["--git-dir", movedGit, "show", `${sha}:note.txt`]))
            .stdout,
        ).toBe("历史真实字节");
        expect(
          (
            await run("git", [
              "config",
              "--file",
              join(movedGit, "config"),
              "--get",
              "core.worktree",
            ])
          ).stdout.trim(),
        ).toBe(nextRoot);
      } finally {
        await db.close();
      }
    }, 60000);
    it("GET提供完整fences；仅missing可关联；身份与素材/布局保留，旧授权失效，Goal人工resume", async () => {
      const f = await fixture();
      try {
        expect(
          (await f.app.inject({ method: "GET", url: f.url })).statusCode,
        ).toBe(400);
        expect(f.closed).toEqual([]);
        await f.move();
        const snapshot = (
          await f.app.inject({ method: "GET", url: f.url })
        ).json();
        expect(snapshot.tasks).toEqual([
          { taskId: f.task.id, scopeGeneration: 1, branchGeneration: 1 },
        ]);
        const request = {
          expectedWorkDir: snapshot.workDir,
          nextWorkDir: f.nextRoot,
          expectedTasks: snapshot.tasks,
        };
        const stale = await f.app.inject({
          method: "POST",
          url: f.url,
          payload: { ...request, expectedTasks: [] },
        });
        expect(stale.statusCode).toBe(409);
        expect(f.closed).toEqual([]);
        const result = await f.app.inject({
          method: "POST",
          url: f.url,
          payload: request,
        });
        expect(result.statusCode).toBe(200);
        expect(result.json().affectedTaskIds).toEqual([f.task.id]);
        expect(result.json().tasks).toEqual([
          {
            taskId: f.task.id,
            scopeGeneration: 2,
            branchGeneration: 2,
            status: "ready",
          },
        ]);
        expect(f.closed).toEqual([f.task.id]);
        await expect(
          f.handle.resolvePath("image.png", "read"),
        ).rejects.toThrow();
        const policy = await f.tasks.readPolicy(f.db.actor, f.task.id);
        expect(policy).toMatchObject({
          rootDirectory: f.nextRoot,
          activeRunId: null,
          scopeGeneration: 2,
          branchGeneration: 2,
        });
        expect(policy.additionalDirectories).toEqual([
          { path: join(f.nextRoot, "readonly-child"), access: "read-only" },
          {
            path: join(f.db.directory, "external-grant"),
            access: "read-write",
          },
        ]);
        expect(await f.files.read(f.db.actor, f.assetId)).toEqual(f.bytes);
        expect(
          (
            await createCanvasFileStore({ projectRoot: f.nextRoot }).read(
              f.canvas.id,
            )
          )?.revision,
        ).toBe(f.layout.revision);
        expect(await readFile(join(f.nextRoot, "image.png"))).toEqual(f.bytes);
        expect(await f.goals.readTask(f.db.actor, f.task.id)).toMatchObject({
          goalId: f.goal.goalId,
          objective: f.goal.objective,
          tokenBudget: 37,
          tokensUsed: 0,
          status: "paused",
          branchGeneration: 2,
          iteration: 0,
        });
        expect(
          (await f.app.inject({ method: "POST", url: f.url, payload: request }))
            .statusCode,
        ).toBe(409);
      } finally {
        await f.close();
      }
    });
    it("关闭失败保留原Project/index与旧文件引用，Task闭门；刷新fences后显式重试", async () => {
      const f = await fixture();
      try {
        await f.move();
        f.failClose(true);
        const snapshot = await f.service.snapshot(f.db.actor, f.project.id);
        await expect(
          f.service.relink(f.db.actor, f.project.id, {
            expectedWorkDir: snapshot.workDir,
            nextWorkDir: f.nextRoot,
            expectedTasks: snapshot.tasks,
          }),
        ).rejects.toThrow("关闭失败");
        expect(
          (await f.tasks.readPolicy(f.db.actor, f.task.id)).executionState,
        ).toBe("failed");
        expect(
          (
            await createCanvasRepository(f.db.persistence).findById(
              f.db.instanceId,
              f.canvas.id,
            )
          )?.root_directory,
        ).toBe(f.oldRoot);
        expect(
          (
            await createProjectRepository(f.db.persistence).findActiveById(
              f.db.instanceId,
              f.project.id,
            )
          )?.work_dir,
        ).toBe(f.oldRoot);
        expect(await readFile(join(f.nextRoot, "image.png"))).toEqual(f.bytes);
        f.failClose(false);
        const retry = await f.service.snapshot(f.db.actor, f.project.id);
        expect(retry.tasks[0]?.scopeGeneration).toBe(2);
        const done = await f.service.relink(f.db.actor, f.project.id, {
          expectedWorkDir: retry.workDir,
          nextWorkDir: f.nextRoot,
          expectedTasks: retry.tasks,
        });
        expect(done.tasks[0]).toMatchObject({
          scopeGeneration: 3,
          branchGeneration: 2,
        });
      } finally {
        await f.close();
      }
    });
    it("原目录重新出现、陌生实例与正文权限注入不会换根", async () => {
      const f = await fixture();
      try {
        await f.move();
        const snapshot = await f.service.snapshot(f.db.actor, f.project.id);
        const input = {
          expectedWorkDir: snapshot.workDir,
          nextWorkDir: f.nextRoot,
          expectedTasks: snapshot.tasks,
        };
        await expect(
          f.service.snapshot(
            { ...f.db.actor, instanceId: randomUUID() },
            f.project.id,
          ),
        ).rejects.toThrow();
        expect(
          (
            await f.app.inject({
              method: "POST",
              url: f.url,
              payload: { ...input, sandboxMode: "danger-full-access" },
            })
          ).statusCode,
        ).toBe(400);
        await mkdir(f.oldRoot);
        await writeFile(join(f.oldRoot, "keep.txt"), "原目录重新出现不能替换");
        expect(
          (await f.app.inject({ method: "POST", url: f.url, payload: input }))
            .statusCode,
        ).toBe(400);
        expect(f.closed).toEqual([]);
        expect(await readFile(join(f.oldRoot, "keep.txt"), "utf8")).toBe(
          "原目录重新出现不能替换",
        );
      } finally {
        await f.close();
      }
    });
    it("stage后迟到Code子记录不能逃过撤权并进入成功receipt", async () => {
      const db = await createTaskWorkDatabase();
      try {
        const oldRoot = join(db.directory, "late-child-old"),
          nextRoot = join(db.directory, "late-child-next");
        await mkdir(oldRoot);
        const { project } = await createProjectRepository(
          db.persistence,
        ).createProject({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          kind: "code",
          name: "LateChild",
          slug: randomUUID(),
          description: null,
          canvasName: "unused",
          workDir: oldRoot,
        });
        const taskId = randomUUID();
        await createCodeUiRepository(db.persistence).createRoot(db.instanceId, {
          sessionId: taskId,
          projectId: project.id,
          scope: {
            instanceId: db.instanceId,
            projectId: project.id,
            taskId,
            generation: 1,
            rootDirectory: oldRoot,
            additionalDirectories: [],
            sandboxMode: "workspace-write",
          },
          createdByClientId: db.actor.accessClientId,
          threadId: randomUUID(),
          state: createCodeUiConversation({
            sessionId: taskId,
            workspacePath: oldRoot,
            config: {
              provider: "fixture",
              model: "fixture",
              thought: "",
              followupMode: "queue",
            },
          }).exportState(),
          command: {
            clientId: "late-child-fixture",
            commandId: randomUUID(),
            fingerprint: "late-child-create",
          },
        });
        await rename(oldRoot, nextRoot);
        const lateId = randomUUID();
        const service = createProjectDirectoryRelinkService({
          persistence: db.persistence,
          localInstance: db.localInstance,
          goals: createGoalService(),
          closeResources: async () => {
            await db.persistence
              .forInstance(db.instanceId)
              .execute(
                "insert into public.code_ui_sessions(id,instance_id,project_id,root_session_id,parent_session_id,parent_tool_call_id,root_directory,additional_directories,sandbox_mode,scope_generation,branch_generation) select $1,:instance,s.project_id,s.id,s.id,$2,s.root_directory,'[]'::jsonb,'workspace-write',1,1 from public.code_ui_sessions s where s.instance_id=:instance and s.id=$3",
                [lateId, randomUUID(), taskId],
              );
          },
        });
        const snapshot = await service.snapshot(db.actor, project.id);
        await expect(
          service.relink(db.actor, project.id, {
            expectedWorkDir: snapshot.workDir,
            expectedTasks: snapshot.tasks,
            nextWorkDir: nextRoot,
          }),
        ).rejects.toThrow("已改变");
        expect(
          (
            await createProjectRepository(db.persistence).findActiveById(
              db.instanceId,
              project.id,
            )
          )?.work_dir,
        ).toBe(oldRoot);
        expect(
          (
            await createCodeUiRepository(db.persistence).find(
              db.instanceId,
              taskId,
            )
          )?.execution_state,
        ).toBe("failed");
        expect(
          (
            await createCodeUiRepository(db.persistence).find(
              db.instanceId,
              lateId,
            )
          )?.root_directory,
        ).toBe(oldRoot);
      } finally {
        await db.close();
      }
    });
    it("资源关闭回调返回但实际foreground未结算，不得伪造退出或发布新根", async () => {
      const f = await fixture();
      try {
        const accepted = await f.tasks.admitInput(f.db.actor, {
          taskId: f.task.id,
          inputId: randomUUID(),
          runId: randomUUID(),
          scopeGeneration: 1,
          branchGeneration: 1,
          request: {
            sessionId: f.task.id,
            conversationId: f.task.id,
            preset: "design",
            prompt: "已接受且尚未真实结算",
          },
        });
        await f.move();
        const snapshot = await f.service.snapshot(f.db.actor, f.project.id);
        await expect(
          f.service.relink(f.db.actor, f.project.id, {
            expectedWorkDir: snapshot.workDir,
            expectedTasks: snapshot.tasks,
            nextWorkDir: f.nextRoot,
          }),
        ).rejects.toThrow("尚未停止");
        const policy = await f.tasks.readPolicy(f.db.actor, f.task.id);
        expect(policy).toMatchObject({
          activeRunId: accepted.runId,
          executionState: "failed",
          rootDirectory: f.oldRoot,
        });
        expect(
          (
            await createProjectRepository(f.db.persistence).findActiveById(
              f.db.instanceId,
              f.project.id,
            )
          )?.work_dir,
        ).toBe(f.oldRoot);
        expect(
          (
            await createCanvasRepository(f.db.persistence).findById(
              f.db.instanceId,
              f.canvas.id,
            )
          )?.root_directory,
        ).toBe(f.oldRoot);
      } finally {
        await f.close();
      }
    });
    it("选择空目录保留缺失素材/布局状态，不复制、扫描或丢失旧记录", async () => {
      const f = await fixture();
      try {
        const backup = join(f.db.directory, "retained-original");
        await rename(f.oldRoot, backup);
        await mkdir(f.nextRoot);
        const snapshot = await f.service.snapshot(f.db.actor, f.project.id);
        await f.service.relink(f.db.actor, f.project.id, {
          expectedWorkDir: snapshot.workDir,
          expectedTasks: snapshot.tasks,
          nextWorkDir: f.nextRoot,
        });
        await expect(f.files.read(f.db.actor, f.assetId)).rejects.toMatchObject(
          { code: "file_missing" },
        );
        expect(
          await createCanvasFileStore({ projectRoot: f.nextRoot }).read(
            f.canvas.id,
          ),
        ).toBeNull();
        expect(await readFile(join(backup, "image.png"))).toEqual(f.bytes);
        expect(
          (await f.files.inspect(f.db.actor, f.assetId)).relativePath,
        ).toBe("image.png");
        expect(
          (await f.tasks.readPolicy(f.db.actor, f.task.id)).activeRunId,
        ).toBeNull();
        expect(await f.goals.readTask(f.db.actor, f.task.id)).toMatchObject({
          goalId: f.goal.goalId,
          status: "paused",
          tokenBudget: 37,
        });
      } finally {
        await f.close();
      }
    });
  },
);
