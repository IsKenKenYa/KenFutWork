import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointRepository } from "../checkpoints/repository.js";
import type {
  PersistenceService,
  SqlRow,
  SqlTransaction,
} from "../persistence/types.js";
import { createTaskWorkStore } from "../task-work/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { bindLocalInstanceDataRoot } from "./root-binding.js";

const run = promisify(execFile);
type Database = Awaited<ReturnType<typeof createTaskWorkDatabase>>;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function shadowDirectory(database: Database, dataDir: string, root: string) {
  return join(
    dataDir,
    "checkpoints",
    database.instanceId,
    database.context.scope.projectId,
    `${database.context.scope.taskId}.git`,
    hash(root),
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
    beforeEach(async () => {
      database = await createTaskWorkDatabase();
      f = await fixture(database);
    });
    afterEach(async () => {
      await database?.close();
    });

    it("旧根已删除时恢复所有应用路径，保留Task/分支/工作事实并能读取检查点；重复启动no-op", async () => {
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
