import type { RunCreateRequest } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeTestInstance,
  RUNTIME_TEST_ACTOR,
} from "../agent/runtime-test-fixtures.js";
import { DesignTaskError } from "../features/execution/design-task-errors.js";
import type {
  DesignAdmissionReceipt,
  DesignTaskPolicy,
} from "../features/execution/design-task-types.js";
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
) {
  const app = Fastify();
  void registerRunRoutes(app, {} as never, {
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

const designTaskId = "00000000-0000-4000-8000-000000000021";
const designCanvasId = "00000000-0000-4000-8000-000000000022";
const designProjectId = "00000000-0000-4000-8000-000000000023";
const designRunId = "00000000-0000-4000-8000-000000000024";
const designRequest: RunCreateRequest = {
  sessionId: designTaskId,
  taskId: designTaskId,
  conversationId: designTaskId,
  canvasId: designCanvasId,
  projectId: designProjectId,
  preset: "design",
  prompt: "生成图片",
  model: "provider/model",
};

function buildDesignPostApp(scopeAvailable = true) {
  const createRun = vi.fn(() => ({
    runId: designRunId,
    sessionId: designTaskId,
    conversationId: designTaskId,
    status: "accepted",
  }));
  const readPolicy = vi.fn(
    async (): Promise<DesignTaskPolicy> => ({
      taskId: designTaskId,
      projectId: designProjectId,
      canvasId: designCanvasId,
      rootDirectory: "/authorized/design-task",
      additionalDirectories: [],
      sandboxMode: "workspace-write",
      mode: "build",
      planEnabled: false,
      planningEpoch: 0,
      activeRunId: null,
      executionState: "ready",
      scopeGeneration: 7,
      branchGeneration: 3,
    }),
  );
  const submit = vi.fn(
    async (
      _actor: unknown,
      input: { inputId: string },
    ): Promise<DesignAdmissionReceipt> => ({
      kind: "running",
      taskId: designTaskId,
      inputId: input.inputId,
      runId: designRunId,
      sequence: 1,
      request: designRequest,
    }),
  );
  const scope = {
    preset: "design",
    describe: () => ({
      instanceId: RUNTIME_TEST_ACTOR.instanceId,
      taskId: designTaskId,
      projectId: designProjectId,
      rootDirectory: "/authorized/design-task",
    }),
  };
  const openTask = vi.fn(async () => scope);
  const app = Fastify();
  void registerRunRoutes(
    app,
    { createRun } as never,
    {
      localAccess: { authenticate: async () => RUNTIME_TEST_ACTOR },
      localInstance: createRuntimeTestInstance(),
      threadService: {
        resolveOwnedSessionThread: async () => ({
          sessionId: designTaskId,
          threadId: "design-thread",
          projectId: designProjectId,
          canvasId: designCanvasId,
          mode: "design",
        }),
      } as never,
      ...(scopeAvailable ? { executionScopes: { openTask } as never } : {}),
      designTasks: { readPolicy },
      designRunHost: { submit },
    } as Parameters<typeof registerRunRoutes>[2],
  );
  return { app, createRun, readPolicy, submit, openTask, scope };
}

describe("POST /api/agent/runs Design 持久 Task admission", () => {
  it("持久授权代际与模型输入交给 Design host，HTTP 不直接创建 Run", async () => {
    const { app, createRun, readPolicy, submit } = buildDesignPostApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/runs",
        payload: designRequest,
      });
      expect(response.statusCode).toBe(202);
      expect(readPolicy).toHaveBeenCalledWith(RUNTIME_TEST_ACTOR, designTaskId);
      expect(submit).toHaveBeenCalledWith(RUNTIME_TEST_ACTOR, {
        taskId: designTaskId,
        inputId: expect.any(String),
        scopeGeneration: 7,
        branchGeneration: 3,
        request: designRequest,
      });
      expect(response.json().runId).toBe(designRunId);
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["缺少 Task", { taskId: undefined }],
    ["另一 Task", { taskId: "00000000-0000-4000-8000-000000000099" }],
    ["另一画布", { canvasId: "00000000-0000-4000-8000-000000000099" }],
    ["另一项目", { projectId: "00000000-0000-4000-8000-000000000099" }],
  ])("%s 在 admission 前拒绝", async (_label, override) => {
    const { app, createRun, submit } = buildDesignPostApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/runs",
        payload: { ...designRequest, ...override },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.json().error.message.length).toBeGreaterThan(0);
      expect(submit).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("作用域服务缺席时在 202 前拒绝", async () => {
    const { app, submit, createRun } = buildDesignPostApp(false);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/runs",
        payload: designRequest,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.message.length).toBeGreaterThan(0);
      expect(submit).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("目录不可用时返回作用域原因，不先接受再失败", async () => {
    const { app, openTask, submit, createRun } = buildDesignPostApp();
    openTask.mockRejectedValue(
      new ExecutionScopeError(
        "scope_unavailable",
        "工作目录不可用，请重新关联。",
        409,
      ),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/runs",
        payload: designRequest,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toBe(
        "工作目录不可用，请重新关联。",
      );
      expect(openTask).toHaveBeenCalledWith(RUNTIME_TEST_ACTOR, designTaskId);
      expect(submit).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["preset", "taskId", "projectId", "rootDirectory", "instanceId"])(
    "作用域 %s 与持久 Task 不符时拒绝",
    async (field) => {
      const { app, scope, submit, createRun } = buildDesignPostApp();
      if (field === "preset") scope.preset = "code";
      else {
        const describe = scope.describe;
        scope.describe = () => ({ ...describe(), [field]: "other" });
      }
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/agent/runs",
          payload: designRequest,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error.message.length).toBeGreaterThan(0);
        expect(submit).not.toHaveBeenCalled();
        expect(createRun).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("跨实例或已删除 Task 在持久归属检查时拒绝", async () => {
    const { app, createRun, readPolicy, submit } = buildDesignPostApp();
    readPolicy.mockRejectedValue(
      new DesignTaskError(
        "design_task_unprovisioned",
        "任务不存在或无权访问。",
        404,
      ),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/runs",
        payload: designRequest,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("任务不存在或无权访问。");
      expect(submit).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("忙碌 Task 复用 host 的排队 receipt，不启动第二个前台 Run", async () => {
    const { app, createRun, submit } = buildDesignPostApp();
    submit.mockImplementation(async (_actor, input) => ({
      kind: "queued",
      taskId: designTaskId,
      inputId: input.inputId,
      runId: designRunId,
      sequence: 2,
      request: designRequest,
    }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent/runs",
        payload: designRequest,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().runId).toBe(designRunId);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

it("Code HTTP 仍打开持久 Task 并经过 Code admission", async () => {
  const createRun = vi.fn(() => ({
    runId: designRunId,
    sessionId: designTaskId,
    conversationId: designTaskId,
    status: "accepted",
  }));
  const handle = { describe: () => ({ taskId: designTaskId }) };
  const openTask = vi.fn(async () => handle);
  const eventSink = vi.fn();
  const admitExternalRun = vi.fn(async () => eventSink);
  const submit = vi.fn();
  const app = Fastify();
  void registerRunRoutes(
    app,
    { createRun } as never,
    {
      localAccess: { authenticate: async () => RUNTIME_TEST_ACTOR },
      localInstance: createRuntimeTestInstance(),
      threadService: {
        resolveOwnedSessionThread: async () => ({
          sessionId: designTaskId,
          threadId: "code-thread",
          projectId: designProjectId,
          mode: "code",
        }),
      } as never,
      executionScopes: { openTask } as never,
      codeUi: { admitExternalRun } as never,
      designRunHost: { submit },
    } as Parameters<typeof registerRunRoutes>[2],
  );
  try {
    const payload = {
      sessionId: designTaskId,
      taskId: designTaskId,
      conversationId: designTaskId,
      projectId: designProjectId,
      preset: "code",
      prompt: "检查代码",
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload,
    });
    expect(response.statusCode).toBe(202);
    expect(openTask).toHaveBeenCalledWith(RUNTIME_TEST_ACTOR, designTaskId);
    expect(admitExternalRun).toHaveBeenCalledWith(
      RUNTIME_TEST_ACTOR,
      handle,
      expect.any(String),
      payload.prompt,
    );
    expect(createRun).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        actor: RUNTIME_TEST_ACTOR,
        scopeHandle: handle,
        eventSink,
        threadId: "code-thread",
      }),
    );
    expect(submit).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
