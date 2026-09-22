import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCheckpointService,
  EMPTY_TREE_SHA,
} from "./checkpoint-service.js";
import { createInMemoryCheckpointRepository } from "./repository.js";
import type { ShadowGitClient } from "./shadow-git-client.js";
import { createShadowGitClient } from "./shadow-git-client.js";
import { createShadowGitExec } from "./shadow-git-exec.js";

/**
 * 检查点服务（切片2）：真实 git + 内存仓储 + 内存 canvas 替身。
 *
 * 锁的行为契约：轮次钩子落行与 run_id 关联、可用性门 fail loud、恢复三态、
 * 预览与恢复一致、每画布互斥串行、空目录跳过、归属校验 404。
 */

const WORKSPACE_ID = "ws-checkpoints";
const CANVAS_ID = "canvas-checkpoints";

describe("检查点服务", () => {
  const dirs: string[] = [];
  const write = (workTree: string, name: string, content: string): void => {
    writeFileSync(join(workTree, name), content, "utf8");
  };

  const makeWorld = (
    options: {
      gitSource?: "system" | "bundled" | "unavailable";
      wrapGit?: (git: ShadowGitClient) => ShadowGitClient;
    } = {},
  ): {
    workTree: string;
    repository: ReturnType<typeof createInMemoryCheckpointRepository>;
    service: ReturnType<typeof createCheckpointService>;
  } => {
    const root = mkdtempSync(join(tmpdir(), "kfw-checkpoint-svc-"));
    dirs.push(root);
    const workTree = join(root, "work");
    mkdirSync(workTree);
    const repository = createInMemoryCheckpointRepository();
    const canvasRepository = {
      findById: async (workspaceId: string, canvasId: string) =>
        workspaceId === WORKSPACE_ID && canvasId === CANVAS_ID
          ? { id: canvasId, name: "画布", project_id: "p1", content: null }
          : null,
      findWorkspaceIdByCanvas: async (canvasId: string) =>
        canvasId === CANVAS_ID ? WORKSPACE_ID : null,
    };
    const realGit = createShadowGitClient({
      exec: createShadowGitExec({ binary: "git" }),
      writeTextFile: async (path, content) => {
        writeFileSync(path, content, "utf8");
      },
    });
    const service = createCheckpointService({
      repository,
      canvasRepository,
      git: options.wrapGit ? options.wrapGit(realGit) : realGit,
      gitSource: options.gitSource ?? "system",
      checkpointRoot: join(root, "checkpoints"),
      resolveSandboxDirFn: () => workTree,
    });
    return { workTree, repository, service };
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beforeTurn → afterTurn 落两行 turn 检查点，run_id 关联、增量统计只算本轮", async () => {
    const { workTree, service } = makeWorld();
    write(workTree, "a.txt", "v1\n");

    const before = await service.beforeTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });
    expect(before?.kind).toBe("turn");
    expect(before?.label).toBe("轮次开始快照");
    expect(before?.runId).toBe("run-1");
    expect(before?.workspaceId).toBe(WORKSPACE_ID);
    // 基线相对空树：只有 a.txt 的 1 行
    expect(before?.filesChanged).toBe(1);
    expect(before?.insertions).toBe(1);
    expect(before?.deletions).toBe(0);

    write(workTree, "a.txt", "v1\nv2\n");
    write(workTree, "b.txt", "b\n");
    const after = await service.afterTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });

    const rows = await service.list({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(before?.id);
    expect(rows[1]?.id).toBe(after?.id);
    expect(rows.every((r) => r.runId === "run-1")).toBe(true);
    expect(rows[0]?.shadowCommit).not.toBe(rows[1]?.shadowCommit);
    // 增量口径：第二行只统计本轮变化（a.txt +1、b.txt +1）
    expect(rows[1]?.filesChanged).toBe(2);
    expect(rows[1]?.insertions).toBe(2);
    expect(rows[1]?.deletions).toBe(0);
  });

  it("失败场景：run 只走到 beforeTurn 也留下轮次开始快照", async () => {
    const { workTree, service } = makeWorld();
    write(workTree, "a.txt", "v1\n");
    const before = await service.beforeTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-9",
    });
    expect(before).not.toBeNull();
    const rows = await service.list({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe("run-9");
    expect(rows[0]?.label).toBe("轮次开始快照");
  });

  it("gitSource=unavailable：所有操作 fail loud 抛 503 git_unavailable", async () => {
    const { service } = makeWorld({ gitSource: "unavailable" });
    const ops = [
      () =>
        service.beforeTurn({
          canvasId: CANVAS_ID,
          sandboxDir: "/tmp/x",
          runId: "r",
        }),
      () =>
        service.afterTurn({
          canvasId: CANVAS_ID,
          sandboxDir: "/tmp/x",
          runId: "r",
        }),
      () => service.list({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
      () => service.diffFor({ workspaceId: WORKSPACE_ID, checkpointId: "id" }),
      () =>
        service.previewRestore({
          workspaceId: WORKSPACE_ID,
          checkpointId: "id",
        }),
      () => service.restore({ workspaceId: WORKSPACE_ID, checkpointId: "id" }),
    ];
    for (const op of ops) {
      await expect(op()).rejects.toMatchObject({
        name: "CodeCheckpointError",
        code: "git_unavailable",
        statusCode: 503,
      });
    }
  });

  it("空目录首跳过：beforeTurn/afterTurn 都不落行", async () => {
    const { workTree, service } = makeWorld();
    expect(
      await service.beforeTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      }),
    ).toBeNull();
    expect(
      await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      }),
    ).toBeNull();
    expect(
      await service.list({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID }),
    ).toEqual([]);
  });

  it("restore：工作区回到目标且多出一个 kind=restore 的检查点", async () => {
    const { workTree, service } = makeWorld();
    write(workTree, "a.txt", "v1\n");
    write(workTree, "gone.txt", "gone\n");
    const first = await service.beforeTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });

    write(workTree, "a.txt", "v2\n");
    write(workTree, "new.txt", "n\n");
    rmSync(join(workTree, "gone.txt"));
    await service.afterTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });

    const restored = await service.restore({
      workspaceId: WORKSPACE_ID,
      checkpointId: first?.id as string,
    });
    // 工作区精确回到目标
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("v1\n");
    expect(readFileSync(join(workTree, "gone.txt"), "utf8")).toBe("gone\n");
    expect(existsSync(join(workTree, "new.txt"))).toBe(false);
    // 恢复本身成为一个新检查点（回滚恢复点），与目标提交不同
    expect(restored?.kind).toBe("restore");
    expect(restored?.label).toBe("回滚恢复点");
    expect(restored?.runId).toBeNull();
    expect(restored?.shadowCommit).not.toBe(first?.shadowCommit);

    const rows = await service.list({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
    });
    expect(rows).toHaveLength(3);
    expect(rows[2]?.kind).toBe("restore");
    // 恢复行的增量：相对恢复前状态 = 3 个文件（a 改、new 删、gone 复活）
    expect(rows[2]?.filesChanged).toBe(3);
    expect(rows[2]?.insertions).toBe(2);
    expect(rows[2]?.deletions).toBe(2);
  });

  it("previewRestore：受影响清单与实际恢复结果一致", async () => {
    const { workTree, service } = makeWorld();
    write(workTree, "a.txt", "v1\n");
    write(workTree, "gone.txt", "gone\n");
    const first = await service.beforeTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });

    write(workTree, "a.txt", "v2\n");
    write(workTree, "b.txt", "b\n");
    await service.afterTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });

    // 未提交改动：改 a.txt、增 extra.txt、删 b.txt
    write(workTree, "a.txt", "dirty\n");
    write(workTree, "extra.txt", "extra\n");
    rmSync(join(workTree, "b.txt"));

    const preview = await service.previewRestore({
      workspaceId: WORKSPACE_ID,
      checkpointId: first?.id as string,
    });
    // 相对目标（first）：a.txt 变了、extra.txt 是多的；b.txt 在两边都不存在，不算差异
    expect(preview.files.map((f) => f.path).sort()).toEqual([
      "a.txt",
      "extra.txt",
    ]);
    expect(preview.filesChanged).toBe(2);
    expect(preview.insertions).toBeGreaterThan(0);

    await service.restore({
      workspaceId: WORKSPACE_ID,
      checkpointId: first?.id as string,
    });
    // 清单里的每一项都按预览归位
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(workTree, "extra.txt"))).toBe(false);
    expect(existsSync(join(workTree, "b.txt"))).toBe(false);
    expect(readFileSync(join(workTree, "gone.txt"), "utf8")).toBe("gone\n");
  });

  it("每画布互斥：并发两次 afterTurn 串行落行，增量互不吞并", async () => {
    let releaseFirst = () => {};
    let numstatEnteredResolve = () => {};
    const numstatEntered = new Promise<void>((resolve) => {
      numstatEnteredResolve = resolve;
    });
    let numstatCalls = 0;
    const { workTree, service } = makeWorld({
      wrapGit: (git) => ({
        ...git,
        numstat: async (input) => {
          numstatCalls += 1;
          if (numstatCalls === 1) {
            // 第一笔停在统计前（commit 已完成）：放行时机由测试掌控
            numstatEnteredResolve();
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return git.numstat(input);
        },
      }),
    });

    write(workTree, "a.txt", "a\n");
    const p1 = service.afterTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });
    // 等 p1 真正跑到统计一步（已持有锁、已完成提交），再写第二个文件并发第二笔
    await numstatEntered;
    write(workTree, "b.txt", "b\n");
    const p2 = service.afterTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-2",
    });
    releaseFirst();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.runId).toBe("run-1");
    expect(r2?.runId).toBe("run-2");
    expect(r1?.filesChanged).toBe(1);
    expect(r2?.filesChanged).toBe(1);
    expect(r1?.shadowCommit).not.toBe(r2?.shadowCommit);
  });

  it("diffFor：首个检查点与空树比，后续与上一检查点比，可按 path 过滤", async () => {
    const { workTree, service } = makeWorld();
    write(workTree, "a.txt", "v1\n");
    const first = await service.beforeTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });
    write(workTree, "a.txt", "v2\n");
    write(workTree, "b.txt", "b\n");
    const second = await service.afterTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });

    const firstDiff = await service.diffFor({
      workspaceId: WORKSPACE_ID,
      checkpointId: first?.id as string,
    });
    expect(firstDiff.from).toBe(EMPTY_TREE_SHA);
    expect(firstDiff.to).toBe(first?.shadowCommit);
    expect(firstDiff.text).toContain("+v1");
    expect(firstDiff.text).not.toContain("b.txt");

    const secondDiff = await service.diffFor({
      workspaceId: WORKSPACE_ID,
      checkpointId: second?.id as string,
    });
    expect(secondDiff.from).toBe(first?.shadowCommit);
    expect(secondDiff.text).toContain("b.txt");
    expect(secondDiff.text).toContain("+v2");

    const onlyA = await service.diffFor({
      workspaceId: WORKSPACE_ID,
      checkpointId: second?.id as string,
      path: "a.txt",
    });
    expect(onlyA.text).toContain("a.txt");
    expect(onlyA.text).not.toContain("b.txt");
  });

  it("归属校验：外工作区/缺失检查点一律 404", async () => {
    const { workTree, service } = makeWorld();
    write(workTree, "a.txt", "v1\n");
    const before = await service.beforeTurn({
      canvasId: CANVAS_ID,
      sandboxDir: workTree,
      runId: "run-1",
    });

    await expect(
      service.list({ workspaceId: "other-ws", canvasId: CANVAS_ID }),
    ).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
    await expect(
      service.diffFor({ workspaceId: WORKSPACE_ID, checkpointId: "missing" }),
    ).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
    await expect(
      service.restore({
        workspaceId: "other-ws",
        checkpointId: before?.id as string,
      }),
    ).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
    await expect(
      service.previewRestore({
        workspaceId: WORKSPACE_ID,
        checkpointId: "missing",
      }),
    ).rejects.toMatchObject({ code: "not_found", statusCode: 404 });
  });

  describe("检查点服务 · 每轮文件清单与每文件撤销", () => {
    it("turnFiles 只列该轮（相对上一检查点）的变更文件", async () => {
      const { workTree, service } = makeWorld();
      write(workTree, "base.txt", "基础内容\n");
      await service.beforeTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-0",
      });
      await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-0",
      });

      write(workTree, "new-in-turn.txt", "本轮新增\n");
      write(workTree, "base.txt", "本轮修改\n");
      const endRow = await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      if (!endRow) throw new Error("应落轮次结束快照");
      if (!endRow) throw new Error("应落轮次结束快照");

      const { files } = await service.turnFiles({
        workspaceId: WORKSPACE_ID,
        checkpointId: endRow.id,
      });
      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(["base.txt", "new-in-turn.txt"]);
    });

    it("restoreFile 把该轮修改的文件恢复到轮开始前，并落一条 restore 检查点", async () => {
      const { workTree, repository, service } = makeWorld();
      write(workTree, "doc.md", "原始内容\n");
      await service.beforeTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      write(workTree, "doc.md", "被改坏的内容\n");
      const endRow = await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      if (!endRow) throw new Error("应落轮次结束快照");
      if (!endRow) throw new Error("应落轮次结束快照");

      const restored = await service.restoreFile({
        workspaceId: WORKSPACE_ID,
        checkpointId: endRow.id,
        path: "doc.md",
      });
      expect(restored.kind).toBe("restore");
      expect(readFileSync(join(workTree, "doc.md"), "utf8")).toBe("原始内容\n");
      // 恢复本身落了可查的检查点行（变更面板据此刷新）
      const rows = await repository.listByCanvas(WORKSPACE_ID, CANVAS_ID);
      expect(rows[rows.length - 1]?.id).toBe(restored.id);
    });

    it("restoreFile 删除该轮新建的文件（回到该轮开始前不存在）", async () => {
      const { workTree, service } = makeWorld();
      write(workTree, "kept.txt", "轮前就有\n");
      await service.beforeTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      write(workTree, "created.md", "本轮新建\n");
      const endRow = await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      if (!endRow) throw new Error("应落轮次结束快照");

      await service.restoreFile({
        workspaceId: WORKSPACE_ID,
        checkpointId: endRow.id,
        path: "created.md",
      });
      expect(existsSync(join(workTree, "created.md"))).toBe(false);
      expect(existsSync(join(workTree, "kept.txt"))).toBe(true);
    });

    it("restoreFile 复活该轮删除的文件", async () => {
      const { workTree, service } = makeWorld();
      write(workTree, "doomed.txt", "将被删除\n");
      await service.beforeTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      rmSync(join(workTree, "doomed.txt"));
      const endRow = await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      if (!endRow) throw new Error("应落轮次结束快照");

      await service.restoreFile({
        workspaceId: WORKSPACE_ID,
        checkpointId: endRow.id,
        path: "doomed.txt",
      });
      expect(readFileSync(join(workTree, "doomed.txt"), "utf8")).toBe(
        "将被删除\n",
      );
    });

    it("restoreFile 只动目标文件，其余文件不受影响", async () => {
      const { workTree, service } = makeWorld();
      write(workTree, "a.txt", "a-原始\n");
      write(workTree, "b.txt", "b-原始\n");
      await service.beforeTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      write(workTree, "a.txt", "a-改\n");
      write(workTree, "b.txt", "b-改\n");
      const endRow = await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      if (!endRow) throw new Error("应落轮次结束快照");

      await service.restoreFile({
        workspaceId: WORKSPACE_ID,
        checkpointId: endRow.id,
        path: "a.txt",
      });
      expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("a-原始\n");
      expect(readFileSync(join(workTree, "b.txt"), "utf8")).toBe("b-改\n");
    });

    it("restoreFile 拒绝绝对路径与 `..` 段（400，fail loud）", async () => {
      const { workTree, service } = makeWorld();
      write(workTree, "x.txt", "x\n");
      const row = await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      if (!row) throw new Error("应落轮次快照");
      for (const bad of ["/etc/passwd", "../escape.txt", "a/../../b.txt"]) {
        await expect(
          service.restoreFile({
            workspaceId: WORKSPACE_ID,
            checkpointId: row.id,
            path: bad,
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      }
    });

    it("restoreFile 重复撤销同一文件：第二次无可恢复差异，不新落检查点", async () => {
      const { workTree, repository, service } = makeWorld();
      write(workTree, "doc.md", "原始\n");
      await service.beforeTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      write(workTree, "doc.md", "改\n");
      const endRow = await service.afterTurn({
        canvasId: CANVAS_ID,
        sandboxDir: workTree,
        runId: "run-1",
      });
      if (!endRow) throw new Error("应落轮次结束快照");
      if (!endRow) throw new Error("应落轮次结束快照");

      // 第一次撤销：恢复 + 落 restore 行
      const first = await service.restoreFile({
        workspaceId: WORKSPACE_ID,
        checkpointId: endRow.id,
        path: "doc.md",
      });
      expect(first.kind).toBe("restore");
      const afterFirst = (
        await repository.listByCanvas(WORKSPACE_ID, CANVAS_ID)
      ).length;

      // 第二次撤销：文件已与基准一致 → 无操作，不新落行（返回目标是本轮的 end 行）
      const second = await service.restoreFile({
        workspaceId: WORKSPACE_ID,
        checkpointId: endRow.id,
        path: "doc.md",
      });
      expect(second.kind).not.toBe("restore");
      expect(
        await repository.listByCanvas(WORKSPACE_ID, CANVAS_ID),
      ).toHaveLength(afterFirst);
    });
  });
});
