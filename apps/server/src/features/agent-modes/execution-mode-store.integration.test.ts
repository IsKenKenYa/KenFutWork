import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createProjectRepository } from "../projects/repository.js";
import { createExecutionModeStore } from "./execution-mode-store.js";

/**
 * 执行模式持久化真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明 chat_sessions.execution_mode 的读回/写穿在工作区谓词下成立——
 * 归属工作区可见、外工作区不可见，迁移落列后无脏读。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run execution-mode-store.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const FOREIGN_WORKSPACE = "00000000-0000-0000-0000-000000000000";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("执行模式持久化真实库集成", () => {
  async function withThreadFixture(
    run: (input: {
      threadId: string;
      persistence: ReturnType<typeof createPostgresPersistence>;
      userId: string;
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
      ).createProject({
        canvasName: "模式集成画布",
        description: null,
        name: "模式集成项目",
        slug: `mode-int-${Date.now().toString(36)}`,
        userId: (profile as IdRow).id,
        workspaceId,
      });
      if (!created.canvas) throw new Error("Design 夹具缺少主画布");

      const threadId = `thread_mode_int_${randomUUID()}`;
      const chat = createChatRepository(persistence);
      await chat.createSession(workspaceId, {
        canvasId: created.canvas.id,
        threadId,
        userId: (profile as IdRow).id,
      });

      try {
        await run({
          threadId,
          persistence,
          userId: (profile as IdRow).id,
          workspaceId,
        });
      } finally {
        await persistence.query(
          "delete from public.chat_sessions where canvas_id = $1",
          [created.canvas.id],
        );
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

  it("lookup：归属工作区 exists+null，外工作区不可见；save 写穿后读回一致", async () => {
    await withThreadFixture(async ({ threadId, persistence, workspaceId }) => {
      const store = createExecutionModeStore(persistence);

      // 新会话未设置模式：行存在、值为 null
      expect(await store.lookup(workspaceId, threadId)).toEqual({
        exists: true,
        mode: null,
      });
      // 外工作区看不到该线程（FORM-9 隔离谓词）
      expect(await store.lookup(FOREIGN_WORKSPACE, threadId)).toEqual({
        exists: false,
        mode: null,
      });

      // 写穿 + 读回
      await store.save(workspaceId, threadId, "plan");
      expect(await store.lookup(workspaceId, threadId)).toEqual({
        exists: true,
        mode: "plan",
      });

      // 外工作区写入是 0 行更新，不影响归属工作区的值
      await store.save(FOREIGN_WORKSPACE, threadId, "solo");
      expect(await store.lookup(workspaceId, threadId)).toEqual({
        exists: true,
        mode: "plan",
      });

      // 全六档值都能落列（约束列合法性）
      for (const mode of [
        "agent",
        "plan",
        "solo",
        "goal",
        "loop",
        "creative",
      ] as const) {
        await store.save(workspaceId, threadId, mode);
        expect(await store.lookup(workspaceId, threadId)).toEqual({
          exists: true,
          mode,
        });
      }
    });
  });

  it("save 对不存在的线程是 0 行 no-op（会话未落库时内存激活兜底）", async () => {
    await withThreadFixture(async ({ persistence, workspaceId }) => {
      const store = createExecutionModeStore(persistence);
      const ghost = `thread_mode_ghost_${randomUUID()}`;
      await store.save(workspaceId, ghost, "solo");
      expect(await store.lookup(workspaceId, ghost)).toEqual({
        exists: false,
        mode: null,
      });
    });
  });
});
