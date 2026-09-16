import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createProjectRepository } from "../projects/repository.js";
import { createChatService } from "./chat-service.js";
import { createChatRepository } from "./repository.js";

/**
 * chat 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明 `chat_sessions`/`chat_messages` 经「画布→项目」链的工作区谓词在真库
 * 上成立，且缺省标题走列默认值、消息 jsonb 往返一致。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run chat.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const FOREIGN_WORKSPACE = "00000000-0000-0000-0000-000000000000";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("chat 真实库集成", () => {
  async function withChatFixture(
    run: (input: {
      canvasId: string;
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
      ).createWithCanvas({
        canvasName: "会话集成画布",
        description: null,
        name: "会话集成项目",
        slug: `chat-int-${Date.now().toString(36)}`,
        userId: (profile as IdRow).id,
        workspaceId,
      });

      try {
        await run({
          canvasId: created.canvas.id,
          persistence,
          userId: (profile as IdRow).id,
          workspaceId,
        });
      } finally {
        // 清理：会话/消息 → 画布 → 项目（顺序不依赖 FK 级联行为）。
        await persistence.query(
          `delete from public.chat_messages
            where session_id in (
              select id from public.chat_sessions where canvas_id = $1
            )`,
          [created.canvas.id],
        );
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

  it("建会话缺省标题落库默认值，给出标题则写入", async () => {
    await withChatFixture(
      async ({ canvasId, persistence, userId, workspaceId }) => {
        const chat = createChatRepository(persistence);

        const bare = await chat.createSession(workspaceId, {
          canvasId,
          threadId: "thread_integration_a",
          userId,
        });
        expect(bare?.title).toBe("新对话");
        expect(bare?.id).toBeTruthy();

        const titled = await chat.createSession(workspaceId, {
          canvasId,
          threadId: "thread_integration_b",
          title: "集成标题",
          userId,
        });
        expect(titled?.title).toBe("集成标题");
      },
    );
  });

  it("会话列表按画布取回，线程绑定可解析", async () => {
    await withChatFixture(
      async ({ canvasId, persistence, userId, workspaceId }) => {
        const chat = createChatRepository(persistence);
        const created = await chat.createSession(workspaceId, {
          canvasId,
          threadId: "thread_integration_c",
          userId,
        });

        const sessions = await chat.listSessions(workspaceId, canvasId);
        expect(sessions.map((row) => row.id)).toContain(created?.id);

        const binding = await chat.findSessionThread(
          workspaceId,
          created?.id as string,
        );
        expect(binding?.thread_id).toBe("thread_integration_c");
      },
    );
  });

  it("写消息后读回一致（content_blocks jsonb 往返），且推进会话时间", async () => {
    await withChatFixture(
      async ({ canvasId, persistence, userId, workspaceId }) => {
        const chat = createChatRepository(persistence);
        const session = await chat.createSession(workspaceId, {
          canvasId,
          threadId: "thread_integration_d",
          userId,
        });
        const sessionId = session?.id as string;

        const created = await chat.insertMessage(workspaceId, {
          sessionId,
          role: "assistant",
          content: "回复正文",
          toolActivities: [{ name: "web_search" }],
          contentBlocks: [
            { type: "text", text: "回复正文" },
            { type: "tool", name: "web_search" },
          ],
        });

        expect(created?.content).toBe("回复正文");
        expect(created?.content_blocks).toEqual([
          { type: "text", text: "回复正文" },
          { type: "tool", name: "web_search" },
        ]);

        const messages = await chat.listMessages(workspaceId, sessionId);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.id).toBe(created?.id);
        expect(messages[0]?.tool_activities).toEqual([{ name: "web_search" }]);

        await expect(chat.touchSession(workspaceId, sessionId)).resolves.toBe(
          1,
        );
      },
    );
  });

  it("跨工作区读不到、改不动、删不掉（FORM-9 隔离门禁）", async () => {
    await withChatFixture(
      async ({ canvasId, persistence, userId, workspaceId }) => {
        const chat = createChatRepository(persistence);
        const session = await chat.createSession(workspaceId, {
          canvasId,
          threadId: "thread_integration_e",
          userId,
        });
        const sessionId = session?.id as string;
        await chat.insertMessage(workspaceId, {
          sessionId,
          role: "user",
          content: "只应本工作区可见",
        });

        await expect(
          chat.findSessionThread(FOREIGN_WORKSPACE, sessionId),
        ).resolves.toBeNull();
        await expect(
          chat.listSessions(FOREIGN_WORKSPACE, canvasId),
        ).resolves.toEqual([]);
        await expect(
          chat.listMessages(FOREIGN_WORKSPACE, sessionId),
        ).resolves.toEqual([]);
        await expect(
          chat.updateSessionTitle(FOREIGN_WORKSPACE, sessionId, "越权改名"),
        ).resolves.toBe(0);
        await expect(
          chat.deleteSession(FOREIGN_WORKSPACE, sessionId),
        ).resolves.toBe(0);
        await expect(
          chat.insertMessage(FOREIGN_WORKSPACE, {
            sessionId,
            role: "user",
            content: "越权写入",
          }),
        ).resolves.toBeNull();

        // 越权尝试后本工作区数据完好
        const messages = await chat.listMessages(workspaceId, sessionId);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.content).toBe("只应本工作区可见");
      },
    );
  });

  it("删除会话后列表不再包含它", async () => {
    await withChatFixture(
      async ({ canvasId, persistence, userId, workspaceId }) => {
        const chat = createChatRepository(persistence);
        const session = await chat.createSession(workspaceId, {
          canvasId,
          threadId: "thread_integration_f",
          userId,
        });
        const sessionId = session?.id as string;

        await expect(chat.deleteSession(workspaceId, sessionId)).resolves.toBe(
          1,
        );
        await expect(chat.deleteSession(workspaceId, sessionId)).resolves.toBe(
          0,
        );

        const sessions = await chat.listSessions(workspaceId, canvasId);
        expect(sessions.map((row) => row.id)).not.toContain(sessionId);
      },
    );
  });
});

describe.skipIf(!DATABASE_URL)("Code 模式会话供给（方案 A）", () => {
  /**
   * 回归锁（用户可见症状：Code 模式回复正常但**消息不落库**）：工作台用客户端自造的
   * sessionId 发起 run，库里没有会话行 → 线程解析失败、助手消息被丢弃。供给后必须满足
   * 「发一条消息 → chat_messages 真有行」，且多轮复用同一 thread、载体只建一份。
   */
  async function withFixture(
    run: (input: {
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

      try {
        await run({
          persistence,
          userId: (profile as IdRow).id,
          workspaceId,
        });
      } finally {
        // 清理：删会话（消息级联）+ 隐藏载体项目（画布级联）
        await persistence.query(
          `delete from public.chat_sessions
            where canvas_id in (
              select c.id from public.canvases c
               join public.projects p on p.id = c.project_id
              where p.slug = 'code-workbench' and p.workspace_id = $1
            )`,
          [workspaceId],
        );
        await persistence.query(
          "delete from public.projects where slug = 'code-workbench' and workspace_id = $1",
          [workspaceId],
        );
      }
    } finally {
      await persistence.close();
    }
  }

  function buildServices(input: {
    persistence: ReturnType<typeof createPostgresPersistence>;
    userId: string;
    workspaceId: string;
  }) {
    const repository = createChatRepository(input.persistence);
    const user = {
      accessToken: "t",
      email: "code-session-int@test",
      id: input.userId,
      userMetadata: {},
    };
    const service = createChatService({
      codeWorkbench: createProjectRepository(input.persistence),
      repository,
      threadService: {
        createThreadId: () =>
          `thread_test_${Math.random().toString(36).slice(2)}`,
      } as never,
      // 工作区解析注入夹具工作区（生产实现从鉴权用户解析，这里只需形状）
      viewerService: {
        resolveWorkspace: async () => ({
          id: input.workspaceId,
          name: "ws",
          ownerUserId: input.userId,
          type: "personal" as const,
        }),
      } as never,
    });
    return { repository, service, user };
  }

  it("供给后：会话行存在、线程绑定，且发消息真的落到 chat_messages", async () => {
    await withFixture(async ({ persistence, userId, workspaceId }) => {
      const { repository, service, user } = buildServices({
        persistence,
        userId,
        workspaceId,
      });
      const sessionId = crypto.randomUUID();

      const first = await service.ensureCodeSession(user, {
        sessionId,
        title: "写一个脚本",
      });
      expect(first.sessionId).toBe(sessionId);
      expect(first.threadId).toBeTruthy();

      const row = await repository.findSessionThread(workspaceId, sessionId);
      expect(row?.thread_id).toBe(first.threadId);

      // 关键断言：发消息后消息行存在（修复前这里是 0 行）
      await service.createMessage(user, sessionId, {
        content: "助手回复",
        contentBlocks: [{ type: "text", text: "助手回复" }],
        role: "assistant",
      });
      const messages = await persistence.query<{ count: string }>(
        "select count(*)::text as count from public.chat_messages where session_id = $1",
        [sessionId],
      );
      expect(Number(messages[0]?.count)).toBe(1);

      // 多轮：同一 sessionId 再供给一次 → 复用同一 thread
      const second = await service.ensureCodeSession(user, { sessionId });
      expect(second.threadId).toBe(first.threadId);
    });
  });

  it("载体只建一份，且不在 Design 项目列表里出现", async () => {
    await withFixture(async ({ persistence, userId, workspaceId }) => {
      const { service, user } = buildServices({
        persistence,
        userId,
        workspaceId,
      });

      await service.ensureCodeSession(user, { sessionId: crypto.randomUUID() });
      await service.ensureCodeSession(user, { sessionId: crypto.randomUUID() });

      const projects = await persistence.query<{ count: string }>(
        "select count(*)::text as count from public.projects where slug = 'code-workbench' and workspace_id = $1",
        [workspaceId],
      );
      expect(Number(projects[0]?.count)).toBe(1);
      const canvases = await persistence.query<{ count: string }>(
        `select count(*)::text as count
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where p.slug = 'code-workbench' and p.workspace_id = $1 and c.is_primary`,
        [workspaceId],
      );
      expect(Number(canvases[0]?.count)).toBe(1);

      const listed =
        await createProjectRepository(persistence).listActive(workspaceId);
      expect(listed.some((p) => p.slug === "code-workbench")).toBe(false);
    });
  });

  it("并发供给 8 个会话：载体仍只有一份，各自线程唯一", async () => {
    await withFixture(async ({ persistence, userId, workspaceId }) => {
      const { repository, service, user } = buildServices({
        persistence,
        userId,
        workspaceId,
      });
      const ids = Array.from({ length: 8 }, () => crypto.randomUUID());

      const results = await Promise.all(
        ids.map((sessionId) => service.ensureCodeSession(user, { sessionId })),
      );

      const threads = new Set(results.map((r) => r.threadId));
      expect(threads.size).toBe(8);
      for (const sessionId of ids) {
        const row = await repository.findSessionThread(workspaceId, sessionId);
        expect(row?.thread_id, sessionId).toBeTruthy();
      }
      const projects = await persistence.query<{ count: string }>(
        "select count(*)::text as count from public.projects where slug = 'code-workbench' and workspace_id = $1",
        [workspaceId],
      );
      expect(Number(projects[0]?.count)).toBe(1);
    });
  });

  it("非 uuid 的 sessionId 直接拒绝（不静默换 id）", async () => {
    await withFixture(async ({ persistence, userId, workspaceId }) => {
      const { service, user } = buildServices({
        persistence,
        userId,
        workspaceId,
      });

      await expect(
        service.ensureCodeSession(user, { sessionId: "not-a-uuid" }),
      ).rejects.toThrow(/UUID/i);
    });
  });
});
