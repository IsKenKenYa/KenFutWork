import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  type ExecutionMode,
  runCreateResponseSchema,
} from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createAgentPersistenceService } from "../agent/persistence/index.js";
import { createAgentRunService } from "../agent/runtime.js";
import { loadServerEnv } from "../config/env.js";
import { createExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import { createExecutionModeStore } from "../features/agent-modes/execution-mode-store.js";
import { BoundaryModel } from "../features/agent-runs/test-harness.js";
import { createChatRepository } from "../features/chat/repository.js";
import { createThreadService } from "../features/chat/thread-service.js";
import { createProjectRepository } from "../features/projects/repository.js";
import { createTaskWorkDatabase } from "../features/task-work/test-postgres-schema.js";
import { registerRunRoutes } from "./runs.js";

async function createModeRouteFixture(
  options: { initialMode?: ExecutionMode; cold?: boolean } = {},
) {
  const database = await createTaskWorkDatabase();
  const app = Fastify();
  const persistence = createAgentPersistenceService({});
  const model = new BoundaryModel();
  const runtime = createAgentRunService({
    localInstance: database.localInstance,
    env: loadServerEnv({
      databaseUrl: database.connectionString,
      agentBackendMode: "filesystem",
      agentFilesRoot: database.directory,
    }),
    blob: {} as never,
    model,
    agentPersistenceService: persistence,
  });
  const close = async () => {
    await app.close();
    await persistence.dispose();
    await database.close();
  };
  try {
    const { localAccess, localInstance, actor, instanceId } = database;
    const created = await createProjectRepository(
      database.persistence,
    ).createProject({
      instanceId,
      createdByClientId: actor.accessClientId,
      kind: "design",
      name: "HTTP执行模式写穿回归",
      slug: `http-mode-${randomUUID()}`,
      description: null,
      canvasName: "主画布",
    });
    if (!created.canvas) throw new Error("正式Design项目未创建主画布");
    const chat = createChatRepository(database.persistence);
    const threadId = `http-mode-${randomUUID()}`;
    const session = await chat.createSession(instanceId, {
      canvasId: created.canvas.id,
      createdByClientId: actor.accessClientId,
      threadId,
    });
    if (!session) throw new Error("正式Design会话未创建");
    const modeScope = { instanceId };
    const createModes = () =>
      createExecutionModeService({
        store: createExecutionModeStore(database.persistence),
      });
    const initialModes = createModes();
    await initialModes.activate(
      threadId,
      options.initialMode ?? "agent",
      modeScope,
    );
    const modes = options.cold ? createModes() : initialModes;
    await registerRunRoutes(app, runtime, {
      localAccess,
      localInstance,
      threadService: createThreadService({
        repository: chat,
        localInstance,
      }),
      agentModes: modes,
    });
    return {
      app,
      headers: { authorization: `Bearer ${database.desktopToken}` },
      database,
      runtime,
      model,
      modes,
      modeScope,
      threadId,
      payload: {
        sessionId: session.id,
        conversationId: created.canvas.id,
        canvasId: created.canvas.id,
        projectId: created.project.id,
        preset: "design" as const,
        executionMode: "plan" as const,
        prompt: "请先计划，未批准前不要修改任何文件。",
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** 真实HTTP路由/认证/业务存储与RunService；只替换外部模型边界。 */
describe.skipIf(process.env.KENFUTWORK_RUN_MODE_TEST_PG !== "1")(
  "Run执行模式激活真实拒绝 integration",
  () => {
    it("显式plan真实DB拒写时HTTP拒绝启动，不返回runId且原模式与模型边界不变", async () => {
      const f = await createModeRouteFixture();
      let createdRunId: string | undefined;
      try {
        // 只在独占临时PG注入外部写拒绝，不mock activate/store、不改历史迁移。
        await f.database.persistence.execute(
          `create function public.reject_http_execution_mode() returns trigger language plpgsql as $$ begin if new.execution_mode is distinct from old.execution_mode then raise exception '测试HTTP执行模式拒写'; end if; return new; end $$`,
        );
        await f.database.persistence.execute(
          "create trigger reject_http_execution_mode before update on public.chat_sessions for each row execute function public.reject_http_execution_mode()",
        );
        const response = await f.app.inject({
          method: "POST",
          url: "/api/agent/runs",
          headers: f.headers,
          payload: f.payload,
        });
        if (response.statusCode === 202)
          createdRunId = runCreateResponseSchema.parse(response.json()).runId;
        expect(response.statusCode).toBe(503);
        const body = applicationErrorResponseSchema.parse(response.json());
        expect(body.error).toMatchObject({ code: "service_unavailable" });
        expect(body.error.message).toContain("运行未启动");
        expect(response.json()).not.toHaveProperty("runId");
        expect(await f.modes.lookup(f.threadId, f.modeScope)).toEqual({
          exists: true,
          mode: "agent",
        });
        expect(f.modes.getMode(f.threadId)).toBe("agent");
        expect(f.model.requests).toEqual([]);
      } finally {
        if (createdRunId) await f.runtime.cancelRunAndWait(createdRunId);
        await f.close();
      }
    }, 90_000);

    it("未声明模式时真实Scoped读库失败也拒绝启动，冷服务不能把持久plan变成agent", async () => {
      const f = await createModeRouteFixture({
        initialMode: "plan",
        cold: true,
      });
      let createdRunId: string | undefined;
      let renamed = false;
      try {
        expect(await f.modes.lookup(f.threadId, f.modeScope)).toEqual({
          exists: true,
          mode: "plan",
        });
        expect(f.modes.getMode(f.threadId)).toBe("agent");
        // 只在独占临时PG制造模式列不可读；ThreadService只读绑定列，仍真实可用。
        await f.database.persistence.execute(
          "alter table public.chat_sessions rename column execution_mode to execution_mode_temporarily_unavailable",
        );
        renamed = true;
        const response = await f.app.inject({
          method: "POST",
          url: "/api/agent/runs",
          headers: f.headers,
          payload: { ...f.payload, executionMode: undefined },
        });
        if (response.statusCode === 202)
          createdRunId = runCreateResponseSchema.parse(response.json()).runId;
        expect(response.statusCode).toBe(503);
        const body = applicationErrorResponseSchema.parse(response.json());
        expect(body.error).toMatchObject({ code: "service_unavailable" });
        expect(body.error.message).toContain("运行未启动");
        expect(response.json()).not.toHaveProperty("runId");
        expect(f.model.requests).toEqual([]);
        await f.database.persistence.execute(
          "alter table public.chat_sessions rename column execution_mode_temporarily_unavailable to execution_mode",
        );
        renamed = false;
        expect(await f.modes.lookup(f.threadId, f.modeScope)).toEqual({
          exists: true,
          mode: "plan",
        });
      } finally {
        if (renamed)
          await f.database.persistence.execute(
            "alter table public.chat_sessions rename column execution_mode_temporarily_unavailable to execution_mode",
          );
        if (createdRunId) await f.runtime.cancelRunAndWait(createdRunId);
        await f.close();
      }
    }, 90_000);
  },
);
