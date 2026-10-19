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
import { createCheckpointRepository } from "../checkpoints/repository.js";
import { shadowRepositoryPath } from "../checkpoints/shadow-repo-path.js";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createUnifiedDesignTaskFixture } from "../code-ui/unified-task-test-fixture.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGoalService } from "../goals/service.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
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
  const canonical = await createUnifiedDesignTaskFixture(db, {
    root: oldRoot,
    name: "缺失项目",
    budget: 37,
    additionalDirectories: [
      { path: internalGrant, access: "read-only" },
      { path: externalGrant, access: "read-write" },
    ],
  });
  const { project, canvas, task, goal } = canonical;
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
  const closed: string[] = [];
  let failClose = false;
  let beforeClose: (() => Promise<void>) | undefined;
  const service = createProjectDirectoryRelinkService({
    persistence: db.persistence,
    localInstance: db.localInstance,
    goals: pure,
    closeResources: async (_actor, id) => {
      closed.push(id);
      await beforeClose?.();
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
    task,
    readTask: canonical.readTask,
    readGoal: canonical.readGoal,
    admit: canonical.admit,
    handle,
    files,
    bytes,
    assetId,
    layout,
    goal,
    service,
    url,
    closed,
    failClose: (value: boolean) => {
      failClose = value;
    },
    beforeClose: (callback: () => Promise<void>) => {
      beforeClose = callback;
    },
    move: () => rename(oldRoot, nextRoot),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
describe.skipIf(process.env.KENFUTWORK_LOCAL_ROOT_PG_TEST !== "1")(
  "Project缺失目录受控重新关联真实PG",
  () => {
    it("恢复到已有项目目录须明确共用；拒绝前不关闭Task，不改scope代际或项目身份", async () => {
      const f = await fixture();
      try {
        await f.move();
        const projects = createProjectRepository(f.db.persistence);
        const { project: existing } = await projects.createProject({
          instanceId: f.db.instanceId,
          createdByClientId: f.db.actor.accessClientId,
          name: "已有项目",
          slug: randomUUID(),
          kind: "code",
          workDir: f.nextRoot,
          description: null,
          canvasName: "unused",
        });
        const snapshot = await f.service.snapshot(f.db.actor, f.project.id);
        const input = {
          expectedWorkDir: snapshot.workDir,
          nextWorkDir: f.nextRoot,
          expectedTasks: snapshot.tasks,
        };
        const denied = await f.app.inject({
          method: "POST",
          url: f.url,
          payload: input,
        });
        expect(denied.statusCode).toBe(409);
        expect(denied.json().error.code).toBe("project_directory_conflict");
        expect(f.closed).toEqual([]);
        expect(await f.service.snapshot(f.db.actor, f.project.id)).toEqual(
          snapshot,
        );
        expect((await f.readTask()).executionState).toBe("ready");
        const confirmed = await f.app.inject({
          method: "POST",
          url: f.url,
          payload: { ...input, directoryChoice: "independent" },
        });
        expect(confirmed.statusCode).toBe(200);
        expect(confirmed.json().projectId).toBe(f.project.id);
        const shared = await projects.findDirectoryProjects(
          f.db.instanceId,
          f.nextRoot,
        );
        expect(new Set(shared.map((project) => project.id))).toEqual(
          new Set([f.project.id, existing.id]),
        );
        expect(
          (await projects.findActiveById(f.db.instanceId, existing.id))
            ?.enabled_modes,
        ).toEqual(["code"]);
      } finally {
        await f.close();
      }
    });
    it("恢复发布前持有创建共用的目录锁；等待者不占单连接普通池，发布后重新检查真实归属", async () => {
      const f = await fixture();
      const other = createPostgresPersistence({
        databaseUrl: f.db.connectionString,
        maxConnections: 1,
      });
      let releaseClose!: () => void;
      let enteredClose!: () => void;
      const closing = new Promise<void>((resolve) => {
        enteredClose = resolve;
      });
      const continueClose = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      let relinking: Promise<unknown> | undefined;
      let creating: Promise<unknown> | undefined;
      try {
        await f.move();
        f.beforeClose(async () => {
          enteredClose();
          await continueClose;
        });
        const snapshot = await f.service.snapshot(f.db.actor, f.project.id);
        relinking = f.service.relink(f.db.actor, f.project.id, {
          expectedWorkDir: snapshot.workDir,
          nextWorkDir: f.nextRoot,
          expectedTasks: snapshot.tasks,
        });
        await closing;
        creating = createProjectRepository(other).createProject({
          instanceId: f.db.instanceId,
          createdByClientId: f.db.actor.accessClientId,
          name: "竞争创建",
          slug: randomUUID(),
          kind: "code",
          workDir: f.nextRoot,
          description: null,
          canvasName: "unused",
        });
        // 先挂接拒绝处理，避免失败后的迟到观察造成 unhandled rejection。
        const createdOutcome = creating.then(
          () => null,
          (error: unknown) => error,
        );
        await expect
          .poll(async () =>
            Number(
              (
                await f.db.persistence.queryOne<{ count: string }>(
                  "select count(*) as count from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like 'select pg_advisory_xact_lock%'",
                )
              )?.count,
            ),
          )
          .toBe(1);
        const ordinary = other.queryOne<{ ok: number }>("select 1 as ok");
        let normalResult: { ok: number } | null | undefined;
        void ordinary.then((result) => {
          normalResult = result;
        });
        await expect.poll(() => normalResult?.ok).toBe(1);
        releaseClose();
        expect(await relinking).toMatchObject({
          projectId: f.project.id,
          workDir: f.nextRoot,
        });
        expect(await createdOutcome).toMatchObject({
          message: "此目录已关联项目，请选择复用或独立创建。",
        });
        expect(
          await createProjectRepository(other).findDirectoryProjects(
            f.db.instanceId,
            f.nextRoot,
          ),
        ).toHaveLength(1);
      } finally {
        releaseClose();
        await Promise.allSettled([relinking, creating]);
        await other.close();
        await f.close();
      }
    });
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
        const checkpointRoot = join(
          (await db.localInstance.getContext()).dataDir,
          "checkpoints",
        );
        const gitDir = shadowRepositoryPath(checkpointRoot, taskId, oldRoot);
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
        const movedGit = shadowRepositoryPath(checkpointRoot, taskId, nextRoot);
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
        expect(
          (
            await run("git", [
              "config",
              "--file",
              join(movedGit, "config"),
              "--get",
              "core.excludesFile",
            ])
          ).stdout.trim(),
        ).toBe(join(movedGit, "excludes"));
        expect(await readFile(join(movedGit, "excludes"), "utf8")).toBe(
          ".git\n",
        );
        await expect(readFile(join(gitDir, "config"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(join(nextRoot, "note.txt"), "utf8")).toBe(
          "历史真实字节",
        );

        // 真实影子仓缺失时继续拒绝；保留仓库字节供证明失败没有偷偷重建或重放。
        const secondRoot = join(db.directory, "second-code"),
          heldGit = `${movedGit}.held`;
        await rename(nextRoot, secondRoot);
        await rename(movedGit, heldGit);
        const missingShadow = await relink.snapshot(db.actor, project.id);
        await expect(
          relink.relink(db.actor, project.id, {
            expectedWorkDir: missingShadow.workDir,
            expectedTasks: missingShadow.tasks,
            nextWorkDir: secondRoot,
          }),
        ).rejects.toThrow("缺少检查点影子仓库");
        expect(
          (
            await createCheckpointRepository(db.persistence).getById(
              db.instanceId,
              checkpointId,
            )
          )?.rootDirectory,
        ).toBe(nextRoot);
        expect(
          (
            await createProjectRepository(db.persistence).findActiveById(
              db.instanceId,
              project.id,
            )
          )?.work_dir,
        ).toBe(nextRoot);
        expect(
          (await run("git", ["--git-dir", heldGit, "show", `${sha}:note.txt`]))
            .stdout,
        ).toBe("历史真实字节");
        await expect(
          readFile(
            join(
              shadowRepositoryPath(checkpointRoot, taskId, secondRoot),
              "config",
            ),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
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
        const policy = await f.readTask();
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
        expect(await f.readGoal()).toMatchObject({
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
        expect((await f.readTask()).executionState).toBe("failed");
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
        const accepted = await f.admit(randomUUID(), "已接受且尚未真实结算");
        await f.move();
        const snapshot = await f.service.snapshot(f.db.actor, f.project.id);
        await expect(
          f.service.relink(f.db.actor, f.project.id, {
            expectedWorkDir: snapshot.workDir,
            expectedTasks: snapshot.tasks,
            nextWorkDir: f.nextRoot,
          }),
        ).rejects.toThrow("尚未停止");
        const policy = await f.readTask();
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
        expect((await f.readTask()).activeRunId).toBeNull();
        expect(await f.readGoal()).toMatchObject({
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
