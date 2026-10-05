import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import { HumanMessage } from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { AgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";
import { createTemporaryPostgres } from "../task-work/test-postgres.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createHarness } from "./test-harness.js";

const enabled = process.env.RUN_AGENT_PERSISTENCE_INTEGRATION === "1";

describe.skipIf(!enabled)("Harness真实数据库持久化 integration", () => {
  it("已配置Postgres但初始化失败时Run明确失败，不能以MemorySaver继续执行模型", async () => {
    const database = await createTaskWorkDatabase();
    let f: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      const unavailable = new URL(database.connectionString);
      unavailable.pathname = "/missing_agent_persistence_database";
      f = await createHarness(database, undefined, undefined, true, {
        agentPersistenceService: createAgentPersistenceService({
          databaseUrl: unavailable.toString(),
        }),
      });
      const runId = randomUUID();
      await f.service.createAcceptedRun({
        runId,
        sessionId: f.scope.taskId,
        threadId: f.threadId,
      });
      f.runtime.createRun(
        {
          sessionId: f.scope.taskId,
          conversationId: f.scope.taskId,
          taskId: f.scope.taskId,
          projectId: f.scope.projectId,
          preset: "code",
          prompt: "初始化失败必须保留持久化承诺",
        },
        {
          runId,
          threadId: f.threadId,
          scopeHandle: f.handle,
          actor: f.actor,
          inputIdentity: {
            clientId: "persistence-client",
            sourceCommandId: "persistence-command",
          },
          inputOrigin: "userInput",
        },
      );
      const events: StreamEvent[] = [];
      for await (const event of f.runtime.streamRun(runId)) events.push(event);
      expect(events.at(-1)?.type).toBe("run.failed");
      expect(events.some((event) => event.type === "run.completed")).toBe(
        false,
      );
      expect(f.model.requests).toEqual([]);
    } finally {
      await f?.work.close("持久化回归收尾");
      await database.close();
    }
  }, 90_000);
  it("真实插件宿主关闭后持久化服务不再借出资源，已创建的SDK连接全部释放", async () => {
    const fixture = await createCodeUiHttpFixture();
    try {
      const service = fixture.app.kernel.get("agentPersistence");
      const native = await service.getPersistence();
      if (!native) throw new Error("独占数据库必须提供真实持久化");
      await native.store.put(["persistence-lifecycle"], "receipt", {
        text: "真实数据库内容",
      });
      expect(
        await native.store.get(["persistence-lifecycle"], "receipt"),
      ).toMatchObject({ value: { text: "真实数据库内容" } });
      await fixture.app.close();
      await expect(service.getPersistence()).rejects.toThrow(
        "持久化服务已关闭",
      );
      await expect(
        native.store.get(["persistence-lifecycle"], "receipt"),
      ).rejects.toThrow();
      await expect(
        native.checkpointer.getTuple({
          configurable: { thread_id: "closed-thread" },
        }),
      ).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  }, 90_000);
  it("并发首次读取共享完整SDK持久化，关闭重建后原生上下文与store仍从数据库恢复", async () => {
    const database = await createTemporaryPostgres();
    const service = createAgentPersistenceService({
      databaseUrl: database.connectionString,
    });
    const replacement = createAgentPersistenceService({
      databaseUrl: database.connectionString,
    });
    try {
      const [first, second] = await Promise.all([
        service.getPersistence(),
        service.getPersistence(),
      ]);
      if (!first || !second) throw new Error("明确配置数据库不能返回空持久化");
      const buildGraph = (persistence: typeof first) =>
        new StateGraph(MessagesAnnotation)
          .addNode("remember", () => ({}))
          .addEdge(START, "remember")
          .addEdge("remember", END)
          .compile(persistence);
      const config = { configurable: { thread_id: "durable-original-thread" } };
      await buildGraph(first).invoke(
        { messages: [new HumanMessage("服务重建后仍保留的完整输入")] },
        config,
      );
      expect(
        (await buildGraph(second).getState(config)).values.messages,
      ).toMatchObject([{ content: "服务重建后仍保留的完整输入" }]);
      await second.store.put(["durable-original-store"], "receipt", {
        text: "同一数据库事实",
      });
      await Promise.all([service.dispose(), service.dispose()]);
      const restored = await replacement.getPersistence();
      if (!restored) throw new Error("新服务必须恢复数据库持久化");
      expect(
        (await buildGraph(restored).getState(config)).values.messages,
      ).toMatchObject([{ content: "服务重建后仍保留的完整输入" }]);
      expect(
        await restored.store.get(["durable-original-store"], "receipt"),
      ).toMatchObject({ value: { text: "同一数据库事实" } });
    } finally {
      await service.dispose();
      await replacement.dispose();
      await database.close();
    }
  }, 90_000);

  it("store真实初始化失败后清理部分SDK连接，数据库修复后同一服务可重试且不丢到内存", async () => {
    const database = await createTemporaryPostgres();
    const observer = new Client({
      connectionString: database.connectionString,
    });
    const service = createAgentPersistenceService({
      databaseUrl: database.connectionString,
    });
    try {
      await observer.connect();
      // 仅独占临时SDK schema的外部故障注入；不修改项目迁移或现存数据库。
      await observer.query(
        "create schema langgraph; create table langgraph.store_migrations (invalid_column integer)",
      );
      const settled = await Promise.allSettled([
        service.getPersistence(),
        service.getPersistence(),
      ]);
      expect(settled.map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      const connections = await observer.query(
        "select count(*)::integer as count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()",
      );
      expect(connections.rows).toEqual([{ count: 0 }]);
      await observer.query("drop table langgraph.store_migrations");
      const recovered = await service.getPersistence();
      if (!recovered) throw new Error("修复后必须得到真实SDK持久化");
      await recovered.store.put(["recovered-database"], "receipt", {
        text: "真实修复结果",
      });
      expect(
        await recovered.store.get(["recovered-database"], "receipt"),
      ).toMatchObject({ value: { text: "真实修复结果" } });
    } finally {
      await service.dispose();
      await observer.end();
      await database.close();
    }
  }, 90_000);

  it("关闭等待中的初始化不借出迟到资源，重复关闭只在所有真实连接释放后完成", async () => {
    const database = await createTemporaryPostgres();
    const seed = createAgentPersistenceService({
      databaseUrl: database.connectionString,
    });
    const service: AgentPersistenceService = createAgentPersistenceService({
      databaseUrl: database.connectionString,
    });
    const observer = new Client({
      connectionString: database.connectionString,
    });
    let initialized: ReturnType<typeof service.getPersistence> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await seed.getPersistence();
      await seed.dispose();
      await observer.connect();
      await observer.query(
        "begin; lock table langgraph.checkpoint_migrations in access exclusive mode",
      );
      initialized = service.getPersistence();
      void initialized.catch(() => {});
      // 真实DB锁作为外部同步点；不以sleep猜测SDK已经进入初始化。
      await vi.waitFor(
        async () => {
          // observer持有事务锁，主动刷新Postgres统计快照才能观察后来进入等待的连接。
          await observer.query("select pg_stat_clear_snapshot()");
          const waiting = await observer.query(
            "select count(*)::integer as count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%checkpoint_migrations%'",
          );
          expect(waiting.rows).toEqual([{ count: 1 }]);
        },
        { timeout: 30_000 },
      );
      closing = service.dispose();
      await expect(service.getPersistence()).rejects.toThrow(
        "持久化服务已关闭",
      );
      await observer.query("commit");
      await expect(initialized).rejects.toThrow("持久化服务已关闭");
      await Promise.all([closing, service.dispose()]);
      const connections = await observer.query(
        "select count(*)::integer as count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()",
      );
      expect(connections.rows).toEqual([{ count: 0 }]);
    } finally {
      await observer.query("rollback");
      await initialized?.catch(() => {});
      await closing;
      await seed.dispose();
      await service.dispose();
      await observer.end();
      await database.close();
    }
  }, 90_000);
});
