import { describe, expect, it } from "vitest";
import { createLocalInstanceService } from "../local-instance/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import { SqlError } from "../persistence/errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { ChatServiceError, createChatService } from "./chat-service.js";
import { type ChatRepository, createChatRepository } from "./repository.js";
import { createThreadService, ThreadServiceError } from "./thread-service.js";

const CLIENT_ID = "client-1";
const INSTANCE_ID = "instance-1";
const CANVAS_ID = "canvas-1";
const PROJECT_ID = "project-1";
const SESSION_ID = "session-1";

const ACTOR: LocalActor = {
  instanceId: INSTANCE_ID,
  accessClientId: CLIENT_ID,
};

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async acquireSession() {
      return {
        query: async (text, values) => run(text, values),
        onLost: () => () => {},
        release: async () => {},
      };
    },
    async end() {},
  };

  return {
    calls,
    sqls: () => calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
    runner,
  };
}

const LOCAL_INSTANCE = createLocalInstanceService({
  repository: { ensure: async () => INSTANCE_ID },
  dataDir: "/tmp/chat-instance-test",
});

const SESSION_ROW = {
  id: SESSION_ID,
  title: "New Chat",
  updated_at: "2026-09-13T00:00:00+00:00",
  project_id: PROJECT_ID,
  mode: "design" as const,
};

const MESSAGE_ROW = {
  id: "msg-1",
  role: "user",
  content: "你好",
  tool_activities: null,
  content_blocks: null,
  created_at: "2026-09-13T00:00:00+00:00",
};

describe("chat repository（会话与消息经画布→项目链限定）", () => {
  it("会话列表按画布过滤并施加实例谓词，按更新时间倒序", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [SESSION_ROW],
    }));

    await createChatRepository(
      createPersistenceFromRunner(runner),
    ).listSessions(INSTANCE_ID, CANVAS_ID);

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("from public.chat_sessions s");
    expect(sql).not.toContain("join public.canvases");
    expect(sql).toContain(
      "join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id",
    );
    expect(sql).toContain("where s.canvas_id = $1 and p.instance_id = $2");
    expect(sql).toContain("order by s.updated_at desc");
    expect(calls[0]?.values).toEqual([CANVAS_ID, INSTANCE_ID]);
  });

  it("建会话缺省标题时省略该列（NOT NULL 默认值生效），给出标题时写入", async () => {
    const withoutTitle = createRunner(() => ({
      rowCount: 1,
      rows: [SESSION_ROW],
    }));
    await createChatRepository(
      createPersistenceFromRunner(withoutTitle.runner),
    ).createSession(INSTANCE_ID, {
      canvasId: CANVAS_ID,
      threadId: "thread_1",
      createdByClientId: CLIENT_ID,
    });

    const bareSql =
      withoutTitle.calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(bareSql).toContain(
      "insert into public.chat_sessions (instance_id, project_id, mode, canvas_id, created_by_client_id, thread_id)",
    );
    expect(bareSql).not.toMatch(
      /insert into public\.chat_sessions \([^)]*title/,
    );
    expect(withoutTitle.calls[0]?.values).toEqual([
      CANVAS_ID,
      CLIENT_ID,
      "thread_1",
      INSTANCE_ID,
    ]);

    const withTitle = createRunner(() => ({
      rowCount: 1,
      rows: [SESSION_ROW],
    }));
    await createChatRepository(
      createPersistenceFromRunner(withTitle.runner),
    ).createSession(INSTANCE_ID, {
      canvasId: CANVAS_ID,
      threadId: "thread_1",
      title: "标题",
      createdByClientId: CLIENT_ID,
    });

    const titledSql =
      withTitle.calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(titledSql).toContain(
      "insert into public.chat_sessions (instance_id, project_id, mode, canvas_id, created_by_client_id, thread_id, title)",
    );
    expect(withTitle.calls[0]?.values).toEqual([
      CANVAS_ID,
      CLIENT_ID,
      "thread_1",
      "标题",
      INSTANCE_ID,
    ]);
  });

  it("改标题/删除/推进时间都带链式实例谓词", async () => {
    const rename = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createChatRepository(
      createPersistenceFromRunner(rename.runner),
    ).updateSessionTitle(INSTANCE_ID, SESSION_ID, "新标题");

    expect(rename.sqls()[0]).toContain(
      "update public.chat_sessions s set title = $1 from public.projects p where p.id = s.project_id and s.instance_id = $3 and s.id = $2 and s.mode <> 'code' and p.instance_id = $3",
    );
    expect(rename.calls[0]?.values).toEqual([
      "新标题",
      SESSION_ID,
      INSTANCE_ID,
    ]);

    const remove = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createChatRepository(
      createPersistenceFromRunner(remove.runner),
    ).deleteSession(INSTANCE_ID, SESSION_ID);
    expect(remove.sqls()[0]).toContain("delete from public.chat_sessions s");
    expect(remove.sqls()[0]).toContain("and p.instance_id = $2");
    expect(remove.calls[0]?.values).toEqual([SESSION_ID, INSTANCE_ID]);

    const touch = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createChatRepository(
      createPersistenceFromRunner(touch.runner),
    ).touchSession(INSTANCE_ID, SESSION_ID);
    expect(touch.sqls()[0]).toContain(
      "update public.chat_sessions s set updated_at = now()",
    );
    expect(touch.calls[0]?.values).toEqual([SESSION_ID, INSTANCE_ID]);
  });

  it("消息读取经会话→项目实例身份限定，Code无需Canvas", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [MESSAGE_ROW],
    }));

    await createChatRepository(
      createPersistenceFromRunner(runner),
    ).listMessages(INSTANCE_ID, SESSION_ID);

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("from public.chat_messages m");
    expect(sql).toContain("join public.chat_sessions s on s.id = m.session_id");
    expect(sql).not.toContain("join public.canvases");
    expect(sql).toContain(
      "join public.projects p on p.id = s.project_id and p.instance_id = s.instance_id",
    );
    expect(sql).toContain("order by m.created_at asc");
    expect(calls[0]?.values).toEqual([SESSION_ID, INSTANCE_ID]);
  });

  it("写消息同样经链限定，jsonb 参数显式序列化", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [MESSAGE_ROW],
    }));

    await createChatRepository(
      createPersistenceFromRunner(runner),
    ).insertMessage(INSTANCE_ID, {
      sessionId: SESSION_ID,
      role: "assistant",
      content: "回复",
      toolActivities: [{ name: "search" }],
      contentBlocks: [{ type: "text", text: "回复" }],
    });

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("insert into public.chat_messages");
    expect(sql).toContain("select s.id, $2, $3, $4::jsonb, $5::jsonb");
    expect(sql).toContain("and p.instance_id = $6");
    expect(calls[0]?.values).toEqual([
      SESSION_ID,
      "assistant",
      "回复",
      JSON.stringify([{ name: "search" }]),
      JSON.stringify([{ type: "text", text: "回复" }]),
      INSTANCE_ID,
    ]);

    // 未给出可选项时落 NULL 而非省略列（列可空）
    const bare = createRunner(() => ({ rowCount: 1, rows: [MESSAGE_ROW] }));
    await createChatRepository(
      createPersistenceFromRunner(bare.runner),
    ).insertMessage(INSTANCE_ID, {
      sessionId: SESSION_ID,
      role: "user",
      content: "hi",
    });
    expect(bare.calls[0]?.values).toEqual([
      SESSION_ID,
      "user",
      "hi",
      null,
      null,
      INSTANCE_ID,
    ]);
  });
});

function createFakeRepository(
  overrides: Partial<ChatRepository> = {},
): ChatRepository {
  return {
    createSession: async () => SESSION_ROW,
    ensureSessionWithId: async (_instanceId, input) => ({
      id: input.sessionId,
      thread_id: input.threadId,
      canvas_id: input.canvasId ?? null,
      project_id: PROJECT_ID,
      mode: "design",
    }),
    deleteSession: async () => 1,
    findSessionThread: async () => ({
      canvas_id: CANVAS_ID,
      project_id: PROJECT_ID,
      mode: "design",
      id: SESSION_ID,
      thread_id: "thread_1",
    }),
    insertMessage: async () => MESSAGE_ROW,
    listMessages: async () => [],
    listSessions: async () => [],
    touchSession: async () => 1,
    updateSessionTitle: async () => 1,
    ...overrides,
  };
}

function buildService(
  options: {
    repository?: Partial<ChatRepository>;
    localInstance?: LocalInstanceService;
  } = {},
) {
  const repository = createFakeRepository(options.repository);
  const threadService = createThreadService({
    repository,
    localInstance: options.localInstance ?? LOCAL_INSTANCE,
  });

  return {
    chat: createChatService({
      repository,
      threadService,
      localInstance: options.localInstance ?? LOCAL_INSTANCE,
    }),
    threadService,
  };
}

describe("chat service", () => {
  it("generic视觉聊天入口拒绝CodeTask写/删/改名/读取，V4是唯一聚合", async () => {
    let writes = 0;
    const { chat } = buildService({
      repository: {
        findSessionThread: async () => ({
          id: SESSION_ID,
          canvas_id: null,
          project_id: PROJECT_ID,
          mode: "code",
          thread_id: "code-thread",
        }),
        deleteSession: async () => {
          writes++;
          return 1;
        },
        updateSessionTitle: async () => {
          writes++;
          return 1;
        },
        insertMessage: async () => {
          writes++;
          return MESSAGE_ROW;
        },
      },
    });
    for (const action of [
      () => chat.deleteSession(ACTOR, SESSION_ID),
      () => chat.updateSessionTitle(ACTOR, SESSION_ID, "标题"),
      () =>
        chat.createMessage(ACTOR, SESSION_ID, {
          role: "user",
          content: "消息",
        }),
      () => chat.listMessages(ACTOR, SESSION_ID),
    ])
      await expect(action()).rejects.toMatchObject({
        code: "session_not_found",
        statusCode: 404,
      });
    expect(writes).toBe(0);
  });

  it("会话列表映射为契约形状", async () => {
    const { chat } = buildService({
      repository: { listSessions: async () => [SESSION_ROW] },
    });

    await expect(chat.listSessions(ACTOR, CANVAS_ID)).resolves.toEqual([
      {
        id: SESSION_ID,
        title: "New Chat",
        updatedAt: SESSION_ROW.updated_at,
        projectId: PROJECT_ID,
        mode: "design",
      },
    ]);
  });

  it("建会话未命中（画布不属本实例）报 500 chat_error", async () => {
    const { chat } = buildService({
      repository: { createSession: async () => null },
    });
    await expect(chat.createSession(ACTOR, CANVAS_ID)).rejects.toMatchObject({
      code: "chat_error",
      statusCode: 500,
    });
  });

  it("改标题/删除未命中显式 404（旧实现经 RLS 静默成功）", async () => {
    const rename = buildService({
      repository: { updateSessionTitle: async () => 0 },
    });
    await expect(
      rename.chat.updateSessionTitle(ACTOR, SESSION_ID, "x"),
    ).rejects.toMatchObject({ code: "session_not_found", statusCode: 404 });

    const remove = buildService({
      repository: { deleteSession: async () => 0 },
    });
    await expect(
      remove.chat.deleteSession(ACTOR, SESSION_ID),
    ).rejects.toMatchObject({ code: "session_not_found", statusCode: 404 });
  });

  it("消息读取去重相邻同角色同内容（历史双写遗留）", async () => {
    const row = (id: string, role: string, content: string) => ({
      ...MESSAGE_ROW,
      id,
      role,
      content,
    });
    const { chat } = buildService({
      repository: {
        listMessages: async () => [
          row("1", "user", "hi"),
          row("2", "user", "hi"),
          row("3", "assistant", "yo"),
          row("4", "assistant", "yo"),
          row("5", "user", "hi"),
        ],
      },
    });

    const messages = await chat.listMessages(ACTOR, SESSION_ID);
    expect(messages.map((m) => m.id)).toEqual(["1", "3", "5"]);
  });

  it("消息读取从旧字段合成 contentBlocks（text 在前，工具在后）", async () => {
    const { chat } = buildService({
      repository: {
        listMessages: async () => [
          {
            ...MESSAGE_ROW,
            content_blocks: null,
            tool_activities: [{ name: "search", status: "ok" }],
          },
        ],
      },
    });

    const [message] = await chat.listMessages(ACTOR, SESSION_ID);
    expect(message?.contentBlocks).toEqual([
      { type: "text", text: "你好" },
      { type: "tool", name: "search", status: "ok" },
    ]);
  });

  it("已存 content_blocks 优先于旧字段合成", async () => {
    const blocks = [{ type: "text", text: "显式块" }];
    const { chat } = buildService({
      repository: {
        listMessages: async () => [{ ...MESSAGE_ROW, content_blocks: blocks }],
      },
    });

    const [message] = await chat.listMessages(ACTOR, SESSION_ID);
    expect(message?.contentBlocks).toEqual(blocks);
  });

  it("写消息后推进会话时间；推进失败不影响消息本身", async () => {
    let touched = 0;
    const { chat } = buildService({
      repository: {
        touchSession: async () => {
          touched += 1;
          throw new SqlError("boom");
        },
      },
    });

    await expect(
      chat.createMessage(ACTOR, SESSION_ID, { role: "user", content: "hi" }),
    ).resolves.toMatchObject({ id: MESSAGE_ROW.id });
    expect(touched).toBe(1);
  });

  it("写消息未命中报 500 chat_error，且不推进会话时间", async () => {
    let touched = 0;
    const { chat } = buildService({
      repository: {
        insertMessage: async () => null,
        touchSession: async () => {
          touched += 1;
          return 1;
        },
      },
    });

    await expect(
      chat.createMessage(ACTOR, SESSION_ID, { role: "user", content: "hi" }),
    ).rejects.toBeInstanceOf(ChatServiceError);
    expect(touched).toBe(0);
  });

  it("实例解析失败时不下发数据访问", async () => {
    let reads = 0;
    const failingInstance: LocalInstanceService = {
      ...LOCAL_INSTANCE,
      resolve: async () => {
        throw new Error("本地实例暂不可用");
      },
    };
    const { chat } = buildService({
      localInstance: failingInstance,
      repository: {
        listSessions: async () => {
          reads += 1;
          return [];
        },
      },
    });

    await expect(chat.listSessions(ACTOR, CANVAS_ID)).rejects.toThrow(
      "本地实例暂不可用",
    );
    expect(reads).toBe(0);
  });
});

describe("thread service（会话线程绑定）", () => {
  it("命中且已绑定线程时返回绑定", async () => {
    const { threadService } = buildService();
    await expect(
      threadService.resolveOwnedSessionThread(ACTOR, SESSION_ID),
    ).resolves.toEqual({
      canvasId: CANVAS_ID,
      projectId: PROJECT_ID,
      mode: "design",
      sessionId: SESSION_ID,
      threadId: "thread_1",
    });
  });

  it("会话不存在（或不属本实例）返回 404", async () => {
    const { threadService } = buildService({
      repository: { findSessionThread: async () => null },
    });
    await expect(
      threadService.resolveOwnedSessionThread(ACTOR, SESSION_ID),
    ).rejects.toMatchObject({
      code: "session_not_found",
      statusCode: 404,
    });
  });

  it("会话未绑定线程返回 409（不可续跑）", async () => {
    const { threadService } = buildService({
      repository: {
        findSessionThread: async () => ({
          canvas_id: CANVAS_ID,
          project_id: PROJECT_ID,
          mode: "design",
          id: SESSION_ID,
          thread_id: null,
        }),
      },
    });

    const error = await threadService
      .resolveOwnedSessionThread(ACTOR, SESSION_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThreadServiceError);
    expect(error).toMatchObject({ code: "session_not_found", statusCode: 409 });
  });

  it("实例解析失败原样传播，不伪装成会话不存在", async () => {
    const { threadService } = buildService({
      localInstance: {
        ...LOCAL_INSTANCE,
        resolve: async () => {
          throw new Error("本地实例暂不可用");
        },
      },
    });

    await expect(
      threadService.resolveOwnedSessionThread(ACTOR, SESSION_ID),
    ).rejects.toThrow("本地实例暂不可用");
  });
});

it("会话与线程服务在实例不匹配时拒绝，不从会话资源反推调用身份", async () => {
  let queries = 0;
  const { chat, threadService } = buildService({
    repository: {
      listSessions: async () => {
        queries += 1;
        return [];
      },
      findSessionThread: async () => {
        queries += 1;
        return null;
      },
    },
  });
  const actor = { instanceId: "foreign", accessClientId: ACTOR.accessClientId };
  await expect(chat.listSessions(actor, CANVAS_ID)).rejects.toMatchObject({
    code: "instance_forbidden",
  });
  await expect(
    threadService.resolveOwnedSessionThread(actor, SESSION_ID),
  ).rejects.toMatchObject({ code: "instance_forbidden" });
  expect(queries).toBe(0);
});
