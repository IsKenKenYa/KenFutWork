import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createProjectRepository } from "../projects/repository.js";
import { createCanvasRepository } from "./repository.js";

/**
 * canvas 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明 canvases 经 projects 父链的工作区谓词在真库上成立——读写都不可越界，
 * 且 jsonb 的读回与 $n::jsonb 写入形状一致。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run canvas.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const FOREIGN_WORKSPACE = "00000000-0000-0000-0000-000000000000";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("canvas 真实库集成", () => {
  async function withCanvasFixture(
    run: (input: {
      canvasId: string;
      persistence: ReturnType<typeof createPostgresPersistence>;
      workspaceId: string;
    }) => Promise<void>,
  ) {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();

      const workspace = await createViewerRepository(
        persistence,
      ).findPersonalWorkspace((profile as IdRow).id);
      const workspaceId = workspace?.id as string;
      expect(workspaceId).toBeTruthy();

      const projects = createProjectRepository(persistence);
      const created = await projects.createWithCanvas({
        canvasName: "集成画布",
        description: null,
        name: "集成项目",
        slug: `canvas-int-${Date.now().toString(36)}`,
        userId: (profile as IdRow).id,
        workspaceId,
      });

      try {
        await run({
          canvasId: created.canvas.id,
          persistence,
          workspaceId,
        });
      } finally {
        await persistence.query(
          "delete from public.canvases where project_id = $1",
          [created.project.id],
        );
        await persistence.query("delete from public.projects where id = $1", [
          created.project.id,
        ]);
      }
    } finally {
      await persistence.close();
    }
  }

  it("读画布经父链取到（新建画布内容为默认空对象）", async () => {
    await withCanvasFixture(async ({ canvasId, persistence, workspaceId }) => {
      const canvas = await createCanvasRepository(persistence).findById(
        workspaceId,
        canvasId,
      );

      expect(canvas?.id).toBe(canvasId);
      expect(canvas?.name).toBe("集成画布");
    });
  });

  it("写画布内容后读回一致（jsonb 写入与读回往返）", async () => {
    await withCanvasFixture(async ({ canvasId, persistence, workspaceId }) => {
      const canvases = createCanvasRepository(persistence);
      const content = {
        appState: { viewBackgroundColor: "#fff" },
        elements: [{ id: "el-1", type: "image", x: 10, width: 100 }],
      };

      await expect(
        canvases.saveContent(workspaceId, canvasId, content),
      ).resolves.toBe(1);

      const reread = await canvases.findById(workspaceId, canvasId);
      expect(reread?.content).toEqual(content);
    });
  });

  it("跨工作区读不到也写不进（FORM-9 隔离门禁）", async () => {
    await withCanvasFixture(async ({ canvasId, persistence, workspaceId }) => {
      const canvases = createCanvasRepository(persistence);

      await expect(
        canvases.findById(FOREIGN_WORKSPACE, canvasId),
      ).resolves.toBeNull();
      await expect(
        canvases.saveContent(FOREIGN_WORKSPACE, canvasId, { elements: [] }),
      ).resolves.toBe(0);

      // 越界写尝试后原内容不受影响
      const untouched = await canvases.findById(workspaceId, canvasId);
      expect(untouched?.id).toBe(canvasId);
    });
  });

  it("写入不存在的画布返回 0 行（不再静默成功）", async () => {
    await withCanvasFixture(async ({ persistence, workspaceId }) => {
      await expect(
        createCanvasRepository(persistence).saveContent(
          workspaceId,
          "11111111-1111-1111-1111-111111111111",
          { elements: [] },
        ),
      ).resolves.toBe(0);
    });
  });
});

describe.skipIf(!DATABASE_URL)("canvas 原子追加（并发落图不丢元素）", () => {
  /**
   * 回归锁：生成物落画布曾经是「读 content → 追加 → 覆盖写」，两个任务并发落同一块
   * 画布时后写者覆盖前者（lost update）。现在合并发生在单条 SQL 内，这里用真库并发
   * 追加固定数量元素，断言**一个都不少**。
   */
  async function withCanvasFixture(
    run: (input: {
      canvasId: string;
      persistence: ReturnType<typeof createPostgresPersistence>;
      workspaceId: string;
    }) => Promise<void>,
  ) {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();

      const workspace = await createViewerRepository(
        persistence,
      ).findPersonalWorkspace((profile as IdRow).id);
      const workspaceId = workspace?.id as string;
      expect(workspaceId).toBeTruthy();

      const created = await createProjectRepository(
        persistence,
      ).createWithCanvas({
        canvasName: "并发画布",
        description: null,
        name: "并发项目",
        slug: `canvas-append-${Date.now().toString(36)}`,
        userId: (profile as IdRow).id,
        workspaceId,
      });

      try {
        await run({ canvasId: created.canvas.id, persistence, workspaceId });
      } finally {
        await persistence.query(
          "delete from public.canvases where project_id = $1",
          [created.project.id],
        );
        await persistence.query("delete from public.projects where id = $1", [
          created.project.id,
        ]);
      }
    } finally {
      await persistence.close();
    }
  }

  it("8 路并发追加后元素与文件一个不少（覆盖写时代会丢）", async () => {
    await withCanvasFixture(async ({ canvasId, persistence, workspaceId }) => {
      const repository = createCanvasRepository(persistence);
      const N = 8;

      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          repository.appendContent(workspaceId, canvasId, {
            elements: [{ id: `el-${i}`, type: "image" }],
            files: { [`file-${i}`]: { id: `file-${i}`, dataURL: "data:," } },
          }),
        ),
      );

      const row = await repository.findById(workspaceId, canvasId);
      const content = (row?.content ?? {}) as {
        elements?: Array<{ id: string }>;
        files?: Record<string, unknown>;
      };
      expect(content.elements?.map((el) => el.id).sort()).toEqual(
        Array.from({ length: N }, (_, i) => `el-${i}`).sort(),
      );
      expect(Object.keys(content.files ?? {}).sort()).toEqual(
        Array.from({ length: N }, (_, i) => `file-${i}`).sort(),
      );
    });
  });

  it("空 content 与缺键都能追加（新建画布首次落图）", async () => {
    await withCanvasFixture(async ({ canvasId, persistence, workspaceId }) => {
      const repository = createCanvasRepository(persistence);
      // 先显式清成空对象，模拟「尚无 elements/files 键」的历史行
      await repository.saveContent(workspaceId, canvasId, {});

      const affected = await repository.appendContent(workspaceId, canvasId, {
        elements: [{ id: "first" }],
      });

      expect(affected).toBe(1);
      const row = await repository.findById(workspaceId, canvasId);
      const content = (row?.content ?? {}) as {
        elements?: Array<{ id: string }>;
        files?: Record<string, unknown>;
      };
      expect(content.elements?.map((el) => el.id)).toEqual(["first"]);
      expect(content.files).toEqual({});
    });
  });

  it("跨工作区追加 0 行（越界不可写）", async () => {
    await withCanvasFixture(async ({ canvasId, persistence }) => {
      const affected = await createCanvasRepository(persistence).appendContent(
        FOREIGN_WORKSPACE,
        canvasId,
        { elements: [{ id: "evil" }] },
      );
      expect(affected).toBe(0);
    });
  });
});
