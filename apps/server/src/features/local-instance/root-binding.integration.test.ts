import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasFileStore } from "../canvas/file-store.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createCheckpointRepository } from "../checkpoints/repository.js";
import { shadowRepositoryPath } from "../checkpoints/shadow-repo-path.js";
import { createDesignGoals } from "../execution/design-goals.js";
import { createTestDesignModelSelection } from "../execution/design-goals-test-fixture.js";
import { createDesignTasksService } from "../execution/design-tasks.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGoalService } from "../goals/service.js";
import { createPermissionService } from "../permissions/permission-service.js";
import type {
  PersistenceService,
  SqlRow,
  SqlTransaction,
} from "../persistence/types.js";
import { createProjectFileRepository } from "../project-files/repository.js";
import { createProjectFileService } from "../project-files/service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkStore } from "../task-work/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { bindLocalInstanceDataRoot } from "./root-binding.js";

const run = promisify(execFile);
type Database = Awaited<ReturnType<typeof createTaskWorkDatabase>>;

function shadowDirectory(database: Database, dataDir: string, root: string) {
  // 短布局（与生产同一公式）：仓库目录名是 `<taskId>-<rootHash16>.git`，不再走三层 UUID。
  return shadowRepositoryPath(
    join(dataDir, "checkpoints"),
    database.context.scope.taskId,
    root,
  );
}

async function gitSnapshot(gitDir: string, workTree: string) {
  await mkdir(gitDir, { recursive: true });
  const git = (args: string[]) =>
    run("git", args, {
      cwd: workTree,
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workTree },
    });
  await git(["init", gitDir]);
  await writeFile(join(gitDir, "excludes"), ".git\n");
  await git(["config", "core.worktree", workTree]);
  await git(["config", "core.excludesFile", join(gitDir, "excludes")]);
  await git(["add", "--all"]);
  await git([
    "-c",
    "user.name=Root Binding Regression",
    "-c",
    "user.email=root-binding@kenfutwork.local",
    "commit",
    "-m",
    "目录迁移前的真实快照",
  ]);
  await chmod(join(gitDir, "config"), 0o640);
  return (await git(["rev-parse", "HEAD"])).stdout.trim();
}

async function prepareTask(database: Database, oldDir: string) {
  const root = join(oldDir, "sandbox", "main");
  const extra = join(oldDir, "sandbox", "additional");
  const external = database.context.scope.rootDirectory;
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(extra, { recursive: true }),
  ]);
  await writeFile(join(root, "note.txt"), "恢复后仍可读取的原始内容\n");
  await writeFile(join(external, "external.txt"), "外部工作目录不能被移动\n");
  const scope: CodeExecutionScope = {
    ...database.context.scope,
    rootDirectory: root,
    additionalDirectories: [
      { path: extra, access: "read-write" },
      { path: external, access: "read-write" },
    ],
  };
  const scoped = database.persistence.forInstance(database.instanceId);
  const identity = JSON.stringify([scope.projectId, root]);
  const state = {
    workspaceId: root,
    workspaceIdentity: identity,
    queue: { pending: ["历史输入，恢复时不得自动重放"] },
    text: `历史文字中的目录 ${root}`,
    generation: scope.generation,
  };
  await scoped.execute(
    "update public.projects set work_dir=$2, additional_directories=$3::jsonb where instance_id=:instance and id=$1",
    [scope.projectId, root, JSON.stringify(scope.additionalDirectories)],
  );
  await scoped.execute(
    "update public.code_ui_sessions set root_directory=$2, additional_directories=$3::jsonb, state=$4::jsonb where instance_id=:instance and id=$1",
    [
      scope.taskId,
      root,
      JSON.stringify(scope.additionalDirectories),
      JSON.stringify(state),
    ],
  );
  await scoped.execute(
    "insert into public.instance_settings (instance_id, code_ui_preferences) values (:instance, $1::jsonb) on conflict (instance_id) do update set code_ui_preferences=excluded.code_ui_preferences",
    [JSON.stringify({ tabs: { [identity]: { workspacePath: root } } })],
  );
  return { scope, state, root, extra, external };
}

async function prepareHistory(
  database: Database,
  oldDir: string,
  scope: CodeExecutionScope,
  external: string,
) {
  const [mainSha, externalSha] = await Promise.all([
    gitSnapshot(
      shadowDirectory(database, oldDir, scope.rootDirectory),
      scope.rootDirectory,
    ),
    gitSnapshot(shadowDirectory(database, oldDir, external), external),
  ]);
  const snapshots = [
    { rootDirectory: scope.rootDirectory, shadowCommit: mainSha },
    { rootDirectory: external, shadowCommit: externalSha },
  ];
  const checkpointId = randomUUID();
  await createCheckpointRepository(database.persistence).insert({
    id: checkpointId,
    instanceId: database.instanceId,
    projectId: scope.projectId,
    taskId: scope.taskId,
    taskKind: "code",
    rootDirectory: scope.rootDirectory,
    directorySnapshots: snapshots,
    runId: null,
    kind: "turn",
    label: "重绑定真实Git回归",
    shadowCommit: mainSha,
    filesChanged: snapshots.length,
    insertions: snapshots.length,
    deletions: 0,
    createdAt: new Date().toISOString(),
  });
  const workId = randomUUID();
  const workStore = createTaskWorkStore(database.persistence);
  await workStore.create({
    id: workId,
    scope,
    agentId: "main",
    kind: "command",
    detached: true,
    label: "已结束的历史后台任务",
    originRunId: "root-binding-run",
    toolCallId: "root-binding-call",
    parameterFingerprint: `immutable:${scope.rootDirectory}`,
    branchGeneration: database.context.branchGeneration,
    status: "running",
    startedAt: new Date().toISOString(),
    consumed: false,
    ownerId: randomUUID(),
    executionHostId: "root-binding-test-host",
  });
  await workStore.settle(
    database.instanceId,
    scope.taskId,
    workId,
    {
      status: "completed",
      summary: "恢复不能再次执行此工作",
      outputRef: join(oldDir, "execution-output", "task-output.txt"),
    },
    new Date().toISOString(),
  );
  return { checkpointId, workId, snapshots };
}

async function fixture(database: Database) {
  const oldDir = join(database.directory, "old-app-data");
  const newDir = join(database.directory, "new-app-data");
  // 初次绑定仅记账，不猜测已有外部 Project 的归属路径。
  await bindLocalInstanceDataRoot({
    persistence: database.persistence,
    instanceId: database.instanceId,
    dataDir: oldDir,
  });
  const task = await prepareTask(database, oldDir);
  const history = await prepareHistory(
    database,
    oldDir,
    task.scope,
    task.external,
  );
  await cp(oldDir, newDir, { recursive: true });
  return { ...task, ...history, oldDir, newDir };
}

async function readRows(database: Database) {
  const scoped = database.persistence.forInstance(database.instanceId);
  return {
    project: await scoped.queryOne(
      "select id, work_dir, additional_directories from public.projects where instance_id=:instance and id=$1",
      [database.context.scope.projectId],
    ),
    task: await scoped.queryOne<
      SqlRow & { scope_generation: string; revision: string }
    >(
      "select id, root_session_id, root_directory, additional_directories, state, scope_generation, branch_generation, revision, execution_state, active_run_id from public.code_ui_sessions where instance_id=:instance and id=$1",
      [database.context.scope.taskId],
    ),
    work: await scoped.queryOne(
      "select scope, output_ref, status, parameter_fingerprint, branch_generation, consumed_at from public.task_works where instance_id=:instance and task_id=$1",
      [database.context.scope.taskId],
    ),
    checkpoints: await createCheckpointRepository(
      database.persistence,
    ).listByTask(database.instanceId, database.context.scope.taskId),
    settings: await scoped.queryOne(
      "select code_ui_preferences from public.instance_settings where instance_id=:instance",
    ),
    binding: await database.persistence.queryOne(
      "select last_data_dir from public.local_instances where id=$1",
      [database.instanceId],
    ),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Rows = Awaited<ReturnType<typeof readRows>>;

function expectMappedRows(f: Fixture, before: Rows, after: Rows) {
  const nextRoot = join(f.newDir, "sandbox", "main");
  const nextExtra = join(f.newDir, "sandbox", "additional");
  expect(after.project).toEqual({
    id: f.scope.projectId,
    work_dir: nextRoot,
    additional_directories: [
      { path: nextExtra, access: "read-write" },
      { path: f.external, access: "read-write" },
    ],
  });
  expect(after.task).toEqual({
    ...before.task,
    root_directory: nextRoot,
    additional_directories: after.project?.additional_directories,
    state: {
      ...f.state,
      workspaceId: nextRoot,
      workspaceIdentity: JSON.stringify([f.scope.projectId, nextRoot]),
    },
    scope_generation: String(Number(before.task?.scope_generation) + 1),
    revision: String(Number(before.task?.revision) + 1),
  });
  expect(after.work).toEqual({
    ...before.work,
    scope: {
      ...f.scope,
      rootDirectory: nextRoot,
      additionalDirectories: after.project?.additional_directories,
    },
    output_ref: join(f.newDir, "execution-output", "task-output.txt"),
  });
  expect(after.settings).toEqual({
    code_ui_preferences: {
      tabs: {
        [JSON.stringify([f.scope.projectId, nextRoot])]: {
          workspacePath: nextRoot,
        },
      },
    },
  });
  expect(after.checkpoints).toEqual(
    before.checkpoints.map((row) => ({
      ...row,
      rootDirectory: nextRoot,
      directorySnapshots: row.directorySnapshots.map((entry) => ({
        ...entry,
        rootDirectory:
          entry.rootDirectory === f.root ? nextRoot : entry.rootDirectory,
      })),
    })),
  );
  expect(after.binding).toEqual({ last_data_dir: f.newDir });
}

async function expectReadableShadowGit(database: Database, f: Fixture) {
  const nextRoot = join(f.newDir, "sandbox", "main");
  await expect(
    stat(shadowDirectory(database, f.newDir, f.root)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  for (const snapshot of f.snapshots) {
    const root = snapshot.rootDirectory === f.root ? nextRoot : f.external;
    const gitDir = shadowDirectory(database, f.newDir, root);
    const configValue = async (key: string) =>
      (
        await run("git", [
          "config",
          "--file",
          join(gitDir, "config"),
          "--get",
          key,
        ])
      ).stdout.trim();
    expect(await configValue("core.worktree")).toBe(root);
    expect(await configValue("core.excludesFile")).toBe(
      join(gitDir, "excludes"),
    );
    const file = root === nextRoot ? "note.txt" : "external.txt";
    expect(
      (
        await run("git", [
          "--git-dir",
          gitDir,
          "show",
          `${snapshot.shadowCommit}:${file}`,
        ])
      ).stdout,
    ).toBe(await readFile(join(root, file), "utf8"));
  }
}

function failBindingUpdate(
  database: Database,
  failure: Error,
): PersistenceService {
  return {
    ...database.persistence,
    transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      return database.persistence.transaction((tx) =>
        fn({
          ...tx,
          execute(sql, values) {
            if (
              sql ===
              "update public.local_instances set last_data_dir=$2 where id=$1"
            )
              return Promise.reject(failure);
            return tx.execute(sql, values);
          },
        }),
      );
    },
  };
}

/** 只在全新独占PG中运行；默认skipped，不读取.env、不连接开发库。 */
describe.skipIf(process.env.KENFUTWORK_LOCAL_ROOT_PG_TEST !== "1")(
  "应用数据根复制恢复：生产SQL与真实Git",
  () => {
    let database: Database;
    let f: Fixture;
    // 独占数据库启动与迁移属于每例的完整验收，使用该用例预算。
    async function setup() {
      database = await createTaskWorkDatabase();
      f = await fixture(database);
    }
    afterEach(async () => {
      await database?.close();
    });
    it("Canvas/Design托管根一致迁移，外部根不动，素材可读且Goal冷恢复必须手动resume", async () => {
      await setup();
      const projects = createProjectRepository(database.persistence);
      const canvases = createCanvasRepository(database.persistence);
      const tasks = createDesignTasksService({
        persistence: database.persistence,
        localInstance: database.localInstance,
      });
      const goalOptions = {
        modelSelection: createTestDesignModelSelection(),
        persistence: database.persistence,
        localInstance: database.localInstance,
        goals: createGoalService(),
        permissions: createPermissionService(),
      };
      const goals = createDesignGoals(goalOptions);
      let reopened: ReturnType<typeof createDesignGoals> | undefined;
      try {
        const managed = join(f.oldDir, "sandbox", "design-canvas");
        const external = join(database.directory, "external-design");
        await mkdir(managed, { recursive: true });
        await mkdir(external);
        const facts: {
          canvasId: string;
          taskId: string;
          assetId: string;
          root: string;
          generation: number;
          goalId: string;
        }[] = [];
        const files = createProjectFileService({
          repository: createProjectFileRepository(database.persistence),
          localInstance: database.localInstance,
          canvases,
          projects: {
            getProject: async (actor, id) => {
              const row = await projects.findActiveById(actor.instanceId, id);
              if (!row) throw new Error("项目缺失");
              return row;
            },
          },
          executionScopes: createExecutionScopes({
            repository: createScopeRepository(database.persistence),
            localInstance: database.localInstance,
          }),
        });
        const bytes = Buffer.from("托管与外部Canvas原字节");
        for (const root of [managed, external]) {
          const { canvas } = await projects.createProject({
            instanceId: database.instanceId,
            createdByClientId: database.actor.accessClientId,
            kind: "design",
            name: "迁移Canvas",
            slug: randomUUID(),
            description: null,
            canvasName: "Canvas",
            workDir: root,
          });
          if (!canvas) throw new Error("Canvas缺失");
          const prepared = await tasks.prepareCreation(
            database.actor,
            canvas.id,
          );
          if (!prepared) throw new Error("Task准备缺失");
          const session = await createChatRepository(
            database.persistence,
          ).createSession(database.instanceId, {
            canvasId: canvas.id,
            threadId: randomUUID(),
            createdByClientId: database.actor.accessClientId,
            designTaskPreparation: prepared,
          });
          if (!session) throw new Error("Task缺失");
          const goal = await goals.create(database.actor, {
            taskId: session.id,
            objective: `保留目标文字 ${root}`,
            tokenBudget: 17,
          });
          const assetId = randomUUID();
          await files.prepareWrite(database.actor, {
            target: {
              kind: "canvas",
              canvasId: canvas.id,
              projectId: prepared.projectId,
            },
            assetId,
            relativePath: "image.png",
            mimeType: "image/png",
            writeFingerprint: hash(bytes.toString()),
          });
          await files.namespaceProvider.upload(
            `${database.instanceId}/project-files/${assetId}`,
            bytes,
            { upsert: true, contentType: "image/png" },
          );
          await createCanvasFileStore({ projectRoot: root }).save(
            canvas.id,
            {
              elements: [],
              appState: {},
              files: {
                image: {
                  assetId,
                  relativePath: "image.png",
                  version: hash(bytes.toString()),
                  storageRef: `oss://project-assets/${database.instanceId}/project-files/${assetId}`,
                },
              },
            },
            null,
          );
          facts.push({
            canvasId: canvas.id,
            taskId: session.id,
            assetId,
            root,
            generation: (await tasks.readPolicy(database.actor, session.id))
              .scopeGeneration,
            goalId: goal.goalId,
          });
        }
        const before = await Promise.all(
          facts.map((fact) => goals.readTask(database.actor, fact.taskId)),
        );
        await goals.close();
        await cp(f.oldDir, f.newDir, { recursive: true });
        await rm(f.oldDir, { recursive: true });
        await bindLocalInstanceDataRoot({
          persistence: database.persistence,
          instanceId: database.instanceId,
          dataDir: f.newDir,
        });
        for (const [index, fact] of facts.entries()) {
          const expected =
            fact.root === managed
              ? join(f.newDir, "sandbox", "design-canvas")
              : external;
          expect(
            (await canvases.findById(database.instanceId, fact.canvasId))
              ?.root_directory,
          ).toBe(expected);
          const policy = await tasks.readPolicy(database.actor, fact.taskId);
          expect(policy.rootDirectory).toBe(expected);
          expect(policy.scopeGeneration).toBe(
            fact.generation + (fact.root === managed ? 1 : 0),
          );
          expect(policy.branchGeneration).toBe(1);
          expect(policy.activeRunId).toBeNull();
          expect(await files.read(database.actor, fact.assetId)).toEqual(bytes);
          expect(
            (
              await createCanvasFileStore({ projectRoot: expected }).read(
                fact.canvasId,
              )
            )?.content.files.image?.assetId,
          ).toBe(fact.assetId);
          const persisted = await database.persistence
            .forInstance(database.instanceId)
            .queryOne<{ state: unknown }>(
              "select state from public.design_task_goals where instance_id=:instance and task_id=$1",
              [fact.taskId],
            );
          expect(persisted?.state).toEqual(before[index]);
        }
        reopened = createDesignGoals(goalOptions);
        await reopened.initialize();
        for (const fact of facts)
          expect(
            await reopened.readTask(database.actor, fact.taskId),
          ).toMatchObject({
            goalId: fact.goalId,
            status: "paused",
            tokenBudget: 17,
            tokensUsed: 0,
            iteration: 0,
            reason: "host.restarted",
          });
      } finally {
        await reopened?.close();
        await goals.close();
        await tasks.close();
      }
    }, 60000);

    it("旧根已删除时恢复所有应用路径，保留Task/分支/工作事实并能读取检查点；重复启动no-op", async () => {
      await setup();
      const before = await readRows(database);
      await rm(f.oldDir, { recursive: true });
      expect(
        await bindLocalInstanceDataRoot({
          persistence: database.persistence,
          instanceId: database.instanceId,
          dataDir: f.newDir,
        }),
      ).toBe(f.newDir);
      const after = await readRows(database);
      expectMappedRows(f, before, after);
      await expectReadableShadowGit(database, f);
      expect(
        await createTaskWorkStore(database.persistence).isCurrent({
          ...database.context,
          scope: f.scope,
        }),
      ).toBe(false);
      await bindLocalInstanceDataRoot({
        persistence: database.persistence,
        instanceId: database.instanceId,
        dataDir: f.newDir,
      });
      expect(await readRows(database)).toEqual(after);
      expect(database.secondReplay).toEqual([]);
    });

    it("末尾事务失败精确回滚hash目录、Git配置与SQL；非法快照拒绝后仍可正常重试", async () => {
      await setup();
      const before = await readRows(database);
      const configs = await Promise.all(
        f.snapshots.map(async (snapshot) => {
          const path = join(
            shadowDirectory(database, f.newDir, snapshot.rootDirectory),
            "config",
          );
          return {
            bytes: await readFile(path),
            mode: (await stat(path)).mode & 0o777,
          };
        }),
      );
      const failure = new Error("故意中断根账本写入");
      const persistence = failBindingUpdate(database, failure);
      await expect(
        bindLocalInstanceDataRoot({
          persistence,
          instanceId: database.instanceId,
          dataDir: f.newDir,
        }),
      ).rejects.toBe(failure);
      expect(await readRows(database)).toEqual(before);
      for (const [index, snapshot] of f.snapshots.entries()) {
        const path = join(
          shadowDirectory(database, f.newDir, snapshot.rootDirectory),
          "config",
        );
        expect({
          bytes: await readFile(path),
          mode: (await stat(path)).mode & 0o777,
        }).toEqual(configs[index]);
      }
      await expect(
        stat(
          shadowDirectory(
            database,
            f.newDir,
            join(f.newDir, "sandbox", "main"),
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const scoped = database.persistence.forInstance(database.instanceId);
      await scoped.execute(
        "update public.project_checkpoints set directory_snapshots='[]'::jsonb where instance_id=:instance and id=$1",
        [f.checkpointId],
      );
      await expect(
        bindLocalInstanceDataRoot({
          persistence: database.persistence,
          instanceId: database.instanceId,
          dataDir: f.newDir,
        }),
      ).rejects.toThrow("缺少目录快照");
      expect((await readRows(database)).binding).toEqual(before.binding);
      await scoped.execute(
        "update public.project_checkpoints set directory_snapshots=$2::jsonb where instance_id=:instance and id=$1",
        [f.checkpointId, JSON.stringify(f.snapshots)],
      );
      expect(await readRows(database)).toEqual(before);
      await bindLocalInstanceDataRoot({
        persistence: database.persistence,
        instanceId: database.instanceId,
        dataDir: f.newDir,
      });
      expect((await readRows(database)).binding).toEqual({
        last_data_dir: f.newDir,
      });
      expect(await readFile(join(f.root, "note.txt"), "utf8")).toBe(
        "恢复后仍可读取的原始内容\n",
      );
    });
  },
);
