import type { RunCreateRequest } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeTestInstance,
  RUNTIME_TEST_ACTOR,
} from "../agent/runtime-test-fixtures.js";
import { ExecutionScopeError } from "../features/execution/scope-service.js";
import { registerRunRoutes } from "./runs.js";

/**
 * `GET /api/agent/subagents`（设置 →「子智能体」的数据源）的**路由级**回归。
 *
 * 这一层的价值在于契约形状：响应要过 `agentSubagentListResponseSchema`，客户端据此渲染
 * （漏字段/多字段都会被 zod 拦下或剥掉）。同时钉住「未授权不给清单」这条基本线。
 */
function buildApp(
  authenticated: boolean,
  deps: Partial<Parameters<typeof registerRunRoutes>[2]> = {},
  runtime: Parameters<typeof registerRunRoutes>[1] = {} as never,
) {
  const app = Fastify();
  void registerRunRoutes(app, runtime, {
    localAccess: {
      authenticate: async () => (authenticated ? RUNTIME_TEST_ACTOR : null),
    },
    localInstance: createRuntimeTestInstance(),
    ...deps,
  });
  return app;
}

describe("GET /api/agent/subagents", () => {
  it("本机授权后返回声明的子代理与内置分发工具（形状过契约）", async () => {
    const app = buildApp(true);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/subagents",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        subagents: Array<{ name: string; label: string; tools: string[] }>;
        builtin: Array<{ name: string }>;
      };
      expect(body.subagents.map((entry) => entry.name)).toContain(
        "video_generate",
      );
      expect(body.builtin.map((entry) => entry.name)).toContain("task");
      // 中文短名与工具名都要在（界面直接上屏，缺了就是空白行）
      for (const entry of body.subagents) {
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.tools.length).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  it("未获本机授权：401（清单不外泄）", async () => {
    const app = buildApp(false);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/subagents",
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("最新 Run 的本机查询", () => {
  it("只用持久会话与实例归属查询并返回原始失败原因", async () => {
    const latestRunQuery = vi.fn(async () => ({
      status: "failed",
      errorCode: "run_failed",
      errorMessage: "服务重启，本轮已中断。",
      startedAt: "2026-10-07T00:00:00.000Z",
      completedAt: null,
    }));
    const app = buildApp(true, { latestRunQuery });
    try {
      const response = await app.inject({
        url: "/api/agent/runs/latest?sessionId=persistent-session",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().run.errorMessage).toBe("服务重启，本轮已中断。");
      expect(latestRunQuery).toHaveBeenCalledWith({
        sessionId: "persistent-session",
        instanceId: RUNTIME_TEST_ACTOR.instanceId,
      });
      expect(
        (await app.inject({ url: "/api/agent/runs/latest" })).json(),
      ).toEqual({ run: null });
      expect(latestRunQuery).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("未认证请求不会读取终态", async () => {
    const latestRunQuery = vi.fn();
    const app = buildApp(false, { latestRunQuery });
    try {
      expect(
        (await app.inject({ url: "/api/agent/runs/latest?sessionId=other" }))
          .statusCode,
      ).toBe(401);
      expect(latestRunQuery).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

const taskId = "00000000-0000-4000-8000-000000000021";
const runId = "00000000-0000-4000-8000-000000000024";

describe("HTTP共享Task准入", () => {
  it.each(["code", "design"] as const)(
    "%s仅委托canonical宿主，运输层不创建第二Run或消费SDK流",
    async (preset) => {
      const createRun = vi.fn();
      const publish = vi.fn(async () => {});
      const handle = { describe: () => ({ taskId }) };
      const openTask = vi.fn(async () => handle);
      const admitExternalRun = vi.fn(async () => ({
        runId,
        sessionId: taskId,
        conversationId: taskId,
        status: "accepted" as const,
        publish,
      }));
      const app = buildApp(
        true,
        {
          executionScopes: { openTask } as never,
          codeUi: { admitExternalRun } as never,
        },
        { createRun } as never,
      );
      try {
        const payload: RunCreateRequest = {
          sessionId: taskId,
          taskId,
          conversationId: taskId,
          prompt: "真实准入",
          inputId: "stable-input",
          workContext: { preset },
          preset,
        };
        const response = await app.inject({
          method: "POST",
          url: "/api/agent/runs",
          payload,
        });
        expect(response.statusCode).toBe(202);
        expect(response.json()).toEqual({
          runId,
          sessionId: taskId,
          conversationId: taskId,
          status: "accepted",
        });
        expect(openTask).toHaveBeenCalledWith(RUNTIME_TEST_ACTOR, taskId);
        expect(admitExternalRun).toHaveBeenCalledWith(
          RUNTIME_TEST_ACTOR,
          handle,
          "stable-input",
          payload.prompt,
          payload,
        );
        expect(publish).toHaveBeenCalledOnce();
        expect(createRun).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it("作用域缺席或真实Task错误时在接纳前拒绝，不回退直接runtime", async () => {
    const admitted = vi.fn();
    const missing = buildApp(true, {
      codeUi: { admitExternalRun: admitted } as never,
    });
    const denied = buildApp(true, {
      codeUi: { admitExternalRun: admitted } as never,
      executionScopes: {
        openTask: async () => {
          throw new ExecutionScopeError(
            "task_not_found",
            "任务已删除，请新建会话。",
            404,
          );
        },
      } as never,
    });
    try {
      const payload = {
        sessionId: taskId,
        conversationId: taskId,
        prompt: "执行",
      };
      expect(
        (
          await missing.inject({
            method: "POST",
            url: "/api/agent/runs",
            payload,
          })
        ).statusCode,
      ).toBe(503);
      const response = await denied.inject({
        method: "POST",
        url: "/api/agent/runs",
        payload,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: "task_not_found", message: "任务已删除，请新建会话。" },
      });
      expect(admitted).not.toHaveBeenCalled();
    } finally {
      await missing.close();
      await denied.close();
    }
  });
  it("传入另一Task不能替代会话身份，取消也必须委托共享宿主持久停止", async () => {
    const admitted = vi.fn();
    const cancelExternalRun = vi.fn(async () => ({
      runId,
      status: "canceled" as const,
    }));
    const app = buildApp(true, {
      codeUi: { admitExternalRun: admitted, cancelExternalRun } as never,
      executionScopes: {
        openTask: async () => ({ describe: () => ({ taskId: "other" }) }),
      } as never,
    });
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/agent/runs",
            payload: {
              sessionId: taskId,
              taskId: "other",
              conversationId: taskId,
              prompt: "执行",
            },
          })
        ).statusCode,
      ).toBe(409);
      expect(admitted).not.toHaveBeenCalled();
      const canceled = await app.inject({
        method: "POST",
        url: `/api/agent/runs/${runId}/cancel`,
      });
      expect(canceled.statusCode).toBe(202);
      expect(cancelExternalRun).toHaveBeenCalledWith(RUNTIME_TEST_ACTOR, runId);
    } finally {
      await app.close();
    }
  });
});
