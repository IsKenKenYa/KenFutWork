import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTestInstance } from "../../agent/runtime-test-fixtures.js";
import type { ScopeState } from "../execution/scope-repository.js";
import {
  createExecutionScopes,
  type ExecutionScopeHandle,
} from "../execution/scope-service.js";
import { acquireTaskFileRestoreBarrier } from "../execution/scoped-filesystem.js";
import type { LocalActor } from "../local-instance/types.js";
import {
  type CheckpointFileTransactions,
  createCheckpointService,
} from "./checkpoint-service.js";
import { createInMemoryCheckpointRepository } from "./repository.js";
import {
  createShadowGitClient,
  type ExecShadowGit,
} from "./shadow-git-client.js";

const INSTANCE_ID = "2cdb5c27-a1f7-4109-9927-40e0b0822956";
const PROJECT_ID = "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5";
const TASK_ID = "0432143f-e2b8-4ea6-adea-01f706f537d3";
const actor: LocalActor = {
  instanceId: INSTANCE_ID,
  accessClientId: "00000000-0000-4000-8000-000000000009",
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
// Git 存储语义的测试执行替身；不作为真实 ProcessSandbox enforcement 证据。
const exec: ExecShadowGit = async (args, directory, input) => {
  try {
    return {
      code: 0,
      stderr: "",
      stdout: execFileSync("git", ["--no-optional-locks", ...args], {
        cwd: directory.workTree,
        env: {
          ...process.env,
          GIT_DIR: directory.gitDir,
          GIT_WORK_TREE: directory.workTree,
        },
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer };
    return {
      code: failure.status ?? 1,
      stderr: failure.stderr?.toString() ?? "失败",
      stdout: "",
    };
  }
};
async function world() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-checkpoint-task-")),
  );
  temporary.push(base);
  const root = join(base, "primary");
  const extra = join(base, "extra");
  const readonly = join(root, "readonly");
  await Promise.all([mkdir(root), mkdir(extra)]);
  await mkdir(readonly);
  let identity: CodeExecutionScope = {
    instanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [
      { path: extra, access: "read-write" },
      { path: readonly, access: "read-only" },
    ],
    sandboxMode: "workspace-write",
  };
  let branch = 1;
  let state: ScopeState = "ready";
  const scopes = createExecutionScopes({
    repository: {
      load: async (_instanceId, task) =>
        task === TASK_ID
          ? { scope: identity, state, branchGeneration: branch }
          : null,
    },
    localInstance: createRuntimeTestInstance(INSTANCE_ID),
  });
  const scope = await scopes.openTask(actor, TASK_ID);
  const git = createShadowGitClient({
    exec,
    writeTextFile: (path, text) => writeFile(path, text, "utf8"),
  });
  const beforeRestore = vi.fn(async () => {
    branch++;
    identity = { ...identity, generation: identity.generation + 1 };
    state = "revoking";
    return scopes.openRestoringTask(actor, TASK_ID, identity.generation);
  });
  const afterRestore = vi.fn(
    async (
      _scope: ExecutionScopeHandle,
      _actor: LocalActor,
      success: boolean,
    ) => {
      state = success ? "ready" : "failed";
    },
  );
  const files: CheckpointFileTransactions = {
    observe: (handle, path) => handle.backend.observeBinary(path),
    commit: async (handle, entries, beforeCommit) => {
      const result = await handle.backend.commitBatch(entries, async () => {
        const next = await beforeCommit();
        await expect(scopes.openTask(actor, TASK_ID)).rejects.toMatchObject({
          code: "scope_unavailable",
        });
        return next;
      });
      if (!result.complete || !result.newScope)
        throw new Error(
          result.failures.map((failure) => failure.error).join("\n"),
        );
      return result.newScope;
    },
  };
  const repository = createInMemoryCheckpointRepository();
  const service = createCheckpointService({
    repository,
    gitForScope: async () => git,
    gitSource: "system",
    checkpointRoot: join(base, "checkpoints"),
    files,
    acquireRestoreBarrier: acquireTaskFileRestoreBarrier,
    onBeforeRestore: beforeRestore,
    onAfterRestore: afterRestore,
  });
  return {
    base,
    root,
    extra,
    readonly,
    scope,
    scopes,
    service,
    repository,
    beforeRestore,
    afterRestore,
  };
}
describe("Task 检查点", () => {
  it("按精确pre引用读取选定文件原始字节，保留UTF16与BOM且不猜相邻检查点", async () => {
    const { root, service, scope } = await world();
    const path = join(root, "encoded.txt");
    const original = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("before\n", "utf16le"),
    ]);
    await writeFile(path, original);
    const pre = await service.captureTurnBoundary({
      scope,
      actor,
      runId: "encoded-run",
      phase: "pre",
    });
    if (!pre.effective) throw new Error("真实pre引用未保存");
    await scope.backend.readPage({ path });
    await scope.backend.editFile({
      path,
      oldString: "before",
      newString: "after",
    });
    await service.captureTurnBoundary({
      scope,
      actor,
      runId: "encoded-run",
      phase: "post",
    });
    const bytes = await service.readFileSnapshot({
      scope,
      actor,
      checkpointId: pre.effective.id,
      path,
    });
    expect(Buffer.from(bytes.bytes!)).toEqual(original);
    expect(await readFile(path)).toEqual(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("after\n", "utf16le"),
      ]),
    );
  });
  it("captureTurnBoundary无变化按本次真实shadow版本返回post有效引用，不猜数据库最新行", async () => {
    const { root, service, scope } = await world();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T02:00:00.000Z"));
      await writeFile(join(root, "a.txt"), "one\n");
      const first = await service.beforeTurn({
        scope,
        actor,
        runId: "run-first",
      });
      vi.setSystemTime(new Date("2026-10-04T01:00:00.000Z"));
      await writeFile(join(root, "a.txt"), "two\n");
      const current = await service.afterTurn({
        scope,
        actor,
        runId: "run-current",
      });
      if (!current) throw new Error("文件已变更，应创建检查点");
      expect(current.shadowCommit).not.toBe(first?.shadowCommit);
      expect((await service.list({ scope, actor })).at(-1)?.id).toBe(first?.id);
      vi.setSystemTime(new Date("2026-10-04T03:00:00.000Z"));
      const boundary = await service.captureTurnBoundary({
        scope,
        actor,
        runId: "run-next",
        phase: "post",
      });
      expect(boundary).toMatchObject({
        phase: "post",
        created: null,
        effective: {
          id: current.id,
          shadowCommit: current.shadowCommit,
          kind: "turn",
        },
      });
      expect(await service.list({ scope, actor })).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("只读边界不会被用户.gitignore反向规则覆盖，恢复保留只读内容", async () => {
    const { root, readonly, scope, scopes, service } = await world();
    await writeFile(join(root, ".gitignore"), "!readonly/\n!readonly/**\n");
    await writeFile(join(root, "main.txt"), "before");
    await writeFile(join(readonly, "reference.txt"), "只读内容");
    const checkpoint = await service.beforeTurn({ scope, actor, runId: "run" });
    expect(
      (
        await service.turnFiles({ scope, actor, checkpointId: checkpoint!.id })
      ).files.map((file) => file.path),
    ).not.toContain("readonly/reference.txt");
    await writeFile(join(root, "main.txt"), "after");
    const preview = await service.previewRestore({
      scope,
      actor,
      checkpointId: checkpoint!.id,
    });
    await service.restore({
      scope,
      actor,
      checkpointId: checkpoint!.id,
      expectedVersion: preview.expectedVersion,
    });
    expect(await readFile(join(readonly, "reference.txt"), "utf8")).toBe(
      "只读内容",
    );
    expect(await readFile(join(root, "main.txt"), "utf8")).toBe("before");
    expect((await scopes.openTask(actor, TASK_ID)).describe().sandboxMode).toBe(
      "workspace-write",
    );
  });

  it("快照覆盖主目录和可写额外目录，排除只读子目录与用户 .git", async () => {
    const { root, extra, readonly, service, scope } = await world();
    await writeFile(join(root, "main.txt"), "主目录\n");
    await writeFile(join(extra, "extra.txt"), "额外目录\n");
    await writeFile(join(readonly, "private.txt"), "只读\n");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "用户配置");
    const before = await service.beforeTurn({ scope, actor, runId: "run" });
    expect(before?.taskId).toBe(TASK_ID);
    expect(before?.projectId).toBe(PROJECT_ID);
    expect(
      before?.directorySnapshots.map((entry) => entry.rootDirectory),
    ).toEqual([root, extra]);
    const files = await service.turnFiles({
      scope,
      actor,
      checkpointId: before!.id,
    });
    expect(files.files.map((entry) => entry.path).sort()).toEqual([
      "extra.txt",
      "main.txt",
    ]);
    expect(await readFile(join(root, ".git", "config"), "utf8")).toBe(
      "用户配置",
    );
  });
  it("无变化不追加行，afterTurn保留run关联与增量统计", async () => {
    const { root, service, scope } = await world();
    await writeFile(join(root, "a.txt"), "one\n");
    await service.beforeTurn({ scope, actor, runId: "run" });
    expect(await service.afterTurn({ scope, actor, runId: "run" })).toBeNull();
    await writeFile(join(root, "a.txt"), "one\ntwo\n");
    const after = await service.afterTurn({ scope, actor, runId: "run" });
    expect(after?.runId).toBe("run");
    expect(after?.insertions).toBe(1);
    expect(await service.list({ scope, actor })).toHaveLength(2);
  });
  it("预览后其他 Task 改同文件，恢复409且不停止/覆盖其他工作", async () => {
    const { root, scope, service, beforeRestore } = await world();
    const path = join(root, "a.txt");
    await writeFile(path, "initial");
    const checkpoint = await service.beforeTurn({ scope, actor, runId: "r" });
    await writeFile(path, "current");
    const preview = await service.previewRestore({
      scope,
      actor,
      checkpointId: checkpoint!.id,
    });
    await writeFile(path, "另一Task刚写的");
    await expect(
      service.restore({
        scope,
        actor,
        checkpointId: checkpoint!.id,
        expectedVersion: preview.expectedVersion,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(beforeRestore).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("另一Task刚写的");
  });
  it("二进制恢复保持字节、撤销新增/恢复删除，旧scope永久失效", async () => {
    const { root, extra, readonly, scope, scopes, service } = await world();
    const bytes = Buffer.from([0, 255, 128, 10]);
    await writeFile(join(root, "binary.dat"), bytes);
    await writeFile(join(extra, "gone.txt"), "restore");
    await writeFile(join(readonly, "keep.txt"), "keep");
    const checkpoint = await service.beforeTurn({ scope, actor, runId: "r" });
    await writeFile(join(root, "binary.dat"), "changed");
    await rm(join(extra, "gone.txt"));
    await writeFile(join(root, "new.txt"), "new");
    const preview = await service.previewRestore({
      scope,
      actor,
      checkpointId: checkpoint!.id,
    });
    await service.restore({
      scope,
      actor,
      checkpointId: checkpoint!.id,
      expectedVersion: preview.expectedVersion,
    });
    expect(await readFile(join(root, "binary.dat"))).toEqual(bytes);
    expect(await readFile(join(extra, "gone.txt"), "utf8")).toBe("restore");
    await expect(readFile(join(root, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(readonly, "keep.txt"), "utf8")).toBe("keep");
    await expect(scope.resolvePath(".", "read")).rejects.toMatchObject({
      code: "branch_changed",
    });
    expect((await scopes.openTask(actor, TASK_ID)).describe().generation).toBe(
      2,
    );
  });
  it("预览版本不能重放、跨检查点或误用于文件撤销", async () => {
    const { root, scope, service } = await world();
    await writeFile(join(root, "a.txt"), "first");
    const first = await service.beforeTurn({ scope, actor, runId: "r" });
    await writeFile(join(root, "a.txt"), "second");
    const second = await service.afterTurn({ scope, actor, runId: "r" });
    const preview = await service.previewRestore({
      scope,
      actor,
      checkpointId: first!.id,
    });
    await expect(
      service.restore({
        scope,
        actor,
        checkpointId: second!.id,
        expectedVersion: preview.expectedVersion,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.restoreFile({
        scope,
        actor,
        checkpointId: first!.id,
        expectedVersion: preview.expectedVersion,
        path: "a.txt",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("外Task检查点拒绝，空目录无快照", async () => {
    const { scope, service, repository } = await world();
    expect(await service.beforeTurn({ scope, actor, runId: "r" })).toBeNull();
    await repository.insert({
      id: "other",
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      taskId: "other-task",
      rootDirectory: scope.describe().rootDirectory,
      directorySnapshots: [],
      shadowCommit: "a".repeat(40),
      runId: null,
      kind: "turn",
      label: "其他Task",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      createdAt: new Date().toISOString(),
    });
    await expect(
      service.previewRestore({ scope, actor, checkpointId: "other" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
